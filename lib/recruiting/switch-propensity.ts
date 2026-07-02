// lib/recruiting/switch-propensity.ts
//
// RECRUIT SWITCH-PROPENSITY — the marquee recruiting differentiator. Every recruiting tool (and every
// competitor) treats the pipeline as a flat list the broker works top-to-bottom. This scores each
// prospect on how worth-approaching-NOW they are — blending the SWITCH INTENT signal (where the lead
// came from: a public "thinking of leaving my brokerage" post, an inbound landing, a warm referral, or
// a cold scrape), their PRODUCTION value (annual volume — a $10M producer is a different prize than a
// rookie), and career MOBILITY (mid-career agents switch; brand-new and 20-year veterans rarely do). The
// Recruiting Manager then points the broker's finite attention at the highest-propensity talent first.
// Pure + honest: missing data lowers a factor to neutral, never fabricated into a strong score.

export interface RecruitSignals {
  /** recruits.referral_source — encodes where/how the prospect surfaced. */
  referralSource: string | null
  /** recruits.annual_volume — their production (USD). */
  annualVolume: number | null
  /** recruits.years_experience. */
  yearsExperience: number | null
}

export interface SwitchPropensity {
  /** 0..1 — how worth-approaching-now this prospect is. */
  score: number
  tier: "hot" | "warm" | "cool"
  reasons: string[]
}

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase()

/** PURE: the switch-INTENT sub-score (0..1) from where the prospect came. */
function intentScore(referralSource: string | null): { v: number; reason: string | null } {
  const s = norm(referralSource)
  if (!s) return { v: 0.4, reason: null }
  if (/switch|leaving|thinking.?of|dissatisf|unhappy|reddit|review|glassdoor|indeed|forum|complain/.test(s))
    return { v: 1.0, reason: "Surfaced from a public 'thinking of switching' signal." }
  if (/public|landing|inbound|website|form|self/.test(s))
    return { v: 0.9, reason: "Inbound — they reached out to us first." }
  if (/referral|agent_referral|intro/.test(s))
    return { v: 0.8, reason: "Warm referral from someone in the network." }
  return { v: 0.45, reason: null }  // cold sourced
}

/** PURE: the PRODUCTION-value sub-score (0..1). $10M+ annual volume tops out. */
function valueScore(annualVolume: number | null): { v: number; reason: string | null } {
  if (annualVolume == null || !(annualVolume > 0)) return { v: 0.3, reason: null }
  const v = Math.min(1, annualVolume / 10_000_000)
  const reason = annualVolume >= 3_000_000 ? `Produces ~$${Math.round(annualVolume / 1_000_000)}M/yr — a high-value target.` : null
  return { v, reason }
}

/** PURE: the career-MOBILITY sub-score (0..1). Mid-career agents are the most switchable. */
function mobilityScore(yearsExperience: number | null): { v: number; reason: string | null } {
  if (yearsExperience == null || yearsExperience < 0) return { v: 0.5, reason: null }
  if (yearsExperience >= 3 && yearsExperience <= 12) return { v: 1.0, reason: `${yearsExperience} yrs in — the mobile, established sweet spot.` }
  if ((yearsExperience >= 2 && yearsExperience < 3) || (yearsExperience > 12 && yearsExperience <= 18)) return { v: 0.6, reason: null }
  return { v: 0.3, reason: null }  // brand-new (<2) or long-tenured (>18) rarely move
}

/**
 * PURE: score a recruit's switch-propensity (0..1) + tier + human reasons. Weighted: intent 45% (the
 * strongest signal that they'll actually move), production value 35%, mobility 20%.
 */
export function computeSwitchPropensity(sig: RecruitSignals): SwitchPropensity {
  const intent = intentScore(sig.referralSource)
  const value = valueScore(sig.annualVolume)
  const mobility = mobilityScore(sig.yearsExperience)
  const score = Math.round(Math.min(1, Math.max(0, 0.45 * intent.v + 0.35 * value.v + 0.20 * mobility.v)) * 100) / 100
  const reasons = [intent.reason, value.reason, mobility.reason].filter((r): r is string => !!r)
  if (reasons.length === 0) reasons.push("Standard prospect — no standout switch signal yet.")
  const tier: SwitchPropensity["tier"] = score >= 0.7 ? "hot" : score >= 0.5 ? "warm" : "cool"
  return { score, tier, reasons }
}

export interface ScoredRecruit extends SwitchPropensity {
  recruitId: string
  name: string
}

/**
 * PURE: rank recruits by switch-propensity, highest first (deterministic by name on ties). The Recruiting
 * Manager works the top of this list, not an arbitrary order.
 */
export function rankRecruitsByPropensity(
  recruits: Array<{ id: string; first_name: string | null; last_name: string | null } & RecruitSignals>,
): ScoredRecruit[] {
  return recruits
    .map((r) => ({
      recruitId: r.id,
      name: [r.first_name, r.last_name].filter(Boolean).join(" ").trim() || "A prospect",
      ...computeSwitchPropensity(r),
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}
