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

// ─────────────────────────────────────────────────────────────────────────────
// STORAGE SPELLING — the canonical vocabulary above is NOT what the tenant
// column holds, and that gap silently voided the paywall.
//
// subscriptions.status is CHECK-constrained to exactly:
//     active | past_due | cancelled | trialing | paused
// Note the spelling: 'cancelled', two Ls. The canonical set above normalizes
// TO 'canceled', one L, because that is what Stripe emits.
//
// The billing webhook wrote Stripe's RAW status straight through
// (`status: s.status` in normalizeSub) without going near this file, and
// upsertBrokerageSubscription discards the update result. So when a tenant
// cancelled, Stripe sent status='canceled', the CHECK rejected the write,
// supabase-js resolved with { error } instead of throwing, the error was
// dropped on the floor — and the row KEPT ITS PREVIOUS 'active' STATUS.
// resolveBillingAccess then read 'active' and let them straight in.
//
// A cancelled tenant kept full paid access, indefinitely. Same for 'unpaid',
// 'incomplete' and 'incomplete_expired' — every Stripe status the column cannot
// spell was a write that vanished. The CHECK-vocabulary guard could not see it
// because the value arrives in a VARIABLE from the Stripe API, and that guard
// only reads inline literals.
//
// This maps the canonical status onto a value the column can actually store, so
// the write lands. No vocabulary is invented: every target below is already one
// of the five admitted values.
export type StoredSubStatus = "active" | "past_due" | "cancelled" | "trialing" | "paused"

/**
 * PURE — the value to persist in subscriptions.status, or null when the status
 * is one we should NOT overwrite the row with.
 *
 * 'incomplete' maps to 'past_due': an initial invoice that never succeeded is a
 * delinquent, non-paying state, and past_due is the admitted value that blocks.
 * 'unknown' maps to null — a status we do not recognise must leave the existing
 * row alone rather than guess a state that gates someone's access.
 */
export function toStoredSubscriptionStatus(
  status: string | null | undefined,
): StoredSubStatus | null {
  switch (normalizeStripeStatus(status)) {
    case "active":    return "active"
    case "trialing":  return "trialing"
    case "paused":    return "paused"
    case "past_due":  return "past_due"   // Stripe 'unpaid' normalizes here too
    case "canceled":  return "cancelled"  // one L → two Ls: the storage spelling
    case "incomplete":return "past_due"
    default:          return null
  }
}
