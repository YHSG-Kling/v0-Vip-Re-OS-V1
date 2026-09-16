import type { NormalizedScrapedRecord } from "@/lib/lead-pipeline/raw-record-types"

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
    const [city, state] = location.includes(',')
      ? location.split(',').map(s => s.trim())
      : ['', location]
    // motivationTypes lets a caller target a SPECIFIC trigger as its own search (e.g. ['expired'] for
    // expired listings) — fetchMotivatedSellers labels every returned record with types[0], so each
    // trigger must be pulled trigger-by-trigger. Omitted → the default motivated-seller trio.
    return fetchMotivatedSellers({ state: state || location, city: city || undefined, motivationTypes }).then(r => r.records)
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
  // The full motivated-seller spectrum BatchData covers — downsizers (high
  // equity), divorce, foreclosure / pre-foreclosure, tax lien, expired listings,
  // investor/absentee owners, vacant, and tired landlords.
  motivationType: 'probate' | 'divorce' | 'foreclosure' | 'tax_lien' | 'pre_foreclosure' | 'distressed' | 'high_equity' | 'absentee' | 'expired' | 'vacant' | 'tired_landlord'
  motivationConfidence: number
}

/** Full motivated-seller trigger set requested by default. Only types that map to a REAL BatchData
 *  quickList are pullable here (divorce has no BatchData quickList — those leads come from other
 *  sources). A single Property Search caps quickLists at 3, so the cron pulls trigger-by-trigger. */
export const BATCHDATA_MOTIVATION_TYPES = [
  'probate', 'foreclosure', 'pre_foreclosure', 'tax_lien',
  'high_equity', 'absentee', 'expired', 'vacant', 'tired_landlord',
] as const

/** The default high-intent seller trio used when no explicit triggers are given (API caps at 3). */
const DEFAULT_MOTIVATION_TRIO = ['high_equity', 'pre_foreclosure', 'absentee'] as const

/** Config/DB aliases → our canonical BatchData motivation trigger. */
const TRIGGER_ALIASES: Record<string, string> = {
  preforeclosure: 'pre_foreclosure', 'pre-foreclosure': 'pre_foreclosure',
  'tax-lien': 'tax_lien', taxlien: 'tax_lien', 'tax-default': 'tax_lien', taxdefault: 'tax_lien',
  inherited: 'probate', 'notice-of-sale': 'foreclosure',
  'absentee-owner': 'absentee', 'expired-listing': 'expired', 'tired-landlord': 'tired_landlord',
  'high-equity': 'high_equity', highequity: 'high_equity',
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

/** Pure: a BatchData Property Search `results.properties[]` row → BatchDataRecord. */
export function normalizeBatchDataProperty(p: Record<string, any>, requestedType: string): BatchDataRecord {
  const addr      = p.address ?? {}
  const owner     = p.owner ?? {}
  const building  = p.building ?? {}
  const valuation = p.valuation ?? {}
  const mortgage  = p.mortgage  ?? p.openMortgageInfo  ?? {}
  const lastSale  = p.lastSale  ?? p.sale              ?? p.transferInfo ?? {}
  const vacancy   = p.vacancy   ?? {}
  const fullName  = typeof owner.fullName === 'string' ? owner.fullName.trim() : ''
  const ownerFirst = owner.firstName ?? (fullName ? fullName.split(/\s+/)[0] : '')
  const ownerLast  = owner.lastName  ?? (fullName ? fullName.split(/\s+/).slice(1).join(' ') : '')
  const quickListsRaw =
    Array.isArray(p.quickLists)      ? p.quickLists
    : Array.isArray(p.quick_lists)   ? p.quick_lists
    : Array.isArray(p.tags)          ? p.tags
    : []
  const quickLists = quickListsRaw.filter((x: any) => typeof x === 'string')

  // Compact helper: drop undefined keys so sub-objects stay compact in the raw_data JSONB.
  const compact = <T extends Record<string, unknown>>(o: T): T | undefined => {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(o)) if (o[k] !== undefined && o[k] !== null) out[k] = o[k]
    return Object.keys(out).length ? (out as T) : undefined
  }

  return {
    firstName: ownerFirst || '',
    lastName:  ownerLast  || '',
    phone:     owner.phone ?? null,
    email:     owner.email ?? null,
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
    motivationType: (requestedType as BatchDataRecord['motivationType']) ?? 'distressed',
    motivationConfidence: 0.7,
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
    auth: { style: "bearer", token: BATCHDATA_API_KEY },
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
    cost: records.length * 0.05,
  }
}

export async function searchProperties(address: string): Promise<{
  matches: any[]
  cost: number
}> {
  // BatchData v1 Property Search by free-text address (POST /api/v1/property/search).
  const data = await batchDataPropertySearch(
    { searchCriteria: { query: address }, options: { take: 5, skip: 0 } },
    "BatchData property search error",
  )

  return {
    matches: data?.results?.properties ?? data?.results ?? [],
    cost: 0.02,
  }
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
  const ql = prop.quickLists ?? {}
  // Distress/vacancy signals imply a likely fixer; otherwise unknown.
  const condition: 'turnkey' | 'fixer' | 'unknown' =
    ql.vacant || ql.foreclosure || ql.preforeclosure || ql['tax-default'] ? 'fixer' : 'unknown'

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

/**
 * createSmartSearchSubscription — register ONE V2 Property Subscription for ONE
 * BatchData quickList against ONE territory's geography, delivered to this repo's
 * webhook receiver. Bounded spend by construction: called only from the reconcile
 * plan below (buildSmartSearchSubscriptionPlan), never per-record, and only after the
 * caller has confirmed the account-wide 5-subscription cap is not exceeded.
 *
 * SUBSCRIPTIONS ARE IMMUTABLE (documented). A criteria change is a DELETE of the old
 * subscription id followed by a fresh CREATE — never a renew-in-place. There is
 * therefore no `createOrRenew` any more; the reconcile step deletes first when it
 * needs to change criteria, then calls this.
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
 * FAIL-CLOSED: no BATCHDATA_API_KEY, no webhook URL configured, or a network/HTTP
 * error all return { ok: false }, never a fabricated subscription id.
 */
export async function createSmartSearchSubscription(params: {
  /** A single BatchData quickList slug, validated against BATCHDATA_QUICKLISTS. */
  quicklist: string
  city?: string
  state: string
  zip?: string
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
  const query = [params.city, params.zip, params.state].filter(Boolean).join(", ") || params.state

  try {
    const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
    const res = await callConnector<Record<string, any>>({
      connector: "batchdata_smart_search",
      baseUrl: BATCHDATA_API_V2_URL,
      path: SMART_SEARCH_PATH,
      method: "POST",
      auth: { style: "bearer", token: BATCHDATA_API_KEY },
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
      auth: { style: "bearer", token: BATCHDATA_API_KEY },
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
      auth: { style: "bearer", token: BATCHDATA_API_KEY },
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

// ─── SUBSCRIPTION PLAN — the 5-per-account cap forces prioritization ──────────────────
export interface SmartSearchWant {
  marketId: string
  /** Higher = more important. Mirrors lead_scraping_markets.priority so a territory the
   *  tenant already ranked highly is not starved by one that happens to sort first. */
  priority: number
  quicklist: string
  city?: string | null
  state: string
  zip?: string | null
}

export interface SmartSearchPlanEntry extends SmartSearchWant {
  action: "keep" | "create" | "defer"
  reason: string
}

/**
 * PURE — turns every (market × quicklist) the tenant base WANTS a live subscription for
 * into an admit/defer plan against the account-wide 5-subscription cap.
 *
 * "Combine territories into one query where BatchData accepts multi-location" — NOT
 * done here. BatchData's own example (`searchCriteria.query: "Phoenix, AZ"`) and every
 * confirmed usage in this repo's own V1 pulls is a SINGLE city/state string; nothing in
 * the fetched documentation states a multi-location query syntax, and inventing one
 * (e.g. joining with ";" or "|") risks silently narrowing a subscription to zero
 * results rather than widening it — a false economy against a hard cap this quiet.
 * So the fallback the task names explicitly is the one implemented: RANK by priority
 * (already-active subscriptions keep their slot ahead of a new want, so a live
 * subscription is never torn down just because a higher-priority territory showed up
 * later in the list — churn costs a delete+recreate and a window with no coverage)
 * and DEFER whatever does not fit, with the reason recorded for the status column.
 */
export function buildSmartSearchSubscriptionPlan(params: {
  wants: readonly SmartSearchWant[]
  /** (market_id, quicklist) pairs already ACTIVE (subscriptionId set, status active) —
   *  kept ahead of new wants so reconciling does not thrash a working subscription. */
  alreadyActive: ReadonlySet<string>
  /** Total subscriptions BatchData reports across the WHOLE account right now
   *  (listSmartSearchSubscriptions), including any this repo did not register itself. */
  accountLiveCount: number
  cap?: number
}): SmartSearchPlanEntry[] {
  const cap = params.cap ?? BATCHDATA_SMART_SEARCH_SUBSCRIPTION_ACCOUNT_CAP
  const key = (w: Pick<SmartSearchWant, "marketId" | "quicklist">) => `${w.marketId}:${w.quicklist}`

  const kept = params.wants.filter((w) => params.alreadyActive.has(key(w)))
  const candidates = params.wants
    .filter((w) => !params.alreadyActive.has(key(w)))
    // Highest priority first; stable tie-break on (marketId, quicklist) so the plan is
    // deterministic for the same input rather than depending on array order.
    .sort((a, b) => b.priority - a.priority || key(a).localeCompare(key(b)))

  // Slots already spoken for by rows this repo did NOT just decide to keep (an
  // out-of-band subscription BatchData's account shows that our own plan does not
  // recognise) still count against the cap — we cannot create past what the account
  // actually holds regardless of whose row it is.
  const externalLiveCount = Math.max(0, params.accountLiveCount - kept.length)
  let remaining = Math.max(0, cap - kept.length - externalLiveCount)

  const plan: SmartSearchPlanEntry[] = kept.map((w) => ({ ...w, action: "keep", reason: "already active" }))
  for (const w of candidates) {
    if (remaining > 0) {
      plan.push({ ...w, action: "create", reason: `admitted (priority ${w.priority})` })
      remaining--
    } else {
      plan.push({
        ...w,
        action: "defer",
        reason: `account cap (${cap}) reached — ${kept.length + (candidates.length - candidates.filter((c) => c === w).length)} higher-priority subscription(s) already hold the remaining slots`,
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
        auth: { style: "bearer", token: BATCHDATA_API_KEY },
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
      cost += chunk.length * 0.15 // V3 skip trace is a per-match-attempt charge; matched or not, the lookup is billed
    } catch {
      allMatches.push(...chunk.map((p) => ({ ref: p.ref, matched: false, phones: [], emails: [] })))
    }
  }
  return { matches: allMatches, cost }
}

// ─── ADDRESS VERIFY — fallback ONLY when Lob is unconfigured ──────────────────────────
// Lob stays the survivor for mailing-address verification (lib/external/lob-address-
// verify.ts, wired through lib/lead-pipeline/promotion-address-verification.ts — CLAUDE.md
// §1: merge onto the named survivor, never build a second primary). This exists so the
// SAME capability keeps working when LOB_API_KEY is absent but BATCHDATA_API_KEY is
// present, rather than the promotion gate silently never verifying an address at all.
// CONFIRMED (batchdata.io/llms.txt): "Address APIs include Verify, Geocode, Reverse
// Geocode, and Autocomplete... Address APIs are synchronous-only." Request shape per the
// community `@land-catalyst/batch-data-sdk` README: `{ requests: [{ street, city, state,
// zip }] }`. UNRESOLVED: exact V1 path segment ("address/verify" used here, matching the
// address/geocode and address/autocomplete siblings' naming) not independently confirmed.
export interface BatchDataAddressVerifyResult {
  ok: boolean
  verified: boolean
  standardized: { street?: string; city?: string; state?: string; zip?: string } | null
  cost: number
  error?: string
}

export async function verifyAddressBatchData(address: {
  street: string
  city?: string
  state?: string
  zip?: string
}): Promise<BatchDataAddressVerifyResult> {
  if (!process.env.BATCHDATA_API_KEY) {
    return { ok: false, verified: false, standardized: null, cost: 0, error: "BATCHDATA_API_KEY not configured" }
  }
  if (!address.street?.trim()) {
    return { ok: false, verified: false, standardized: null, cost: 0, error: "no street address to verify" }
  }
  try {
    const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
    const res = await callConnector<Record<string, any>>({
      connector: "batchdata_address_verify",
      baseUrl: BATCHDATA_API_URL,
      path: "address/verify",
      method: "POST",
      auth: { style: "bearer", token: BATCHDATA_API_KEY },
      body: { requests: [{ street: address.street, city: address.city, state: address.state, zip: address.zip }] },
    })
    if (!res.ok || !res.data) {
      return { ok: false, verified: false, standardized: null, cost: 0, error: res.error ?? `HTTP ${res.status ?? "network"}` }
    }
    const row = (res.data.results ?? res.data.results?.addresses ?? [res.data])[0] ?? {}
    const verified = row.deliverable === true || row.verified === true || row.status === "verified"
    const std = row.standardized ?? row.address ?? null
    return {
      ok: true,
      verified,
      standardized: std ? { street: std.street ?? std.primary_line, city: std.city, state: std.state, zip: std.zip ?? std.zip_code } : null,
      cost: 0.02,
    }
  } catch (e) {
    return { ok: false, verified: false, standardized: null, cost: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

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
        dataset: ["core", "valuation", "mortgage-liens", "foreclosure", "deed", "owner"],
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
        auth: { style: "bearer", token: BATCHDATA_API_KEY },
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

  try {
    const data = await batchDataPropertySearch(
      { searchCriteria: { query, orQuickLists: quicklists }, options },
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
      cost: records.length * 0.05,
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
function readBatchDataComp(row: Record<string, any>): BatchDataComp {
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
 *  are one address lookup against a named dataset projection. */
const BATCHDATA_COMPS_COST_CENTS = 5

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
      auth: { style: "bearer", token: BATCHDATA_API_KEY },
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
      auth: { style: "bearer", token: BATCHDATA_API_KEY },
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
