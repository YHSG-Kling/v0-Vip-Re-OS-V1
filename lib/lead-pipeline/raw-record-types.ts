/**
 * Canonical shape for every scraped record before it enters the pipeline.
 * Sources: Zillow, Realtor, Craigslist, BatchData, Nextdoor, Facebook, Reddit.
 *
 * isViableRecord  → allowed to exist as a raw_scraped_leads row
 * hasPromotionEligibleIdentity → required before promotion to a leads row
 *
 * This distinction matters: some raw records are useful for enrichment or
 * pattern analysis but only promotion-eligible records may become leads.
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
 * Same criteria as isViableRecord but semantically distinct: only records that
 * pass this gate should drive lead creation or CRM contact upsert.
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
