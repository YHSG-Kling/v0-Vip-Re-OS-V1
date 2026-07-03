// lib/recruiting/challenges.ts
//
// GAMIFICATION CHALLENGES (recruiting_manager) — broker/team-run, time-boxed competitions that drive the
// exact production behaviors (contacts touched, showings, deals, points). Live standings are computed from
// the consolidated data (agent_points_log / transactions / contacts), ranked, and on end the winners get
// prize points into the SAME ledger + a gated announcement. NOTE (business process): a "contacts" challenge
// counts CONTACTS the agent manages — never the unqualified ISA lead queue.
//
// Pure ranking + status + metric mapping (testable); the runner + actions do the DB work.

export type ChallengeType = "most_points" | "most_transactions" | "most_contacts" | "most_referrals" | "custom"
export type ChallengeStatus = "draft" | "active" | "ended" | "cancelled"

/** What each challenge type measures (for display + the scorer's source selection). */
export const CHALLENGE_METRIC: Record<ChallengeType, string> = {
  most_points: "gamification points",
  most_transactions: "closed transactions",
  most_contacts: "contacts added",
  most_referrals: "referrals",
  custom: "custom metric",
}

/** PURE: the computed status of a challenge from its window (a stored 'cancelled' always wins). */
export function challengeStatus(stored: string | null | undefined, startsAt: string, endsAt: string, now: Date): ChallengeStatus {
  if (stored === "cancelled") return "cancelled"
  const start = Date.parse(startsAt), end = Date.parse(endsAt)
  if (!Number.isNaN(end) && now.getTime() >= end) return "ended"
  if (!Number.isNaN(start) && now.getTime() < start) return "draft"
  return "active"
}

export interface Participant { agentId: string; value: number }
export interface RankedParticipant { agentId: string; value: number; rank: number; isWinner: boolean }

/**
 * PURE: rank participants by value (desc), assign 1-indexed ranks, and mark the top `winnerCount` as
 * winners (only those with value > 0). Deterministic tie-break by agentId. Standard competition ranking
 * (ties share a rank; the next rank skips).
 */
export function rankParticipants(participants: Participant[], winnerCount = 1): RankedParticipant[] {
  const sorted = [...participants].sort((a, b) => b.value - a.value || a.agentId.localeCompare(b.agentId))
  const out: RankedParticipant[] = []
  let lastValue: number | null = null
  let lastRank = 0
  sorted.forEach((p, i) => {
    const rank = lastValue !== null && p.value === lastValue ? lastRank : i + 1
    lastValue = p.value; lastRank = rank
    out.push({ agentId: p.agentId, value: p.value, rank, isWinner: rank <= winnerCount && p.value > 0 })
  })
  return out
}
