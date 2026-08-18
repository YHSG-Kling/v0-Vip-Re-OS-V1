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
    },
  }
}
