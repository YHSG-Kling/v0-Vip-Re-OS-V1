"use server"

/**
 * app/actions/lead-signal-ingest.ts
 *
 * Thin server actions that the rest of the codebase calls when a
 * qualifying event happens. They build the SignalDelta and apply it
 * through the existing scoring path — no new tables, no replacement of
 * the AI scoring logic.
 *
 * Existing call sites that plug into these:
 *   • Buyer offer workflow → ingestOfferLostSignalAction (when an offer's
 *     final state is `lost` or `withdrawn_after_competing_accepted`)
 *     — wired: app/actions/seller-offers.ts
 *   • Open house attendee submission → ingestOpenHouseAttendeeSignalAction
 *     — wired: app/actions/seller-open-house.ts
 *   • The existing lead-scraping pipeline → ingestPredictiveSellerSignalAction
 *     (each predictive contributor — equity threshold, life event, etc.
 *     — calls in with its own signalKey + confidence)
 *     — NOT yet wired; see the note on that export.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SECURITY — why every export here is gated (w2s3)
 *
 * This file is `"use server"`, so each export is a publicly reachable HTTP
 * endpoint. `applySignalDelta()` runs on the SERVICE client and filters on
 * `contact_id` alone, so RLS is not in play once the delta reaches it.
 * Before this pass none of the three exports authenticated at all: any
 * unauthenticated caller could POST a `contactId` belonging to ANY
 * brokerage and push that tenant's lead scores up, plus write an
 * attributed `lead_score_history` audit row that looked like the platform
 * had observed a real signal.
 *
 * The gate below runs BEFORE any delta is built. It authenticates, then
 * proves the contact lives in the caller's brokerage using the COOKIE
 * client (so RLS applies to the check itself), and it fails CLOSED: a
 * refused or errored read is rejected, never treated as "no rows".
 * ─────────────────────────────────────────────────────────────────────────
 */

import { resolveWriteContext } from "@/lib/kernel/identity"
import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"
import {
  applySignalDelta,
  buildOfferLostSignal,
  buildOpenHouseAttendeeSignal,
  buildPredictiveSellerSignal,
} from "@/lib/lead-intelligence/signal-extensions"

type IngestResult = { applied: boolean; reason?: string }

/**
 * Authenticate the caller and prove `contactId` belongs to the caller's
 * brokerage. Returns a rejection *reason* rather than throwing so the
 * fire-and-forget call sites (`.catch(() => {})`) keep their shape and a
 * rejected signal never blocks the business action that emitted it.
 *
 * Fails closed on a refused read — a signal that cannot be proven in-tenant
 * is not applied.
 */
async function authorizeContactInTenant(
  contactId: string,
): Promise<{ ok: true; brokerageId: string } | { ok: false; reason: string }> {
  if (!contactId || !isValidUUID(contactId)) {
    return { ok: false, reason: "invalid_contact_id" }
  }

  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated) return { ok: false, reason: "unauthorized" }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()

  // A refused read resolves as `{ data: null, error }`. Treating that as
  // "contact not found" would be correct here by accident, but treating it
  // as "no error" anywhere in this chain would be a fail-open gate — so the
  // error branch is explicit and distinguishable in the returned reason.
  if (error) return { ok: false, reason: "contact_scope_check_failed" }
  if (!data) return { ok: false, reason: "contact_not_in_tenant" }

  return { ok: true, brokerageId: ctx.brokerageId }
}

export async function ingestOfferLostSignalAction(input: {
  contactId: string
  offerId: string
  offerAmount: number
  losingMargin?: number
}): Promise<IngestResult> {
  const gate = await authorizeContactInTenant(input.contactId)
  if (!gate.ok) return { applied: false, reason: gate.reason }

  // offerAmount only feeds the human-readable reason string, but a non-finite
  // value would render as "$NaN" in the audit trail.
  const offerAmount = Number.isFinite(Number(input.offerAmount)) ? Number(input.offerAmount) : 0
  const losingMargin = Number.isFinite(Number(input.losingMargin)) ? Number(input.losingMargin) : undefined

  const delta = buildOfferLostSignal({
    contactId: input.contactId,
    offerId: input.offerId,
    offerAmount,
    losingMargin,
  })
  return applySignalDelta(delta)
}

export async function ingestOpenHouseAttendeeSignalAction(input: {
  contactId: string
  attendeeId: string
  listingId: string
  interestLevel?: 1 | 2 | 3 | 4 | 5
}): Promise<IngestResult> {
  const gate = await authorizeContactInTenant(input.contactId)
  if (!gate.ok) return { applied: false, reason: gate.reason }

  // interestLevel is multiplied into the boost, so an out-of-range or
  // non-integer value from the wire would scale the score arbitrarily.
  const raw = Number(input.interestLevel)
  const interestLevel = (
    Number.isInteger(raw) && raw >= 1 && raw <= 5 ? raw : undefined
  ) as 1 | 2 | 3 | 4 | 5 | undefined

  const delta = buildOpenHouseAttendeeSignal({
    contactId: input.contactId,
    attendeeId: input.attendeeId,
    listingId: input.listingId,
    interestLevel,
  })
  return applySignalDelta(delta)
}

/**
 * Predictive-seller signal.
 *
 * NOT YET WIRED. The lane it was written for is the lead-scraping pipeline
 * (`app/api/cron/lead-scraping/route.ts`), which runs with no user session —
 * so it cannot call this gated action. Finishing the wiring means having the
 * pipeline call the library entry point `applySignalDelta()` directly (it is
 * `import "server-only"`, service-client, and already idempotent per
 * (contact, source, evidence, day)) with a brokerage-scoped contact it has
 * already resolved. That call site lives outside this slice's file set, so
 * the endpoint is hardened in place and left for the pipeline owner.
 *
 * It is kept as an action because the interactive surfaces that surface a
 * predictive signal for manual confirmation (the seller-signal review lane)
 * do have a session and can call it directly.
 */
export async function ingestPredictiveSellerSignalAction(input: {
  contactId: string
  signalKey: string
  signalLabel: string
  confidence: number
  evidenceId?: string | null
  evidence?: Record<string, unknown>
}): Promise<IngestResult> {
  const gate = await authorizeContactInTenant(input.contactId)
  if (!gate.ok) return { applied: false, reason: gate.reason }

  // The builder clamps with Math.min/Math.max, which propagates NaN rather
  // than rejecting it: a non-numeric `confidence` from the wire would reach
  // `Math.round(15 * NaN) + 3` and land NaN/null in lead_score_history's
  // numeric score columns. Reject it here instead.
  const confidence = Number(input.confidence)
  if (!Number.isFinite(confidence)) {
    return { applied: false, reason: "invalid_confidence" }
  }

  const signalKey = String(input.signalKey ?? "").trim()
  const signalLabel = String(input.signalLabel ?? "").trim()
  if (!signalKey || !signalLabel) {
    return { applied: false, reason: "missing_signal_identity" }
  }

  const delta = buildPredictiveSellerSignal({
    contactId: input.contactId,
    signalKey: signalKey.slice(0, 120),
    signalLabel: signalLabel.slice(0, 200),
    confidence: Math.max(0, Math.min(1, confidence)),
    evidenceId: input.evidenceId ?? null,
    evidence: input.evidence,
  })
  return applySignalDelta(delta)
}
