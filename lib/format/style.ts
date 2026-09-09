// lib/format/style.ts
// ─────────────────────────────────────────────────────────────────────────────
// SAME-BODY CENSUS, ROUND 4 (2026-09-09, lane FC). PURE LEAF — no imports.

/** Margin percentage → a Tailwind text-color class, banding at 40/25/15%.
 *  Survivor for the byte-identical private `getMarginColor` in
 *  app/dashboard/financials/components/os/margin-breakdown-panel.tsx:49 and
 *  app/dashboard/financials/components/os/profitability-radar.tsx:45. */
export function marginColorClass(margin: number): string {
  if (margin >= 40) return "text-green-600"
  if (margin >= 25) return "text-emerald-600"
  if (margin >= 15) return "text-amber-600"
  return "text-red-600"
}
