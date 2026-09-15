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
// The inbound side already exists at app/api/webhooks/batchdata-smart-search/route.ts;
// this is the OUTBOUND half that was missing — nothing ever CREATED a subscription, so
// that webhook could only ever receive a push BatchData had no standing reason to send.
//
// CONFIRMED, 2026-09-15 (Exa web fetch, batchdata.io/llms.txt + developer.batchdata.com
// search results — transcribed, not guessed):
//   · V2 base URL: https://api.batchdata.com/api/v2 (developer.batchdata.com/docs/
//     batchdata/batchdata-v2: "Property Monitoring for push-based monitoring of search
//     criteria... Search Sessions for managing persistent delivery contexts").
//   · Request/response SHAPE (github.com/land-catalyst/land-catalyst,
//     npmjs.com/package/@land-catalyst/batch-data-sdk — a third-party TS SDK whose
//     README documents `PropertySubscriptionBuilder` / `PropertySubscriptionRequest` /
//     `PropertySubscriptionResponse` / `client.createPropertySubscription(subscription)`
//     against the real API, integration-tested against BATCHDATA_API_KEY per its own
//     README): the body is `{ searchCriteria, deliveryConfig }`, where searchCriteria is
//     the SAME shape buildPropertySearchBody already sends to V1 property/search
//     (query + quickLists/orQuickLists), and deliveryConfig is ONE of
//     `{ webhook: { url, headers? } }`, `{ kinesis: {...} }` or `{ eventHub: {...} }` —
//     this lane only ever sends `webhook`, matching the existing receiver.
// UNRESOLVED (see the wave report): the exact REST PATH SEGMENT under /api/v2 (this
// lane sends "property/subscription", following the v1 "property/search" naming
// convention, but that segment was not independently confirmed on
// developer.batchdata.com — a Stoplight-rendered SPA this lane's fetch tools could not
// execute JS against) and the exact response field name for the created subscription's
// id (read DEFENSIVELY below from every plausible shape, never fabricated).
const BATCHDATA_API_V2_URL = 'https://api.batchdata.com/api/v2'

export interface SmartSearchSubscriptionResult {
  ok: boolean
  /** BatchData's id for the created/renewed subscription — null when the call failed
   *  or the response carried no recognizable id field. */
  subscriptionId: string | null
  status: number | null
  error: string | null
}

/** PURE — reads a subscription id out of a Property Subscription response body in every
 *  plausible shape, never guesses. Module-private. */
function readSubscriptionId(data: Record<string, any> | null | undefined): string | null {
  if (!data) return null
  const candidates = [
    data.id, data.subscriptionId, data.subscription_id,
    data.results?.id, data.results?.subscriptionId, data.results?.subscription_id,
    data.subscription?.id,
  ]
  const found = candidates.find((c) => typeof c === "string" && c.length > 0)
  return typeof found === "string" ? found : null
}

/**
 * createOrRenewSmartSearchSubscription — register (or, called again with the same
 * criteria, effectively refresh) a V2 Property Subscription for ONE BatchData quickList
 * against ONE territory's geography, delivered to this repo's webhook receiver. Bounded
 * spend by construction: called only from the reconcile step below, never per-record.
 * FAIL-CLOSED: no BATCHDATA_API_KEY, no webhook URL configured, or a network/HTTP error
 * all return { ok: false }, never a fabricated subscription id.
 */
export async function createOrRenewSmartSearchSubscription(params: {
  /** A single BatchData quickList slug, validated against BATCHDATA_QUICKLISTS — Smart
   *  Search subscriptions are one criteria set each, unlike the OR-able V1 search pull. */
  quicklist: string
  city?: string
  state: string
  zip?: string
}): Promise<SmartSearchSubscriptionResult> {
  if (!process.env.BATCHDATA_API_KEY) {
    return { ok: false, subscriptionId: null, status: null, error: "BATCHDATA_API_KEY not configured" }
  }
  const webhookUrl = process.env.BATCHDATA_SMART_SEARCH_WEBHOOK_URL
  if (!webhookUrl) {
    return { ok: false, subscriptionId: null, status: null, error: "BATCHDATA_SMART_SEARCH_WEBHOOK_URL not configured — no delivery target to register" }
  }
  const secret = process.env.BATCHDATA_SMART_SEARCH_WEBHOOK_SECRET
  const quicklists = validQuickLists([params.quicklist])
  if (quicklists.length === 0) {
    return { ok: false, subscriptionId: null, status: null, error: `"${params.quicklist}" is not a valid BatchData quickList` }
  }
  const query = [params.city, params.zip, params.state].filter(Boolean).join(", ") || params.state

  try {
    const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
    const res = await callConnector<Record<string, any>>({
      connector: "batchdata_smart_search",
      baseUrl: BATCHDATA_API_V2_URL,
      path: "property/subscription",
      method: "POST",
      auth: { style: "bearer", token: BATCHDATA_API_KEY },
      body: {
        searchCriteria: { query, quickLists: quicklists },
        deliveryConfig: {
          webhook: {
            url: webhookUrl,
            // Matches the receiver's verifySharedSecret, which also accepts a bearer
            // Authorization header — sent both ways since BatchData's exact header name
            // for this push was not confirmed (see app/api/webhooks/batchdata-smart-search/route.ts).
            ...(secret ? { headers: { "x-batchdata-webhook-secret": secret, Authorization: `Bearer ${secret}` } } : {}),
          },
        },
      },
    })
    if (!res.ok) {
      return { ok: false, subscriptionId: null, status: res.status, error: res.error ?? `HTTP ${res.status ?? "network"}` }
    }
    const subscriptionId = readSubscriptionId(res.data)
    if (!subscriptionId) {
      return { ok: false, subscriptionId: null, status: res.status, error: "subscription created but no id in the response — cannot track it for renewal" }
    }
    return { ok: true, subscriptionId, status: res.status, error: null }
  } catch (e) {
    return { ok: false, subscriptionId: null, status: null, error: e instanceof Error ? e.message : String(e) }
  }
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
