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

/**
 * MOUNTED (§1 orphan doctrine, wave 58 carried item, 2026-09-11):
 * previously a private, never-called function in
 * app/dashboard/campaigns/mail/components/create-campaign-dialog.tsx — that
 * dialog has no color-valued field, so the sanitizer had nothing to
 * sanitize (a prior wave's own UNRESOLVED comment there said so and left it
 * in place rather than guess-wiring it). The real brand-color acceptance
 * points DO exist and DID accept an unvalidated string: `global_settings`'s
 * primary_color/secondary_color (brokerage-scoped brand color; brokerages
 * carries its own primary_color too, with no writer anywhere in the tree) —
 * app/actions/onboarding/brand.ts::saveBrandColors upserts `data.primaryColor`
 * / `data.secondaryColor` straight from the onboarding wizard's client input
 * with no format check at all, and app/actions/settings/update-global-settings.ts
 * accepts the same two fields from BrandingForm.tsx equally unchecked. Both
 * values eventually render as a literal CSS color (inline style / Tailwind
 * arbitrary value) on brand-facing surfaces, so an unvalidated string is a
 * CSS-injection surface, not merely a cosmetic one. Relocated here (exported,
 * pure, no imports) so both server-side writers can share ONE sanitizer
 * rather than each growing its own copy — moved rather than left in the
 * dialog with a tombstone, because there was no live call site to leave a
 * tombstone AT.
 */
export function sanitizeCssColor(value: unknown): string {
  if (typeof value !== "string") return "#000000"
  // Only allow safe color values — hex, rgb/rgba, hsl/hsla, or named colors
  if (/^(#[0-9a-fA-F]{3,8}|rgb[a]?\([^)]+\)|hsl[a]?\([^)]+\)|[a-zA-Z]+)$/.test(value.trim())) {
    return value.trim()
  }
  return "#000000"
}
