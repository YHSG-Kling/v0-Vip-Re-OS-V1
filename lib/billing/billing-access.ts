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

// subscriptions.status admits exactly: active | past_due | cancelled | trialing |
// paused. 'unpaid', 'incomplete_expired' and the American 'canceled' are values
// this column cannot hold — they rode along inertly with the three real ones.
// Kept OUT rather than kept "just in case": a set that lists impossible states
// reads as though they are reachable.
const BLOCKING_STATUSES = new Set(["past_due", "cancelled", "paused"])
const ACTIVE_STATUSES = new Set(["active", "trialing"])

/** PURE: classify a brokerage's access from its subscription row + now. */
export function resolveBillingAccess(sub: BillingSubRow | null, now: Date = new Date()): BillingAccess {
  if (!sub) return { state: "none", blocked: false, trialDaysLeft: null, reason: "no_subscription" }

  const status = (sub.status ?? "").toLowerCase()

  if (BLOCKING_STATUSES.has(status)) {
    return { state: status === "past_due" || status === "unpaid" ? "past_due" : "expired", blocked: true, trialDaysLeft: null, reason: `status_${status}` }
  }

  // A trial that has run out is a hard paywall — this is the core enforcement.
  if (status === "trialing" && sub.trial_end) {
    const end = Date.parse(sub.trial_end)
    if (Number.isFinite(end)) {
      const msLeft = end - now.getTime()
      if (msLeft <= 0) return { state: "expired", blocked: true, trialDaysLeft: 0, reason: "trial_expired" }
      return { state: "trialing", blocked: false, trialDaysLeft: Math.ceil(msLeft / 86_400_000), reason: "trialing" }
    }
  }

  if (ACTIVE_STATUSES.has(status)) {
    return { state: status === "trialing" ? "trialing" : "active", blocked: false, trialDaysLeft: null, reason: `status_${status}` }
  }

  // Unknown status → don't lock out (fail-open), but surface it.
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
