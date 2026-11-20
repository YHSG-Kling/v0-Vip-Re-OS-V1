/**
 * scripts/event-claims-ledger.ts — THE ONE COPY of the two event-claims ledgers (wave 155, lane 155R22; CLAUDE.md §6).
 *
 * Read by BOTH scripts/event-claims-guard.ts (test:event-claims, which holds the ratchet on them) and
 * scripts/os-coverage-ledger.ts (the arbitration census, which classifies the same events). Before this module the census
 * knew neither map, so one guard on the chain called an event "owner-held" and the census called the SAME event a
 * "P0 executable gap". The guard registers module hooks at import time (its own `server-only` / service-client stubs),
 * so the census cannot import the guard itself: the lists live here, with no side effect, and are never retyped.
 *
 *   EVENT_OWNER_HELD    fan-out events no reactor case claims, each waiting on ONE owner question ("record or consumer?").
 *                       SHRINK-ONLY: test:event-claims fails a stale entry; the census fails an entry whose event is gone
 *                       or that its own row does not hold (a stale list cannot hold a row).
 *   CONDITIONAL_AUDIT   an `auditOnly: <expression>` whose TRUE branch is exactly that event — named, and re-verified
 *                       against the file's comment-stripped code by conditionalAuditVerified (else it would hide a fan-out).
 */

// ─── the owner-held list (moved verbatim from scripts/event-claims-guard.ts, lane 155R6) ─────────────────────────────────
// "record?" = is the lifecycle_events row the whole point (auditOnly: true at the emit site), or must a registered manager
// act (a consumer)? Lane 155R6 did not decide that (brief: "do NOT decide that yourself"). Shrink-only.
// WAVE 155 (lane 155R22): enrichment_completed REMOVED — its only emit site is a direct lifecycle_events insert
// (lib/lead-pipeline/enrichment-orchestrator.ts:1115), a record that never reaches the reactor; the guard's classifier read it
// as fan-out because that site rides no door call and its file also fans out (CONTACT_ENRICHMENT_COMPLETED through
// processKernelEvent). The census already proved it audit-only. Control: scripts/event-claims-guard.ts §A ("direct insert").
export const EVENT_OWNER_HELD: Record<string, string> = {
  brand_compliance_passed:        "record? brand scan passed (lib/kernel/brand-compliance.ts); nothing must act on a pass",
  brand_compliance_failed:        "record or consumer? a failed brand scan — compliance_officer could hold the piece; no signal fits today",
  buyer_disengaged:               "record? a buyer lifecycle state (lib/kernel/lifecycle.ts map); BUYER_STATE_CHANGED already reaches the concierges",
  buyer_search_executed:          "record? a buyer lifecycle state echo (same as above)",
  cda_generated:                  "record? a CDA row was generated (app/actions/cda-portal.ts); approval is the CDA portal's own door",
  contact_enrichment_completed:   "record? enrichment landed (lib/lead-pipeline/enrichment-orchestrator.ts); failure already routes (contact_enrichment_failed → ai_isa)",
  credit_status_updated:          "record? the credit status change (app/actions/credit-copilot.ts → logCreditStatusUpdated). Both orchestrator bodies are retired onto triggerCreditFlowActions (lane 155R24); is the lifecycle row the whole point (auditOnly: true), or must a manager act?",
  deal_on_hold:                   "record? a buyer lifecycle state echo (lib/kernel/lifecycle.ts)",
  integration_failed:             "record? an admin's own integration TEST failed (app/api/integrations/test) — the admin is looking at the result",
  marketing_campaign_approved:    "record? the approval is decided by decideMarketingApproval (lib/kernel/approval-authority.ts); the event is its echo",
  offer_eligible:                 "record? a buyer lifecycle state echo (lib/kernel/lifecycle.ts)",
  property_recommended:           "record? a buyer FAVORITED one of our listings (lib/kernel/forms.ts); the preference learner already runs inline",
  referral_advanced:              "record or consumer? a referral moved stage (app/actions/referrals) — sphere_of_influence has referral_received / referral_reciprocity, neither is this moment",
  report_generated:               "record? a report was generated (lib/kernel/reporting.ts emitEvent fans out)",
  report_emailed:                 "record? a report was EMAILED (lib/kernel/reporting.ts emitEvent fans out; the financial.ts copy is already audit-only) — the send is the act",
  report_exported_csv:            "record? a report was exported (lib/kernel/reporting.ts emitEvent fans out; the financial.ts copy is already audit-only)",
  report_exported_pdf:            "record? a report was exported (lib/kernel/reporting.ts emitEvent fans out; the financial.ts copy is already audit-only)",
  seller_declined:                "record or consumer? a seller DECLINED to list (app/actions/seller-listing/execution-engine.ts recordSellerDecision) — the Listing Concierge could close out the seller journey; no signal fits",
  subscription_reminder_sent:     "record? a reminder was SENT (lib/billing/stripe-subscription-ops.ts) — the send is the act",
  tour_eligible:                  "record? a buyer lifecycle state echo (lib/kernel/lifecycle.ts)",
  tour_planned:                   "record? a buyer lifecycle state echo (lib/kernel/lifecycle.ts)",
  user_account_incomplete:        "record? self-heal finding on dashboard load (app/dashboard/page.tsx)",
  user_account_repaired:          "record? self-heal outcome (lib/kernel/users.ts)",
  user_brokerage_assigned:        "record? provisioning step (lib/kernel/users.ts)",
  user_domain_records_created:    "record? provisioning step (lib/kernel/users.ts)",
  user_domain_records_repaired:   "record? provisioning step (lib/kernel/users.ts)",
  user_invited:                   "record? an invite was sent (app/actions/admin/invite-user.ts) — the send is the act",
  user_onboarding_started:        "record? onboarding started (lib/kernel/onboarding.ts); the onboarding-health sweep already watches stalls",
}

/** An `auditOnly: <expression>` whose TRUE branch is exactly this event — named, and re-verified against the file's code. */
export const CONDITIONAL_AUDIT: Record<string, { file: string; expr: RegExp }> = {
  // a REOPENED dispute is an audit echo; only the APPROVED branch fans out (wave 154, lane 154A3), and that one is claimed
  commission_calculated: { file: "lib/kernel/financial.ts", expr: /event:\s*nextStatus === "approved" \? KernelEvent\.COMMISSION_APPROVED : KernelEvent\.COMMISSION_CALCULATED,[\s\S]{0,400}?auditOnly:\s*nextStatus !== "approved"/ },
}

/** PURE — true only when `value` has a CONDITIONAL_AUDIT entry naming `file` AND its expression still matches that file's
 *  COMMENT-STRIPPED code (scripts/strip-comments.ts stripComments — the caller passes it; a tombstone cannot satisfy it). */
export function conditionalAuditVerified(value: string, file: string, strippedCode: string, table: Record<string, { file: string; expr: RegExp }> = CONDITIONAL_AUDIT): boolean {
  const x = table[value]
  return !!x && x.file === file && x.expr.test(strippedCode)
}
