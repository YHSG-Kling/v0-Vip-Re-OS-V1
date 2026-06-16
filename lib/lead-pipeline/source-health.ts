// lib/lead-pipeline/source-health.ts
//
// SOURCE LIFETIME-HEALTH feedback (pure). Source scoring usually stops at first-contact conversion
// (lead→contact→close) — but a source that produces cheap leads who NEVER become healthy lifetime
// relationships is a money pit dressed up as a bargain. This grades each source by the LIFETIME
// HEALTH of the contacts it actually produced (what % reached thriving/warm vs decayed to
// at-risk/dormant), so acquisition can optimize for relationships that LAST, not just leads that
// convert once. Advisory; feeds the source learner. Pure (no I/O), unit-tested directly.

import type { HealthBand } from "@/lib/intelligence/relationship-health"

export interface SourceHealthInput {
  source: string
  band: HealthBand
}

export interface SourceHealthSummary {
  source: string
  total: number
  /** thriving + warm. */
  healthy: number
  /** at_risk + dormant. */
  decayed: number
  /** healthy / total (0–1) — the lifetime-quality of this source. */
  healthRate: number
  /** advisory verdict (only meaningful past a volume floor). */
  verdict: "lasting" | "mixed" | "cheap_but_fading" | "insufficient_data"
}

const HEALTHY = new Set<HealthBand>(["thriving", "warm"])
const DECAYED = new Set<HealthBand>(["at_risk", "dormant"])
const DEFAULT_MIN_VOLUME = 10

/** Grade each source by the lifetime health of the contacts it produced. Pure. */
export function aggregateSourceHealth(items: SourceHealthInput[], opts?: { minVolume?: number }): SourceHealthSummary[] {
  const minVolume = opts?.minVolume ?? DEFAULT_MIN_VOLUME
  const by = new Map<string, { total: number; healthy: number; decayed: number }>()
  for (const it of items ?? []) {
    if (!it.source) continue
    const e = by.get(it.source) ?? { total: 0, healthy: 0, decayed: 0 }
    e.total++
    if (HEALTHY.has(it.band)) e.healthy++
    else if (DECAYED.has(it.band)) e.decayed++
    by.set(it.source, e)
  }
  return [...by.entries()]
    .map(([source, e]) => {
      const healthRate = e.total > 0 ? e.healthy / e.total : 0
      let verdict: SourceHealthSummary["verdict"]
      if (e.total < minVolume) verdict = "insufficient_data"
      else if (healthRate >= 0.5) verdict = "lasting"
      else if (healthRate >= 0.25) verdict = "mixed"
      else verdict = "cheap_but_fading"
      return { source, total: e.total, healthy: e.healthy, decayed: e.decayed, healthRate, verdict }
    })
    .sort((a, b) => b.healthRate - a.healthRate)
}
