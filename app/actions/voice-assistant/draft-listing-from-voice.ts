"use server"

/**
 * Voice-driven conversational LISTING AGREEMENT intake. Mirror of
 * draft-offer-from-voice.ts — same multi-turn pattern, calls
 * extractListingIntake + fillListingPacket + generateListingAgreement.
 *
 * Wired into VoiceAssistantPanel as a parallel "Draft Listing" mode.
 *
 * THE SURVIVOR OF THE LISTING-INTAKE CONSOLIDATION.
 * app/api/workflow/intake/listing/route.ts was the same business process behind an
 * HTTP door — same extractListingIntake, same workflow_intake_sessions row, same
 * fillListingPacket, same documents insert (document_type 'listing_agreement',
 * status 'needs_agent_input'), same recordAIFill audit, same generateListingAgreement
 * staging, same /dashboard/listings/new?documentId= URL. It was retired because
 * nothing in the tree addressed it and nothing outside could (it authenticated on
 * `supabase.auth.getUser()`, i.e. a browser session), while this function is reached
 * from app/mobile/voice/voice-session-button.tsx, app/actions/wizard-staging.ts and
 * app/api/internal/voice-command/route.ts.
 * Nothing had to be merged onto this survivor: it is a strict superset of that route
 * (multi-turn follow-ups, the ready-to-finalize confirmation turn, the assistant turn
 * appended to `conversation`, metadata.source='voice_intake', and a refusal when
 * propertyState is missing — where the route wrote a NULL state_code). The route's
 * intakeToListingDraftParams() mapper produces field-for-field what this function
 * already hand-builds.
 */

import { createClient } from "@/lib/supabase/server"
// intakeToListingDraftParams is the ONE intake → generateListingAgreement mapping. It
// was written for the retired /api/workflow/intake/listing route while this action
// hand-built the identical object beside it; the survivor takes the shared mapper so
// there is one spelling of the mapping, not two (CLAUDE.md §6). `state` is checked
// before it is called, so its throw-on-missing-state can never fire here.
import { extractListingIntake, intakeToListingDraftParams, type ListingIntake } from "@/lib/workflow/intake/voice-to-listing"
import { fillListingPacket } from "@/lib/workflow/intake/form-fill-engine"

export interface VoiceDraftListingRequest {
  voiceInput:    string
  sessionId?:    string
  contactId?:    string
  forceFinalize?: boolean
}

export type VoiceDraftListingResponse =
  | {
      kind:           "needs_more_info"
      sessionId:      string
      questions:      Array<{ field: string; question: string }>
      intakeSoFar:    ListingIntake
      spokenResponse: string
    }
  | {
      kind:           "ready_to_finalize"
      sessionId:      string
      intake:         ListingIntake
      spokenResponse: string
    }
  | {
      kind:           "finalized"
      sessionId:      string
      documentId:     string
      formwizardUrl:  string
      spokenResponse: string
    }
  | {
      kind:           "error"
      error:          string
    }

export async function voiceDraftListing(req: VoiceDraftListingRequest): Promise<VoiceDraftListingResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { kind: "error", error: "Unauthorized" }

  const { data: userRow } = await supabase
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  const brokerageId = userRow?.brokerage_id
  if (!brokerageId) return { kind: "error", error: "No brokerage on user" }

  // Load any prior session — OWNER-SCOPED (§4). `sessionId` is caller-supplied,
  // and without the `agent_user_id` predicate any authenticated user could
  // resume ANOTHER user's intake — reading their contact linkage and the whole
  // prior conversation — by guessing or replaying a session id. Identity comes
  // from the SESSION, never the request. A miss (not found OR not yours —
  // deliberately indistinguishable) starts a NEW session: req.sessionId is
  // cleared so the persist below inserts rather than updating a row this
  // caller does not own.
  let priorIntake: ListingIntake | undefined
  let priorConversation: Array<{ role: string; content: string; ts: string }> = []
  if (req.sessionId) {
    const { data: session } = await supabase
      .from("workflow_intake_sessions")
      .select("current_intake, conversation, contact_id")
      .eq("id", req.sessionId)
      .eq("agent_user_id", user.id)
      .maybeSingle()
    if (session) {
      priorIntake = session.current_intake as ListingIntake
      priorConversation = (session.conversation as any[]) || []
      if (!req.contactId && session.contact_id) req.contactId = session.contact_id
    } else {
      req.sessionId = undefined
    }
  }

  const extracted = await extractListingIntake({
    text:  req.voiceInput,
    prior: priorIntake,
    // §4 — session user, and the brokerage read off THEIR users row.
    brokerageId,
    userId: user.id,
  })

  const newConversation = [
    ...priorConversation,
    { role: "agent", content: req.voiceInput, ts: new Date().toISOString() },
  ]

  // Persist / upsert session
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
      intake_type:    "listing",
      conversation:   newConversation,
      current_intake: extracted.intake,
      status:         extracted.readyToDraft ? "ready_to_draft" : "in_progress",
    }).select("id").single()
    sessionId = newSession?.id
  }
  if (!sessionId) return { kind: "error", error: "Could not persist intake session" }

  if (!extracted.readyToDraft && !req.forceFinalize) {
    const top = extracted.followUpQuestions.slice(0, 2)
    const spoken = top.length > 0
      ? `Got it. ${top.map(q => q.question).join(" ")}`
      : "Got it. What else?"
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

  if (!req.forceFinalize) {
    return {
      kind:           "ready_to_finalize",
      sessionId,
      intake:         extracted.intake,
      spokenResponse: "I have everything I need. Say 'finalize' or tap to stage the listing-agreement packet for your review.",
    }
  }

  // Finalize
  const state = extracted.intake.propertyState.value
  if (!state) return { kind: "error", error: "Cannot finalize — propertyState is missing" }

  let filledPacket
  try {
    filledPacket = await fillListingPacket({ intake: extracted.intake, brokerageId })
  } catch (err) {
    return { kind: "error", error: (err as Error).message ?? "Fill engine failed" }
  }

  const { data: doc } = await supabase.from("documents").insert({
    brokerage_id:  brokerageId,
    contact_id:    req.contactId ?? null,
    document_type: "listing_agreement",
    status:        "needs_agent_input",
    state_code:    state,
    metadata: {
      packet_type: "listing",
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

  // Audit trail
  try {
    const { recordAIFill } = await import("@/lib/workflow/intelligence/field-audit")
    await recordAIFill(doc.id, [...filledPacket.forms, ...filledPacket.brokerageForms])
  } catch { /* audit best-effort */ }

  // Stage via generateListingAgreement
  try {
    const intakeMod = await import("@/app/actions/ai-listing-intake")
    if (typeof (intakeMod as any).generateListingAgreement === "function") {
      await (intakeMod as any).generateListingAgreement(intakeToListingDraftParams({
        intake:      extracted.intake,
        brokerageId,
        contactId:   req.contactId ?? null,
        agentUserId: user.id,
        documentId:  doc.id,
      }))
    }
  } catch { /* generator optional */ }

  await supabase.from("workflow_intake_sessions").update({
    status: "drafted",
    document_id: doc.id,
    updated_at: new Date().toISOString(),
  }).eq("id", sessionId)

  return {
    kind:           "finalized",
    sessionId,
    documentId:     doc.id,
    formwizardUrl:  `/dashboard/listings/new?documentId=${doc.id}`,
    spokenResponse: "Listing-agreement packet staged for your review. Opening the FormWizard now.",
  }
}
