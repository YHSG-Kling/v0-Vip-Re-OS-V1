// NOT a server-action module (2026-09-03, lane R3-A; template
// lib/behavior-learning/preference-updater.ts:1-9). The module-level "use server"
// that stood here published checkCompliancePassed(offerId),
// emitCompliancePassed(params) and validateAcceptanceEligibility(offerId) as
// public HTTP doors with no gate — a service client that any session could
// point at any offers.id (the tenant is read from the offer row, so this was a
// cross-tenant probe-and-write, not a body-supplied tenant). Every caller is
// in-process server code (re-verified 2026-09-03):
//   · app/actions/compliance-bridge-actions.ts:17          ("use server")
//   · app/actions/buyer-offer/submit-to-compliance.ts:39   ("use server")
//   · app/actions/seller-offers.ts:136 (dynamic import)    ("use server")
//   · lib/buyer-offer/index.ts:2-7 (the barrel), whose value importers are
//     app/actions/buyer-offer/{submit-for-signature,respond-to-counter,
//     convert-to-transaction}.ts — all "use server"
// so the directive published nothing anyone needed. `server-only` makes a future
// client import fail at build time instead of bundling the service credential.
import "server-only"

/**
 * System 7.1B - Compliance Gate (ABSOLUTE)
 * 
 * NO PATH may emit buyer.offer.accepted or buyer.under_contract
 * without buyer.offer.compliance.passed in activities history.
 * 
 * This is the constitutional gate that prevents non-compliant offers
 * from advancing to acceptance.
 *
 * ── VOCABULARY NOTE ──────────────────────────────────────────────────────────
 * `buyer.offer.compliance.passed` is deliberately NOT in
 * `lib/buyer-offer/offer-lifecycle.ts:OFFER_EVENT`. That map is the STATE
 * MACHINE — `EVENT_TO_STATE` and `EVENT_TO_STATUS` are total
 * `Record<OfferEvent, …>`, so every name added there must have a state AND a
 * status. Compliance-passed has neither: it is an AUDIT/GATE event, not a
 * lifecycle transition (an offer's state is unchanged by passing compliance).
 * Adding it to OFFER_EVENT would force an invented state mapping.
 *
 * THAT RECOMMENDATION IS NOW DONE (wave 13). The standing note here — and in
 * docs/wave7-slice-writers.md — asked for a sibling `OFFER_AUDIT_EVENT` const in
 * offer-lifecycle.ts covering the non-state offer events, so the out-of-module
 * readers (convert-to-transaction.ts, lib/kernel/transactions.ts) could stop
 * spelling the literal. It exists, every reader and writer imports it, and the
 * two vocabularies are held disjoint by a type that fails to compile if a name
 * ever appears in both — so "an audit event must never be given a state" is
 * enforced by the compiler rather than by this comment.
 */

import { OFFER_AUDIT_EVENT } from "./offer-lifecycle"
import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"

export interface ComplianceCheckResult {
  passed: boolean
  complianceEventId?: string
  complianceTimestamp?: string
  error?: string
}

/**
 * Check if offer has compliance.passed event
 * 
 * This is the ONLY source of truth for compliance status.
 * Never check any column. Only check activities.
 */
export async function checkCompliancePassed(
  offerId: string
): Promise<ComplianceCheckResult> {
  if (!isValidUUID(offerId)) {
    return { passed: false, error: "Invalid offer ID" }
  }

  const supabase = createServiceClient()

  const { data: complianceEvent, error } = await supabase
    .from("activities")
    .select("id, created_at")
    .eq("entity_type", "offer")
    .eq("entity_id", offerId)
    .eq("activity_type", OFFER_AUDIT_EVENT.COMPLIANCE_PASSED)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error("[System 7.1B] Error checking compliance:", error)
    return { passed: false, error: error.message }
  }

  if (!complianceEvent) {
    return { passed: false, error: "Compliance event not found" }
  }

  return {
    passed: true,
    complianceEventId: complianceEvent.id,
    complianceTimestamp: complianceEvent.created_at,
  }
}

/**
 * Emit compliance.passed event — THE ONLY WRITER OF THIS EVENT.
 *
 * Called after internal compliance scan OR external compliance approval.
 *
 * ── MERGE (wave 7) ───────────────────────────────────────────────────────────
 * `app/actions/buyer-offer/submit-to-compliance.ts` carried a SECOND inline
 * insert of `buyer.offer.compliance.passed` (its step 3). Two writers of one
 * event, disagreeing on the key: this one supplied `entity_id` but NO
 * `brokerage_id`; that one supplied `brokerage_id` but NO `entity_id`. Both
 * therefore failed — this one wrote ZERO rows (brokerage_id is NOT NULL with no
 * default), and that one wrote a row that neither reader can find, because all
 * three readers gate on `entity_type='offer' AND entity_id=<offers.id>`:
 *   · lib/buyer-offer/compliance-gate.ts:checkCompliancePassed (just above)
 *   · app/actions/buyer-offer/convert-to-transaction.ts:110-112
 *   · lib/kernel/transactions.ts:221-223 (evaluateOfferCompliance)
 *
 * The two were MERGED onto this function — the richer audit shape from
 * submit-to-compliance (title / description / notes / contact_id / agent_id /
 * status / priority) is carried here, the duplicate insert was deleted, and
 * submit-to-compliance now calls this. SURVIVOR:
 * `lib/buyer-offer/compliance-gate.ts:emitCompliancePassed`.
 *
 * ── THE TENANT ───────────────────────────────────────────────────────────────
 * `brokerage_id` comes from `offers.brokerage_id`, NEVER from the caller. This
 * function is reachable over HTTP through the `"use server"` barrel
 * (app/actions/compliance-bridge-actions.ts:emitCompliancePassedAction), so a
 * caller-supplied tenant would let the gate row be filed under someone else's
 * brokerage.
 *
 * ── IDENTITY CLASS ───────────────────────────────────────────────────────────
 * `activities.agent_id` FKs `agents(id)`; `agent_user_id` is users-class. They
 * are disjoint spaces. `offers.agent_id` is already an agents id, so it is used
 * directly for `agent_id`; the caller's `userId` is users-class and only ever
 * goes to `agent_user_id`. Neither is ever `??`'d into the other.
 */
export async function emitCompliancePassed(params: {
  offerId: string
  userId: string
  scanResults?: Record<string, any>
  externalApprovalId?: string
  /** Which path emitted this — e.g. "agent_submit_to_compliance", "manual_bridge_panel". */
  source?: string
  /** Human-readable detail for the audit row. Defaults to a generic line. */
  description?: string
}): Promise<{ success: boolean; error?: string }> {
  const { offerId, userId, scanResults, externalApprovalId, source, description } = params

  if (!isValidUUID(offerId) || !isValidUUID(userId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = createServiceClient()

  // THE TENANT + THE KEY, both from the offer row. `error` is destructured:
  // supabase-js RESOLVES a refused read, so `const { data }` renders "refused"
  // and "no such offer" identically — and this is a GATE, so it fails CLOSED.
  const { data: offer, error: offerError } = await supabase
    .from("offers")
    .select("id, brokerage_id, contact_id, agent_id")
    .eq("id", offerId)
    .maybeSingle()

  if (offerError) {
    console.error("[System 7.1B] Could not read offer for compliance.passed:", offerError)
    return { success: false, error: `Could not read the offer: ${offerError.message}` }
  }
  if (!offer) return { success: false, error: "Offer not found" }
  if (!offer.brokerage_id) {
    // activities.brokerage_id is NOT NULL with no default — without it the
    // insert writes zero rows and the gate this exists to open never opens.
    return { success: false, error: "Offer has no brokerage — cannot record the compliance gate" }
  }

  const now = new Date().toISOString()

  const { error } = await supabase.from("activities").insert({
    // NOT NULL — omitted before, which is why this writer had never once landed.
    brokerage_id:  offer.brokerage_id,
    entity_type:   "offer",
    entity_id:     offerId,
    activity_type: OFFER_AUDIT_EVENT.COMPLIANCE_PASSED,
    // agents-class from the offer; users-class from the caller. Never crossed.
    agent_id:      offer.agent_id ?? null,
    agent_user_id: userId,
    contact_id:    offer.contact_id ?? null,
    title:         "Compliance gate passed",
    description:   description ?? `Compliance gate recorded for offer ${offerId}.`,
    notes:         JSON.stringify({ offer_id: offerId, source: source ?? "compliance_gate", external_approval_id: externalApprovalId ?? null }),
    metadata: {
      offer_id:             offerId,
      scan_results:         scanResults,
      external_approval_id: externalApprovalId,
      source:               source ?? "compliance_gate",
      timestamp:            now,
    },
    status:        "completed",
    priority:      "high",
  })

  if (error) {
    console.error("[System 7.1B] Error emitting compliance.passed:", error)
    return { success: false, error: error.message }
  }

  return { success: true }
}

/**
 * Validate acceptance eligibility
 * 
 * Throws error if offer cannot be accepted.
 * Use this before emitting acceptance events.
 */
export async function validateAcceptanceEligibility(
  offerId: string
): Promise<void> {
  const complianceCheck = await checkCompliancePassed(offerId)

  if (!complianceCheck.passed) {
    throw new Error(
      `Cannot accept offer ${offerId}: ${complianceCheck.error || "compliance.passed event not found"}`
    )
  }
}
