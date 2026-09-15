/**
 * Canonical shape for every scraped record before it enters the pipeline.
 * Sources: Zillow, Realtor, Craigslist, BatchData, Nextdoor, Facebook, Reddit.
 *
 * isViableRecord  → allowed to exist as a raw_scraped_leads row (WIRED — the
 *                   sourcers and the ingest cron filter on it)
 * hasPromotionEligibleIdentity → MERGED ONTO isViableRecord (orphan doctrine
 *                   §1.1, wave 65A) — see the tombstone where it used to be
 *                   defined, below. It was the SAME PREDICATE, byte for byte;
 *                   the real promotion gate lives in
 *                   lib/lead-pipeline/canonical-lead-eligibility.ts.
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

// ── MERGED ONTO SURVIVOR (orphan doctrine §1.1, wave 65A) ────────────────────
// `hasPromotionEligibleIdentity` used to live here, BYTE-IDENTICAL to
// `isViableRecord` (lib/lead-pipeline/raw-record-types.ts:72) — same six
// clauses, same order. The real, stricter promotion gate it claimed to be was
// (and remains) lib/lead-pipeline/canonical-lead-eligibility.ts — the "SINGLE
// source of truth for the raw record → lead CONVERSION GATE" (first name AND
// last name, plus one of email / phone / VERIFIED mailing address) — which
// both live promotion paths (lib/lead-pipeline/pipeline-processor.ts and
// lib/lead-promotion/eligibility-evaluator.ts) already delegate to. This
// duplicate function added nothing a caller could not get from isViableRecord
// directly, and its own header said so (wave "2026-09-03, lane L2"). Its only
// two callers — scripts/scraper-simulator.ts:32,262,270 and
// scripts/lead-flow-e2e.ts:28,262, both outside the scraping fence for THIS
// lane's edit list — are repointed to isViableRecord (lib/lead-pipeline/raw-
// record-types.ts:72) in this same pass. No capability is lost: isViableRecord
// IS the predicate this function computed, unchanged.

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
