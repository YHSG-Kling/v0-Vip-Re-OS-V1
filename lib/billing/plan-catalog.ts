// lib/billing/plan-catalog.ts
// ─────────────────────────────────────────────────────────────────────────────
// Pure validation/normalization for a subscription-tier catalog entry. Kept in a
// plain module (no "use server") so it can be unit-tested without a request. The
// superadmin CRUD action + any importer share this ONE validator so a tier can't
// be saved malformed (negative price, empty name, non-canonical tier).
//
// ─── REMOVED in the orphan burn-down (lane O) ────────────────────────────────
//
// `lib/vendors/billing-calculator.ts` — the whole file — DELETED
// (calculateMonthlyBilling, calculateVendorRevenue, calculateAnnualDiscount).
// `lib/vendors/credit-calculator.ts` — the whole file — DELETED
// (CREDIT_COSTS, calculateCreditsForOperation, calculateMonthlyUsageEstimate,
// recommendPlanByUsage). Neither file was imported by anything, anywhere.
//
// The tombstone is HERE, on the survivor, because this is where someone
// tempted to re-add a hardcoded price table will be standing. SURVIVORS:
//   · plan price → `subscription_tiers.monthly_price_cents` /
//     `annual_price_cents`, administered through this module and read at
//     lib/kernel/billing.ts:318. The deleted `recommendPlanByUsage` returned
//     literal 29 and 99 — the exact numbers this catalog exists so that nobody
//     hardcodes — and `calculateAnnualDiscount` DERIVED the annual price as
//     "monthly × 12 less 10%", when annual_price_cents is an administered field
//     that a tier may set to anything.
//   · overage → `plan_limits.overage_allowed` + `overage_rate_cents_per_1k`,
//     computed by lib/billing/ai-overage.ts. The deleted `calculateMonthlyBilling`
//     re-derived overage against a caller-passed per-credit price and added a
//     flat 8% "tax" that no invoice in this system charges.
//   · usage → `vendor_usage_tracking` (lib/vendor-tracking.ts) and
//     `usage_events` (lib/finance/usage-metering.ts), which record what was
//     ACTUALLY spent. The deleted CREDIT_COSTS table asserted invented per-
//     operation credit prices for operations that meter their real vendor cost.
//   · vendor revenue share → `vendors.default_revenue_share_percent` through
//     lib/commission/waterfall/09-revenue-share.ts, gated on
//     `brokerages.revenue_share_enabled` (see lib/vendors/vendor-validators.ts:16).
//
// Nothing needed merging: every number in both files was a literal invented at
// authoring time, and all of them are administered rows here. MONEY IN THIS
// SYSTEM IS INTEGER CENTS; both deleted files did float dollar arithmetic with
// `Math.round(x * 100) / 100`, which is the other reason neither could be
// adopted as-is.

// THE one metric vocabulary for AI overage. Declared HERE (the pure module) and
// imported by the server-side ai-overage reader — not the other way around:
// this module is reachable from CLIENT chains (coupons manager -> platform
// coupons -> here), and importing the reader would drag the service client
// into a client bundle (caught by the client-server-only guard).
export const AI_OVERAGE_METRIC = "ai_tokens_monthly" as const

export const CANONICAL_TIERS = ["solo_agent", "team", "brokerage", "multi_location"] as const
export type CanonicalTierName = (typeof CANONICAL_TIERS)[number]

// ── THE SEAT BANDS — ONE DERIVATION (wave 79A, owner verbatim 2026-09-23) ─────
//
//   "not charging for staff/admin (non producing) and charging producing
//    seats. solo tier is 2 seats; team tier is 10 seats; brokerage tier is 30
//    seats; multi location tier is custom pricing for seats. the fee is setup
//    fee. there will be an opportunity for buying more seat packages and if
//    the tenant hits a limit they will be able to either upgrade to a higher
//    tier (or lower tier if their business changes) or buy more seats.
//    subscriptions will be setup in stripe so they sync."
//
// SUPERSEDES wave 78A's 2 / 5 / ∞ / ∞ (m655). Wave 78A had already collapsed
// three disagreeing tables (tier-role-matrix 2/5/50, prospect-conversion
// 1/15/75, the live catalogue 2/5/50) onto THIS object; the number moves here
// and nowhere else. Every other seat surface DERIVES from it:
//
//   · lib/kernel/tier-role-matrix.ts  TIER_SEAT_LIMITS  ≡ this object (the
//     gate's fallback when the catalogue cannot be read)
//   · lib/platform/prospect-conversion.ts tierForProspect → tierForSeatCount
//   · supabase/migrations/m660-…sql moves the live catalogue onto it; the
//     seat gate reads the catalogue FIRST (resolveCatalogSeatLimits) and
//     scripts/seat-bands-guard.ts + scripts/seat-packages-guard.ts pin the
//     migration's numbers to this table.
//
// `null` = CUSTOM. multi_location has no band: its seats are negotiated per
// tenant (subscriptions.custom_seat_limit, priced by a tenant-specific Stripe
// price — subscriptions.custom_stripe_price_id) and a multi_location tenant
// with no negotiated count is UNLIMITED for the gate (nobody is refused for
// a number nobody set). The band is a floor, not a ceiling: a tenant's
// EFFECTIVE cap is band + purchased extra seats (seat packages, below), so
// hitting the band is a DOOR — upgrade, downgrade, or buy seats — never a wall.
//
// WHAT A SEAT IS (the second half of the ruling) lives beside the count that
// enforces it: lib/kernel/tier-role-matrix.ts PRODUCER_SEAT_ROLES /
// SEAT_BY_PRODUCTION_ROLES / FREE_STAFF_ROLES and roleConsumesSeat. Short
// form: a seat is a LICENSED PRODUCER; staff never consume one.
export const TIER_SEAT_BANDS: Readonly<Record<CanonicalTierName, number | null>> = Object.freeze({
  solo_agent:     2,
  team:           10,
  brokerage:      30,
  multi_location: null,
})

/** PURE: the cheapest tier whose band fits this many producer seats, walking
 *  CANONICAL_TIERS in order. 0/NaN/negative reads as one seat (the person
 *  asking). A count above every capped band lands on the custom tier
 *  (multi_location) — the only plan that seats it — which the conversion
 *  path already hands to a person (conversionHumanReasons: enterprise_size). */
export function tierForSeatCount(seats: number | null | undefined): CanonicalTierName {
  const n = typeof seats === "number" && Number.isFinite(seats) && seats > 0 ? Math.round(seats) : 1
  for (const tier of CANONICAL_TIERS) {
    const band = TIER_SEAT_BANDS[tier]
    if (band === null || n <= band) return tier
  }
  // Reached only if every band is capped: the largest tier still answers.
  return CANONICAL_TIERS[CANONICAL_TIERS.length - 1]
}

/** PURE: the first seat count that NO capped band fits — the seat at which a
 *  prospect is an enterprise conversation (custom pricing, a person). Derived
 *  so it moves with the bands instead of drifting from them. */
export function seatCountAboveEveryBand(): number {
  let top = 0
  for (const tier of CANONICAL_TIERS) {
    const band = TIER_SEAT_BANDS[tier]
    if (band !== null && band > top) top = band
  }
  return top + 1
}

// ── SEAT PACKAGES (wave 79A) ─────────────────────────────────────────────────
//
// A seat package is a Stripe add-on: ONE licensed price per tier
// (subscription_tiers.stripe_seat_price_id) sold by QUANTITY on a second
// subscription item, `seat_package_size` seats per unit at
// `seat_package_price_cents` per unit per month. Stripe is the catalogue
// source — the superadmin "sync from Stripe" action writes these columns from
// the live prices, and the webhook / reconcile write the tenant's purchased
// quantity onto subscriptions.seat_packages / extra_seats. A tier whose seat
// price is NOT linked cannot sell packages: the door then offers the tier
// change only and says why (fail closed — never a "buy" button that charges
// nothing, CLAUDE.md §4).
export interface SeatPackageFacts {
  /** Seats per package unit (≥ 1). */
  size: number
  /** Monthly price per package unit, integer cents; null = not priced yet. */
  priceCents: number | null
  /** The Stripe licensed price the package is sold on; null = not linked. */
  stripePriceId: string | null
}

/** Tier → seat-package facts read from the catalogue. Absent / null = the
 *  tier sells no packages (multi_location: custom pricing, a person). */
export type SeatPackageCatalog = Partial<Record<CanonicalTierName, SeatPackageFacts | null>>

/** PURE: may this tier sell seat packages right now? Requires a size, a
 *  price and a Stripe price — a package with any of the three missing is not
 *  sellable, and the door must not offer it. */
export function seatPackageSellable(facts: SeatPackageFacts | null | undefined): facts is SeatPackageFacts & { priceCents: number; stripePriceId: string } {
  return !!facts && Number.isInteger(facts.size) && facts.size >= 1
    && typeof facts.priceCents === "number" && Number.isInteger(facts.priceCents) && facts.priceCents > 0
    && typeof facts.stripePriceId === "string" && facts.stripePriceId.trim().length > 0
}

/** PURE: how many package units cover `seatsOver` more seats. */
export function seatPackagesNeeded(seatsOver: number, packageSize: number): number {
  if (!(seatsOver > 0) || !(packageSize >= 1)) return 0
  return Math.ceil(seatsOver / packageSize)
}

export interface PlanTierInput {
  tierName: string
  displayName: string
  description?: string | null
  monthlyPriceCents: number
  annualPriceCents?: number | null
  setupFeeCents?: number | null
  marketingBullets?: string[] | null
  isFeatured?: boolean
  isActive?: boolean
  maxAgents?: number | null
  stripePriceId?: string | null
  /** Seat package (wave 79A): seats per unit, cents per unit, the Stripe licensed price. */
  seatPackageSize?: number | null
  seatPackagePriceCents?: number | null
  stripeSeatPriceId?: string | null
}

export interface NormalizedPlanTier {
  tierName: string
  displayName: string
  description: string | null
  monthlyPriceCents: number
  annualPriceCents: number
  setupFeeCents: number
  marketingBullets: string[]
  isFeatured: boolean
  isActive: boolean
  maxAgents: number | null
  stripePriceId: string | null
  seatPackageSize: number | null
  seatPackagePriceCents: number | null
  stripeSeatPriceId: string | null
}

export type ValidationResult =
  | { ok: true; value: NormalizedPlanTier }
  | { ok: false; error: string }

// ── STRIPE DRIFT COMPARE (pure) ──────────────────────────────────────────────
// ONE comparison for "does this catalog tier still match its live Stripe
// price?" — used by the weekly stripe-drift cron. Mirrors the interval logic
// syncPlanTierFromStripeAction uses when it PULLS a price (interval 'year' →
// annual_price_cents, else monthly_price_cents), so cron and manual sync can
// never disagree about what "matches" means.

export interface StripePriceFacts {
  unitAmount: number | null
  interval: "month" | "year" | string | null
  active: boolean
}

export interface PlanDriftFinding {
  drifted: boolean
  reason: "price_inactive" | "amount_mismatch" | null
  /** Which DB column the Stripe price maps onto (by its interval). */
  field: "monthly_price_cents" | "annual_price_cents"
  dbCents: number
  stripeCents: number | null
}

export function comparePlanPriceToStripe(
  tier: { monthly_price_cents: number | null; annual_price_cents: number | null },
  price: StripePriceFacts,
): PlanDriftFinding {
  const field = price.interval === "year" ? "annual_price_cents" : "monthly_price_cents"
  const dbCents = Number(tier[field] ?? 0)
  const stripeCents = price.unitAmount == null ? null : Number(price.unitAmount)
  if (!price.active) return { drifted: true, reason: "price_inactive", field, dbCents, stripeCents }
  if (stripeCents !== dbCents) return { drifted: true, reason: "amount_mismatch", field, dbCents, stripeCents }
  return { drifted: false, reason: null, field, dbCents, stripeCents }
}

// ── AI OVERAGE TERMS (pure) ──────────────────────────────────────────────────
// The m479 overage terms (plan_limits.overage_allowed + overage_rate_cents_per_1k)
// are PLATFORM-CONFIGURABLE the same way tier pricing is — this is the ONE
// validator the superadmin upsert action goes through, so malformed terms can
// never be saved: non-canonical tier, negative / non-integer rate, and — the
// m479 postcondition doctrine, kept true BY CONSTRUCTION — any metric other
// than ai_tokens_monthly is REFUSED outright. Rate is integer CENTS per 1K
// tokens (the same integer-cents discipline as monthly_price_cents).

export interface AIOverageTermsInput {
  planTier: string
  overageAllowed: boolean
  /** Integer CENTS per 1,000 tokens (m479 column contract). */
  overageRateCentsPer1k: number
  /** Optional; anything other than ai_tokens_monthly is refused. */
  metric?: string
}

export interface NormalizedAIOverageTerms {
  planTier: (typeof CANONICAL_TIERS)[number]
  metric: typeof AI_OVERAGE_METRIC
  overageAllowed: boolean
  overageRateCentsPer1k: number
}

export type AIOverageTermsValidation =
  | { ok: true; value: NormalizedAIOverageTerms }
  | { ok: false; error: string }

/** PURE: validate + normalize per-tier AI overage terms. */
export function validateAIOverageTermsInput(input: AIOverageTermsInput): AIOverageTermsValidation {
  // Metric: overage exists ONLY for ai_tokens_monthly. No other metric may be
  // overage-enabled (m479 postcondition), so any other spelling is a refusal —
  // not a normalization.
  const metric = (input.metric ?? AI_OVERAGE_METRIC).trim()
  if (metric !== AI_OVERAGE_METRIC) {
    return { ok: false, error: `overage terms exist only for the '${AI_OVERAGE_METRIC}' metric — no other metric may be overage-enabled (m479)` }
  }

  const planTier = (input.planTier ?? "").trim()
  if (!(CANONICAL_TIERS as readonly string[]).includes(planTier)) {
    return { ok: false, error: `plan_tier must be one of: ${CANONICAL_TIERS.join(", ")}` }
  }

  if (typeof input.overageAllowed !== "boolean") {
    return { ok: false, error: "overage_allowed must be a boolean" }
  }

  // Rate: integer cents, never negative, never silently rounded — money terms
  // are refused when malformed, not repaired.
  const rate = input.overageRateCentsPer1k
  if (typeof rate !== "number" || !Number.isFinite(rate) || !Number.isInteger(rate)) {
    return { ok: false, error: "overage_rate_cents_per_1k must be an integer (cents per 1K tokens)" }
  }
  if (rate < 0) {
    return { ok: false, error: "overage_rate_cents_per_1k must be >= 0" }
  }
  // Enabled terms need a real rate: allowed with a 0 rate would SERVE overage
  // that bills nothing (the writethrough skips zero_amount) — free unlimited
  // AI by accident. Turning overage on is agreeing to a price.
  if (input.overageAllowed && rate === 0) {
    return { ok: false, error: "overage_allowed requires a rate > 0 — enabling overage with a 0 rate would serve unlimited AI unbilled" }
  }

  return {
    ok: true,
    value: {
      planTier: planTier as (typeof CANONICAL_TIERS)[number],
      metric: AI_OVERAGE_METRIC,
      overageAllowed: input.overageAllowed,
      overageRateCentsPer1k: rate,
    },
  }
}

const nonNeg = (n: unknown): number => {
  const v = typeof n === "number" ? n : Number(n ?? 0)
  return Number.isFinite(v) && v >= 0 ? Math.round(v) : NaN
}

/** PURE: validate + normalize a tier catalog entry. */
export function validatePlanTierInput(input: PlanTierInput): ValidationResult {
  const tierName = (input.tierName ?? "").trim()
  if (!tierName) return { ok: false, error: "tier_name is required" }
  // tier_name is the canonical plan key — keep it to the 4 tiers so plan_tier /
  // cap-enforcement / routing stay coherent.
  if (!(CANONICAL_TIERS as readonly string[]).includes(tierName)) {
    return { ok: false, error: `tier_name must be one of: ${CANONICAL_TIERS.join(", ")}` }
  }
  const displayName = (input.displayName ?? "").trim()
  if (!displayName) return { ok: false, error: "display_name is required" }

  const monthly = nonNeg(input.monthlyPriceCents)
  if (Number.isNaN(monthly)) return { ok: false, error: "monthly_price_cents must be a non-negative integer" }
  const annual = input.annualPriceCents == null ? monthly * 12 : nonNeg(input.annualPriceCents)
  if (Number.isNaN(annual)) return { ok: false, error: "annual_price_cents must be a non-negative integer" }
  const setup = input.setupFeeCents == null ? 0 : nonNeg(input.setupFeeCents)
  if (Number.isNaN(setup)) return { ok: false, error: "setup_fee_cents must be a non-negative integer" }

  const bullets = Array.isArray(input.marketingBullets)
    ? input.marketingBullets.map((b) => String(b).trim()).filter(Boolean).slice(0, 12)
    : []

  const maxAgents = input.maxAgents == null ? null : (Number.isFinite(Number(input.maxAgents)) && Number(input.maxAgents) >= 0 ? Math.round(Number(input.maxAgents)) : null)

  // Seat package: size ≥ 1 when given; price non-negative integer cents when
  // given. Malformed money is REFUSED, not repaired (same discipline as the
  // overage rate). A 0-cent price is stored as null — "not priced", never
  // "free seats" (a free package would sell producers unbilled).
  const seatPackageSize = input.seatPackageSize == null ? null : Number(input.seatPackageSize)
  if (seatPackageSize !== null && (!Number.isInteger(seatPackageSize) || seatPackageSize < 1)) {
    return { ok: false, error: "seat_package_size must be an integer >= 1 (seats per package)" }
  }
  const seatPrice = input.seatPackagePriceCents == null ? null : nonNeg(input.seatPackagePriceCents)
  if (seatPrice !== null && Number.isNaN(seatPrice)) return { ok: false, error: "seat_package_price_cents must be a non-negative integer" }

  return {
    ok: true,
    value: {
      tierName,
      displayName,
      description: (input.description ?? "").trim() || null,
      monthlyPriceCents: monthly,
      annualPriceCents: annual,
      setupFeeCents: setup,
      marketingBullets: bullets,
      isFeatured: !!input.isFeatured,
      isActive: input.isActive !== false,
      maxAgents,
      stripePriceId: (input.stripePriceId ?? "").trim() || null,
      seatPackageSize,
      seatPackagePriceCents: seatPrice === null || seatPrice === 0 ? null : seatPrice,
      stripeSeatPriceId: (input.stripeSeatPriceId ?? "").trim() || null,
    },
  }
}
