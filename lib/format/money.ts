// lib/format/money.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE COMPACT-CURRENCY-FROM-CENTS FORMATTER (§6 — one vocabulary per
// function; §1.1 — merge onto the survivor). Three byte-identical private
// copies of `money` (cents → "$1.2M" / "$45K" / "$900") lived in
// lib/intelligence/roi-ledger.ts, lib/kernel/intelligence-report.ts and
// lib/video/listing-pitch-reel.ts — found by
// scripts/duplicate-function-census.ts's SAME BODY pass (2026-09-08, lane BD).
//
// NAMED `compactCentsMoney`, not `money` or `compactMoney`: two OTHER,
// DIFFERENTLY-SHAPED functions already answer to those spellings and are NOT
// duplicates of this one —
//   · lib/video/director-content.ts:196 `money(n: number|null|undefined):
//     string|null` — dollars in, null-safe, a different output contract;
//   · lib/video/director-content.ts:419 `compactMoney(n: number): string` —
//     dollars in, no locale commas, 1,000/1,000,000 thresholds (this
//     collision was caught by re-running the census after the first version
//     of this file landed as `compactMoney` — confirms the finder catches
//     collisions it did not go looking for, not just the ones adjudicated
//     from the known list).
// Reusing either name here would have recreated the exact defect §6 exists to
// prevent: two spellings of "a money formatter" that callers cannot
// distinguish by name. This one is unambiguous about its input unit.
//
// PURE LEAF — no imports, so callers on either side of the Remotion/kernel
// bundling wall (see lib/format/ordinal.ts for the fuller version of that
// note) can both use it without dragging the other side in.

/** Cents → compact display string: "$1.2M" / "$45K" / "$900". Negative and
 *  non-finite input clamp to $0 rather than throwing or printing "$-5". */
export function compactCentsMoney(cents: number): string {
  const v = Math.round(Math.max(0, cents) / 100)
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (v >= 10_000) return `$${Math.round(v / 1000).toLocaleString("en-US")}K`
  return `$${v.toLocaleString("en-US")}`
}
