// lib/vendors/rank.ts
//
// PURE vendor ranking — no DB, no session, no server-only imports, so it can be
// tested directly and reused by any surface that has to order a bench.
//
// THE ORDER IS THE BROKERAGE'S CURATION FIRST, THEN QUALITY:
//
//   1. preferred          — the broker explicitly put this vendor on the bench
//   2. display_priority   — paid/curated placement (m355 columns on `vendors`)
//   3. rating             — the earned average
//
// Ranking by rating alone — which is what the matcher this replaces did — throws
// away the two columns the brokerage actually controls. A 4.9 nobody vetted
// outranking the broker's own preferred partner is not a recommendation the
// broker would make.

export interface RankableVendor {
  preferred?: boolean | null
  display_priority?: number | null
  rating?: number | null
  estimated_turnaround_days?: number | null
}

/** Comparator for Array.prototype.sort — best first. */
export function compareVendors(a: RankableVendor, b: RankableVendor): number {
  if (!!b.preferred !== !!a.preferred) return (b.preferred ? 1 : 0) - (a.preferred ? 1 : 0)
  if ((b.display_priority ?? 0) !== (a.display_priority ?? 0)) {
    return (b.display_priority ?? 0) - (a.display_priority ?? 0)
  }
  return (b.rating ?? 0) - (a.rating ?? 0)
}

/**
 * Narrow a bench to the fastest turnaround it offers.
 *
 * Used when a job is URGENT: speed becomes the first filter, and the normal
 * curation order then decides among the vendors who can actually make it.
 * Returns the bench unchanged when it is empty, so callers never get a
 * surprise empty list out of an optimisation.
 */
export function fastestTurnaround<T extends RankableVendor>(bench: T[]): T[] {
  if (bench.length === 0) return bench
  // A missing turnaround is treated as same-day (the column default is 1),
  // which is what the row itself says — not an excuse to drop the vendor.
  const days = (v: RankableVendor) => v.estimated_turnaround_days ?? 1
  const fastest = Math.min(...bench.map(days))
  return bench.filter((v) => days(v) === fastest)
}

/** The single best vendor for a job, honouring urgency. Null on an empty bench. */
export function pickBestVendor<T extends RankableVendor>(
  bench: T[],
  urgency: "routine" | "urgent" = "routine",
): T | null {
  if (bench.length === 0) return null
  const pool = urgency === "urgent" ? fastestTurnaround(bench) : bench
  return [...pool].sort(compareVendors)[0] ?? null
}
