// lib/platform/engagement-risk.ts
// ─────────────────────────────────────────────────────────────────────────────
// TENANT ENGAGEMENT RISK TIER — the PURE classifier behind the superadmin
// churn-risk radar (app/dashboard/superadmin/engagement). Kept side-effect-free
// and exported on its own so a simulator can exercise every boundary without a
// database. The inputs are the two behavioral signals the radar computes from
// real rows:
//   • lastActivityAt      — the tenant's newest sign-in evidence
//                           (auth.users.last_sign_in_at via the admin API; see
//                           the page header for why that source was chosen)
//   • creates last-30d vs prior-30d — core-object creation velocity
//                           (contacts + listings + transactions head-counts)
//
// Tier rules (documented order — recency outranks velocity):
//   at_risk : no sign-in ever, or none in the last 14 days
//   cooling : last sign-in 7–14 days ago, OR output halved (prior window had
//             real creation volume and the current window is ≤ half of it)
//   engaged : signed in within 7 days and velocity not halved

export type EngagementTier = "engaged" | "cooling" | "at_risk"

export interface EngagementSignals {
  /** ISO timestamp of the tenant's newest user sign-in; null = no sign-in evidence at all. */
  lastActivityAt: string | null
  /** Core objects (contacts + listings + transactions) created in the last 30 days. */
  createsLast30d: number
  /** Same count for the prior window (31–60 days ago). */
  createsPrior30d: number
}

export const DAY_MS = 86_400_000

/** Riskiest-first sort order for the radar table and tiles. */
export const TIER_ORDER: Record<EngagementTier, number> = { at_risk: 0, cooling: 1, engaged: 2 }

/** Days since the last sign-in; Infinity when there is none (or it is unparseable). */
export function daysSinceActivity(lastActivityAt: string | null, now: Date = new Date()): number {
  if (!lastActivityAt) return Number.POSITIVE_INFINITY
  const t = new Date(lastActivityAt).getTime()
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY
  return (now.getTime() - t) / DAY_MS
}

/** PURE: classify a tenant's engagement tier from its real activity signals. */
export function classifyEngagement(s: EngagementSignals, now: Date = new Date()): EngagementTier {
  const days = daysSinceActivity(s.lastActivityAt, now)
  if (days > 14) return "at_risk"
  if (days >= 7) return "cooling"
  // Velocity halved: only meaningful when the prior window had real output —
  // a tenant going 0 → 0 is judged on sign-in recency alone.
  if (s.createsPrior30d > 0 && s.createsLast30d * 2 <= s.createsPrior30d) return "cooling"
  return "engaged"
}
