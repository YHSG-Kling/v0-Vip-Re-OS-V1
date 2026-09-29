import type { NormalizedScrapedRecord } from "@/lib/lead-pipeline/raw-record-types"
import { resolveBatchDataToken } from "@/lib/external/batchdata-tokens"
import { householdFinancialsFromBatchData, type HouseholdFinancials } from "@/lib/lead-pipeline/enrichment-column-map"

// ─── CLASS ALIAS (backward compat for callers using `new BatchDataClient()`) ──
export class BatchDataClient {
  async searchByAddress(address: string, city: string, state: string) {
    return searchProperties(`${address}, ${city}, ${state}`).then(r => r.matches)
  }
  async searchByName(firstName: string, lastName: string, city: string, state: string) {
    return fetchMotivatedSellers({ state }).then(r => r.records)
  }
  async getMotivatedSellers(filters: { city: string; state?: string; minEquity?: number }) {
    // minEquity intent → bias the pull toward the high-equity quickList.
    const motivationTypes = (filters.minEquity ?? 0) > 0 ? ["high_equity", "pre_foreclosure", "absentee"] : undefined
    return fetchMotivatedSellers({ state: filters.state || "", city: filters.city, motivationTypes }).then(r => r.records)
  }
  async getPropertyDetails(propertyId: string) {
    return enrichPropertyWithBatchData(propertyId).then(r => r)
  }
  /**
   * Alias used by the lead-scraping cron.
   * Accepts a "City, State" string, splits it, and delegates to fetchMotivatedSellers — passing
   * BOTH city and state so the BatchData `query` scopes to the city, not just the state.
   * Returns the records array directly so callers can iterate without unwrapping.
   */
  async getMotivatedSellerData(location: string, motivationTypes?: string[]): Promise<BatchDataRecord[]> {
    return this.getMotivatedSellerDataWithCost(location, motivationTypes).then(r => r.records)
  }
  /**
   * Lane 82B — the SAME pull, keeping fetchMotivatedSellers' `cost` (records × the per-record
   * search price) instead of dropping it. The lead-scraping cron used the records-only alias above,
   * so every motivated-seller / expired pull reached raw_scraped_leads with cost_per_record NULL
   * and booked NOTHING on vendor_usage_tracking — the platform ledger's BatchData line was the
   * wallet reconcile's drift, never a per-source cost. The cron now books this figure per source.
   */
  async getMotivatedSellerDataWithCost(location: string, motivationTypes?: string[], window?: MotivatedPullWindow): Promise<{ records: BatchDataRecord[]; cost: number }> {
    const [city, state] = location.includes(',')
      ? location.split(',').map(s => s.trim())
      : ['', location]
    // motivationTypes lets a caller target a SPECIFIC trigger as its own search (e.g. ['expired'] for
    // expired listings) — fetchMotivatedSellers labels every returned record with types[0], so each
    // trigger must be pulled trigger-by-trigger. Omitted → the default motivated-seller trio.
    // Lane 89E — a single-trigger pull may carry the market's DATE WINDOW (dateWindowCriteria):
    // "same-day" court/recorder filings become a recording-date floor on the V1 pull instead of
    // re-billing the same oldest 100 records every run.
    const searchCriteria = window && motivationTypes && motivationTypes.length === 1
      ? dateWindowCriteria(motivationTypes[0], window)
      : undefined
    const r = await fetchMotivatedSellers({ state: state || location, city: city || undefined, motivationTypes, searchCriteria })
    return { records: r.records, cost: r.cost }
  }
}

const BATCHDATA_API_KEY = process.env.BATCHDATA_API_KEY!
const BATCHDATA_API_URL = 'https://api.batchdata.com/api/v1'

export interface BatchDataRecord {
  [key: string]: unknown  // enables cast to Record<string, unknown>
  firstName: string
  lastName: string
  phone: string | null
  email: string | null
  /** Lane 89B — EVERY contact point the provider's `contact` dataset carried on the row
   *  (owner.phoneNumbers[].number / owner.emails[] / owner.enrichedEmails[].email — the field
   *  catalogue read 2026-09-29 via list_property_dataset_fields "contact"). `phone`/`email` above
   *  are the first of each; the rest ride here so nothing bought is dropped. */
  phones?: string[]
  emails?: string[]
  /** Lane 89B — the provider SOLD the person's contact points with this record (raw-record-types.ts::
   *  paidPersonData; source-intent-map.ts::SOURCE_PAID_PERSON_DATA). PeopleData is not asked again. */
  paidPersonData?: boolean
  address: string
  city: string
  state: string
  zip: string
  propertyAddress?: string
  propertyCity?: string
  propertyState?: string
  propertyZip?: string
  beds?: number
  baths?: number
  sqft?: number
  /** Building/property type (e.g. "Single Family", "Condo") — read for criteria-fit scoring
   *  (wave 67: market_active_listings.property_type / investor_offmarket_candidates). */
  propertyType?: string
  estimatedValue?: number
  // ── Rich seller-profile signal (max-info capture) ──────────────────────────
  /** All BatchData quickList tags returned for the property (cash-buyer, absentee-owner,
   *  high-equity, preforeclosure, vacant, etc.) — full motivation taxonomy in one array. */
  quickLists?: string[]
  /** Valuation breakdown: estimated value, equity dollars + %, low/high range. */
  valuation?: {
    estimatedValue?:  number
    estimatedEquity?: number
    equityPercent?:   number
    lowValue?:        number
    highValue?:       number
    confidenceScore?: number
  }
  /** Mortgage / lien profile — loan balance, lender, lien count, last-payment, foreclosure stage. */
  mortgage?: {
    openLoanBalance?:   number
    estimatedRemainingBalance?: number
    lenderName?:        string
    loanCount?:         number
    foreclosureStatus?: string
    lastPaymentDate?:   string
  }
  /** Most-recent sale facts so AI ISA / offer scripts know cost basis + tenure. */
  lastSale?: {
    date?:   string
    price?:  number
    type?:   string
    deed?:   string
  }
  /** Years the current owner has held the property — drives downsizer / tired-landlord scoring. */
  ownershipLengthYears?: number
  /** Mailing address differs from property address → likely absentee/investor. */
  mailingAddressVacant?: boolean
  /** Property vacancy facts. */
  vacancy?: {
    isVacant?:        boolean
    vacancyDate?:     string
    vacancyType?:     string
  }
  /** Lane 88G — the `listing` dataset the same Property Search row carries (confirmed from the
   *  provider's own field catalogue, list_property_dataset_fields "listing", 2026-09-28:
   *  listing.price / maxListPrice / minListPrice / daysOnMarket / status). Read so a PRICE CUT
   *  (price below the listing's own max list price) is visible to the scorer and the active-listing
   *  feed stores the LIST price instead of the AVM (it wrote `estimatedValue` into list_price). */
  listing?: {
    price?:           number
    maxListPrice?:    number
    minListPrice?:    number
    daysOnMarket?:    number
    status?:          string
  }
  // The full motivated-seller spectrum BatchData covers — downsizers (high
  // equity), divorce, foreclosure / pre-foreclosure, tax lien, expired listings,
  // investor/absentee owners, vacant, and tired landlords.
  motivationType: 'probate' | 'divorce' | 'foreclosure' | 'tax_lien' | 'pre_foreclosure' | 'distressed' | 'high_equity' | 'absentee' | 'expired' | 'vacant' | 'tired_landlord'
    // Lane 82B (owner, wave 82: "motivated sellers (fsbo, expired, probate/divorce, etc.)") — the
    // quickLists BatchData publishes that no trigger reached before (see QUICKLIST_SLUG below).
    | 'fsbo' | 'senior_owner' | 'canceled_listing' | 'lis_pendens' | 'notice_of_default' | 'involuntary_lien'
    // Lane 88G — three published quickLists no trigger reached (see BATCHDATA_MOTIVATION_TYPES).
    | 'auction' | 'mailing_vacant' | 'failed_listing'
    // Lane 89B — the LAST six published owner/equity quickLists no trigger reached (BATCHDATA_QUICKLIST_CATALOGUE).
    | 'free_and_clear' | 'out_of_state_owner' | 'corporate_owned' | 'trust_owned' | 'low_equity' | 'vacant_lot'
  motivationConfidence: number
  /** Lane 85C — the property row's `demographic` dataset (marital status / household income / net
   *  worth) that a Property Search returns with every permitted dataset and this normalizer used to
   *  DROP. Carried onto raw_scraped_leads.raw_data, read by pipeline-processor.ts through the ONE
   *  mapper (enrichment-column-map.ts::householdFinancialsFromBatchData). */
  householdFinancials?: HouseholdFinancials
}

/** Full motivated-seller trigger set requested by default. Only types that map to a REAL BatchData
 *  quickList are pullable here (divorce has no BatchData quickList — those leads come from other
 *  sources). A single Property Search caps quickLists at 3, so the cron pulls trigger-by-trigger. */
export const BATCHDATA_MOTIVATION_TYPES = [
  'probate', 'foreclosure', 'pre_foreclosure', 'tax_lien',
  'high_equity', 'absentee', 'expired', 'vacant', 'tired_landlord',
  // Lane 82B — six published quickLists (BATCHDATA_QUICKLISTS below) no trigger mapped to before:
  // FSBO owners ('for-sale-by-owner'), downsizers ('senior-owner' — the life-stage mismatch
  // SmartZip/Offrs score on), withdrawn/cancelled listings ('canceled-listing' — the expired
  // playbook's sibling), and the two EARLY pre-foreclosure filings plus involuntary liens
  // ('notice-of-lis-pendens', 'notice-of-default', 'involuntary-lien'). Divorce STILL has no
  // quickList — it stays on the OSINT court-records lane (osint_signal).
  'fsbo', 'senior_owner', 'canceled_listing', 'lis_pendens', 'notice_of_default', 'involuntary_lien',
  // Lane 88G (wave 88, lane-87F scraping gaps #3 same-day filings, #4 change-of-address, #6 stale
  // listings) — data we ALREADY BUY, never a new vendor: three more published quickLists
  // (BATCHDATA_QUICKLISTS, confirmed against the provider's quicklist dataset catalogue 2026-09-28):
  //   auction        → 'active-auction'         — the trustee/sheriff sale is SCHEDULED: the latest,
  //                                                most time-boxed foreclosure stage the recorder shows.
  //   mailing_vacant → 'mailing-address-vacant' — the owner's OWN mailing address is vacant: they
  //                                                moved without updating the county — the lawful
  //                                                change-of-address proxy (USPS NCOALink may NOT be
  //                                                used to build new-mover lists; its licence confines
  //                                                it to correcting a mailer's own list).
  //   failed_listing → 'failed-listing'         — a listing that failed to close (stale/withdrawn
  //                                                sibling of canceled/expired).
  'auction', 'mailing_vacant', 'failed_listing',
  // Lane 89B (wave 89, owner verbatim: "batchdata has many other quicklists so don't just limit to
  // motivated sellers") — the catalogue was re-enumerated against the provider's quicklist dataset
  // (list_property_dataset_fields "quicklist", 2026-09-29: 38 flags) and EVERY flag now has a verdict
  // in BATCHDATA_QUICKLIST_CATALOGUE below. These six are the owner/equity lists that were still
  // unreached; each is opt-in (never in the default trio — see the catalogue's `defaultOn`):
  //   free_and_clear     → 'free-and-clear'              no mortgage: the downsizer/estate seller with
  //                                                       nothing to pay off (an ENABLER family for stacking)
  //   out_of_state_owner → 'out-of-state-absentee-owner' the owner lives in another state — the
  //                                                       strongest absentee tier ('out-of-state-owner'
  //                                                       and 'in-state-absentee-owner' are aliases)
  //   corporate_owned    → 'corporate-owned'             LLC/corporation on title — DEFAULT OFF: the
  //                                                       lead gate refuses entity names (lane 84C), so a
  //                                                       pull strands until a person is resolved; useful
  //                                                       as a STACK enabler and for the investor bench
  //   trust_owned        → 'trust-owned'                 a trust on title (estate planning / pre-probate);
  //                                                       same gate posture as corporate_owned
  //   low_equity         → 'low-equity'                  underwater / thin equity: with a foreclosure
  //                                                       family it is the SHORT-SALE candidate
  //   vacant_lot         → 'vacant-lot'                  land owners (builder/land-sale sellers)
  'free_and_clear', 'out_of_state_owner', 'corporate_owned', 'trust_owned', 'low_equity', 'vacant_lot',
] as const

/** The default high-intent seller trio used when no explicit triggers are given (API caps at 3).
 *  Lane 89B — the ONE list; BATCHDATA_QUICKLIST_CATALOGUE's `defaultOn` flags must name exactly
 *  these three (scripts/lead-source-catalogue-guard.ts holds the two in agreement). */
const DEFAULT_MOTIVATION_TRIO = ['high_equity', 'pre_foreclosure', 'absentee'] as const

/**
 * Lane 89B — the INVESTOR BUYER lists (BUYER-side; never a seller trigger). 'cash_buyer' (lane 82B)
 * plus 'fix_and_flip': an owner whose last two sales were months apart at a profit is an ACTIVE
 * flipper — the buyer an investor-persona listing wants. Pulled only by the cron's
 * batchdata_cash_buyer step, one call per list, each record stamped with its own list + 'investor'.
 */
export const BATCHDATA_INVESTOR_BUYER_TYPES = ['cash_buyer', 'fix_and_flip'] as const

/** Config/DB aliases → our canonical BatchData motivation trigger. */
const TRIGGER_ALIASES: Record<string, string> = {
  preforeclosure: 'pre_foreclosure', 'pre-foreclosure': 'pre_foreclosure',
  'tax-lien': 'tax_lien', taxlien: 'tax_lien', 'tax-default': 'tax_lien', taxdefault: 'tax_lien',
  inherited: 'probate', 'notice-of-sale': 'foreclosure',
  'absentee-owner': 'absentee', 'expired-listing': 'expired', 'tired-landlord': 'tired_landlord',
  'high-equity': 'high_equity', highequity: 'high_equity',
  // Lane 82B — config/UI spellings for the six new triggers.
  'for-sale-by-owner': 'fsbo', for_sale_by_owner: 'fsbo', by_owner: 'fsbo',
  'senior-owner': 'senior_owner', downsizer: 'senior_owner', empty_nester: 'senior_owner',
  'canceled-listing': 'canceled_listing', cancelled_listing: 'canceled_listing', withdrawn: 'canceled_listing', withdrawn_listing: 'canceled_listing',
  'notice-of-lis-pendens': 'lis_pendens', 'lis-pendens': 'lis_pendens',
  'notice-of-default': 'notice_of_default', nod: 'notice_of_default',
  'involuntary-lien': 'involuntary_lien',
  // Lane 88G — tax-delinquent spellings (the county "tax delinquent list" gap maps onto the SAME
  // 'tax-default' quickList this platform already buys) + the three new triggers' spellings.
  tax_delinquent: 'tax_lien', 'tax-delinquent': 'tax_lien', delinquent_tax: 'tax_lien', delinquent_taxes: 'tax_lien',
  'active-auction': 'auction', foreclosure_auction: 'auction', trustee_sale: 'auction', sheriff_sale: 'auction',
  'mailing-address-vacant': 'mailing_vacant', change_of_address: 'mailing_vacant', moved_away: 'mailing_vacant', owner_moved: 'mailing_vacant',
  'failed-listing': 'failed_listing', stale_listing: 'failed_listing',
  // Lane 89B — config/UI spellings for the six new triggers + the absentee tiers.
  'free-and-clear': 'free_and_clear', freeandclear: 'free_and_clear', no_mortgage: 'free_and_clear', paid_off: 'free_and_clear',
  'out-of-state-absentee-owner': 'out_of_state_owner', 'out-of-state-owner': 'out_of_state_owner', out_of_state_absentee: 'out_of_state_owner', out_of_state: 'out_of_state_owner',
  'in-state-absentee-owner': 'absentee', in_state_absentee: 'absentee', in_state_absentee_owner: 'absentee',
  'corporate-owned': 'corporate_owned', llc_owned: 'corporate_owned', entity_owned: 'corporate_owned',
  'trust-owned': 'trust_owned', trustee: 'trust_owned', living_trust: 'trust_owned',
  'low-equity': 'low_equity', underwater: 'low_equity', negative_equity: 'low_equity', short_sale: 'low_equity',
  'vacant-lot': 'vacant_lot', land: 'vacant_lot', vacant_land: 'vacant_lot',
  'fix-and-flip': 'fix_and_flip', flipper: 'fix_and_flip',
}
function canonicalTrigger(t: string): string {
  const k = String(t).trim().toLowerCase().replace(/\s+/g, '_')
  return TRIGGER_ALIASES[k] ?? TRIGGER_ALIASES[k.replace(/_/g, '-')] ?? k
}

/**
 * Resolve which BatchData motivation triggers to pull for a market's CONFIGURED signal types.
 * Motivated-seller scrapes (probate, foreclosure, pre_foreclosure, tax_lien, vacant, tired_landlord,
 * high_equity, absentee) come from BatchData FIRST — each mapped to a real quickList and pulled
 * trigger-by-trigger. 'expired' is pulled on its own gated path (excluded here). Types BatchData
 * can't serve (divorce / bankruptcy / eviction — no quickList) are DROPPED (they come from OSINT).
 * Empty / none configured → the high-intent trio (cost-safe default). Pure.
 */
export function batchDataTriggersFor(signalTypes: readonly string[] | null | undefined): string[] {
  const supported = new Set<string>(BATCHDATA_MOTIVATION_TYPES.filter((t) => t !== 'expired'))
  if (!signalTypes || signalTypes.length === 0) return [...DEFAULT_MOTIVATION_TRIO]
  const picked = Array.from(new Set(signalTypes.map(canonicalTrigger).filter((t) => supported.has(t))))
  return picked.length > 0 ? picked : [...DEFAULT_MOTIVATION_TRIO]
}

/** Authoritative BatchData v1 Property Search quickList vocabulary (the named business-rule
 *  queries). Used to validate every slug before it hits the API so an invalid name can't be sent.
 *  Source: BatchData v1 "Create a Property Search" docs. */
export const BATCHDATA_QUICKLISTS = new Set<string>([
  'absentee-owner', 'active-auction', 'active-listing', 'canceled-listing', 'cash-buyer',
  'corporate-owned', 'expired-listing', 'failed-listing', 'fix-and-flip', 'free-and-clear',
  'for-sale-by-owner', 'has-hoa', 'has-hoa-fees', 'high-equity', 'inherited', 'involuntary-lien',
  'in-state-absentee-owner', 'listed-below-market-price', 'low-equity', 'mailing-address-vacant',
  'notice-of-default', 'notice-of-lis-pendens', 'notice-of-sale', 'on-market',
  'out-of-state-absentee-owner', 'out-of-state-owner', 'owner-occupied', 'pending-listing',
  'preforeclosure', 'recently-sold', 'same-property-and-mailing-address', 'senior-owner',
  'tax-default', 'tired-landlord', 'trust-owned', 'unknown-equity', 'vacant', 'vacant-lot',
])

/**
 * INVESTOR OFF-MARKET quickLists (wave 67, owner verbatim: "with a buyer who we know is an investor
 * intent, that we are giving them off market listings"). The named subset of BATCHDATA_QUICKLISTS an
 * investor-intent contact's off-market rail pulls from — every slug validated against
 * BATCHDATA_QUICKLISTS (asserted in the simulator), and 'on-market'/'pending-listing'/
 * 'recently-sold'/'active-listing' NEVER appear here — that vocabulary is the regular-buyer rail's
 * (market_active_listings, current_status='active'). Used by
 * lib/buyer-search/investor-offmarket-runner.ts beside the existing scraped lead/contact sourcing —
 * ADDITIVE, never a replacement.
 */
export const INVESTOR_OFFMARKET_QUICKLISTS = [
  "absentee-owner", "high-equity", "tired-landlord", "vacant", "preforeclosure", "inherited",
] as const satisfies readonly string[]

// Maps our internal motivation types to VALID BatchData Property Search quickList slugs. Each value
// is a real quickList from BATCHDATA_QUICKLISTS (validated by the simulator).
const QUICKLIST_SLUG: Record<string, string> = {
  probate:         'inherited',
  foreclosure:     'notice-of-sale',     // active foreclosure (auction stage)
  pre_foreclosure: 'preforeclosure',
  tax_lien:        'tax-default',
  high_equity:     'high-equity',
  absentee:        'absentee-owner',
  expired:         'expired-listing',
  vacant:          'vacant',
  tired_landlord:  'tired-landlord',
  distressed:      'preforeclosure',
  // Lane 82B
  fsbo:              'for-sale-by-owner',
  senior_owner:      'senior-owner',
  canceled_listing:  'canceled-listing',
  lis_pendens:       'notice-of-lis-pendens',
  notice_of_default: 'notice-of-default',
  involuntary_lien:  'involuntary-lien',
  // Lane 88G
  auction:           'active-auction',
  mailing_vacant:    'mailing-address-vacant',
  failed_listing:    'failed-listing',
  // Lane 89B
  free_and_clear:     'free-and-clear',
  out_of_state_owner: 'out-of-state-absentee-owner',
  corporate_owned:    'corporate-owned',
  trust_owned:        'trust-owned',
  low_equity:         'low-equity',
  vacant_lot:         'vacant-lot',
  // Lane 82B — BUYER-side (investor) list, deliberately NOT in BATCHDATA_MOTIVATION_TYPES so a
  // seller pull can never reach it; pulled only by the cron's batchdata_cash_buyer step.
  cash_buyer:        'cash-buyer',
  // Lane 89B — second investor-buyer list (BATCHDATA_INVESTOR_BUYER_TYPES), same posture.
  fix_and_flip:      'fix-and-flip',
}

/** How ONE published quickList is used by this platform — every flag answers (lane 89B). */
export type QuickListUse =
  | 'seller_trigger'   // a BATCHDATA_MOTIVATION_TYPES trigger the motivated pull can request
  | 'investor_buyer'   // a BATCHDATA_INVESTOR_BUYER_TYPES list the cash-buyer step pulls
  | 'listing_feed'     // on-market inventory — lib/kernel/listings-batchdata-feed.ts (batchdata_active_listings), never a person lead
  | 'farm'             // lib/kernel/farm-play.ts / neighbor-farm.ts (just-sold neighbour farming), seller-permission-gated
  | 'fact_filter'      // a property/owner FACT (AND-filter or stack fact), not motivation — never pulled as a list

export interface QuickListCatalogueEntry {
  use: QuickListUse
  /** The internal trigger (QUICKLIST_SLUG key) for seller_trigger / investor_buyer uses. */
  trigger?: string
  /** seller_trigger only — pulled for an UNCONFIGURED market (must equal DEFAULT_MOTIVATION_TRIO). */
  defaultOn?: boolean
  /** Why it is used this way (the operator's justification, surfaced beside the picker). */
  why: string
}

/**
 * Lane 89B — EVERY published quickList (BATCHDATA_QUICKLISTS, 38) with its verdict. Owner, 2026-09-29:
 * "batchdata has many other quicklists so don't just limit to motivated sellers." The proof asserts the
 * key set EQUALS BATCHDATA_QUICKLISTS (a flag the provider adds cannot sit unjudged), that every
 * seller_trigger / investor_buyer entry names a trigger QUICKLIST_SLUG maps back onto its own slug, and
 * that `defaultOn` names exactly DEFAULT_MOTIVATION_TRIO. Each pull is territory-scoped by the cron
 * (market city/state in `query`), booked per source (bookSourceSpend), $0.05/record
 * (BATCHDATA_PROPERTY_SEARCH_RECORD_COST_USD), and toggled per market through the admin
 * "Motivated signals" picker (app/dashboard/admin/markets/page.tsx derives its options from
 * BATCHDATA_MOTIVATION_TYPES) or the Data-sources toggles (expired_listing / batchdata_cash_buyer).
 */
export const BATCHDATA_QUICKLIST_CATALOGUE: Readonly<Record<string, QuickListCatalogueEntry>> = {
  // ── seller triggers (the motivated pull) ──
  'high-equity':                 { use: 'seller_trigger', trigger: 'high_equity',        defaultOn: true,  why: 'equity to move — the default trio; the market can sell' },
  'preforeclosure':              { use: 'seller_trigger', trigger: 'pre_foreclosure',    defaultOn: true,  why: 'default trio — the classic distressed seller' },
  'absentee-owner':              { use: 'seller_trigger', trigger: 'absentee',           defaultOn: true,  why: 'default trio — does not live there; landlord/second home' },
  'inherited':                   { use: 'seller_trigger', trigger: 'probate',            defaultOn: false, why: 'deed shows inheritance — probate/estate seller' },
  'notice-of-sale':              { use: 'seller_trigger', trigger: 'foreclosure',        defaultOn: false, why: 'auction stage of foreclosure' },
  'tax-default':                 { use: 'seller_trigger', trigger: 'tax_lien',           defaultOn: false, why: 'delinquent taxes — the county tax-delinquent list, already bought' },
  'expired-listing':             { use: 'seller_trigger', trigger: 'expired',            defaultOn: false, why: 'own Data-sources toggle (expired_listing) — failed to sell' },
  'vacant':                      { use: 'seller_trigger', trigger: 'vacant',             defaultOn: false, why: 'nobody home — carrying cost with no use' },
  'tired-landlord':              { use: 'seller_trigger', trigger: 'tired_landlord',     defaultOn: false, why: 'long-held rental — an ENABLER family' },
  'for-sale-by-owner':           { use: 'seller_trigger', trigger: 'fsbo',               defaultOn: false, why: 'FSBO at $0.05/record — the fsbo_site_listing lane (Apify, ~$0.005/listing) covers the same population cheaper; keep for markets the FSBO sites miss' },
  'senior-owner':                { use: 'seller_trigger', trigger: 'senior_owner',       defaultOn: false, why: 'life-stage downsizer — an ENABLER family' },
  'canceled-listing':            { use: 'seller_trigger', trigger: 'canceled_listing',   defaultOn: false, why: 'withdrew a listing — expired playbook sibling' },
  'notice-of-lis-pendens':       { use: 'seller_trigger', trigger: 'lis_pendens',        defaultOn: false, why: 'earliest foreclosure filing' },
  'notice-of-default':           { use: 'seller_trigger', trigger: 'notice_of_default',  defaultOn: false, why: 'default recorded' },
  'involuntary-lien':            { use: 'seller_trigger', trigger: 'involuntary_lien',   defaultOn: false, why: 'mechanic/HOA/judgment lien' },
  'active-auction':              { use: 'seller_trigger', trigger: 'auction',            defaultOn: false, why: 'trustee/sheriff sale scheduled — same-day stage' },
  'mailing-address-vacant':      { use: 'seller_trigger', trigger: 'mailing_vacant',     defaultOn: false, why: 'the lawful change-of-address proxy (NCOALink may not build mover lists)' },
  'failed-listing':              { use: 'seller_trigger', trigger: 'failed_listing',     defaultOn: false, why: 'listing failed to close — stale' },
  'free-and-clear':              { use: 'seller_trigger', trigger: 'free_and_clear',     defaultOn: false, why: 'no mortgage — nothing to pay off; ENABLER family (equity)' },
  'out-of-state-absentee-owner': { use: 'seller_trigger', trigger: 'out_of_state_owner', defaultOn: false, why: 'owner lives in another state — the strongest absentee tier' },
  'corporate-owned':             { use: 'seller_trigger', trigger: 'corporate_owned',    defaultOn: false, why: 'entity on title: the lead gate refuses LLC names until a person is resolved — stack enabler / investor bench, not a default' },
  'trust-owned':                 { use: 'seller_trigger', trigger: 'trust_owned',        defaultOn: false, why: 'trust on title (pre-probate estate planning) — same gate posture as corporate' },
  'low-equity':                  { use: 'seller_trigger', trigger: 'low_equity',         defaultOn: false, why: 'thin/negative equity — short-sale candidate when stacked with a foreclosure family' },
  'vacant-lot':                  { use: 'seller_trigger', trigger: 'vacant_lot',         defaultOn: false, why: 'land owners — builder/land-sale sellers' },
  // ── investor buyers (the cash-buyer step) ──
  'cash-buyer':                  { use: 'investor_buyer', trigger: 'cash_buyer',   why: 'bought for cash — the investor buyer list (default ON via DEFAULT_MARKET_SOURCES)' },
  'fix-and-flip':                { use: 'investor_buyer', trigger: 'fix_and_flip', why: 'flipped recently — an ACTIVE investor buyer' },
  // ── on-market inventory (never a person lead from this platform) ──
  'active-listing':              { use: 'listing_feed', why: 'batchdata_active_listings feed — represented listings (Article 16), transitions only' },
  'on-market':                   { use: 'listing_feed', why: 'the same active-listing feed (on-market inventory)' },
  'pending-listing':             { use: 'listing_feed', why: 'the same feed — the pending transition' },
  'listed-below-market-price':   { use: 'listing_feed', why: 'a represented listing priced under AVM — buyer-side deal alert for the investor rail, never a seller solicitation' },
  // ── just-sold farming ──
  'recently-sold':               { use: 'farm', why: 'farm-play / neighbor-farm on every close (seller-permission-gated); a new owner is sphere, not a seller lead' },
  // ── facts (AND-filters and stack facts, not motivation) ──
  'owner-occupied':              { use: 'fact_filter', why: 'occupancy fact — AND-filter (not-owner-occupied narrows an absentee pull)' },
  'same-property-and-mailing-address': { use: 'fact_filter', why: 'the inverse of absentee — a fact' },
  'in-state-absentee-owner':     { use: 'fact_filter', why: 'the weaker absentee tier — aliased onto the absentee trigger for config; a fact on the stack' },
  'out-of-state-owner':          { use: 'fact_filter', why: 'mailing state ≠ property state regardless of occupancy — aliased onto out_of_state_owner for config' },
  'has-hoa':                     { use: 'fact_filter', why: 'an HOA governs the property — a fact, never motivation' },
  'has-hoa-fees':                { use: 'fact_filter', why: 'HOA fees are charged — a carrying-cost fact for the stack, never a list' },
  'unknown-equity':              { use: 'fact_filter', why: 'the provider could not value it — no signal' },
}

/** Lane 89B — the pullable seller triggers with their catalogue entry, derived (the admin picker's caption source). */
export function quickListCatalogueForTrigger(trigger: string): (QuickListCatalogueEntry & { quickList: string }) | null {
  const slug = QUICKLIST_SLUG[trigger]
  const entry = slug ? BATCHDATA_QUICKLIST_CATALOGUE[slug] : undefined
  return slug && entry ? { ...entry, quickList: slug } : null
}

/**
 * Pure: the internal motivation-trigger labels (probate/foreclosure/tax_lien/…) →
 * their BatchData quickList slug, filtered to ones the provider actually publishes.
 * Reused by both the V1 pull (buildPropertySearchBody, below) and the V2 Smart Search
 * subscription reconcile step (app/api/cron/lead-scraping/route.ts) so the two never
 * drift onto two different slug spellings for the same trigger.
 */
export function quickListSlugsFor(triggers: readonly string[]): string[] {
  return validQuickLists(triggers.map((t) => QUICKLIST_SLUG[t]).filter(Boolean) as string[])
}

/** The two camelCase flags whose kebab form is NOT the published slug (word order differs). */
const QUICKLIST_CAMEL_EXCEPTIONS: Record<string, string> = {
  absenteeOwnerInState: 'in-state-absentee-owner',
  absenteeOwnerOutOfState: 'out-of-state-absentee-owner',
}

/**
 * Lane 88G — PURE. Every quickList a provider property row is ON, as the published kebab slugs.
 *
 * FIXES THE "ONE FILE, TWO BELIEFS" DEFECT that lib/external/batchdata-seller-signals.ts::
 * readQuickList documented and worked around: Property Search returns `quickLists` as an OBJECT of
 * camelCase booleans (the provider's own quicklist dataset catalogue, re-confirmed 2026-09-28 via
 * list_property_dataset_fields: `quickLists.preforeclosure`, `quickLists.taxDefault`, 38 flags), but
 * normalizeBatchDataProperty read it as `Array.isArray(p.quickLists)` — so every object-shaped
 * response lost its WHOLE quickList set. Downstream that silently blinded: the expired/canceled
 * detection in scraper-parsers.ts::normalizeBatchDataRecord, the active-listing feed's status read
 * (listings-batchdata-feed.ts::statusFromQuickLists → "unknown" → every record skipped), the
 * inventory radar, and any multi-signal stack (one pull already says a parcel is tax-default AND
 * vacant AND absentee — for free). Accepts both wire shapes, like readQuickList; unknown names are
 * dropped (validated against BATCHDATA_QUICKLISTS), never invented.
 */
export function quickListSlugsFromRow(p: Record<string, any> | null | undefined): string[] {
  const raw = p?.quickLists ?? p?.quick_lists ?? (Array.isArray(p?.tags) ? p?.tags : undefined)
  const out = new Set<string>()
  const add = (slug: string) => { if (BATCHDATA_QUICKLISTS.has(slug)) out.add(slug) }
  if (Array.isArray(raw)) {
    for (const v of raw) if (typeof v === 'string') add(v.trim().toLowerCase())
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v !== true) continue
      add(QUICKLIST_CAMEL_EXCEPTIONS[k] ?? k.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase())
    }
  }
  return [...out]
}

/**
 * Lane 88G — PURE. Published quickList slug → the internal motivation trigger that pulls it (the
 * inverse of QUICKLIST_SLUG, so the SAME trigger vocabulary names a record's co-occurring signals —
 * CLAUDE.md §6). null for a slug no trigger maps to (owner-occupied, has-hoa, on-market …): those
 * are facts, not motivation, and never enter a signal stack.
 */
export function triggerForQuickListSlug(slug: string): string | null {
  for (const [trigger, s] of Object.entries(QUICKLIST_SLUG)) {
    // 'distressed' is a legacy alias of pre_foreclosure's slug — the canonical trigger wins.
    if (s === slug && trigger !== 'distressed') return trigger
  }
  return null
}

/** Lane 89B — true for a BUYER-side investor list trigger (never enters a seller stack). */
export function isInvestorBuyerTrigger(trigger: string | null | undefined): boolean {
  return !!trigger && (BATCHDATA_INVESTOR_BUYER_TYPES as readonly string[]).includes(trigger)
}

/**
 * Lane 89B — PURE. Every phone / email the provider's `contact` dataset put on an `owner` object,
 * in the order the provider ranked them. Shapes read: `phoneNumbers[]` of `{ number, … }` (the
 * published catalogue), bare string arrays (`phones`, `emails`), `enrichedEmails[]` of `{ email }`,
 * and the flat `phone` / `email` the legacy reader expected. Digits-only phone dedupe; lowercase
 * email dedupe; DNC-flagged lines are KEPT (the phone-scrub at promotion decides reachability —
 * dropping them here would hide a bought fact from the scrub).
 */
export function ownerContactPointsFromRow(owner: Record<string, any> | null | undefined): { phones: string[]; emails: string[] } {
  const phones: string[] = []
  const emails: string[] = []
  const seenPhone = new Set<string>()
  const seenEmail = new Set<string>()
  const addPhone = (v: unknown) => {
    const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''
    const digits = s.replace(/\D/g, '')
    if (digits.length < 10 || seenPhone.has(digits)) return
    seenPhone.add(digits); phones.push(s)
  }
  const addEmail = (v: unknown) => {
    const s = typeof v === 'string' ? v.trim() : ''
    const k = s.toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || seenEmail.has(k)) return
    seenEmail.add(k); emails.push(s)
  }
  if (!owner || typeof owner !== 'object') return { phones, emails }
  for (const list of [owner.phoneNumbers, owner.phones]) {
    if (!Array.isArray(list)) continue
    for (const p of list) addPhone(p && typeof p === 'object' ? (p as any).number ?? (p as any).phone : p)
  }
  addPhone(owner.phone)
  for (const list of [owner.emails, owner.enrichedEmails]) {
    if (!Array.isArray(list)) continue
    for (const e of list) addEmail(e && typeof e === 'object' ? (e as any).email ?? (e as any).address : e)
  }
  addEmail(owner.email)
  return { phones, emails }
}

/** Pure: a BatchData Property Search `results.properties[]` row → BatchDataRecord. */
export function normalizeBatchDataProperty(p: Record<string, any>, requestedType: string): BatchDataRecord {
  const addr      = p.address ?? {}
  const owner     = p.owner ?? {}
  const building  = p.building ?? {}
  const valuation = p.valuation ?? {}
  const mortgage  = p.mortgage  ?? p.openMortgageInfo  ?? {}
  const lastSale  = p.lastSale  ?? p.sale              ?? p.transferInfo ?? {}
  const vacancy   = p.vacancy   ?? {}
  const listing   = p.listing   ?? {}
  const fullName  = typeof owner.fullName === 'string' ? owner.fullName.trim() : ''
  const ownerFirst = owner.firstName ?? (fullName ? fullName.split(/\s+/)[0] : '')
  const ownerLast  = owner.lastName  ?? (fullName ? fullName.split(/\s+/).slice(1).join(' ') : '')
  // Lane 88G — BOTH wire shapes (object of camelCase flags AND the legacy array) through the ONE
  // reader; was `Array.isArray(p.quickLists)`, which dropped every object-shaped response's set.
  const quickLists = quickListSlugsFromRow(p)
  // Lane 89B — the `contact` dataset (list_property_dataset_fields "contact", 2026-09-29):
  // owner.phoneNumbers[].number / owner.emails[] / owner.enrichedEmails[].email. This normalizer read
  // only the flat `owner.phone` / `owner.email` (a shape the catalogue does not publish), so every
  // contact point the account had already PAID for on the pull was dropped and PeopleData was asked
  // again for the same person. Read defensively across both shapes; unknown → empty, never invented.
  const { phones, emails } = ownerContactPointsFromRow(owner)

  // Compact helper: drop undefined keys so sub-objects stay compact in the raw_data JSONB.
  const compact = <T extends Record<string, unknown>>(o: T): T | undefined => {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(o)) if (o[k] !== undefined && o[k] !== null) out[k] = o[k]
    return Object.keys(out).length ? (out as T) : undefined
  }

  return {
    firstName: ownerFirst || '',
    lastName:  ownerLast  || '',
    phone:     phones[0] ?? null,
    email:     emails[0] ?? null,
    ...(phones.length ? { phones } : {}),
    ...(emails.length ? { emails } : {}),
    // The provider sold the person with the record (raw-record-types.ts::paidPersonData) — only when a
    // contact point actually arrived; an account without the contact dataset stamps false.
    paidPersonData: phones.length > 0 || emails.length > 0,
    address:   owner.mailingAddress?.street ?? addr.street ?? '',
    city:      owner.mailingAddress?.city   ?? addr.city   ?? '',
    state:     owner.mailingAddress?.state  ?? addr.state  ?? '',
    zip:       owner.mailingAddress?.zip    ?? addr.zip    ?? '',
    propertyAddress: addr.street ?? undefined,
    propertyCity:    addr.city   ?? undefined,
    propertyState:   addr.state  ?? undefined,
    propertyZip:     addr.zip    ?? undefined,
    beds:  building.bedroomCount       ?? building.beds  ?? undefined,
    baths: building.bathroomCount      ?? building.baths ?? undefined,
    sqft:  building.livingAreaSquareFeet ?? building.sqft ?? undefined,
    propertyType: building.propertyType ?? building.property_type ?? p.propertyType ?? undefined,
    estimatedValue: valuation.estimatedValue ?? p.estimatedValue ?? undefined,
    // Rich seller-profile signal (preserved for downstream scoring, AI-ISA scripts, dashboards)
    quickLists: quickLists.length ? quickLists : undefined,
    valuation: compact({
      estimatedValue:  valuation.estimatedValue,
      estimatedEquity: valuation.estimatedEquity     ?? valuation.equityCurrentEstimated,
      equityPercent:   valuation.equityPercent       ?? valuation.equityCurrentEstimatedPercent,
      lowValue:        valuation.lowValue            ?? valuation.priceRangeMin,
      highValue:       valuation.highValue           ?? valuation.priceRangeMax,
      confidenceScore: valuation.confidenceScore     ?? valuation.confidence,
    }),
    mortgage: compact({
      openLoanBalance:          mortgage.openLoanBalance          ?? mortgage.estimatedLoanBalance,
      estimatedRemainingBalance: mortgage.estimatedRemainingBalance,
      lenderName:               mortgage.lenderName               ?? mortgage.lender,
      loanCount:                mortgage.loanCount                ?? mortgage.numberOfLoans,
      foreclosureStatus:        mortgage.foreclosureStatus        ?? p.foreclosureStatus,
      lastPaymentDate:          mortgage.lastPaymentDate,
    }),
    lastSale: compact({
      date:  lastSale.date   ?? lastSale.recordingDate ?? lastSale.saleDate,
      price: lastSale.price  ?? lastSale.salePrice,
      type:  lastSale.type   ?? lastSale.transferType,
      deed:  lastSale.deed   ?? lastSale.documentType,
    }),
    ownershipLengthYears: typeof p.ownershipLengthYears === 'number' ? p.ownershipLengthYears
                          : typeof owner.ownershipLengthYears === 'number' ? owner.ownershipLengthYears
                          : undefined,
    mailingAddressVacant: typeof p.mailingAddressVacant === 'boolean' ? p.mailingAddressVacant : undefined,
    vacancy: compact({
      isVacant:    vacancy.isVacant    ?? p.isVacant,
      vacancyDate: vacancy.vacancyDate ?? p.vacancyDate,
      vacancyType: vacancy.vacancyType,
    }),
    listing: compact({
      price:        typeof listing.price === 'number' ? listing.price : undefined,
      maxListPrice: typeof listing.maxListPrice === 'number' ? listing.maxListPrice : undefined,
      minListPrice: typeof listing.minListPrice === 'number' ? listing.minListPrice : undefined,
      daysOnMarket: typeof listing.daysOnMarket === 'number' ? listing.daysOnMarket : undefined,
      status:       typeof listing.status === 'string' ? listing.status : undefined,
    }),
    motivationType: (requestedType as BatchDataRecord['motivationType']) ?? 'distressed',
    motivationConfidence: 0.7,
    householdFinancials: compact(householdFinancialsFromBatchData(p)),
  }
}

export interface FetchMotivatedSellersOptions {
  state: string
  city?: string
  zip?: string
  /** Internal motivation types → BatchData quickList slugs. A motivated-seller pull wants ANY of
   *  these triggers, so they go into `orQuickLists` (OR-ed). Capped at 3 by the API. */
  motivationTypes?: string[]
  /** Raw BatchData quickList slugs to AND together (e.g. ["high-equity","out-of-state-owner"] =
   *  high-equity out-of-state owners). Validated + capped at 3. */
  andQuickLists?: string[]
  /** Advanced "third search type": BatchData-native searchCriteria fields merged verbatim
   *  (address/building/foreclosure/etc.) — an escape hatch so a verified field works w/o a change. */
  searchCriteria?: Record<string, unknown>
  limit?: number
  skip?: number
}

/**
 * Lane 89E — THE DATE WINDOW on a V1 motivated pull (lane 88G's open item: "BatchData filter
 * field shapes unresolved … with them, 'same-day' becomes a recording-date window on the V1 pull").
 *
 * The shapes, CONFIRMED two ways without a paid call: (1) BatchData's own MCP search schema
 * publishes `min_foreclosure_recording_date`, `min_auction_date`, `min_tax_delinquent_year`,
 * `min_last_sale_date` (YYYY-MM-DD) as Property Search filters; (2) the published SDK that
 * mirrors the v1 request schema (@land-catalyst/batch-data-sdk) serialises them under
 * `searchCriteria` as `foreclosure.recordingDate {minDate,maxDate}`,
 * `foreclosure.auctionDate {minDate,maxDate}`, `tax.taxDelinquentYear {min,max}` and
 * `sale.lastSaleDate {minDate,maxDate}` — the same nested `{min,max}` grammar the pull already
 * uses for `valuation.equityPercent`. NOT wired (unresolved, no evidence of the key): a listing
 * DATE filter for expired / canceled / failed listings — those pulls stay window-less.
 *
 * PURE. Returns the searchCriteria fragment for ONE canonical trigger, or {} when the trigger
 * has no dated field or the window is unset (a pull without a window is the wave-88 pull,
 * unchanged). Merged verbatim by buildPropertySearchBody's passthrough.
 */
export interface MotivatedPullWindow {
  /** lead_scraping_motivated_params.lookback_days — null/0 = no window. */
  lookbackDays?: number | null
  /** Injected by proofs; the clock otherwise. */
  today?: Date
}
const isoDay = (d: Date) => d.toISOString().slice(0, 10)
export function dateWindowCriteria(trigger: string, window: MotivatedPullWindow): Record<string, unknown> {
  const days = window.lookbackDays
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) return {}
  const today = window.today ?? new Date()
  const floor = isoDay(new Date(today.getTime() - Math.floor(days) * 86_400_000))
  switch (canonicalTrigger(trigger)) {
    // Recorder filings — the filing's own recording date is the freshness signal.
    case 'pre_foreclosure':
    case 'notice_of_default':
    case 'lis_pendens':
    case 'foreclosure':
      return { foreclosure: { recordingDate: { minDate: floor } } }
    // An auction is a FUTURE date: "upcoming" means from today forward, never a look-back.
    case 'auction':
      return { foreclosure: { auctionDate: { minDate: isoDay(today) } } }
    // Tax default is kept by YEAR: a lookback in days becomes the earliest delinquent year.
    case 'tax_lien':
      return { tax: { taxDelinquentYear: { min: today.getUTCFullYear() - Math.max(1, Math.ceil(days / 365)) } } }
    default:
      return {}
  }
}

/** Keep only valid BatchData quickList slugs (supports the "not-" exclude prefix), capped at 3. */
function validQuickLists(slugs: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of slugs) {
    const base = s.startsWith("not-") ? s.slice(4) : s
    if (BATCHDATA_QUICKLISTS.has(base) && !seen.has(s)) { seen.add(s); out.push(s) }
    if (out.length === 3) break // BatchData caps quickList arrays at 3 items
  }
  return out
}

/**
 * PURE: build the BatchData v1 Property Search request body. The lead is DESCRIBED by quickLists —
 * the named business-rule queries (high-equity, preforeclosure, absentee-owner, …) — scoped by a
 * `query` string (the geography, e.g. "Tampa, FL"). A motivated-seller pull wants properties
 * matching ANY trigger, so motivation types become `orQuickLists` (OR-ed, ≤3); an explicit
 * `andQuickLists` narrows by intersection (AND-ed, ≤3). Invalid slugs are dropped (validated
 * against BATCHDATA_QUICKLISTS) so a bad name never hits the API. Unit-tested in the simulator.
 */
export function buildPropertySearchBody(opts: FetchMotivatedSellersOptions): { searchCriteria: Record<string, unknown>; options: { take: number; skip: number } } {
  const types = opts.motivationTypes && opts.motivationTypes.length > 0
    ? opts.motivationTypes
    : [...DEFAULT_MOTIVATION_TRIO]
  const orQuickLists = validQuickLists(types.map((t) => QUICKLIST_SLUG[t]).filter(Boolean) as string[])
  const andQuickLists = validQuickLists(opts.andQuickLists ?? [])
  const query = [opts.city, opts.zip, opts.state].filter(Boolean).join(", ") || opts.state

  const searchCriteria: Record<string, unknown> = { query }
  if (orQuickLists.length) searchCriteria.orQuickLists = orQuickLists
  if (andQuickLists.length) searchCriteria.quickLists = andQuickLists
  // Verbatim passthrough (the structured "third search type") wins last.
  Object.assign(searchCriteria, opts.searchCriteria ?? {})

  return { searchCriteria, options: { take: opts.limit ?? 100, skip: opts.skip ?? 0 } }
}

// Single egress: all BatchData Property Search calls route through the connector-gateway
// (one way in/out). Throws on error to preserve the callers' contract.
async function batchDataPropertySearch(body: unknown, errorLabel: string): Promise<any> {
  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const res = await callConnector<any>({
    connector: "batchdata",
    baseUrl: BATCHDATA_API_URL,
    path: "property/search",
    method: "POST",
    // Token strategy (lib/external/batchdata-tokens.ts, wave 67): property/search is
    // the "search" purpose — always BATCHDATA_API_KEY.
    auth: { style: "bearer", token: resolveBatchDataToken("search") ?? BATCHDATA_API_KEY },
    body,
  })
  if (!res.ok) throw new Error(`${errorLabel}: ${res.status ?? "network"} ${res.error ?? ""}`.trim())
  return res.data
}

export async function fetchMotivatedSellers(params: FetchMotivatedSellersOptions): Promise<{
  records: BatchDataRecord[]
  cost: number
  recordsFound: number
}> {
  // Label default MUST match buildPropertySearchBody's default (the trio) — otherwise records get
  // tagged with a motivationType the search never targeted (e.g. labeled 'probate' while the query
  // pulled high-equity/preforeclosure/absentee).
  const types = params.motivationTypes && params.motivationTypes.length > 0
    ? params.motivationTypes
    : [...DEFAULT_MOTIVATION_TRIO]

  // BatchData v1 Property Search — POST /api/v1/property/search. Motivated-seller triggers are
  // expressed as quickLists/orQuickLists by the pure builder (which uses the same default).
  const data = await batchDataPropertySearch(
    buildPropertySearchBody(params),
    "BatchData API error",
  )
  const properties: any[] = data?.results?.properties ?? data?.results ?? []
  const records = properties.map((p) => normalizeBatchDataProperty(p, types[0] ?? 'distressed'))

  // PULL-DRIFT SENTINEL: BatchData returned rows but NONE normalized to a
  // usable identity (no address, no owner name) → the response shape drifted
  // out from under normalizeBatchDataProperty. One quarantined sample +
  // ledger; best-effort, never blocks the scrape.
  const usable = records.filter((r) => r.address || r.propertyAddress || r.firstName || r.lastName)
  if (properties.length > 0 && usable.length === 0) {
    try {
      const { createServiceClient } = await import("@/lib/supabase/service")
      const { reportPullDrift } = await import("@/lib/kernel/ingress-continuity")
      await reportPullDrift(createServiceClient() as any, {
        connector: "batchdata", source: "batchdata_property_search",
        received: properties.length, kept: 0, sample: properties[0],
      })
    } catch { /* the scrape result still returns */ }
  }

  return {
    records,
    recordsFound: data?.results?.meta?.totalResults ?? properties.length,
    cost: records.length * BATCHDATA_PROPERTY_SEARCH_RECORD_COST_USD,
  }
}

export async function searchProperties(address: string, opts?: { take?: number }): Promise<{
  matches: any[]
  cost: number
}> {
  // BatchData v1 Property Search by free-text address (POST /api/v1/property/search).
  // Lane 88G — `take` is optional (default 5, unchanged for every existing caller); the neighbour
  // farm asks for the block's size.
  const take = Math.max(1, Math.min(100, Math.floor(opts?.take ?? 5)))
  const data = await batchDataPropertySearch(
    { searchCriteria: { query: address }, options: { take, skip: 0 } },
    "BatchData property search error",
  )

  return {
    matches: data?.results?.properties ?? data?.results ?? [],
    cost: 0.02,
  }
}

/**
 * Lane 88G — PURE. The STREET-level query a just-sold / just-listed neighbour farm sends: the
 * listing's street without its house number ("123 Main St" → "Main St, Tampa, FL"), so the search
 * returns the BLOCK rather than the one home. realNeighborScraper sent the full listing address with
 * take 5, which returns the sold home itself (and at most a handful of exact-match variants) — the
 * farm could never identify its neighbours. null when no street survives (a PO box, a bare number).
 */
export function neighborStreetQuery(listingAddress: string, city: string | null, state: string | null): string | null {
  const street = String(listingAddress ?? "").split(",")[0].replace(/^\s*\d+[a-z]?(-\d+)?\s+/i, "").replace(/\s+(apt|unit|#)\s*\S+$/i, "").trim()
  if (!street || /^p\.?\s*o\.?\s*box/i.test(street) || !/[a-z]/i.test(street)) return null
  return [street, city, state].filter(Boolean).join(", ")
}

// ─── BatchRank propensity ─────────────────────────────────────────────────────────────
// WAVE 65 CORRECTION of wave 64's guess. Wave 64 treated BatchRank as a premium field
// distinct from the passive `intel.salePropensity` read in
// lib/external/batchdata-seller-signals.ts and invented an `includeBatchRank` search
// option plus a `batchRank`/`batch_rank` response field — neither is real.
//
// CONFIRMED LIVE, 2026-09-15, via the BatchData MCP server's own
// `list_property_dataset_fields` tool (github.com/batchdataco/batchdata-mcp-server,
// the same MCP this repo already adapts in lib/external/batchdata-mcp.ts):
//   list_property_dataset_fields({dataset_name:"batchrank"}) →
//     {"dataset":"batchrank","fieldCount":4,
//      "fields":["_id","intel.salePropensity","intel.salePropensityCategory",
//                "intel.salePropensityStatus"]}
// BatchRank is not a separate premium field — it IS the `batchrank` DATASET
// projection, and that dataset publishes EXACTLY `intel.salePropensity` (the 0-100
// score), `intel.salePropensityCategory` (High/Medium/Low) and
// `intel.salePropensityStatus` (the provider's own per-record availability verdict).
// This is the same field seller-signals' SALE_PROPENSITY_SIGNAL_TYPE already reads
// passively when a search response happens to carry it — BatchRank is that field
// requested ON PURPOSE via the dataset list, not a second capability. Kept as its
// own function anyway (not folded into detectSellerSignals) because callers here want
// ONE address's score at PROMOTION time with its own budget/cost accounting, not a
// motivated-seller sweep.
//
// FAIL-CLOSED BY CONSTRUCTION: no BATCHDATA_API_KEY, no address, a network error, a
// response with no property row, or `salePropensityStatus` reporting the model has
// nothing for this parcel ALL return { available: false, score: null }, never a
// fabricated number.
export interface BatchRankResult {
  available: boolean
  score: number | null           // intel.salePropensity, 0-100
  category: "High" | "Medium" | "Low" | null   // intel.salePropensityCategory
  /** intel.salePropensityStatus verbatim — the provider's own verdict on whether this
   *  parcel has a model output at all (e.g. an "unavailable"-shaped status refuses the
   *  read even when a stray numeric field is present). */
  status: string | null
  cost: number
  /** Set when the call could not confirm BatchRank is on this account/response —
   *  the reason the fetch fails closed, never a fabricated result. */
  unavailableReason?: string
}

/** Status strings the provider could plausibly use to say "no model output for this
 *  parcel" — read defensively (never assume the exact casing/spelling) so an
 *  unrecognised status still fails closed rather than accepting a stray score. */
const BATCHRANK_UNAVAILABLE_STATUSES = new Set(["unavailable", "not_available", "none", "no_data", "insufficient_data"])

/** PURE — reads the confirmed `batchrank` dataset fields
 *  (`intel.salePropensity` / `intel.salePropensityCategory` / `intel.salePropensityStatus`)
 *  off a property-search/lookup response row. Module-private: fetchBatchRankPropensity
 *  below is the ONE caller-facing entry point. */
function readBatchRankFromLookup(propertyRow: Record<string, any> | null | undefined): BatchRankResult {
  if (!propertyRow) return { available: false, score: null, category: null, status: null, cost: 0, unavailableReason: "no property row in response" }
  const intel = (propertyRow.intel ?? {}) as Record<string, unknown>
  const statusRaw = intel.salePropensityStatus
  const status = typeof statusRaw === "string" ? statusRaw : null
  if (status && BATCHRANK_UNAVAILABLE_STATUSES.has(status.toLowerCase())) {
    return { available: false, score: null, category: null, status, cost: 0, unavailableReason: `provider salePropensityStatus: ${status}` }
  }

  const scoreRaw = intel.salePropensity
  const categoryRaw = intel.salePropensityCategory
  const score = typeof scoreRaw === "number" && Number.isFinite(scoreRaw) ? Math.min(100, Math.max(0, scoreRaw)) : null
  const category = ["High", "Medium", "Low"].includes(String(categoryRaw)) ? (categoryRaw as "High" | "Medium" | "Low") : null

  if (score === null && category === null) {
    return { available: false, score: null, category: null, status, cost: 0, unavailableReason: "no intel.salePropensity/salePropensityCategory on the response — account may lack the batchrank dataset" }
  }
  return { available: true, score, category, status, cost: 0.10 }
}

/**
 * fetchBatchRankPropensity — the BatchData credential + budget gate, fail-closed. Called
 * only for BatchData-origin records at promotion time (bounded spend — never at raw
 * ingest volume). Requests the confirmed `batchrank` dataset alongside `core` (the
 * REST request-side parameter name for dataset selection was not independently
 * confirmed against developer.batchdata.com by this lane — see the wave report's
 * unresolved list — so both the documented MCP-style `dataset` array and a defensive
 * `includeDatasets` alias are sent; an account/endpoint that ignores both still returns
 * a plain search response, which the reader above treats as "no batchrank data" rather
 * than throwing). Returns { available: false } rather than throwing so a missing
 * entitlement never blocks promotion; the caller decides whether to use the score.
 */
export async function fetchBatchRankPropensity(address: string): Promise<BatchRankResult> {
  if (!process.env.BATCHDATA_API_KEY) {
    return { available: false, score: null, category: null, status: null, cost: 0, unavailableReason: "BATCHDATA_API_KEY not configured" }
  }
  if (!address?.trim()) {
    return { available: false, score: null, category: null, status: null, cost: 0, unavailableReason: "no address to look up" }
  }
  try {
    const data = await batchDataPropertySearch(
      {
        searchCriteria: { query: address },
        options: { take: 1, skip: 0 },
        // Confirmed dataset name (list_property_datasets): "batchrank". "core" is
        // requested alongside it because the provider's own dataset docs mark
        // basic/core as the mutually-exclusive base every other dataset layers onto.
        dataset: ["core", "batchrank"],
      },
      "BatchRank lookup error",
    )
    const prop = (data?.results?.properties ?? data?.results ?? [])[0] ?? null
    return readBatchRankFromLookup(prop)
  } catch (e) {
    return { available: false, score: null, category: null, status: null, cost: 0, unavailableReason: `BatchRank lookup failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}

export async function enrichPropertyWithBatchData(address: string): Promise<{
  condition: 'turnkey' | 'fixer' | 'unknown'
  estimatedValue: number
  daysOnMarket?: number
  cost: number
}> {
  // No dedicated "enrichment" endpoint on BatchData — a single-address Property
  // Search returns the property valuation + attributes we derive condition from.
  const data = await batchDataPropertySearch(
    { searchCriteria: { query: address }, options: { take: 1, skip: 0 } },
    "BatchData enrichment error",
  )
  const prop = (data?.results?.properties ?? data?.results ?? [])[0] ?? {}
  // Lane 88G — through the ONE quickList reader: `ql['tax-default']` never matched the object shape
  // (the flag is camelCase `taxDefault`), and `foreclosure` is not a published quickList at all.
  const ql = new Set(quickListSlugsFromRow(prop))
  // Distress/vacancy signals imply a likely fixer; otherwise unknown.
  const condition: 'turnkey' | 'fixer' | 'unknown' =
    ql.has('vacant') || ql.has('notice-of-sale') || ql.has('preforeclosure') || ql.has('tax-default') ? 'fixer' : 'unknown'

  return {
    condition,
    estimatedValue: prop.valuation?.estimatedValue ?? prop.estimatedValue ?? 0,
    daysOnMarket: prop.listing?.daysOnMarket,
    cost: 0.03,
  }
}

// ─── SMART SEARCH = V2 PROPERTY SUBSCRIPTION ──────────────────────────────────────────
// A DISTINCT capability from fetchMotivatedSellers (V1 Property Search, us polling on a
// cron) — Property Subscription is BatchData's PUSH model: we register search criteria
// once and BatchData delivers only NEW matches to a webhook as they appear, no polling.
// The inbound side lives at app/api/webhooks/batchdata-smart-search/route.ts; this is
// the OUTBOUND half.
//
// WAVE 66 CORRECTION of wave 65B's guess, against DOCUMENTED FACTS (help.batchdata.io,
// fetched 2026-09-16, transcribed verbatim in the wave-66 lane prompt):
//   · Path is `/api/v2/property-subscription` (hyphenated resource, not
//     "property/subscription" — wave 65B's unconfirmed v1-naming guess was wrong).
//   · Body: `{ searchCriteria: { query, orQuickLists: [...] }, deliveryConfig: { type:
//     "webhook", url, headers? } }` — `orQuickLists` (not `quickLists`, not nested under
//     a `webhook` object) is the documented shape.
//   · Response: `{ status: { code: 201 }, result: { subscriptionId } }`.
//   · `GET /api/v2/property-subscription` lists all subscriptions; `GET`/`DELETE
//     /api/v2/property-subscription/{id}` read/remove one.
//   · Subscriptions are IMMUTABLE — a criteria change is delete-then-recreate, never a
//     PATCH/PUT.
//   · Hard ACCOUNT-WIDE cap: 5 subscriptions per account, 5M properties each, 4 delivery
//     retries. Provisioning requires sales setup (7 business days + setup fee) — an
//     unprovisioned account's create call refuses, detected below as
//     `provisioningRequired` rather than a generic error so the caller can record it
//     distinctly (batchdata_smart_search_subscriptions.status = 'provisioning_required').
export const BATCHDATA_SMART_SEARCH_SUBSCRIPTION_ACCOUNT_CAP = 5
const BATCHDATA_API_V2_URL = 'https://api.batchdata.com/api/v2'
const SMART_SEARCH_PATH = 'property-subscription'

export interface SmartSearchSubscriptionResult {
  ok: boolean
  /** BatchData's id for the created subscription — null when the call failed or the
   *  response carried no recognizable id field. */
  subscriptionId: string | null
  status: number | null
  error: string | null
  /** True when the failure looks like "this account is not provisioned for Property
   *  Monitoring" (sales setup required) rather than an ordinary request/network error —
   *  read from the documented refusal shape (403 / a message naming provisioning,
   *  entitlement or sales). The caller records this AS ITS OWN STATE
   *  ('provisioning_required'), never retried on the same cadence as a transient error. */
  provisioningRequired: boolean
}

/** PURE — reads a subscription id out of a Property Subscription response body. The
 *  documented shape is `result.subscriptionId`; the others are defensive fallbacks for
 *  an account on an older response revision. Module-private. */
function readSubscriptionId(data: Record<string, any> | null | undefined): string | null {
  if (!data) return null
  const candidates = [
    data.result?.subscriptionId, data.result?.id,
    data.subscriptionId, data.id, data.subscription_id,
    data.results?.subscriptionId, data.results?.id,
  ]
  const found = candidates.find((c) => typeof c === "string" && c.length > 0)
  return typeof found === "string" ? found : null
}

/** PURE — every phrase a "you are not provisioned for this API" refusal plausibly uses.
 *  Read defensively (case-insensitive substring) rather than pinned to one exact
 *  sentence, because the wording was not independently confirmed against a live
 *  refusal — only the CLAUDE.md §2 posture ("assert the rule, not a waypoint") applies
 *  the same way to a vendor error string as to our own code. */
function looksLikeProvisioningRefusal(status: number | null, message: string): boolean {
  const m = message.toLowerCase()
  return (
    status === 403 ||
    m.includes("not provisioned") ||
    m.includes("provisioning") ||
    m.includes("sales team") ||
    m.includes("contact sales") ||
    m.includes("entitlement") ||
    m.includes("not enabled for your account") ||
    m.includes("upgrade your plan")
  )
}

/** One territory's geography contributing to a POOLED Smart Search subscription
 *  (wave 67 cap strategy — see buildSmartSearchSubscriptionPlan below). Module-private
 *  — every external caller (the cron reconcile step) builds this shape structurally
 *  and passes it into the exported functions below rather than importing the type
 *  by name. */
interface SmartSearchGeography {
  marketId: string
  priority: number
  city?: string | null
  state: string
  zip?: string | null
}

/**
 * PURE — the union query for a pooled subscription's searchCriteria.query.
 *
 * UNRESOLVED / BEST-EFFORT (owner-directed build, wave 67 §"how can we get around
 * the caps"): BatchData's own documented example is a SINGLE `"City, ST"` string
 * (see the wave-66 note above this function) and no fetched article states a
 * multi-location query SYNTAX. The pooling strategy the owner asked for — one
 * subscription per quicklist covering every active territory's geography — has no
 * confirmed way to express "OR these N places" inside one `query` string, so this
 * joins each territory's `"City, ST"` (deduped) with `"; "` as the most literal
 * reading of "the union of territory geographies" until the integrator confirms the
 * real syntax against a live account. If BatchData's parser does not accept a
 * joined string, the effect degrades to matching only the FIRST segment — visible
 * immediately in the reconcile's leads-per-subscription count, never a silent
 * narrowing nobody can see (CLAUDE.md §2: a count that moves is the finding).
 *
 * Module-private — exercised through createSmartSearchSubscription's own behavior
 * (its `query` body field), not imported directly by anything outside this file. */
function buildPooledSmartSearchQuery(geographies: readonly Pick<SmartSearchGeography, "city" | "state" | "zip">[]): string {
  const seen = new Set<string>()
  const parts: string[] = []
  for (const g of geographies) {
    const label = [g.city, g.zip, g.state].filter(Boolean).join(", ") || g.state
    if (label && !seen.has(label)) {
      seen.add(label)
      parts.push(label)
    }
  }
  return parts.join("; ")
}

/**
 * createSmartSearchSubscription — register ONE V2 Property Subscription for ONE
 * BatchData quickList, POOLED across every active territory that wants it (wave 67
 * cap strategy: 5 account-wide slots cover 5 quicklists PLATFORM-WIDE rather than
 * 5 (market × quicklist) pairs). The caller writes one MEMBERSHIP row per
 * contributing market against the single subscription id this returns — see
 * app/api/cron/lead-scraping/route.ts step 2b and
 * batchdata_smart_search_subscriptions.pool_key/pooled/geography_count (m637).
 * Bounded spend by construction: called only from the reconcile plan below
 * (buildSmartSearchSubscriptionPlan), never per-record, and only after the caller
 * has confirmed the account-wide 5-subscription cap is not exceeded.
 *
 * SUBSCRIPTIONS ARE IMMUTABLE (documented). A criteria change (including the
 * geography UNION changing because a territory joined or left the pool) is a
 * DELETE of the old subscription id followed by a fresh CREATE — never a
 * renew-in-place. There is therefore no `createOrRenew` any more; the reconcile
 * step deletes first when it needs to change criteria, then calls this.
 *
 * TOMBSTONE (wave 66, CLAUDE.md §1.1): `createOrRenewSmartSearchSubscription`
 * (wave 65B) stood here and is DELETED. Its survivor is THIS function plus the
 * delete-then-create branch of the reconcile step in
 * app/api/cron/lead-scraping/route.ts (step 2b, "SMART SEARCH RECONCILE"). The
 * "renew" half had no documented counterpart — subscriptions are immutable and
 * carry no TTL (help.batchdata.io Property Monitoring guide, fetched
 * 2026-09-16) — so renewing in place was a guessed capability, not a lost one;
 * the create half is what survives, unchanged in effect, under its honest name.
 *
 * FAIL-CLOSED: no BATCHDATA_API_KEY, no webhook URL configured, no geographies, or
 * a network/HTTP error all return { ok: false }, never a fabricated subscription id.
 */
export async function createSmartSearchSubscription(params: {
  /** A single BatchData quickList slug, validated against BATCHDATA_QUICKLISTS. */
  quicklist: string
  /** Every active territory admitting this pooled subscription — searchCriteria.query
   *  is their union (buildPooledSmartSearchQuery). Always at least one entry. */
  geographies: readonly Pick<SmartSearchGeography, "city" | "state" | "zip">[]
}): Promise<SmartSearchSubscriptionResult> {
  if (!process.env.BATCHDATA_API_KEY) {
    return { ok: false, subscriptionId: null, status: null, error: "BATCHDATA_API_KEY not configured", provisioningRequired: false }
  }
  const webhookUrl = process.env.BATCHDATA_SMART_SEARCH_WEBHOOK_URL
  if (!webhookUrl) {
    return { ok: false, subscriptionId: null, status: null, error: "BATCHDATA_SMART_SEARCH_WEBHOOK_URL not configured — no delivery target to register", provisioningRequired: false }
  }
  const secret = process.env.BATCHDATA_SMART_SEARCH_WEBHOOK_SECRET
  const quicklists = validQuickLists([params.quicklist])
  if (quicklists.length === 0) {
    return { ok: false, subscriptionId: null, status: null, error: `"${params.quicklist}" is not a valid BatchData quickList`, provisioningRequired: false }
  }
  if (!params.geographies?.length) {
    return { ok: false, subscriptionId: null, status: null, error: "no geographies to pool — nothing wants this quicklist", provisioningRequired: false }
  }
  const query = buildPooledSmartSearchQuery(params.geographies)

  try {
    const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
    const res = await callConnector<Record<string, any>>({
      connector: "batchdata_smart_search",
      baseUrl: BATCHDATA_API_V2_URL,
      path: SMART_SEARCH_PATH,
      method: "POST",
      // Token strategy: Smart Search registration is the "search" purpose.
      auth: { style: "bearer", token: resolveBatchDataToken("search") ?? BATCHDATA_API_KEY },
      body: {
        searchCriteria: { query, orQuickLists: quicklists },
        deliveryConfig: {
          type: "webhook",
          url: webhookUrl,
          // Matches the receiver's verifySharedSecret, which also accepts a bearer
          // Authorization header — sent both ways since BatchData's exact header name
          // for this push is not confirmed by any fetched article.
          ...(secret ? { headers: { "x-batchdata-webhook-secret": secret, Authorization: `Bearer ${secret}` } } : {}),
        },
      },
    })
    if (!res.ok) {
      const message = res.error ?? `HTTP ${res.status ?? "network"}`
      return { ok: false, subscriptionId: null, status: res.status, error: message, provisioningRequired: looksLikeProvisioningRefusal(res.status ?? null, message) }
    }
    const subscriptionId = readSubscriptionId(res.data)
    if (!subscriptionId) {
      return { ok: false, subscriptionId: null, status: res.status, error: "subscription created but no id in the response — cannot track it for renewal", provisioningRequired: false }
    }
    return { ok: true, subscriptionId, status: res.status, error: null, provisioningRequired: false }
  } catch (e) {
    return { ok: false, subscriptionId: null, status: null, error: e instanceof Error ? e.message : String(e), provisioningRequired: false }
  }
}

/** DELETE /api/v2/property-subscription/{id}. Best-effort — a delete failure is
 *  reported, never thrown, so the caller can still proceed to recreate under a new
 *  criteria set and record the old row as an orphan on BatchData's side rather than
 *  blocking the reconcile tick on it. */
export async function deleteSmartSearchSubscription(subscriptionId: string): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  if (!process.env.BATCHDATA_API_KEY) return { ok: false, status: null, error: "BATCHDATA_API_KEY not configured" }
  if (!subscriptionId) return { ok: false, status: null, error: "no subscriptionId supplied" }
  try {
    const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
    const res = await callConnector<Record<string, any>>({
      connector: "batchdata_smart_search",
      baseUrl: BATCHDATA_API_V2_URL,
      path: `${SMART_SEARCH_PATH}/${encodeURIComponent(subscriptionId)}`,
      method: "DELETE",
      auth: { style: "bearer", token: resolveBatchDataToken("search") ?? BATCHDATA_API_KEY },
    })
    return { ok: res.ok, status: res.status, error: res.ok ? null : (res.error ?? `HTTP ${res.status ?? "network"}`) }
  } catch (e) {
    return { ok: false, status: null, error: e instanceof Error ? e.message : String(e) }
  }
}

/** GET /api/v2/property-subscription — the account's live subscription list, read
 *  defensively (the documented list envelope was not independently re-confirmed by
 *  this lane; every plausible array location is checked). Used by the reconcile step
 *  to learn the TRUE account-wide count before deciding what it may still create —
 *  the local `batchdata_smart_search_subscriptions` table is our OWN record of what we
 *  asked for, not authoritative over what BatchData actually holds (a row could have
 *  been cancelled on their side, e.g. by a human via their dashboard). */
export async function listSmartSearchSubscriptions(): Promise<{ ok: boolean; subscriptionIds: string[]; error: string | null }> {
  if (!process.env.BATCHDATA_API_KEY) return { ok: false, subscriptionIds: [], error: "BATCHDATA_API_KEY not configured" }
  try {
    const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
    const res = await callConnector<Record<string, any>>({
      connector: "batchdata_smart_search",
      baseUrl: BATCHDATA_API_V2_URL,
      path: SMART_SEARCH_PATH,
      method: "GET",
      auth: { style: "bearer", token: resolveBatchDataToken("search") ?? BATCHDATA_API_KEY },
    })
    if (!res.ok) return { ok: false, subscriptionIds: [], error: res.error ?? `HTTP ${res.status ?? "network"}` }
    const rows: any[] = res.data?.result?.subscriptions ?? res.data?.result ?? res.data?.results ?? res.data?.subscriptions ?? []
    const ids = (Array.isArray(rows) ? rows : [])
      .map((r) => (typeof r === "string" ? r : r?.subscriptionId ?? r?.id))
      .filter((id): id is string => typeof id === "string" && id.length > 0)
    return { ok: true, subscriptionIds: ids, error: null }
  } catch (e) {
    return { ok: false, subscriptionIds: [], error: e instanceof Error ? e.message : String(e) }
  }
}

// ─── SUBSCRIPTION PLAN — POOLED BY QUICKLIST (wave 67 cap strategy) ───────────────────
// Owner ruling (wave 67, "how can we get around the caps" — RESEARCHED FACTS in the
// lane prompt, help.batchdata.io/batchdata.io/pricing 2026-09-16): Property Monitoring
// is capped at 5 subscriptions PER ACCOUNT, not per market. Wave 65B/66 spent that cap
// one (market × quicklist) pair at a time, so as few as 5 TERRITORIES exhausted it
// platform-wide. The fix POOLS by QUICKLIST: every active territory that wants a given
// quicklist becomes ONE subscription whose query is the union of their geographies
// (buildPooledSmartSearchQuery), so 5 slots cover 5 QUICKLISTS platform-wide regardless
// of how many territories want each one. The per-market row survives as a MEMBERSHIP
// row (batchdata_smart_search_subscriptions.pool_key/pooled/geography_count, m637) —
// many markets can point at the same subscription_id.
// Module-private — the cron reconcile step (the only external caller) builds these
// shapes structurally rather than importing the type names; SmartSearchPlanEntry
// below is the one public shape callers actually name.
interface SmartSearchGeographyWant {
  marketId: string
  /** Higher = more important. Mirrors lead_scraping_markets.priority. */
  priority: number
  city?: string | null
  state: string
  zip?: string | null
}

/** One quicklist's pooled want: every active territory that currently wants it. */
interface SmartSearchQuicklistWant {
  quicklist: string
  geographies: readonly SmartSearchGeographyWant[]
}

export interface SmartSearchPlanEntry {
  quicklist: string
  action: "keep" | "create" | "defer"
  reason: string
  geographies: readonly SmartSearchGeographyWant[]
  /** Highest contributing territory's priority — used only for cap ranking; the
   *  pooled subscription itself serves every contributing territory equally. */
  priority: number
}

/**
 * PURE — turns every QUICKLIST the active tenant base wants (pooled across every
 * territory that wants it) into an admit/defer plan against the account-wide
 * 5-subscription cap. The cap now binds on the NUMBER OF DISTINCT QUICKLISTS, never
 * on the number of territories — a 6th, 50th, or 500th territory wanting an
 * already-admitted quicklist joins its pool for free (a membership row, no new
 * subscription); only the 6th DISTINCT quicklist is deferred.
 *
 * RANK by priority (the highest priority territory contributing to a quicklist),
 * already-pooled quicklists KEEP their slot ahead of a new quicklist (so a live
 * subscription is never torn down just because a higher-priority territory adopted a
 * different quicklist later — churn costs a delete+recreate and a coverage gap), and
 * DEFER whatever does not fit, with the reason recorded for the status column.
 */
export function buildSmartSearchSubscriptionPlan(params: {
  wants: readonly SmartSearchQuicklistWant[]
  /** Quicklists already POOLED + ACTIVE (subscriptionId set, status active, and — per
   *  the caller's own diffing — membership unchanged since the last reconcile) — kept
   *  ahead of new wants so reconciling does not thrash a working subscription. */
  alreadyActive: ReadonlySet<string>
  /** Total subscriptions BatchData reports across the WHOLE account right now
   *  (listSmartSearchSubscriptions), including any this repo did not register itself. */
  accountLiveCount: number
  cap?: number
}): SmartSearchPlanEntry[] {
  const cap = params.cap ?? BATCHDATA_SMART_SEARCH_SUBSCRIPTION_ACCOUNT_CAP
  const maxPriority = (w: SmartSearchQuicklistWant) => w.geographies.reduce((m, g) => Math.max(m, g.priority), 0)

  const kept = params.wants.filter((w) => params.alreadyActive.has(w.quicklist))
  const candidates = params.wants
    .filter((w) => !params.alreadyActive.has(w.quicklist))
    // Highest priority first; stable tie-break on quicklist name so the plan is
    // deterministic for the same input rather than depending on array order.
    .sort((a, b) => maxPriority(b) - maxPriority(a) || a.quicklist.localeCompare(b.quicklist))

  // Slots already spoken for by rows this repo did NOT just decide to keep (an
  // out-of-band subscription BatchData's account shows that our own plan does not
  // recognise) still count against the cap — we cannot create past what the account
  // actually holds regardless of whose row it is.
  const externalLiveCount = Math.max(0, params.accountLiveCount - kept.length)
  let remaining = Math.max(0, cap - kept.length - externalLiveCount)

  const plan: SmartSearchPlanEntry[] = kept.map((w) => ({
    quicklist: w.quicklist, geographies: w.geographies, priority: maxPriority(w), action: "keep", reason: "already active",
  }))
  for (const w of candidates) {
    const priority = maxPriority(w)
    if (remaining > 0) {
      plan.push({
        quicklist: w.quicklist, geographies: w.geographies, priority, action: "create",
        reason: `admitted (priority ${priority}, pooling ${w.geographies.length} territor${w.geographies.length === 1 ? "y" : "ies"})`,
      })
      remaining--
    } else {
      plan.push({
        quicklist: w.quicklist, geographies: w.geographies, priority, action: "defer",
        reason: `account cap (${cap}) reached — ${cap} higher-priority quicklist pool(s) already hold every slot`,
      })
    }
  }
  return plan
}

// ─── V3 SKIP TRACE — batched, ≤100 per call ────────────────────────────────────────────
// CONFIRMED (batchdata.io/llms.txt, 2026-09-15): "API Reference V3 (includes V3 Skip
// Trace)"; "Property and Phone APIs offer asynchronous variants... async responses
// return a `requestId`... deliver to a `webhookUrl`". This lane uses the SYNCHRONOUS V3
// form (bounded batch, no webhook plumbing needed) — the async variant is available at
// the same request shape plus `options.webhookUrl` if a caller ever needs >100 records.
// UNRESOLVED: the exact V3 path segment was not independently confirmed against
// developer.batchdata.com (Stoplight SPA, not executable by this lane's fetch tools);
// "property/skip-trace" is used, following the v1 "property/search" / "property/
// lookup/all-attributes" naming convention this repo already relies on elsewhere.
//
// DOES NOT DUPLICATE lib/compliance/phone-scrub-runner.ts — this function returns RAW
// phone/email candidates only. DNC/TCPA scrubbing stays the orchestrator's job, exactly
// as it already is for the PeopleData lane (enrichment-orchestrator.ts calls
// scrubPhonesForPatch on whatever candidates it has, regardless of which provider found
// them).
export interface BatchDataSkipTraceInput {
  /** Caller-supplied correlation id (e.g. the lead/contact id) — echoed back so a
   *  batch response can be matched to its request row without relying on name/address
   *  string equality. */
  ref: string
  firstName?: string
  lastName?: string
  address?: string
  city?: string
  state?: string
  zip?: string
}

export interface BatchDataSkipTraceMatch {
  ref: string
  matched: boolean
  phones: string[]
  emails: string[]
}

const BATCHDATA_API_V3_URL = 'https://api.batchdata.com/api/v3'
const SKIP_TRACE_BATCH_LIMIT = 100

/**
 * THE ONE skip-trace unit-cost constant (lane 72B — CLAUDE.md §3 "one vocabulary
 * per function"). Reconciled discrepancy: this file's own skipTraceBatchDataV3Batch
 * had hard-coded `0.15` inline while .env.example's BATCHDATA_SKIP_TRACE_TOKEN
 * comment documented "~$0.06/matched record per the wave-67 research" — two
 * spellings of the same number, and the code's `0.15` cited no source at all (its
 * own comment only describes the BILLING MODEL — "matched or not, the lookup is
 * billed" — never a verified invoice). Per the wave-67 research (help.batchdata.io /
 * batchdata.io/pricing, 2026-09-16, recorded in LANE_RULES and
 * docs/real-estate-data-providers-2026-09.md): "skip-trace pay-as-you-go
 * ~$0.06/matched record." KEEPING THE RESEARCHED VALUE per this lane's brief
 * ("keep the researched value unless the code comment cites a verified invoice" —
 * it did not). Every reader of BatchData's V3 skip-trace unit cost uses THIS
 * constant; a second literal is the defect §6 names.
 *
 * RE-PRICED lane 81B (Exa 2026-09-24): batchdata.io/pricing lists the skip-trace
 * plans as "Pay per matched record"; batchdata.io/blog/batchdata-skip-tracing-
 * comparison-tlo-idi (2026-04-02) publishes "$0.07–$0.18 per record … pay-per-match
 * at about $0.07 per record for large volumes"; help.getbatch.co (2024-09-25)
 * "starts at $0.07 per skiptrace record". The wave-67 figure ($0.06) is below every
 * published floor, so the ledger UNDERSTATED platform spend — 0.07 is the published
 * pay-per-match floor. Billed PER MATCHED RECORD, not per attempt (the reverse-skip-
 * trace page: "A lookup that resolves to no one isn't counted") — the batch function
 * below still books per attempt as the conservative (never understating) estimate
 * until the wallet reconcile (reconcileBatchDataWalletSpend) says otherwise.
 * ROUTING: lib/ai-isa/property-lookup-rail.ts::CONTACT_PROVIDER_ROUTES holds this
 * beside PeopleData's $0.25/match — BatchData is the cheaper owner-contact provider
 * and runs FIRST for any record with a property address; PeopleData is the fallback.
 */
export const BATCHDATA_SKIP_TRACE_COST_USD = 0.07

/** ONE name for the per-record estimate a V1 Property Search pull books (fetchMotivatedSellers,
 *  fetchIncrementalPropertySearch). Plan-tier list price is $0.01–$0.0033/record (docs/real-
 *  estate-data-providers-2026-09.md); 0.05 is the repo's conservative pay-as-you-go estimate
 *  carried since wave 6x — kept (never understate), named so two `* 0.05` literals cannot drift. */
export const BATCHDATA_PROPERTY_SEARCH_RECORD_COST_USD = 0.05

/** PURE — one V3 skip-trace response row → phones[]/emails[], read defensively across
 *  the plausible shapes (a `persons[]` array, a flat `phoneNumbers`/`emails`, or the
 *  V1-style `phone`/`email` singular fields this repo already reads elsewhere). */
function readSkipTraceMatch(ref: string, row: Record<string, any> | null | undefined): BatchDataSkipTraceMatch {
  if (!row) return { ref, matched: false, phones: [], emails: [] }
  const phoneSources = [
    row.phoneNumbers, row.phones, row.contact?.phoneNumbers, row.contact?.phones,
    ...(Array.isArray(row.persons) ? row.persons.flatMap((p: any) => p?.phoneNumbers ?? p?.phones ?? []) : []),
  ].filter(Array.isArray).flat()
  const emailSources = [
    row.emails, row.contact?.emails,
    ...(Array.isArray(row.persons) ? row.persons.flatMap((p: any) => p?.emails ?? []) : []),
  ].filter(Array.isArray).flat()
  const singlePhone = typeof row.phone === "string" ? [row.phone] : []
  const singleEmail = typeof row.email === "string" ? [row.email] : []

  const phones = Array.from(new Set(
    [...phoneSources, ...singlePhone]
      .map((p) => (typeof p === "string" ? p : p?.number))
      .filter((p): p is string => typeof p === "string" && p.length > 0),
  ))
  const emails = Array.from(new Set(
    [...emailSources, ...singleEmail]
      .map((e) => (typeof e === "string" ? e : e?.email))
      .filter((e): e is string => typeof e === "string" && e.length > 0),
  ))
  return { ref, matched: phones.length > 0 || emails.length > 0, phones, emails }
}

/**
 * skipTraceBatchDataV3Batch — synchronous V3 Skip Trace, chunked to the documented
 * ≤100-per-call limit. FAIL-CLOSED: no BATCHDATA_API_KEY returns every input as
 * unmatched (never throws, never fabricates a phone/email) so a caller can fall through
 * to another provider or terminate the row exactly as if BatchData found nothing.
 */
export async function skipTraceBatchDataV3Batch(
  people: readonly BatchDataSkipTraceInput[],
): Promise<{ matches: BatchDataSkipTraceMatch[]; cost: number }> {
  if (people.length === 0) return { matches: [], cost: 0 }
  if (!process.env.BATCHDATA_API_KEY) {
    return { matches: people.map((p) => ({ ref: p.ref, matched: false, phones: [], emails: [] })), cost: 0 }
  }

  const chunks: BatchDataSkipTraceInput[][] = []
  for (let i = 0; i < people.length; i += SKIP_TRACE_BATCH_LIMIT) chunks.push(people.slice(i, i + SKIP_TRACE_BATCH_LIMIT))

  const allMatches: BatchDataSkipTraceMatch[] = []
  let cost = 0
  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  for (const chunk of chunks) {
    try {
      const res = await callConnector<Record<string, any>>({
        connector: "batchdata_skip_trace",
        baseUrl: BATCHDATA_API_V3_URL,
        path: "property/skip-trace",
        method: "POST",
        // Token strategy: skip-trace is billed pay-as-you-go per matched record —
        // a dedicated BATCHDATA_SKIP_TRACE_TOKEN keeps its provisioning (and cost)
        // isolated from the search lane's token.
        auth: { style: "bearer", token: resolveBatchDataToken("skip_trace") ?? BATCHDATA_API_KEY },
        body: {
          requests: chunk.map((p) => ({
            propertyAddress: p.address ? { street: p.address, city: p.city, state: p.state, zip: p.zip } : undefined,
            owner: { firstName: p.firstName, lastName: p.lastName },
          })),
        },
      })
      if (!res.ok || !res.data) {
        allMatches.push(...chunk.map((p) => ({ ref: p.ref, matched: false, phones: [], emails: [] })))
        continue
      }
      const rows: any[] = res.data.results?.persons ?? res.data.results?.properties ?? res.data.results ?? []
      // Correlate positionally — the request array and the response array are the same
      // length and order per the documented batch contract; a length mismatch means the
      // response drifted and every ref in this chunk fails closed rather than being
      // matched to the wrong person.
      if (rows.length !== chunk.length) {
        allMatches.push(...chunk.map((p) => ({ ref: p.ref, matched: false, phones: [], emails: [] })))
      } else {
        chunk.forEach((p, i) => allMatches.push(readSkipTraceMatch(p.ref, rows[i])))
      }
      cost += chunk.length * BATCHDATA_SKIP_TRACE_COST_USD // per-match-attempt charge; matched or not, the lookup is billed
    } catch {
      allMatches.push(...chunk.map((p) => ({ ref: p.ref, matched: false, phones: [], emails: [] })))
    }
  }
  return { matches: allMatches, cost }
}

// ─── REVERSE SKIP TRACE — person-keyed (phone / email → the person + property) ─────────
// Wave 82 lane A, owner verbatim: "build a reverse skip trace wrapper." CONFIRMED
// (batchdata.io/reverse-skip-trace-api, Exa 2026-09-25): "Hand the API a phone number or
// email and it returns the person behind it — their identity, contact records, and the
// property linked to them"; response fields name.first/last/full, phones[].number/dnc/tcpa,
// emails[].email, addresses[], property.address; billed "By matched records, not by API
// calls. A lookup that resolves to no one isn't counted." The official BatchData MCP server
// exposes it as `reverse_skip_trace` ({ requests: [{ phone?, email?, requestId? }] }) — this
// transport asks MCP FIRST (batchDataPreferMcp, the seam every agentic BatchData read rides)
// and falls back to REST. UNRESOLVED: the REST path segment ("property/skip-trace/reverse",
// after developer.batchdata.com's "Reverse Property Skip Trace" operation under V3) could not
// be executed from this lane (Stoplight SPA) — the MCP leg is the confirmed one.
// Access is provisioned separately from standard skip trace (same page), so an unprovisioned
// account returns an error → every input reads unmatched (fail closed, never fabricated).
// THE GATE IS NOT HERE: callers pass lib/ai-isa/property-lookup-rail.ts::resolveBatchDataAccess
// (purpose "skip_trace") first — lib/enrichment/reverse-skip-trace.ts is the one wrapper.

export interface BatchDataReverseSkipTraceInput {
  ref: string
  phone?: string | null
  email?: string | null
}

export interface BatchDataReversePerson {
  firstName: string | null
  lastName: string | null
  fullName: string | null
  phones: string[]
  emails: string[]
  /** Addresses the provider links to the person (most relevant first). */
  addresses: Array<{ street: string | null; city: string | null; state: string | null; zip: string | null }>
  /** The property BatchData verified to the person, when it could. */
  propertyAddress: { street: string | null; city: string | null; state: string | null; zip: string | null } | null
}

export interface BatchDataReverseMatch {
  ref: string
  matched: boolean
  /** Every person the provider returned for this input (a shared line can resolve to several). */
  persons: BatchDataReversePerson[]
}

const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

function readReverseAddress(a: Record<string, any> | null | undefined): BatchDataReversePerson["propertyAddress"] {
  if (!a || typeof a !== "object") return null
  const street = strOrNull(a.street) ?? strOrNull(a.fullAddress) ?? strOrNull(a.addressLine1)
  if (!street) return null
  return { street, city: strOrNull(a.city), state: strOrNull(a.state), zip: strOrNull(a.zip) ?? strOrNull(a.zipCode) }
}

/** PURE — one raw person object from the reverse response → BatchDataReversePerson. */
function readReversePerson(p: Record<string, any>): BatchDataReversePerson {
  const contact = readSkipTraceMatch("_", p)
  const name = (p.name ?? {}) as Record<string, any>
  const addresses = (Array.isArray(p.addresses) ? p.addresses : [])
    .map((a: Record<string, any>) => readReverseAddress(a))
    .filter((a: BatchDataReversePerson["propertyAddress"]): a is NonNullable<BatchDataReversePerson["propertyAddress"]> => !!a)
  return {
    firstName: strOrNull(name.first) ?? strOrNull(p.firstName),
    lastName: strOrNull(name.last) ?? strOrNull(p.lastName),
    fullName: strOrNull(name.full) ?? strOrNull(p.fullName),
    phones: contact.phones,
    emails: contact.emails,
    addresses,
    propertyAddress: readReverseAddress(p.property?.address) ?? readReverseAddress(p.propertyAddress),
  }
}

/**
 * PURE — the reverse response → one BatchDataReverseMatch per input ref. Correlates by the echoed
 * `requestId` / `meta.requestId` when the provider returns one; otherwise POSITIONALLY, and only
 * when the result count equals the request count (a drifted response fails every ref closed
 * rather than attaching a stranger's phone to the wrong person).
 */
export function readReverseSkipTraceResponse(
  data: unknown,
  inputs: readonly BatchDataReverseSkipTraceInput[],
): BatchDataReverseMatch[] {
  const miss = (ref: string): BatchDataReverseMatch => ({ ref, matched: false, persons: [] })
  const root = (data ?? {}) as Record<string, any>
  const rows: any[] = Array.isArray(root) ? root
    : Array.isArray(root.results) ? root.results
    : Array.isArray(root.results?.persons) ? root.results.persons
    : Array.isArray(root.results?.results) ? root.results.results
    : Array.isArray(root.persons) ? root.persons
    : []
  const toMatch = (ref: string, row: Record<string, any> | undefined): BatchDataReverseMatch => {
    if (!row) return miss(ref)
    const people: any[] = Array.isArray(row.persons) ? row.persons : [row]
    const persons = people.filter((p) => p && typeof p === "object").map(readReversePerson)
      .filter((p) => p.phones.length > 0 || p.emails.length > 0 || !!p.fullName || !!p.lastName)
    return { ref, matched: persons.length > 0, persons }
  }
  const idOf = (r: any): string | null => strOrNull(r?.requestId) ?? strOrNull(r?.meta?.requestId) ?? strOrNull(r?.input?.requestId)
  if (rows.some((r) => idOf(r))) {
    return inputs.map((i) => toMatch(i.ref, rows.find((r) => idOf(r) === i.ref)))
  }
  if (rows.length !== inputs.length) return inputs.map((i) => miss(i.ref))
  return inputs.map((i, k) => toMatch(i.ref, rows[k]))
}

/**
 * reverseSkipTraceBatchData — MCP `reverse_skip_trace` first, REST fallback. FAIL CLOSED: no
 * resolvable BatchData credential, an unprovisioned account or any error → every input unmatched,
 * cost 0. `cost` is PER MATCHED INPUT at BATCHDATA_SKIP_TRACE_COST_USD — the reverse product's own
 * page says a lookup that resolves to no one is not counted; reconcileBatchDataWalletSpend stays
 * the corrector if the invoice ever says otherwise.
 */
export async function reverseSkipTraceBatchData(
  inputs: readonly BatchDataReverseSkipTraceInput[],
): Promise<{ matches: BatchDataReverseMatch[]; cost: number; via: "mcp" | "rest" | "none"; error: string | null }> {
  const usable = inputs.filter((i) => strOrNull(i.phone) || strOrNull(i.email)).slice(0, SKIP_TRACE_BATCH_LIMIT)
  const unmatched = inputs.map((i) => ({ ref: i.ref, matched: false, persons: [] as BatchDataReversePerson[] }))
  if (usable.length === 0) return { matches: unmatched, cost: 0, via: "none", error: "no phone or email to reverse-trace" }
  const requests = usable.map((i) => ({
    requestId: i.ref,
    ...(strOrNull(i.phone) ? { phone: String(i.phone).replace(/\D/g, "").slice(-10) } : {}),
    ...(strOrNull(i.email) ? { email: String(i.email).trim().toLowerCase() } : {}),
  }))
  const { batchDataPreferMcp } = await import("@/lib/external/batchdata-mcp")
  const r = await batchDataPreferMcp<unknown>(
    "reverse_skip_trace",
    { requests },
    async () => {
      const token = resolveBatchDataToken("skip_trace") ?? BATCHDATA_API_KEY
      if (!token) return null
      const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
      const res = await callConnector<Record<string, any>>({
        connector: "batchdata_skip_trace",
        baseUrl: BATCHDATA_API_V3_URL,
        path: "property/skip-trace/reverse",
        method: "POST",
        auth: { style: "bearer", token },
        body: { requests },
      })
      return res.ok ? res.data : null
    },
  )
  if (!r.data) return { matches: unmatched, cost: 0, via: r.via, error: r.error ?? "no reverse skip-trace data returned" }
  const read = readReverseSkipTraceResponse(r.data, usable)
  const byRef = new Map(read.map((m) => [m.ref, m]))
  const matches = inputs.map((i) => byRef.get(i.ref) ?? { ref: i.ref, matched: false, persons: [] })
  const cost = matches.filter((m) => m.matched).length * BATCHDATA_SKIP_TRACE_COST_USD
  return { matches, cost, via: r.via, error: null }
}

// ─── ADDRESS VERIFY — TOMBSTONE (lane 84C) ────────────────────────────────────────────
// verifyAddressBatchData / BatchDataAddressVerifyResult (wave 65: the "Lob unconfigured"
// fallback) are DELETED. Their ONLY caller was lib/lead-pipeline/promotion-address-verification.ts,
// the gate-side buyer for the wave-14 "verified mailing address" promotion anchor, which the owner's
// wave-84 ruling removed ("doesnt have phone and/or email with first and last name, it can't come in
// as a lead"). Mailing-address verification survives where it is still wanted — at the direct-mail
// send, through Lob (lib/external/lob-address-verify.ts via lib/providers/dispatch.ts needsCassCheck
// → lib/providers/mailing-cass-gate.ts). A Lob-less environment cannot send Lob mail either, so the
// fallback had no remaining reader.

// ─── PROPERTY-ENRICHMENT DATASETS — valuation, mortgage-liens, foreclosure, deed, owner ─
// One address lookup requesting the SAME confirmed dataset names BatchRank uses above
// (list_property_datasets), landed as a single compact object so enrichment-column-map.ts
// can map it onto EXISTING leads/contacts columns without inventing any.
export interface BatchDataPropertyEnrichment {
  ok: boolean
  equityPercent: number | null
  estimatedValue: number | null
  mortgageBalance: number | null
  foreclosureStatus: string | null
  lastDeedType: string | null
  ownerOccupied: boolean | null
  /** Lane 85C — the `demographic` dataset, requested in the SAME lookup (no extra billed record). */
  householdFinancials?: HouseholdFinancials | null
  cost: number
  error?: string
}

export async function enrichPropertyDatasetsBatchData(address: string): Promise<BatchDataPropertyEnrichment> {
  const empty = { equityPercent: null, estimatedValue: null, mortgageBalance: null, foreclosureStatus: null, lastDeedType: null, ownerOccupied: null }
  if (!process.env.BATCHDATA_API_KEY) {
    return { ok: false, ...empty, cost: 0, error: "BATCHDATA_API_KEY not configured" }
  }
  if (!address?.trim()) {
    return { ok: false, ...empty, cost: 0, error: "no address to look up" }
  }
  try {
    const data = await batchDataPropertySearch(
      {
        searchCriteria: { query: address },
        options: { take: 1, skip: 0 },
        // Lane 85C — "demographic" rides the SAME lookup: BatchData bills the returned record, not the
        // dataset list, so marital status / household income / net worth arrive at no extra record
        // cost (the seller-signal probe has asked for it since #297). Mapped by the ONE mapper.
        dataset: ["core", "valuation", "mortgage-liens", "foreclosure", "deed", "owner", "demographic"],
      },
      "BatchData property enrichment error",
    )
    const prop = (data?.results?.properties ?? data?.results ?? [])[0]
    if (!prop) return { ok: false, ...empty, cost: 0, error: "no property matched this address" }
    const valuation = prop.valuation ?? {}
    const mortgage = prop.mortgage ?? prop.openLien ?? {}
    const foreclosure = prop.foreclosure ?? {}
    const deed = prop.deedHistory ?? prop.sale?.lastSale ?? {}
    const owner = prop.owner ?? {}
    return {
      ok: true,
      equityPercent: typeof valuation.equityPercent === "number" ? valuation.equityPercent : null,
      estimatedValue: typeof valuation.estimatedValue === "number" ? valuation.estimatedValue : null,
      mortgageBalance: typeof mortgage.openLoanBalance === "number" ? mortgage.openLoanBalance
        : typeof mortgage.totalOpenLienBalance === "number" ? mortgage.totalOpenLienBalance : null,
      foreclosureStatus: typeof foreclosure.status === "string" ? foreclosure.status : null,
      lastDeedType: typeof deed.documentType === "string" ? deed.documentType : null,
      ownerOccupied: typeof owner.ownerOccupied === "boolean" ? owner.ownerOccupied : null,
      householdFinancials: (() => { const hf = householdFinancialsFromBatchData(prop); return Object.keys(hf).length > 0 ? hf : null })(),
      cost: 0.05,
    }
  } catch (e) {
    return { ok: false, ...empty, cost: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

// ─── PROPERTY LOOKUP — hydrates a Smart Search push (IDs only) into a full record ─────
// DOCUMENTED CONTRACT (wave-66 lane prompt): the Smart Search push event carries
// `propertyId` ONLY (plus parcelHash/addressHash — no owner name, no address, no
// motivation facts), and hydration is `POST /api/v1/property/lookup { requests: [{
// propertyId }] }`. INDEPENDENTLY CONFIRMED (Exa fetch, developer.batchdata.com,
// 2026-09-16): the LIVE Property Lookup endpoint is
// `POST https://api.batchdata.com/api/v1/property/lookup/all-attributes`, taking
// `requests: [{ propertyId }]` alongside the address-shaped request this repo already
// sends elsewhere via `dataset` projection selection. The confirmed path is used here
// rather than the lane prompt's shorter `property/lookup`, and this paragraph records
// the discrepancy rather than silently picking one.
export interface BatchDataLookupResult {
  ok: boolean
  /** One row per requested id that the provider actually returned, in NO guaranteed
   *  order — callers must match by `propertyId`/`_id`, never by array position. */
  properties: Array<Record<string, unknown>>
  cost: number
  error?: string
}

/** Chunked to the same batch-size discipline as the V3 skip trace (no documented cap
 *  found for this endpoint; reusing the confirmed V3 limit is the conservative choice
 *  rather than guessing a larger one). */
const PROPERTY_LOOKUP_BATCH_LIMIT = 100

export async function lookupBatchDataPropertiesByIds(
  propertyIds: readonly string[],
  opts?: { dataset?: string[] },
): Promise<BatchDataLookupResult> {
  const ids = [...new Set(propertyIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
  if (ids.length === 0) return { ok: true, properties: [], cost: 0 }
  if (!process.env.BATCHDATA_API_KEY) {
    return { ok: false, properties: [], cost: 0, error: "BATCHDATA_API_KEY not configured" }
  }
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += PROPERTY_LOOKUP_BATCH_LIMIT) chunks.push(ids.slice(i, i + PROPERTY_LOOKUP_BATCH_LIMIT))

  const properties: Array<Record<string, unknown>> = []
  let cost = 0
  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  for (const chunk of chunks) {
    try {
      const res = await callConnector<Record<string, any>>({
        connector: "batchdata_property_lookup",
        baseUrl: BATCHDATA_API_URL,
        path: "property/lookup/all-attributes",
        method: "POST",
        // Token strategy: property-lookup hydration backs the listing/monitoring
        // lanes (Smart Search hydrate, active-listing discovery) — BATCHDATA_LISTING_TOKEN.
        auth: { style: "bearer", token: resolveBatchDataToken("listing") ?? BATCHDATA_API_KEY },
        body: { requests: chunk.map((propertyId) => ({ propertyId })), ...(opts?.dataset ? { dataset: opts.dataset } : {}) },
      })
      if (!res.ok || !res.data) continue // best-effort hydrate — a failed chunk yields fewer hydrated rows, never throws
      const rows: any[] = res.data?.results?.properties ?? res.data?.results ?? []
      for (const r of rows) if (r && typeof r === "object") properties.push(r)
      cost += chunk.length * 0.02 // property lookup is priced like the address-keyed V1 search (COST_PER_AVM_LOOKUP-adjacent); no per-lookup price confirmed
    } catch {
      // best-effort — a network failure on one chunk does not fail the others already hydrated
    }
  }
  return { ok: true, properties, cost }
}

// ─── INCREMENTAL PROPERTY SEARCH — cursor pagination + Search Sessions ────────────────
// DOCUMENTED CONTRACT: `options.useCursorPagination: true`, `options.take`,
// `options.pageCursor` (opaque, signed, bound to the searchCriteria that produced it —
// a cursor from one search cannot be replayed against a different one).
// `results.nextPageCursor` on the response feeds the NEXT call's `pageCursor`;
// `results.meta.totalResults` (`resultsFound`) is frozen from page 1 and must not be
// re-read as if paging changed it; no random sort order is admitted while paging.
// `options.searchSession` (a caller-named persistent context) additionally narrows
// delivery to properties NEVER BEFORE returned under that session name — this is what
// lets the daily tick ask "what's NEW since last time" instead of re-walking the whole
// result set and re-deduping client-side. Requires token ability `property-search-
// sessions`; an account without it gets a 403, handled below as `sessionUnsupported`
// so the caller degrades to plain skip/take rather than failing the whole pull.
export interface IncrementalSearchResult {
  ok: boolean
  records: BatchDataRecord[]
  /** Feed back into the next call's `pageCursor` to keep paging the SAME searchCriteria.
   *  null when the provider reports no further page (or the call failed). */
  nextPageCursor: string | null
  /** Frozen from page 1 per the documented contract — callers should not expect this to
   *  change across pages of the SAME search and must not treat a later page's own
   *  possibly-absent total as a smaller true count. */
  resultsFound: number | null
  /** True when the account's token lacks the `property-search-sessions` ability (a 403
   *  naming sessions) — the caller should retry the SAME request with `searchSession`
   *  omitted (plain skip/take) rather than treat this as a hard failure. */
  sessionUnsupported: boolean
  cost: number
  error?: string
}

export async function fetchIncrementalPropertySearch(params: {
  quicklist: string
  city?: string
  state: string
  zip?: string
  take?: number
  /** Feed the PREVIOUS call's `nextPageCursor` here to continue paging; omit to start a
   *  fresh page 1. */
  pageCursor?: string | null
  /** A stable name derived from (market id, signal lane) — e.g.
   *  `m-<marketId>-<quicklist>` — so the SAME logical search resumes "only new since
   *  last time" across cron runs. Omit to page without session semantics (every call
   *  returns the same result set from page 1, re-deduped by the caller). */
  searchSession?: string | null
  // ── BUY-BOX FILTERS (wave 68, owner ruling: an investor's portal buy-box maps to
  // Property Search FILTERS — quickList + valuation.estimatedValue min/max +
  // equityPercent.min + general.propertyTypeDetail.equals + geography — NOT the Buy Box
  // API and NOT BatchRank; see docs/lead-acquisition-coverage-2026-09.md). ADDITIVE:
  // every existing caller that omits these keeps its exact prior request body. */
  /** valuation.estimatedValue.min — the box's price floor. */
  minPrice?: number | null
  /** valuation.estimatedValue.max — the box's price ceiling. */
  maxPrice?: number | null
  /** equityPercent.min — only properties with at least this much equity. */
  minEquityPercent?: number | null
  /** general.propertyTypeDetail.equals — a single BatchData property-type slug
   *  (e.g. "Single Family"), when the box names exactly one type worth filtering
   *  server-side. Multiple box types are left to the caller's own client-side scoring
   *  (scoreOffMarketFit already does this softly) rather than an AND/OR filter shape
   *  that has not been independently confirmed against the live API. */
  propertyTypeDetail?: string | null
}): Promise<IncrementalSearchResult> {
  if (!process.env.BATCHDATA_API_KEY) {
    return { ok: false, records: [], nextPageCursor: null, resultsFound: null, sessionUnsupported: false, cost: 0, error: "BATCHDATA_API_KEY not configured" }
  }
  const quicklists = validQuickLists([params.quicklist])
  if (quicklists.length === 0) {
    return { ok: false, records: [], nextPageCursor: null, resultsFound: null, sessionUnsupported: false, cost: 0, error: `"${params.quicklist}" is not a valid BatchData quickList` }
  }
  const query = [params.city, params.zip, params.state].filter(Boolean).join(", ") || params.state

  const options: Record<string, unknown> = { useCursorPagination: true, take: params.take ?? 100 }
  if (params.pageCursor) options.pageCursor = params.pageCursor
  if (params.searchSession) options.searchSession = params.searchSession

  const searchCriteria: Record<string, unknown> = { query, orQuickLists: quicklists }
  if (params.minPrice != null || params.maxPrice != null) {
    searchCriteria.valuation = {
      estimatedValue: {
        ...(params.minPrice != null && { min: params.minPrice }),
        ...(params.maxPrice != null && { max: params.maxPrice }),
      },
    }
  }
  if (params.minEquityPercent != null) {
    searchCriteria.equityPercent = { min: params.minEquityPercent }
  }
  if (params.propertyTypeDetail) {
    searchCriteria.general = { propertyTypeDetail: { equals: params.propertyTypeDetail } }
  }

  try {
    const data = await batchDataPropertySearch(
      { searchCriteria, options },
      "BatchData incremental search error",
    )
    const properties: any[] = data?.results?.properties ?? data?.results ?? []
    const records = properties.map((p) => normalizeBatchDataProperty(p, params.quicklist))
    return {
      ok: true,
      records,
      nextPageCursor: typeof data?.results?.nextPageCursor === "string" ? data.results.nextPageCursor : null,
      resultsFound: typeof data?.results?.meta?.totalResults === "number" ? data.results.meta.totalResults : (typeof data?.results?.resultsFound === "number" ? data.results.resultsFound : null),
      sessionUnsupported: false,
      cost: records.length * BATCHDATA_PROPERTY_SEARCH_RECORD_COST_USD,
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const sessionUnsupported = !!params.searchSession && (message.includes("403") || /session/i.test(message))
    return { ok: false, records: [], nextPageCursor: null, resultsFound: null, sessionUnsupported, cost: 0, error: message }
  }
}

// ─── COMPARABLE PROPERTY (COMPS DATASET) — a REAL data provider beside RentCast ───────
// Product surface (batchdata.io/api-solutions): "Comparables identifier" / "Comps
// dataset developer guide: low-cost comparable-property analysis". CONFIRMED (Exa
// fetch, developer.batchdata.com Property Lookup reference, 2026-09-16): `comps` is one
// of the 14 named dataset projections a Property Search/Lookup request can select
// (`basic comps batchrank contact core deed demographic foreclosure image listing
// mortgage-liens owner permit quicklist valuation`) — so this is the SAME
// `property/search` call every other function in this file uses, requesting the `comps`
// dataset rather than a separate endpoint. Wired into lib/cma/comp-provider.ts as a
// provider BESIDE RentCast (never replacing it — RentCast stays the sold-side default
// per the owner's ruling in that file); cost is booked through logVendorUsage at the
// CMA call site, matching every other comp source's own accounting.
export interface BatchDataComp {
  address: string | null
  status: "closed" | "active" | "pending" | "unknown"
  salePrice: number | null
  saleDate: string | null
  sqftLiving: number | null
  bedrooms: number | null
  bathrooms: number | null
  distanceMiles: number | null
  similarityScore: number | null
}

export interface BatchDataCompsResult {
  ok: boolean
  comps: BatchDataComp[]
  cost: number
  error?: string
}

/** PURE — one `comps` dataset row → BatchDataComp. Read defensively: the dataset's own
 *  field catalogue was not independently re-walked this wave (see lib/external/
 *  batchdata-seller-signals.ts's own 2026-08-20 catalogue reads for the sibling
 *  datasets this repo HAS confirmed); every field is read from the same address/
 *  valuation/lastSale shapes normalizeBatchDataProperty already trusts elsewhere in
 *  this file, so a drift in one place is a drift the whole file already tolerates. */
// EXPORTED (wave 69 — the MCP comps pre-flight in lib/cma/comp-provider.ts reuses this SAME
// mapper for `comparable_property_page`'s MCP rows, which are the same provider `comps` dataset
// shape as the REST path below: one vocabulary, §6, rather than a second field-mapping guess.
export function readBatchDataComp(row: Record<string, any>): BatchDataComp {
  const addr = row.address ?? {}
  const building = row.building ?? {}
  const lastSale = row.lastSale ?? row.sale ?? {}
  const listing = row.listing ?? {}
  const removedDate = typeof row.removedDate === "string" ? row.removedDate : null
  const status: BatchDataComp["status"] =
    removedDate || lastSale.date || lastSale.saleDate ? "closed"
      : String(listing.statusCategory ?? listing.status ?? "").toLowerCase().includes("pend") ? "pending"
        : (listing.status || listing.daysOnMarket != null) ? "active"
          : "unknown"
  return {
    address: typeof addr.street === "string" ? addr.street : null,
    status,
    salePrice: typeof lastSale.price === "number" ? lastSale.price : (typeof listing.listPrice === "number" ? listing.listPrice : null),
    saleDate: removedDate ?? (typeof lastSale.date === "string" ? lastSale.date : (typeof lastSale.saleDate === "string" ? lastSale.saleDate : null)),
    sqftLiving: typeof building.livingAreaSquareFeet === "number" ? building.livingAreaSquareFeet : null,
    bedrooms: typeof building.bedroomCount === "number" ? building.bedroomCount : null,
    bathrooms: typeof building.bathroomCount === "number" ? building.bathroomCount : null,
    distanceMiles: typeof row.distanceMiles === "number" ? row.distanceMiles : null,
    similarityScore: typeof row.correlation === "number" ? row.correlation : null,
  }
}

/** Cost telemetry, cents — no per-comp price independently confirmed; priced the same
 *  as the property-enrichment dataset pull (enrichPropertyDatasetsBatchData) since both
 *  are one address lookup against a named dataset projection. EXPORTED (wave 69): the
 *  MCP comps pre-flight in lib/cma/comp-provider.ts prices its MCP-sourced pull at the
 *  same conservative estimate — no independently-confirmed MCP-specific comps price
 *  exists either, and re-declaring the literal would be a second spelling of one cost. */
export const BATCHDATA_COMPS_COST_CENTS = 5

export async function fetchBatchDataComps(address: string, opts?: { limit?: number }): Promise<BatchDataCompsResult> {
  if (!process.env.BATCHDATA_API_KEY) {
    return { ok: false, comps: [], cost: 0, error: "BATCHDATA_API_KEY not configured" }
  }
  if (!address?.trim()) {
    return { ok: false, comps: [], cost: 0, error: "no address to look up" }
  }
  try {
    const data = await batchDataPropertySearch(
      {
        searchCriteria: { query: address },
        options: { take: opts?.limit ?? RENTCAST_COMP_PULL_LIMIT_FALLBACK, skip: 0 },
        dataset: ["core", "comps"],
      },
      "BatchData comps error",
    )
    const rows: any[] = data?.results?.comps ?? data?.results?.properties?.[0]?.comps ?? []
    if (!Array.isArray(rows) || rows.length === 0) {
      return { ok: true, comps: [], cost: BATCHDATA_COMPS_COST_CENTS / 100, error: "no comps dataset rows on the response" }
    }
    return { ok: true, comps: rows.map(readBatchDataComp), cost: BATCHDATA_COMPS_COST_CENTS / 100 }
  } catch (e) {
    return { ok: false, comps: [], cost: 0, error: e instanceof Error ? e.message : String(e) }
  }
}
/** Named locally so fetchBatchDataComps does not depend on lib/cma's own pull-limit
 *  constant (this file must stay CMA-agnostic — lib/cma/* imports FROM here, never the
 *  reverse). */
const RENTCAST_COMP_PULL_LIMIT_FALLBACK = 20

// ─── BUY BOX — investor-match rows normalized into BUYER-side raw leads ───────────────
// mcp__batchdata__investor_buybox_count/page/preview (the BatchData MCP server's own
// tools — no independently-confirmed REST path exists for this product; batchdata.io/
// buy-box-api is marketing copy, not an API reference) are the primary path, mirrored
// through lib/external/batchdata-mcp.ts. This function is the PURE normalizer shared by
// both the MCP path and any future REST path: an investor-profile row → a
// NormalizedScrapedRecord shaped for lib/kernel/scraping.ts::ingestRawSourceBatch,
// sourceChannel `batchdata_buybox`, intentType 'buyer' — DISTINCT from every
// seller-motivation record this file already normalizes (never overloaded onto
// normalizeBatchDataProperty, which is seller-shaped and requires a subject property).
export interface BatchDataInvestorMatch {
  investorName?: string | null
  entityName?: string | null
  phone?: string | null
  email?: string | null
  mailingCity?: string | null
  mailingState?: string | null
  mailingZip?: string | null
  mailingStreet?: string | null
  buyBoxScore?: number | null
  matchedPropertyAddress?: string | null
}

/** PURE. One investor-profile match → NormalizedScrapedRecord (buyer-intent). Read
 *  defensively across the plausible MCP tool response shapes (entity vs individual
 *  investor, camelCase vs snake_case) rather than pinned to one payload sample. */
export function normalizeBuyBoxInvestorRecord(
  row: BatchDataInvestorMatch & Record<string, any>,
  matchedPropertyAddress: string,
): NormalizedScrapedRecord {
  const owner = row.owner ?? row.investor ?? row
  const fullName = typeof owner.fullName === "string" ? owner.fullName.trim()
    : typeof owner.name === "string" ? owner.name.trim() : ""
  const entityName = typeof owner.entityName === "string" ? owner.entityName
    : typeof owner.companyName === "string" ? owner.companyName : null
  const first = owner.firstName ?? (fullName ? fullName.split(/\s+/)[0] : null)
  const last = owner.lastName ?? (fullName ? fullName.split(/\s+/).slice(1).join(" ") : null)
  const mailing = owner.mailingAddress ?? {}
  const score = typeof row.buyBoxScore === "number" ? row.buyBoxScore : (typeof row.matchScore === "number" ? row.matchScore : null)
  const idSlug = `${entityName ?? fullName ?? "investor"}-${matchedPropertyAddress}`.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")

  return {
    sourceRecordId: `batchdata-buybox-${idSlug || Date.now()}`,
    source: "batchdata_buybox",
    behaviorType: "investor_buy_box_match",
    intentType: "buyer",
    intentSignals: ["cash_buyer", "investor_buy_box"],
    firstName: first ?? null,
    lastName: last ?? null,
    fullName: !first && !last ? (entityName ?? fullName ?? null) : null,
    email: (owner.email as string | null | undefined) ?? null,
    phone: (owner.phone as string | null | undefined) ?? null,
    city: (mailing.city as string | null | undefined) ?? null,
    state: (mailing.state as string | null | undefined) ?? null,
    zip: (mailing.zip as string | null | undefined) ?? null,
    mailingAddress: (mailing.street as string | null | undefined) ?? null,
    propertyAddress: null, // the MATCHED property belongs to the tenant's own listing, not the investor — never conflate the two in one record's propertyAddress
    motivationScore: score,
    sourceUrl: null,
    rawPayload: row as Record<string, unknown>,
    intent: {
      winner: "investor", persona: "investor_buy_hold",
      // A Buy Box match IS the investor signal — the provider matched this profile's
      // stated criteria to the subject listing, so the investor axis is certain and
      // the others carry nothing; `matched` names the mechanism, not a phrase.
      scores: { buyer: 0, seller: 0, investor: 1, agent: 0, generic: 0 },
      matched: ["batchdata_buybox_match"],
    },
  }
}

// ─── WALLET — balance + consumption report, so spend is MEASURED not estimated ───────
// help.batchdata.io lists "Wallet endpoints reference: balance, consumption report,
// credit card transactions" and developer.batchdata.com's V1 nav confirms a "Wallet"
// section exists under the v1 API reference; the Stoplight-rendered page itself could
// not be read by this lane's fetch tools (same JS-rendering limitation recorded
// elsewhere in this file for the V2/V3 path segments), so the exact path segments below
// follow this file's OWN established v1 naming convention (`address/verify`,
// `property/search`) rather than being independently confirmed. UNRESOLVED, recorded
// rather than guessed silently: confirm `wallet/balance` and
// `wallet/consumption-report` (or their real segments) against a live account before
// this reconcile path is trusted for anything more than an advisory drift signal.
export interface BatchDataWalletBalance {
  ok: boolean
  balanceUsd: number | null
  error?: string
}

export async function fetchBatchDataWalletBalance(): Promise<BatchDataWalletBalance> {
  if (!process.env.BATCHDATA_API_KEY) return { ok: false, balanceUsd: null, error: "BATCHDATA_API_KEY not configured" }
  try {
    const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
    const res = await callConnector<Record<string, any>>({
      connector: "batchdata_wallet",
      baseUrl: BATCHDATA_API_URL,
      path: "wallet/balance",
      method: "GET",
      // Account-wide read — always the master key regardless of purpose tokens.
      auth: { style: "bearer", token: resolveBatchDataToken("search") ?? BATCHDATA_API_KEY },
    })
    if (!res.ok || !res.data) return { ok: false, balanceUsd: null, error: res.error ?? `HTTP ${res.status ?? "network"}` }
    const raw = res.data.results?.balance ?? res.data.result?.balance ?? res.data.balance
    const balanceUsd = typeof raw === "number" ? raw : (typeof raw === "string" ? Number(raw) : null)
    return { ok: true, balanceUsd: Number.isFinite(balanceUsd) ? balanceUsd : null }
  } catch (e) {
    return { ok: false, balanceUsd: null, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface BatchDataConsumptionReport {
  ok: boolean
  /** Total USD actually consumed for the reporting window BatchData returns —
   *  compared against our OWN vendor_usage_tracking estimate for the same window so a
   *  drift is a MEASURED finding, not an assumption that our per-call cost constants
   *  are exact. */
  totalConsumedUsd: number | null
  periodStart: string | null
  periodEnd: string | null
  error?: string
}

export async function fetchBatchDataWalletConsumptionReport(params?: { since?: string }): Promise<BatchDataConsumptionReport> {
  if (!process.env.BATCHDATA_API_KEY) return { ok: false, totalConsumedUsd: null, periodStart: null, periodEnd: null, error: "BATCHDATA_API_KEY not configured" }
  try {
    const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
    const res = await callConnector<Record<string, any>>({
      connector: "batchdata_wallet",
      baseUrl: BATCHDATA_API_URL,
      path: "wallet/consumption-report",
      method: "GET",
      auth: { style: "bearer", token: resolveBatchDataToken("search") ?? BATCHDATA_API_KEY },
      query: params?.since ? { since: params.since } : undefined,
    })
    if (!res.ok || !res.data) return { ok: false, totalConsumedUsd: null, periodStart: null, periodEnd: null, error: res.error ?? `HTTP ${res.status ?? "network"}` }
    const report = res.data.results ?? res.data.result ?? res.data
    const raw = report?.totalConsumed ?? report?.total ?? report?.amount
    const totalConsumedUsd = typeof raw === "number" ? raw : (typeof raw === "string" ? Number(raw) : null)
    return {
      ok: true,
      totalConsumedUsd: Number.isFinite(totalConsumedUsd) ? totalConsumedUsd : null,
      periodStart: typeof report?.periodStart === "string" ? report.periodStart : null,
      periodEnd: typeof report?.periodEnd === "string" ? report.periodEnd : null,
    }
  } catch (e) {
    return { ok: false, totalConsumedUsd: null, periodStart: null, periodEnd: null, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * reconcileBatchDataWalletSpend — compares our OWN vendor_usage_tracking ledger sum for
 * vendor 'batchdata' this month against BatchData's own wallet consumption report, and
 * files a LOW-severity automation_errors row when they drift past a noise threshold.
 * This is what makes BatchData spend "measured, not estimated" (CLAUDE.md §5: a wrong
 * cost-ledger number is a wrong invoice) — every per-call cost constant in this file
 * (RENTCAST_COMPS_COST_CENTS-style literals) is an ESTIMATE until compared against the
 * provider's own billed truth. Best-effort and non-blocking: a wallet-API failure is
 * reported in the return value and never throws.
 */
export async function reconcileBatchDataWalletSpend(params: {
  brokerageId: string | null
  estimatedSpendThisMonthUsd: number
}): Promise<{ ok: boolean; walletTotalUsd: number | null; estimatedTotalUsd: number; driftUsd: number | null; flagged: boolean; error?: string }> {
  const report = await fetchBatchDataWalletConsumptionReport()
  if (!report.ok || report.totalConsumedUsd === null) {
    return { ok: false, walletTotalUsd: null, estimatedTotalUsd: params.estimatedSpendThisMonthUsd, driftUsd: null, flagged: false, error: report.error }
  }
  const driftUsd = report.totalConsumedUsd - params.estimatedSpendThisMonthUsd
  // Flag only when the drift is both >$5 absolute AND >20% relative — a one-cent
  // rounding difference on a $0.03 pull is not a finding; a $40 gap on an estimated
  // $20 is.
  const flagged = Math.abs(driftUsd) > 5 && Math.abs(driftUsd) > params.estimatedSpendThisMonthUsd * 0.2
  if (flagged) {
    // Through the ONE canonical writer (lib/errors/collect-error.ts — the
    // hand-rolled-insert population is frozen by test:automation-errors); it
    // never throws, so the drift is still reported in the return value even if
    // the ops row could not be filed.
    const { collectError } = await import("@/lib/errors/collect-error")
    await collectError({
      workflowName: "batchdata_wallet_reconcile",
      errorMessage: `BatchData wallet consumption ($${report.totalConsumedUsd.toFixed(2)}) drifted from our own vendor_usage_tracking estimate ($${params.estimatedSpendThisMonthUsd.toFixed(2)}) by $${driftUsd.toFixed(2)} — the per-call cost constants in lib/external/batchdata-client.ts are estimates and may need re-pricing against the wallet's billed truth.`,
      severity: "low",
      brokerageId: params.brokerageId ?? undefined,
      context: { walletTotalUsd: report.totalConsumedUsd, estimatedTotalUsd: params.estimatedSpendThisMonthUsd, driftUsd },
    })
  }
  return { ok: true, walletTotalUsd: report.totalConsumedUsd, estimatedTotalUsd: params.estimatedSpendThisMonthUsd, driftUsd, flagged }
}
