/**
 * Canonical shape for every scraped record before it enters the pipeline.
 * Sources: Zillow, Realtor, Craigslist, BatchData, Nextdoor, Facebook, Reddit.
 *
 * isViableRecord  → allowed to exist as a raw_scraped_leads row (WIRED — the
 *                   sourcers and the ingest cron filter on it)
 * hasPromotionEligibleIdentity → SAME PREDICATE, byte for byte. The distinction
 *                   this header used to assert does not exist in the code, and
 *                   the real promotion gate lives in
 *                   lib/lead-pipeline/canonical-lead-eligibility.ts. See the
 *                   note on the function itself before wiring it anywhere.
 */
export interface NormalizedScrapedRecord {
  /** Stable dedup key unique within the source (not a DB uuid). */
  sourceRecordId: string
  /** e.g. 'zillow', 'realtor', 'craigslist_fsbo', 'batchdata_motivated' */
  source: string
  /** e.g. 'property_view', 'fsbo_listing', 'motivated_seller', 'social_intent' */
  behaviorType: string
  intentType: 'buyer' | 'seller' | 'unknown'
  /** Free-form signals driving the intent classification. */
  intentSignals: string[]

  // Identity fields — at least one combination must be present for viability.
  firstName?: string | null
  lastName?: string | null
  fullName?: string | null
  username?: string | null
  email?: string | null
  phone?: string | null

  // Geography
  city?: string | null
  state?: string | null
  zip?: string | null

  // Property context
  propertyAddress?: string | null
  mailingAddress?: string | null

  // Scoring
  motivationScore?: number | null
  sourceUrl?: string | null

  /** Rich intent classification (when the source produced enough text to score). Optional so
   *  every scraper need not populate it; downstream code reads `intent?.winner` defensively. */
  intent?: {
    winner: "buyer" | "seller" | "investor" | "agent" | "generic"
    persona:
      | "first_time_buyer" | "move_up_buyer" | "downsizer"
      | "fsbo_seller" | "motivated_seller" | "expired_listing"
      | "investor_flipper" | "investor_buy_hold" | "investor_1031"
      | "agent_recruit"
      | null
    scores: { buyer: number; seller: number; investor: number; agent: number; generic: number }
    matched: string[]
    /** True when the source page advertises a saved-search / property-alert profile (buyer side). */
    buyerAlertProfile?: boolean
    /** Property addresses + prices the normalizer pulled from text/highlights/summary. */
    propertyAddresses?: string[]
    prices?: number[]
  }

  /** Original payload from the provider — preserved verbatim for audit. */
  rawPayload: Record<string, unknown>
}

/**
 * Gate 1 — record is allowed to exist as a raw_scraped_leads row.
 * Requires at minimum one identity signal or a property address.
 */
export function isViableRecord(r: NormalizedScrapedRecord): boolean {
  return !!(
    r.email ||
    r.phone ||
    r.username ||
    (r.fullName && (r.city || r.state)) ||
    (r.firstName && r.lastName && (r.city || r.state)) ||
    r.propertyAddress
  )
}

/**
 * Gate 2 — record may be promoted to a leads row.
 *
 * ── READ THIS BEFORE GIVING IT A PRODUCTION CALLER (2026-09-03, lane L2) ─────
 * IT IS NOT A SECOND GATE. Its body is BYTE-IDENTICAL to `isViableRecord`
 * immediately above — same six clauses, same order — so the "semantically
 * distinct" the previous comment claimed was a claim, not a difference: a record
 * this admits is exactly a record that one admits. Wiring it into a promotion
 * path would add a check that cannot ever refuse anything the ingest gate
 * already let through.
 *
 * THE PROMOTION GATE IT DESCRIBES ALREADY EXISTS SOMEWHERE ELSE, and it is
 * stricter by owner ruling: lib/lead-pipeline/canonical-lead-eligibility.ts is
 * the "SINGLE source of truth for the raw record → lead CONVERSION GATE" (first
 * name AND last name, plus one of email / phone / VERIFIED mailing address), and
 * BOTH promotion paths — lib/lead-pipeline/pipeline-processor.ts and
 * lib/lead-promotion/eligibility-evaluator.ts — already delegate to it. That is
 * the survivor for this function's stated job.
 *
 * SO WHY IS IT STILL HERE. Deleting it is blocked, not declined: it is imported
 * by scripts/scraper-simulator.ts:32,262,270, which is inside the owner's
 * SCRAPING FENCE and may not be edited by this lane, and by
 * scripts/lead-flow-e2e.ts:28,262. The delete has to move together with those
 * two proofs. Until then this comment is the record, so the next reader does not
 * re-derive the duplication or, worse, wire the weaker gate believing it adds
 * something.
 */
export function hasPromotionEligibleIdentity(r: NormalizedScrapedRecord): boolean {
  return !!(
    r.email ||
    r.phone ||
    r.username ||
    (r.fullName && (r.city || r.state)) ||
    (r.firstName && r.lastName && (r.city || r.state)) ||
    r.propertyAddress
  )
}

/**
 * Returns a stable string key for deduplication.
 * Priority: email > phone > username+source > name+location.
 * Returns null when no usable identity exists.
 */
export function buildLeadIdentityKey(r: NormalizedScrapedRecord): string | null {
  if (r.email) return `email:${r.email.trim().toLowerCase()}`

  const p = r.phone?.replace(/\D/g, '').slice(-10)
  if (p?.length === 10) return `phone:${p}`

  if (r.username && r.sourceUrl) {
    return `user:${r.username.toLowerCase()}|src:${r.sourceUrl}`
  }

  const name = [r.firstName, r.lastName].filter(Boolean).join(' ').toLowerCase()
  if (name && (r.city || r.state)) {
    return `name:${name}|${r.city?.toLowerCase() ?? ''}|${r.state?.toLowerCase() ?? ''}`
  }

  return null
}
