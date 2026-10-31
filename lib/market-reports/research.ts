// lib/market-reports/research.ts
// ─────────────────────────────────────────────────────────────────────────────
// TERRITORY + RESEARCH for the market-report producer (wave 147, lane 147E — owner ruling 6).
//
// Built ON the survivors, never beside them (CLAUDE.md §1, LAW 2/3):
//   · market statistics — the tenant's `market_data` rows, refreshed through THE market-data waterfall
//     (lib/intelligence/market-insight-generator.ts refreshMarketData: RentCast /markets → OSINT → …) when the territory has no
//     fresh row. RentCast spend is metered inside its client (lib/property/rentcast.ts meterCall) — never a second meter here.
//   · closed sales — the tenant's MLS-synced `listings` (status 'sold', sold_price, sold_date) inside the territory.
//   · street-level comparables — THE CMA comps survivor (lib/cma/comp-provider.ts sourceCompsForCma: IDX → RentCast → BatchData),
//     provider-only (allowAiGapFill: false — a market report never prints a model-authored comparable).
//   · monthly trend — `market_trends` (the same refresher's monthly snapshot).
//
// HONESTY RULES (each enforced here, proven by scripts/market-report-producer-guard.ts):
//   · `market_data` zero-fills what its writer did not observe (sold_listings_30d / list_to_sale_ratio / months_of_inventory /
//     price_trend_* default 0, and the RentCast tier writes 0 for what /markets does not expose) — so a 0 there is UNKNOWN,
//     never a fact. Every 0 becomes an UnavailableDatum.
//   · RentCast's median is an ASKING price of listings → `median_asking_price`, never "sold".
//   · `cma_aggregate` rows (an average of agents' CMA recommendations) are OPINION, not market data — excluded and said.
//   · A median from fewer than MIN_RECORDS_FOR_MEDIAN closed sales is not reported (said, with the count).
//   · Data older than FRESH_DAYS is refreshed; older than MAX_MARKET_ROW_AGE_DAYS is unavailable (with its date).
//
// Tenant-pinned everywhere (the brokerageId is the CALLER-VERIFIED tenant). Every { error } is read. Never throws.

import { isoDay, unavailable, type ComparableSale, type MarketDatum, type MarketReportTerritory, type MarketSource, type TrendPoint, type UnavailableDatum } from "./contract"

type Db = { from: (table: string) => any }

const FRESH_DAYS = 30
const MAX_MARKET_ROW_AGE_DAYS = 120
const SOLD_WINDOW_DAYS = 180
/** The CMA survivor's own floor (lib/cma/comp-provider.ts REQUIRED_SOLD_COMPS = 3) — one number for "enough sales". */
export const MIN_RECORDS_FOR_MEDIAN = 3
const DAY_MS = 86_400_000

// ── TERRITORY ────────────────────────────────────────────────────────────────

export interface TerritoryHint {
  zip?: string | null
  city?: string | null
  state?: string | null
  address?: string | null
  label?: string | null
}

/**
 * PURE — the grain a report is written at (creative latitude: "how the producer chooses the territory grain"). The smallest
 * grain the evidence honestly supports: an address with ≥ MIN_RECORDS_FOR_MEDIAN provider comparables → street ("what sold
 * near you"); a ZIP → zip (RentCast publishes zip aggregates); a city + state → city; nothing → no territory (refused upstream).
 */
export function chooseTerritoryGrain(hint: TerritoryHint, evidence: { streetComps?: number } = {}): { territory: MarketReportTerritory | null; reason: string } {
  const zip = (hint.zip ?? "").trim()
  const city = (hint.city ?? "").trim()
  const state = (hint.state ?? "").trim().toUpperCase()
  const address = (hint.address ?? "").trim()
  const labelOr = (fallback: string) => (hint.label ?? "").trim() || fallback
  if (address && (evidence.streetComps ?? 0) >= MIN_RECORDS_FOR_MEDIAN) {
    return { territory: { grain: "street", label: labelOr(`around ${address}`), address, zip: zip || null, city: city || null, state: state || null, radiusMiles: 1 }, reason: `${evidence.streetComps} provider comparables near the address support a street-level report` }
  }
  if (/^\d{5}$/.test(zip)) {
    return { territory: { grain: "zip", label: labelOr(city && state ? `${zip} (${city}, ${state})` : zip), zip, city: city || null, state: state || null }, reason: address ? `too few comparables near ${address} for street level — written at ZIP ${zip}` : `ZIP ${zip} is the smallest grain with published aggregates` }
  }
  if (city && /^[A-Z]{2}$/.test(state)) {
    return { territory: { grain: "city", label: labelOr(`${city}, ${state}`), city, state, zip: null }, reason: `no ZIP — written at city level for ${city}, ${state}` }
  }
  return { territory: null, reason: "no ZIP, no city + state and no address — a market report cannot be territory-specific without one" }
}

/** The territory a tenant's report is about: the caller's hint → the tenant's active farm territory → the brokerage's own address. */
export async function resolveReportTerritory(svc: Db, input: { brokerageId: string; agentId?: string | null; hint?: TerritoryHint | null }): Promise<{ hint: TerritoryHint | null; basis: string; error: string | null }> {
  const h = input.hint ?? null
  if (h && ((h.zip ?? "").trim() || ((h.city ?? "").trim() && (h.state ?? "").trim()) || (h.address ?? "").trim())) return { hint: h, basis: "magnet_settings", error: null }
  let q = svc.from("farm_territories").select("id, name, city, state, zip_codes, agent_id, is_active").eq("brokerage_id", input.brokerageId).eq("is_active", true).limit(5)
  const { data: farms, error: fErr } = await q
  if (fErr) return { hint: null, basis: "none", error: `farm_territories read refused: ${fErr.message ?? "unknown"}` }
  const list = (farms ?? []) as Array<{ name: string | null; city: string | null; state: string | null; zip_codes: string[] | null; agent_id: string | null }>
  const farm = list.find((f) => input.agentId && f.agent_id === input.agentId) ?? list[0]
  if (farm) {
    const zip = Array.isArray(farm.zip_codes) ? farm.zip_codes.find((z) => /^\d{5}$/.test(String(z).trim())) ?? null : null
    if (zip || (farm.city && farm.state)) return { hint: { zip, city: farm.city, state: farm.state, label: null }, basis: `farm_territory${farm.name ? `:${farm.name}` : ""}`, error: null }
  }
  const { data: b, error: bErr } = await svc.from("brokerages").select("city, state, zip").eq("id", input.brokerageId).maybeSingle()
  if (bErr) return { hint: null, basis: "none", error: `brokerages read refused: ${bErr.message ?? "unknown"}` }
  const br = b as { city: string | null; state: string | null; zip: string | null } | null
  if (br && (br.zip || (br.city && br.state))) return { hint: { zip: br.zip, city: br.city, state: br.state }, basis: "brokerage_address", error: null }
  return { hint: null, basis: "none", error: null }
}

// ── RESEARCH ─────────────────────────────────────────────────────────────────

interface MarketDataRow {
  id?: string
  data_date: string
  source_type: string | null
  zip_code: string | null
  city: string | null
  state: string | null
  active_listings: number | null
  new_listings_30d: number | null
  median_sale_price: number | null
  avg_days_on_market: number | null
  price_trend_pct_1yr: number | null
}

interface StreetComp { address: string; salePrice: number; saleDate: string; priceBasis: "closed_sale" | "list_price" | null; provider: string | null; bedrooms?: number | null; sqftLiving?: number | null; distanceMiles?: number | null }

export interface ResearchDeps {
  now?: Date
  /** THE market-data refresher (default: lib/intelligence/market-insight-generator.ts refreshMarketData). */
  refreshMarketData?: (a: { brokerageId: string; marketArea: string; zipCode?: string; city?: string; state?: string }) => Promise<{ source: string; success: boolean; error?: string }>
  /** Street-grain comparables (default: lib/cma/comp-provider.ts sourceCompsForCma, provider-only). */
  streetComps?: (a: { brokerageId: string; agentUserId: string | null; address: string; city: string | null; state: string | null; zip: string | null }) => Promise<StreetComp[]>
}

export interface ResearchResult {
  data: MarketDatum[]
  unavailable: UnavailableDatum[]
  comparables: ComparableSale[]
  trend: TrendPoint[]
  /** What was looked at and set aside (published beside the report — §2). */
  notes: string[]
  /** Refusals while reading — the producer FAILS CLOSED on any (a report built on a refused read could omit what it denies). */
  errors: string[]
  refreshed: { attempted: boolean; source: string | null; success: boolean | null }
}

const MARKET_ROW_COLUMNS = "id, data_date, source_type, zip_code, city, state, active_listings, new_listings_30d, median_sale_price, avg_days_on_market, price_trend_pct_1yr"

const positive = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null }
const nonZero = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) && n !== 0 ? n : null }
function median(xs: number[]): number { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

async function readLatestMarketRow(svc: Db, brokerageId: string, t: MarketReportTerritory): Promise<{ row: MarketDataRow | null; excluded: string[]; error: string | null }> {
  let q = svc.from("market_data").select(MARKET_ROW_COLUMNS).eq("brokerage_id", brokerageId)
  if (t.zip) q = q.eq("zip_code", t.zip)
  else if (t.city && t.state) q = q.ilike("city", t.city).eq("state", t.state)
  else return { row: null, excluded: [], error: null }
  const { data, error } = await q.order("data_date", { ascending: false }).limit(10)
  if (error) return { row: null, excluded: [], error: `market_data read refused: ${error.message ?? "unknown"}` }
  const rows = (data ?? []) as MarketDataRow[]
  const excluded = rows.filter((r) => r.source_type === "cma_aggregate").map((r) => `market_data ${r.data_date}: cma_aggregate (an average of agents' CMA recommendations) is opinion, not market data — excluded`)
  return { row: rows.find((r) => r.source_type !== "cma_aggregate") ?? null, excluded, error: null }
}

function providerOf(sourceType: string | null): MarketSource["provider"] | null {
  switch (sourceType) {
    case "rentcast": return "rentcast"
    case "osint_scrape": return "osint_scrape"
    case "batchdata": return "batchdata"
    case "mls_feed": return "mls_feed"
    case "idx_broker": return "idx_broker"
    case "manual_import": return "manual_import"
    default: return null
  }
}

/** PURE — one market_data row → dated, sourced data + honest unavailable entries. Proven through researchMarket. */
function marketRowToData(row: MarketDataRow | null, t: MarketReportTerritory, asOf: string, now: Date): { data: MarketDatum[]; unavailable: UnavailableDatum[]; notes: string[] } {
  const data: MarketDatum[] = []
  const missing: UnavailableDatum[] = []
  const notes: string[] = []
  const keys = [
    ["median_asking_price", "Median asking price (listings)"],
    ["active_listings", "Active listings"],
    ["new_listings_30d", "New listings (30 days)"],
    ["avg_days_on_market", "Average days on market (listings)"],
    ["asking_price_yoy_pct", "Asking-price change, year over year"],
  ] as const
  const provider = row ? providerOf(row.source_type) : null
  const ageDays = row ? (now.getTime() - Date.parse(`${row.data_date}T00:00:00Z`)) / DAY_MS : Infinity
  if (!row || !provider || ageDays > MAX_MARKET_ROW_AGE_DAYS) {
    const reason = !row ? "no market statistics on record for this territory" : !provider ? `market_data source '${row.source_type}' is not a recognised market-data provider` : `the latest market statistics are dated ${row.data_date} — older than ${MAX_MARKET_ROW_AGE_DAYS} days`
    for (const [k, l] of keys) missing.push(unavailable(k, l, t, asOf, reason))
    if (row && !provider) notes.push(reason)
    return { data, unavailable: missing, notes }
  }
  const source: MarketSource = { provider, dataset: "market_data", ref: row.id ?? row.zip_code ?? null }
  const listingCaveat = provider === "rentcast"
    ? "RentCast market statistics describe LISTINGS (asking prices, listing counts); dated by the day this brokerage retrieved them"
    : provider === "osint_scrape" ? "scraped public listing statistics; dated by the day they were retrieved" : null
  const push = (key: MarketDatum["key"], label: string, value: number | null, unit: MarketDatum["unit"]) => {
    if (value == null) { missing.push(unavailable(key, label, t, asOf, `not observed in the ${row.data_date} ${provider} reading (recorded as 0 = unknown)`)); return }
    data.push({ key, label, value, unit, asOf: row.data_date, source, basis: "provider_reported", caveat: listingCaveat })
  }
  push("median_asking_price", "Median asking price (listings)", positive(row.median_sale_price), "usd")
  push("active_listings", "Active listings", positive(row.active_listings), "count")
  push("new_listings_30d", "New listings (30 days)", positive(row.new_listings_30d), "count")
  push("avg_days_on_market", "Average days on market (listings)", positive(row.avg_days_on_market), "days")
  push("asking_price_yoy_pct", "Asking-price change, year over year", nonZero(row.price_trend_pct_1yr), "pct")
  return { data, unavailable: missing, notes }
}

async function readClosedSales(svc: Db, brokerageId: string, t: MarketReportTerritory, now: Date): Promise<{ rows: Array<{ id: string; address: string | null; sold_price: number; sold_date: string; list_price: number | null; listing_date: string | null; bedrooms: number | null; bathrooms: number | null; sqft: number | null }>; error: string | null }> {
  const since = isoDay(new Date(now.getTime() - SOLD_WINDOW_DAYS * DAY_MS))
  let q = svc.from("listings").select("id, address, sold_price, sold_date, list_price, listing_date, bedrooms, bathrooms, sqft, zip, city, state")
    .eq("brokerage_id", brokerageId).eq("status", "sold").is("deleted_at", null).gte("sold_date", since)
  if (t.zip) q = q.eq("zip", t.zip)
  else if (t.city && t.state) q = q.ilike("city", t.city).eq("state", t.state)
  else return { rows: [], error: null }
  const { data, error } = await q.order("sold_date", { ascending: false }).limit(200)
  if (error) return { rows: [], error: `listings (closed sales) read refused: ${error.message ?? "unknown"}` }
  const rows = ((data ?? []) as Array<Record<string, unknown>>).filter((r) => positive(r.sold_price) != null && typeof r.sold_date === "string")
  return { rows: rows.map((r) => ({ id: String(r.id), address: (r.address as string | null) ?? null, sold_price: Number(r.sold_price), sold_date: String(r.sold_date).slice(0, 10), list_price: positive(r.list_price), listing_date: typeof r.listing_date === "string" ? String(r.listing_date).slice(0, 10) : null, bedrooms: positive(r.bedrooms), bathrooms: positive(r.bathrooms), sqft: positive(r.sqft) })), error: null }
}

/** PURE — closed sales → computed data + comparables (MIN_RECORDS_FOR_MEDIAN floor). Proven through researchMarket. */
function closedSalesToData(rows: Awaited<ReturnType<typeof readClosedSales>>["rows"], t: MarketReportTerritory, asOf: string): { data: MarketDatum[]; unavailable: UnavailableDatum[]; comparables: ComparableSale[] } {
  const source: MarketSource = { provider: "tenant_mls", dataset: "listings (status sold)" }
  const window = `the last ${SOLD_WINDOW_DAYS} days`
  const caveat = "closed sales recorded in this brokerage's MLS-synced listings — a sample of the territory, not every sale"
  const newest = rows.reduce<string | null>((m, r) => (m == null || r.sold_date > m ? r.sold_date : m), null)
  const comparables: ComparableSale[] = rows.slice(0, 8).map((r) => ({ address: r.address ?? "address withheld", price: r.sold_price, priceBasis: "recorded_sale", date: r.sold_date, source: { ...source, ref: r.id }, beds: r.bedrooms, baths: r.bathrooms, sqft: r.sqft }))
  if (rows.length < MIN_RECORDS_FOR_MEDIAN || !newest) {
    const reason = `only ${rows.length} closed sale(s) in ${window} — fewer than ${MIN_RECORDS_FOR_MEDIAN} is not a median`
    return {
      data: [],
      unavailable: [
        unavailable("median_sold_price", "Median sold price", t, asOf, reason),
        unavailable("closed_sales_count", "Closed sales", t, asOf, reason),
        unavailable("median_days_to_sell", "Median days to sell", t, asOf, reason),
        unavailable("sale_to_list_ratio_pct", "Sale-to-list price", t, asOf, reason),
      ],
      comparables,
    }
  }
  const data: MarketDatum[] = [
    { key: "median_sold_price", label: "Median sold price", value: Math.round(median(rows.map((r) => r.sold_price))), unit: "usd", asOf: newest, source, basis: "computed_from_records", sampleSize: rows.length, caveat },
    { key: "closed_sales_count", label: `Closed sales (${window})`, value: rows.length, unit: "count", asOf: newest, source, basis: "computed_from_records", sampleSize: rows.length, caveat },
  ]
  const missing: UnavailableDatum[] = []
  const dts = rows.filter((r) => r.listing_date).map((r) => (Date.parse(`${r.sold_date}T00:00:00Z`) - Date.parse(`${r.listing_date}T00:00:00Z`)) / DAY_MS).filter((d) => d >= 0)
  if (dts.length >= MIN_RECORDS_FOR_MEDIAN) data.push({ key: "median_days_to_sell", label: "Median days to sell", value: Math.round(median(dts)), unit: "days", asOf: newest, source, basis: "computed_from_records", sampleSize: dts.length, caveat })
  else missing.push(unavailable("median_days_to_sell", "Median days to sell", t, asOf, `only ${dts.length} closed sale(s) carry a listing date`))
  const ratios = rows.filter((r) => r.list_price).map((r) => (r.sold_price / (r.list_price as number)) * 100)
  if (ratios.length >= MIN_RECORDS_FOR_MEDIAN) data.push({ key: "sale_to_list_ratio_pct", label: "Sale-to-list price", value: Math.round(median(ratios) * 10) / 10, unit: "pct", asOf: newest, source, basis: "computed_from_records", sampleSize: ratios.length, caveat: `${caveat}; shown as the sold price as a percent of the list price` })
  else missing.push(unavailable("sale_to_list_ratio_pct", "Sale-to-list price", t, asOf, `only ${ratios.length} closed sale(s) carry a list price`))
  return { data, unavailable: missing, comparables }
}

async function readTrend(svc: Db, brokerageId: string, t: MarketReportTerritory): Promise<{ trend: TrendPoint[]; error: string | null }> {
  if (!t.zip) return { trend: [], error: null }
  const { data, error } = await svc.from("market_trends").select("snapshot_month, median_price, active_inventory, zip_code").eq("brokerage_id", brokerageId).eq("zip_code", t.zip).order("snapshot_month", { ascending: false }).limit(12)
  if (error) return { trend: [], error: `market_trends read refused: ${error.message ?? "unknown"}` }
  return {
    trend: ((data ?? []) as Array<{ snapshot_month: string; median_price: number | null; active_inventory: number | null }>)
      .map((r) => ({ month: String(r.snapshot_month).slice(0, 7), medianPrice: positive(r.median_price), activeInventory: positive(r.active_inventory), source: { provider: "rentcast" as const, dataset: "market_trends" } }))
      .filter((p) => p.medianPrice != null || p.activeInventory != null)
      .reverse(),
    error: null,
  }
}

const defaultRefresh: NonNullable<ResearchDeps["refreshMarketData"]> = async (a) => {
  const { refreshMarketData } = await import("@/lib/intelligence/market-insight-generator")
  return refreshMarketData(a.brokerageId, a.marketArea, a.zipCode, a.city, a.state)
}

const defaultStreetComps: NonNullable<ResearchDeps["streetComps"]> = async (a) => {
  const { sourceCompsForCma } = await import("@/lib/cma/comp-provider")
  const r = await sourceCompsForCma({ brokerageId: a.brokerageId, agentUserId: a.agentUserId, address: a.address, city: a.city, state: a.state, zip: a.zip, subject: {}, allowAiGapFill: false, systemSource: "market_report" })
  return r.closedComps.map((c) => ({ address: c.address, salePrice: c.salePrice, saleDate: String(c.saleDate).slice(0, 10), priceBasis: c.priceBasis ?? null, provider: c.sourceProvider ?? null, bedrooms: c.bedrooms ?? null, sqftLiving: c.sqftLiving ?? null, distanceMiles: c.distanceMiles ?? null }))
}

/** Gather the territory's dated, sourced facts. Never throws; a refused read lands in `errors` (the producer fails closed). */
export async function researchMarket(svc: Db, input: { brokerageId: string; agentUserId?: string | null; territory: MarketReportTerritory }, deps: ResearchDeps = {}): Promise<ResearchResult> {
  const now = deps.now ?? new Date()
  const asOf = isoDay(now)
  const t = input.territory
  const notes: string[] = []
  const errors: string[] = []
  const refreshed: ResearchResult["refreshed"] = { attempted: false, source: null, success: null }
  try {
    // 1 · market statistics (refresh through the waterfall when nothing fresh is on record).
    let market = await readLatestMarketRow(svc, input.brokerageId, t)
    if (market.error) errors.push(market.error)
    const fresh = market.row && (now.getTime() - Date.parse(`${market.row.data_date}T00:00:00Z`)) / DAY_MS <= FRESH_DAYS
    if (!market.error && !fresh && t.zip) {
      refreshed.attempted = true
      const r = await (deps.refreshMarketData ?? defaultRefresh)({ brokerageId: input.brokerageId, marketArea: t.label, zipCode: t.zip, city: t.city ?? undefined, state: t.state ?? undefined })
        .catch((e: unknown) => ({ source: "threw", success: false, error: e instanceof Error ? e.message : String(e) }))
      refreshed.source = r.source; refreshed.success = r.success
      if (!r.success) notes.push(`market-data refresh did not land a reading (${r.source}${r.error ? `: ${r.error}` : ""})`)
      market = await readLatestMarketRow(svc, input.brokerageId, t)
      if (market.error) errors.push(market.error)
    }
    notes.push(...market.excluded)
    const fromMarket = marketRowToData(market.row, t, asOf, now)
    notes.push(...fromMarket.notes)

    // 2 · closed sales (MLS-synced) + comparables.
    const sales = await readClosedSales(svc, input.brokerageId, t, now)
    if (sales.error) errors.push(sales.error)
    const fromSales = closedSalesToData(sales.rows, t, asOf)

    // 3 · street grain: provider comparables near the address (provider-only).
    let comparables: ComparableSale[] = fromSales.comparables
    if (t.grain === "street" && t.address) {
      const comps = await (deps.streetComps ?? defaultStreetComps)({ brokerageId: input.brokerageId, agentUserId: input.agentUserId ?? null, address: t.address, city: t.city ?? null, state: t.state ?? null, zip: t.zip ?? null })
        .catch((e: unknown) => { errors.push(`street comparables failed: ${e instanceof Error ? e.message : String(e)}`); return [] as StreetComp[] })
      const street: ComparableSale[] = comps.filter((c) => c.salePrice > 0 && /^\d{4}-\d{2}-\d{2}$/.test(c.saleDate)).slice(0, 8).map((c) => ({
        address: c.address, price: c.salePrice, priceBasis: c.priceBasis === "closed_sale" ? "recorded_sale" : "last_list_price", date: c.saleDate,
        source: { provider: c.provider === "rentcast" ? "rentcast" : c.provider === "batchdata" ? "batchdata" : c.provider === "idx" ? "idx_broker" : "tenant_mls", dataset: "comparable sales (CMA comp sources)" },
        beds: c.bedrooms ?? null, sqft: c.sqftLiving ?? null, distanceMiles: c.distanceMiles ?? null,
      }))
      comparables = [...street, ...comparables].slice(0, 10)
    }

    // 4 · monthly trend.
    const trend = await readTrend(svc, input.brokerageId, t)
    if (trend.error) errors.push(trend.error)

    const unavailableAll = [...fromMarket.unavailable, ...fromSales.unavailable]
    if (comparables.length === 0) unavailableAll.push(unavailable("comparable_sales", "Comparable sales", t, asOf, `no closed sales or provider comparables in the last ${SOLD_WINDOW_DAYS} days`))
    if (trend.trend.length < 2) unavailableAll.push(unavailable("monthly_trend", "Monthly trend", t, asOf, `${trend.trend.length} monthly snapshot(s) on record — a trend needs at least two`))
    return { data: [...fromMarket.data, ...fromSales.data], unavailable: unavailableAll, comparables, trend: trend.trend, notes, errors, refreshed }
  } catch (e) {
    errors.push(`research threw: ${e instanceof Error ? e.message : String(e)}`)
    return { data: [], unavailable: [], comparables: [], trend: [], notes, errors, refreshed }
  }
}
