/**
 * Canonical DOM (Days on Market) computation.
 *
 * Source of truth: `listings.go_live_date`. That column holds the moment
 * a listing went publicly active on the MLS / aggregators — which is the
 * only date that maps cleanly to industry "DOM" convention.
 *
 *   - `listing_date`     — when the seller signed the listing agreement.
 *                          NOT the start of DOM (pre-MLS period doesn't
 *                          count).
 *   - `list_date`        — does not exist on the live schema; if you see
 *                          it referenced anywhere it's a stale field.
 *
 * Callers that read DOM from a hypothetical `days_on_market` or `dom`
 * column are reading a nonexistent column (the live schema has neither).
 * They should fetch `go_live_date` and call this helper instead.
 */

export function computeDaysOnMarket(goLiveDate: string | Date | null | undefined): number | null {
  if (!goLiveDate) return null
  const t = goLiveDate instanceof Date ? goLiveDate.getTime() : new Date(goLiveDate).getTime()
  if (!Number.isFinite(t)) return null
  const diff = Date.now() - t
  if (diff < 0) return 0
  return Math.floor(diff / 86_400_000)
}

/** Same as computeDaysOnMarket but returns 0 instead of null for missing dates.
 *  Use only when downstream UI cannot represent null. */
export function computeDaysOnMarketOrZero(goLiveDate: string | Date | null | undefined): number {
  return computeDaysOnMarket(goLiveDate) ?? 0
}
