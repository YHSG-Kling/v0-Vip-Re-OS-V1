/**
 * lib/intelligence/adoption-pulse.ts
 *
 * LEADER ADOPTION PULSE (tenant concierge list #23/#31) — "show which
 * people need help, not just who logged in." The signals already exist
 * scattered (overdue tasks, stale contacts, silence, unread briefings);
 * this ranks them into ONE leader-facing read: who needs a hand this
 * week, and WHY (reasons, not a bare score — a leader coaches a reason).
 * PURE; the loader lives in app/actions/quarterly-review.ts and the card
 * renders beside the QBR. Thresholded so a healthy agent NEVER appears —
 * this is care, not surveillance. recruiting_manager owns agent
 * development. NOT server-only (simulator-driven).
 */

export interface AgentPulseStats {
  agentId: string
  name: string
  overdueTasks: number
  /** contacts assigned to them untouched for 30+ days. */
  staleContacts: number
  /** logged activities in the last 14 days. */
  activities14d: number
  /** opened at least one daily briefing in the last 14 days. */
  briefingOpened14d: boolean
}

export interface PulseEntry {
  agentId: string
  name: string
  score: number
  reasons: string[]
}

/** Below this, an agent is doing fine and stays OFF the list. */
export const PULSE_MIN_SCORE = 4

/** PURE: rank who needs help, worst first, with the coachable reasons. */
export function rankNeedsHelp(stats: AgentPulseStats[], limit = 5): PulseEntry[] {
  return stats
    .map((s) => {
      const reasons: string[] = []
      let score = 0
      if (s.overdueTasks > 0) { score += Math.min(6, s.overdueTasks * 2); reasons.push(`${s.overdueTasks} overdue task${s.overdueTasks === 1 ? "" : "s"}`) }
      if (s.staleContacts > 0) { score += Math.min(5, s.staleContacts); reasons.push(`${s.staleContacts} contact${s.staleContacts === 1 ? "" : "s"} untouched 30+ days`) }
      if (s.activities14d === 0) { score += 5; reasons.push(`no logged activity in 14 days`) }
      if (!s.briefingOpened14d) { score += 2; reasons.push(`morning briefing unread for 2 weeks`) }
      return { agentId: s.agentId, name: s.name, score, reasons }
    })
    .filter((e) => e.score >= PULSE_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}
