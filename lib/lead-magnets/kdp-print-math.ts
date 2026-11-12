// lib/lead-magnets/kdp-print-math.ts
//
// KDP PAPERBACK NUMBERS AND THE THREE PURE FUNCTIONS OVER THEM (wave 143, lane 143F) — extracted from lib/lead-magnets/book-publishing.ts so
// each has a caller in another file: kdpPaperbackPlan (book-publishing.ts) reads the chart and the page estimate, and buildKdpPackage
// (book-publishing-produce.ts) checks the planned trim against the allowed range. No behaviour changed.
//
// Numbers read 2026-10-23 from KDP's help pages (trim size and page ranges G201834180; margins by page count). KDP's own upload screens govern.
// PURE: no I/O, no server-only.

export const KDP_PAPERBACK_SPEC = {
  trimWidthIn: { min: 4, max: 8.5 }, trimHeightIn: { min: 6, max: 11.69 },
  defaultTrimIn: { width: 6, height: 9 },
  pages: { min: 24, maxBlackWhite: 828 },
  outsideMarginIn: 0.25, outsideMarginWithBleedIn: 0.375,
  insideMargin: [
    { fromPage: 24, toPage: 150, inches: 0.375 }, { fromPage: 151, toPage: 300, inches: 0.5 }, { fromPage: 301, toPage: 500, inches: 0.625 },
    { fromPage: 501, toPage: 700, inches: 0.75 }, { fromPage: 701, toPage: 828, inches: 0.875 },
  ],
} as const

/** PURE. The inside (gutter) margin KDP requires for a page count, or null outside 24–828. scripts/book-publishing-guard.ts drives every chart boundary (23/24/150/151/…/828/829). */
export function kdpInsideMarginInches(pageCount: number): number | null {
  if (!Number.isInteger(pageCount)) return null
  const row = KDP_PAPERBACK_SPEC.insideMargin.find((r) => pageCount >= r.fromPage && pageCount <= r.toPage)
  return row ? row.inches : null
}

/** PURE. Is the trim inside KDP's allowed range (4"–8.5" wide × 6"–11.69" tall)? */
export function kdpTrimAllowed(widthIn: number, heightIn: number): boolean {
  const t = KDP_PAPERBACK_SPEC
  return widthIn >= t.trimWidthIn.min && widthIn <= t.trimWidthIn.max && heightIn >= t.trimHeightIn.min && heightIn <= t.trimHeightIn.max
}

/** PURE. A page-count ESTIMATE for a 6×9 interior at ~320 words a page plus front/back matter, rounded up to even (KDP's rule). */
export function estimateTrimPages(words: number, frontBackMatterPages = 8): number {
  const body = Math.ceil(Math.max(0, words) / 320)
  const total = body + frontBackMatterPages
  return total % 2 === 0 ? total : total + 1
}
