// lib/kernel/vendor-categories.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE vendors.category vocabulary.
//
// The live CHECK, read off the database:
//
//   CHECK (category = ANY (ARRAY['Contractor','Inspector','Lender',
//                                'Other','Stager','Title Company']))
//
// It is Title Case, and 'Title Company' is two words. Three partner-facing
// surfaces asked for it in lowercase:
//
//   app/dashboard/partners/components/os/lender-status-panel.tsx  eq(category,'lender')
//   app/dashboard/partners/components/os/title-pipeline-panel.tsx eq(category,'title')
//   app/title/dashboard/page.tsx                                  eq(category,'title')
//
// Postgres string comparison is case-sensitive, so all three matched zero rows
// forever: the broker's lender panel showed 0 lenders, the title pipeline panel
// showed 0 title companies, and the title partner's own dashboard could not
// confirm the vendor row it was looking at was a title company — so it fell
// through to the not-a-title-partner branch.
//
// The vocabulary itself had also been copied five times, each slightly different:
//
//   lib/kernel/vendor-orchestration.ts       type VendorCategory (6 values)
//   lib/kernel/vendor-coverage-forecast.ts   type VendorCategory (5 — no 'Other')
//   lib/kernel/vendor-verification.ts        VALID_CATEGORIES Set (6)
//   lib/kernel/lender-linkage.ts             LENDER_VENDOR_CATEGORY, plus a comment
//                                            claiming the column is free text
//   lib/contacts/card-classifier.ts          an inline union in the return type
//
// One copy now, here, and the five import it.
//
// NOT THE SAME THING as lib/compliance/vendor-respa.ts's normalizeVendorCategory:
// that flattens ANY spelling from `vendors`, `vendor_directory` AND
// `referral_partners` (which are free text) into a comparable token for RESPA
// matching. This module is only about the `vendors.category` CHECK.

/** Every value the CHECK admits, alphabetical as the constraint declares them. */
export const VENDOR_CATEGORIES = [
  "Contractor",
  "Inspector",
  "Lender",
  "Other",
  "Stager",
  "Title Company",
] as const

export type VendorCategory = (typeof VENDOR_CATEGORIES)[number]

/**
 * The categories a pipeline stage can actually demand. 'Other' is the catch-all
 * bucket for photographers, movers, attorneys and the like — a real vendor can
 * be filed under it, but no stage ever forecasts a need for "Other".
 */
export const BENCH_VENDOR_CATEGORIES = [
  "Lender",
  "Inspector",
  "Title Company",
  "Contractor",
  "Stager",
] as const

export type BenchVendorCategory = (typeof BENCH_VENDOR_CATEGORIES)[number]

/** The two categories with dedicated partner surfaces, spelled as the CHECK does. */
export const VENDOR_CATEGORY_LENDER: VendorCategory = "Lender"
export const VENDOR_CATEGORY_TITLE: VendorCategory = "Title Company"

/** PURE — is this exactly a value the column will accept? */
export function isVendorCategory(value: string | null | undefined): value is VendorCategory {
  return !!value && (VENDOR_CATEGORIES as readonly string[]).includes(value)
}

/**
 * PURE — map a loose spelling onto the CHECK value, or null if there is no
 * confident match. Handles the two shapes that were actually in the codebase:
 * lowercase ('lender') and the one-word short form ('title' for 'Title Company').
 * Returns null rather than guessing, so a caller can fall back to 'Other'
 * deliberately instead of silently mis-filing a vendor.
 */
export function toVendorCategory(raw: string | null | undefined): VendorCategory | null {
  const t = (raw ?? "").trim()
  if (!t) return null
  const exact = VENDOR_CATEGORIES.find((c) => c.toLowerCase() === t.toLowerCase())
  if (exact) return exact
  const flat = t.toLowerCase().replace(/[^a-z]/g, "")
  if (flat === "title" || flat === "titlecompany" || flat === "escrow") return VENDOR_CATEGORY_TITLE
  if (flat === "mortgage" || flat === "loanofficer") return VENDOR_CATEGORY_LENDER
  return null
}
