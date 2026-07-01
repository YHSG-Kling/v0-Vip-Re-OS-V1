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
