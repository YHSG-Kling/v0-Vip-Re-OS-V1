// lib/intelligence/outcome-autopsy.ts
//
// WIN/LOSS AUTOPSY (pure). The conductors learn from REPLIES — but the real prize is learning from
// OUTCOMES: when a relationship reaches THRIVING (a win) or churns to DORMANT (a loss), what was the
// last thing that actually earned engagement before that fork? Crediting the channel + intent that
// preceded wins (and flagging those that preceded losses) lets the team learn what genuinely moves a
// relationship forward, not just what gets an open. Feeds the channel/copy conductors a richer
// signal than reply rate alone. Pure (no I/O), unit-tested directly.

export type Outcome = "win" | "loss"

export interface AutopsyTouch {
  channel: string | null
  ai_intent?: string | null
  /** ISO timestamp the contact REPLIED to this touch (null = no reply). */
  replied_at?: string | null
  /** ISO timestamp the touch went out. */
  at: string | null
}

export interface AutopsyRecord {
  outcome: Outcome
  /** the channel that earned the LAST engagement before the outcome (the thing that was working / failing). */
  lastReplyChannel: string | null
  lastReplyIntent: string | null
  touchCount: number
}

/** Reconstruct the autopsy for one relationship's outcome. Pure. */
export function outcomeAutopsy(touches: AutopsyTouch[], outcome: Outcome): AutopsyRecord {
  const replied = (touches ?? [])
    .filter((t) => t.replied_at)
    .sort((a, b) => (a.replied_at! || "").localeCompare(b.replied_at! || ""))
  const last = replied[replied.length - 1] ?? null
  return {
    outcome,
    lastReplyChannel: last?.channel ?? null,
    lastReplyIntent: last?.ai_intent ?? null,
    touchCount: (touches ?? []).length,
  }
}

export interface ChannelOutcomeStat {
  channel: string
  wins: number
  losses: number
  /** wins / (wins + losses) — how often this channel's engagement preceded a WIN. */
  winRate: number
}

/** Aggregate autopsies by the last-reply channel → which channels precede wins. Pure. */
export function aggregateAutopsyByChannel(records: AutopsyRecord[]): ChannelOutcomeStat[] {
  const by = new Map<string, { wins: number; losses: number }>()
  for (const r of records ?? []) {
    if (!r.lastReplyChannel) continue
    const e = by.get(r.lastReplyChannel) ?? { wins: 0, losses: 0 }
    if (r.outcome === "win") e.wins++
    else e.losses++
    by.set(r.lastReplyChannel, e)
  }
  return [...by.entries()]
    .map(([channel, e]) => ({ channel, wins: e.wins, losses: e.losses, winRate: (e.wins + e.losses) > 0 ? e.wins / (e.wins + e.losses) : 0 }))
    .sort((a, b) => b.winRate - a.winRate)
}
