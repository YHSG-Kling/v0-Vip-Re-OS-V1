// lib/gamification/tiers.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE POINTS-TIER LADDER.
//
// There were four copies of it and they did not agree. Three sites carried
// 500 / 2500 / 10000 / 25000 — app/actions/gamification.getAgentPointsAndTier,
// app/actions/admin/agent-360.tierFor and /dashboard/intelligence's own
// getTierFromPoints — and app/dashboard/motivation/motivation-client.tsx carried
// 0 / 1000 / 5000 / 15000. The Motivation page therefore printed a DIFFERENT tier
// in its header than the server had just computed for the same agent: at 3,000
// points the server said Silver and the page said Silver-going-on-Gold at 5,000,
// while at 1,200 the server said Bronze and the page said Silver.
//
// The server-authored ladder wins (3 sites of 4, and it is the one the badge
// catalog is seeded against).
//
// CASING IS SETTLED TOO, and not by taste: `gamification_badges.badge_tier` carries
// a live CHECK constraint admitting exactly bronze | silver | gold | platinum |
// diamond. The database already had a casing, so the canonical id is LOWERCASE and
// display capitalisation is a rendering concern (TIER_LABEL). The three sites that
// returned "Platinum" / "none" / "Rookie" were each inventing a fifth spelling.
//
// NOT THE CAREER LADDER. lib/recruiting/career-tier.ts is a separate, production-
// driven ladder over agents.career_tier (rookie/…); it measures deals closed, not
// engagement points. The two are different facts and neither is a copy of the other.

export const POINTS_TIERS = ["unranked", "bronze", "silver", "gold", "platinum", "diamond"] as const
export type PointsTier = (typeof POINTS_TIERS)[number]

/** Descending, so the first match wins. `diamond` is broker-conferred — no threshold. */
export const TIER_LADDER: ReadonlyArray<{ tier: PointsTier; minPoints: number }> = [
  { tier: "platinum", minPoints: 25000 },
  { tier: "gold", minPoints: 10000 },
  { tier: "silver", minPoints: 2500 },
  { tier: "bronze", minPoints: 500 },
  { tier: "unranked", minPoints: 0 },
]

export const TIER_LABEL: Record<PointsTier, string> = {
  unranked: "Unranked",
  bronze: "Bronze",
  silver: "Silver",
  gold: "Gold",
  platinum: "Platinum",
  diamond: "Diamond",
}

export function tierForPoints(points: number): PointsTier {
  const p = Number.isFinite(points) ? points : 0
  return (TIER_LADDER.find((t) => p >= t.minPoints) ?? TIER_LADDER[TIER_LADDER.length - 1]).tier
}

export function tierLabelForPoints(points: number): string {
  return TIER_LABEL[tierForPoints(points)]
}

/**
 * The next rung and the distance to it. Null at the top of the THRESHOLD ladder —
 * diamond is conferred by a broker, not earned by a count, so there is no honest
 * "points to Diamond" number to print.
 */
export function nextTierForPoints(
  points: number,
): { tier: PointsTier; label: string; threshold: number; pointsToGo: number } | null {
  const p = Number.isFinite(points) ? points : 0
  const ascending = [...TIER_LADDER].reverse()
  const next = ascending.find((t) => t.minPoints > p)
  if (!next) return null
  return { tier: next.tier, label: TIER_LABEL[next.tier], threshold: next.minPoints, pointsToGo: next.minPoints - p }
}

/** 0-100 progress from the tier the agent is on to the next rung; 100 at the top. */
export function tierProgressPercent(points: number): number {
  const p = Number.isFinite(points) ? points : 0
  const next = nextTierForPoints(p)
  if (!next) return 100
  const current = TIER_LADDER.find((t) => p >= t.minPoints)?.minPoints ?? 0
  const span = next.threshold - current
  if (span <= 0) return 100
  return Math.max(0, Math.min(100, Math.round(((p - current) / span) * 100)))
}
