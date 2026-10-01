/**
 * lib/lead-pipeline/pooled-pull.ts — ONE PULL PER VENDOR PER CYCLE (wave 93, lane 93B)
 *
 * Owner, verbatim (2026-10-01): "can't you pull all of the active territories to add to the
 * criteria and pull all homeowners in the platform to make it one pull to keep the cost down?"
 * · "make sure our platform is setup the most effective and cost effective."
 *
 * BEFORE: the lead-scraping cron (app/api/cron/lead-scraping/route.ts) walked every ACTIVE
 * territory and, inside that loop, asked each vendor for that territory alone — BatchData once per
 * (territory × trigger), the RentCast inactive sweep once per territory, the FSBO-site actor once
 * per territory. Two brokerages that share a ZIP paid twice for the same homeowners; ten
 * territories cost ten request round-trips against BatchData's and RentCast's rate limits.
 *
 * NOW: per vendor per cycle, every ACTIVE territory the ONE pull gate admitted
 * (scrape-territories.ts::resolveActivePullGate) is merged into ONE criteria set — overlapping
 * ZIPs / counties / cities deduped — and pulled once, in limit-sized chunks; every record is then
 * FANNED BACK to every territory whose geography CONTAINS it, and the vendor charge is SPLIT per
 * territory (hence per brokerage) by records received (splitPullCost — the shares sum to the charge
 * to the cent). The chunk axes are the vendor's own limits, never the tenant count:
 *   BatchData — one request per (trigger × state × geography kind × ≤BATCHDATA_POOLED_MAX_INLIST
 *               values), paged at BATCHDATA_POOLED_MAX_TAKE. Per TRIGGER because BatchData labels a
 *               search by its first quickList (fetchMotivatedSellers) and a recorder trigger carries
 *               its own date window; per KIND because searchCriteria filters AND together (a zip list
 *               and a city list cannot be OR-ed in one request); per STATE because `query` is required.
 *   RentCast  — /listings/sale takes ONE city+state (no list form), ≤500 rows per request
 *               (RENTCAST_MAX_LISTINGS_PER_REQUEST): the pool is the set of territories naming the
 *               SAME area, swept once, its ledger row split equally (rentcast.ts meterCall).
 *   Apify     — the FSBO-site actor takes a LIST of location slugs; ≤APIFY_POOLED_LOCATIONS_PER_RUN
 *               slugs per run so maxItems stays under the per-run cap.
 *   Exa       — semantic per-query search with 10 results included per request: a multi-city query
 *               degrades relevance, so Exa is NOT pooled (published blind spot, notes §2).
 *
 * PURE CORE + injectable I/O: scripts/one-pull-guard.ts executes the planner, the containment rule,
 * the fan-out and the split with zero network, and replays the old per-territory loop as the
 * positive control.
 */
import type { BatchDataRecord, FetchMotivatedSellersOptions } from "@/lib/external/batchdata-client"
import type { NormalizedScrapedRecord } from "@/lib/lead-pipeline/raw-record-types"

/** The slice of a lead_scraping_markets row the pooled pull needs. */
export interface PoolTerritory {
  id: string
  brokerage_id: string | null
  city?: string | null
  state?: string | null
  zip_codes?: string[] | null
  counties?: string[] | null
  max_records_per_run?: number | null
}

export type PoolGeoKind = "zip" | "county" | "city"

/** One limit-sized pooled request: one state, one geography kind, ≤maxValues values. */
export interface PooledGeoChunk {
  state: string
  kind: PoolGeoKind
  values: string[]
  /** The territories whose geography this chunk carries (their record caps fund it). */
  memberIds: string[]
}

const zip5 = (z: string | null | undefined) => (z ?? "").trim().slice(0, 5)
const fold = (v: string | null | undefined) => (v ?? "").trim().toLowerCase().replace(/\s+county$/, "").replace(/\s+/g, " ")
const stateOf = (v: string | null | undefined) => (v ?? "").trim().toUpperCase()

/**
 * PURE — the ONE geography a territory is pulled by: its ZIPs when it names any (the most precise),
 * else its counties, else its city. A territory naming none (or no state) is not poolable — it is
 * returned with the reason, never guessed (the pull gate already refuses an unspecified area).
 */
function territoryGeography(t: PoolTerritory): { state: string; kind: PoolGeoKind; values: string[] } | null {
  const state = stateOf(t.state)
  if (!state) return null
  const zips = [...new Set((t.zip_codes ?? []).map(zip5).filter((z) => /^\d{5}$/.test(z)))]
  if (zips.length) return { state, kind: "zip", values: zips }
  const counties = [...new Set((t.counties ?? []).map((c) => (c ?? "").trim()).filter(Boolean))]
  if (counties.length) return { state, kind: "county", values: counties }
  const city = (t.city ?? "").trim()
  return city ? { state, kind: "city", values: [city] } : null
}

/**
 * PURE — merge every territory's geography into the fewest limit-sized chunks: grouped by
 * (state, kind), values DEDUPED across territories (case-folded; the first spelling seen is sent),
 * then cut into chunks of ≤maxValues. Returns the chunks plus the territories it could not pool.
 * @proofSeam exported so scripts/one-pull-guard.ts can execute the merge + dedupe + chunking directly
 *  (its ONE production reader is runPooledBatchDataLane in this file).
 */
export function planPooledGeography(
  territories: readonly PoolTerritory[],
  opts: { maxValues: number },
): { chunks: PooledGeoChunk[]; unpoolable: string[]; distinctValues: number; requestedValues: number } {
  const groups = new Map<string, { state: string; kind: PoolGeoKind; values: Map<string, string>; members: Map<string, Set<string>> }>()
  const unpoolable: string[] = []
  let requestedValues = 0
  for (const t of territories) {
    const g = territoryGeography(t)
    if (!g) { unpoolable.push(t.id); continue }
    const key = `${g.state}|${g.kind}`
    const grp = groups.get(key) ?? { state: g.state, kind: g.kind, values: new Map(), members: new Map() }
    for (const v of g.values) {
      requestedValues++
      const k = g.kind === "zip" ? v : fold(v)
      if (!grp.values.has(k)) grp.values.set(k, v)
      const m = grp.members.get(k) ?? new Set<string>()
      m.add(t.id)
      grp.members.set(k, m)
    }
    groups.set(key, grp)
  }
  const max = Math.max(1, Math.floor(opts.maxValues))
  const chunks: PooledGeoChunk[] = []
  let distinctValues = 0
  for (const grp of groups.values()) {
    const keys = [...grp.values.keys()].sort()
    distinctValues += keys.length
    for (let i = 0; i < keys.length; i += max) {
      const slice = keys.slice(i, i + max)
      const memberIds = new Set<string>()
      for (const k of slice) for (const id of grp.members.get(k) ?? []) memberIds.add(id)
      chunks.push({ state: grp.state, kind: grp.kind, values: slice.map((k) => grp.values.get(k) as string), memberIds: [...memberIds].sort() })
    }
  }
  return { chunks, unpoolable, distinctValues, requestedValues }
}

/** Where a pulled record sits — the fields containment reads. */
export interface RecordLocation { zip?: string | null; city?: string | null; state?: string | null; county?: string | null }

/**
 * PURE — does this territory CONTAIN the record? The SAME geography the territory was pulled by
 * (territoryGeography): a ZIP territory by ZIP (ZIP+4 folded), a county territory by county +
 * state, a city territory by city + state. A record with no usable location is contained by no one.
 * @proofSeam exported so scripts/one-pull-guard.ts can execute the containment rule directly (its
 *  production reader is fanOutByTerritory in this file).
 */
export function territoryContains(t: PoolTerritory, rec: RecordLocation): boolean {
  const g = territoryGeography(t)
  if (!g) return false
  if (g.kind === "zip") return g.values.includes(zip5(rec.zip))
  if (stateOf(rec.state) !== g.state) return false
  if (g.kind === "county") return !!fold(rec.county) && g.values.some((c) => fold(c) === fold(rec.county))
  return !!fold(rec.city) && g.values.some((c) => fold(c) === fold(rec.city))
}

/**
 * PURE — fan every pulled record back to EVERY territory that contains it (a ZIP two brokerages
 * share delivers the homeowner to both; each paid half). Returns per-territory records, the receipt
 * counts the cost split reads, and how many records no territory contained (published, not hidden).
 * @proofSeam exported so scripts/one-pull-guard.ts can execute the fan-out directly (its production
 *  readers are the two pooled lanes in this file).
 */
export function fanOutByTerritory<R>(
  records: readonly R[],
  territories: readonly PoolTerritory[],
  locate: (r: R) => RecordLocation,
  accept: (t: PoolTerritory, r: R) => boolean = () => true,
): { byTerritory: Map<string, R[]>; receipts: Map<string, number>; unattributed: number } {
  const byTerritory = new Map<string, R[]>()
  const receipts = new Map<string, number>()
  let unattributed = 0
  for (const r of records) {
    const loc = locate(r)
    let delivered = false
    for (const t of territories) {
      if (!territoryContains(t, loc) || !accept(t, r)) continue
      const list = byTerritory.get(t.id) ?? []
      list.push(r)
      byTerritory.set(t.id, list)
      receipts.set(t.id, (receipts.get(t.id) ?? 0) + 1)
      delivered = true
    }
    if (!delivered) unattributed++
  }
  return { byTerritory, receipts, unattributed }
}

/**
 * PURE — THE COST-SPLIT RULE. A vendor charge split by records received: share_i =
 * charge × receipts_i ÷ Σ receipts, computed in CENTS with the largest-remainder method so the
 * shares SUM TO THE CHARGE EXACTLY (no cent invented or lost). Zero receipts → no shares (the caller
 * books the charge unattributed — a pull nobody received is still spend, never dropped).
 */
export function splitPullCost(chargeUsd: number, receipts: ReadonlyMap<string, number>): Map<string, number> {
  const out = new Map<string, number>()
  const cents = Math.round(Math.max(0, chargeUsd) * 100)
  const entries = [...receipts.entries()].filter(([, n]) => n > 0)
  const total = entries.reduce((s, [, n]) => s + n, 0)
  if (total === 0 || entries.length === 0) return out
  const raw = entries.map(([id, n]) => ({ id, exact: (cents * n) / total }))
  const floors = raw.map((r) => ({ id: r.id, c: Math.floor(r.exact), rem: r.exact - Math.floor(r.exact) }))
  let left = cents - floors.reduce((s, f) => s + f.c, 0)
  for (const f of [...floors].sort((a, b) => b.rem - a.rem || a.id.localeCompare(b.id))) {
    if (left <= 0) break
    f.c++
    left--
  }
  for (const f of floors) out.set(f.id, f.c / 100)
  return out
}

// ─── BATCHDATA — the pooled quickList pull ─────────────────────────────────────────────

/** One territory's want for one BatchData lane this cycle. */
export interface PooledWant {
  territory: PoolTerritory
  triggers: readonly string[]
  /** lead_scraping_motivated_params.lookback_days (null = window-less). */
  lookbackDays: number | null
}

/** One territory's share of a pooled lane. */
export interface PooledShare<R> { records: R[]; costUsd: number; staleDropped: number }

/** What one pooled lane did — the cron log carries it (the proof reads the same shape). */
export interface PooledLaneLedger {
  lane: string
  vendor: string
  territories: number
  /** Billed requests issued (each page of each chunk). */
  requests: number
  chunks: number
  chargeUsd: number
  /** Σ of the per-territory shares — equals chargeUsd unless nothing was attributed. */
  allocatedUsd: number
  unattributedRecords: number
  /** Charge with no receiving territory (booked platform-side by the caller). */
  unallocatedUsd: number
  /** The per-territory loop this replaced would have issued this many requests (one per territory × trigger). */
  perTerritoryRequestsReplaced: number
}

export interface PooledBatchDataDeps {
  /** One BatchData v1 Property Search (the lead lanes' own fetchMotivatedSellers). */
  search: (opts: FetchMotivatedSellersOptions) => Promise<{ records: BatchDataRecord[]; cost: number }>
  /** The trigger's request-side date window (batchdata-client.ts::dateWindowCriteria). */
  dateWindow: (trigger: string, window: { lookbackDays?: number | null }) => Record<string, unknown>
  /** The client-side status-date window (withinListingStatusWindow) — expired/canceled/failed only. */
  statusWindow: (rec: BatchDataRecord, trigger: string, window: { lookbackDays?: number | null }) => boolean
  geographyCriteria: (kind: PoolGeoKind, values: readonly string[]) => Record<string, unknown>
  maxTake: number
  maxInList: number
  /** Records each territory funds per trigger when it names no max_records_per_run (the old pull's take). */
  defaultRecordsPerTerritory?: number
}

/** I/O defaults — the ONE BatchData client. */
export async function productionPooledBatchDataDeps(): Promise<PooledBatchDataDeps> {
  const bd = await import("@/lib/external/batchdata-client")
  return {
    search: (opts) => bd.fetchMotivatedSellers(opts),
    dateWindow: (t, w) => bd.dateWindowCriteria(t, w),
    statusWindow: (r, t, w) => bd.withinListingStatusWindow(r, t, w),
    geographyCriteria: (k, v) => bd.pooledGeographyCriteria(k, v),
    maxTake: bd.BATCHDATA_POOLED_MAX_TAKE,
    maxInList: bd.BATCHDATA_POOLED_MAX_INLIST,
  }
}

/**
 * THE POOLED BATCHDATA LANE. Every want is grouped into pools keyed by (trigger, request-side
 * window) — territories wanting the same trigger under the same window share ONE pull; each pool's
 * merged geography is chunked (planPooledGeography) and each chunk is paged until the chunk's
 * funded cap (Σ its members' per-run caps) or the last page. Records fan back by containment (plus
 * each member's own client-side status window for listing-status triggers) and the charge splits by
 * receipts. Never throws: a failed chunk is reported in `errors` and costs nothing.
 */
export async function runPooledBatchDataLane(
  lane: string,
  wants: readonly PooledWant[],
  deps: PooledBatchDataDeps,
): Promise<{ byTerritory: Map<string, PooledShare<BatchDataRecord>>; ledger: PooledLaneLedger; errors: string[] }> {
  const byTerritory = new Map<string, PooledShare<BatchDataRecord>>()
  const errors: string[] = []
  const ledger: PooledLaneLedger = {
    lane, vendor: "batchdata", territories: new Set(wants.map((w) => w.territory.id)).size, requests: 0, chunks: 0,
    chargeUsd: 0, allocatedUsd: 0, unattributedRecords: 0, unallocatedUsd: 0,
    perTerritoryRequestsReplaced: wants.reduce((s, w) => s + w.triggers.length, 0),
  }
  const perTerritoryCap = (t: PoolTerritory) =>
    typeof t.max_records_per_run === "number" && t.max_records_per_run > 0 ? Math.floor(t.max_records_per_run) : (deps.defaultRecordsPerTerritory ?? 100)

  // Pools: (trigger, window) → members.
  const pools = new Map<string, { trigger: string; lookbackDays: number | null; criteria: Record<string, unknown>; members: PooledWant[] }>()
  for (const w of wants) {
    for (const trigger of w.triggers) {
      const criteria = deps.dateWindow(trigger, { lookbackDays: w.lookbackDays })
      const windowed = Object.keys(criteria).length > 0
      const key = `${trigger}|${windowed ? JSON.stringify(criteria) : "-"}`
      const pool = pools.get(key) ?? { trigger, lookbackDays: windowed ? w.lookbackDays : null, criteria, members: [] }
      pool.members.push(w)
      pools.set(key, pool)
    }
  }

  for (const pool of pools.values()) {
    const territories = pool.members.map((m) => m.territory)
    const plan = planPooledGeography(territories, { maxValues: deps.maxInList })
    for (const id of plan.unpoolable) errors.push(`${lane}: territory ${id} names no state + ZIP/county/city — not pooled (the gate refuses an unspecified area too)`)
    for (const chunk of plan.chunks) {
      ledger.chunks++
      const members = territories.filter((t) => chunk.memberIds.includes(t.id))
      const cap = members.reduce((s, t) => s + perTerritoryCap(t), 0)
      const pulled: BatchDataRecord[] = []
      let chunkCost = 0
      try {
        for (let skip = 0; pulled.length < cap; skip += deps.maxTake) {
          const take = Math.min(deps.maxTake, cap - pulled.length)
          const r = await deps.search({
            state: chunk.state,
            motivationTypes: [pool.trigger],
            searchCriteria: { ...pool.criteria, ...deps.geographyCriteria(chunk.kind, chunk.values) },
            limit: take,
            skip,
          })
          ledger.requests++
          chunkCost += r.cost ?? 0
          pulled.push(...r.records)
          if (r.records.length < take) break
        }
      } catch (e) {
        errors.push(`${lane}: pooled ${pool.trigger} pull for ${chunk.state} ${chunk.kind}×${chunk.values.length} failed — ${e instanceof Error ? e.message : String(e)}`)
      }
      ledger.chargeUsd += chunkCost
      const memberWindow = new Map(pool.members.map((m) => [m.territory.id, m.lookbackDays]))
      let staleByTerritory = new Map<string, number>()
      const fan = fanOutByTerritory(
        pulled,
        members,
        (r) => ({ zip: r.propertyZip ?? null, city: r.propertyCity ?? null, state: r.propertyState ?? null, county: r.propertyCounty ?? null }),
        (t, r) => {
          const ok = deps.statusWindow(r, pool.trigger, { lookbackDays: memberWindow.get(t.id) ?? null })
          if (!ok) staleByTerritory.set(t.id, (staleByTerritory.get(t.id) ?? 0) + 1)
          return ok
        },
      )
      ledger.unattributedRecords += fan.unattributed
      // A record every member's window refused was still billed: it is allocated by RECEIPT-OR-STALE
      // so the charge is never orphaned by a client-side window (the cost is the pull's).
      const billedTo = new Map(fan.receipts)
      for (const [id, n] of staleByTerritory) billedTo.set(id, (billedTo.get(id) ?? 0) + n)
      const shares = splitPullCost(chunkCost, billedTo)
      const allocated = [...shares.values()].reduce((s, v) => s + v, 0)
      ledger.allocatedUsd += allocated
      if (chunkCost > 0 && shares.size === 0) ledger.unallocatedUsd += chunkCost
      for (const t of members) {
        const prev = byTerritory.get(t.id) ?? { records: [], costUsd: 0, staleDropped: 0 }
        prev.records.push(...(fan.byTerritory.get(t.id) ?? []))
        prev.costUsd = Math.round((prev.costUsd + (shares.get(t.id) ?? 0)) * 100) / 100
        prev.staleDropped += staleByTerritory.get(t.id) ?? 0
        byTerritory.set(t.id, prev)
      }
      staleByTerritory = new Map()
    }
  }
  ledger.chargeUsd = Math.round(ledger.chargeUsd * 100) / 100
  ledger.allocatedUsd = Math.round(ledger.allocatedUsd * 100) / 100
  ledger.unallocatedUsd = Math.round(ledger.unallocatedUsd * 100) / 100
  return { byTerritory, ledger, errors }
}

// ─── RENTCAST — identical-area sweeps, swept once ────────────────────────────────────────

/** PURE — group territories by the ONE area RentCast can sweep (city + state; RentCast has no list
 *  form), keyed with any per-territory parameters that change the request. */
export function groupIdenticalAreas<T extends PoolTerritory>(
  territories: readonly T[],
  extraKey: (t: T) => string = () => "",
): Array<{ key: string; city: string; state: string; members: T[] }> {
  const groups = new Map<string, { key: string; city: string; state: string; members: T[] }>()
  for (const t of territories) {
    const city = (t.city ?? "").trim(), state = stateOf(t.state)
    if (!city || !state) continue
    const key = `${fold(city)}|${state}|${extraKey(t)}`
    const g = groups.get(key) ?? { key, city, state, members: [] }
    g.members.push(t)
    groups.set(key, g)
  }
  return [...groups.values()]
}

// ─── APIFY — the FSBO-site actor takes a list of locations ───────────────────────────────

/** Locations per actor run: each location funds 100 items and the run's maxItems stays ≤ 1,000. */
export const APIFY_POOLED_LOCATIONS_PER_RUN = 10

export interface PooledFsboDeps {
  run: (locations: Array<{ city: string; state: string; stateName?: string | null }>) => Promise<{ records: NormalizedScrapedRecord[]; cost: number }>
}

/**
 * THE POOLED FSBO-SITE LANE: identical (city, state) territories collapse to one slug, the slugs
 * ride ≤APIFY_POOLED_LOCATIONS_PER_RUN per actor run, and each listing fans back by its own
 * city + state (normalizeFsboSiteListing carries the listing's location) with the run's cost split
 * by receipts.
 */
export async function runPooledFsboLane(
  territories: readonly PoolTerritory[],
  deps: PooledFsboDeps,
  stateName: (code: string) => string | null,
): Promise<{ byTerritory: Map<string, PooledShare<NormalizedScrapedRecord>>; ledger: PooledLaneLedger; errors: string[] }> {
  const byTerritory = new Map<string, PooledShare<NormalizedScrapedRecord>>()
  const errors: string[] = []
  const cityTerritories = territories.map((t) => ({ ...t, zip_codes: null, counties: null }))
  const areas = groupIdenticalAreas(cityTerritories)
  const ledger: PooledLaneLedger = {
    lane: "fsbo_site_listing", vendor: "apify", territories: territories.length, requests: 0, chunks: 0,
    chargeUsd: 0, allocatedUsd: 0, unattributedRecords: 0, unallocatedUsd: 0, perTerritoryRequestsReplaced: territories.length,
  }
  for (let i = 0; i < areas.length; i += APIFY_POOLED_LOCATIONS_PER_RUN) {
    const slice = areas.slice(i, i + APIFY_POOLED_LOCATIONS_PER_RUN)
    ledger.chunks++
    let records: NormalizedScrapedRecord[] = []
    let cost = 0
    try {
      const r = await deps.run(slice.map((a) => ({ city: a.city, state: a.state, stateName: stateName(a.state) })))
      ledger.requests++
      records = r.records
      cost = r.cost ?? 0
    } catch (e) {
      errors.push(`fsbo_site_listing: pooled run failed — ${e instanceof Error ? e.message : String(e)}`)
    }
    ledger.chargeUsd += cost
    const members = slice.flatMap((a) => a.members)
    const fan = fanOutByTerritory(records, members, (r) => ({ city: r.city ?? null, state: r.state ?? null, zip: r.zip ?? null }))
    ledger.unattributedRecords += fan.unattributed
    const shares = splitPullCost(cost, fan.receipts)
    ledger.allocatedUsd += [...shares.values()].reduce((s, v) => s + v, 0)
    if (cost > 0 && shares.size === 0) ledger.unallocatedUsd += cost
    for (const t of members) {
      byTerritory.set(t.id, { records: fan.byTerritory.get(t.id) ?? [], costUsd: shares.get(t.id) ?? 0, staleDropped: 0 })
    }
  }
  ledger.chargeUsd = Math.round(ledger.chargeUsd * 100) / 100
  ledger.allocatedUsd = Math.round(ledger.allocatedUsd * 100) / 100
  ledger.unallocatedUsd = Math.round(ledger.unallocatedUsd * 100) / 100
  return { byTerritory, ledger, errors }
}
