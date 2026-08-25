// lib/kernel/vendor-categories.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE vendors.category vocabulary.
//
// The live CHECK is the 39-value lowercase_snake taxonomy below, shared verbatim
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

/** Every value the CHECK admits — the SAME taxonomy vendor_directory used,
 *  since m304 widened the bench to match it. Ordered by how a brokerage
 *  thinks about them: the transaction trades first, then the home-service trades
 *  a lifetime client actually asks for, then the catch-all.
 *
 *  m554 added `appraiser` (39 values) on the owner ruling "an appraiser can be
 *  another vendor type and is state licensed". It sits with the transaction
 *  trades because that is when a brokerage meets one. NOTE: `appraiser` is the
 *  one value here that carries a rule of its own — CLAUDE.md §5, anything
 *  reaching a licensed appraiser must not be model-authored. That rule and the
 *  routes it governs live at lib/vendors/appraiser-independence.ts, which is the
 *  ONE place it is spelled; do not re-implement it beside a call site. */
export const VENDOR_CATEGORIES = [
  // transaction-side (several are RESPA settlement services — see lib/compliance/vendor-respa.ts)
  "lender", "refinance_lender", "title", "attorney", "inspector", "appraiser",
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
  attorney: "Attorney", inspector: "Inspector", appraiser: "Appraiser",
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
 * The same values, in the groups the ordering above already implies — so a
 * picker can render optgroups without restating the vocabulary. A category
 * belongs to exactly one group; the guard proves the groups partition
 * VENDOR_CATEGORIES exactly, which is what stops a value being added here and
 * silently never appearing in the UI (or appearing twice).
 */
export const VENDOR_CATEGORY_GROUPS: ReadonlyArray<{
  label: string
  categories: readonly VendorCategory[]
}> = [
  { label: "Transaction", categories: ["lender", "refinance_lender", "title", "attorney", "inspector", "appraiser"] },
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
/** The appraiser trade (m554). Named rather than spelled inline because it is the
 *  ONE category that gates behaviour rather than only labelling a row — see
 *  lib/vendors/appraiser-independence.ts (CLAUDE.md §5) and
 *  STATE_LICENSED_VENDOR_CATEGORIES in lib/vendors/vendor-service-area.ts. A
 *  hand-typed "appraiser" at a call site is a gate that silently stops matching
 *  the day the spelling moves. */
export const VENDOR_CATEGORY_APPRAISER: VendorCategory = "appraiser"
/** The catch-all, spelled as the CHECK does. The business-card scanner wrote the
 *  Title-Case "Other" — valid before m304, rejected after it — so every scanned
 *  card the classifier could not place failed its INSERT outright. Named here so
 *  a fallback cannot be spelled by hand. */
export const VENDOR_CATEGORY_OTHER: VendorCategory = "other"

/** PURE — is this exactly a value the column will accept? */
export function isVendorCategory(value: string | null | undefined): value is VendorCategory {
  return !!value && (VENDOR_CATEGORIES as readonly string[]).includes(value)
}

// ─────────────────────────────────────────────────────────────────────────────
// THE RETIRED SPELLINGS (m561 — "consolodate service types")
//
// A SECOND taxonomy called "service type" existed in three places and shared
// almost no spelling with the column it was filtered against. Measured live on
// project hrvaqgvukzxfskkcrwbt, 2026-08-25, against the 39-value
// vendors_category_check: of the ten values in the AI action's union, EIGHT
// matched NOTHING under the `category ILIKE '%serviceType%'` it was used with —
// photography, staging, inspection, appraisal, cleaning, repairs, moving and
// escrow all returned an empty bench, and only landscaping and title matched.
//
// Every key below is a spelling that ACTUALLY EXISTED in this repo, named with
// where it came from, so this map is a record of a merge and not a guess at what
// someone might type. §1.1: these were merged ONTO this survivor FIRST; the
// three duplicate lists were deleted afterwards, each leaving a tombstone naming
// this file.
//
// Keys are FLATTENED (lowercased, non-alphanumerics removed), so "Title
// Company", "title_company" and "titlecompany" are one key.
//
// NOT A PLACE FOR NEW TRADES. A spelling here resolves to an EXISTING member of
// VENDOR_CATEGORIES. A genuinely new trade widens the live CHECK (the way m554
// added `appraiser`) and is added to VENDOR_CATEGORIES above — never smuggled in
// as a synonym of something it is not.
// ─────────────────────────────────────────────────────────────────────────────
export const VENDOR_CATEGORY_SYNONYMS: Readonly<Record<string, VendorCategory>> = {
  // ── from app/actions/ai-vendor-management.ts :: getVendorRecommendations,
  //    whose `serviceType` union was the noun-of-the-JOB where the column holds
  //    the noun-of-the-PERSON. Eight of its ten values could never match.
  photography: "photographer",
  staging: "stager",
  inspection: "inspector",
  appraisal: "appraiser",
  cleaning: "cleaner",
  repairs: "contractor",
  moving: "mover",

  // ── from app/components/dashboard/listings/lifecycle/vendor-booking-button.tsx,
  //    which offered the SAME ten in Title Case ("Photography", "Staging", …).
  //    Flattening makes those the keys above; only 'Other' and 'Landscaping' and
  //    'Title' ever resolved, and they resolve by exact match, not from here.

  // ── from app/actions/vendor-marketplace.ts :: getSuggestedVendorsByStage,
  //    whose stage→service map carried a third set of spellings.
  homeinspector: "inspector",
  financing: "lender",

  // ── pre-existing, kept verbatim: legacy Title-Case and the one-word short
  //    form. ('title' itself is NOT a key — it is a real member and resolves by
  //    exact match above, before this table is consulted.)
  titlecompany: "title",
  mortgage: "lender",
  loanofficer: "lender",

  // ── ESCROW. RETIRED AS A SPELLING OF `title`, NOT ADDED TO THE VOCABULARY.
  //
  // It was in the AI union, in both booking pickers, and in NO CHECK — the one
  // value of the ten with no possible member. Unlike `appraiser` (m554), which
  // named a distinct state-licensed profession with no home in the taxonomy,
  // `escrow` already had a home here and the live schema says so:
  //
  //   · the deal-side table is public.transaction_title_escrow — ONE row holding
  //     title_officer_* AND escrow_officer_* for the same counterparty. The
  //     database already models escrow as a ROLE AT the title company.
  //   · public.deposits.escrow_company is free text, not a vendors FK — no bench
  //     row was ever meant to be the escrow holder.
  //   · lib/compliance/vendor-respa.ts:39 already folds "escrow" and
  //     "escrowofficer" into the TITLE settlement-service bucket.
  //   · vendor_assignments.assignment_type (the ten-value deal-ledger subset)
  //     carries `title` and has never carried `escrow`.
  //
  // Four independent writers already treat them as one thing, so widening the
  // CHECK would have created the §6 defect rather than closing it.
  escrow: "title",
}

/**
 * PURE — map a loose spelling onto the CHECK value, or null if there is no
 * confident match.
 *
 * Order is exact-first: a value the column already admits is returned unchanged
 * and never routed through the synonym table, so adding a synonym can never
 * shadow a real member.
 *
 * Returns null rather than guessing, so a caller can fall back to 'Other'
 * deliberately — or REFUSE — instead of silently mis-filing a vendor or running
 * a query that cannot match. `surveyor` is the live example: it sat in one
 * booking picker, is not a member, and is NOT mapped here, because a land
 * surveyor is not any of the other 39 and inventing a fold would file it under a
 * trade it is not. It resolves to null and the caller says so. UNRESOLVED —
 * whether to widen the CHECK for it is an owner call, not this function's.
 */
export function toVendorCategory(raw: string | null | undefined): VendorCategory | null {
  const t = (raw ?? "").trim()
  if (!t) return null
  const exact = VENDOR_CATEGORIES.find((c) => c.toLowerCase() === t.toLowerCase())
  if (exact) return exact
  const flat = t.toLowerCase().replace(/[^a-z0-9]/g, "")
  const synonym = VENDOR_CATEGORY_SYNONYMS[flat]
  if (synonym) return synonym
  const snake = t.toLowerCase().trim().replace(/[\s-]+/g, "_")
  if ((VENDOR_CATEGORIES as readonly string[]).includes(snake)) return snake as VendorCategory
  return null
}

/**
 * PURE — the ONE way to turn a caller-supplied "service type" into a bench
 * filter, with the refusal spelled out.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT `.ilike('%x%')`. Every bench read in the app
 * used `category ILIKE '%serviceType%'`. Two things are wrong with a LIKE over a
 * CLOSED vocabulary, and BOTH were live, not hypothetical:
 *
 *   · IT MISSES. Eight of the ten AI service types matched no member at all (see
 *     VENDOR_CATEGORY_SYNONYMS above) — the substring was never a substring.
 *   · IT OVER-MATCHES. `%lender%` matches `lender` AND `refinance_lender`, so a
 *     search for a purchase lender silently returned refinance lenders too, and
 *     the two are separate members of the vocabulary on purpose. Verified live
 *     against the 39-value CHECK. `%title%` is one `title_agent` away from the
 *     same bug, and `%pool%` from colliding with a future `pool` trade.
 *
 * Exact equality on a normalized value has neither failure mode. A caller that
 * gets `{ ok: false }` must REFUSE — it must not fall back to a LIKE, and it
 * must not spend a model call on the empty bench that a LIKE would have handed
 * it (CLAUDE.md §5).
 */
export function benchCategoryFilter(
  serviceType: string | null | undefined,
):
  | { ok: true; category: VendorCategory }
  | { ok: false; error: string } {
  const raw = (serviceType ?? "").trim()
  if (!raw) return { ok: false, error: "No service type was given." }
  const category = toVendorCategory(raw)
  if (!category) {
    return {
      ok: false,
      error: `"${raw}" is not a vendor trade this platform books. Choose one of: ${VENDOR_CATEGORIES.join(", ")}.`,
    }
  }
  return { ok: true, category }
}
