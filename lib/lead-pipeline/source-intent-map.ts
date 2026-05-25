/**
 * source-intent-map.ts
 *
 * Source → business-process mapping + scoring for the Kernel OS lead pipeline.
 *
 * Defines the canonical semantics for each of the 11 scraping sources:
 *   intentType, behaviorType, leadType, motivationType, scoreRange,
 *   identityPolicy, promotionPolicy.
 *
 * Used by pipeline-processor.ts to:
 *   - Apply territory gate before enrichment spend
 *   - Score records via calculateSourceScore()
 *   - Set lead_type, motivation_type, urgency_level on promotion
 */

// ─── Types ─────────────────────────────────────────────────────────────────────

export type SourceKey =
  | 'batchdata_motivated'
  | 'zenrows_zillow'
  | 'zenrows_realtor'
  | 'zenrows_homes'
  | 'nextdoor_intent'
  | 'facebook_group'
  | 'facebook_marketplace'
  | 'reddit_intent'
  | 'craigslist_fsbo'
  | 'google_phrase_intent'
  | 'osint_signal'

export type IntentType = 'buyer' | 'seller' | 'unknown'

/**
 * Identity policy governs how much identity is needed before spending on enrichment
 * and whether a record can be promoted directly or must wait for an identity anchor.
 */
export type IdentityPolicy =
  | 'immediate'         // batchdata_motivated — property address alone suffices
  | 'property_required' // craigslist_fsbo — must have property address
  | 'enrichment_first'  // social sources — enrich then re-evaluate
  | 'analytics_only'    // google_phrase_intent — raw/analytics; identity resolved externally

export interface SourceDefinition {
  intentType: IntentType
  /** Maps to leads.lead_type */
  leadType: 'buyer' | 'seller' | 'unknown'
  /** Maps to leads.motivation_type */
  motivationType: string
  behaviorType: string
  /** [min, max] score range — scores outside this are clamped */
  scoreRange: [number, number]
  /** Baseline score before signal adjustments */
  baseScore: number
  /** Positive signal words that raise the score */
  boostSignals: string[]
  /** Negative signal words that lower the score */
  dampSignals: string[]
  identityPolicy: IdentityPolicy
  /** Whether the source can promote directly without enrichment if identity is sufficient */
  canPromoteBeforeEnrichment: boolean
}

// ─── SOURCE_MAP — 11 canonical sources ────────────────────────────────────────

export const SOURCE_MAP: Record<SourceKey, SourceDefinition> = {

  // ── BatchData motivated sellers ──────────────────────────────────────────────
  // Highest-quality structured data with verified property + owner identity.
  // Score range 55–95; promotion-eligible immediately when property address exists.
  batchdata_motivated: {
    intentType:                'seller',
    leadType:                  'seller',
    motivationType:            'motivated_seller',
    behaviorType:              'motivated_seller',
    scoreRange:                [55, 95],
    baseScore:                 70,
    boostSignals:              ['foreclosure', 'pre_foreclosure', 'divorce', 'bankruptcy', 'distressed', 'absentee', 'tax_lien', 'high_equity', 'vacant'],
    dampSignals:               ['low_confidence', 'incomplete'],
    identityPolicy:            'immediate',
    canPromoteBeforeEnrichment: true,
  },

  // ── Zillow behavioral signal ──────────────────────────────────────────────────
  // FSBO / by-owner listings scraped from Zillow (we filter to for-sale-by-owner,
  // not agent inventory — a by-owner listing is a SELLER lead, not a property).
  // The owner is resolved by skip-trace enrichment from the property address.
  zenrows_zillow: {
    intentType:                'seller',
    leadType:                  'seller',
    motivationType:            'fsbo_seller',
    behaviorType:              'fsbo_listing',
    scoreRange:                [35, 65],
    baseScore:                 50,
    boostSignals:              ['by_owner', 'fsbo', 'make_me_move', 'coming_soon', 'price_reduced', 'expired_listing'],
    dampSignals:               ['agent_listed', 'rental', 'no_owner_contact'],
    identityPolicy:            'enrichment_first',
    canPromoteBeforeEnrichment: false,
  },

  // ── Realtor.com FSBO / by-owner signal ───────────────────────────────────────
  zenrows_realtor: {
    intentType:                'seller',
    leadType:                  'seller',
    motivationType:            'fsbo_seller',
    behaviorType:              'fsbo_listing',
    scoreRange:                [35, 65],
    baseScore:                 48,
    boostSignals:              ['by_owner', 'fsbo', 'make_me_move', 'coming_soon', 'price_reduced'],
    dampSignals:               ['agent_listed', 'rental', 'no_owner_contact'],
    identityPolicy:            'enrichment_first',
    canPromoteBeforeEnrichment: false,
  },

  // ── Redfin / generic property portal — FSBO / by-owner only ──────────────────
  zenrows_homes: {
    intentType:                'seller',
    leadType:                  'seller',
    motivationType:            'fsbo_seller',
    behaviorType:              'fsbo_listing',
    scoreRange:                [35, 60],
    baseScore:                 45,
    boostSignals:              ['by_owner', 'fsbo', 'make_me_move', 'coming_soon'],
    dampSignals:               ['agent_listed', 'rental'],
    identityPolicy:            'enrichment_first',
    canPromoteBeforeEnrichment: false,
  },

  // ── Nextdoor neighborhood intent ──────────────────────────────────────────────
  // Posts mentioning buying/selling in a neighborhood.
  // Can be buyer or seller; identity is usually partial.
  nextdoor_intent: {
    intentType:                'unknown',
    leadType:                  'unknown',
    motivationType:            'neighborhood_intent',
    behaviorType:              'social_intent',
    scoreRange:                [35, 65],
    baseScore:                 50,
    boostSignals:              ['moving', 'selling', 'just_listed', 'looking_to_buy', 'relocating', 'downsizing'],
    dampSignals:               ['asking_question', 'no_intent'],
    identityPolicy:            'enrichment_first',
    canPromoteBeforeEnrichment: false,
  },

  // ── Facebook group post ───────────────────────────────────────────────────────
  // Often seller-side intent in real estate or neighborhood groups.
  facebook_group: {
    intentType:                'seller',
    leadType:                  'seller',
    motivationType:            'social_seller_intent',
    behaviorType:              'social_intent',
    scoreRange:                [30, 65],
    baseScore:                 45,
    boostSignals:              ['for_sale', 'selling', 'need_to_sell', 'motivated', 'moving_out', 'relocating', 'owner'],
    dampSignals:               ['just_asking', 'no_timeline', 'renting'],
    identityPolicy:            'enrichment_first',
    canPromoteBeforeEnrichment: false,
  },

  // ── Facebook Marketplace listing ─────────────────────────────────────────────
  // Structured listing with property details — higher quality than group posts.
  facebook_marketplace: {
    intentType:                'seller',
    leadType:                  'seller',
    motivationType:            'marketplace_listing',
    behaviorType:              'property_listing',
    scoreRange:                [40, 70],
    baseScore:                 55,
    boostSignals:              ['price_reduced', 'motivated', 'fsbo', 'owner', 'must_sell'],
    dampSignals:               ['agent_listing', 'rental'],
    identityPolicy:            'property_required',
    canPromoteBeforeEnrichment: false,
  },

  // ── Reddit intent signal ─────────────────────────────────────────────────────
  // Often anonymous buyer intent; lower scores reflect anonymous identity.
  reddit_intent: {
    intentType:                'buyer',
    leadType:                  'buyer',
    motivationType:            'buyer_research',
    behaviorType:              'social_intent',
    scoreRange:                [35, 55],
    baseScore:                 40,
    boostSignals:              ['pre_approved', 'looking_to_buy', 'first_time', 'moving_to', 'relocating', 'timeline'],
    dampSignals:               ['just_curious', 'hypothetical', 'no_timeline'],
    identityPolicy:            'enrichment_first',
    canPromoteBeforeEnrichment: false,
  },

  // ── Craigslist FSBO listing ───────────────────────────────────────────────────
  // Strong sell signal; property address often present.
  // Score range 70–90; promotion-eligible when property address is confirmed.
  craigslist_fsbo: {
    intentType:                'seller',
    leadType:                  'seller',
    motivationType:            'fsbo_seller',
    behaviorType:              'fsbo_listing',
    scoreRange:                [70, 90],
    baseScore:                 75,
    boostSignals:              ['motivated', 'price_reduced', 'must_sell', 'below_market', 'owner_occupied'],
    dampSignals:               ['agent_listed', 'rental', 'no_price'],
    identityPolicy:            'property_required',
    canPromoteBeforeEnrichment: true,
  },

  // ── Google phrase / search intent ────────────────────────────────────────────
  // Analytics or keyword-triggered signals; no direct identity.
  // Remain raw-only until identity is resolved via another channel.
  google_phrase_intent: {
    intentType:                'unknown',
    leadType:                  'unknown',
    motivationType:            'search_intent',
    behaviorType:              'search_signal',
    scoreRange:                [30, 55],
    baseScore:                 40,
    boostSignals:              ['sell_my_home', 'sell_house_fast', 'cash_offer', 'how_much_is_my_home_worth', 'homes_for_sale'],
    dampSignals:               ['general_research', 'low_intent'],
    identityPolicy:            'analytics_only',
    canPromoteBeforeEnrichment: false,
  },

  // ── OSINT / skip-trace signal ────────────────────────────────────────────────
  // Enrichment result that elevates an existing raw record.
  osint_signal: {
    intentType:                'unknown',
    leadType:                  'unknown',
    motivationType:            'osint_enrichment',
    behaviorType:              'osint_signal',
    scoreRange:                [45, 80],
    baseScore:                 60,
    boostSignals:              ['owner_occupied', 'high_equity', 'long_tenure', 'life_event', 'distressed'],
    dampSignals:               ['renter', 'low_confidence'],
    identityPolicy:            'enrichment_first',
    canPromoteBeforeEnrichment: false,
  },
}

// ─── Fallback for unknown sources ─────────────────────────────────────────────

const FALLBACK_DEFINITION: SourceDefinition = {
  intentType:                'unknown',
  leadType:                  'unknown',
  motivationType:            'unknown_source',
  behaviorType:              'unknown',
  scoreRange:                [30, 60],
  baseScore:                 40,
  boostSignals:              [],
  dampSignals:               [],
  identityPolicy:            'enrichment_first',
  canPromoteBeforeEnrichment: false,
}

// ─── calculateSourceScore ──────────────────────────────────────────────────────

/**
 * Returns a motivation score [0, 100] for a given source and its intent signals.
 *
 * Algorithm:
 *   1. Start at source baseScore
 *   2. +5 per matched boost signal (capped at +25)
 *   3. -5 per matched damp signal (capped at -20)
 *   4. Clamp to source scoreRange [min, max]
 */
export function calculateSourceScore(source: string, signals: string[]): number {
  const def = SOURCE_MAP[resolveSourceKey(source)] ?? FALLBACK_DEFINITION

  const normalizedSignals = signals.map(s => s.toLowerCase().replace(/[\s\-]/g, '_'))

  let boost = 0
  for (const sig of def.boostSignals) {
    if (normalizedSignals.some(s => s.includes(sig.replace(/[\s\-]/g, '_')))) {
      boost = Math.min(boost + 5, 25)
    }
  }

  let damp = 0
  for (const sig of def.dampSignals) {
    if (normalizedSignals.some(s => s.includes(sig.replace(/[\s\-]/g, '_')))) {
      damp = Math.min(damp + 5, 20)
    }
  }

  const raw = def.baseScore + boost - damp
  return Math.min(def.scoreRange[1], Math.max(def.scoreRange[0], raw))
}

/**
 * Returns the full SourceDefinition for a given source key.
 * Falls back to the default definition for unrecognised sources.
 */
export function getSourceSemantics(source: string): SourceDefinition {
  return SOURCE_MAP[resolveSourceKey(source)] ?? FALLBACK_DEFINITION
}

/**
 * Maps the `source` values emitted by the scrapers/parsers to the canonical
 * SOURCE_MAP keys. Without this, parser sources like "zillow"/"realtor"/"redfin"/
 * "nextdoor" silently fell through to the unknown fallback (wrong intent + score).
 * Already-canonical keys pass through unchanged.
 */
const SOURCE_ALIASES: Record<string, SourceKey> = {
  zillow: "zenrows_zillow",
  realtor: "zenrows_realtor",
  "realtor.com": "zenrows_realtor",
  redfin: "zenrows_homes",
  homes: "zenrows_homes",
  homes_com: "zenrows_homes",
  nextdoor: "nextdoor_intent",
  facebook: "facebook_group",
  facebook_marketplace: "facebook_marketplace",
  reddit: "reddit_intent",
  craigslist: "craigslist_fsbo",
  google: "google_phrase_intent",
  osint: "osint_signal",
}

export function resolveSourceKey(source: string): SourceKey {
  const key = source as SourceKey
  if (key in SOURCE_MAP) return key
  return SOURCE_ALIASES[source.toLowerCase()] ?? (source as SourceKey)
}

/**
 * Derives urgency_level from a numeric motivation score.
 * Maps directly to the leads.urgency_level column values.
 */
export function scoreToUrgencyLevel(score: number): 'high' | 'medium' | 'low' {
  if (score >= 70) return 'high'
  if (score >= 45) return 'medium'
  return 'low'
}

// ─── buildTerritoryPhrases ─────────────────────────────────────────────────────

export interface TerritoryPhrases {
  buyerPhrases:  string[]
  sellerPhrases: string[]
}

/**
 * Builds intent-matching search phrases for a territory.
 * Used by the lead-scraping cron to build keyword queries for social sources.
 *
 * Accepts any object with optional city, state, zip_codes, and counties fields
 * so it works with both live market records and partial test fixtures.
 */
export function buildTerritoryPhrases(market: {
  city?:      string | null
  state?:     string | null
  zip_codes?: string[] | null
  counties?:  string[] | null
}): TerritoryPhrases {
  const city    = market.city?.trim()    ?? ''
  const state   = market.state?.trim()   ?? ''
  const zips    = market.zip_codes       ?? []
  const counties = market.counties       ?? []

  // Build a location token list: city, state abbrev, zip codes, county names
  const locationTokens: string[] = [
    city,
    state,
    ...zips,
    ...counties.map(c => c.replace(/\s+county$/i, '').trim()),
  ].filter(Boolean)

  const buyerPhrases: string[] = []
  const sellerPhrases: string[] = []

  for (const loc of locationTokens) {
    buyerPhrases.push(
      `looking to buy in ${loc}`,
      `homes for sale ${loc}`,
      `moving to ${loc}`,
      `relocating to ${loc}`,
      `first time buyer ${loc}`,
      `pre approved ${loc}`,
    )
    sellerPhrases.push(
      `selling home in ${loc}`,
      `sell my house ${loc}`,
      `for sale by owner ${loc}`,
      `fsbo ${loc}`,
      `need to sell ${loc}`,
      `motivated seller ${loc}`,
      `cash offer ${loc}`,
    )
  }

  return { buyerPhrases, sellerPhrases }
}

// ─── Territory match helper ────────────────────────────────────────────────────

/**
 * Returns true when a scraped record's geography matches the market territory.
 *
 * Match criteria (any one suffices):
 *   1. City + state match (case-insensitive)
 *   2. Zip code is in market.zip_codes
 *   3. No geographic data on the record — pass through, cannot verify
 *
 * A mismatch requires BOTH city/state to be present AND mismatched,
 * or a zip that is definitively outside the market's zip list.
 */
export function recordMatchesTerritory(
  recordGeo: { city?: string | null; state?: string | null; zip?: string | null },
  market:    { city?: string | null; state?: string | null; zip_codes?: string[] | null },
): boolean {
  const hasCity  = !!recordGeo.city?.trim()
  const hasState = !!recordGeo.state?.trim()
  const hasZip   = !!recordGeo.zip?.trim()

  // No geographic data — cannot reject; pass through
  if (!hasCity && !hasState && !hasZip) return true

  // Zip match
  if (hasZip && market.zip_codes?.length) {
    const normalZip = recordGeo.zip!.trim()
    return market.zip_codes.some(z => z.trim() === normalZip)
  }

  // City + state match
  if (hasCity && hasState) {
    const cityMatch  = recordGeo.city!.trim().toLowerCase() === market.city?.trim().toLowerCase()
    const stateMatch = recordGeo.state!.trim().toLowerCase() === market.state?.trim().toLowerCase()
    return cityMatch && stateMatch
  }

  // Partial geography — state-only or city-only: pass through
  return true
}
