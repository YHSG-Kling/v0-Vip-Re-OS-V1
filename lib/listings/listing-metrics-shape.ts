// lib/listings/listing-metrics-shape.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE shape helpers for the listing-metrics rollup — split out of the server-only producer so the
// simulator can unit-test the only non-DB logic: which date anchors "days on market" and how raw
// property_views rows sum into a single view total. No I/O.

export interface ListingMarketStartInput {
  go_live_date?: string | null
  listing_date?: string | null
  created_at?: string | null
}

/**
 * PURE. The metrics row's `date` is the listing's market-start anchor — the seller-updates DOM calc
 * reads the EARLIEST metric date as "day the home hit the market", so we anchor it to go-live (then
 * listing_date, then created_at). Returns a YYYY-MM-DD string. `now` lets the test pin the fallback.
 */
export function pickMarketStartDate(l: ListingMarketStartInput, now: Date): string {
  const raw = l.go_live_date ?? l.listing_date ?? l.created_at ?? now.toISOString()
  // Normalize to a date (YYYY-MM-DD); tolerate already-date strings and full timestamps.
  return raw.slice(0, 10)
}

/** PURE. Sum the per-row view_count of property_views rows for a listing (null-safe). */
export function sumViewCounts(rows: Array<{ view_count?: number | null }> | null | undefined): number {
  return (rows ?? []).reduce((s, r) => s + (typeof r.view_count === "number" ? r.view_count : 0), 0)
}
