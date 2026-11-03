// lib/geo/tenant-markets.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE TENANT'S MARKETS, DERIVED FROM THE TERRITORIES THEY ENTERED IN SETTINGS (wave 149, lane 149E — owner ruling 14).
//
// Owner, 2026-11-03: "Markets derive from the territories the tenant entered in their settings. Report where the market
// registry actually lives; the market reports already exist in the code — do not rebuild."
//
// WHERE THINGS LIVE (audited at 08712fef — this module is a READER over them, never a second registry):
//   · THE MARKET REGISTRY is code, not a table: lib/external/socrata-market-registry.ts `MARKETS` (keyed "<ST>:<city>",
//     each market's public-record datasets) + `MARKET_DATASET_CANDIDATES`; `classifyMarketCoverage` is the per-territory
//     verdict (covered | unregistered | unavailable | unboundable). C19 verification of each dataset is
//     lib/intent/dataset-verification.ts (the dated code contract) overlaid by the m918 observation log
//     `market_dataset_verifications` (platform-wide, no tenant column).
//   · THE TENANT'S TERRITORIES are the rows a person typed in Settings:
//       - `subscriber_service_areas`  Settings → Territories (app/actions/settings/territories.ts) — the per-zip
//                                     "where do we serve" roster (city/state per row; brokerage / team / agent grain).
//       - `lead_scraping_markets`     Settings → lead scraping (app/actions/lead-scraping-config.ts) — city/state/zips/
//                                     counties; every create/update also syncs subscriber_service_areas.
//     Both are SETTINGS territories. They are unioned here (a scraping market created before the sync existed has no
//     service-area row) and deduped case-insensitively on (state, city), because both columns are free text.
//   · NOT TERRITORIES — `farm_territories` (a prospecting farm) and the brokerage's office address. They are reported as
//     a FALLBACK HINT, labelled with their basis, and never counted as a market the tenant entered. A tenant with no
//     settings territory is told so ("add one in Settings → Territories"), which is the truth.
//
// CONSUMERS: lib/geo/search-visibility.ts (C31 — the markets the visibility reading is about), the SEO / GEO page's
// default market (app/dashboard/marketing/seo/page.tsx), and lib/market-reports/research.ts resolveReportTerritory
// (a report's territory now prefers a settings territory over a farm and the office address).
//
// A refused read is a published blind spot and fails closed: it is never rendered as "no territories".

import { classifyMarketCoverage, type MarketCoverageStatus } from "@/lib/external/socrata-market-registry"
import type { DatasetVerificationStatus } from "@/lib/intent/dataset-verification"

type Db = { from: (table: string) => any }

/** Where a market came from. Only the first two are settings territories. */
export type TerritoryBasis = "settings_territory" | "scraping_market" | "farm_territory" | "brokerage_address"
const SETTINGS_TERRITORY_BASES: readonly TerritoryBasis[] = Object.freeze(["settings_territory", "scraping_market"])

export interface ServiceAreaRow { city: string | null; state: string | null; zip_code: string | null; is_primary?: boolean | null; active?: boolean | null }
export interface ScrapingMarketRow { city: string | null; state: string | null; zip_codes: string[] | null; counties?: string[] | null; is_active?: boolean | null }
export interface FarmRow { name?: string | null; city: string | null; state: string | null; zip_codes: string[] | null; is_active?: boolean | null }
export interface BrokerageAddressRow { city: string | null; state: string | null; zip?: string | null }

export interface DatasetStatusLike { datasetKey: string; status: DatasetVerificationStatus; reasons: string[] }

export interface TenantMarket {
  /** "<ST>:<City>" exactly as the registry's classifier prints it. */
  market: string
  state: string
  city: string
  zips: string[]
  counties: string[]
  primary: boolean
  bases: TerritoryBasis[]
  /** The registry's verdict for this market (lib/external/socrata-market-registry.ts classifyMarketCoverage). */
  registry: {
    status: MarketCoverageStatus
    queryableDatasets: Array<{ datasetKey: string; label: string; kind: string; c19: DatasetVerificationStatus | "not_read" }>
    reasons: string[]
  }
}

export interface TenantMarkets {
  /** Markets from SETTINGS territories only — the ruling-14 answer. */
  markets: TenantMarket[]
  /** Where the markets came from: "settings" when any settings territory exists, else the fallback's basis, else "none". */
  basis: "settings" | "farm_territory" | "brokerage_address" | "none"
  /** Used only when no settings territory exists, labelled — never counted as a market the tenant entered. */
  fallbackHint: { state: string | null; city: string | null; zip: string | null; basis: TerritoryBasis } | null
  /** Zip-only territory rows (no city/state typed) — counted, never silently dropped. */
  zipOnlyTerritories: string[]
  blindSpots: string[]
}

const clean = (v: unknown): string => String(v ?? "").trim()
const ZIP = /^\d{5}$/

/**
 * PURE. Territory rows → the tenant's markets, each with the registry's verdict.
 * Settings territories are the ONLY source of markets; a farm or the office address is a labelled fallback hint.
 * The guard drives it through loadTenantMarkets over a scripted client.
 */
function deriveTenantMarkets(input: {
  serviceAreas: ReadonlyArray<ServiceAreaRow>
  scrapingMarkets: ReadonlyArray<ScrapingMarketRow>
  farms?: ReadonlyArray<FarmRow>
  brokerage?: BrokerageAddressRow | null
  datasetStatuses?: ReadonlyArray<DatasetStatusLike> | null
  blindSpots?: string[]
}): TenantMarkets {
  const blindSpots = [...(input.blindSpots ?? [])]
  const byKey = new Map<string, { state: string; city: string; zips: Set<string>; counties: Set<string>; primary: boolean; bases: Set<TerritoryBasis> }>()
  const zipOnly = new Set<string>()
  const touch = (state: string, city: string, basis: TerritoryBasis) => {
    const key = `${state.toUpperCase()}:${city.toLowerCase()}`
    let e = byKey.get(key)
    if (!e) { e = { state: state.toUpperCase(), city, zips: new Set(), counties: new Set(), primary: false, bases: new Set() }; byKey.set(key, e) }
    e.bases.add(basis)
    return e
  }

  for (const r of input.serviceAreas) {
    if (r.active === false) continue
    const state = clean(r.state), city = clean(r.city), zip = clean(r.zip_code)
    if (!state || !city) { if (ZIP.test(zip)) zipOnly.add(zip); continue }
    const e = touch(state, city, "settings_territory")
    if (ZIP.test(zip)) e.zips.add(zip)
    if (r.is_primary) e.primary = true
  }
  for (const m of input.scrapingMarkets) {
    if (m.is_active === false) continue
    const state = clean(m.state), city = clean(m.city)
    const zips = (m.zip_codes ?? []).map(clean).filter((z) => ZIP.test(z))
    if (!state || !city) { for (const z of zips) zipOnly.add(z); continue }
    const e = touch(state, city, "scraping_market")
    for (const z of zips) e.zips.add(z)
    for (const c of m.counties ?? []) if (clean(c)) e.counties.add(clean(c))
  }

  const statusByKey = new Map((input.datasetStatuses ?? []).map((s) => [s.datasetKey, s]))
  const markets: TenantMarket[] = [...byKey.values()].map((e) => {
    const cov = classifyMarketCoverage({ state: e.state, city: e.city })
    return {
      market: cov.market, state: e.state, city: e.city,
      zips: [...e.zips].sort(), counties: [...e.counties].sort(), primary: e.primary,
      bases: SETTINGS_TERRITORY_BASES.filter((b) => e.bases.has(b)),
      registry: {
        status: cov.status,
        queryableDatasets: cov.queryable.map((d) => {
          const datasetKey = `${d.host}/${d.datasetId}`
          return { datasetKey, label: d.label, kind: d.kind, c19: input.datasetStatuses ? (statusByKey.get(datasetKey)?.status ?? "unverified") : "not_read" as const }
        }),
        reasons: cov.reasons,
      },
    }
  }).sort((a, b) => Number(b.primary) - Number(a.primary) || b.zips.length - a.zips.length || a.market.toLowerCase().localeCompare(b.market.toLowerCase()))

  if (zipOnly.size > 0) blindSpots.push(`${zipOnly.size} territory zip(s) carry no city/state, so the registry cannot place them in a market: ${[...zipOnly].sort().slice(0, 10).join(", ")}`)

  if (markets.length > 0) return { markets, basis: "settings", fallbackHint: null, zipOnlyTerritories: [...zipOnly].sort(), blindSpots }

  blindSpots.push("no settings territory: add one in Settings → Territories so the OS knows which markets are yours")
  const farm = (input.farms ?? []).find((f) => f.is_active !== false && (clean(f.city) && clean(f.state) || (f.zip_codes ?? []).some((z) => ZIP.test(clean(z)))))
  if (farm) {
    return { markets, basis: "farm_territory", zipOnlyTerritories: [...zipOnly].sort(), blindSpots,
      fallbackHint: { state: clean(farm.state) || null, city: clean(farm.city) || null, zip: (farm.zip_codes ?? []).map(clean).find((z) => ZIP.test(z)) ?? null, basis: "farm_territory" } }
  }
  const b = input.brokerage ?? null
  if (b && (clean(b.city) && clean(b.state) || ZIP.test(clean(b.zip)))) {
    return { markets, basis: "brokerage_address", zipOnlyTerritories: [...zipOnly].sort(), blindSpots,
      fallbackHint: { state: clean(b.state) || null, city: clean(b.city) || null, zip: ZIP.test(clean(b.zip)) ? clean(b.zip) : null, basis: "brokerage_address" } }
  }
  return { markets, basis: "none", fallbackHint: null, zipOnlyTerritories: [...zipOnly].sort(), blindSpots }
}

/** "City, ST" for the primary market, else the labelled fallback, else undefined. */
export function primaryMarketLabel(t: TenantMarkets): string | undefined {
  const m = t.markets[0]
  if (m) return `${m.city}, ${m.state}`
  const h = t.fallbackHint
  if (h?.city && h.state) return `${h.city}, ${h.state}`
  return undefined
}

/**
 * The loader. Tenant-pinned reads (the caller passes the SESSION tenant); a refused read is a blind spot, never an empty
 * list that reads as "no territories". `withVerifications` overlays C19 statuses (platform-wide dataset facts).
 */
export async function loadTenantMarkets(db: Db, brokerageId: string, opts: { withVerifications?: boolean; now?: Date } = {}): Promise<TenantMarkets> {
  const blindSpots: string[] = []
  if (!brokerageId) return deriveTenantMarkets({ serviceAreas: [], scrapingMarkets: [], blindSpots: ["no tenant — nothing was read"] })
  const read = async <T,>(what: string, q: PromiseLike<{ data: unknown; error: { message?: string } | null }>): Promise<T[]> => {
    const { data, error } = await q
    if (error) { blindSpots.push(`${what} read refused (${error.message ?? "unknown"}) — markets from it are a blind spot`); return [] }
    return (data ?? []) as T[]
  }
  const [serviceAreas, scrapingMarkets, farms, brokerageRows] = await Promise.all([
    read<ServiceAreaRow>("subscriber_service_areas", db.from("subscriber_service_areas").select("city, state, zip_code, is_primary, active").eq("brokerage_id", brokerageId).eq("active", true).limit(500)),
    read<ScrapingMarketRow>("lead_scraping_markets", db.from("lead_scraping_markets").select("city, state, zip_codes, counties, is_active").eq("brokerage_id", brokerageId).eq("is_active", true).limit(200)),
    read<FarmRow>("farm_territories", db.from("farm_territories").select("name, city, state, zip_codes, is_active").eq("brokerage_id", brokerageId).eq("is_active", true).limit(20)),
    read<BrokerageAddressRow>("brokerages", db.from("brokerages").select("city, state, zip").eq("id", brokerageId).limit(1)),
  ])
  let datasetStatuses: DatasetStatusLike[] | null = null
  if (opts.withVerifications) {
    const { listMarketDatasetVerifications } = await import("@/lib/intent/dataset-verification")
    const v = await listMarketDatasetVerifications(db as never, { now: opts.now })
    if (v.error) blindSpots.push(`C19 observation log not read (${v.error}) — dataset statuses are the dated code contract only`)
    datasetStatuses = v.verifications.map((x) => ({ datasetKey: x.datasetKey, status: x.status, reasons: x.reasons }))
  }
  return deriveTenantMarkets({ serviceAreas, scrapingMarkets, farms, brokerage: brokerageRows[0] ?? null, datasetStatuses, blindSpots })
}
