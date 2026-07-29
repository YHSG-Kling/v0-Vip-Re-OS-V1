// lib/billing/billing-access.ts
// ─────────────────────────────────────────────────────────────────────────────
// The hands-off paywall brain: does a brokerage currently have paid access?
// Pure classifier (unit-testable) + a loader. The login gate uses this to route a
// lapsed-trial / past-due / cancelled tenant to billing so the money loop closes
// itself — a customer that stops paying stops getting the product, with no human
// in the loop. Conservative by design: a brokerage with NO subscription row is NOT
// blocked (legacy / staff-created accounts must never be locked out by accident).

export type BillingAccessState = "active" | "trialing" | "past_due" | "expired" | "none"

export interface BillingAccess {
  state: BillingAccessState
  /** True → the tenant should be routed to the paywall (billing page). */
  blocked: boolean
  /** Whole days left in the trial (>=0), or null when not trialing. */
  trialDaysLeft: number | null
  reason: string
}

export interface BillingSubRow {
  status: string | null
  trial_end: string | null
}

// CLASSIFY THROUGH THE ONE SHARED VOCABULARY, not a second local set.
//
// This used to hold its own literal set — `["past_due", "cancelled", "paused"]` —
// justified by the fact that subscriptions.status is CHECK-constrained to those
// spellings and so 'canceled' (Stripe's one-L spelling) "cannot happen". The
// premise was right about the column and wrong about the risk: the billing
// webhook was writing Stripe's RAW status into that column, the CHECK rejected
// every foreign spelling, the discarded update left the row on its previous
// 'active', and this function then read 'active' and let a cancelled tenant
// through. Reasoning from what a column ADMITS, when the writer was never
// checked, is how a paywall ends up never firing.
//
// The writer is fixed (lib/billing/stripe-status.ts toStoredSubscriptionStatus,
// wired into the webhook), but this stays defensive on purpose: it is the last
// gate before someone gets the product for free, legacy rows predate the fix,
// and normalizeStripeStatus is the same vocabulary the vendor billing path
// already classifies with. One vocabulary, both paths, every spelling.
import { normalizeStripeStatus } from "./stripe-status"

/** PURE: classify a brokerage's access from its subscription row + now. */
export function resolveBillingAccess(sub: BillingSubRow | null, now: Date = new Date()): BillingAccess {
  if (!sub) return { state: "none", blocked: false, trialDaysLeft: null, reason: "no_subscription" }

  const status = (sub.status ?? "").toLowerCase()
  const canonical = normalizeStripeStatus(status)

  // canceled (either spelling) / past_due / unpaid / incomplete / paused all stop access.
  if (canonical === "past_due" || canonical === "canceled" || canonical === "incomplete" || canonical === "paused") {
    return { state: canonical === "past_due" ? "past_due" : "expired", blocked: true, trialDaysLeft: null, reason: `status_${status}` }
  }

  // A trial that has run out is a hard paywall — this is the core enforcement.
  if (canonical === "trialing" && sub.trial_end) {
    const end = Date.parse(sub.trial_end)
    if (Number.isFinite(end)) {
      const msLeft = end - now.getTime()
      if (msLeft <= 0) return { state: "expired", blocked: true, trialDaysLeft: 0, reason: "trial_expired" }
      return { state: "trialing", blocked: false, trialDaysLeft: Math.ceil(msLeft / 86_400_000), reason: "trialing" }
    }
  }

  if (canonical === "active" || canonical === "trialing") {
    return { state: canonical === "trialing" ? "trialing" : "active", blocked: false, trialDaysLeft: null, reason: `status_${status}` }
  }

  // Unknown status → don't lock out (fail-open), but surface it. Deliberate:
  // a status nobody recognises must never lock out a paying customer. Every
  // status Stripe actually emits is classified above, so reaching here means a
  // genuinely new value, and the reason string carries it for the operator.
  return { state: "none", blocked: false, trialDaysLeft: null, reason: `status_unknown_${status || "empty"}` }
}

/** Load a brokerage's most-recent subscription and classify access. */
export async function loadBillingAccess(svc: any, brokerageId: string, now: Date = new Date()): Promise<BillingAccess> {
  const { data } = await svc
    .from("subscriptions")
    .select("status, trial_end, created_at")
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  return resolveBillingAccess((data as BillingSubRow) ?? null, now)
}
