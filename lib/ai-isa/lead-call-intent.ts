/**
 * lib/ai-isa/lead-call-intent.ts
 *
 * LEAD CALL-IN → INTENT ROUTING — the voice half of the inbound autonomy loop.
 *
 * The AI ISA nurtures LEADS by email and direct mail (no phone or SMS before
 * consent) — but leads can CALL IN. The inbound voice door records those calls
 * on voice_calls.lead_id (leads are NOT contacts — separate id class). When the
 * call CLOSES with a transcript, this hook runs the SAME inbound intent router
 * the email lane uses (classifyAndRouteInbound):
 *
 *   clear POSITIVE intent → convert via the canonical handoff + route to the
 *                           matching milestone (criteria / pre-approval / showing
 *                           / CMA / appointment)
 *   clear NEGATIVE intent → halt engagement (never convert)
 *   AMBIGUOUS             → record a nurture touch, keep nurturing
 *
 * Reuse, don't rebuild: ONE classifier serves email replies and call-ins. This
 * module only loads the closed call and hands its transcript to the router.
 * Idempotent: the converters are idempotent per lead, and the caller gates on
 * the row actually transitioning to completed (no double-fire on the
 * status-callback + turn-hangup race).
 */

import "server-only"

export interface LeadCallIntentResult {
  outcome: "converted" | "halted" | "nurtured" | "skipped"
  contactId?: string
  error?: string
}

/**
 * routeLeadCallIntent — classify a COMPLETED lead call's transcript and route.
 * Safe to call for any voice_calls id: non-lead calls and calls without a
 * transcript skip honestly. Never throws (voice webhooks must never 500).
 */
export async function routeLeadCallIntent(
  svc: any,
  voiceCallId: string,
): Promise<LeadCallIntentResult> {
  try {
    const { data: call } = await svc
      .from("voice_calls")
      .select("id, lead_id, brokerage_id, transcription, direction")
      .eq("id", voiceCallId)
      .maybeSingle()

    if (!call?.lead_id) return { outcome: "skipped" }
    const transcript = (call.transcription ?? "").trim()
    if (!transcript) return { outcome: "skipped" }

    const { classifyAndRouteInbound } = await import("./inbound-intent-classifier")
    const routed = await classifyAndRouteInbound({
      leadId: call.lead_id,
      brokerageId: call.brokerage_id,
      message: transcript,
    })

    return {
      outcome: routed.outcome,
      contactId: routed.contactId,
      error: routed.error,
    }
  } catch (err) {
    // Best-effort: the call ledger is already closed; classification failure
    // must never break the voice webhook.
    console.error("[lead-call-intent] routing failed:", err)
    return { outcome: "skipped", error: err instanceof Error ? err.message : "routing failed" }
  }
}
