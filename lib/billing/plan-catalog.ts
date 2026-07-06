// lib/billing/plan-catalog.ts
// ─────────────────────────────────────────────────────────────────────────────
// Pure validation/normalization for a subscription-tier catalog entry. Kept in a
// plain module (no "use server") so it can be unit-tested without a request. The
// superadmin CRUD action + any importer share this ONE validator so a tier can't
// be saved malformed (negative price, empty name, non-canonical tier).

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
