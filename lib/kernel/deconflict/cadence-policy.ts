// lib/kernel/deconflict/cadence-policy.ts
//
// SELF-TUNING CADENCE — the over-touch frequency cap LEARNS each brokerage's rhythm from real
// engagement instead of staying a static config. An audience that opens and replies can hear from
// us a little more often; an audience that's going quiet hears from us LESS (protect the
// relationship). This is the "agentic, it learns" differentiator — Rave/Lofty/RealScout cadences
// are fixed settings, not learned.
//
// SAFETY (non-negotiable, encoded as hard bounds):
//   • The learned cap NEVER drops below the floor (1 touch) and NEVER rises above a hard ceiling
//     (2× the base, capped at base+2). It only adjusts the UX/deliverability guardrail.
//   • The legal gates — consent, opt-out/unsubscribe, DNC, quiet hours, suppression — are SEPARATE
//     and ALWAYS apply regardless of what this returns. Learning can never loosen a legal floor.
//   • Below MIN_SAMPLE recent sends the signal isn't trusted — we return the base policy unchanged.
//
// PURE — no I/O (so the proof imports it without the server-only runtime). The reader that gathers
// signals takes an injected client.

export interface ChannelPolicy {
  maxTouches: number
  windowDays: number
}

export interface EngagementSignals {
  /** 0..1 — fraction of recent sends the contact engaged with (opened / clicked / converted). */
  engagementRate: number
  /** Number of recent sends the rate is computed over. Below MIN_SAMPLE we don't trust it. */
  sample: number
}

/** Don't tune on thin data — a handful of sends isn't a rhythm. */
export const MIN_SAMPLE = 20
/** Engaged audiences (≥ this open/click/convert rate) earn a modest loosening. */
export const HIGH_ENGAGEMENT = 0.5
// TOMBSTONE (orphan doctrine §1.3) — this name is no longer exported: LOW_ENGAGEMENT.
// Nothing in the product imported it, and no simulator did either; the
// value is live and unchanged, reached through this module's own exported
// functions, which is where callers already get its effect. Same ruling and same
// reasoning as lib/vendors/appraiser-independence.ts (isAppraiserTrade,
// labelNamesAppraisal): an export with no importer is a public surface nobody
// asked for, and the wire to build is not a second copy of the module's door.
/** Cooling audiences (≤ this rate) get tightened to protect the relationship. */
const LOW_ENGAGEMENT = 0.1

export interface LearnedCadence {
  policy: ChannelPolicy
  /** Human-readable why — surfaced on the de-confliction audit row + the cockpit. */
  reason: string
  /** Did the learner change the base policy? */
  adjusted: boolean
}

/**
 * Pure: adjust a base channel policy from engagement signals, within hard safety bounds.
 *   high engagement + trusted sample → loosen (maxTouches +2, capped at 2× base)
 *   low engagement  + trusted sample → tighten (maxTouches −1, floored at 1)
 *   otherwise / thin sample          → base unchanged
 * windowDays is never changed (the window is the compliance-shaped period; only the count flexes).
 */
export function computeLearnedCadence(base: ChannelPolicy, s: EngagementSignals): LearnedCadence {
  if (s.sample < MIN_SAMPLE) {
    return { policy: base, reason: `cadence: insufficient sample (${s.sample}<${MIN_SAMPLE}) — base policy`, adjusted: false }
  }
  if (s.engagementRate >= HIGH_ENGAGEMENT) {
    const ceiling = Math.min(base.maxTouches * 2, base.maxTouches + 2)
    const maxTouches = Math.max(base.maxTouches, ceiling) === base.maxTouches ? base.maxTouches : ceiling
    if (maxTouches > base.maxTouches) {
      return { policy: { maxTouches, windowDays: base.windowDays }, reason: `cadence: engagement ${(s.engagementRate * 100).toFixed(0)}% ≥ ${HIGH_ENGAGEMENT * 100}% — loosened to ${maxTouches}/${base.windowDays}d (ceiling)`, adjusted: true }
    }
    return { policy: base, reason: `cadence: engaged but already at ceiling — base policy`, adjusted: false }
  }
  if (s.engagementRate <= LOW_ENGAGEMENT) {
    const maxTouches = Math.max(1, base.maxTouches - 1)
    if (maxTouches < base.maxTouches) {
      return { policy: { maxTouches, windowDays: base.windowDays }, reason: `cadence: engagement ${(s.engagementRate * 100).toFixed(0)}% ≤ ${LOW_ENGAGEMENT * 100}% — tightened to ${maxTouches}/${base.windowDays}d (protect the relationship)`, adjusted: true }
    }
    return { policy: base, reason: `cadence: cooling but already at floor — base policy`, adjusted: false }
  }
  return { policy: base, reason: `cadence: engagement ${(s.engagementRate * 100).toFixed(0)}% in normal band — base policy`, adjusted: false }
}

type AnyClient = { from: (t: string) => any }

/**
 * Gather engagement signals for a brokerage+channel over the trailing window from the shared touch
 * ledger (marketing_campaign_touchpoints). engagementRate = (opened|clicked|converted) / total
 * delivered sends. Best-effort — any read error yields a zero-sample signal (→ base policy).
 */
export async function getEngagementSignals(
  client: AnyClient,
  brokerageId: string,
  channel: string,
  sinceDays = 30,
): Promise<EngagementSignals> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString()
  // Map the de-confliction channel to the touchpoint channel vocabulary (mail → direct_mail).
  const tpChannel = channel === "mail" ? "direct_mail" : channel
  try {
    const sentP = client.from("marketing_campaign_touchpoints")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("channel", tpChannel).gte("sent_at", since)
    const engagedP = client.from("marketing_campaign_touchpoints")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("channel", tpChannel).gte("sent_at", since)
      .in("status", ["opened", "clicked", "converted"])
    const [{ count: sent }, { count: engaged }] = await Promise.all([sentP, engagedP])
    const sample = sent ?? 0
    const engagementRate = sample > 0 ? (engaged ?? 0) / sample : 0
    return { engagementRate, sample }
  } catch {
    return { engagementRate: 0, sample: 0 }
  }
}
