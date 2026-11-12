// lib/lead-pipeline/source-health.ts
//
// SOURCE LIFETIME-HEALTH feedback (pure). Source scoring usually stops at first-contact conversion
// (lead→contact→close) — but a source that produces cheap leads who NEVER become healthy lifetime
// relationships is a money pit dressed up as a bargain. This grades each source by the LIFETIME
// HEALTH of the contacts it actually produced (what % reached thriving/warm vs decayed to
// at-risk/dormant), so acquisition can optimize for relationships that LAST, not just leads that
// convert once. Advisory; feeds the source learner. Pure (no I/O), unit-tested directly.

import type { HealthBand } from "@/lib/intelligence/relationship-health"
import { classifyEnrichmentFault } from "./enrichment-retry"

export interface SourceHealthInput {
  source: string
  band: HealthBand
  /**
   * WAVE 66: the vendor error text (if any) observed on the scrape/enrichment batch that
   * produced this item. When present and it classifies as a CONFIG fault (BatchData "token
   * ability missing" / "provisioning required"), the source's poor showing here is a BROKEN
   * CONNECTOR, not bad lead quality — see the "connector_fault" verdict below. Optional so
   * every existing caller (which never carried vendor error text) is unaffected.
   */
  vendorFaultMessage?: string | null
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
  verdict: "lasting" | "mixed" | "cheap_but_fading" | "insufficient_data" | "connector_fault"
  /** How many of this source's items carried a CONFIG-fault vendor error (wave 66) — 0 for
   *  every source with no vendorFaultMessage input, so existing behavior is unchanged. */
  configFaultCount: number
}

const HEALTHY = new Set<HealthBand>(["thriving", "warm"])
const DECAYED = new Set<HealthBand>(["at_risk", "dormant"])
const DEFAULT_MIN_VOLUME = 10

/** Grade each source by the lifetime health of the contacts it produced. Pure. */
export function aggregateSourceHealth(items: SourceHealthInput[], opts?: { minVolume?: number }): SourceHealthSummary[] {
  const minVolume = opts?.minVolume ?? DEFAULT_MIN_VOLUME
  const by = new Map<string, { total: number; healthy: number; decayed: number; configFaultCount: number }>()
  for (const it of items ?? []) {
    if (!it.source) continue
    const e = by.get(it.source) ?? { total: 0, healthy: 0, decayed: 0, configFaultCount: 0 }
    e.total++
    if (HEALTHY.has(it.band)) e.healthy++
    else if (DECAYED.has(it.band)) e.decayed++
    if (it.vendorFaultMessage && classifyEnrichmentFault(it.vendorFaultMessage) === "config") e.configFaultCount++
    by.set(it.source, e)
  }
  return [...by.entries()]
    .map(([source, e]) => {
      const healthRate = e.total > 0 ? e.healthy / e.total : 0
      let verdict: SourceHealthSummary["verdict"]
      // A source where the MAJORITY of items carried a config-fault vendor error is not a
      // lead-quality problem — it is a broken connector wearing a lead-quality costume. This
      // check runs BEFORE the volume floor and the healthRate buckets: even a small sample is
      // enough to know the connector, not the source, is what needs attention.
      if (e.total > 0 && e.configFaultCount / e.total >= 0.5) verdict = "connector_fault"
      else if (e.total < minVolume) verdict = "insufficient_data"
      else if (healthRate >= 0.5) verdict = "lasting"
      else if (healthRate >= 0.25) verdict = "mixed"
      else verdict = "cheap_but_fading"
      return { source, total: e.total, healthy: e.healthy, decayed: e.decayed, healthRate, verdict, configFaultCount: e.configFaultCount }
    })
    .sort((a, b) => b.healthRate - a.healthRate)
}
