// lib/ads/ad-engagement-decay.ts
//
// CREATIVE-FATIGUE MONITOR (verified white space) — the ad-manager keeps only the LATEST snapshot
// and explicitly ignores CTR, so a creative whose engagement is DECAYING burns budget unnoticed.
// This is the pure decay engine: over a time-series of CTR snapshots it fits a trend, measures the
// drop from the creative's own opening CTR, and verdicts a fatigue risk — HONEST on thin data
// (too few points / too short a run → "insufficient", never a false alarm). The analog of video
// format_learning, for PAID ads. The caller persists the series (ad_performance_history) + proposes
// the gated refresh; this just does the math. PURE.

export interface CtrPoint {
  /** ISO timestamp of the snapshot. */
  capturedAt: string
  /** Click-through rate at that time (0..1 or %, consistent within a series). */
  ctr: number
}

export type FatigueRisk = "high" | "medium" | "low" | "insufficient"

export interface EngagementDecay {
  fatigueRisk: FatigueRisk
  /** Fraction the CTR has fallen from the opening reading (0..1). */
  dropPct: number
  /** Least-squares slope of CTR per day (negative = decaying). */
  decayPerDay: number
  daysLive: number
  initialCtr: number
  currentCtr: number
  sample: number
  reason: string
}

/** Don't judge fatigue on thin data (mirrors format_learning's honesty gate). */
export const MIN_SAMPLE = 3
export const MIN_DAYS = 7
/** A creative that's lost this much of its opening CTR is fatigued. */
export const HIGH_DROP = 0.4
export const MED_DROP = 0.2

const days = (a: string, b: string) => (new Date(b).getTime() - new Date(a).getTime()) / 86_400_000

/** Pure: verdict a creative's fatigue from its CTR time-series. */
export function computeEngagementDecay(series: CtrPoint[]): EngagementDecay {
  const pts = [...series].filter((p) => Number.isFinite(p.ctr)).sort((a, b) => +new Date(a.capturedAt) - +new Date(b.capturedAt))
  const sample = pts.length
  const blank = (reason: string, partial: Partial<EngagementDecay> = {}): EngagementDecay => ({
    fatigueRisk: "insufficient", dropPct: 0, decayPerDay: 0, daysLive: 0,
    initialCtr: pts[0]?.ctr ?? 0, currentCtr: pts[sample - 1]?.ctr ?? 0, sample, reason, ...partial,
  })

  if (sample < MIN_SAMPLE) return blank(`only ${sample} snapshot(s) (<${MIN_SAMPLE}) — not enough to judge`)
  const daysLive = days(pts[0].capturedAt, pts[sample - 1].capturedAt)
  if (daysLive < MIN_DAYS) return blank(`only ${daysLive.toFixed(1)} days of data (<${MIN_DAYS}) — too early`, { daysLive })

  const initialCtr = pts[0].ctr
  const currentCtr = pts[sample - 1].ctr
  const dropPct = initialCtr > 0 ? Math.max(0, (initialCtr - currentCtr) / initialCtr) : 0

  // Least-squares slope of ctr vs day-offset.
  const xs = pts.map((p) => days(pts[0].capturedAt, p.capturedAt))
  const ys = pts.map((p) => p.ctr)
  const n = sample
  const sx = xs.reduce((a, b) => a + b, 0), sy = ys.reduce((a, b) => a + b, 0)
  const sxx = xs.reduce((a, b) => a + b * b, 0), sxy = xs.reduce((a, b, i) => a + b * ys[i], 0)
  const denom = n * sxx - sx * sx
  const decayPerDay = denom !== 0 ? (n * sxy - sx * sy) / denom : 0

  // Risk: a real drop from the opening CTR, on a creative that's had a fair run.
  let fatigueRisk: FatigueRisk = "low"
  if (dropPct >= HIGH_DROP && decayPerDay < 0) fatigueRisk = "high"
  else if (dropPct >= MED_DROP && decayPerDay < 0) fatigueRisk = "medium"

  return {
    fatigueRisk, dropPct, decayPerDay, daysLive, initialCtr, currentCtr, sample,
    reason: fatigueRisk === "high"
      ? `CTR down ${Math.round(dropPct * 100)}% from open (${(initialCtr).toFixed(2)} → ${(currentCtr).toFixed(2)}) over ${daysLive.toFixed(0)} days — fatigued, refresh the creative`
      : fatigueRisk === "medium"
      ? `CTR down ${Math.round(dropPct * 100)}% — softening; line up a fresh variant`
      : `CTR holding (${Math.round(dropPct * 100)}% off open) — no refresh needed`,
  }
}
