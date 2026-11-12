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
import { paidPullApproval, type StoredPlanRow, type PlatformProviderDoor } from "@/lib/lead-pipeline/source-discovery-planner"
import { providerTenancy } from "@/lib/providers/tenancy-matrix"
import { decideSpendBackpressure } from "@/lib/vendor-governance/budget-eval"
import { splitPullCost } from "@/lib/vendor-governance/budget-eval"

/** The slice of a lead_scraping_markets row the pooled pull needs. */
export interface PoolTerritory {
  id: string
  brokerage_id: string | null
  city?: string | null
  state?: string | null
  zip_codes?: string[] | null
  counties?: string[] | null
  max_records_per_run?: number | null
  /** Wave 150 (lane 150HIAB): the territory's own monthly scrape budget (the cron passes the market row whole). */
  spend_this_month?: number | null
  monthly_budget_usd?: number | null
}

export type PoolGeoKind = "zip" | "county" | "city"

// ─── THE PLATFORM PROVIDER DOOR FACTS (wave 151, lane 151C) ──────────────────────────────────────────────────────────
//
// The IF / THEN source door (source-discovery-planner.ts resolveSourceDoor) is PURE: it never reads an environment value.
// This is the ONE place the platform's own connection facts are established for the acquisition lanes — a presence check
// BY NAME (never a value, never logged), the activation state the route table records (lib/ai-isa/property-lookup-rail.ts
// PROVIDER_ACTIVATION, R9), and the territory's monthly budget. The cron and the pooled lane both read it here.

/** The monthly scrape budget a territory runs on when its row names none — the SAME number the cron's STEP 3 gate and its
 *  pooled `live` filter apply as the literal `monthly_budget_usd ?? 100` (scripts/one-pull-guard.ts:241 pins that literal;
 *  scripts/acquisition-door-guard.ts holds this constant equal to it). */
const DEFAULT_TERRITORY_MONTHLY_BUDGET_USD = 100

/**
 * The credential NAMES each acquisition vendor's transport reads. The scraper fleet shares one tenancy row
 * (lib/providers/tenancy-matrix.ts "scrapers" — Apify / ZenRows / Zyte), so the per-vendor split is stated here and the
 * proof holds every name ⊆ that row's envVars; the others read their own tenancy rows. Names only — never values.
 */
const SCRAPER_FLEET_CREDENTIALS: Readonly<Record<"apify" | "zenrows" | "zyte", readonly string[]>> = Object.freeze({
  apify: ["APIFY_API_TOKEN"], zenrows: ["ZENROWS_API_KEY"], zyte: ["ZYTE_API_KEY"],
})

/** PURE — the env NAMES the platform's connection for `vendor` is configured by (the one registry: tenancy-matrix).
 *  @proofSeam scripts/acquisition-door-guard.ts holds every scraper name ⊆ the tenancy row; the product reader is
 *  platformProviderDoorFacts below. */
function platformCredentialNames(vendor: string): readonly string[] {
  const v = vendor.trim().toLowerCase()
  if (v in SCRAPER_FLEET_CREDENTIALS) return SCRAPER_FLEET_CREDENTIALS[v as keyof typeof SCRAPER_FLEET_CREDENTIALS]
  return providerTenancy(v)?.envVars ?? []
}

/**
 * The platform's connection facts for ONE acquisition vendor — configured by NAME presence, activation from the route
 * table (dynamic import: the rail is heavy and this module is reached by the vendor clients), budget left for the caller
 * to attach per territory (withTerritoryBudget). `env` is injectable so the proof never touches the real environment.
 */
export async function platformProviderDoorFacts(
  vendor: string,
  opts: { env?: Record<string, string | undefined>; activation?: Partial<Record<string, { state: PlatformProviderDoor["activation"]; survivorDoors?: PlatformProviderDoor["survivorDoors"] }>> } = {},
): Promise<PlatformProviderDoor> {
  const v = vendor.trim().toLowerCase()
  const names = platformCredentialNames(v)
  const env = opts.env ?? process.env
  const configured = names.length > 0 && names.some((n) => typeof env[n] === "string" && env[n]!.trim().length > 0)
  let activation: PlatformProviderDoor["activation"] = "unknown"
  let survivorDoors: PlatformProviderDoor["survivorDoors"] = null
  const stated = opts.activation?.[v]
  if (stated) { activation = stated.state; survivorDoors = stated.survivorDoors ?? null }
  else {
    try {
      const rail = await import("@/lib/ai-isa/property-lookup-rail")
      const a = (rail.PROVIDER_ACTIVATION as Record<string, { state: PlatformProviderDoor["activation"]; survivorDoors?: PlatformProviderDoor["survivorDoors"] }>)[v]
      if (a) { activation = a.state; survivorDoors = a.survivorDoors ?? null }
    } catch { /* the rail could not load — activation stays unknown; the door still needs a named credential and a budget */ }
    if (activation === "unknown") {
      // Not in PROVIDER_ACTIVATION: the platform-metered research / scraper lanes (tenancy-matrix) are live platform lanes.
      const tenancy = providerTenancy(v in SCRAPER_FLEET_CREDENTIALS ? "scrapers" : v)
      if (tenancy?.models.includes("platform_metered")) activation = v in SCRAPER_FLEET_CREDENTIALS ? "scraper_fleet" : "active"
    }
  }
  return { vendor: v, configured, credentialNames: names, activation, survivorDoors, monthlyBudgetUsd: null, remainingBudgetUsd: null }
}

/** PURE — the door facts with THIS territory's monthly budget attached (the cron's STEP 3 default when the row names none). */
export function withTerritoryBudget(door: PlatformProviderDoor | null, territory: Pick<PoolTerritory, "monthly_budget_usd" | "spend_this_month"> | null): PlatformProviderDoor | null {
  if (!door) return null
  if (!territory) return { ...door, monthlyBudgetUsd: null, remainingBudgetUsd: null }
  const monthly = typeof territory.monthly_budget_usd === "number" ? territory.monthly_budget_usd : DEFAULT_TERRITORY_MONTHLY_BUDGET_USD
  const remaining = Math.round((monthly - (territory.spend_this_month ?? 0)) * 100) / 100
  return { ...door, monthlyBudgetUsd: monthly, remainingBudgetUsd: remaining }
}

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

// splitPullCost — THE cost-split rule — lives in lib/vendor-governance/budget-eval.ts (integrator move, wave 150); re-exported here for its importers.
export { splitPullCost } from "@/lib/vendor-governance/budget-eval"

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
  /** Wave 150 (lane 150EFG, directive 150E): territories whose tenant has NO approved acquisition plan for this lane —
   *  dropped BEFORE the pull, so they are never bought for ("never a paid call without approval"). */
  unapprovedTerritories?: number
  /** Wave 150 (lane 150HIAB, directive 150AB): approved territories whose DOLLAR ceiling (approved line / territory
   *  budget) cut their funded records this cycle, and those deferred entirely (spent, unreadable ledger, failing provider,
   *  no price). Each one was escalated to the finance manager the same cycle (decideSpendBackpressure.escalate). */
  throttledTerritories?: number
  deferredTerritories?: number
  escalations?: number
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
  /**
   * THE APPROVAL GATE (wave 150, lane 150EFG — directive 150E, owner rule 7 "no autonomous purchases"). Asked once per
   * want BEFORE any request is issued: may this tenant's share of a `lane` pull be bought? Production answers from the
   * tenant's APPROVED acquisition plans (source-discovery-planner.ts paidPullApproval over acquisition_plans, m962); an
   * unreadable store refuses every want. REQUIRED — a deps object without it does not type-check, so no caller forgets it.
   * Wave 151 (lane 151C): the lane also hands the TERRITORY, so production can open the IF / THEN door with the territory's
   * monthly budget as the ceiling (approved plan OR a configured, licensed platform provider within budget — never an
   * unconfigured one). A fixture that ignores the third argument is unchanged.
   */
  approval: (brokerageId: string | null, lane: string, territory?: PoolTerritory) => { allowed: true; maxSpendUsd?: number | null; approvedAt?: string | null } | { allowed: false; reason: string }
  /**
   * SPEND BACKPRESSURE (wave 150, lane 150HIAB — directive 150AB). When the approval carries its ceiling
   * (`maxSpendUsd`, a number or null) AND `unitUsd` is set, every approved want is sized in DOLLARS by
   * decideSpendBackpressure before any request: the approved line's ceiling minus what is already booked against it
   * (`spentSinceApproval`; absent or null = unreadable → deferred), and the territory's monthly budget. A deps object
   * without `unitUsd` keeps the record cap alone (the proofs' fixtures) — production always sets both.
   */
  unitUsd?: number
  spentSinceApproval?: (brokerageId: string, lane: string, sinceIso: string | null) => number | null
  /** Wave 151 (lane 151F, wired by the integrator; per-tenant reading by lane 151L): the owner's PLATFORM acquisition cap remaining
   *  this cycle for THIS tenant's platform-paid want (lib/vendor-governance/platform-acquisition-caps.ts platformCapRemainingFromLedger
   *  over caps + ledger rows read ONCE per cycle — the monthly cap and the per-tenant cap both bind). undefined = not supplied
   *  (a tenant-owned connection's call, the legacy fixtures) → not consulted; null = caps not configured / ledger unreadable → stop before spend. */
  platformCapRemainingUsd?: (brokerageId: string | null) => number | null | undefined
  providerFailing?: boolean
  /** The same-cycle escalation to a manager (production: publishManagerSignal → finance_manager). Never throws. */
  escalate?: (e: { brokerageId: string; territoryId: string; lane: string; action: string; reason: string }) => Promise<void> | void
}

/** I/O defaults — the ONE BatchData client. */
export async function productionPooledBatchDataDeps(): Promise<PooledBatchDataDeps> {
  const bd = await import("@/lib/external/batchdata-client")
  // The tenants' approved acquisition plans, read ONCE per cycle (service client — the cron is platform-side; every
  // decision below is per tenant). A refused read is `null` and paidPullApproval refuses every want (fail closed).
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { data: planRows, error: planErr } = await createServiceClient()
    .from("acquisition_plans")
    .select("id, brokerage_id, status, valid_until, lines")
    .eq("status", "approved")
  if (planErr) console.error("[pooled-pull] acquisition_plans read refused — every paid pooled want is refused this cycle:", planErr.message)
  const plans: StoredPlanRow[] | null = planErr ? null : ((planRows ?? []) as StoredPlanRow[])
  // Wave 150 (lane 150HIAB): what each approval has already bought — the platform ledger rows the pooled persistence
  // books per (brokerage, source) through source-cost-ledger (usage_type = the lane key), read ONCE per cycle from the
  // earliest approval. A refused read is `null` → every dollar-sized want is deferred and escalated (fail closed).
  const approvedAts = (plans ?? []).flatMap((p) => (Array.isArray(p.lines) ? (p.lines as Array<{ approvedAt?: string | null }>) : []).map((l) => l?.approvedAt ?? null)).filter((a): a is string => !!a).sort()
  let spendRows: Array<{ brokerage_id: string | null; usage_type: string | null; total_cost: number | string | null; created_at: string }> | null = []
  if (approvedAts.length > 0) {
    const { data: rows, error: spendErr } = await createServiceClient()
      .from("vendor_usage_tracking")
      .select("brokerage_id, usage_type, total_cost, created_at")
      .in("usage_type", ["batchdata_motivated", "batchdata_cash_buyer", "expired_listing"])
      .gte("created_at", approvedAts[0])
    if (spendErr) console.error("[pooled-pull] vendor_usage_tracking read refused — dollar-sized wants are deferred this cycle:", spendErr.message)
    spendRows = spendErr ? null : ((rows ?? []) as typeof spendRows)
  }
  const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
  // Wave 151 (lane 151C): the platform's own BatchData connection facts, established ONCE per cycle by NAME — the door's
  // ELSE-IF when no plan line names the lane (R9: a dormant survivor's live doors stay open until the owner closes them).
  const platformDoor = await platformProviderDoorFacts("batchdata")
  // Wave 151 (lane 151F; the per-tenant reading built by lane 151L): the owner's platform acquisition caps and the month's
  // acquisition ledger rows are read ONCE per cycle, and every want is judged PER TENANT by the ONE pure composition
  // (platformCapRemainingFromLedger: the platform month total AND this tenant's month share against monthly / per-tenant /
  // per-pull caps). null caps or an unreadable ledger → the backpressure stops before spend; nothing is assumed zero.
  const { loadPlatformAcquisitionCaps, loadPlatformAcquisitionLedgerRows, platformCapRemainingFromLedger } = await import("@/lib/vendor-governance/platform-acquisition-caps")
  const capsRead = await loadPlatformAcquisitionCaps(createServiceClient() as never).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }))
  if (!capsRead.ok) console.error("[pooled-pull] platform acquisition caps unreadable — platform-paid wants stop before spend:", capsRead.error)
  const ledgerRead = await loadPlatformAcquisitionLedgerRows(createServiceClient() as never, new Date()).catch((e: unknown) => ({ rows: null, error: e instanceof Error ? e.message : String(e) }))
  if (ledgerRead.rows === null) console.error("[pooled-pull] platform acquisition ledger unreadable — platform-paid wants stop before spend:", ledgerRead.error)
  const platformCaps = capsRead.ok ? capsRead.caps : null
  return {
    approval: (brokerageId, lane, territory) => paidPullApproval(plans, { brokerageId, source: lane }, new Date(), { platform: withTerritoryBudget(platformDoor, territory ?? null) }),
    platformCapRemainingUsd: (brokerageId) => platformCapRemainingFromLedger(platformCaps, ledgerRead.rows, brokerageId).remainingUsd,
    unitUsd: bd.BATCHDATA_PROPERTY_SEARCH_RECORD_COST_USD,
    spentSinceApproval: (brokerageId, lane, sinceIso) => spendRows === null ? null
      : Math.round(spendRows.filter((r) => r.brokerage_id === brokerageId && r.usage_type === lane && (!sinceIso || r.created_at >= sinceIso))
        .reduce((s, r) => s + (Number(r.total_cost) || 0), 0) * 100) / 100,
    escalate: async (e) => {
      // Same-cycle, deduped per territory while open (manager_signals entity) — never a week-late error.
      const r = await publishManagerSignal({
        brokerageId: e.brokerageId, fromManager: "cron_manager", toManager: "finance_manager", signalType: "autonomy_budget_escalated",
        message: `Paid acquisition ${e.lane} ${e.action} for a territory: ${e.reason}`.slice(0, 900),
        entityType: "lead_scraping_market", entityId: e.territoryId, payload: { lane: e.lane, action: e.action, reason: e.reason },
      })
      if (!r.ok) console.error("[pooled-pull] backpressure escalation not published:", r.reason)
    },
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
  allWants: readonly PooledWant[],
  deps: PooledBatchDataDeps,
): Promise<{ byTerritory: Map<string, PooledShare<BatchDataRecord>>; ledger: PooledLaneLedger; errors: string[] }> {
  const byTerritory = new Map<string, PooledShare<BatchDataRecord>>()
  const errors: string[] = []
  // THE APPROVAL GATE — before pooling, so an unapproved tenant's geography never widens a paid request.
  const approvedWants: PooledWant[] = []
  let unapproved = 0, throttled = 0, deferred = 0, escalations = 0
  // Records each territory may fund PER TRIGGER after the dollar check (absent = the record cap alone).
  const dollarCap = new Map<string, number>()
  for (const w of allWants) {
    const verdict = deps.approval(w.territory.brokerage_id, lane, w.territory)
    if (!verdict.allowed) {
      unapproved++
      errors.push(`${lane}: territory ${w.territory.id} not pulled — ${verdict.reason}`)
      continue
    }
    // SPEND BACKPRESSURE — only when the approval carries its ceiling and the price is known (see the deps doc).
    if (verdict.maxSpendUsd !== undefined && typeof deps.unitUsd === "number" && w.territory.brokerage_id) {
      const t = w.territory
      const recordCap = typeof t.max_records_per_run === "number" && t.max_records_per_run > 0 ? Math.floor(t.max_records_per_run) : (deps.defaultRecordsPerTerritory ?? 100)
      const triggers = Math.max(1, w.triggers.length)
      const bp = decideSpendBackpressure({
        wantRecords: recordCap * triggers,
        unitUsd: deps.unitUsd,
        approvedMaxUsd: verdict.maxSpendUsd,
        approvedSpentUsd: deps.spentSinceApproval ? deps.spentSinceApproval(t.brokerage_id as string, lane, verdict.approvedAt ?? null) : null,
        territoryRemainingUsd: typeof t.monthly_budget_usd === "number" ? t.monthly_budget_usd - (t.spend_this_month ?? 0) : null,
        platformCapRemainingUsd: deps.platformCapRemainingUsd ? deps.platformCapRemainingUsd((t.brokerage_id as string | null) ?? null) : undefined,
        providerFailing: deps.providerFailing === true,
      })
      if (bp.escalate) {
        escalations++
        try { await deps.escalate?.({ brokerageId: t.brokerage_id as string, territoryId: t.id, lane, action: bp.action, reason: bp.reason }) } catch { /* never throws into the lane */ }
      }
      if (bp.action === "defer" || bp.action === "refuse") {
        deferred++
        errors.push(`${lane}: territory ${t.id} ${bp.action === "refuse" ? "refused" : "deferred"} — ${bp.reason}`)
        continue
      }
      if (bp.action === "throttle") {
        throttled++
        const per = Math.floor(bp.records / triggers)
        if (per < 1) { deferred++; throttled--; errors.push(`${lane}: territory ${t.id} deferred — ${bp.reason} (under one record per trigger)`); continue }
        dollarCap.set(t.id, per)
        errors.push(`${lane}: territory ${t.id} throttled — ${bp.reason}`)
      }
    }
    approvedWants.push(w)
  }
  const wants: readonly PooledWant[] = approvedWants
  const ledger: PooledLaneLedger = {
    lane, vendor: "batchdata", territories: new Set(wants.map((w) => w.territory.id)).size, requests: 0, chunks: 0,
    chargeUsd: 0, allocatedUsd: 0, unattributedRecords: 0, unallocatedUsd: 0, unapprovedTerritories: unapproved,
    throttledTerritories: throttled, deferredTerritories: deferred, escalations,
    perTerritoryRequestsReplaced: wants.reduce((s, w) => s + w.triggers.length, 0),
  }
  const perTerritoryCap = (t: PoolTerritory) => {
    const records = typeof t.max_records_per_run === "number" && t.max_records_per_run > 0 ? Math.floor(t.max_records_per_run) : (deps.defaultRecordsPerTerritory ?? 100)
    const dollars = dollarCap.get(t.id)
    return typeof dollars === "number" ? Math.min(records, dollars) : records
  }

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

// ─── POOLED SAVE — every paid record persisted BEFORE the per-territory loop (wave 93, 93B2) ──
// A pooled pull is paid for EVERY territory at once, but the cron's per-territory loop can hit
// maxDuration before it reaches the last territories — their pooled records were paid for and
// lost. The fix: the pooled phase PERSISTS every territory's share (raw insert + source ledger +
// territory spend) before the loop starts, and hands the loop EMPTY shares (it only reports). This
// pure planner is the one place that decides what is persisted; it never drops a record or a cent:
// one batch per (territory, lane) that received anything or was charged anything.

export interface PooledPersistBatch<R> {
  territoryId: string
  lane: string
  records: R[]
  costUsd: number
  staleDropped: number
}

/** PURE — every territory share of every pooled lane → the batches to persist. Σ records and Σ cost
 *  over the batches equal Σ over the shares (scripts/one-pull-guard.ts asserts it, with a positive
 *  control replaying the timeout that lost them). */
export function planPooledPersistence<R>(
  lanes: ReadonlyArray<{ lane: string; byTerritory: ReadonlyMap<string, PooledShare<R>> }>,
): PooledPersistBatch<R>[] {
  const out: PooledPersistBatch<R>[] = []
  for (const { lane, byTerritory } of lanes) {
    for (const [territoryId, share] of byTerritory) {
      if (share.records.length === 0 && share.costUsd <= 0 && share.staleDropped === 0) continue
      out.push({ territoryId, lane, records: [...share.records], costUsd: share.costUsd, staleDropped: share.staleDropped })
    }
  }
  return out
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
