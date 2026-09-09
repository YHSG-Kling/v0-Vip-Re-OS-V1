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

/** Dollars → compact display string: "$1.2M" / "$180K" / "$3,200". The
 *  dollars-in twin of `compactCentsMoney` (no /100), kept as its OWN export
 *  rather than a thin wrapper around it — the two disagree in one edge case
 *  (the K-branch's thousands separator right at the ~$1M boundary) and
 *  changing that would have altered compactCentsMoney's existing three
 *  callers' output as a side effect of this merge, which §1.1 forbids.
 *  Byte-identical copies (named `fmtUsd`) lived in
 *  lib/intelligence/partners-meeting.ts and
 *  lib/intelligence/partners-meeting-reel-props.ts (SAME BODY census,
 *  2026-09-08). */
export function compactDollarsMoney(n: number): string {
  const v = Math.round(Math.max(0, n))
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (v >= 10_000) return `$${Math.round(v / 1000)}K`
  return `$${v.toLocaleString("en-US")}`
}

// ─────────────────────────────────────────────────────────────────────────────
// THE DOLLARS-IN, WHOLE-DOLLAR USD FORMATTERS (§1/§6, 2026-09-08, lane CC —
// duplicates round 2). A private `const usd = (n) => ...` was pasted into 27
// files, in two visibly different but behaviorally near-identical shapes:
// `Intl.NumberFormat(..., { maximumFractionDigits: 0 }).format(n)` and
// `` `$${Math.round(n).toLocaleString("en-US")}` `` (some without the explicit
// "en-US", relying on the runtime's default locale). The template-string form
// is a LATENT BUG on negative input — `$${(-1235).toLocaleString()}` renders
// "$-1,235" (dollar sign before the minus) where Intl correctly renders
// "-$1,235" — so the Intl form is the survivor everywhere, not just where it
// already was. Every other private `usd` in this repo differs by an actual
// contract (null handling, decimal places, rounding) and is recorded, not
// merged, at each site with a comment naming why. */
export function usd(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)
}

/** Nullable dollars → whole-dollar USD string, or `""` for null/undefined.
 *  Survivor for the three identical `n != null ? Intl...format(n) : ""`
 *  copies (cron listing-promo-social-publish, render-just-listed,
 *  listing-promo-reactor). */
export function usdOrEmpty(n: number | null | undefined): string {
  return n != null ? usd(n) : ""
}

/** Nullable/non-finite dollars → whole-dollar USD string, or `null`. Guards
 *  with `typeof === "number" && Number.isFinite` (rejects NaN/Infinity, not
 *  just null/undefined) — the stricter of the two near-duplicates this
 *  merges. Survivor for app/v/[slug]/page.tsx's copy. NOT the survivor for
 *  lib/portal/home-assistant.ts's byte-equivalent copy: that file's header
 *  contract is "Pure, import-free helpers" (unit-tested import-free by
 *  scripts/home-assistant-simulator.ts), so it deliberately keeps its own
 *  text in sync with this one by hand rather than importing it. */
export function usdOrNull(n: number | null | undefined): string | null {
  return typeof n === "number" && Number.isFinite(n) ? usd(n) : null
}

/** Nullable/non-finite dollars → whole-dollar USD string, or the em-dash
 *  placeholder "—". Survivor for three near-duplicates (PortalNlSearch, admin
 *  strategy-insights, app/crm/contacts/[contactId]/seller-lifetime-overview.tsx's
 *  `fmtMoney`) that differed only in whether the locale was passed explicitly
 *  and whether NaN/Infinity were guarded against (the strictest of the three
 *  — seller-lifetime-overview's — is the one this keeps). */
export function usdOrDash(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? usd(n) : "—"
}

/** Dollars → 2-decimal USD string WITH the Intl thousands separator:
 *  "$1,234.56". A distinct contract from `usd2` (which is deliberately
 *  separator-free) — merges app/dashboard/superadmin/vendors/page.tsx's
 *  `fmtMoney` (manual `$` + `toLocaleString`, wrong on negative input: prints
 *  "$-1,234.56" instead of "-$1,234.56") and
 *  app/dashboard/financials/brokerage/page.tsx:994's local `usd`. */
export function usd2Grouped(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n)
}

/** Dollars → 2-decimal USD string WITHOUT a thousands separator: "$1234.56".
 *  A real, distinct contract from `usd()` — not a rounding variant of it —
 *  because it deliberately omits grouping. Survivor for
 *  lib/analytics/territory-roi.ts's un-null-safe copy and the `?? 0`-guarded
 *  2-fraction-digit `usd` local to app/dashboard/financials/brokerage/page.tsx:994. */
export function usd2(n: number): string {
  return `$${n.toFixed(2)}`
}

/** Nullable dollars → `usd2`, or `null` for null. Byte-identical private copies
 *  lived in app/dashboard/admin/scrape-diagnostics/tenant-coverage-card.tsx
 *  and app/dashboard/superadmin/platform/territory-coverage-board.tsx. */
export function usd2OrNull(n: number | null | undefined): string | null {
  return n == null ? null : usd2(n)
}

// ─────────────────────────────────────────────────────────────────────────────
// SAME-BODY CENSUS, ROUND 4 (2026-09-09, lane FC). Two more `formatCurrency`
// contracts pasted across lender/title surfaces and offer cards — both
// whole-dollar `usd()`, but disagreeing on what counts as "missing":

/** Whole-dollar USD, or `"N/A"` for any FALSY amount (`0`, `null`,
 *  `undefined`, `NaN`) — the loose null-check four identical private
 *  `formatCurrency` copies used. Survivor for
 *  app/components/lender/loan-list.tsx:56, app/components/title/transaction-list.tsx:74,
 *  app/portal/lender/[transactionId]/page.tsx:68, app/portal/title/[transactionId]/page.tsx:48. */
export function usdOrNA(amount: number | null | undefined): string {
  if (!amount) return "N/A"
  return usd(amount)
}

/** Whole-dollar USD, or `"N/A"` — but ONLY for `null`/`undefined`, so a real
 *  `$0` still renders. A genuinely different contract from `usdOrNA` (which
 *  swallows zero), not a formatting variant of it. Survivor for
 *  app/components/portal/OfferStatusCard.tsx:49 and
 *  app/portal/[contactId]/offers/page.tsx:102. */
export function usdOrNAOnNullish(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return "N/A"
  return usd(amount)
}

/** Dollars → compact CHART-AXIS tick label: "$1.2M" / "$45K" / "$180" — no
 *  Intl, no thousands separator below $1K, and (unlike `compactDollarsMoney`)
 *  the "M" branch keeps a trailing ".0" and the "K" branch's threshold is
 *  $1,000 not $10,000. Kept as its OWN function rather than reusing
 *  `compactDollarsMoney` because changing either one's thresholds would visibly
 *  move numbers on the chart it wasn't written for (§1.1 forbids that
 *  side-effect). Survivor for the byte-identical private `formatCurrency`
 *  pasted into app/dashboard/financials/brokerage/forecast-chart.tsx:23 and
 *  app/dashboard/financials/brokerage/pl-trend-chart.tsx:25. */
export function axisCompactDollars(val: number): string {
  if (val >= 1000000) return `$${(val / 1000000).toFixed(1)}M`
  if (val >= 1000) return `$${(val / 1000).toFixed(0)}K`
  return `$${val}`
}
