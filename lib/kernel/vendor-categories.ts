// lib/kernel/vendor-categories.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE vendors.category vocabulary.
//
// The live CHECK is the 38-value lowercase_snake taxonomy below, shared verbatim
// with vendor_directory.category since m304. Before m304 it was SIX Title-Case
// values ('Contractor','Inspector','Lender','Other','Stager','Title Company') —
// and because `vendors` is the FK target of vendor_bookings, a trade the bench
// could not spell was a trade the platform could not book. The marketplace was
// capped at six trades by a CHECK nobody had revisited.
//
// ── WHY THE SPELLING MATTERS (the bug this module was created for) ──
// The old vocabulary was Title Case, and 'Title Company' was two words. Three
// partner-facing surfaces asked for it in lowercase:
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

/** Every value the CHECK admits — the SAME 38-value taxonomy vendor_directory
 *  uses, since m304 widened the bench to match it. Ordered by how a brokerage
 *  thinks about them: the transaction trades first, then the home-service trades
 *  a lifetime client actually asks for, then the catch-all. */
export const VENDOR_CATEGORIES = [
  // transaction-side (several are RESPA settlement services — see lib/compliance/vendor-respa.ts)
  "lender", "refinance_lender", "title", "attorney", "inspector",
  // listing prep + marketing
  "stager", "photographer", "videographer", "drone_pilot", "3d_tour", "interior_design",
  // move + turnover
  "mover", "cleaner", "organizer", "estate_sale",
  // trades + home services (the long tail a lifetime client keeps coming back for)
  "contractor", "handyman", "landscaping", "pest_control", "pool_service", "hvac",
  "plumber", "electrician", "roofer", "painter", "flooring", "solar", "security",
  "smart_home", "appliance_repair", "window_treatment", "garage_door",
  // ownership + advisory
  "property_management", "home_warranty", "insurance", "tax_pro", "financial_advisor",
  // catch-all
  "other",
] as const

export type VendorCategory = (typeof VENDOR_CATEGORIES)[number]

/** Display labels — beside the vocabulary so a category cannot be added without
 *  one, or labelled without existing. */
export const VENDOR_CATEGORY_LABELS: Record<VendorCategory, string> = {
  lender: "Lender", refinance_lender: "Refinance Lender", title: "Title Company",
  attorney: "Attorney", inspector: "Inspector",
  stager: "Stager", photographer: "Photographer", videographer: "Videographer",
  drone_pilot: "Drone Pilot", "3d_tour": "3D Tour", interior_design: "Interior Design",
  mover: "Mover", cleaner: "Cleaner", organizer: "Organizer", estate_sale: "Estate Sale",
  contractor: "Contractor", handyman: "Handyman", landscaping: "Landscaping",
  pest_control: "Pest Control", pool_service: "Pool Service", hvac: "HVAC",
  plumber: "Plumber", electrician: "Electrician", roofer: "Roofer", painter: "Painter",
  flooring: "Flooring", solar: "Solar", security: "Security", smart_home: "Smart Home",
  appliance_repair: "Appliance Repair", window_treatment: "Window Treatment",
  garage_door: "Garage Door",
  property_management: "Property Management", home_warranty: "Home Warranty",
  insurance: "Insurance", tax_pro: "Tax Professional", financial_advisor: "Financial Advisor",
  other: "Other",
}

/**
 * The same 38 values, in the groups the ordering above already implies — so a
 * picker can render optgroups without restating the vocabulary. A category
 * belongs to exactly one group; the guard proves the groups partition
 * VENDOR_CATEGORIES exactly, which is what stops a value being added here and
 * silently never appearing in the UI (or appearing twice).
 */
export const VENDOR_CATEGORY_GROUPS: ReadonlyArray<{
  label: string
  categories: readonly VendorCategory[]
}> = [
  { label: "Transaction", categories: ["lender", "refinance_lender", "title", "attorney", "inspector"] },
  { label: "Listing prep & marketing", categories: ["stager", "photographer", "videographer", "drone_pilot", "3d_tour", "interior_design"] },
  { label: "Move & turnover", categories: ["mover", "cleaner", "organizer", "estate_sale"] },
  { label: "Trades & home services", categories: ["contractor", "handyman", "landscaping", "pest_control", "pool_service", "hvac", "plumber", "electrician", "roofer", "painter", "flooring", "solar", "security", "smart_home", "appliance_repair", "window_treatment", "garage_door"] },
  { label: "Ownership & advisory", categories: ["property_management", "home_warranty", "insurance", "tax_pro", "financial_advisor"] },
  { label: "Other", categories: ["other"] },
]

/**
 * The categories a pipeline STAGE can demand. Deliberately the transaction-side
 * trades only: a deal forecasts a lender, an inspector, a title company, a
 * contractor or a stager. It never forecasts a need for a pool service — that is
 * a lifetime-client request, not a closing dependency — and it never forecasts
 * "other".
 */
export const BENCH_VENDOR_CATEGORIES = [
  "lender",
  "inspector",
  "title",
  "contractor",
  "stager",
] as const

export type BenchVendorCategory = (typeof BENCH_VENDOR_CATEGORIES)[number]

/** The two categories with dedicated partner surfaces, spelled as the CHECK does.
 *  These moved from "Lender"/"Title Company" to lowercase in m304 — every panel
 *  reads them rather than a literal, which is why that move was a one-line
 *  change instead of a hunt. */
export const VENDOR_CATEGORY_LENDER: VendorCategory = "lender"
export const VENDOR_CATEGORY_TITLE: VendorCategory = "title"
/** Inspector had the same problem: three modules hardcoded "Inspector" in an
 *  .eq("category", …) filter, which TypeScript cannot check because the argument
 *  is a plain string. Named here so they read the vocabulary instead. */
export const VENDOR_CATEGORY_INSPECTOR: VendorCategory = "inspector"
/** The catch-all, spelled as the CHECK does. The business-card scanner wrote the
 *  Title-Case "Other" — valid before m304, rejected after it — so every scanned
 *  card the classifier could not place failed its INSERT outright. Named here so
 *  a fallback cannot be spelled by hand. */
export const VENDOR_CATEGORY_OTHER: VendorCategory = "other"

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
  // Legacy Title-Case spellings and common synonyms → the canonical token.
  const flat = t.toLowerCase().replace(/[^a-z0-9]/g, "")
  if (flat === "title" || flat === "titlecompany" || flat === "escrow") return VENDOR_CATEGORY_TITLE
  if (flat === "mortgage" || flat === "loanofficer") return VENDOR_CATEGORY_LENDER
  const snake = t.toLowerCase().trim().replace(/[\s-]+/g, "_")
  if ((VENDOR_CATEGORIES as readonly string[]).includes(snake)) return snake as VendorCategory
  return null
}
