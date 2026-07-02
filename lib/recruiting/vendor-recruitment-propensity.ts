// lib/recruiting/vendor-recruitment-propensity.ts
//
// VENDOR RECRUITMENT PROPENSITY — the marketplace-growth mirror of the agent switch-propensity scout.
// The brokerage already relies on a set of vendors (inspectors, stagers, photographers, lenders) through
// bookings and jobs, but most of them are OFF-PLATFORM — every booking, payment, SLA and review happens
// out of band. This scores each off-platform vendor on how worth-recruiting-INTO-the-marketplace they
// are, blending RELIANCE (how much the brokerage already depends on them — the strongest "they'll say
// yes, you already work together" signal), QUALITY (their rating — you only want good vendors on your
// marketplace), and SPEND (dollar reliance — the bigger the flow, the bigger the win from tracking it).
// The Recruiting Manager then points the broker at the vendors most worth inviting FIRST.
// Pure + honest: missing data lowers a factor to neutral, never fabricated into a strong score.

export interface VendorRecruitSignals {
  /** Completed/booked engagements the brokerage has already run with this vendor. */
  totalBookings: number | null
  /** Total dollars the brokerage has paid this vendor across those engagements (USD). */
  totalSpend: number | null
  /** Average rating 0..5 (agent + client), if any reviews exist. */
  avgRating: number | null
  /** Five-star engagements as a fraction 0..1 of rated bookings, if known. */
  fiveStarRatio: number | null
}

export interface VendorRecruitPropensity {
  /** 0..1 — how worth-recruiting-now this vendor is. */
  score: number
  tier: "hot" | "warm" | "cool"
  reasons: string[]
}

/** PURE: the RELIANCE sub-score (0..1) from booking volume. Saturates at ~20 engagements. */
function relianceScore(totalBookings: number | null): { v: number; reason: string | null } {
  if (totalBookings == null || !(totalBookings > 0)) return { v: 0.25, reason: null }
  const v = Math.min(1, totalBookings / 20)
  const reason = totalBookings >= 5 ? `You've already run ${totalBookings} engagements with them — a working relationship.` : null
  return { v, reason }
}

/** PURE: the QUALITY sub-score (0..1) from rating + five-star ratio. */
function qualityScore(avgRating: number | null, fiveStarRatio: number | null): { v: number; reason: string | null } {
  if (avgRating == null || !(avgRating > 0)) return { v: 0.4, reason: null }
  const base = Math.min(1, avgRating / 5)
  // A strong five-star ratio nudges a good vendor up; missing → no nudge (honest).
  const bonus = fiveStarRatio != null && fiveStarRatio > 0 ? Math.min(0.15, fiveStarRatio * 0.15) : 0
  const v = Math.min(1, base + bonus)
  const reason = avgRating >= 4.5 ? `Rated ${avgRating.toFixed(1)}/5 — a marketplace-quality vendor.` : null
  return { v, reason }
}

/** PURE: the SPEND sub-score (0..1) — dollar reliance. Saturates at ~$10k of flow. */
function spendScore(totalSpend: number | null): { v: number; reason: string | null } {
  if (totalSpend == null || !(totalSpend > 0)) return { v: 0.3, reason: null }
  const v = Math.min(1, totalSpend / 10_000)
  const reason = totalSpend >= 3_000 ? `~$${Math.round(totalSpend).toLocaleString()} already flows to them off-platform — capture it.` : null
  return { v, reason }
}

/**
 * PURE: score an off-platform vendor's recruitment-propensity (0..1) + tier + human reasons. Weighted:
 * reliance 45% (the strongest "you already work together" signal), quality 35%, spend 20% — the exact
 * mirror of the agent switch-propensity weights so the two recruiting sides read the same.
 */
export function computeVendorRecruitmentPropensity(sig: VendorRecruitSignals): VendorRecruitPropensity {
  const reliance = relianceScore(sig.totalBookings)
  const quality = qualityScore(sig.avgRating, sig.fiveStarRatio)
  const spend = spendScore(sig.totalSpend)
  const score = Math.round(Math.min(1, Math.max(0, 0.45 * reliance.v + 0.35 * quality.v + 0.20 * spend.v)) * 100) / 100
  const reasons = [reliance.reason, quality.reason, spend.reason].filter((r): r is string => !!r)
  if (reasons.length === 0) reasons.push("A vendor you use occasionally — worth having on the marketplace.")
  const tier: VendorRecruitPropensity["tier"] = score >= 0.7 ? "hot" : score >= 0.5 ? "warm" : "cool"
  return { score, tier, reasons }
}

export interface ScoredVendor extends VendorRecruitPropensity {
  vendorId: string
  name: string
  category: string | null
}

/**
 * PURE: rank off-platform vendors by recruitment-propensity, highest first (deterministic by name on
 * ties). The Recruiting Manager works the top of this list — the vendors most worth inviting first.
 */
export function rankVendorsByRecruitmentPropensity(
  vendors: Array<{ id: string; name: string | null; category: string | null } & VendorRecruitSignals>,
): ScoredVendor[] {
  return vendors
    .map((v) => ({
      vendorId: v.id,
      name: (v.name ?? "").trim() || "A vendor",
      category: v.category ?? null,
      ...computeVendorRecruitmentPropensity(v),
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}
