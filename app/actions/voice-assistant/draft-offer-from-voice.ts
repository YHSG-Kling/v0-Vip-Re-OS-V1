"use server"

/**
 * Voice-driven conversational offer intake. Wraps the workflow intake
 * pipeline so the agent's existing voice assistant can drive a packet
 * end-to-end through a single transcript stream.
 *
 * THE SURVIVOR OF THE OFFER-INTAKE CONSOLIDATION.
 * app/api/workflow/intake/offer/route.ts was the same business process behind an HTTP
 * door: same extractOfferIntake, same workflow_intake_sessions row, same
 * fillOfferPacket, same documents insert (document_type 'offer',
 * status 'needs_agent_input'), same generateOfferDraft staging, same FormWizard URL.
 * It was retired because nothing in the tree addressed it and nothing outside could:
 * it authenticated on `supabase.auth.getUser()`, i.e. a browser session, so it was not
 * an external door — while THIS function is the canonical driver reached from
 * app/mobile/voice/voice-session-button.tsx, app/actions/wizard-staging.ts and
 * app/api/internal/voice-command/route.ts.
 * Per CLAUDE.md §1 the survivor took the duplicate's missing half first: the
 * runAllOfferChecks pre-flight and its findings/addenda passthrough (see the finalize
 * branch). Nothing else on that route existed here — its intakeToOfferDraftParams()
 * mapper produces field-for-field what this function already hand-builds.
 *
 * Conversational pattern:
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
// intakeToOfferDraftParams is the ONE intake → generateOfferDraft mapping. It was
// written for the retired /api/workflow/intake/offer route while this action hand-built
// the identical object beside it; the survivor takes the shared mapper so there is one
// spelling of the mapping, not two (CLAUDE.md §6). `state` is checked before it is
// called, so its throw-on-missing-state can never fire here.
import { extractOfferIntake, intakeToOfferDraftParams, type OfferIntake } from "@/lib/workflow/intake/voice-to-offer"
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

/** One proactive-check finding — the shape lib/workflow/intelligence/proactive-checks.ts
 *  returns. Re-declared structurally rather than imported so this action's response type
 *  stays serialisable across the server-action boundary.
 *
 *  NOT EXPORTED, deliberately, and for two reasons at once: this is a "use server" file
 *  where every export is a public endpoint (CLAUDE.md §4), and an exported type that no
 *  other module names is a category-3 orphan export. It is reachable where it needs to
 *  be — structurally, through the exported VoiceDraftOfferResponse union — so the two
 *  consumers that read `.blockers` need no named import. */
interface OfferCheckFinding {
  severity:        string
  category:        string
  title:           string
  detail:          string
  recommendation?: string
  action?:         { label: string; href: string }
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
      /** PROACTIVE CHECKS REFUSED THE DRAFT. Merged onto this action when the duplicate
       *  HTTP door (app/api/workflow/intake/offer) was retired — see the note on the
       *  finalize branch. Nothing is staged: the agent fixes the blocker and re-finalizes. */
      kind:               "blocked"
      sessionId:          string
      blockers:           OfferCheckFinding[]
      findings:           OfferCheckFinding[]
      addenda:            unknown[]
      spokenResponse:     string
    }
  | {
      kind:               "finalized"
      sessionId:          string
      documentId:         string
      formwizardUrl:      string
      spokenResponse:     string
      /** Non-blocking warnings/info the FormWizard shows as a "review these" panel. */
      findings:           OfferCheckFinding[]
      addenda:            unknown[]
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

  // ── Load any prior session — OWNER-SCOPED (§4) ──────────────────────────
  // `sessionId` is caller-supplied, and without the `agent_user_id` predicate
  // any authenticated user could resume ANOTHER user's intake — reading their
  // contact linkage and the whole prior conversation — by guessing or
  // replaying a session id. Identity comes from the SESSION, never the
  // request. A miss (not found OR not yours — deliberately indistinguishable)
  // starts a NEW session: req.sessionId is cleared so the persist below
  // inserts rather than updating a row this caller does not own.
  let priorIntake: OfferIntake | undefined
  let priorConversation: Array<{ role: string; content: string; ts: string }> = []
  if (req.sessionId) {
    const { data: session } = await supabase
      .from("workflow_intake_sessions")
      .select("current_intake, conversation, contact_id")
      .eq("id", req.sessionId)
      .eq("agent_user_id", user.id)
      .maybeSingle()
    if (session) {
      priorIntake = session.current_intake as OfferIntake
      priorConversation = (session.conversation as any[]) || []
      if (!req.contactId && session.contact_id) req.contactId = session.contact_id
    } else {
      req.sessionId = undefined
    }
  }

  // ── Extract / refine intake ──────────────────────────────────────────────
  const extracted = await extractOfferIntake({
    text:  req.voiceInput,
    prior: priorIntake,
    // §4 — session user, and the brokerage read off THEIR users row.
    brokerageId,
    userId: user.id,
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

  // ── PROACTIVE CHECKS, BEFORE ANY FILL ────────────────────────────────────
  // MERGED FROM THE RETIRED DUPLICATE. app/api/workflow/intake/offer/route.ts ran
  // the SAME pipeline as this action (extract → session → fillOfferPacket → documents
  // row → generateOfferDraft → FormWizard url) behind an HTTP door nothing in the tree
  // addressed, and it carried ONE thing this action did not: runAllOfferChecks with a
  // hard-blocker refusal. That meant every offer staged by VOICE — the mobile panel,
  // the wizard Copilot, and the premium voice lane, i.e. every live path — skipped the
  // MLS validation, the financing preflight, the buyer-agency/legal-name completeness
  // gate and the addendum auto-detect, while the door nobody used enforced them.
  // The gate runs FIRST so a blocker stops the flow before a packet is filled, which
  // is what the route's own comment said it was for: it saves a wasted pass.
  // Best-effort by design, exactly as on the retired route: if the checks themselves
  // crash we proceed rather than refuse — this is an ADVISORY pre-flight, not the
  // compliance gate of record (that is submitOfferToCompliance /
  // lib/transactions/transaction-creation-gate.ts, which still refuses downstream).
  let proactive: Awaited<ReturnType<typeof import("@/lib/workflow/intelligence/proactive-checks").runAllOfferChecks>> | null = null
  try {
    const { runAllOfferChecks } = await import("@/lib/workflow/intelligence/proactive-checks")
    proactive = await runAllOfferChecks({
      intake:      extracted.intake,
      contactId:   req.contactId ?? null,
      agentUserId: user.id,
      brokerageId,
      listingId:   extracted.intake.listingId.value,
    })
  } catch { /* checks are best-effort — proceed if they crash */ }

  if (proactive && !proactive.passed) {
    const top = proactive.blockers[0]
    await supabase.from("workflow_intake_sessions").update({
      status:     "ready_to_draft",
      updated_at: new Date().toISOString(),
    }).eq("id", sessionId)
    return {
      kind:     "blocked",
      sessionId,
      blockers: proactive.blockers as OfferCheckFinding[],
      findings: proactive.findings as OfferCheckFinding[],
      addenda:  proactive.addenda,
      spokenResponse: top
        ? `I can't stage this yet — ${top.title}. ${top.recommendation ?? top.detail}`
        : "I can't stage this yet — a pre-flight check refused the offer.",
    }
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
      await (draftMod as any).generateOfferDraft(intakeToOfferDraftParams({
        intake: extracted.intake,
        brokerageId,
        contactId: req.contactId ?? null,
        agentUserId: user.id,
        documentId: doc.id,
      }))
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
    // Non-blocking warnings + suggested addenda ride out with the packet so the
    // FormWizard can show them beside the prefilled fields (the retired route's
    // "review these" panel — the only other thing it carried).
    findings: (proactive?.findings ?? []) as OfferCheckFinding[],
    addenda:  proactive?.addenda ?? [],
  }
}
