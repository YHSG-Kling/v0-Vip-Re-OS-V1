/**
 * lib/buyer-search/written-criteria-alert.ts
 *
 * WRITTEN CRITERIA → LIVING ALERT (text-thread half).
 *
 * The same listener the voice sweep (lib/voice/call-analysis.ts) runs on call
 * transcripts, pointed at the buyer's WRITTEN words: when an inbound email or
 * SMS body states concrete search criteria ("3 bed under 650k in Mocksley"),
 * propose ONE inactive property alert on the approval rail.
 *
 * Contract (identical to the spoken lane, provenance kept honest):
 *   - Reads ONLY the CONTACT's inbound body — never the AI's replies.
 *   - Requires a linked contact + brokerage; criteria without a buyer record
 *     to alert are just chatter.
 *   - Gate unchanged: high confidence + ≥2 distinct concrete signals.
 *   - is_active=false, source 'text_conversation' — the agent approves in
 *     /approvals (the aggregator's pa: cascade accepts both sources);
 *     nothing self-activates.
 *   - Deduped per source message: [msg:<provider id or content hash>] in
 *     alert_name, mirroring the voice lane's [call:<id>].
 *   - paused_reason carries the [TEXT_PROPOSAL] state marker + the buyer's
 *     literal quotes ("They wrote: …") — approval clears the column.
 */

import "server-only"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import {
  extractCriteriaFromTranscript,
  criteriaToAlertRow,
  describeCriteria,
  writtenAlertMessageMarker,
  hashConversationText,
  TEXT_ALERT_SOURCE,
  TEXT_PROPOSAL_MARKER,
} from "./conversation-criteria"

/** Same bar as the voice lane's SPOKEN_ALERT_MIN_SIGNALS. */
export const WRITTEN_ALERT_MIN_SIGNALS = 2

export async function proposeWrittenCriteriaAlert(svc: any, input: {
  brokerageId: string
  contactId: string
  /** users.id of the owning agent (property_alerts.agent_user_id class). */
  agentUserId: string | null
  /** Stable id of the inbound message (provider MessageSid / message row id).
   *  Omit and the body is content-hashed — a re-delivered webhook of the
   *  same text still dedupes. */
  messageRef?: string | null
  /** The CONTACT's inbound body only — never AI output. */
  body: string
  /** Wave 147C: which ear heard it. When omitted, the two existing callers are told apart by
   *  their message ref — the SMS router passes the provider MessageSid, the email path passes
   *  null (both verified at 4d527cc3; the lane-147C notes ask each caller to pass it explicitly). */
  channel?: "email" | "sms" | "portal" | "mobile" | "voice"
}): Promise<boolean> {
  if (!input.contactId || !input.brokerageId) return false
  try {
    const body = (input.body ?? "").trim()
    if (!body) return false

    // WAVE 147C (C10) — THE ONE STORE HEARS EMAIL AND SMS TOO. Whatever the buyer states in writing
    // ("actually under 550k", "no HOA") updates their saved criteria with per-field provenance
    // (said, channel email/sms) through the ONE ledgered writer — the same one the portal turn uses
    // — before the alert gate below (a single refinement is worth remembering even when it is not
    // enough to propose an alert). Rules only: no model spend on every inbound "thanks!". The
    // ledger key is the message, so a re-delivered webhook replays instead of applying twice.
    // Best-effort: a failure here never breaks ingress or the alert proposal.
    // BUYER SIDE ONLY: a seller writing "we'd list at 600k" is not stating a buyer budget — only a
    // buyer / both contact's words reach the buyer criteria store (lib/contact-types.ts, the
    // wave-108 sides ruling). The read is tenant-bounded and its error is read.
    try {
      const { data: who, error: whoError } = await svc.from("contacts").select("contact_type")
        .eq("id", input.contactId).eq("brokerage_id", input.brokerageId).maybeSingle()
      const { isBuyerSideContactType } = await import("@/lib/contact-types")
      if (whoError) {
        console.error("[written-criteria] contact side read refused — criteria store skipped:", whoError.message)
      } else if (who && isBuyerSideContactType((who as { contact_type: string | null }).contact_type)) {
        const ref = (input.messageRef ?? "").trim() || hashConversationText(`${input.contactId}:${body}`)
        const { recordStatedCriteriaTurn } = await import("./criteria-turn")
        const turn = await recordStatedCriteriaTurn(svc, {
          brokerageId: input.brokerageId,
          contactId: input.contactId,
          text: body,
          channel: input.channel ?? (input.messageRef ? "sms" : "email"),
          actor: { type: "system" },
          idempotencyKey: `buyer_search.criteria.update:${input.contactId}:msg:${ref}`,
          allowModelAssist: false,
          // the ledger row goes through the same (service) client the inbound router handed us
          ledgerClient: svc,
        })
        if (turn.error) console.error("[written-criteria] stated criteria not saved to the buyer's search:", turn.error)
      }
    } catch (err) {
      console.error("[written-criteria] stated-criteria persistence failed (non-blocking):", err)
    }

    const extraction = extractCriteriaFromTranscript(body)
    if (extraction.confidence !== "high" || extraction.signalCount < WRITTEN_ALERT_MIN_SIGNALS) return false

    // IDEMPOTENT: one proposal per source message — the marker lives in
    // alert_name and survives approval, so a re-run can never double-propose.
    const ref = (input.messageRef ?? "").trim() || hashConversationText(`${input.contactId}:${body}`)
    const marker = writtenAlertMessageMarker(ref)
    const { data: dup } = await svc.from("property_alerts").select("id")
      .eq("contact_id", input.contactId).ilike("alert_name", `%${marker}%`).limit(1).maybeSingle()
    if (dup) return false

    const row = criteriaToAlertRow(extraction.criteria, {
      contactId: input.contactId,
      agentUserId: input.agentUserId,
      brokerageId: input.brokerageId,
      alertName: `${describeCriteria(extraction.criteria)} ${marker}`,
      source: TEXT_ALERT_SOURCE,
    })
    // The approval card leads with the buyer's literal words — the evidence
    // that the criteria were STATED, not inferred (the no-steering line).
    const wrote = extraction.evidence.map((q) => `"${q}"`).join(" · ")
    return await sentinelWrite(svc, svc.from("property_alerts").insert({
      ...row,
      paused_reason: `${TEXT_PROPOSAL_MARKER} They wrote: ${wrote}`.slice(0, 600),
    }), { table: "property_alerts", flow: "written_criteria_alert", brokerageId: input.brokerageId })
  } catch {
    return false
  }
}
