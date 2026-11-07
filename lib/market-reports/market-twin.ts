// lib/market-reports/market-twin.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE TENANT LOCAL MARKET TWIN + THE HOUSING MATCH GAP (wave 150, lane 150KLMO — directive 150O, contract C41, ruling R8).
//
// SURVIVOR VERDICT (CLAUDE.md §1, LAW 1/2 — no second market store, no second RentCast client):
//   · the RentCast ZIP market read is lib/property/rentcast.ts getRentcastMarketStats (`/markets`, dataType All) — it already
//     rides THE platform-wide provider-payload cache (lib/cma/comp-supplement-cache.ts, key `rentcast:/markets|<zip>`,
//     RENTCAST_CACHE_TTL_DAYS.markets = 7) and meters ONLY on a miss (meterCall inside the fetcher). That IS "cached once per
//     region/period" (C41 / directive §4: legal market-level facts may be cached platform-wide). This module never calls
//     RentCast any other way and never writes a second cache; scripts/market-twin-guard.ts §C holds rentcast.ts to that shape.
//   · the tenant's stored reading is market_data (THE refresher's rows — lib/intelligence/market-insight-generator.ts);
//   · closed sales are the tenant's MLS-synced `listings` (status sold) — a SAMPLE of the territory, labelled as such;
//   · the approved territories are lib/geo/tenant-markets.ts loadTenantMarkets (Settings → Territories, ruling 14) — resolved by the CALLER and passed in as zips + cities;
//   · consented buyer demand is property_preferences read the way lib/buyer-search/buyer-criteria.ts defines it (a field the
//     buyer SAID, held on a stated consent basis — CRITERIA_CONSENT_BASES); inferred-only rows are behaviour, not demand.
//
// CANARY 17 — LABELS. RentCast `/markets` saleData describes LISTINGS: its median is an ASKING price of homes listed for sale
// (rentcast-normalize.ts names the field `median_sale_price`; that name is historical and wrong — every figure here is
// re-labelled `listing_asking`). Sold medians come ONLY from recorded closed sales and are labelled `recorded_sale`. A twin
// fact without its basis does not exist (the type requires it).
//
// C41 — THE HOUSING MATCH GAP: consented buyer demand × FRESH licensed active inventory in the tenant's APPROVED territory →
// attributed demand-gap segments. Never a buyer identity (segments under DEMAND_K_FLOOR buyers are suppressed and counted),
// never "a buyer has been found" (claimBoundary), never stale inventory (INVENTORY_FRESH_DAYS, counted when excluded).
// Months of supply is published ONLY from a feed that observed sold counts (an MLS / IDX market_data row); RentCast exposes
// none and the tenant's closed sales are a sample, so otherwise it is null WITH the reason — never derived from a sample.
//
// Consumers: lib/market-reports/topics.ts (demand-gap + relocation evidence for the report strategist); `marketGap` is the
// shape lib/lead-pipeline/source-discovery-planner.ts planSourceDiscovery takes (wiring at app/actions/acquisition-plan.ts —
// lane 150KLMO notes, Outside-lane). Tenant-pinned on every tenant read; every { error } is read. Never throws.

type Db = { from: (table: string) => any }

const DAY_MS = 86_400_000
/** The provider cache window getRentcastMarketStats rides (lib/property/rentcast.ts RENTCAST_CACHE_TTL_DAYS.markets). */
const PROVIDER_CACHE_WINDOW_DAYS = 7
/** A stored tenant reading older than this is not the twin's answer (research.ts's own ceiling). */
const MAX_READING_AGE_DAYS = 120
/** Inventory last seen / synced longer ago than this is STALE — excluded from the match gap and counted. */
const INVENTORY_FRESH_DAYS = 14
/** A demand segment with fewer buyers than this is suppressed — a count that small can point at a person. */
const DEMAND_K_FLOOR = 3
/** Closed sales below this are not a median (research.ts MIN_RECORDS_FOR_MEDIAN — one number for "enough sales"). */
const MIN_SALES_FOR_MEDIAN = 3
const SOLD_WINDOW_DAYS = 180
const MAX_TWIN_ZIPS = 10

type PriceBasis = "listing_asking" | "recorded_sale" | "listing_rent"

interface TwinFact { value: number; label: string; basis: PriceBasis | "listing_count" | "listing_pace"; unit: "usd" | "count" | "days" | "pct" }

interface TwinZip {
  zip: string
  /** The period the facts describe: RentCast's own update date when published, else the reading's date (YYYY-MM-DD). */
  asOf: string | null
  /** "YYYY-MM" — the cache period (one shared read per zip per provider window). */
  period: string
  listing: Record<"medianAskingPrice" | "activeListings" | "newListings30d" | "avgDaysOnMarket" | "askingPriceYoyPct" | "medianAskingPricePerSqft", TwinFact | null>
  rental: { medianRent: TwinFact | null }
  sold: { medianSoldPrice: TwinFact | null; closedSales: number; window: string; caveat: string }
  via: "provider_read" | "tenant_reading" | "none"
  source: { provider: "rentcast" | "tenant_market_data" | null; endpoint: string | null; cache: string; rights: string; retrievedAt: string | null }
  reason: string | null
}

interface DemandGapSegment {
  area: string
  priceBand: string
  beds: string
  /** Distinct buyers whose OWN stated, consented criteria fit this segment (≥ DEMAND_K_FLOOR; never an id). */
  consentedBuyers: number
  /** Fresh active listings (tenant IDX/MLS + the licensed active feed) that fit the segment. */
  freshInventory: number
  undersupplied: boolean
  attribution: string
  /** What may be said — and what may never be (C41). */
  claimBoundary: string
}

export interface MarketTwin {
  brokerageId: string
  asOf: string
  zips: TwinZip[]
  /** The planner's MarketGap (lib/lead-pipeline/source-discovery-planner.ts) — months of supply only from an observed feed. */
  marketGap: { monthsOfSupply: number | null; asOf: string | null; source: string | null; reason: string }
  demandGap: { segments: DemandGapSegment[]; suppressedSegments: number; consentedBuyers: number; staleInventoryExcluded: number; freshInventory: number }
  notes: string[]
  blindSpots: string[]
}

interface ProviderMarketStats {
  median_sale_price: number; avg_days_on_market: number; active_listings: number; new_listings_30d: number; price_trend_yoy_pct: number
  median_price_per_sqft?: number | null; total_listings_at?: string | null; rental?: { median_rent: number } | null
}

interface MarketTwinDeps {
  now?: Date
  /** THE RentCast ZIP read (default lib/property/rentcast.ts getRentcastMarketStats — platform-cached, gated, metered on miss). */
  providerRead?: (a: { brokerageId: string; zipCode: string }) => Promise<ProviderMarketStats | null>
  /** The shoppable listing statuses (default lib/buyer-search/search-engine.ts buyerShoppableListingStatuses). */
  activeStatuses?: () => Promise<string[]>
}

const positive = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null }
const isoDay = (d: Date) => d.toISOString().slice(0, 10)
function median(xs: number[]): number { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

/** The labels a reader sees — one place, so a listing figure can never be printed as a sale (canary 17). */
const LABEL = {
  medianAskingPrice: "Median asking price (homes listed for sale)",
  activeListings: "Active listings",
  newListings30d: "New listings (30 days)",
  avgDaysOnMarket: "Average days on market (listings)",
  askingPriceYoyPct: "Asking-price change, year over year (listings)",
  medianAskingPricePerSqft: "Median asking price per sq ft (listings)",
  medianRent: "Median asking rent (rental listings)",
  medianSoldPrice: "Median sold price (recorded closed sales)",
} as const

const fact = (value: number | null, label: string, basis: TwinFact["basis"], unit: TwinFact["unit"]): TwinFact | null => (value == null ? null : { value, label, basis, unit })

const RENTCAST_RIGHTS = "licensed_vendor — RentCast API market aggregates (ZIP level, no person data); displayed with the source named and dated"

/** PURE — a provider stats object → labelled listing/rental facts. */
function providerFacts(s: ProviderMarketStats): Pick<TwinZip, "listing" | "rental"> {
  return {
    listing: {
      medianAskingPrice: fact(positive(s.median_sale_price), LABEL.medianAskingPrice, "listing_asking", "usd"),
      activeListings: fact(positive(s.active_listings), LABEL.activeListings, "listing_count", "count"),
      newListings30d: fact(positive(s.new_listings_30d), LABEL.newListings30d, "listing_count", "count"),
      avgDaysOnMarket: fact(positive(s.avg_days_on_market), LABEL.avgDaysOnMarket, "listing_pace", "days"),
      askingPriceYoyPct: Number(s.price_trend_yoy_pct) ? fact(Number(s.price_trend_yoy_pct), LABEL.askingPriceYoyPct, "listing_asking", "pct") : null,
      medianAskingPricePerSqft: fact(positive(s.median_price_per_sqft), LABEL.medianAskingPricePerSqft, "listing_asking", "usd"),
    },
    rental: { medianRent: fact(positive(s.rental?.median_rent), LABEL.medianRent, "listing_rent", "usd") },
  }
}

const EMPTY_LISTING: TwinZip["listing"] = { medianAskingPrice: null, activeListings: null, newListings30d: null, avgDaysOnMarket: null, askingPriceYoyPct: null, medianAskingPricePerSqft: null }

/** One ZIP of the twin: the shared provider read (when allowed) → else the tenant's stored RentCast reading → else none, said. */
async function twinZip(svc: Db, a: { brokerageId: string; zip: string; now: Date; allowProviderRead: boolean }, deps: MarketTwinDeps, notes: string[]): Promise<TwinZip> {
  const period = isoDay(a.now).slice(0, 7)
  const cache = `platform-wide provider cache rentcast:/markets|${a.zip} (${PROVIDER_CACHE_WINDOW_DAYS}-day window — one metered read per zip per window, shared by every tenant)`
  const base: TwinZip = { zip: a.zip, asOf: null, period, listing: { ...EMPTY_LISTING }, rental: { medianRent: null }, sold: { medianSoldPrice: null, closedSales: 0, window: `last ${SOLD_WINDOW_DAYS} days`, caveat: "this brokerage's MLS-synced closed sales — a sample of the territory, not every sale" }, via: "none", source: { provider: null, endpoint: null, cache, rights: RENTCAST_RIGHTS, retrievedAt: null }, reason: null }

  if (a.allowProviderRead) {
    const read = deps.providerRead ?? (async (x: { brokerageId: string; zipCode: string }) => {
      const { getRentcastMarketStats } = await import("@/lib/property/rentcast")
      return getRentcastMarketStats({ brokerageId: x.brokerageId, zipCode: x.zipCode, systemSource: "market_twin" } as never)
    })
    const stats = await read({ brokerageId: a.brokerageId, zipCode: a.zip }).catch((e: unknown) => { notes.push(`RentCast /markets ${a.zip} unavailable: ${e instanceof Error ? e.message : String(e)}`); return null })
    if (stats) {
      const asOf = typeof stats.total_listings_at === "string" && stats.total_listings_at ? stats.total_listings_at.slice(0, 10) : isoDay(a.now)
      Object.assign(base, providerFacts(stats), { via: "provider_read", asOf, source: { provider: "rentcast", endpoint: "/markets", cache, rights: RENTCAST_RIGHTS, retrievedAt: isoDay(a.now) } })
    }
  }
  if (base.via === "none") {
    const { data, error } = await svc.from("market_data").select("id, data_date, source_type, median_sale_price, active_listings, new_listings_30d, avg_days_on_market, price_trend_pct_1yr")
      .eq("brokerage_id", a.brokerageId).eq("zip_code", a.zip).eq("source_type", "rentcast").order("data_date", { ascending: false }).limit(1)
    if (error) notes.push(`market_data ${a.zip} read refused: ${error.message ?? "unknown"} — the stored reading is a blind spot`)
    const row = ((data ?? []) as Array<Record<string, unknown>>)[0]
    const age = row ? (a.now.getTime() - Date.parse(`${String(row.data_date)}T00:00:00Z`)) / DAY_MS : Infinity
    if (row && age <= MAX_READING_AGE_DAYS) {
      Object.assign(base, providerFacts({ median_sale_price: Number(row.median_sale_price), active_listings: Number(row.active_listings), new_listings_30d: Number(row.new_listings_30d), avg_days_on_market: Number(row.avg_days_on_market), price_trend_yoy_pct: Number(row.price_trend_pct_1yr) }),
        { via: "tenant_reading", asOf: String(row.data_date), source: { provider: "tenant_market_data", endpoint: "/markets (stored RentCast reading)", cache, rights: RENTCAST_RIGHTS, retrievedAt: String(row.data_date) } })
      base.rental = { medianRent: null }
    } else base.reason = row ? `the latest stored RentCast reading is dated ${String(row.data_date)} — older than ${MAX_READING_AGE_DAYS} days` : a.allowProviderRead ? "RentCast returned no market statistics for this zip" : "no stored RentCast reading and no authorized provider read"
  }

  // Sold medians — recorded closed sales only, labelled as such (never mixed with listing figures).
  const since = isoDay(new Date(a.now.getTime() - SOLD_WINDOW_DAYS * DAY_MS))
  const { data: sold, error: sErr } = await svc.from("listings").select("id, sold_price, sold_date").eq("brokerage_id", a.brokerageId).eq("zip", a.zip).eq("status", "sold").is("deleted_at", null).gte("sold_date", since).limit(500)
  if (sErr) notes.push(`listings (closed sales) ${a.zip} read refused: ${sErr.message ?? "unknown"} — sold medians are a blind spot`)
  const prices = ((sold ?? []) as Array<{ sold_price: unknown }>).map((r) => positive(r.sold_price)).filter((n): n is number => n != null)
  base.sold.closedSales = prices.length
  if (prices.length >= MIN_SALES_FOR_MEDIAN) base.sold.medianSoldPrice = fact(Math.round(median(prices)), LABEL.medianSoldPrice, "recorded_sale", "usd")
  return base
}

/** Months of supply ONLY from a feed that observed sold counts (MLS / IDX market_data rows). */
async function observedMonthsOfSupply(svc: Db, brokerageId: string, zips: string[], now: Date, notes: string[]): Promise<MarketTwin["marketGap"]> {
  const none = (reason: string): MarketTwin["marketGap"] => ({ monthsOfSupply: null, asOf: null, source: null, reason })
  if (zips.length === 0) return none("no approved territory zip — months of supply has no region")
  const { data, error } = await svc.from("market_data").select("data_date, source_type, months_of_inventory, zip_code").eq("brokerage_id", brokerageId).in("zip_code", zips).in("source_type", ["mls_feed", "idx_broker"]).order("data_date", { ascending: false }).limit(20)
  if (error) { notes.push(`market_data (months of supply) read refused: ${error.message ?? "unknown"}`); return none("the observed-supply read was refused — not computed (fail closed)") }
  const row = ((data ?? []) as Array<{ data_date: string; source_type: string; months_of_inventory: unknown }>).find((r) => positive(r.months_of_inventory) != null && (now.getTime() - Date.parse(`${r.data_date}T00:00:00Z`)) / DAY_MS <= MAX_READING_AGE_DAYS)
  if (!row) return none("RentCast /markets exposes no sold counts and this brokerage's closed sales are a sample — months of supply is not derived from either; no MLS/IDX feed reading observed it")
  return { monthsOfSupply: Math.round(Number(row.months_of_inventory) * 10) / 10, asOf: row.data_date, source: `market_data (${row.source_type})`, reason: "observed by the feed" }
}

// ── THE HOUSING MATCH GAP ────────────────────────────────────────────────────

const PRICE_BANDS: ReadonlyArray<{ label: string; min: number; max: number }> = [
  { label: "up to $300k", min: 0, max: 300_000 }, { label: "$300k–$500k", min: 300_000, max: 500_000 },
  { label: "$500k–$750k", min: 500_000, max: 750_000 }, { label: "$750k–$1M", min: 750_000, max: 1_000_000 },
  { label: "$1M+", min: 1_000_000, max: Number.POSITIVE_INFINITY },
]
const bandOf = (maxPrice: number | null) => (maxPrice == null ? null : PRICE_BANDS.find((b) => maxPrice > b.min && maxPrice <= b.max) ?? PRICE_BANDS[PRICE_BANDS.length - 1])
const bedsOf = (minBeds: number | null) => (minBeds == null || minBeds <= 1 ? "any size" : minBeds >= 4 ? "4+ bedrooms" : `${Math.floor(minBeds)}+ bedrooms`)
const bedsMin = (beds: string) => Number(beds.match(/^(\d)/)?.[1] ?? 0)

/** C41 — the sentences a demand gap may NEVER carry (a found buyer, a buyer described). */
const FORBIDDEN_DEMAND_CLAIMS: readonly RegExp[] = [/\b(a|one of (my|our)) buyers? (has been|was|is) found\b/i, /\bI have a buyer\b/i, /\b(a|my|our) buyer for your (home|house|property)\b/i, /\bbuyer (named|called)\b/i]

/** PURE — does a demand-gap sentence break the C41 boundary? (null = it may be said). Used on every attribution written. */
function demandClaimProblem(text: string): string | null {
  const hit = FORBIDDEN_DEMAND_CLAIMS.find((r) => r.test(text))
  return hit ? `a demand gap never says a buyer has been found or describes a buyer (${hit.source})` : null
}

interface ProvenanceEntry { source?: unknown; value?: unknown; consent?: { basis?: unknown } | null }

async function housingMatchGap(svc: Db, a: { brokerageId: string; zips: string[]; cities: string[]; now: Date; brand: string }, deps: MarketTwinDeps, notes: string[], blindSpots: string[]): Promise<MarketTwin["demandGap"]> {
  const out: MarketTwin["demandGap"] = { segments: [], suppressedSegments: 0, consentedBuyers: 0, staleInventoryExcluded: 0, freshInventory: 0 }
  const { CRITERIA_CONSENT_BASES } = await import("@/lib/buyer-search/buyer-criteria")
  const bases = new Set<string>(CRITERIA_CONSENT_BASES)
  const zipSet = new Set(a.zips), citySet = new Set(a.cities.map((c) => c.toLowerCase()))
  if (zipSet.size === 0 && citySet.size === 0) { blindSpots.push("no approved territory — the housing match gap has no area to measure"); return out }

  const { data: prefs, error: pErr } = await svc.from("property_preferences").select("contact_id, preferred_price_max, inferred_max_price, inferred_beds_min, inferred_zip_codes, inferred_cities, criteria_provenance, listing_type").eq("brokerage_id", a.brokerageId).limit(2000)
  if (pErr) { notes.push(`property_preferences read refused: ${pErr.message ?? "unknown"} — no demand gap this run (fail closed)`); return out }
  const demand = new Map<string, { area: string; band: (typeof PRICE_BANDS)[number]; beds: string; buyers: Set<string> }>()
  for (const r of (prefs ?? []) as Array<Record<string, unknown>>) {
    if (String(r.listing_type ?? "sale") === "rent") continue
    const prov = (r.criteria_provenance && typeof r.criteria_provenance === "object" ? r.criteria_provenance : {}) as Record<string, ProvenanceEntry>
    const said = (k: string) => { const p = prov[k]; return p && p.source === "said" ? p : null }
    // CONSENTED DEMAND = at least one field the buyer SAID, held on a stated basis. Inferred-only rows are behaviour, not demand.
    const consented = Object.values(prov).some((p) => p && p.source === "said" && typeof p.consent?.basis === "string" && bases.has(p.consent.basis))
    if (!consented) continue
    const maxPrice = positive(said("maxPrice")?.value) ?? positive(r.preferred_price_max) ?? positive(r.inferred_max_price)
    const minBeds = positive(said("minBeds")?.value) ?? positive(r.inferred_beds_min)
    const zips = (Array.isArray(said("zipCodes")?.value) ? said("zipCodes")!.value : r.inferred_zip_codes) as unknown
    const cities = (Array.isArray(said("cities")?.value) ? said("cities")!.value : r.inferred_cities) as unknown
    const band = bandOf(maxPrice)
    if (!band) continue
    const areas = [
      ...(Array.isArray(zips) ? zips.map((z) => String(z).trim()).filter((z) => zipSet.has(z)) : []),
      ...(Array.isArray(cities) ? cities.map((c) => String(c).trim().toLowerCase()).filter((c) => citySet.has(c)) : []),
    ]
    for (const area of new Set(areas)) {
      const beds = bedsOf(minBeds)
      const key = `${area}|${band.label}|${beds}`
      const seg = demand.get(key) ?? { area, band, beds, buyers: new Set<string>() }
      seg.buyers.add(String(r.contact_id))
      demand.set(key, seg)
    }
  }
  out.consentedBuyers = new Set([...demand.values()].flatMap((s) => [...s.buyers])).size

  // FRESH licensed inventory: the tenant's own IDX/MLS-synced listings + the licensed active feed — last seen within the window.
  const statuses = await (deps.activeStatuses ?? (async () => (await import("@/lib/buyer-search/search-engine")).buyerShoppableListingStatuses()))().catch(() => { blindSpots.push("shoppable listing statuses unavailable — inventory read as status 'active' only"); return ["active"] })
  const freshSince = a.now.getTime() - INVENTORY_FRESH_DAYS * DAY_MS
  const inventory: Array<{ zip: string | null; city: string | null; price: number | null; beds: number | null }> = []
  const { data: own, error: oErr } = await svc.from("listings").select("id, zip, city, list_price, bedrooms, updated_at, last_provider_sync_at").eq("brokerage_id", a.brokerageId).in("status", statuses).is("deleted_at", null).limit(2000)
  if (oErr) { notes.push(`listings (active) read refused: ${oErr.message ?? "unknown"} — no demand gap this run (fail closed)`); return { ...out, segments: [] } }
  for (const l of (own ?? []) as Array<Record<string, unknown>>) {
    const seen = Date.parse(String(l.last_provider_sync_at ?? l.updated_at ?? ""))
    if (!Number.isFinite(seen) || seen < freshSince) { out.staleInventoryExcluded++; continue }
    inventory.push({ zip: l.zip ? String(l.zip) : null, city: l.city ? String(l.city) : null, price: positive(l.list_price), beds: positive(l.bedrooms) })
  }
  const { data: feed, error: fErr } = await svc.from("market_active_listings").select("id, zip, city, list_price, beds, last_seen_at").eq("brokerage_id", a.brokerageId).eq("current_status", "active").limit(2000)
  if (fErr) notes.push(`market_active_listings read refused: ${fErr.message ?? "unknown"} — the licensed active feed is a blind spot (inventory may read LOW, which overstates a gap — said)`)
  for (const l of (feed ?? []) as Array<Record<string, unknown>>) {
    const seen = Date.parse(String(l.last_seen_at ?? ""))
    if (!Number.isFinite(seen) || seen < freshSince) { out.staleInventoryExcluded++; continue }
    inventory.push({ zip: l.zip ? String(l.zip) : null, city: l.city ? String(l.city) : null, price: positive(l.list_price), beds: positive(l.beds) })
  }
  out.freshInventory = inventory.length

  for (const seg of demand.values()) {
    if (seg.buyers.size < DEMAND_K_FLOOR) { out.suppressedSegments++; continue }
    const fits = inventory.filter((l) => (l.zip === seg.area || (l.city ?? "").toLowerCase() === seg.area) && l.price != null && l.price > seg.band.min && l.price <= seg.band.max && (bedsMin(seg.beds) === 0 || (l.beds ?? 0) >= bedsMin(seg.beds))).length
    const attribution = `${seg.buyers.size} buyers working with ${a.brand} told us, in their own words and with consent, they want ${seg.beds === "any size" ? "a home" : `a ${seg.beds} home`} ${seg.band.label} in ${seg.area}; ${fits} matching home${fits === 1 ? " is" : "s are"} actively listed (seen within ${INVENTORY_FRESH_DAYS} days) as of ${isoDay(a.now)}.`
    const problem = demandClaimProblem(attribution)
    if (problem) { notes.push(`demand segment ${seg.area} withheld: ${problem}`); continue }
    out.segments.push({
      area: seg.area, priceBand: seg.band.label, beds: seg.beds, consentedBuyers: seg.buyers.size, freshInventory: fits, undersupplied: fits < seg.buyers.size, attribution,
      claimBoundary: "Say that homes like this are in demand here, with the counts and the date. Never say a buyer has been found, never describe or identify a buyer, never quote a price for a specific home.",
    })
  }
  out.segments.sort((x, y) => (y.consentedBuyers - y.freshInventory) - (x.consentedBuyers - x.freshInventory))
  return out
}

/**
 * The tenant's Local Market Twin for its APPROVED territory (or the zips the caller names, intersected with nothing — the caller
 * is the territory's verified owner). `allowProviderRead` authorizes the shared RentCast read for this refresh; without it the
 * twin reads only what the tenant already holds. Never throws.
 */
export async function loadMarketTwin(svc: Db, input: { brokerageId: string; zips?: string[] | null; /** the approved territories' cities, resolved by the caller beside the zips (the demand gap matches a buyer's stated cities against them) */ cities?: readonly string[] | null; allowProviderRead?: boolean; brandName?: string | null }, deps: MarketTwinDeps = {}): Promise<MarketTwin> {
  const now = deps.now ?? new Date()
  const notes: string[] = []
  const blindSpots: string[] = [
    "RentCast /markets describes LISTINGS (asking prices, counts, pace) — sold medians come only from this brokerage's MLS-synced closed sales, a sample",
    "consented demand counts buyers who STATED criteria with a recorded consent basis; buyers who never said criteria are invisible here",
  ]
  const twin: MarketTwin = { brokerageId: input.brokerageId, asOf: isoDay(now), zips: [], marketGap: { monthsOfSupply: null, asOf: null, source: null, reason: "not computed" }, demandGap: { segments: [], suppressedSegments: 0, consentedBuyers: 0, staleInventoryExcluded: 0, freshInventory: 0 }, notes, blindSpots }
  try {
    if (!input.brokerageId) { notes.push("no tenant — nothing was read"); return twin }
    let zips = (input.zips ?? []).map((z) => String(z).trim()).filter((z) => /^\d{5}$/.test(z))
    let cities: string[] = []
    // The CALLER resolves the tenant's approved territories (lib/geo/tenant-markets.ts loadTenantMarkets — Settings →
    // Territories, ruling 14) and passes zips + cities; the twin never resolves them itself (integrator, wave 150: that
    // import dragged the territory module into every page that reaches the topic bank — test:proxy-graph-budget).
    cities = (input.cities ?? []).map((c) => String(c).trim()).filter(Boolean)
    if (zips.length === 0) blindSpots.push("no territory zips were given — the caller passes the tenant's approved Settings → Territories zips; the twin has no region")
    zips = [...new Set(zips)]
    if (zips.length > MAX_TWIN_ZIPS) { notes.push(`${zips.length} territory zips — the twin reads the first ${MAX_TWIN_ZIPS} (each is one shared provider read per window)`); zips = zips.slice(0, MAX_TWIN_ZIPS) }
    for (const zip of zips) twin.zips.push(await twinZip(svc, { brokerageId: input.brokerageId, zip, now, allowProviderRead: input.allowProviderRead === true }, deps, notes))
    twin.marketGap = await observedMonthsOfSupply(svc, input.brokerageId, zips, now, notes)
    twin.demandGap = await housingMatchGap(svc, { brokerageId: input.brokerageId, zips, cities, now, brand: (input.brandName ?? "").trim() || "this team" }, deps, notes, blindSpots)
  } catch (e) {
    notes.push(`loadMarketTwin threw: ${e instanceof Error ? e.message : String(e)}`)
  }
  return twin
}
