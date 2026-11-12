// lib/market-reports/contract.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE MARKET REPORT CONTRACT (wave 147, lane 147E — owner ruling 6, 2026-10-31: "Build the market report producer").
//
// A market report is TENANT-BRANDED and TERRITORY-SPECIFIC, built from verified current property / MLS / RentCast data,
// comparable sales and trends, EVERY DATUM DATED AND SOURCED; unavailable data is labelled honestly ("not available for
// <territory> as of <date>"); generic text is not a market report (lib/market-reports/validator.ts refuses it).
//
// PURE — no I/O, importable by the proofs. One vocabulary for the producer, the validator, the renderer and the deliverable.
//
// PROVENANCE FACTS THIS CONTRACT ENCODES (verified, not assumed):
//   · RentCast /markets is "aggregate market statistics and LISTING trends for a single US zip code" (RentCast API docs,
//     read through the rentcast MCP get-endpoint 2026-10-31). Its medianPrice is a median ASKING price of listings, not a
//     recorded sale price — lib/property/rentcast-normalize.ts stores it as `median_sale_price`; this contract labels it
//     `median_asking_price` so no reader is told a listing statistic is a closed-sale statistic.
//   · A RentCast comparable's price is the price on its LISTING RECORD (lib/property/rentcast-normalize.ts RentcastComp.sale_price
//     — "not a figure read off a recorded deed") → ComparableSale.priceBasis "last_list_price".
//   · A tenant listing with status 'sold' + sold_price + sold_date is an MLS-synced closed sale → priceBasis "recorded_sale".

// ── RENTCAST DATA TYPES — ONE LABEL PER ENDPOINT (wave 151, lane 151G) ───────────────────────────────────────────
//
// Owner (2026-11-09): "sold properties can also come from another source but RentCast has sold properties because market
// data is a capability of RentCast if the tenant doesn't have a connected IDX provider." Directive 151G: `/v1/properties`
// carries sale HISTORY (`lastSaleDate` / `lastSalePrice` / `history[*].event "Sale"`) and a `saleDateRange` filter —
// sold RECORDS / comps; `/v1/markets` is ZIP-level sale + rental LISTING statistics (asking prices, counts, days on
// market) — NOT a closed-sale index; `/v1/listings/sale` is LISTING records that need provider rights and freshness and
// carry NO photo — a listing fact field grants no photo right. These are kept DISTINCT here, read by every RentCast
// reader on the market-report, comps and buyer-search paths, and the platform scorecard (lib/providers/provider-scorecard.ts)
// re-exports them so the gap matrix and docs/operations/PROVIDER-SELECTION-WAVE151.md derive from ONE table.
// Lives in this PURE contract (no imports, already on every page graph — test:proxy-graph-budget) rather than in a new
// module. Sources: lib/external/_generated/rentcast-openapi.ts (the vendor spec; `/markets` "aggregate market statistics
// and listing trends for a single US zip code"; `saleDateRange` "the number of days since a property was last sold").

/** What a RentCast endpoint's rows ARE. One spelling per idea (CLAUDE.md §6). */
export type RentcastDataKind = "property_record" | "sold_records" | "listing_statistics" | "listing_records" | "avm_estimate" | "listing_comparables"

export interface RentcastDataType {
  /** The vendor endpoint, host-less (evidence, never a URL this module calls). */
  endpoint: string
  kind: RentcastDataKind
  /** The label a reader must print beside a figure from this source. */
  label: string
  /** True only where a figure is a RECORDED sale (a deed-side event), never a listing price or a listing statistic. */
  closedSaleEvidence: boolean
  /** RentCast grants no photo right on any endpoint; a listing fact field grants no photo right either. */
  photoRights: false
  /** What a reader owes before showing a row to a person: provider rights for the surface, and freshness for a listing. */
  requires: readonly ("provider_rights" | "freshness" | "staff_audience")[]
  /** The repo readers that consume this type (repo-relative; "none" = no reader built yet, said so). */
  readers: readonly string[]
  source: string
}

export const RENTCAST_DATA_TYPES = Object.freeze({
  property_record: {
    endpoint: "GET /v1/properties?address=",
    kind: "property_record",
    label: "RentCast property record (facts, owner, taxes; sale history = recorded sales)",
    closedSaleEvidence: true,
    photoRights: false,
    requires: ["provider_rights", "staff_audience"],
    readers: ["lib/property/rentcast.ts getRentcastPropertyDetail / getRentcastPropertyRecord", "lib/avm/provider-chain.ts getPropertyRecordWithFallback (the property-lookup capability)", "lib/market-reports/research.ts (street comparables — the sale-history side, through the capability, RentCast's record only)"],
    source: "rentcast-openapi.ts property-records: lastSaleDate, lastSalePrice, history[date].event 'Sale' + price; the owner block is STAFF-only (public whitelist never reads it)",
  },
  sold_records: {
    endpoint: "GET /v1/properties?zipCode=|city=&state=&saleDateRange=",
    kind: "sold_records",
    label: "RentCast sold records (properties last sold within the date range — recorded sales)",
    closedSaleEvidence: true,
    photoRights: false,
    requires: ["provider_rights"],
    readers: ["lib/property/rentcast.ts getRentcastSoldRecords (the vendor leg: gated property_data, metered sold_records, cached a week)", "lib/avm/provider-chain.ts getAreaSoldRecords (the capability beside the property lookup: an IDX tenant is answered from its feed, nothing spent)", "lib/market-reports/research.ts soldRecordsToData (the median + comparables when the tenant's MLS-synced closed sales are fewer than MIN_RECORDS_FOR_MEDIAN)"],
    source: "rentcast-openapi.ts property-records query `saleDateRange` — 'the number of days since a property was last sold … used to search for properties that were sold within the specified date range'",
  },
  listing_statistics: {
    endpoint: "GET /v1/markets?zipCode=&dataType=All",
    kind: "listing_statistics",
    label: "RentCast ZIP LISTING statistics (asking prices, listing counts, days on market — LISTINGS, not closed sales)",
    closedSaleEvidence: false,
    photoRights: false,
    requires: ["provider_rights"],
    readers: ["lib/property/rentcast.ts getRentcastMarketStats", "lib/market-reports/market-twin.ts loadMarketTwin", "lib/market-reports/research.ts marketRowToData / readTrend", "lib/intelligence/market-insight-generator.ts refreshMarketData (writes market_data.median_sale_price — the column name is historical; every reader re-labels it asking)"],
    source: "rentcast-openapi.ts /markets: 'aggregate market statistics and listing trends for a single US zip code' — saleData (sale LISTINGS) + rentalData (rental LISTINGS)",
  },
  listing_records: {
    endpoint: "GET /v1/listings/sale · GET /v1/listings/rental/long-term",
    kind: "listing_records",
    label: "RentCast listing record (facts via RentCast; status as the source reports it; MLS name shown as the source; no photo)",
    closedSaleEvidence: false,
    photoRights: false,
    requires: ["provider_rights", "freshness"],
    readers: ["lib/property/rentcast.ts searchRentcastSaleListings / searchRentcastRentalListings / getRentcastListingStatus", "lib/property/external-listings-search.ts searchExternalListings", "lib/buyer-search/search-engine.ts (external rows)", "lib/buyer-search/external-match.ts runExternalMarketWatchForBuyer", "lib/portal/saved-homes.ts (origin rentcast_listing)"],
    source: "rentcast-openapi.ts sale-listings: status, listedDate, removedDate, lastSeenDate, mlsName, mlsNumber — no photo field in the schema",
  },
  avm_estimate: {
    endpoint: "GET /v1/avm/value",
    kind: "avm_estimate",
    label: "RentCast automated value estimate (a model's estimate with its range — not an appraisal, not a sale)",
    closedSaleEvidence: false,
    photoRights: false,
    requires: ["provider_rights", "staff_audience"],
    readers: ["lib/property/rentcast.ts getRentcastAVM / getRentcastAvmAndComps", "lib/avm/provider-chain.ts requestPropertyValuation", "lib/cma/comp-provider.ts buildAvmBaseline"],
    source: "rentcast-openapi.ts /avm/value: price, priceRangeLow, priceRangeHigh",
  },
  listing_comparables: {
    endpoint: "GET /v1/avm/value → comparables[]",
    kind: "listing_comparables",
    label: "RentCast comparable LISTING (price = the comparable's listing-record price; removedDate = left the market, not a recorded deed)",
    closedSaleEvidence: false,
    photoRights: false,
    requires: ["provider_rights", "staff_audience"],
    readers: ["lib/property/rentcast-normalize.ts normalizeRentcastComps", "lib/cma/comp-provider.ts toScoredCompFromRentcast", "lib/market-reports/research.ts (street comparables — basis derived here)"],
    source: "rentcast-openapi.ts /avm/value comparables[]: price, listingType, listedDate, removedDate, lastSeenDate, daysOnMarket, distance, correlation — a listing record, no sale event",
  },
} satisfies Record<RentcastDataKind, RentcastDataType>)

/**
 * PURE — the ComparableSale price basis a RentCast figure may carry: a RECORDED sale only from a data type that is
 * closed-sale evidence; everything else is the last listing price. A reader that labels `/markets` or an `/avm/value`
 * comparable as a sale cannot pass through here (scripts/provider-gap-matrix-guard.ts B).
 */
export function rentcastPriceBasis(kind: RentcastDataKind): ComparableSale["priceBasis"] {
  return RENTCAST_DATA_TYPES[kind].closedSaleEvidence ? "recorded_sale" : "last_list_price"
}

/** The territory grain a report is written at (creative latitude: the smallest grain the data can honestly support). */
export const TERRITORY_GRAINS = ["street", "zip", "city"] as const
export type TerritoryGrain = (typeof TERRITORY_GRAINS)[number]

export interface MarketReportTerritory {
  grain: TerritoryGrain
  /** What the reader sees ("78704", "Austin, TX", "around 1200 Elm St"). Must be named in the report (validator V4). */
  label: string
  zip?: string | null
  city?: string | null
  state?: string | null
  /** Street grain only: the address the comparables are measured from. */
  address?: string | null
  radiusMiles?: number | null
}

/** Report formats a neighbour would actually forward (creative latitude). */
const MARKET_REPORT_FORMATS = ["territory_snapshot", "what_sold_near_you", "equity_this_quarter", "inventory_watch"] as const
export type MarketReportFormat = (typeof MARKET_REPORT_FORMATS)[number]

/** The datum vocabulary (one spelling per fact — CLAUDE.md §6). */
export const MARKET_DATUM_KEYS = [
  "median_asking_price",     // RentCast /markets saleData medianPrice — listings, not sales
  "active_listings",         // RentCast totalListings, or the tenant's own active listings in the territory
  "new_listings_30d",        // RentCast newListings
  "avg_days_on_market",      // RentCast averageDaysOnMarket (listings)
  "asking_price_yoy_pct",    // RentCast history: newest vs 12 months earlier (listing medians)
  "median_sold_price",       // tenant MLS-synced closed sales in the window
  "closed_sales_count",      // tenant MLS-synced closed sales in the window
  "median_days_to_sell",     // listing_date → sold_date on those closed sales
  "sale_to_list_ratio_pct",  // sold_price / list_price on those closed sales
  // NOT a key: the brokerage's own ACTIVE listings — they are its inventory, not the territory's, and would read as market data.
] as const
type MarketDatumKey = (typeof MARKET_DATUM_KEYS)[number]

type MarketDatumUnit = "usd" | "count" | "days" | "pct"

export interface MarketSource {
  /** Who observed it. */
  provider: "rentcast" | "tenant_mls" | "osint_scrape" | "batchdata" | "mls_feed" | "idx_broker" | "manual_import"
  /** The table / endpoint it was read from (market_data, listings, /avm/value comparables). */
  dataset: string
  /** A row id / zip / document the reader can trace. */
  ref?: string | null
}

export interface MarketDatum {
  key: MarketDatumKey
  label: string
  value: number
  unit: MarketDatumUnit
  /** YYYY-MM-DD — the date the observation describes (or was retrieved, when the provider publishes no date; `caveat` says so). */
  asOf: string
  source: MarketSource
  basis: "provider_reported" | "computed_from_records"
  /** Records behind a computed figure (closed sales counted, listings counted). */
  sampleSize?: number | null
  caveat?: string | null
}

export interface UnavailableDatum {
  key: MarketDatumKey | "comparable_sales" | "monthly_trend"
  label: string
  /** EXACTLY unavailableLabel(territory.label, asOf) — validator V8. */
  text: string
  reason: string
}

export interface ComparableSale {
  address: string
  price: number
  priceBasis: "recorded_sale" | "last_list_price"
  /** YYYY-MM-DD the sale closed / the listing left the market. */
  date: string
  source: MarketSource
  beds?: number | null
  baths?: number | null
  sqft?: number | null
  distanceMiles?: number | null
}

export interface TrendPoint {
  month: string // YYYY-MM
  /** The month's median ASKING price of homes listed for sale (RentCast /markets) — never a sold median (canary 17). */
  medianPrice: number | null
  activeInventory: number | null
  /** What medianPrice measures — always listing asking prices; a month without a recorded listing reading is not printed. */
  priceBasis: "listing_asking"
  source: MarketSource
}

export interface MarketReportTopic {
  title: string
  angle: string | null
  /** Evidence ids from lib/market-reports/topics.ts — never an invented one. */
  evidenceIds: string[]
}

export interface NarrativeSection {
  heading: string
  body: string
  /** The datum keys this section's body is built from (validator V3 — a section with no data is generic). */
  datumKeys: MarketDatumKey[]
}

export interface MarketReportNarrative {
  headline: string
  sections: NarrativeSection[]
  buyerTakeaways: string[]
  sellerTakeaways: string[]
  callToAction: string
  /** "ai" when the routed writer composed it, "data_template" when the deterministic composer did (AI unavailable). */
  authoredBy: "ai" | "data_template"
}

export interface MarketReport {
  version: 1
  brokerageId: string
  topic: MarketReportTopic
  format: MarketReportFormat
  territory: MarketReportTerritory
  /** YYYY-MM-DD — the date the report was produced (the "as of" of every unavailable label). */
  asOf: string
  data: MarketDatum[]
  unavailable: UnavailableDatum[]
  comparables: ComparableSale[]
  trend: TrendPoint[]
  narrative: MarketReportNarrative
}

export interface MarketReportValidation {
  ok: boolean
  refusals: string[]
  warnings: string[]
  /** Counts behind the verdict (published beside it — §2 "publish blind spots beside the number"). */
  counts: { data: number; datedSourced: number; unavailable: number; comparables: number; sections: number; numbersChecked: number }
}

// ── PURE HELPERS ─────────────────────────────────────────────────────────────

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

export function isIsoDay(v: unknown): v is string {
  return typeof v === "string" && DAY_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
}

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** THE honest unavailable label (ruling 6). One spelling — the validator compares against it byte for byte. */
export function unavailableLabel(territoryLabel: string, asOf: string): string {
  return `not available for ${territoryLabel} as of ${asOf}`
}

export function unavailable(key: UnavailableDatum["key"], label: string, territory: MarketReportTerritory, asOf: string, reason: string): UnavailableDatum {
  return { key, label, text: unavailableLabel(territory.label, asOf), reason }
}

/** How a datum is SHOWN — the composer substitutes this exact string, the validator matches against it. */
export function formatDatumValue(d: Pick<MarketDatum, "value" | "unit">): string {
  switch (d.unit) {
    case "usd": return `$${Math.round(d.value).toLocaleString("en-US")}`
    case "count": return Math.round(d.value).toLocaleString("en-US")
    case "days": return `${Math.round(d.value)} days`
    case "pct": return `${d.value > 0 ? "+" : ""}${(Math.round(d.value * 10) / 10).toFixed(1)}%`
  }
}

/** "RentCast market statistics (market_data), as of 2026-10-15" — the line the sources table prints per datum. */
export function sourceLine(d: Pick<MarketDatum, "source" | "asOf">): string {
  const who = d.source.provider === "tenant_mls" ? "MLS records synced to this brokerage" : d.source.provider === "rentcast" ? "RentCast" : d.source.provider
  return `${who} (${d.source.dataset}), as of ${d.asOf}`
}

/** A stable key for a territory (idempotency, the deliverable payload). */
export function territoryKey(t: MarketReportTerritory): string {
  return [t.grain, (t.zip ?? "").trim(), (t.city ?? "").trim().toLowerCase(), (t.state ?? "").trim().toUpperCase(), (t.address ?? "").trim().toLowerCase()].join("|")
}

/** Substitute `{{datum_key}}` tokens with the formatted datum; an unknown / unavailable token becomes its honest label. */
export function renderDatumTokens(text: string, report: Pick<MarketReport, "data" | "territory" | "asOf">): { text: string; used: MarketDatumKey[]; unknownTokens: string[] } {
  const used: MarketDatumKey[] = []
  const unknownTokens: string[] = []
  const out = String(text ?? "").replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/g, (_m, key: string) => {
    const d = report.data.find((x) => x.key === key)
    if (d) { used.push(d.key); return formatDatumValue(d) }
    unknownTokens.push(key)
    return unavailableLabel(report.territory.label, report.asOf)
  })
  return { text: out, used: [...new Set(used)], unknownTokens }
}
