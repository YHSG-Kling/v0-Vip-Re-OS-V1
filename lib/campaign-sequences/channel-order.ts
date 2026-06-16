// lib/campaign-sequences/channel-order.ts
//
// CHANNEL-ORDER learning (pure) — the same "reply-rate picks the winner" idea the copy conductor
// uses, applied to which CHANNEL a cadence should LEAD with. Some segments reply fastest to SMS,
// some to a video email, some only ever open a portal card. By ranking channels by their real reply
// rate (sample-gated so it never reorders on noise), the team learns to open on the channel that
// actually earns a response per brokerage/segment — not a fixed email-first default. Advisory:
// recommends an order; humans/sequences adopt it. Pure (no I/O), unit-tested directly.

export interface ChannelStat {
  channel: string
  sent: number
  replies: number
}

export interface RankedChannel {
  channel: string
  rate: number
  sent: number
}

export interface ChannelRanking {
  /** channels with enough volume, best reply rate first. */
  ranked: RankedChannel[]
  /** the channel to LEAD with, or null when there isn't enough signal yet. */
  recommended: string | null
  reason: string
}

export const DEFAULT_MIN_SAMPLE = 30

/** Rank channels by reply rate and recommend the lead channel. Sample-gated. Pure. */
export function rankChannelsByReplyRate(stats: ChannelStat[], opts?: { minSample?: number }): ChannelRanking {
  const minSample = opts?.minSample ?? DEFAULT_MIN_SAMPLE
  const ranked = (stats ?? [])
    .filter((s) => s.sent >= minSample)
    .map((s) => ({ channel: s.channel, rate: s.sent > 0 ? s.replies / s.sent : 0, sent: s.sent }))
    .sort((a, b) => b.rate - a.rate)

  if (ranked.length === 0) {
    return { ranked, recommended: null, reason: `no channel has ≥${minSample} sends yet — keep the default order` }
  }
  const top = ranked[0]
  if (top.rate <= 0) {
    return { ranked, recommended: null, reason: "no channel has earned a reply yet — keep the default order" }
  }
  return {
    ranked,
    recommended: top.channel,
    reason: `lead with ${top.channel} — ${(top.rate * 100).toFixed(1)}% reply rate${ranked[1] ? ` vs ${ranked[1].channel} ${(ranked[1].rate * 100).toFixed(1)}%` : ""}`,
  }
}
