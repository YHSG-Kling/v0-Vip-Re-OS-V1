// lib/billing/stripe-status.ts
// ─────────────────────────────────────────────────────────────────────────────
// ONE canonical Stripe subscription-status vocabulary, shared by BOTH billing
// paths (brokerage tenants → subscriptions; marketplace vendors → vendor_marketplace_
// profiles). They are separate customer entities (correctly separate stores), but
// they must classify Stripe status the SAME way so oversight / paywall / capability
// gating can't diverge. Pure + unit-testable.

export type CanonicalSubStatus =
  | "active" | "trialing" | "past_due" | "canceled" | "paused" | "incomplete" | "unknown"

/** Map any Stripe subscription.status (or our own spellings) to the canonical set. */
export function normalizeStripeStatus(status: string | null | undefined): CanonicalSubStatus {
  const s = (status ?? "").trim().toLowerCase()
  switch (s) {
    case "active": return "active"
    case "trialing": return "trialing"
    case "past_due":
    case "unpaid": return "past_due"
    case "canceled":
    case "cancelled": return "canceled"
    case "paused": return "paused"
    case "incomplete":
    case "incomplete_expired": return "incomplete"
    default: return s ? "unknown" : "unknown"
  }
}

/** Does this status grant current, paid access? (trialing handled by the caller with trial_end.) */
export function isCurrentStatus(status: string | null | undefined): boolean {
  const c = normalizeStripeStatus(status)
  return c === "active" || c === "trialing"
}

/** Is this a hard non-paying state that should suspend/paywall? */
export function isDelinquentStatus(status: string | null | undefined): boolean {
  const c = normalizeStripeStatus(status)
  return c === "past_due" || c === "canceled" || c === "incomplete"
}
