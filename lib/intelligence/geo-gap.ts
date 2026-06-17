// lib/intelligence/geo-gap.ts
//
// GEO-GAP ASSESSMENT (pure) — closes the GEO loop. The citation monitor records, honestly, whether AI
// search engines cite our published pages; this decides when a page has been checked ENOUGH times,
// across ENOUGH days, and STILL never cited — i.e. it's persistently invisible and worth a human's
// attention to refresh (new demand-angle FAQ, sharper copy). It never fires on thin data (a page that
// hasn't been checked, or only today) and never fires on a page that IS being cited. Pure (no I/O),
// unit-tested directly. The runner turns an "act" verdict into a feed-only manager signal.

export interface GeoGapStats {
  /** observations whose outcome was "cited". */
  cited: number
  /** observations whose outcome was "not_cited" (we looked and weren't there). */
  notCited: number
  /** observations we couldn't run (rail down) — excluded from the denominator, never counted against. */
  notChecked: number
  /** distinct days we have ANY checked observation for (cited or not_cited). */
  distinctCheckedDays: number
}

export interface GeoGapVerdict {
  severity: "none" | "watch" | "act"
  needsRemediation: boolean
  reason: string
  /** 0..1 visibility (cited / checked), or null when nothing was checked. */
  visibility: number | null
}

export interface GeoGapOpts {
  /** minimum checked observations before we'll judge invisibility (avoid thin-data false positives). */
  minChecked?: number
  /** minimum distinct days of checked data before escalating to "act" (a single bad day isn't a trend). */
  minDays?: number
}

/**
 * PURE + total. Decide whether a page is persistently invisible to AI search and needs a refresh.
 *   · cited at all                      → none (it's working).
 *   · < minChecked checked observations → none (insufficient_data — never a thin-data false positive).
 *   · 0 cited, enough checks, ≥ minDays → act (persistently invisible).
 *   · 0 cited, enough checks, < minDays → watch (one rough day — keep observing).
 */
export function assessGeoGap(stats: GeoGapStats, opts: GeoGapOpts = {}): GeoGapVerdict {
  const minChecked = opts.minChecked ?? 3
  const minDays = opts.minDays ?? 2
  const checked = stats.cited + stats.notCited
  const visibility = checked === 0 ? null : stats.cited / checked

  if (stats.cited > 0) {
    return { severity: "none", needsRemediation: false, reason: "cited", visibility }
  }
  if (checked < minChecked) {
    return { severity: "none", needsRemediation: false, reason: "insufficient_data", visibility }
  }
  if (stats.distinctCheckedDays >= minDays) {
    return { severity: "act", needsRemediation: true, reason: "persistently_not_cited", visibility }
  }
  return { severity: "watch", needsRemediation: false, reason: "not_cited_single_day", visibility }
}

/** A short, human recommendation for the feed when a page needs remediation. Pure. */
export function geoGapRecommendation(slug: string, stats: GeoGapStats): string {
  const checked = stats.cited + stats.notCited
  return `AI search has checked /lm/${slug} ${checked} time${checked === 1 ? "" : "s"} across ${stats.distinctCheckedDays} day${stats.distinctCheckedDays === 1 ? "" : "s"} and never cited it — regenerate its FAQ with fresh demand topics + sharpen the answers so it can be surfaced.`
}
