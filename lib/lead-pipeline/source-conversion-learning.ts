// lib/lead-pipeline/source-conversion-learning.ts
//
// SOURCE-CONVERSION LEARNER — which scrape/lead SOURCES actually convert (lead → contact → close)
// for THIS brokerage, so spend/effort flows to the winners and the money-pits get flagged. The
// scraping analog of video format_learning: a PURE scorer + a PURE recommender gated on a real
// sample, HONEST on thin data (never advises flipping a source on a handful of leads), and ADVISORY
// only — humans keep lead_scraping_markets.enabled_sources. Composes the existing source field path
// (leads.source → leads.contact_id → transactions) + cost_per_record; no new risk math, no new
// tables, and it does NOT duplicate source-intent-map (semantics) or source-analytics (live UI ROI).

/** Leads needed before a source's conversion rate is trusted (mirrors format_learning's MIN_SAMPLE). */
export const MIN_SOURCE_SAMPLE = 8
/** A source must return more than it costs to be recommended for spend. */
export const ROI_FLOOR = 1.0

export interface SourceConversionRow {
  source: string
  /** Leads from this source in the window (the denominator). */
  leadCount: number
  /** Leads that became contacts (leads.contact_id IS NOT NULL). */
  contactCount: number
  /** Contacts that reached a closed transaction. */
  closedCount: number
  /** GCI/revenue attributed to closes from this source. */
  revenue: number
  /** Spend attributed to this source (sum of cost_per_record). */
  spend: number
}

export interface SourceScore {
  source: string
  leadToContactRate: number
  contactToCloseRate: number
  costPerContact: number
  /** revenue / spend (null when no spend recorded). */
  roiMultiple: number | null
  /** = leadCount — the denominator for trust. */
  sampleSize: number
  trusted: boolean
  /** 0..1 blended performance, max-scaled across sources (untrusted → 0). */
  score: number
}

export interface ScoredSources {
  sources: Record<string, SourceScore>
  ranked: SourceScore[]
}

const safeRate = (num: number, den: number) => (den > 0 ? num / den : 0)

/** Pure: fold per-source outcome rows into scored, trust-gated, max-scaled performance. */
export function scoreSourceConversions(rows: SourceConversionRow[]): ScoredSources {
  const base = rows.map((r) => {
    const leadToContactRate = safeRate(r.contactCount, r.leadCount)
    const contactToCloseRate = safeRate(r.closedCount, r.contactCount)
    const roiMultiple = r.spend > 0 ? r.revenue / r.spend : null
    const trusted = r.leadCount >= MIN_SOURCE_SAMPLE
    return {
      source: r.source, leadToContactRate, contactToCloseRate,
      costPerContact: r.spend / Math.max(r.contactCount, 1),
      roiMultiple, sampleSize: r.leadCount, trusted,
    }
  })
  // Max-scale ROI across TRUSTED sources so a single outlier doesn't dominate; blend with conversion.
  const maxRoi = Math.max(1, ...base.filter((b) => b.trusted && b.roiMultiple != null).map((b) => b.roiMultiple as number))
  const scored: SourceScore[] = base.map((b) => ({
    ...b,
    score: b.trusted
      ? Math.min(1, 0.5 * b.leadToContactRate + 0.5 * ((b.roiMultiple ?? 0) / maxRoi))
      : 0, // untrusted → unknown, not "bad"
  }))
  const sources: Record<string, SourceScore> = {}
  for (const s of scored) sources[s.source] = s
  return { sources, ranked: [...scored].sort((a, b) => b.score - a.score) }
}

export interface SourceAllocation {
  /** Trusted winners worth turning ON (not already enabled). */
  enable: string[]
  /** Trusted money-pits worth turning OFF (currently enabled, ROI below floor). */
  disable: string[]
  /** Thin-sample sources — leave alone, keep gathering data (honest on thin data). */
  hold: string[]
  reasons: Record<string, string>
}

/**
 * Pure: from scored sources + the currently-enabled set, advise enable/disable/hold. The gate is
 * non-negotiable: a source is NEVER advised on/off below MIN_SOURCE_SAMPLE — it's held. Advisory
 * only; the human flips enabled_sources.
 */
export function recommendSourceAllocation(scored: ScoredSources, currentEnabled: string[]): SourceAllocation {
  const enabled = new Set(currentEnabled)
  const out: SourceAllocation = { enable: [], disable: [], hold: [], reasons: {} }
  for (const s of scored.ranked) {
    if (!s.trusted) {
      out.hold.push(s.source)
      out.reasons[s.source] = `holding — only ${s.sampleSize} leads (<${MIN_SOURCE_SAMPLE}); not enough to judge`
      continue
    }
    const roi = s.roiMultiple
    if (!enabled.has(s.source) && (roi == null || roi > ROI_FLOOR) && s.leadToContactRate >= 0.1) {
      out.enable.push(s.source)
      out.reasons[s.source] = `enable — ${Math.round(s.leadToContactRate * 100)}% lead→contact${roi != null ? `, ${roi.toFixed(1)}x ROI` : ""} on ${s.sampleSize} leads`
    } else if (enabled.has(s.source) && roi != null && roi <= ROI_FLOOR) {
      out.disable.push(s.source)
      out.reasons[s.source] = `disable — ${roi.toFixed(1)}x ROI (below ${ROI_FLOOR}x) on ${s.sampleSize} leads; it's costing more than it returns`
    } else {
      out.reasons[s.source] = enabled.has(s.source) ? "keep — performing within range" : "skip — trusted but not a clear win"
    }
  }
  return out
}
