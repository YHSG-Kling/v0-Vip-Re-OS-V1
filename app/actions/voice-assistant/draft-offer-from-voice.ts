"use server"

/**
 * Voice-driven conversational offer intake. Wraps the workflow intake
 * pipeline so the agent's existing voice assistant can drive a packet
 * end-to-end through a single transcript stream.
 *
 * Conversational pattern (matches the same model as
 * /api/workflow/intake/offer):
 *
 *   Turn 1 — agent says "draft offer at 800K on 123 Main, 3% earnest…"
 *           → server stores a workflow_intake_session, returns the missing
 *             fields as follow-up questions
 *   Turn 2 — agent answers with the next field set; server merges,
 *             re-extracts, and either asks more questions or signals
 *             ready-to-draft
 *   Turn N — when ready, calling finalize stages the packet via
 *             generateOfferDraft and returns the FormWizard URL
 *
 * Auth: requires authenticated user. All work scoped to user's brokerage.
 */

import { createClient } from "@/lib/supabase/server"
import { extractOfferIntake, type OfferIntake } from "@/lib/workflow/intake/voice-to-offer"
import { fillOfferPacket } from "@/lib/workflow/intake/form-fill-engine"

export interface VoiceDraftOfferRequest {
  /** Free-form voice transcript or typed text */
  voiceInput:  string
  /** When continuing a session, pass the sessionId from the prior turn */
  sessionId?:  string
  /** Optional context — current buyer the agent is working with */
  contactId?:  string
  /** When true, force finalize with what we have (skip more questions) */
  forceFinalize?: boolean
}

export type VoiceDraftOfferResponse =
  | {
      kind:               "needs_more_info"
      sessionId:          string
      questions:          Array<{ field: string; question: string }>
      intakeSoFar:        OfferIntake
      spokenResponse:     string
    }
  | {
      kind:               "ready_to_finalize"
      sessionId:          string
      intake:             OfferIntake
      spokenResponse:     string
    }
  | {
      kind:               "finalized"
      sessionId:          string
      documentId:         string
      formwizardUrl:      string
      spokenResponse:     string
    }
  | {
      kind:               "error"
      error:              string
    }

export async function voiceDraftOffer(req: VoiceDraftOfferRequest): Promise<VoiceDraftOfferResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { kind: "error", error: "Unauthorized" }

  const { data: userRow } = await supabase
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  const brokerageId = userRow?.brokerage_id
  if (!brokerageId) return { kind: "error", error: "No brokerage on user" }

  // ── Load any prior session ──────────────────────────────────────────────
  let priorIntake: OfferIntake | undefined
  let priorConversation: Array<{ role: string; content: string; ts: string }> = []
  if (req.sessionId) {
    const { data: session } = await supabase
      .from("workflow_intake_sessions")
      .select("current_intake, conversation, contact_id")
      .eq("id", req.sessionId)
      .maybeSingle()
    if (session) {
      priorIntake = session.current_intake as OfferIntake
      priorConversation = (session.conversation as any[]) || []
      if (!req.contactId && session.contact_id) req.contactId = session.contact_id
    }
  }

  // ── Extract / refine intake ──────────────────────────────────────────────
  const extracted = await extractOfferIntake({
    text:  req.voiceInput,
    prior: priorIntake,
  })

  const newConversation = [
    ...priorConversation,
    { role: "agent",     content: req.voiceInput, ts: new Date().toISOString() },
  ]

  // ── Persist / upsert session ─────────────────────────────────────────────
  let sessionId = req.sessionId
  if (sessionId) {
    await supabase.from("workflow_intake_sessions").update({
      current_intake: extracted.intake,
      conversation:   newConversation,
      status:         extracted.readyToDraft ? "ready_to_draft" : "in_progress",
      updated_at:     new Date().toISOString(),
    }).eq("id", sessionId)
  } else {
    const { data: newSession } = await supabase.from("workflow_intake_sessions").insert({
      brokerage_id:   brokerageId,
      agent_user_id:  user.id,
      contact_id:     req.contactId ?? null,
      intake_type:    "offer",
      conversation:   newConversation,
      current_intake: extracted.intake,
      status:         extracted.readyToDraft ? "ready_to_draft" : "in_progress",
    }).select("id").single()
    sessionId = newSession?.id
  }
  if (!sessionId) return { kind: "error", error: "Could not persist intake session" }

  // ── If not ready and not forcing finalize: ask follow-ups ────────────────
  if (!extracted.readyToDraft && !req.forceFinalize) {
    const top = extracted.followUpQuestions.slice(0, 2)
    const spoken = top.length > 0
      ? `Got it. ${top.map(q => q.question).join(" ")}`
      : "Got it. What else?"
    // Append assistant turn
    await supabase.from("workflow_intake_sessions").update({
      conversation: [
        ...newConversation,
        { role: "assistant", content: spoken, ts: new Date().toISOString() },
      ],
    }).eq("id", sessionId)

    return {
      kind:           "needs_more_info",
      sessionId,
      questions:      extracted.followUpQuestions,
      intakeSoFar:    extracted.intake,
      spokenResponse: spoken,
    }
  }

  // ── Ready-to-finalize OR forceFinalize: stage the packet ─────────────────
  // Only finalize if the user explicitly asked to (or readyToDraft AND
  // forceFinalize was implicit — we DON'T auto-finalize without confirmation
  // on the first ready turn, give the agent one chance to add more)
  if (!req.forceFinalize) {
    return {
      kind:           "ready_to_finalize",
      sessionId,
      intake:         extracted.intake,
      spokenResponse: "I have everything I need. Say 'finalize' or tap the button to stage the packet for your review.",
    }
  }

  // Build the packet and stage the document
  const state = extracted.intake.propertyState.value
  if (!state) {
    return { kind: "error", error: "Cannot finalize — propertyState is missing" }
  }

  let filledPacket
  try {
    filledPacket = await fillOfferPacket({ intake: extracted.intake, brokerageId })
  } catch (err) {
    return { kind: "error", error: (err as Error).message ?? "Fill engine failed" }
  }

  const { data: doc } = await supabase.from("documents").insert({
    brokerage_id:  brokerageId,
    contact_id:    req.contactId ?? null,
    document_type: "offer",
    status:        "needs_agent_input",
    state_code:    state,
    metadata: {
      packet_type: "offer",
      state,
      forms_count:           filledPacket.forms.length,
      brokerage_forms_count: filledPacket.brokerageForms.length,
      agent_must_complete:   filledPacket.agentMustComplete,
      audit:                 filledPacket.audit,
      source:                "voice_intake",
    },
    content: JSON.stringify({ filledPacket, intake: extracted.intake }, null, 2),
    created_at: new Date().toISOString(),
  }).select("id").single()
  if (!doc) return { kind: "error", error: "Could not create document" }

  // Record AI-fill audit trail
  try {
    const { recordAIFill } = await import("@/lib/workflow/intelligence/field-audit")
    await recordAIFill(doc.id, [...filledPacket.forms, ...filledPacket.brokerageForms])
  } catch { /* audit best-effort */ }

  // Stage the packet via generateOfferDraft (same as HTTP route)
  try {
    const draftMod = await import("@/app/actions/ai-offer-creation")
    if (typeof (draftMod as any).generateOfferDraft === "function") {
      await (draftMod as any).generateOfferDraft({
        brokerageId,
        contactId: req.contactId ?? null,
        agentUserId: user.id,
        state,
        propertyAddress: extracted.intake.propertyAddress.value ?? undefined,
        listingId: extracted.intake.listingId.value ?? null,
        documentId: doc.id,
      })
    }
  } catch { /* generator optional */ }

  // Update session
  await supabase.from("workflow_intake_sessions").update({
    status: "drafted",
    document_id: doc.id,
    updated_at: new Date().toISOString(),
  }).eq("id", sessionId)

  const formwizardUrl = req.contactId
    ? `/crm?contact=${req.contactId}&action=new_offer&documentId=${doc.id}`
    : `/dashboard/documents/${doc.id}`

  return {
    kind:          "finalized",
    sessionId,
    documentId:    doc.id,
    formwizardUrl,
    spokenResponse: "Packet staged for your review. Opening the FormWizard now.",
  }
}
