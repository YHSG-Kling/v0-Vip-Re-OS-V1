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
  medianPrice: number | null
  activeInventory: number | null
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
