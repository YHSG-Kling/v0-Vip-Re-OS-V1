/**
 * lib/marketing/vendor-ranking.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure ranking core for the listing-marketing vendor bench. Extracted from the
 * server action app/actions/marketing-package-automation.ts (which is "use
 * server" and therefore cannot export a synchronous function) so the auto-pick
 * can be unit-tested without a database — the same split lib/marketing/
 * package-catalog.ts already uses for the package catalog.
 *
 * WHAT THE VENDOR BENCH ACTUALLY CARRIES
 * Verified against information_schema.columns for public.vendors: id, name,
 * category, email, phone, website, rating, notes, created_at, updated_at,
 * brokerage_id, estimated_turnaround_days, access_level, status,
 * ai_verification_score, verification_flags, verified_at, verified_by,
 * compliance_credentials, access_expires_at, invited_by_user_id,
 * invited_by_team_id, preferred, display_priority, visible_in_portal,
 * audience_tags, stage_tags, team_id.
 *
 * There is NO price column, NO location/service-area column and NO
 * response-latency column on that table, and no other table in the schema
 * carries those three facts for a bench vendor. They are therefore NOT scored —
 * see UNMEASURED_RANKING_INPUTS. A ranking input with no source is left out and
 * declared, never approximated: an invented input would make the ordering look
 * informed while being arbitrary.
 */

/** The live CHECK domain of vendors.category (verified against pg_constraint). */
export const VENDOR_CATEGORIES = [
  "inspector", "lender", "title", "attorney", "contractor", "stager",
  "photographer", "cleaner", "mover", "insurance", "handyman",
  "property_management", "landscaping", "pest_control", "pool_service", "hvac",
  "plumber", "electrician", "roofer", "painter", "flooring", "solar",
  "security", "smart_home", "appliance_repair", "window_treatment",
  "garage_door", "refinance_lender", "home_warranty", "tax_pro",
  "financial_advisor", "interior_design", "organizer", "estate_sale",
  "videographer", "drone_pilot", "3d_tour", "other",
] as const

export type VendorCategory = (typeof VENDOR_CATEGORIES)[number]

export function isVendorCategory(v: string | null | undefined): v is VendorCategory {
  return !!v && (VENDOR_CATEGORIES as readonly string[]).includes(v)
}

/**
 * Marketing service type (lib/marketing/package-catalog.ts vocabulary) → the
 * bench category that fulfils it.
 *
 * The two vocabularies are disjoint: no package service type is spelled the way
 * a category is, so filtering the bench by the raw service type matches nothing
 * and the auto-pick can never return a vendor. This map is the join.
 *
 * A service with no entry is fulfilled in-house (syndication, copy, ad buys,
 * email) and has no bench category at all — vendorCategoryForService returns
 * null so the caller can say so instead of running a query that cannot match.
 */
export const MARKETING_SERVICE_VENDOR_CATEGORY: Readonly<Record<string, VendorCategory>> = {
  professional_photos: "photographer",
  twilight_photos: "photographer",
  virtual_tour: "3d_tour",
  "3d_matterport": "3d_tour",
  drone_photos: "drone_pilot",
  drone_video: "drone_pilot",
  video_walkthrough: "videographer",
  cinematic_video: "videographer",
  virtual_staging: "stager",
}

/** PURE — the bench category that fulfils a package service, or null when none does. */
export function vendorCategoryForService(serviceType: string | null | undefined): VendorCategory | null {
  const t = (serviceType ?? "").trim().toLowerCase()
  if (!t) return null
  return MARKETING_SERVICE_VENDOR_CATEGORY[t] ?? null
}

/** The columns of a bench row this ranking reads. Every one is live. */
export interface RankableVendor {
  id: string
  name: string | null
  rating: number | null
  preferred: boolean | null
  display_priority: number | null
  estimated_turnaround_days: number | null
}

/**
 * Ranking inputs that CANNOT be measured from the schema as it stands. Published
 * alongside every score so a caller (or a UI) can state what the ordering did
 * not account for rather than implying it accounted for everything.
 */
export const UNMEASURED_RANKING_INPUTS = [
  "unit_price",        // no price column on the bench, and no vendor price list
  "proximity",         // no location / service-area column on the bench
  "response_latency",  // no reply-time column; turnaround days is job length, not reply speed
  "completion_rate",   // no per-vendor completion aggregate wired to this bench
] as const

export type UnmeasuredRankingInput = (typeof UNMEASURED_RANKING_INPUTS)[number]

export interface VendorScore {
  /** Composite score. Higher wins. Range is unbounded by design — only the ORDER is meaningful. */
  score: number
  /** Inputs that had a real value on this row and moved the score. */
  measured: string[]
  /** Inputs the score could not account for: the permanently-unmeasurable set plus this row's nulls. */
  unmeasured: string[]
}

export type ScoredVendor = RankableVendor & VendorScore

/** Broker curation: display_priority contributes at most this much, so curation
 *  nudges the order without overwhelming a genuinely better-rated vendor. */
export const MAX_PRIORITY_BONUS = 10

/**
 * PURE — score one bench row from live columns only.
 *
 *   rating (0-5)              × 20  → 0-100, the spine of the score
 *   preferred = true          + 20  broker put this vendor on the preferred bench
 *   display_priority (0..10)  + n   the broker's own ordering, clamped
 *   estimated_turnaround_days       +15 ≤2d, +8 ≤5d, 0 for 6-10d, -10 beyond 10d
 *
 * A null column contributes nothing and is reported as unmeasured — it never
 * silently defaults to a flattering (or punishing) number.
 *
 * NOT EXPORTED, deliberately. Every field it produces — score, measured,
 * unmeasured — is spread onto each row by rankVendors below, so a caller
 * holding a ScoredVendor already has this function's whole output. Exporting it
 * as well would put an entry point in the module that nothing outside needs, and
 * "no caller" is what an unfinished feature looks like from the outside. The
 * scoring rules are still proved directly — scripts/phantom-embed-simulator.ts
 * exercises them through rankVendors([one vendor])[0], which observes exactly
 * the same three fields. The capability is intact; only the surplus door is shut.
 */
function scoreVendor(vendor: RankableVendor): VendorScore {
  const measured: string[] = []
  const unmeasured: string[] = [...UNMEASURED_RANKING_INPUTS]
  let score = 0

  if (typeof vendor.rating === "number") {
    score += vendor.rating * 20
    measured.push("rating")
  } else {
    unmeasured.push("rating")
  }

  if (vendor.preferred === true) {
    score += 20
    measured.push("preferred")
  } else if (vendor.preferred === false) {
    measured.push("preferred")
  } else {
    unmeasured.push("preferred")
  }

  if (typeof vendor.display_priority === "number") {
    score += Math.min(Math.max(vendor.display_priority, 0), MAX_PRIORITY_BONUS)
    measured.push("display_priority")
  } else {
    unmeasured.push("display_priority")
  }

  const days = vendor.estimated_turnaround_days
  if (typeof days === "number") {
    if (days <= 2) score += 15
    else if (days <= 5) score += 8
    else if (days > 10) score -= 10
    measured.push("estimated_turnaround_days")
  } else {
    unmeasured.push("estimated_turnaround_days")
  }

  return { score, measured, unmeasured }
}

/**
 * PURE — rank a bench, best first. Ordering is TOTAL and independent of the row
 * order the database happened to return: score desc, then rating desc, then name
 * asc, then id asc. Two rows can only tie when every ranked column is equal.
 */
export function rankVendors(vendors: readonly RankableVendor[]): ScoredVendor[] {
  return vendors
    .map((v) => ({ ...v, ...scoreVendor(v) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const ar = a.rating ?? -1
      const br = b.rating ?? -1
      if (br !== ar) return br - ar
      const an = a.name ?? ""
      const bn = b.name ?? ""
      if (an !== bn) return an < bn ? -1 : 1
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
}

/** PURE — the best bench row, or null for an empty bench. */
export function pickBestVendor(vendors: readonly RankableVendor[]): ScoredVendor | null {
  return rankVendors(vendors)[0] ?? null
}
