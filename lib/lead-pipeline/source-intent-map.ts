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
  // Lane 82B — Craigslist "housing wanted" / ISO posts. The cron has written this sourceChannel since
  // wave 65 (sourceCraigslistWanted) but no SourceKey existed, so every record scored as a STRANGER
  // (FALLBACK_DEFINITION) and its spend had no vendor to attribute to. DISTINCT from craigslist_fsbo
  // (a SELLER listing) — this is a BUYER asking for a home; never merged (CLAUDE.md §6).
  | 'craigslist_wanted'
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
  // ── Lane 71C (carried coverage lane, docs/lead-acquisition-coverage-2026-09.md) — DISTINCT from every source above ──
  | 'email_engagement_intent'     // repeated opens/clicks on the tenant's OWN outbound email (own first-party data, $0 marginal cost)
  // ── Lane 72C (carried coverage lane, docs/lead-acquisition-coverage-2026-09.md — new-construction/builder lists) — DISTINCT from every source above ──
  | 'new_construction_intent'     // Google/Apify phrase-intent search for new-construction / builder shoppers, territory-centric
  // ── Lane 73A (wave 73 ruling, owner verbatim: "unknown inbound senders first need to be
  // identified before adding a spam or non real estate business email records into the os. if
  // there is intent to or interest in real estate then we should add them in as a lead so the ai
  // isa can qualify before converting to contact.") — an inbound email to a tenant that matches NO
  // existing contact/lead is identified (cheap bounce/vendor prefilter, then an AI real-estate-
  // intent read) before it becomes anything at all. Spam/vendor/automated → dropped, never a raw
  // row. Real-estate intent → THIS SourceKey, through the SAME linear pipeline every other source
  // uses (lib/lead-pipeline/unknown-sender-identification.ts). DISTINCT from every source above —
  // this is a first-party signal (the tenant's OWN inbound mailbox), never a vendor scrape.
  | 'inbound_email_unknown'
  // ── Lane 73D (owner ruling wave 73, verbatim: "exa is good at looking for leads like permit").
  // DISTINCT from lib/external/permit-signals.ts (Socrata/ArcGIS permit-PORTAL rows, ATTACH-ONLY —
  // never mints a lead from a bare address, per that file's own header) and from
  // lib/lead-pipeline/exa-sourcer.ts's exa_buyer_intent (buyer-only neural search): this is an Exa
  // neural-search SELLER/pre-listing lane over recent building-permit filings, estate/probate
  // notices, "coming soon" pre-listing chatter, and contractor-bid posts, territory-centric.
  | 'permit_prelisting_intent'
  // ── Lane 74D (docs/lead-acquisition-coverage-2026-09.md's remaining-lanes matrix, items #24
  // and #31 — the last two "Missing"/"Partial" rows) — each DISTINCT from every source above. ──
  // Renters already in the tenant's own `contacts` whose tenure crosses the graduation bar. NEVER
  // a raw lead (the person is already a contact) — see lib/lead-pipeline/rental-graduation-
  // sourcer.ts's header for why `records` stays permanently empty for this key, same posture as
  // email_engagement_intent.
  | 'rental_to_buyer_graduation'
  // Reviewers/commenters on the tenant's PUBLIC Google Business/Zillow/Facebook pages whose own
  // words carry a real-estate QUESTION — lib/lead-pipeline/review-acquisition-sourcer.ts. Unlike
  // rental_to_buyer_graduation, THIS key DOES mint raw leads (a name-unmatched reviewer is a
  // genuinely new person) alongside routing matched-contact hits as a signal — see that file's
  // attach-vs-mint split.
  | 'review_acquisition_intent'
  // Lane 82B — INVESTOR buyers from BatchData's published 'cash-buyer' quickList: owners in the
  // territory who bought for CASH (the investor list PropStream/BatchData users build). BUYER-side,
  // DISTINCT from batchdata_buybox (demand matched to ONE listing) and from every seller lane.
  | 'batchdata_cash_buyer'

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
    boostSignals:              ['foreclosure', 'pre_foreclosure', 'divorce', 'bankruptcy', 'distressed', 'absentee', 'tax_lien', 'high_equity', 'vacant', 'fsbo', 'senior_owner', 'canceled_listing', 'lis_pendens', 'notice_of_default', 'involuntary_lien'],
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

  // ── Craigslist housing-wanted / ISO post (lane 82B) — BUYER asking for a home ───
  // A reply-to address is usually on the post; identity still resolves through enrichment.
  craigslist_wanted: {
    intentType:                'buyer',
    leadType:                  'buyer',
    motivationType:            'housing_wanted_buyer',
    behaviorType:              'housing_wanted_post',
    scoreRange:                [40, 70],
    baseScore:                 50,
    boostSignals:              ['looking_to_buy', 'pre_approved', 'cash_buyer', 'relocating', 'timeline'],
    dampSignals:               ['rental', 'roommate', 'no_timeline'],
    identityPolicy:            'enrichment_first',
    canPromoteBeforeEnrichment: false,
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
    boostSignals:              ['foreclosure', 'pre_foreclosure', 'divorce', 'bankruptcy', 'distressed', 'absentee', 'tax_lien', 'high_equity', 'vacant', 'fsbo', 'senior_owner', 'canceled_listing', 'lis_pendens', 'notice_of_default', 'involuntary_lien'],
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

  // ── Email engagement intent (lane 71C — docs/lead-acquisition-coverage-2026-09.md's
  // remaining-lanes matrix: "email engagement intent (opens/clicks/replies on our own
  // outbound → intent signal)"). Same shape as site_visitor_intent above: a first-party
  // signal (email_tracking, written by app/api/webhooks/sendgrid-events/route.ts) that
  // nothing fed back into acquisition. REPEATED engagement (lib/lead-pipeline/
  // email-engagement-sourcer.ts's EMAIL_ENGAGEMENT_MIN_EVENTS), not a single open, is
  // the bar. Because email_tracking is contact-scoped, the person sourced here is almost
  // always ALREADY a contact — the three-table dedup in lib/kernel/scraping.ts resolves
  // that against `contacts` and records the renewed-intent signal on their history
  // without minting a duplicate lead, matching wave 65's "person's full history from
  // first touch through conversion and after" ruling.
  email_engagement_intent: {
    intentType:                'unknown',
    leadType:                  'unknown',
    motivationType:            'email_engagement_intent',
    behaviorType:              'email_engagement_intent',
    scoreRange:                [20, 50],
    baseScore:                 30,
    boostSignals:              ['repeated_email_engagement', 'click_through', 'high_frequency_engagement'],
    dampSignals:               ['unsubscribed', 'bounced'],
    identityPolicy:            'enrichment_first',
    canPromoteBeforeEnrichment: false,
  },

  // ── New-construction / builder intent (lane 72C — docs/lead-acquisition-coverage-2026-09.md's
  // remaining-lanes matrix item #23, "new-construction/builder lists"). Territory-centric
  // Google phrase-intent search (via the ALREADY-REGISTERED Apify 'google' task — no new
  // vendor relationship, same shape as agent_seeking_phrase_intent above) for people actively
  // shopping new-construction inventory ("new construction homes <city>", "<builder> incentives
  // <city>", "new home communities <city>"). DISTINCT from google_phrase_intent (generic
  // buyer/seller listing search) and from agent_seeking_phrase_intent (shopping for an AGENT,
  // not a house) — never merged (CLAUDE.md §6: one vocabulary per function, but new-construction
  // shoppers are a different population from either of those two). Buyer-side by construction: a
  // new-construction search is definitionally a buyer signal, never a seller one.
  new_construction_intent: {
    intentType:                'buyer',
    leadType:                  'buyer',
    motivationType:            'new_construction_intent',
    behaviorType:              'search_signal',
    scoreRange:                [30, 60],
    baseScore:                 40,
    boostSignals:              ['new_construction', 'builder_incentive', 'move_in_ready', 'new_home_community'],
    dampSignals:               ['general_research'],
    identityPolicy:            'analytics_only',
    canPromoteBeforeEnrichment: false,
  },

  // ── Inbound email — unknown sender, identified as real-estate intent (lane 73A/74A) ─────────
  // An unknown sender's email alone is an IMMEDIATE identity anchor (the same posture as
  // batchdata_motivated/external_behavior above — this record already carries a reachable
  // channel, unlike a social-intent post that needs enrichment before it has one). The
  // AI classifier's per-record intentType (buyer/seller/investor/renter/relocation/
  // agent_seeking → mapped to buyer/seller/unknown on the record) overrides this map's
  // 'unknown' default per NormalizedScrapedRecord.intentType, same as zenrows_zillow.
  //
  // WAVE 74 CORRECTION — this entry STAYS registered (intelligence/cost-tracking identity,
  // SOURCE_VENDOR 'internal', $0) but is NO LONGER routed through the raw pipeline
  // (ingestRawSourceBatch/processRawRecord) this map entry was originally written to feed.
  // lib/lead-pipeline/unknown-sender-identification.ts now creates a lead DIRECTLY for a
  // brokerage mailbox (lib/kernel/crm.ts::createLeadOnlyRecordForAcquisitionSource) or a
  // contact for an agent/team-lead mailbox (lib/contact-pipeline/contact-capture.ts::
  // captureContact) — see that module's header for the full tombstone.
  inbound_email_unknown: {
    intentType:                'unknown',
    leadType:                  'unknown',
    motivationType:            'inbound_email_intent',
    behaviorType:              'inbound_email_unknown',
    scoreRange:                [30, 70],
    baseScore:                 45,
    boostSignals:              ['looking_to_buy', 'looking_to_sell', 'timeline', 'pre_approved', 'relocating', 'investor', 'cash_buyer'],
    dampSignals:               ['just_browsing', 'no_timeline'],
    identityPolicy:            'immediate',
    canPromoteBeforeEnrichment: true,
  },
  // ── Permit / pre-listing intent (lane 73D — owner ruling wave 73, verbatim: "exa is good at
  // looking for leads like permit"). SELLER-side: a recent remodel/addition/roof/pool permit, an
  // estate/probate notice, "coming soon" pre-listing chatter, or a contractor-bid post are all
  // signals somebody is preparing a home for sale. `property_required` (like craigslist_fsbo) — the
  // Exa hit's property address is the concrete anchor; PeopleData enrichment resolves the owner's
  // name downstream (wave 72 ruling) when the hit itself carries none. When the hit's address
  // matches a lead/contact the brokerage ALREADY owns, lib/lead-pipeline/permit-sourcer.ts routes it
  // to lib/external/permit-signals.ts's ATTACH path instead of minting here — see that file's own
  // "no lead is created from a bare address" refusal.
  permit_prelisting_intent: {
    intentType:                'seller',
    leadType:                  'seller',
    motivationType:            'permit_prelisting_intent',
    behaviorType:              'search_signal',
    scoreRange:                [40, 75],
    baseScore:                 50,
    boostSignals:              ['demolition', 'probate', 'estate_sale', 'inherited', 'contractor_bid', 'coming_soon'],
    dampSignals:               ['general_research'],
    identityPolicy:            'property_required',
    canPromoteBeforeEnrichment: true,
  },

  // ── Rental-to-buyer graduation, tenant side (lane 74D) ──────────────────────────────────────
  // A renter already in `contacts` (home_owner_status='renter') whose tenure
  // (contacts.length_of_residence, parsed by the ONE parser this repo has for it —
  // lib/avm/provider-chain.ts::parseLengthOfResidence) crosses a graduation bar reads as
  // approaching a lease-renewal decision — buy vs. renew again. ALWAYS buyer-side; ALWAYS
  // 'immediate' would be wrong here (the person already has full identity as a contact — this
  // key exists for the SCORING/toggle vocabulary, never for a raw-lead promotion path, since
  // lib/lead-pipeline/rental-graduation-sourcer.ts's `records` output is permanently empty).
  rental_to_buyer_graduation: {
    intentType:                'buyer',
    leadType:                  'buyer',
    motivationType:            'rental_to_buyer_graduation',
    behaviorType:              'rental_to_buyer_graduation',
    scoreRange:                [25, 55],
    baseScore:                 35,
    boostSignals:              ['renter_tenure_threshold', 'long_tenure', 'income_signal_present', 'graduation_ready'],
    dampSignals:               ['short_tenure', 'recently_moved'],
    identityPolicy:            'enrichment_first',
    canPromoteBeforeEnrichment: false,
  },

  // ── Review-as-acquisition (lane 74D) ────────────────────────────────────────────────────────
  // A reviewer/commenter on the tenant's PUBLIC Google Business/Zillow/Facebook page whose own
  // text asks a real-estate question ("do you have any listings in…", "what's my home worth?",
  // "looking for an agent in…"). DISTINCT from lib/reputation/* (that lane records/closes the
  // tenant's OWN review requests — response, not acquisition) and from realty_site_chatter above
  // (that lane targets "contact agent"/saved-search DOM markers on listing PORTALS, not review
  // pages). identityPolicy 'enrichment_first' — a display name alone (no email/phone) is what a
  // public review carries; PeopleData enrichment resolves the rest downstream, same posture every
  // social/search lane with a name-only identity anchor already takes.
  // ── BatchData cash buyers (lane 82B) — INVESTOR buyer list, owner identity on the record ──
  batchdata_cash_buyer: {
    intentType:                'buyer',
    leadType:                  'buyer',
    motivationType:            'investor_cash_buyer',
    behaviorType:              'investor_cash_purchase',
    scoreRange:                [45, 80],
    baseScore:                 55,
    boostSignals:              ['cash_buyer', 'investor', 'absentee', 'corporate_owned', 'portfolio'],
    dampSignals:               ['owner_occupied_only', 'low_confidence'],
    identityPolicy:            'immediate',
    canPromoteBeforeEnrichment: true,
  },

  review_acquisition_intent: {
    intentType:                'unknown',
    leadType:                  'unknown',
    motivationType:            'review_acquisition_intent',
    behaviorType:              'review_question_intent',
    scoreRange:                [35, 70],
    baseScore:                 45,
    boostSignals:              ['review_question_intent', 'agent_referral_request', 'looking_to_buy', 'looking_to_sell'],
    dampSignals:               ['general_research'],
    identityPolicy:            'enrichment_first',
    canPromoteBeforeEnrichment: false,
  },

}

/**
 * Every canonical SourceKey SOURCE_MAP defines — derived from the map itself (never a hand-copied
 * list, CLAUDE.md §6: a hand-maintained second list of one vocabulary is how the next SourceKey
 * gets added to one and not the other). Used by the admin markets page's per-market source-toggle
 * panel (lane 72C, docs/lead-acquisition-coverage-2026-09.md — the operator toggle surface wave 71
 * flagged) so a new SourceKey is toggleable the moment it is added here, with no second edit.
 */
export const ALL_SOURCE_KEYS: SourceKey[] = Object.keys(SOURCE_MAP) as SourceKey[]

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
  // Lane 82B — the channel spelling the cron writes, plus UI spellings.
  housing_wanted: "craigslist_wanted",
  // Lane 82B — the incremental Search-Session channel (lib/kernel/listings-batchdata-feed.ts) pulls
  // the SAME motivated-seller quickList universe; it scored as a stranger and its ledger vendor was
  // unresolvable. The CHANNEL stays distinct on raw_scraped_leads — only scoring/vendor resolve here.
  batchdata_incremental: "batchdata_motivated",
  cash_buyer: "batchdata_cash_buyer",
  craigslist_iso: "craigslist_wanted",
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
  // Lane 71C — email engagement intent, second spelling seen in config/UI copy.
  email_engagement: "email_engagement_intent",
  email_intent: "email_engagement_intent",
  // Lane 72C — new-construction/builder intent, second spelling seen in config/UI copy.
  new_construction: "new_construction_intent",
  builder_intent: "new_construction_intent",
  new_construction_builder: "new_construction_intent",
  // Lane 73A — inbound email from an unknown sender, second spelling seen in config/UI copy.
  inbound_email: "inbound_email_unknown",
  unknown_inbound_email: "inbound_email_unknown",
  // Lane 73D — permit/pre-listing intent, second spellings seen in config/UI copy.
  permit_intent: "permit_prelisting_intent",
  permit_prelisting: "permit_prelisting_intent",
  pre_listing_intent: "permit_prelisting_intent",
  // Lane 74D — second spellings seen in config/UI copy.
  rental_graduation: "rental_to_buyer_graduation",
  renter_graduation: "rental_to_buyer_graduation",
  rental_to_buyer: "rental_to_buyer_graduation",
  review_acquisition: "review_acquisition_intent",
  review_intent: "review_acquisition_intent",
  reputation_acquisition: "review_acquisition_intent",
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

/**
 * The per-source vendor CONTRACT, READ AT RUNTIME since lane 82B (scraping unfrozen, wave 82):
 * `vendorForSource` below resolves a channel/alias through this map, and
 * lib/lead-pipeline/source-cost-ledger.ts::bookSourceSpend books every scrape's spend on the
 * platform ledger (vendor_usage_tracking) under the vendor THIS map names and usage_type = the
 * SourceKey — replacing the composite "apify_social" row that lumped Apify, Exa, Tavily and the
 * ZenRows Nextdoor pull into one line no lead-cost report could split. The same map drives the
 * ledger-side READER (source-cost-ledger.ts::leadCostBySource, surfaced by
 * app/actions/source-analytics.ts::getSourcePerformance as each source's `vendor`).
 */
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
  craigslist_wanted:    'apify',   // lane 82B — same Craigslist actor task as craigslist_fsbo
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
  email_engagement_intent:    'internal', // first-party — own email_tracking data, no vendor call
  new_construction_intent:    'apify',    // Google search via Apify, same vendor as agent_seeking_phrase_intent
  inbound_email_unknown:      'internal', // first-party — the tenant's own inbound mailbox, no vendor call (the AI classification cost books to ai_tool_usage, not vendor_usage_tracking)
  permit_prelisting_intent:  'exa',      // Exa neural search (owner ruling wave 73: "exa is good at looking for leads like permit")
  // Lane 74D — first-party: the contact this repo already owns, no vendor call.
  rental_to_buyer_graduation: 'internal',
  // Lane 74D — contract owner is ZenRows (Zyte configured-key fallback, same posture as
  // realty_site_chatter above); 'zyte' is a distinct union member so the ledger can attribute a
  // run that actually fell back, without this contract map pretending to know which provider
  // serves any given call.
  review_acquisition_intent: 'zenrows',
  batchdata_cash_buyer:      'batchdata', // lane 82B — Property Search on the 'cash-buyer' quickList
}

/**
 * Lane 82B — THE ledger-side reader of SOURCE_VENDOR. Resolves any spelling the scrapers write
 * (canonical key, alias, or cron channel such as "zillow" / "craigslist_wanted") to the vendor the
 * contract names; null when the channel has no SourceKey at all (the caller books it under its own
 * name and flags it, never under a guessed vendor).
 */
export function vendorForSource(source: string): ScrapeVendor | null {
  const key = resolveSourceKey(source)
  return key in SOURCE_VENDOR ? SOURCE_VENDOR[key] : null
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
  // Lane 82B — its OWN gate token: the Marketplace property-for-sale lane (social-sourcer.ts::
  // sourceFacebookMarketplace) is a DISTINCT Apify task from group-post monitoring, so a market
  // opts into it by name rather than inheriting it from "facebook" (never merge look-alike lanes).
  facebook_marketplace: 'facebook_marketplace',
  instagram_intent:     'instagram',
  reddit_intent:        'reddit',
  craigslist_fsbo:      'craigslist',
  craigslist_wanted:    'craigslist', // lane 82B — runs inside the same Craigslist block
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
  email_engagement_intent:    'email_engagement_intent',
  new_construction_intent:    'new_construction_intent',
  inbound_email_unknown:      'inbound_email_unknown',
  permit_prelisting_intent:  'permit_prelisting_intent',
  rental_to_buyer_graduation: 'rental_to_buyer_graduation',
  review_acquisition_intent: 'review_acquisition_intent',
  batchdata_cash_buyer:      'batchdata_cash_buyer',
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

// ─── buildNewConstructionPhrases ────────────────────────────────────────────────
// DISTINCT from buildAgentSeekingPhrases (shopping for an AGENT) and buildTerritoryPhrases
// (generic buyer/seller listing search): this builds the new-construction / builder-shopper
// phrase set the new_construction_intent lane (lane 72C, docs/lead-acquisition-coverage-2026-09.md
// item #23) runs against a territory.

export interface NewConstructionPhrases {
  phrases: string[]
}

export function buildNewConstructionPhrases(market: {
  city?:      string | null
  state?:     string | null
  zip_codes?: string[] | null
  counties?:  string[] | null
}): NewConstructionPhrases {
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
      `new construction homes for sale ${loc}`,
      `new home communities ${loc}`,
      `builder incentives ${loc}`,
      `move in ready new construction ${loc}`,
      `new build homes ${loc}`,
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
