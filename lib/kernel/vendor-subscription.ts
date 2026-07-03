// lib/kernel/vendor-subscription.ts
//
// VENDOR SUBSCRIPTION TIERS (finance_manager) — the "vendors PAY the platform" revenue model. A vendor's
// paid tier gates what the marketplace lets them do; their billing STATUS gates whether they keep platform
// access at all. This is the vendor-pays-platform direction — distinct from Stripe Connect payouts OUT
// (stripe_account_id), which flow the other way.
//
// Pure catalog + gating (testable); the Stripe billing calls live in app/actions/vendor-billing.ts and the
// webhook route, both of which reuse the canonical lib/stripe proxy. HONEST: pricing/price-ids are config
// (env / marketplace_settings), so the catalog carries display prices only — the source of truth for a
// charge is always Stripe.

export type VendorTier = "basic" | "standard" | "premium" | "preferred_network"
export type SubscriptionStatus = "active" | "past_due" | "canceled" | "trialing"

export interface TierCapabilities {
  tier: VendorTier
  monthlyPriceUsd: number
  /** Eligible to be AI-surfaced to clients (basic is NOT — spec rule). */
  surfacingEligible: boolean
  /** Eligible to be added to a brokerage's preferred list (premium+). */
  preferredEligible: boolean
  /** Eligible to buy featured placement (preferred_network only). */
  featuredEligible: boolean
  /** Number of service-area zones the tier unlocks. */
  serviceAreaZones: number
  /** Service packages the tier allows. */
  packageLimit: number
}

export const VENDOR_TIERS: Record<VendorTier, TierCapabilities> = {
  basic:             { tier: "basic",             monthlyPriceUsd: 49,  surfacingEligible: false, preferredEligible: false, featuredEligible: false, serviceAreaZones: 1,   packageLimit: 3 },
  standard:          { tier: "standard",          monthlyPriceUsd: 149, surfacingEligible: true,  preferredEligible: false, featuredEligible: false, serviceAreaZones: 3,   packageLimit: 10 },
  premium:           { tier: "premium",           monthlyPriceUsd: 299, surfacingEligible: true,  preferredEligible: true,  featuredEligible: false, serviceAreaZones: 999, packageLimit: 999 },
  preferred_network: { tier: "preferred_network", monthlyPriceUsd: 599, surfacingEligible: true,  preferredEligible: true,  featuredEligible: true,  serviceAreaZones: 999, packageLimit: 999 },
}

const TIER_ORDER: VendorTier[] = ["basic", "standard", "premium", "preferred_network"]

/** PURE: normalize an arbitrary tier string to a known tier (defaults to basic). */
export function normalizeTier(tier: string | null | undefined): VendorTier {
  const t = (tier ?? "").toLowerCase()
  return (TIER_ORDER as string[]).includes(t) ? (t as VendorTier) : "basic"
}

/** PURE: capabilities for a tier. */
export function tierCapabilities(tier: string | null | undefined): TierCapabilities {
  return VENDOR_TIERS[normalizeTier(tier)]
}

/**
 * PURE: the EFFECTIVE capabilities given the billing status. A non-current subscription (past_due beyond
 * grace, or canceled) collapses to `basic` capabilities — the vendor keeps a listing but loses surfacing/
 * preferred/featured until they're current again. `active`/`trialing` use the paid tier as-is.
 */
export function effectiveCapabilities(tier: string | null | undefined, status: string | null | undefined): TierCapabilities {
  const s = (status ?? "active").toLowerCase()
  if (s === "canceled" || s === "past_due") return VENDOR_TIERS.basic
  return tierCapabilities(tier)
}

/** PURE: does this vendor (tier + status) currently qualify for a capability? */
export function tierAllows(tier: string | null | undefined, status: string | null | undefined, capability: "surfacing" | "preferred" | "featured"): boolean {
  const caps = effectiveCapabilities(tier, status)
  return capability === "surfacing" ? caps.surfacingEligible : capability === "preferred" ? caps.preferredEligible : caps.featuredEligible
}

/**
 * PURE: map a Stripe subscription lifecycle event to our status + whether the vendor's platform account
 * should be suspended. Payment failure → past_due (features off, listing kept); cancellation/unpaid →
 * canceled + suspend the account. The webhook applies this; nothing else interprets Stripe events.
 */
export function mapStripeEventToStatus(eventType: string, stripeStatus?: string | null): { status: SubscriptionStatus; suspendAccount: boolean } {
  switch (eventType) {
    case "invoice.payment_failed":
      return { status: "past_due", suspendAccount: false }
    case "customer.subscription.deleted":
      return { status: "canceled", suspendAccount: true }
    case "invoice.payment_succeeded":
    case "customer.subscription.created":
      return { status: "active", suspendAccount: false }
    case "customer.subscription.updated": {
      const s = (stripeStatus ?? "").toLowerCase()
      if (s === "past_due" || s === "unpaid") return { status: "past_due", suspendAccount: false }
      if (s === "canceled") return { status: "canceled", suspendAccount: true }
      if (s === "trialing") return { status: "trialing", suspendAccount: false }
      return { status: "active", suspendAccount: false }
    }
    default:
      return { status: "active", suspendAccount: false }
  }
}
