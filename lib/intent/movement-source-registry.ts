// lib/intent/movement-source-registry.ts
//
// THE MOVEMENT SIGNAL SOURCE REGISTRY (wave 147, lane 147B — owner rulings 3 + 4, contract C9). Pure data, no I/O.
//
// Owner, 2026-10-31: "Life changes include divorce, probate, relocation, posts about looking for an agent — it is also a real
// estate event. There has to be a way to gain this info accurately." and "use AI or ways to find online behaviour outside a real
// estate business activity to determine when a person is ready or starting the process of moving before anyone else knows."
//
// WHAT THIS IS. One row per place a movement signal can come from, saying — for each — what KIND of source it is, how it is
// obtained ACCURATELY and PERMISSIBLY, its licence and storage posture, the consent it needs, whether it pushes or must be polled,
// how fresh it can honestly be, what it costs, and the highest epistemic class its evidence can ever carry. A source never decides
// what to do (the manager / arbiter does — lib/intent/movement-signals.ts decideMovementNextAction); it only says what it can know.
//
// IT COMPOSES THE SURVIVORS (LAW 1 / LAW 2 — never a fourth census). Rows LINK to the survivor that already owns the source:
//   provider fields   lib/enrichment/intent-signal-sources.ts INTENT_SIGNAL_SOURCES (wave 144E — provider / capability / field /
//                     docs are READ from that row, never restated; the overlay below adds only the movement governance)
//   acquisition       lib/lead-pipeline/source-intent-map.ts SourceKey / SOURCE_VENDOR (the scraping lanes)
//   first-party       lib/enrichment/first-party-intent-watcher.ts families + the first-party tables (scripts/schema-snapshot.ts)
//   public records    lib/external/permit-signals.ts (Socrata / ArcGIS), lib/external/socrata-market-registry.ts (verified datasets)
//   life events       lib/enrichment/web-mention-search.ts (Exa: name + term co-occur, URL kept)
//   market            lib/kernel/equity-trigger.ts (rates / equity), lib/predictive-listing/signal-generators.ts (neighbour sold)
// scripts/movement-signals-guard.ts proves every INTENT_SIGNAL_SOURCES key and every intent-bearing acquisition SourceKey is either
// a registry row here or excluded below with its reason — derived from the survivors, never a hardcoded count.
//
// LEGAL / TERMS FACTS are stated with their source and date; nothing here is a universal legal rule. Where the law varies by state
// the row says "varies by state — counsel / broker policy", and the next action for that topic is a PERSON (decideMovementNextAction).

import { INTENT_SIGNAL_SOURCES, type IntentKind } from "@/lib/enrichment/intent-signal-sources"
import type { SourceKey } from "@/lib/lead-pipeline/source-intent-map"

// ── vocabularies (contract C9 — one spelling each, CLAUDE.md §6) ─────────────────────────────────────────────────────────────

/** How we know. ORDERED: a source's ceiling is the highest class its evidence may ever carry. */
export const EPISTEMIC_CLASSES = Object.freeze(["verified", "reported", "inferred", "unknown"] as const)
export type EpistemicClass = (typeof EPISTEMIC_CLASSES)[number]
export const EPISTEMIC_RANK: Readonly<Record<EpistemicClass, number>> = Object.freeze({ verified: 3, reported: 2, inferred: 1, unknown: 0 })

/** What real-estate event the evidence bears on (C9 event_relevance). */
export const MOVEMENT_RELEVANCE = Object.freeze(["divorce", "probate_estate", "relocation", "seeking_agent", "life_stage", "property_event", "market_event", "community_change"] as const)
export type MovementRelevance = (typeof MOVEMENT_RELEVANCE)[number]

/** Life events that are a person's own business: only a PUBLIC record / the person's own disclosure may establish them — never an
 *  inference from behaviour — and only a PERSON answers them (never an automated message about the event, never a segment). */
export const INTIMATE_RELEVANCE: ReadonlySet<MovementRelevance> = new Set(["divorce", "probate_estate"])

/** Context, never a person-level trigger on its own (a new employer HQ does not mean any one person is moving). */
export const CONTEXT_RELEVANCE: ReadonlySet<MovementRelevance> = new Set(["market_event", "community_change"])

/** The five source kinds of the brief (requirement 1). */
export const MOVEMENT_SOURCE_KINDS = Object.freeze(["first_party_behaviour", "property_public_record", "public_post", "provider_observation", "community_market_event"] as const)
export type MovementSourceKind = (typeof MOVEMENT_SOURCE_KINDS)[number]

/** Cheapest first (owner ruling 4: "platform-paid and free public sources before buying enrichment"). ORDERED. */
export const COST_CLASSES = Object.freeze(["free_first_party", "free_public", "platform_paid", "paid_enrichment", "contract_required"] as const)
export type CostClass = (typeof COST_CLASSES)[number]

export type Delivery =
  /** Written at the person's / staff's own action on our surfaces — read on the enrichment-processor tick. */
  | "realtime_write"
  /** The provider pushes (webhook). */
  | "push"
  /** No push exists — poll-and-diff (lib/intent/movement-source-watcher.ts) with a published freshness promise. */
  | "poll"
  /** Our own enrichment buys it gap-only; the vendor does not push. */
  | "on_demand"
  /** A person records it (automated collection is not permitted for this source). */
  | "manual"

export type CollectionBasis =
  | "first_party"                 // the tenant's own surfaces, under its privacy notice
  | "open_data"                   // a government open-data portal (public, published for reuse)
  | "licensed_api"                // a vendor / MLS API under a licence the platform holds
  | "public_web_search"           // a search-engine API over PUBLIC pages (read the page; any reply is a person, on-platform)
  | "platform_scrape_contested"   // automated collection from a platform whose terms restrict it — recorded, never automated outreach
  | "manual_only"                 // content behind a login / terms that forbid automated capture: a person may record what they saw
  | "contract_required"           // usable only once a licence / processing agreement exists (WAITING_EXTERNAL)
  | "not_permitted"               // standard terms do not permit our multi-tenant use

export type SourceStatus = "live" | "configuration_only" | "waiting_external" | "manual_only"

export type StrengthTier = "strong" | "moderate" | "weak" | "context"

export interface MovementLicence {
  collection: CollectionBasis
  /** The terms, verbatim or summarised, with where / when read. */
  terms: string
  /** May the fact be persisted on a tenant's record? */
  storage: "first_party" | "open_data_reuse" | "vendor_terms_restrict_caching" | "platform_terms" | "contract"
  /** Outreach the source itself permits (the person-level consent gates still apply on top). */
  outreach: "per_consent" | "none_automated" | "address_correction_only"
}

export type SurvivorLink =
  | { kind: "intent_signal_source"; key: string }
  | { kind: "acquisition_source"; key: SourceKey }
  | { kind: "first_party_table"; table: string; family?: "search" | "portal" | "calculator" | "valuation" | "magnet" | "stated" | "event" }
  | { kind: "public_record"; module: string }
  | { kind: "market"; module: string }
  | { kind: "none"; reason: string }

export interface MovementSignalSource {
  key: string
  kind: MovementSourceKind
  survivor: SurvivorLink
  relevance: readonly MovementRelevance[]
  intents: readonly IntentKind[]
  /** The highest epistemic class this source's evidence may carry (a modeled indicator is never "verified"). */
  maxConfidence: EpistemicClass
  /** The source names or proxies a protected characteristic (familial / marital status, age): stored for research, never targeting. */
  protectedProxy: boolean
  delivery: Delivery
  /** Poll cadence in minutes (poll sources); null for push / realtime / manual. */
  cadenceMinutes: number | null
  /** The source's own publication lag on top of our cadence, in minutes (null = not published — said, never guessed). */
  providerLatencyMinutes: number | null
  /** The cadence in words, honest (never "real-time" unless written at the person's action). */
  freshness: string
  /** How long a fact from this source keeps half its weight (the combination's recency decay). */
  halfLifeDays: number
  strength: StrengthTier
  costClass: CostClass
  licence: MovementLicence
  /** The consent the source needs before a fact may be RECORDED against a person. */
  consent: string
  /** How it is obtained ACCURATELY and PERMISSIBLY — the "write down how" of the brief. */
  howObtained: string
  status: SourceStatus
}

const FP_LICENCE: MovementLicence = { collection: "first_party", terms: "the tenant's own surfaces under its privacy notice; the person acted on them", storage: "first_party", outreach: "per_consent" }
const FP_CONSENT = "the person is identified by their OWN action (signed-in portal, form, saved search) — an anonymous visitor is never recorded as a person"
const OPEN_DATA_LICENCE = (what: string): MovementLicence => ({ collection: "open_data", terms: `${what} — published by the issuing government for public reuse`, storage: "open_data_reuse", outreach: "per_consent" })
const VENDOR_PROVIDER_LICENCE = (vendor: "versium" | "peopledata" | "batchdata" | "osint" | "rentcast" | "first_party"): MovementLicence => {
  if (vendor === "versium") return { collection: "licensed_api", terms: "Versium standard terms §3.3(j): may not cache data or build a database from it; §7.3 destroy on termination (docs/commercial/CUSTOMER-360-PROVIDER-COMPARISON.md §4, read 2026-10-29) — persisted today under vendor_licensed labelling pending the owner's Ordering Document", storage: "vendor_terms_restrict_caching", outreach: "per_consent" }
  if (vendor === "peopledata") return { collection: "licensed_api", terms: "PDL: cached data no longer than necessary, display to one End User, delete on termination; no FCRA purposes (comparison doc §4) — persisted under vendor_licensed labelling pending an Enterprise licence", storage: "vendor_terms_restrict_caching", outreach: "per_consent" }
  if (vendor === "batchdata") return { collection: "licensed_api", terms: "BatchData property search / quickLists under the platform's API agreement (vendor-compiled public records)", storage: "contract", outreach: "per_consent" }
  if (vendor === "osint") return { collection: "public_web_search", terms: "public web pages read through a search API (Exa first, ZenRows fallback — lib/enrichment/web-mention-search.ts); the page's own copyright stays with its publisher: we keep the FACT + URL, never republish the text", storage: "platform_terms", outreach: "per_consent" }
  if (vendor === "rentcast") return { collection: "licensed_api", terms: "RentCast API under the platform's subscription", storage: "contract", outreach: "per_consent" }
  return FP_LICENCE
}
const CONTESTED = (platform: string, terms: string): MovementLicence => ({
  collection: "platform_scrape_contested",
  terms: `${platform}: ${terms}. Recorded as a lead-desk research fact only; no automated outreach rides it — an agent may answer the public post personally, on the platform, as themselves.`,
  storage: "platform_terms", outreach: "none_automated",
})

// ── 1. FIRST-PARTY CONSENTED BEHAVIOUR ────────────────────────────────────────────────────────────────────────────────────────
const FIRST_PARTY: readonly MovementSignalSource[] = [
  { key: "fp_saved_homes", kind: "first_party_behaviour", survivor: { kind: "first_party_table", table: "saved_properties", family: "search" }, relevance: ["property_event"], intents: ["home_purchase"], maxConfidence: "verified", protectedProxy: false, delivery: "realtime_write", cadenceMinutes: null, providerLatencyMinutes: 0, freshness: "written at the save; read on the 15-minute enrichment-processor tick (first-party watcher)", halfLifeDays: 30, strength: "moderate", costClass: "free_first_party", licence: FP_LICENCE, consent: FP_CONSENT, howObtained: "the person saved a home in the portal / site search — our own row (saved_properties); the watcher routes a START or RESUMPTION, never every click", status: "live" },
  { key: "fp_repeat_property_views", kind: "first_party_behaviour", survivor: { kind: "first_party_table", table: "property_views", family: "search" }, relevance: ["property_event"], intents: ["home_purchase"], maxConfidence: "verified", protectedProxy: false, delivery: "realtime_write", cadenceMinutes: null, providerLatencyMinutes: 0, freshness: "written at the view; read on the 15-minute tick", halfLifeDays: 21, strength: "weak", costClass: "free_first_party", licence: FP_LICENCE, consent: FP_CONSENT, howObtained: "repeat views of a listing by an identified person on our surfaces (property_views keeps one aggregate row per person × property)", status: "live" },
  { key: "fp_site_sessions", kind: "first_party_behaviour", survivor: { kind: "first_party_table", table: "website_visitors", family: "search" }, relevance: ["property_event"], intents: ["home_purchase", "home_sale"], maxConfidence: "verified", protectedProxy: false, delivery: "realtime_write", cadenceMinutes: null, providerLatencyMinutes: 0, freshness: "written per site session; read on the 15-minute tick", halfLifeDays: 14, strength: "weak", costClass: "free_first_party", licence: FP_LICENCE, consent: "only sessions tied to an identified contact / lead (website_visitors.contact_id / lead_id) — an anonymous session is never a person", howObtained: "the tenant site's own visitor rows once the visitor identified themselves", status: "live" },
  { key: "fp_portal_resumed", kind: "first_party_behaviour", survivor: { kind: "first_party_table", table: "client_portal_activity", family: "portal" }, relevance: ["property_event"], intents: ["home_purchase", "home_sale"], maxConfidence: "verified", protectedProxy: false, delivery: "realtime_write", cadenceMinutes: null, providerLatencyMinutes: 0, freshness: "written at each portal visit; read on the 15-minute tick", halfLifeDays: 30, strength: "moderate", costClass: "free_first_party", licence: FP_LICENCE, consent: FP_CONSENT, howObtained: "a signed-in client returned to their portal after the tenant's dormancy window (first-party watcher `portal_activity_resumed`)", status: "live" },
  { key: "fp_valuation_request", kind: "first_party_behaviour", survivor: { kind: "intent_signal_source", key: "home_value_request" }, relevance: ["property_event"], intents: ["home_sale", "refinance"], maxConfidence: "verified", protectedProxy: false, delivery: "realtime_write", cadenceMinutes: null, providerLatencyMinutes: 0, freshness: "written at the request (valuation_requests); the home_value_seller_intent signal fires at once", halfLifeDays: 60, strength: "strong", costClass: "free_first_party", licence: FP_LICENCE, consent: "the person submitted the home-value form (their consent wording rides contract C8)", howObtained: "the homeowner asked 'what is my home worth?' on the tenant's tool — the strongest inbound seller action", status: "live" },
  { key: "fp_calc_seller_net", kind: "first_party_behaviour", survivor: { kind: "first_party_table", table: "calculator_history", family: "calculator" }, relevance: ["property_event"], intents: ["home_sale"], maxConfidence: "verified", protectedProxy: false, delivery: "realtime_write", cadenceMinutes: null, providerLatencyMinutes: 0, freshness: "written at the calculation (tenant stamped by calculator_history_set_brokerage_trg, verified live 2026-10-31); read by the movement watcher's stored-row poll", halfLifeDays: 45, strength: "strong", costClass: "free_first_party", licence: FP_LICENCE, consent: FP_CONSENT, howObtained: "the person ran the seller net-proceeds calculator (calculator_type seller_net) in their portal — they are working out what they would walk away with", status: "live" },
  { key: "fp_calc_moving_cost", kind: "first_party_behaviour", survivor: { kind: "first_party_table", table: "calculator_history", family: "calculator" }, relevance: ["relocation"], intents: ["moving"], maxConfidence: "verified", protectedProxy: false, delivery: "realtime_write", cadenceMinutes: null, providerLatencyMinutes: 0, freshness: "as fp_calc_seller_net", halfLifeDays: 45, strength: "strong", costClass: "free_first_party", licence: FP_LICENCE, consent: FP_CONSENT, howObtained: "the person priced a move with the moving-cost calculator (calculator_type moving_cost)", status: "live" },
  { key: "fp_calc_neighborhood_compare", kind: "first_party_behaviour", survivor: { kind: "first_party_table", table: "calculator_history", family: "calculator" }, relevance: ["relocation"], intents: ["moving", "home_purchase"], maxConfidence: "verified", protectedProxy: false, delivery: "realtime_write", cadenceMinutes: null, providerLatencyMinutes: 0, freshness: "as fp_calc_seller_net", halfLifeDays: 30, strength: "moderate", costClass: "free_first_party", licence: FP_LICENCE, consent: FP_CONSENT, howObtained: "the person compared neighbourhoods (calculator_type neighborhood_compare) — a new area compared is a material change", status: "live" },
  { key: "fp_calc_mortgage_comparison", kind: "first_party_behaviour", survivor: { kind: "first_party_table", table: "calculator_history", family: "calculator" }, relevance: ["property_event"], intents: ["home_purchase", "refinance"], maxConfidence: "verified", protectedProxy: false, delivery: "realtime_write", cadenceMinutes: null, providerLatencyMinutes: 0, freshness: "as fp_calc_seller_net", halfLifeDays: 30, strength: "moderate", costClass: "free_first_party", licence: FP_LICENCE, consent: FP_CONSENT, howObtained: "the person compared mortgage options (calculator_type mortgage_comparison) — affordability work", status: "live" },
  { key: "fp_calc_investment", kind: "first_party_behaviour", survivor: { kind: "first_party_table", table: "calculator_history", family: "calculator" }, relevance: ["property_event"], intents: ["home_purchase"], maxConfidence: "verified", protectedProxy: false, delivery: "realtime_write", cadenceMinutes: null, providerLatencyMinutes: 0, freshness: "as fp_calc_seller_net", halfLifeDays: 30, strength: "weak", costClass: "free_first_party", licence: FP_LICENCE, consent: FP_CONSENT, howObtained: "the person analysed an investment property (calculator_type investment_analyzer)", status: "live" },
  { key: "fp_relocation_guide", kind: "first_party_behaviour", survivor: { kind: "first_party_table", table: "lead_magnet_promises", family: "magnet" }, relevance: ["relocation"], intents: ["moving"], maxConfidence: "verified", protectedProxy: false, delivery: "realtime_write", cadenceMinutes: null, providerLatencyMinutes: 0, freshness: "written at the request (contract C4 promise ledger)", halfLifeDays: 60, strength: "moderate", costClass: "free_first_party", licence: FP_LICENCE, consent: "the person requested the guide on a consented form (contract C8)", howObtained: "the person asked for a relocation guide / moving checklist lead magnet", status: "live" },
  { key: "fp_next_move_tap", kind: "first_party_behaviour", survivor: { kind: "first_party_table", table: "manager_signals", family: "stated" }, relevance: ["relocation", "property_event"], intents: ["moving", "home_sale", "home_purchase", "refinance"], maxConfidence: "verified", protectedProxy: false, delivery: "realtime_write", cadenceMinutes: null, providerLatencyMinutes: 0, freshness: "written at the tap (next_move_intent / relocation_referral_request)", halfLifeDays: 90, strength: "strong", costClass: "free_first_party", licence: FP_LICENCE, consent: "the client chose the option themselves in their portal", howObtained: "a lifetime client tapped 'Your Next Move' (move up / right-size / relocate) — client-initiated, the cleanest signal there is", status: "live" },
  { key: "fp_inbound_stated", kind: "first_party_behaviour", survivor: { kind: "first_party_table", table: "agent_client_messages", family: "stated" }, relevance: ["relocation", "property_event", "seeking_agent", "life_stage"], intents: ["moving", "home_sale", "home_purchase"], maxConfidence: "reported", protectedProxy: false, delivery: "realtime_write", cadenceMinutes: null, providerLatencyMinutes: 0, freshness: "written when the message arrives (contract C1 inbound record)", halfLifeDays: 60, strength: "strong", costClass: "free_first_party", licence: FP_LICENCE, consent: "the person wrote to us", howObtained: "the person TOLD us (\"we're thinking about moving next year\") — self-reported, so it is `reported`, not `verified`; the inbound responder (C1) answers the message itself", status: "live" },
  { key: "fp_open_house_checkin", kind: "first_party_behaviour", survivor: { kind: "first_party_table", table: "open_house_attendees", family: "event" }, relevance: ["property_event"], intents: ["home_purchase"], maxConfidence: "verified", protectedProxy: false, delivery: "realtime_write", cadenceMinutes: null, providerLatencyMinutes: 0, freshness: "written at sign-in (lane 147F owns the check-in writers)", halfLifeDays: 30, strength: "moderate", costClass: "free_first_party", licence: FP_LICENCE, consent: "the attendee signed in with the event's consent wording (C8)", howObtained: "an identified person signed in at an open house", status: "live" },
]

// ── 2. PROPERTY / PUBLIC RECORD ───────────────────────────────────────────────────────────────────────────────────────────────
const PUBLIC_RECORD: readonly MovementSignalSource[] = [
  { key: "pr_permit_activity", kind: "property_public_record", survivor: { kind: "public_record", module: "lib/external/permit-signals.ts (signal_type permit_activity)" }, relevance: ["property_event"], intents: ["home_sale"], maxConfidence: "verified", protectedProxy: false, delivery: "poll", cadenceMinutes: 60, providerLatencyMinutes: 1440, freshness: "the permit sweep polls each VERIFIED city dataset daily; the movement watcher diffs the stored rows hourly", halfLifeDays: 120, strength: "moderate", costClass: "free_public", licence: OPEN_DATA_LICENCE("city / county building-permit datasets (Socrata SODA, ArcGIS FeatureServer) listed with verifiedOn in lib/external/socrata-market-registry.ts"), consent: "public record — recorded against a person only when the permit address matches a lead / contact the brokerage already owns (permit-signals matchPermitsToLeads); never mints a person", howObtained: "issued building permits (kitchen, roof, paint, repairs) — the pre-listing tell a neighbour notices; read from the issuing city's open-data portal", status: "live" },
  { key: "pr_code_violation", kind: "property_public_record", survivor: { kind: "public_record", module: "lib/external/permit-signals.ts (signal_type code_violation)" }, relevance: ["property_event"], intents: ["home_sale"], maxConfidence: "verified", protectedProxy: false, delivery: "poll", cadenceMinutes: 60, providerLatencyMinutes: 1440, freshness: "as pr_permit_activity", halfLifeDays: 120, strength: "weak", costClass: "free_public", licence: OPEN_DATA_LICENCE("city code-violation datasets"), consent: "as pr_permit_activity", howObtained: "code-violation notices on an owned address — pressure, not intent; weak alone", status: "live" },
  { key: "pr_batchdata_quicklist", kind: "property_public_record", survivor: { kind: "intent_signal_source", key: "batchdata_seller_signal" }, relevance: ["property_event", "probate_estate"], intents: ["home_sale"], maxConfidence: "reported", protectedProxy: false, delivery: "poll", cadenceMinutes: 60, providerLatencyMinutes: null, freshness: "polled property-search quickLists (pre-foreclosure, vacant, tax-default, inherited, expired / withdrawn, absentee, high-equity); vendor publication lag is not published; the Property Subscription push is WAITING_EXTERNAL", halfLifeDays: 90, strength: "moderate", costClass: "paid_enrichment", licence: VENDOR_PROVIDER_LICENCE("batchdata"), consent: "property record; attached to an owned lead / contact or a raw lead under the raw-lead gates", howObtained: "a vendor compilation of county recorder / assessor / court records — `reported` (we did not read the issuing record ourselves); 'inherited' maps to probate_estate", status: "live" },
  { key: "pr_probate_open_data", kind: "property_public_record", survivor: { kind: "public_record", module: "lib/external/socrata-market-registry.ts (kind probate)" }, relevance: ["probate_estate"], intents: ["home_sale"], maxConfidence: "verified", protectedProxy: false, delivery: "poll", cadenceMinutes: 1440, providerLatencyMinutes: null, freshness: "only for a probate dataset VERIFIED in the market registry (none verified as of 2026-10-31 — configuration-only); court publication lag varies by county", halfLifeDays: 180, strength: "strong", costClass: "free_public", licence: OPEN_DATA_LICENCE("a county probate-filing dataset published on an open-data portal"), consent: "public court record; a solicitation rule for estates varies by state — the next action is always a person", howObtained: "probate case filings (decedent, personal representative, property) from a county open-data feed; where a court only offers a name search, a person looks it up — bulk automated access to a court portal needs that court's permission", status: "configuration_only" },
  { key: "pr_property_transfer_open_data", kind: "property_public_record", survivor: { kind: "public_record", module: "lib/external/socrata-market-registry.ts (kind property_transfers)" }, relevance: ["property_event"], intents: ["home_sale", "home_purchase"], maxConfidence: "verified", protectedProxy: false, delivery: "poll", cadenceMinutes: 1440, providerLatencyMinutes: null, freshness: "only for a transfer / deed dataset VERIFIED in the market registry (none as of 2026-10-31)", halfLifeDays: 90, strength: "moderate", costClass: "free_public", licence: OPEN_DATA_LICENCE("a county deed / transfer dataset"), consent: "public record", howObtained: "recorded deeds and transfers (a purchase elsewhere by an owner we know is a strong move tell)", status: "configuration_only" },
  { key: "pr_street_use_permit", kind: "property_public_record", survivor: { kind: "public_record", module: "lib/external/socrata-client.ts socrataQuery (no verified dataset registered)" }, relevance: ["relocation", "property_event"], intents: ["moving"], maxConfidence: "verified", protectedProxy: false, delivery: "poll", cadenceMinutes: 1440, providerLatencyMinutes: null, freshness: "configuration-only until a city's street-use / right-of-way permit dataset is VERIFIED in the market registry", halfLifeDays: 30, strength: "moderate", costClass: "free_public", licence: OPEN_DATA_LICENCE("city street-use / right-of-way permits (dumpster, roll-off container, moving van, storage pod on the street)"), consent: "public record; attached only to an owned person by address", howObtained: "THE DUMPSTER: many cities require a street-use permit for a dumpster or a moving container on the street and publish those permits as open data — a neighbour's tell made lawful", status: "configuration_only" },
  { key: "pr_mls_status_change", kind: "property_public_record", survivor: { kind: "first_party_table", table: "listings" }, relevance: ["property_event"], intents: ["home_sale"], maxConfidence: "verified", protectedProxy: false, delivery: "poll", cadenceMinutes: 60, providerLatencyMinutes: null, freshness: "the MLS / IDX feed sync cadence (listing status); expired / withdrawn / cancelled is verified by the MLS", halfLifeDays: 60, strength: "strong", costClass: "free_first_party", licence: { collection: "licensed_api", terms: "the brokerage's MLS / IDX licence; each MLS's rules govern display and use, and expired-listing calls stay under DNC / TCPA (lib/providers/dispatch.ts)", storage: "contract", outreach: "per_consent" }, consent: "MLS record; outreach to an owner under DNC / TCPA gates", howObtained: "a listing expired / was withdrawn / was cancelled on the MLS (LIFE_CHANGE_SIGNAL_KINDS listing_expired)", status: "live" },
  { key: "pr_fsbo_listing", kind: "property_public_record", survivor: { kind: "acquisition_source", key: "fsbo_site_listing" }, relevance: ["property_event"], intents: ["home_sale"], maxConfidence: "reported", protectedProxy: false, delivery: "poll", cadenceMinutes: 1440, providerLatencyMinutes: null, freshness: "the acquisition sweep's cadence (Apify task)", halfLifeDays: 30, strength: "strong", costClass: "platform_paid", licence: CONTESTED("forsalebyowner.com / Craigslist", "site terms restrict automated collection"), consent: "the owner published their own listing; a raw lead under the raw-lead gates", howObtained: "an owner listed their own home for sale — self-published, so `reported`", status: "live" },
  { key: "pr_owner_rental_listing", kind: "property_public_record", survivor: { kind: "acquisition_source", key: "rental_listing" }, relevance: ["relocation", "property_event"], intents: ["moving"], maxConfidence: "inferred", protectedProxy: false, delivery: "poll", cadenceMinutes: 1440, providerLatencyMinutes: null, freshness: "the acquisition sweep's cadence", halfLifeDays: 30, strength: "weak", costClass: "platform_paid", licence: CONTESTED("Craigslist housing", "terms of use prohibit automated collection"), consent: "a raw lead under the raw-lead gates", howObtained: "an owner listing their own home for RENT may be moving out — an inference (`inferred`), weak alone", status: "live" },
  { key: "pr_estate_sale_listing", kind: "property_public_record", survivor: { kind: "none", reason: "no estate-sale listing source is integrated; the public sites (estate-sale directories) restrict automated collection and offer no API" }, relevance: ["property_event"], intents: ["home_sale"], maxConfidence: "reported", protectedProxy: false, delivery: "manual", cadenceMinutes: null, providerLatencyMinutes: null, freshness: "when a person records it", halfLifeDays: 45, strength: "moderate", costClass: "free_public", licence: { collection: "manual_only", terms: "estate-sale directory sites list sales publicly but their terms restrict automated collection; a person may note a sale they saw", storage: "platform_terms", outreach: "per_consent" }, consent: "attached only to a person the brokerage already knows at that address", howObtained: "THE ESTATE-SALE SIGN: an agent notices a public estate-sale listing at an address they know and records it — never an assumption about why (a death, a downsizing or a move all look the same)", status: "manual_only" },
]

// ── 3. PUBLIC POSTS ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const PUBLIC_POSTS: readonly MovementSignalSource[] = [
  { key: "pp_agent_seeking_phrase", kind: "public_post", survivor: { kind: "acquisition_source", key: "agent_seeking_phrase_intent" }, relevance: ["seeking_agent"], intents: ["home_purchase", "home_sale"], maxConfidence: "reported", protectedProxy: false, delivery: "poll", cadenceMinutes: 1440, providerLatencyMinutes: null, freshness: "the acquisition sweep's cadence; the post's own date bounds it (SOURCE_RECENCY)", halfLifeDays: 21, strength: "strong", costClass: "platform_paid", licence: { collection: "public_web_search", terms: "a search-engine query over PUBLIC pages for 'looking for a realtor / agent in <territory>' (Apify Google search today); we read the result, a person replies on the platform as themselves", storage: "platform_terms", outreach: "per_consent" }, consent: "the author published it publicly; a raw lead under the raw-lead gates until identity + consent", howObtained: "\"Can anyone recommend a realtor in <town>?\" — the person announced it themselves; `reported` (self) once the AI classifier confirms the author is asking for themselves with a verbatim quote", status: "live" },
  { key: "pp_reddit_relocation", kind: "public_post", survivor: { kind: "acquisition_source", key: "reddit_relocation" }, relevance: ["relocation", "seeking_agent"], intents: ["moving", "home_purchase"], maxConfidence: "reported", protectedProxy: false, delivery: "poll", cadenceMinutes: 1440, providerLatencyMinutes: null, freshness: "the acquisition sweep's cadence", halfLifeDays: 30, strength: "moderate", costClass: "platform_paid", licence: CONTESTED("Reddit", "the User Agreement and Data API Terms (2023) require Reddit's agreement for commercial data access; collection today is an Apify actor"), consent: "a raw lead under the raw-lead gates", howObtained: "\"Moving to <city> in the spring — which neighbourhoods?\" in a city subreddit", status: "live" },
  { key: "pp_facebook_recommend_realtor", kind: "public_post", survivor: { kind: "acquisition_source", key: "facebook_recommend_realtor" }, relevance: ["seeking_agent"], intents: ["home_purchase", "home_sale"], maxConfidence: "reported", protectedProxy: false, delivery: "poll", cadenceMinutes: 1440, providerLatencyMinutes: null, freshness: "the acquisition sweep's cadence", halfLifeDays: 21, strength: "strong", costClass: "platform_paid", licence: CONTESTED("Facebook groups", "Meta's terms prohibit automated collection without permission; Meta v. Bright Data (N.D. Cal., Jan 2024) held Meta's terms did not bar LOGGED-OUT scraping of public data — a PRIVATE group is not public"), consent: "a raw lead under the raw-lead gates", howObtained: "a 'recommend a realtor' thread in a public community group; the permissible human path is the agent, a member of the group, answering in the thread", status: "live" },
  { key: "pp_linkedin_relocation", kind: "public_post", survivor: { kind: "acquisition_source", key: "linkedin_relocation" }, relevance: ["relocation", "life_stage"], intents: ["moving"], maxConfidence: "reported", protectedProxy: false, delivery: "poll", cadenceMinutes: 1440, providerLatencyMinutes: null, freshness: "the acquisition sweep's cadence", halfLifeDays: 45, strength: "moderate", costClass: "platform_paid", licence: CONTESTED("LinkedIn", "the User Agreement prohibits scraping; hiQ v. LinkedIn (9th Cir. 2022) found public-data scraping likely not a CFAA violation, but on remand (N.D. Cal., Nov 2022) hiQ was held to have breached the User Agreement"), consent: "a raw lead under the raw-lead gates", howObtained: "\"Excited to start my new role in <city>\" — a self-announced job move; the licensed equivalent is PeopleData's job_change field", status: "live" },
  { key: "pp_nextdoor", kind: "public_post", survivor: { kind: "acquisition_source", key: "nextdoor_intent" }, relevance: ["seeking_agent", "relocation"], intents: ["home_sale", "home_purchase"], maxConfidence: "reported", protectedProxy: false, delivery: "manual", cadenceMinutes: null, providerLatencyMinutes: null, freshness: "when a person records it", halfLifeDays: 21, strength: "strong", costClass: "free_public", licence: { collection: "manual_only", terms: "Nextdoor content is shown to signed-in, address-verified neighbours; automated capture behind a login is not permitted — an agent who is a verified neighbour may record a post they saw", storage: "platform_terms", outreach: "none_automated" }, consent: "a person records it; no automated outreach", howObtained: "the 'who do you recommend to sell our house?' neighbourhood post — read by an agent who lives there", status: "manual_only" },
  { key: "pp_tenant_own_pages", kind: "public_post", survivor: { kind: "acquisition_source", key: "review_acquisition_intent" }, relevance: ["seeking_agent"], intents: ["home_purchase", "home_sale"], maxConfidence: "reported", protectedProxy: false, delivery: "poll", cadenceMinutes: 1440, providerLatencyMinutes: null, freshness: "the review sweep's cadence", halfLifeDays: 30, strength: "strong", costClass: "platform_paid", licence: { collection: "public_web_search", terms: "comments on the TENANT'S OWN public Google Business / Zillow / Facebook pages", storage: "platform_terms", outreach: "per_consent" }, consent: "the person wrote on the tenant's own page; a name-matched contact is routed, an unmatched writer is a raw lead", howObtained: "a real-estate question left on the brokerage's own page", status: "live" },
  { key: "pp_web_mention_life_event", kind: "public_post", survivor: { kind: "intent_signal_source", key: "public_life_event" }, relevance: ["divorce", "probate_estate", "relocation", "life_stage"], intents: ["life_event", "moving", "home_sale"], maxConfidence: "reported", protectedProxy: true, delivery: "on_demand", cadenceMinutes: null, providerLatencyMinutes: null, freshness: "on the life-change re-check (runLifeChangeCheck) — Exa first (~$0.007 / search inside the free monthly credit), ZenRows fallback", halfLifeDays: 180, strength: "moderate", costClass: "platform_paid", licence: VENDOR_PROVIDER_LICENCE("osint"), consent: "public page; recorded only for a person we already know", howObtained: "a public page (an obituary, a court notice, a news item, a relocation announcement) where the contact's FULL NAME and the event term co-occur, URL kept — identity is NAME-ONLY until a person confirms, so it never rides automated outreach; marriage / divorce are marital-status proxies (protected in several states)", status: "live" },
]

// ── 4. PROVIDER OBSERVATIONS — DERIVED from INTENT_SIGNAL_SOURCES (wave 144E); only the movement governance is added here ────────
type ProviderOverlay = Pick<MovementSignalSource, "relevance" | "maxConfidence" | "halfLifeDays" | "strength" | "protectedProxy"> & { howObtained: string }

/** Every provider fact the census names, with its movement reading. A key absent here AND absent from the exclusions is a guard red. */
const PROVIDER_MOVEMENT_OVERLAY: Readonly<Record<string, ProviderOverlay>> = Object.freeze({
  online_real_estate_activity: { relevance: ["property_event"], maxConfidence: "inferred", halfLifeDays: 60, strength: "moderate", protectedProxy: false, howObtained: "Versium's modeled 'Online Presence Indicator – Real Estate' — a vendor MODEL of online real-estate activity, so `inferred`, never a fact about this person" },
  refinance_date: { relevance: ["property_event"], maxConfidence: "reported", halfLifeDays: 365, strength: "weak", protectedProxy: false, howObtained: "Versium's refinance date (vendor-compiled recorder data) — tenure / equity context" },
  mortgage_purchase_date: { relevance: ["property_event"], maxConfidence: "reported", halfLifeDays: 365, strength: "weak", protectedProxy: false, howObtained: "Versium's mortgage purchase date — tenure context (the equity trigger owns the threshold)" },
  length_of_residence: { relevance: ["property_event"], maxConfidence: "inferred", halfLifeDays: 365, strength: "weak", protectedProxy: false, howObtained: "Versium's length of residence (modeled) — long tenure is context, never intent alone" },
  home_sales_transaction: { relevance: ["property_event"], maxConfidence: "reported", halfLifeDays: 180, strength: "moderate", protectedProxy: false, howObtained: "Versium's home-sales transaction flag (vendor-compiled)" },
  investor_activity: { relevance: ["property_event"], maxConfidence: "inferred", halfLifeDays: 120, strength: "weak", protectedProxy: false, howObtained: "Versium's investing-real-estate interest (modeled)" },
  home_improvement_interest: { relevance: ["property_event"], maxConfidence: "inferred", halfLifeDays: 90, strength: "weak", protectedProxy: false, howObtained: "Versium's home-improvement interest (modeled) — a pre-listing tell only in combination" },
  location_history: { relevance: ["relocation"], maxConfidence: "inferred", halfLifeDays: 365, strength: "weak", protectedProxy: false, howObtained: "PeopleData location history — a TALLY of past moves; a history of moving is not a move now" },
  job_change: { relevance: ["life_stage", "relocation"], maxConfidence: "reported", halfLifeDays: 120, strength: "moderate", protectedProxy: false, howObtained: "PeopleData job_start_date / company (the person's public professional profile, licensed) — a new job; a relocation only when another source places it in another metro" },
  batchdata_seller_signal: { relevance: ["property_event", "probate_estate"], maxConfidence: "reported", halfLifeDays: 90, strength: "moderate", protectedProxy: false, howObtained: "see pr_batchdata_quicklist (the same survivor)" },
  public_life_event: { relevance: ["divorce", "probate_estate", "relocation", "life_stage"], maxConfidence: "reported", halfLifeDays: 180, strength: "moderate", protectedProxy: true, howObtained: "see pp_web_mention_life_event (the same survivor)" },
  home_anniversary: { relevance: ["property_event"], maxConfidence: "verified", halfLifeDays: 60, strength: "context", protectedProxy: false, howObtained: "our own closing record's anniversary — a relationship moment and tenure context" },
  home_value_request: { relevance: ["property_event"], maxConfidence: "verified", halfLifeDays: 60, strength: "strong", protectedProxy: false, howObtained: "see fp_valuation_request (the same survivor)" },
})

/** Provider facts that are NOT movement signals, each with why (a guard reads this; never a silent omission). */
export const MOVEMENT_EXCLUDED_INTENT_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  online_audience_matched: "a MATCH fact (the person has linked online identifiers) — an audience fact for the governed ads action (ruling 10), never evidence of a move",
  birthday_month: "AGE — never a movement input (owner: never age stereotyping); cards only",
  birth_date: "AGE — never a movement input; cards only",
})

/** Survivor rows already carried by a first-class row above (one source, one row). */
const CARRIED_BY: Readonly<Record<string, string>> = Object.freeze({ batchdata_seller_signal: "pr_batchdata_quicklist", public_life_event: "pp_web_mention_life_event", home_value_request: "fp_valuation_request" })

const PROVIDER_ROWS: readonly MovementSignalSource[] = INTENT_SIGNAL_SOURCES
  .filter((s) => PROVIDER_MOVEMENT_OVERLAY[s.key] && !CARRIED_BY[s.key])
  .map((s): MovementSignalSource => {
    const o = PROVIDER_MOVEMENT_OVERLAY[s.key]
    const vendor = s.provider
    const firstParty = vendor === "first_party"
    return {
      key: `po_${s.key}`, kind: firstParty ? "first_party_behaviour" : "provider_observation", survivor: { kind: "intent_signal_source", key: s.key },
      relevance: o.relevance, intents: s.intents, maxConfidence: o.maxConfidence, protectedProxy: o.protectedProxy,
      delivery: firstParty ? "realtime_write" : "on_demand", cadenceMinutes: null, providerLatencyMinutes: null,
      freshness: firstParty ? "our own record" : `stored only when OUR budget-gated gap-only enrichment buys it (${s.capability}); the vendor does not push — the 145F fact watcher routes each NEW fact`,
      halfLifeDays: o.halfLifeDays, strength: o.strength, costClass: firstParty ? "free_first_party" : "paid_enrichment",
      licence: VENDOR_PROVIDER_LICENCE(vendor === "osint" ? "osint" : vendor), consent: "a person we already hold (lead / contact); gap-only purchase under the enrichment budget gates",
      howObtained: `${o.howObtained} — field ${s.responseFields.join(" / ")} (${s.docs})`, status: "live",
    }
  })

// ── 5. COMMUNITY / MARKET EVENTS (context — they modify a person's combination, never trigger one alone) ──────────────────────
const COMMUNITY_MARKET: readonly MovementSignalSource[] = [
  { key: "cm_warn_notice", kind: "community_market_event", survivor: { kind: "none", reason: "no WARN-notice adapter or connector is registered; each state labour department publishes in its own format" }, relevance: ["community_change"], intents: ["moving", "home_sale"], maxConfidence: "verified", protectedProxy: false, delivery: "poll", cadenceMinutes: 1440, providerLatencyMinutes: null, freshness: "configuration-only — weekly-to-daily per state once an adapter exists", halfLifeDays: 120, strength: "context", costClass: "free_public", licence: OPEN_DATA_LICENCE("state WARN Act notices (federal WARN Act: 60 days' notice of a plant closing / mass layoff by covered employers, generally 100+ employees; states publish the notices)"), consent: "territory fact — never attached to a person", howObtained: "an employer in the territory filed a closing / layoff notice — context for every owner there, a trigger for no one", status: "configuration_only" },
  { key: "cm_employer_expansion", kind: "community_market_event", survivor: { kind: "none", reason: "classified on request from public news by the AI classifier (classifyPublicMovementText); no standing feed" }, relevance: ["community_change"], intents: ["moving", "home_purchase"], maxConfidence: "reported", protectedProxy: false, delivery: "manual", cadenceMinutes: null, providerLatencyMinutes: null, freshness: "when a person or the market-report research records it", halfLifeDays: 180, strength: "context", costClass: "free_public", licence: { collection: "public_web_search", terms: "economic-development press releases and business-journal articles (fact + URL, never the article text)", storage: "platform_terms", outreach: "per_consent" }, consent: "territory fact", howObtained: "a new HQ / campus / hospital wing announced in the territory — inbound movers and new demand", status: "manual_only" },
  { key: "cm_development_or_rezoning", kind: "community_market_event", survivor: { kind: "none", reason: "planning-commission agendas are not integrated" }, relevance: ["community_change"], intents: ["home_sale", "home_purchase"], maxConfidence: "verified", protectedProxy: false, delivery: "manual", cadenceMinutes: null, providerLatencyMinutes: null, freshness: "when recorded", halfLifeDays: 365, strength: "context", costClass: "free_public", licence: OPEN_DATA_LICENCE("planning-commission / city-council agendas and approvals"), consent: "territory fact", howObtained: "an approved subdivision, rezoning or transit line near a neighbourhood", status: "manual_only" },
  { key: "cm_school_boundary_change", kind: "community_market_event", survivor: { kind: "none", reason: "school-board minutes are not integrated" }, relevance: ["community_change"], intents: ["moving"], maxConfidence: "verified", protectedProxy: false, delivery: "manual", cadenceMinutes: null, providerLatencyMinutes: null, freshness: "when recorded", halfLifeDays: 365, strength: "context", costClass: "free_public", licence: OPEN_DATA_LICENCE("school-board approved attendance-boundary changes"), consent: "territory fact — never a statement about who has children (familial status)", howObtained: "a boundary change approved by the school board — a neighbourhood fact; NEVER used to guess which households have children", status: "manual_only" },
  { key: "cm_rate_move", kind: "community_market_event", survivor: { kind: "market", module: "lib/kernel/equity-trigger.ts (rate-improvement refinance)" }, relevance: ["market_event"], intents: ["refinance", "home_purchase"], maxConfidence: "verified", protectedProxy: false, delivery: "poll", cadenceMinutes: 1440, providerLatencyMinutes: 10080, freshness: "the equity-trigger scan's cadence over the weekly published rate", halfLifeDays: 30, strength: "context", costClass: "free_public", licence: OPEN_DATA_LICENCE("the weekly published average mortgage rate"), consent: "market fact", howObtained: "a meaningful rate move — context for owners with a high rate and buyers on the fence", status: "live" },
  { key: "cm_neighbor_sold_high", kind: "community_market_event", survivor: { kind: "market", module: "lib/predictive-listing/signal-generators.ts runNeighborSoldGenerator" }, relevance: ["market_event"], intents: ["home_sale"], maxConfidence: "verified", protectedProxy: false, delivery: "poll", cadenceMinutes: 1440, providerLatencyMinutes: null, freshness: "the daily predictive-listing scoring run", halfLifeDays: 90, strength: "context", costClass: "free_first_party", licence: FP_LICENCE, consent: "market fact about a nearby sale", howObtained: "a nearby home closed above the owner's estimated value — the 'what did the neighbours get?' moment", status: "live" },
  { key: "cm_local_market_trend", kind: "community_market_event", survivor: { kind: "market", module: "lib/buyer-search/market-watch.ts + market data" }, relevance: ["market_event"], intents: ["home_sale", "home_purchase"], maxConfidence: "verified", protectedProxy: false, delivery: "poll", cadenceMinutes: 1440, providerLatencyMinutes: null, freshness: "the market-data refresh cadence", halfLifeDays: 60, strength: "context", costClass: "free_first_party", licence: FP_LICENCE, consent: "market fact", howObtained: "DOM / price / inventory moving in the owner's ZIP", status: "live" },
]

// ── 6. WAITING_EXTERNAL / NOT PERMITTED ON STANDARD TERMS (listed so the gap is visible; they cannot record) ─────────────────────
const WAITING: readonly MovementSignalSource[] = [
  { key: "we_usps_ncoa", kind: "provider_observation", survivor: { kind: "none", reason: "not built — owner / counsel decision (CUSTOMER-360-PROVIDER-COMPARISON.md §3.6)" }, relevance: ["relocation"], intents: ["moving"], maxConfidence: "verified", protectedProxy: false, delivery: "poll", cadenceMinutes: 129600, providerLatencyMinutes: null, freshness: "quarterly file processing would be typical (TrueNCOA $20 / file)", halfLifeDays: 180, strength: "strong", costClass: "contract_required", licence: { collection: "contract_required", terms: "NCOALink: 'sole purpose … a mailing list correction tool … may not be used to create, generate, or maintain new movers lists'; a Processing Acknowledgement Form per list owner (USPS NCOALink EULA v30, 2026-07-15)", storage: "contract", outreach: "address_correction_only" }, consent: "each tenant's own list, processed as that tenant's list (no pooling)", howObtained: "the authoritative 'moved' fact for people a tenant already serves — never a movers list", status: "waiting_external" },
  { key: "we_pdl_changelog", kind: "provider_observation", survivor: { kind: "none", reason: "not built — needs a batch worker (lane 146D Still open 3)" }, relevance: ["relocation", "life_stage"], intents: ["moving"], maxConfidence: "reported", protectedProxy: false, delivery: "poll", cadenceMinutes: 43200, providerLatencyMinutes: null, freshness: "PDL publishes the Person Changelog monthly / quarterly", halfLifeDays: 120, strength: "moderate", costClass: "contract_required", licence: { collection: "contract_required", terms: "PDL Person Changelog flat files (public bucket) — use is under the PDL licence", storage: "vendor_terms_restrict_caching", outreach: "per_consent" }, consent: "people we already hold", howObtained: "re-buy only profiles whose job / location changed instead of blind re-buys", status: "waiting_external" },
  { key: "we_dealmachine", kind: "provider_observation", survivor: { kind: "none", reason: "evaluated by lane 147D (docs/commercial/DEALMACHINE-EVALUATION.md); no adapter" }, relevance: ["property_event"], intents: ["home_sale"], maxConfidence: "reported", protectedProxy: false, delivery: "push", cadenceMinutes: null, providerLatencyMinutes: null, freshness: "webhooks exist on every plan (vendor docs)", halfLifeDays: 90, strength: "weak", costClass: "contract_required", licence: { collection: "not_permitted", terms: "DealMachine terms (effective 2026-07-14): licence is 'non-transferrable, non-sublicensable … limited to the Customer's internal, lawful use only' — does not fit a multi-tenant platform without a negotiated agreement. A DealMachine PROSPECT LIFECYCLE event is the investor's pipeline moving, NOT proof a consumer is ready to move", storage: "contract", outreach: "none_automated" }, consent: "n/a until licensed", howObtained: "not obtainable for tenants on standard terms", status: "waiting_external" },
  { key: "we_batchdata_property_subscription", kind: "property_public_record", survivor: { kind: "acquisition_source", key: "batchdata_smart_search" }, relevance: ["property_event"], intents: ["home_sale"], maxConfidence: "reported", protectedProxy: false, delivery: "push", cadenceMinutes: null, providerLatencyMinutes: null, freshness: "a PUSH (webhook) once BatchData provisions the Property Subscription; until then pr_batchdata_quicklist is polled", halfLifeDays: 90, strength: "moderate", costClass: "paid_enrichment", licence: VENDOR_PROVIDER_LICENCE("batchdata"), consent: "property record", howObtained: "BatchData V2 Property Subscription push", status: "waiting_external" },
]

/** THE REGISTRY — every movement signal source, composed from the survivors. */
export const MOVEMENT_SIGNAL_SOURCES: readonly MovementSignalSource[] = Object.freeze([
  ...FIRST_PARTY, ...PUBLIC_RECORD, ...PUBLIC_POSTS, ...PROVIDER_ROWS, ...COMMUNITY_MARKET, ...WAITING,
])

const BY_KEY = new Map(MOVEMENT_SIGNAL_SOURCES.map((s) => [s.key, s]))
export function movementSource(key: string): MovementSignalSource | undefined { return BY_KEY.get(key) }

/** The registry key a provider census key is read under (a carried survivor → its first-class row). */
export function movementSourceKeyForIntentSource(intentKey: string): string | null {
  if (CARRIED_BY[intentKey]) return CARRIED_BY[intentKey]
  return BY_KEY.has(`po_${intentKey}`) ? `po_${intentKey}` : null
}

/** Acquisition SourceKeys that bear on a MOVE (the guard derives the set it checks from SOURCE_MAP + this exclusion list). */
export const ACQUISITION_NOT_MOVEMENT: Readonly<Partial<Record<SourceKey, string>>> = Object.freeze({
  batchdata_motivated: "carried by pr_batchdata_quicklist (the same quickList rows land in motivated_seller_signals)",
  zenrows_zillow: "portal FSBO / listing cards — a listing population, carried by pr_fsbo_listing / pr_mls_status_change",
  zenrows_realtor: "portal listing cards — as zenrows_zillow",
  zenrows_homes: "portal listing cards — as zenrows_zillow",
  facebook_group: "generic group posts; agent-seeking threads are pp_facebook_recommend_realtor",
  facebook_marketplace: "Marketplace home cards — a listing population (pr_fsbo_listing family)",
  reddit_intent: "generic buyer / seller chatter; relocation posts are pp_reddit_relocation",
  instagram_intent: "hashtag posts — no movement reading verified",
  craigslist_fsbo: "carried by pr_fsbo_listing",
  craigslist_wanted: "a BUYER asking for a home — a buyer lead, not a move signal about an owner",
  google_phrase_intent: "generic phrase intent; the agent-seeking phrases are pp_agent_seeking_phrase",
  expired_listing: "carried by pr_mls_status_change / pr_batchdata_quicklist",
  exa_buyer_intent: "buyer acquisition (a stranger looking to buy) — acquisition, not a move signal",
  tavily_intent: "buyer / seller acquisition — as exa_buyer_intent",
  osint_signal: "carried by pp_web_mention_life_event",
  realty_site_chatter: "portal 'contact agent' chatter — buyer acquisition",
  batchdata_smart_search: "carried by we_batchdata_property_subscription",
  batchdata_buybox: "investor demand matched to a listing — buyer side",
  external_behavior: "off-site property-view discovery — buyer acquisition",
  site_visitor_intent: "anonymous visitors (never a person) — the identified half is fp_site_sessions",
  email_engagement_intent: "our own email opens / clicks (contact_email_reengage) — engagement, not a move",
  new_construction_intent: "new-construction shoppers — buyer acquisition",
  inbound_email_unknown: "an unknown sender's inbound mail — the identified half is fp_inbound_stated",
  permit_prelisting_intent: "Exa permit / probate NEWS search — carried by pr_permit_activity / pr_probate_open_data when attached",
  rental_to_buyer_graduation: "a renter contact's tenure — buyer graduation (contact_rental_graduation_reengage)",
  batchdata_cash_buyer: "investor buyers — buyer side",
})

// ── NOT PERMITTED — sources a neighbour might imagine and this platform will never use (privacy: no intimate inference) ────────
export const NOT_PERMITTED_MOVEMENT_SOURCES: readonly { what: string; why: string }[] = Object.freeze([
  { what: "mortgage / credit 'trigger leads' (a credit inquiry sold to third parties)", why: "regulated prescreened-offer data under FCRA §604(c) for firm offers of credit, not real-estate marketing; further restricted by the Homebuyers Privacy Protection Act (2025) — verify with counsel" },
  { what: "utility connect / disconnect records", why: "private customer records of a utility; not public, not licensable for marketing" },
  { what: "school enrolment / withdrawal", why: "FERPA-protected education records; and a familial-status proxy" },
  { what: "health, pregnancy, diagnosis or care inferences (pharmacy, baby-registry, hospice browsing)", why: "intimate inference from private behaviour — never, under any purpose" },
  { what: "precise location tracking / geofenced device IDs of individuals", why: "sensitive personal information under state privacy laws (e.g. CPRA precise geolocation); intimate tracking" },
  { what: "private messages, closed-group or behind-login content captured by automation", why: "not public; platform terms and computer-access law — a person may only record what they lawfully saw" },
  { what: "marital-status or household-composition inference from behaviour (a single-person search, a ring removed in a photo)", why: "intimate inference; marital status is protected under several state fair-housing laws and familial status under the federal FHA" },
  { what: "a third party's claim about a named person's divorce, death or health", why: "gossip about a person's intimate life is not evidence; only a public record or the person's own disclosure establishes it" },
])

// ── RESEARCH STRATEGIES — economical, cheapest first (requirement 7) ───────────────────────────────────────────────────────────
export interface ResearchStrategy {
  key: string
  costClass: CostClass
  /** What gap it can close (the relevance it can corroborate). */
  corroborates: readonly MovementRelevance[]
  /** The survivor rail that runs it (and its gate). */
  rail: string
  gate: "none" | "mayUseAndAfford"
  what: string
}

export const RESEARCH_STRATEGIES: readonly ResearchStrategy[] = Object.freeze([
  { key: "first_party_history", costClass: "free_first_party", corroborates: ["property_event", "relocation", "seeking_agent"], rail: "lib/enrichment/customer-360.ts customer360For (consent + intent + engagement slices)", gate: "none", what: "read what the person already did with us — saves, views, portal, calculators, messages" },
  { key: "stored_public_records", costClass: "free_first_party", corroborates: ["property_event", "probate_estate"], rail: "motivated_seller_signals for the person's lead / contact (permit / violation / quickList rows already stored)", gate: "none", what: "check the records our sweeps already stored for their address" },
  { key: "open_data_lookup", costClass: "free_public", corroborates: ["property_event", "probate_estate", "relocation"], rail: "lib/external/socrata-client.ts socrataQuery over a VERIFIED dataset (socrata-market-registry verifiedOn)", gate: "none", what: "query a verified city / county open-data dataset for the address" },
  { key: "manual_record_check", costClass: "free_public", corroborates: ["divorce", "probate_estate", "property_event"], rail: "a person: the county court / recorder name or address search", gate: "none", what: "a person checks the official index (the only lawful route where bulk access is not offered)" },
  { key: "web_mention_search", costClass: "platform_paid", corroborates: ["relocation", "life_stage", "probate_estate", "divorce"], rail: "lib/enrichment/web-mention-search.ts searchPersonMentions (dispatchWebSearch, Exa, booked platform-paid)", gate: "mayUseAndAfford", what: "one public-web search for the person's full name with the event terms (~$0.007 inside Exa's free monthly credit)" },
  { key: "provider_gap_refresh", costClass: "paid_enrichment", corroborates: ["relocation", "life_stage", "property_event"], rail: "the enrichment queue (lib/lead-pipeline/enrichment-orchestrator.ts) — Versium / PeopleData, gap-only", gate: "mayUseAndAfford", what: "buy only the missing field that would change the decision (a job / location change, an online real-estate indicator)" },
])

// ── NEIGHBOURLY HELPERS — capability descriptors the arbiter may choose, never a timetable (requirement 9) ───────────────────────
export interface NeighbourlyHelper {
  key: string
  title: string
  /** The neighbourly framing — how the help is offered. */
  offer: string
  /** The evidence it needs before it may be offered. */
  requires: { relevance: readonly MovementRelevance[]; minConfidence: EpistemicClass; personIdentified: boolean; requestedByPerson?: boolean }
  /** The planner experience that carries it (lib/ai-isa/lead-action-plan.ts EXPERIENCE_KINDS — one vocabulary). */
  experience: "market_update" | "education" | "properties" | "agent_intervention" | "communication" | "professional_referral" | "appointment"
  /** Words and moves that must never appear. */
  never: readonly string[]
}

export const NEIGHBOURLY_HELPERS: readonly NeighbourlyHelper[] = Object.freeze([
  { key: "market_update_after_interest", title: "A market update after real interest", offer: "\"Saw a few homes like yours sell nearby this month — happy to send what they went for if it's useful.\"", requires: { relevance: ["property_event", "market_event"], minConfidence: "reported", personIdentified: true }, experience: "market_update", never: ["mentioning the signal source", "'are you thinking of selling?' as an opener", "a price for their home without a CMA"] },
  { key: "equity_review_on_request", title: "An equity review — only when asked", offer: "\"If you ever want a no-pressure look at where your equity stands, I can put one together.\" The review itself only after they say yes.", requires: { relevance: ["property_event"], minConfidence: "verified", personIdentified: true, requestedByPerson: true }, experience: "market_update", never: ["an unrequested valuation number", "a rate or loan quote (licensed lender only)"] },
  { key: "relocation_checklist_on_disclosed_move", title: "A relocation checklist when the move is disclosed", offer: "\"Congrats on the move! Here's the checklist I give friends heading to a new city — and I can connect you with a great agent there.\"", requires: { relevance: ["relocation"], minConfidence: "reported", personIdentified: true }, experience: "education", never: ["guessing the reason for the move", "assuming they are selling"] },
  { key: "agent_recommendation_reply", title: "A personal reply to 'can anyone recommend an agent?'", offer: "The agent answers the public thread themselves, as a neighbour — one short helpful line, no pitch, an invitation to talk privately.", requires: { relevance: ["seeking_agent"], minConfidence: "reported", personIdentified: false }, experience: "agent_intervention", never: ["an automated DM", "a reply from a bot account", "copying the post anywhere"] },
  { key: "estate_education_without_assumption", title: "Estate-sale / probate education, without assumption", offer: "A person offers general, plain-language help (\"how selling a home through probate works in <state>\") only where the person publicly asked or a public record makes it relevant — and after a respectful interval the agent judges.", requires: { relevance: ["probate_estate"], minConfidence: "verified", personIdentified: true }, experience: "agent_intervention", never: ["condolences used as an opener to sell", "any automated message about a death", "naming the decedent in marketing"] },
  { key: "life_change_check_in", title: "A personal check-in from the agent", offer: "The agent reaches out personally about something useful (a market note, a vendor they trust) — never about the life event itself.", requires: { relevance: ["divorce", "life_stage"], minConfidence: "verified", personIdentified: true }, experience: "agent_intervention", never: ["mentioning the divorce / the life event", "any automated message", "any segment or audience built from it"] },
  { key: "matching_homes_for_a_buyer", title: "Homes that fit what they told us", offer: "\"Two homes just came up that match what you mentioned — want me to send them?\"", requires: { relevance: ["property_event", "relocation", "seeking_agent"], minConfidence: "reported", personIdentified: true }, experience: "properties", never: ["inventing a listing fact", "steering by neighbourhood demographics"] },
  { key: "lender_introduction_on_request", title: "An introduction to a lender the client chooses", offer: "Only when the client asks about financing: the agent offers two or three licensed lenders from the bench; the client chooses (RESPA §8 — no fee, never automated).", requires: { relevance: ["property_event"], minConfidence: "reported", personIdentified: true, requestedByPerson: true }, experience: "professional_referral", never: ["an automated referral", "a paid steer"] },
])
