// lib/format/stats.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE `median` (§6 — one vocabulary per function; §1.1 — merge onto the
// survivor). Found by scripts/duplicate-function-census.ts's SAME BODY pass
// (2026-09-08, lane BD): byte-identical `median` in lib/kernel/deal-play-outcomes.ts
// and lib/managers/teamwork-metrics.ts. A THIRD copy in
// lib/kernel/reporting-autonomy.ts computes the same value with renamed locals
// (`sorted` vs `s`, `sorted.length % 2` vs `s.length % 2 === 1`) — outside the
// finder's stated scope (comment+whitespace normalization only, no identifier
// renaming per the task that built it) but the same duplicate in substance, so
// it is merged here too.
//
// PURE LEAF — no imports (see lib/format/ordinal.ts for the fuller rationale).

/** Median of a numeric list — average of the middle pair on even counts.
 *  Null on an empty list (there is no median of nothing). */
export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
