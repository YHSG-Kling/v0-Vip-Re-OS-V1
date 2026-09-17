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
  | 'instagram_intent'
  | 'craigslist_fsbo'
  | 'google_phrase_intent'
  | 'rental_listing'
  | 'expired_listing'
  | 'linkedin_relocation'
  | 'exa_buyer_intent'
  | 'tavily_intent'
  | 'osint_signal'
  // ── Wave 65 lanes (owner ruling 2026-09-15) — DISTINCT from the sources above; never merge ──
  | 'realty_site_chatter'         // Zillow/Realtor/Homes.com saved-search + "contact agent" chatter (ZenRows/Zyte)
  | 'reddit_relocation'           // Reddit "moving to <city>" / "looking for a realtor in <city>"
  | 'facebook_recommend_realtor'  // Facebook-group "recommend a realtor" threads
  | 'agent_seeking_phrase_intent' // "looking for a real estate agent/realtor" phrase intent, cross-source
  // ── Wave 66 lanes (owner ruling 2026-09-15/16) — DISTINCT from every source above; never merge ──
  | 'batchdata_smart_search'      // BatchData V2 Property Subscription push (webhook) — DISTINCT from the polled batchdata_motivated sweep
  | 'batchdata_buybox'            // BatchData Buy Box investor-criteria match per listing — a BUYER-side signal
  | 'external_behavior'           // lead-intelligence's off-site property-view discovery lane (app/actions/lead-intelligence.ts::scrapeExternalBehavior)
  // ── Wave 70 lane (owner ruling 2026-09-17 — coverage audit) — DISTINCT from every source above ──
  | 'site_visitor_intent'         // ON-SITE behavioral acquisition: unidentified, high-dwell tenant-website visitors (own first-party data, $0 marginal cost)

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
  // Real-estate sites yield BOTH online behaviors: FSBO/by-owner listings
  // (SELLER) and saved-search / favorited / watching activity (BUYER). Intent is
  // set per record by the parser (parsePropertySearchResults vs
  // parseBuyerSavedSearches); the owner/buyer is resolved by enrichment.
  zenrows_zillow: {
    intentType:                'unknown',
    leadType:                  'unknown',
    motivationType:            'real_estate_site_intent',
    behaviorType:              'fsbo_listing',
    scoreRange:                [35, 65],
    baseScore:                 50,
    boostSignals:              ['by_owner', 'fsbo', 'make_me_move', 'coming_soon', 'price_reduced', 'expired_listing', 'saved_search', 'favorited', 'active_buyer'],
    dampSignals:               ['agent_listed', 'rental', 'no_owner_contact'],
    identityPolicy:            'enrichment_first',
    canPromoteBeforeEnrichment: false,
  },

  // ── Realtor.com — FSBO sellers + saved-search buyers ─────────────────────────
  zenrows_realtor: {
    intentType:                'unknown',
    leadType:                  'unknown',
    motivationType:            'real_estate_site_intent',
    behaviorType:              'fsbo_listing',
    scoreRange:                [35, 65],
    baseScore:                 48,
    boostSignals:              ['by_owner', 'fsbo', 'make_me_move', 'coming_soon', 'price_reduced', 'saved_search', 'favorited', 'active_buyer'],
    dampSignals:               ['agent_listed', 'rental', 'no_owner_contact'],
    identityPolicy:            'enrichment_first',
    canPromoteBeforeEnrichment: false,
  },

  // ── Redfin / generic property portal — FSBO sellers + saved-search buyers ────
  zenrows_homes: {
    intentType:                'unknown',
    leadType:                  'unknown',
    motivationType:            'real_estate_site_intent',
    behaviorType:              'fsbo_listing',
    scoreRange:                [35, 60],
    baseScore:                 45,
    boostSignals:              ['by_owner', 'fsbo', 'make_me_move', 'coming_soon', 'saved_search', 'favorited', 'active_buyer'],
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
    // Both buyer and seller posts; classified per post by the normalizer.
    intentType:                'unknown',
    leadType:                  'unknown',
    motivationType:            'social_intent',
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
    // Both buyer ("looking to buy", "first home") and seller ("selling my home")
    // posts; the per-post normalizer sets the actual intent via detectIntent.
    intentType:                'unknown',
    leadType:                  'unknown',
    motivationType:            'social_intent',
    behaviorType:              'social_intent',
    scoreRange:                [35, 55],
    baseScore:                 40,
    boostSignals:              ['pre_approved', 'looking_to_buy', 'first_time', 'moving_to', 'relocating', 'timeline'],
    dampSignals:               ['just_curious', 'hypothetical', 'no_timeline'],
    identityPolicy:            'enrichment_first',
    canPromoteBeforeEnrichment: false,
  },

  // ── Instagram intent (Apify) ──────────────────────────────────────────────────
  // Real-estate hashtags/posts surface both buyer ("house hunting", "first home")
  // and seller ("listing my home", "fsbo") intent; resolved per-post at enrichment.
  instagram_intent: {
    intentType:                'unknown',
    leadType:                  'unknown',
    motivationType:            'social_intent',
    behaviorType:              'social_intent',
    scoreRange:                [30, 55],
    baseScore:                 38,
    boostSignals:              ['looking_to_buy', 'house_hunting', 'first_home', 'selling', 'fsbo', 'listing_my_home', 'relocating'],
    dampSignals:               ['agent_promo', 'just_browsing'],
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

  // ── Rental listings (Craigslist apa) — landlord/investor SELLER signal ───────
  // Owners listing rentals are prospective sellers (liquidating investment props).
  rental_listing: {
    intentType:                'seller',
    leadType:                  'seller',
    motivationType:            'investor_landlord',
    behaviorType:              'rental_listing',
    scoreRange:                [35, 60],
    baseScore:                 45,
    boostSignals:              ['by_owner', 'must_sell', 'tired_landlord', 'vacant', 'price_reduced'],
    dampSignals:               ['property_manager', 'large_complex'],
    identityPolicy:            'enrichment_first',
    canPromoteBeforeEnrichment: false,
  },

  // ── Expired / withdrawn listings — top motivated SELLER signal ───────────────
  // A listing that failed to sell (off-market / removed) is a high-intent seller.
  expired_listing: {
    intentType:                'seller',
    leadType:                  'seller',
    motivationType:            'expired_listing',
    behaviorType:              'expired_listing',
    scoreRange:                [60, 90],
    baseScore:                 75,
    boostSignals:              ['off_market', 'listing_removed', 'withdrawn', 'expired', 'price_reduced', 'days_on_market'],
    dampSignals:               ['recently_sold', 'pending'],
    identityPolicy:            'enrichment_first',
    canPromoteBeforeEnrichment: false,
  },

  // ── LinkedIn relocation posts — inbound BUYER signal ─────────────────────────
  // "Excited to start at {company} in {city}" → relocating buyer with timeline.
  linkedin_relocation: {
    intentType:                'buyer',
    leadType:                  'buyer',
    motivationType:            'relocation_buyer',
    behaviorType:              'social_intent',
    scoreRange:                [40, 70],
    baseScore:                 52,
    boostSignals:              ['relocating', 'new_job', 'moving_to', 'starting_at', 'excited_to_join'],
    dampSignals:               ['remote', 'no_location'],
    identityPolicy:            'enrichment_first',
    canPromoteBeforeEnrichment: false,
  },

  // ── Exa neural-search buyer intent (AI-native) ───────────────────────────────
  // Semantic discovery of buyer-intent content across the open web; per-result
  // intent via detectIntent, anchored on the author handle.
  exa_buyer_intent: {
    intentType:                'buyer',
    leadType:                  'buyer',
    motivationType:            'ai_neural_buyer_intent',
    behaviorType:              'search_signal',
    scoreRange:                [35, 65],
    baseScore:                 50,
    boostSignals:              ['pre_approved', 'looking_to_buy', 'house_hunting', 'first_home', 'relocating', 'timeline'],
    dampSignals:               ['just_browsing', 'no_timeline'],
    identityPolicy:            'enrichment_first',
    canPromoteBeforeEnrichment: false,
  },

  // ── Tavily agentic-search intent (AI-native) — buyer / seller / investor ─────
  // Real-time ranked web content with snippets; per-result intent via detectIntent
  // + isInvestor (investors tagged as buyers). Identity anchored on email/phone
  // extracted from the snippet, else the source page URL.
  tavily_intent: {
    intentType:                'unknown',
    leadType:                  'unknown',
    motivationType:            'ai_search_intent',
    behaviorType:              'search_signal',
    scoreRange:                [35, 65],
    baseScore:                 48,
    boostSignals:              ['pre_approved', 'looking_to_buy', 'house_hunting', 'first_home', 'selling', 'fsbo', 'investor', '1031_exchange', 'cash_buyer', 'relocating'],
    dampSignals:               ['just_browsing', 'no_timeline', 'agent_promo'],
    identityPolicy:            'enrichment_first',
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

  // ── Zillow/Realtor/Homes.com saved-search + "contact agent" chatter (ZenRows/Zyte) ─────────
  // DISTINCT from zenrows_zillow/zenrows_realtor/zenrows_homes above (those parse structured
  // FSBO listing cards + saved-search DOM blocks via cheerio parsers); this lane targets the
  // "contact agent" / "request a tour" / "get pre-approved" form-chatter and saved-search-alert
  // markers that normalizeZenRowsHtml's intent scorer already reads (buyerAlertProfile). Owner
  // ruling wave 65: never merge look-alike scraping lanes.
  realty_site_chatter: {
    intentType:                'unknown',
    leadType:                  'unknown',
    motivationType:            'realty_site_chatter',
    behaviorType:              'contact_agent_chatter',
    scoreRange:                [40, 75],
    baseScore:                 55,
    boostSignals:              ['contact_agent', 'request_info', 'saved_search', 'schedule_tour', 'get_pre_approved', 'buyer_alert_profile'],
    dampSignals:               ['agent_landing_page', 'no_form'],
    identityPolicy:            'enrichment_first',
    canPromoteBeforeEnrichment: false,
  },

  // ── Reddit relocation lane — "moving to <city>" / "looking for a realtor in <city>" ───────
  // DISTINCT from reddit_intent above (which follows the brokerage's own configured
  // subreddits/keywords); this lane runs a FIXED territory-centric relocation query set against
  // general relocation/city subreddits regardless of what keywords are configured.
  reddit_relocation: {
    intentType:                'buyer',
    leadType:                  'buyer',
    motivationType:            'relocation_buyer',
    behaviorType:              'social_intent',
    scoreRange:                [40, 70],
    baseScore:                 54,
    boostSignals:              ['moving_to', 'relocating', 'looking_for_a_realtor', 'new_job', 'job_transfer', 'need_a_realtor'],
    dampSignals:               ['just_curious', 'hypothetical', 'not_moving'],
    identityPolicy:            'enrichment_first',
    canPromoteBeforeEnrichment: false,
  },

  // ── Facebook "recommend a realtor" lane ────────────────────────────────────────────────────
  // DISTINCT from facebook_group above (configured-keyword group monitoring); this lane runs a
  // FIXED "recommend a realtor / need an agent" query against the territory's local groups.
  facebook_recommend_realtor: {
    intentType:                'unknown',
    leadType:                  'unknown',
    motivationType:            'agent_referral_request',
    behaviorType:              'social_intent',
    scoreRange:                [35, 70],
    baseScore:                 50,
    boostSignals:              ['recommend_a_realtor', 'need_an_agent', 'looking_for_a_realtor', 'buying_or_selling', 'referral'],
    dampSignals:               ['just_asking', 'no_timeline'],
    identityPolicy:            'enrichment_first',
    canPromoteBeforeEnrichment: false,
  },

  // ── Agent-seeking phrase intent — cross-source (Google/Apify today) ───────────────────────
  // "looking for a real estate agent/realtor" is a DISTINCT phrase-intent capability from
  // google_phrase_intent (buyer/seller listing search phrases) — this targets people actively
  // shopping for an AGENT, the platform's own referral funnel.
  agent_seeking_phrase_intent: {
    intentType:                'unknown',
    leadType:                  'unknown',
    motivationType:            'agent_referral_request',
    behaviorType:              'search_signal',
    scoreRange:                [30, 60],
    baseScore:                 42,
    boostSignals:              ['looking_for_a_realtor', 'need_a_real_estate_agent', 'recommend_a_realtor', 'best_real_estate_agent'],
    dampSignals:               ['general_research'],
    identityPolicy:            'analytics_only',
    canPromoteBeforeEnrichment: false,
  },

  // ── BatchData Smart Search (V2 Property Subscription push) ──────────────────────────────────
  // DISTINCT from batchdata_motivated above (which is the POLLED quicklist sweep): this is the
  // incremental webhook delivery lib/kernel/manager-registry.ts's batchdata_smart_search entry
  // describes (app/api/webhooks/batchdata-smart-search). Same quicklist universe, own
  // vendor-routed key per owner ruling ("never merge look-alike scraping lanes").
  batchdata_smart_search: {
    intentType:                'seller',
    leadType:                  'seller',
    motivationType:            'motivated_seller_subscription',
    behaviorType:              'batchdata_smart_search_match',
    scoreRange:                [50, 90],
    baseScore:                 65,
    boostSignals:              ['foreclosure', 'pre_foreclosure', 'divorce', 'bankruptcy', 'distressed', 'absentee', 'tax_lien', 'high_equity', 'vacant'],
    dampSignals:               ['low_confidence', 'incomplete'],
    identityPolicy:            'immediate',
    canPromoteBeforeEnrichment: true,
  },

  // ── BatchData Buy Box — investor-criteria match per listing (wave 66 ruling) ────────────────
  // A Buy Box match tells us a property fits an INVESTOR'S stated buying criteria — a BUYER-side
  // signal, never the seller-side motivated-seller lanes above. Enrichment-first: a matched
  // listing alone is not yet a named person.
  batchdata_buybox: {
    intentType:                'buyer',
    leadType:                  'buyer',
    motivationType:            'investor_buybox_match',
    behaviorType:              'investor_buybox_match',
    scoreRange:                [45, 80],
    baseScore:                 58,
    boostSignals:              ['cash_buyer', '1031_exchange', 'portfolio', 'investor', 'high_equity', 'fix_and_flip'],
    dampSignals:               ['owner_occupied_only', 'low_confidence'],
    identityPolicy:            'enrichment_first',
    canPromoteBeforeEnrichment: false,
  },

  // ── External behavior — off-site property-view discovery (scrapeExternalBehavior) ──────────
  // Property discovery across Zillow/Realtor/Redfin outside the governed cron lane (kept per the
  // orphan doctrine — it writes `external_behavior`, a shape the governed lane does not produce).
  // Per-record `source` there is usually the origin site (already aliased below); this canonical
  // entry hardens the fallback for any record tagged with the umbrella channel name directly.
  external_behavior: {
    intentType:                'seller',
    leadType:                  'seller',
    motivationType:            'off_site_property_interest',
    behaviorType:              'external_behavior',
    scoreRange:                [35, 65],
    baseScore:                 45,
    boostSignals:              ['price_reduced', 'by_owner', 'motivated', 'vacant'],
    dampSignals:               ['agent_listed', 'low_confidence'],
    identityPolicy:            'immediate',
    canPromoteBeforeEnrichment: true,
  },

  // ── Site visitor intent (wave 70 — owner: "make sure we have covered every area of lead
  // acquisition and enrichment scraping and behavioral scraping opportunities") ────────────────
  // ON-SITE, first-party behavioral signal: an UNIDENTIFIED (no contact_id/lead_id) visitor to the
  // tenant's OWN website/portal who dwelled long enough on a listing/search page to read as real
  // buyer interest (lib/lead-pipeline/site-visitor-sourcer.ts). $0 marginal cost — no vendor call,
  // the data is already collected by the existing pixel/dwell beacons
  // (app/api/track/pixel, app/api/track/dwell). Anonymous by construction, so identity is always
  // enrichment-first; a later /api/track/identify hit (the visitor filling a form) is the real
  // identity resolution path, not this lane.
  site_visitor_intent: {
    intentType:                'buyer',
    leadType:                  'buyer',
    motivationType:            'site_visitor_intent',
    behaviorType:              'site_visitor_intent',
    scoreRange:                [25, 55],
    baseScore:                 35,
    boostSignals:              ['long_dwell', 'listing_page_view', 'return_visit', 'campaign_referred'],
    dampSignals:               ['bounce', 'short_dwell'],
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
 * hasScoringEntry — true only when `source` resolves to a REAL SOURCE_MAP entry (directly or
 * via SOURCE_ALIASES), never the silent FALLBACK_DEFINITION. `getSourceSemantics` always
 * returns a truthy object (fallback included), so it cannot answer "does this channel have its
 * OWN scoring, or is it being scored as a stranger?" — this is that check. Used by
 * pipeline-processor.ts to fall back from `raw_scraped_leads.source` to `.source_channel` when
 * the former has no real entry, and by the wave-66 positive-control proof (a bogus channel name
 * MUST come back false, or the check is not actually checking anything).
 */
export function hasScoringEntry(source: string): boolean {
  return resolveSourceKey(source) in SOURCE_MAP
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
  instagram: "instagram_intent",
  craigslist: "craigslist_fsbo",
  google: "google_phrase_intent",
  rental: "rental_listing",
  expired: "expired_listing",
  linkedin: "linkedin_relocation",
  exa: "exa_buyer_intent",
  tavily: "tavily_intent",
  osint: "osint_signal",
  realty_chatter: "realty_site_chatter",
  zillow_chatter: "realty_site_chatter",
  realtor_chatter: "realty_site_chatter",
  homes_chatter: "realty_site_chatter",
  reddit_relocation: "reddit_relocation",
  facebook_recommend_realtor: "facebook_recommend_realtor",
  agent_seeking: "agent_seeking_phrase_intent",
  agent_seeking_phrase_intent: "agent_seeking_phrase_intent",
  // Wave 66 — same idea, a second spelling seen elsewhere in the codebase (CLAUDE.md §6: one
  // vocabulary per function). Aliased onto the existing canonical key rather than duplicating
  // its SourceDefinition.
  nextdoor_chatter: "nextdoor_intent",
  google_intent: "google_phrase_intent",
  // Wave 70 — site visitor intent, second spelling seen in config/UI copy.
  site_visitor: "site_visitor_intent",
  website_visitor: "site_visitor_intent",
  website_visitor_intent: "site_visitor_intent",
}

/**
 * Vendor routing contract — which scraping vendor owns each source.
 *   • zenrows  — expensive; reserved for real-estate sites + Nextdoor only.
 *   • apify    — Facebook / Instagram / Craigslist / Reddit / Google.
 *   • batchdata — motivated-seller property data via quickLists (high-equity, preforeclosure,
 *                 absentee, tax-default, vacant, tired-landlord, inherited, expired-listing).
 *                 NOTE: BatchData has no divorce quickList — divorce is sourced via OSINT.
 *   • osint    — public + court records (divorce / probate / foreclosure / tax-lien / eviction).
 *   • peopledata is enrichment-only and never sources raw leads, so it is not here.
 */
// 'internal' (wave 70) — first-party data already collected by this repo's own pixel/dwell
// beacons; no vendor call, $0 marginal cost, never appears in vendor_usage_tracking.
export type ScrapeVendor = 'zenrows' | 'apify' | 'batchdata' | 'osint' | 'exa' | 'tavily' | 'zyte' | 'internal'

export const SOURCE_VENDOR: Record<SourceKey, ScrapeVendor> = {
  zenrows_zillow:       'zenrows',
  zenrows_realtor:      'zenrows',
  zenrows_homes:        'zenrows',
  nextdoor_intent:      'zenrows',
  facebook_group:       'apify',
  facebook_marketplace: 'apify',
  instagram_intent:     'apify',
  reddit_intent:        'apify',
  craigslist_fsbo:      'apify',
  google_phrase_intent: 'apify',
  rental_listing:       'apify',   // Craigslist apartments section
  linkedin_relocation:  'apify',
  expired_listing:      'batchdata', // BatchData 'expired' motivation trigger (quickList 'expired-listing')
  exa_buyer_intent:     'exa',     // AI-native neural search (buyer intent)
  tavily_intent:        'tavily',  // AI-native agentic search (buyer/seller/investor)
  batchdata_motivated:  'batchdata',
  osint_signal:         'osint',
  // Wave 65 lanes — contract owner is ZenRows (with Zyte as the configured-key fallback the
  // provider picker reaches for, see lib/external/zenrows-client.ts::scrapeSiteWithBestProvider);
  // 'zyte' is a distinct union member so the vendor ledger can attribute a run that actually fell
  // back, without this contract map pretending to know which provider serves any given call.
  realty_site_chatter:        'zenrows',
  reddit_relocation:          'apify',
  facebook_recommend_realtor: 'apify',
  agent_seeking_phrase_intent: 'apify', // Google search via Apify today
  // Wave 66 lanes.
  batchdata_smart_search:     'batchdata',
  batchdata_buybox:           'batchdata',
  external_behavior:          'apify',  // discovery is Apify; BatchData only enriches the match
  site_visitor_intent:        'internal', // first-party — own pixel/dwell data, no vendor call
}

export function resolveSourceKey(source: string): SourceKey {
  const key = source as SourceKey
  if (key in SOURCE_MAP) return key
  return SOURCE_ALIASES[source.toLowerCase()] ?? (source as SourceKey)
}

/**
 * Gate token used by the lead-scraping cron's `enabledSources.has(...)` checks.
 * The cron historically gated on short names ("facebook"), while DB config and
 * normalizers use canonical keys ("facebook_group") — so a market configured with
 * canonical keys silently scraped nothing. GATE_TOKEN maps each canonical key to
 * the exact string the cron checks; expandEnabledSources() applies it so the gate
 * matches regardless of which form (short / canonical / alias) the DB stored.
 * The three ZenRows property sources collapse to the single "zillow_behavior"
 * property-block gate the cron uses.
 */
const GATE_TOKEN: Record<SourceKey, string> = {
  zenrows_zillow:       'zillow_behavior',
  zenrows_realtor:      'zillow_behavior',
  zenrows_homes:        'zillow_behavior',
  nextdoor_intent:      'nextdoor',
  facebook_group:       'facebook',
  facebook_marketplace: 'facebook',
  instagram_intent:     'instagram',
  reddit_intent:        'reddit',
  craigslist_fsbo:      'craigslist',
  google_phrase_intent: 'google_phrase_intent',
  rental_listing:       'rental',
  linkedin_relocation:  'linkedin',
  expired_listing:      'expired_listing',
  exa_buyer_intent:     'exa',
  tavily_intent:        'tavily',
  batchdata_motivated:  'batchdata_motivated',
  osint_signal:         'osint_signal',
  realty_site_chatter:        'realty_chatter',
  reddit_relocation:          'reddit_relocation',
  facebook_recommend_realtor: 'facebook_recommend_realtor',
  agent_seeking_phrase_intent: 'agent_seeking_phrase_intent',
  batchdata_smart_search:     'batchdata_smart_search',
  batchdata_buybox:           'batchdata_buybox',
  external_behavior:          'external_behavior',
  site_visitor_intent:        'site_visitor_intent',
}

/**
 * Builds the set the cron tests with `enabledSources.has(...)`. For each configured
 * value it adds: the raw value, its canonical SourceKey, and the cron gate token —
 * so "facebook", "facebook_group", and the canonical key all activate the Facebook
 * block. Pass-through values (e.g. "zillow_behavior", "recruiting_intent") are kept
 * verbatim. This is the single bridge between DB `enabled_sources` config and the
 * cron gate, eliminating the short-name/canonical-key drift.
 */
export function expandEnabledSources(raw: readonly string[] | null | undefined): Set<string> {
  const out = new Set<string>()
  for (const v of raw ?? []) {
    if (!v) continue
    out.add(v)
    const key = resolveSourceKey(v)
    out.add(key)
    const token = GATE_TOKEN[key as SourceKey]
    if (token) out.add(token)
  }
  return out
}

/**
 * Derives urgency_level from a numeric motivation score.
 * Maps directly to the leads.urgency_level column values.
 */
// leads.urgency_level uses the real-estate lead-TEMPERATURE vocabulary
// (hot/warm/cool/cold) — enforced by leads_urgency_level_check and read by
// app/actions/leads.ts (.eq "hot") and AvailableLeadsSheet. Map the 0–100
// source score onto those four buckets.
//
// NOTE: this previously returned high/medium/low, which violated the leads
// constraint and made every scrape→lead promotion throw "Failed to create
// lead" (the leads table was empty, so it had never surfaced). The sole caller
// is the promotion insert in pipeline-processor.ts.
export function scoreToUrgencyLevel(score: number): 'hot' | 'warm' | 'cool' | 'cold' {
  if (score >= 70) return 'hot'
  if (score >= 45) return 'warm'
  if (score >= 25) return 'cool'
  return 'cold'
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

// ─── buildAgentSeekingPhrases ──────────────────────────────────────────────────
// DISTINCT from buildTerritoryPhrases (buyer/seller LISTING-search phrases): this builds the
// "shopping for an agent" phrase set the agent_seeking_phrase_intent lane (and the Reddit /
// Facebook "recommend a realtor" lanes) run against a territory — owner ruling wave 65 task 3
// ("a phrase-intent lane for 'looking for a real estate agent/realtor' across sources").

export interface AgentSeekingPhrases {
  phrases: string[]
}

export function buildAgentSeekingPhrases(market: {
  city?:      string | null
  state?:     string | null
  zip_codes?: string[] | null
  counties?:  string[] | null
}): AgentSeekingPhrases {
  const city    = market.city?.trim()    ?? ''
  const state   = market.state?.trim()   ?? ''
  const counties = market.counties       ?? []

  const locationTokens: string[] = [
    city,
    ...counties.map(c => c.replace(/\s+county$/i, '').trim()),
    [city, state].filter(Boolean).join(', '),
  ].filter(Boolean)

  const phrases: string[] = []
  for (const loc of locationTokens) {
    phrases.push(
      `looking for a realtor in ${loc}`,
      `looking for a real estate agent in ${loc}`,
      `need a real estate agent in ${loc}`,
      `recommend a realtor in ${loc}`,
      `best real estate agent in ${loc}`,
    )
  }
  return { phrases }
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
