// lib/kernel/vendor-subscription.ts
//
// VENDOR SUBSCRIPTION TIERS (finance_manager) — the "vendors PAY the platform" revenue model. A vendor's
// paid tier gates what the marketplace lets them do; their billing STATUS gates whether they keep platform
// access at all. This is the vendor-pays-platform direction — distinct from Stripe Connect payouts OUT
// (stripe_account_id), which flow the other way.
//
// Pure catalog + gating (testable); the Stripe billing calls live in app/actions/vendor-billing.ts and the
// webhook route, both of which reuse the canonical lib/stripe proxy. HONEST: pricing is ADMINISTERED
// (brokerage_settings.settings.vendor_tier_pricing, set in the admin vendor-approval queue), never a code
// literal. Owner (wave 139 ECONOMICS / wave 140): "nothing may hard-code a tier price; unknown price stays
// explicitly unknown, never fabricated" — so the catalog's monthlyPriceUsd is `null` (not configured) for
// every tier, and a checkout with no administered price is the typed price_not_configured refusal
// (lib/billing/plan-catalog.ts), never a $49/$149/$299/$599 invented at authoring time.
// TOMBSTONE (wave 140J): those four literals lived on VENDOR_TIERS below; survivor = resolveTierPrice over
// the administered override.

import { normalizeStripeStatus } from "@/lib/billing/stripe-status"
import { isConfiguredPriceCents } from "@/lib/billing/plan-catalog"

export type VendorTier = "basic" | "standard" | "premium" | "preferred_network"
export type SubscriptionStatus = "active" | "past_due" | "canceled" | "trialing"

export interface TierCapabilities {
  tier: VendorTier
  /** USD/month. `null` = NOT CONFIGURED — the catalog never carries a price; resolveTierPrice
   *  folds the administered override in, and a null there refuses the checkout. */
  monthlyPriceUsd: number | null
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
  basic:             { tier: "basic",             monthlyPriceUsd: null, surfacingEligible: false, preferredEligible: false, featuredEligible: false, serviceAreaZones: 1,   packageLimit: 3 },
  standard:          { tier: "standard",          monthlyPriceUsd: null, surfacingEligible: true,  preferredEligible: false, featuredEligible: false, serviceAreaZones: 3,   packageLimit: 10 },
  premium:           { tier: "premium",           monthlyPriceUsd: null, surfacingEligible: true,  preferredEligible: true,  featuredEligible: false, serviceAreaZones: 999, packageLimit: 999 },
  preferred_network: { tier: "preferred_network", monthlyPriceUsd: null, surfacingEligible: true,  preferredEligible: true,  featuredEligible: true,  serviceAreaZones: 999, packageLimit: 999 },
}

const TIER_ORDER: VendorTier[] = ["basic", "standard", "premium", "preferred_network"]

/** Per-brokerage price overrides (USD/month) — a brokerage can set its own vendor tier pricing. */
export type TierPriceOverrides = Partial<Record<VendorTier, number>>

/** PURE: the effective monthly price for a tier — the administered override (an explicit $0 is a
 *  decision: free), else the catalog, which carries NO price → `null` = price_not_configured. */
export function resolveTierPrice(tier: string | null | undefined, overrides?: TierPriceOverrides | null): number | null {
  const t = normalizeTier(tier)
  const o = overrides?.[t]
  return isConfiguredPriceCents(o, { allowZero: true }) ? o : VENDOR_TIERS[t].monthlyPriceUsd
}

/** PURE: the tier catalog with prices resolved against a brokerage's overrides (capabilities unchanged). */
export function resolveVendorTiers(overrides?: TierPriceOverrides | null): Record<VendorTier, TierCapabilities> {
  const out = {} as Record<VendorTier, TierCapabilities>
  for (const t of TIER_ORDER) out[t] = { ...VENDOR_TIERS[t], monthlyPriceUsd: resolveTierPrice(t, overrides) }
  return out
}

/** PURE: normalize an arbitrary tier string to a known tier (defaults to basic). */
export function normalizeTier(tier: string | null | undefined): VendorTier {
  const t = (tier ?? "").toLowerCase()
  return (TIER_ORDER as string[]).includes(t) ? (t as VendorTier) : "basic"
}

/** PURE: capabilities for a tier. */
// Module-private since 2026-09-07 — no importer outside this file (lane O / opposite-missing cascade).
function tierCapabilities(tier: string | null | undefined): TierCapabilities {
  return VENDOR_TIERS[normalizeTier(tier)]
}

/**
 * PURE: the EFFECTIVE capabilities given the billing status. A non-current subscription (past_due beyond
 * grace, or canceled) collapses to `basic` capabilities — the vendor keeps a listing but loses surfacing/
 * preferred/featured until they're current again. `active`/`trialing` use the paid tier as-is.
 */
export function effectiveCapabilities(tier: string | null | undefined, status: string | null | undefined): TierCapabilities {
  // ── THROUGH THE SHARED NORMALIZER, NOT A RAW STRING COMPARE (wave 26) ──────
  // This used to lowercase the raw status and test it against the literals
  // "canceled" / "past_due". That misses two live spellings:
  //
  //   · "cancelled" — TWO Ls. lib/billing/stripe-status.ts documents that the
  //     STORED spelling is 'cancelled' (the subscriptions CHECK admits
  //     active|past_due|cancelled|trialing|paused) while Stripe EMITS 'canceled'
  //     with one. A row carrying the stored spelling fell through this test, so
  //     a cancelled vendor kept premium surfacing, preferred-list and featured
  //     eligibility — the paywall simply did not fire.
  //   · "unpaid" / "incomplete" / "incomplete_expired" — Stripe statuses that
  //     mean not-paying and were not named here at all.
  //
  // normalizeStripeStatus is already imported in this file and already used by
  // mapStripeEventToStatus below; the two halves of one file were classifying
  // Stripe status two different ways (§6). `incomplete` is folded in with the
  // other non-paying states: an initial invoice that never succeeded is not a
  // paid tier.
  const c = normalizeStripeStatus(status ?? "active")
  if (c === "canceled" || c === "past_due" || c === "incomplete") return VENDOR_TIERS.basic
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
/**
 * THE SUBSCRIPTION-LANE EVENT VOCABULARY of the vendor marketplace webhook —
 * every Stripe event type mapStripeEventToStatus is written to receive: its
 * five `case` labels plus customer.subscription.updated, which carries no
 * short-circuit and resolves through normalizeStripeStatus on the object's
 * own status (app/api/webhooks/stripe/vendor/route.ts header names all six).
 * Frozen and read by lib/vendors/vendor-webhook-events.ts, which unions it
 * with the payout-completion map so the SDK registration
 * (lib/billing/stripe-webhook-registration.ts) can enable exactly what the
 * endpoint handles — one vocabulary, derived, never re-typed (lane 81E).
 * scripts/stripe-webhook-events-guard.ts holds the switch's labels ⊆ this list.
 */
export const VENDOR_SUBSCRIPTION_WEBHOOK_EVENTS: readonly string[] = Object.freeze([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
])

export function mapStripeEventToStatus(eventType: string, stripeStatus?: string | null): { status: SubscriptionStatus; suspendAccount: boolean } {
  // Event-shaped short-circuits, then the SHARED canonical status normalizer so the
  // vendor path can't drift from the tenant path's Stripe-status vocabulary.
  switch (eventType) {
    case "invoice.payment_failed": return { status: "past_due", suspendAccount: false }
    case "customer.subscription.deleted": return { status: "canceled", suspendAccount: true }
    case "invoice.payment_succeeded":
    case "checkout.session.completed":
    case "customer.subscription.created":
      if (!stripeStatus) return { status: "active", suspendAccount: false }
      break
  }
  const c = normalizeStripeStatus(stripeStatus)
  if (c === "past_due") return { status: "past_due", suspendAccount: false }
  if (c === "canceled" || c === "incomplete") return { status: "canceled", suspendAccount: c === "canceled" }
  if (c === "trialing") return { status: "trialing", suspendAccount: false }
  return { status: "active", suspendAccount: false }
}
