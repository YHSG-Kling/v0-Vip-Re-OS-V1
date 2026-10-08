/**
 * AVM PROVIDER CHAIN
 *
 * Single entry point for "what is this property worth right now?" Returns a
 * fresh AVM with provider attribution + confidence. Cascades through providers
 * in order — first one that returns a confident value wins. Falls back to the
 * cached `contacts.home_value_estimate` adjusted by `market_data` appreciation
 * if everything else fails.
 *
 * Configured providers (super-admin tier):
 *   - RentCast (RENTCAST_API_KEY — the ONE platform key; RentCast is platform-
 *     gated, there is no per-tenant key) — chosen AVM provider
 *   - (BatchData — RETIRED from this chain, wave 92 lane 92B: owner "use rentcast as much as
 *     possible regarding … home values" / "batchdata is to be used more for scrapping leads".
 *     Survivor: the RentCast leg, which now runs for EVERY tenant — its gate no longer asks the
 *     tenant-IDX substitute question for a property-data read, rentcast-eligibility.ts readKind.)
 *   - BatchData — THE BACKUP (wave 93, lane 93B, owner: "use batchdata as a backup"). Runs
 *     ONLY after a named RentCast miss (unconfigured / error / no record — never over budget),
 *     only server-side, through the ONE BatchData gate's fallback purpose. The same backup
 *     serves the property LOOKUP (getPropertyRecordWithFallback) and the CMA comps
 *     (lib/cma/comp-provider.ts §3c) through batchDataPropertyFallback below. Never a
 *     primary, never an AI agent tool.
 *   - ZenRows + Zillow (ZENROWS_API_KEY) — Zillow Zestimate scrape
 *   - Perplexity Sonar (via lib/ai/models.ts) — live AVM context
 *   - OSINT public records — value derived from sale records + comps
 *
 * Each provider's API integration is wrapped in a thin adapter. Adapters can
 * fail silently — the chain just tries the next one. No provider's failure
 * propagates as an error to the caller.
 *
 * STATUS (verified): the adapters are LIVE — RentCast via lib/property/rentcast
 * (connector-gateway, X-Api-Key, per-call metering), (BatchData leg retired wave 92),
 * Zillow-via-ZenRows via lib/external/
 * zenrows-client, Perplexity via the AI gateway. Each is creds-gated (no key →
 * null → next provider). Wave 92 (lane 92B2): RentCast is the FIRST tier for every call
 * that names a tenant (key + vendor budget gated); the premium Zillow scrape still sits
 * behind usePaidProviders + the vendor budget gate. The only remaining stub is the OSINT direct-AVM path
 * (public records give life events, not values — deliberate).
 */

import "server-only"
import type { RentcastMissReason, CapabilityProviderHealth } from "@/lib/ai-isa/property-lookup-rail"
import type { BatchDataPropertyFallback } from "@/lib/external/batchdata-client"
import type { RentcastPropertyDetail, RentcastReadOutcome } from "@/lib/property/rentcast"
import type { VersiumPropertyFactsResult, VersiumProvenance } from "@/lib/external/versium-client"
import type { MeterVendorInput } from "@/lib/vendor-governance/meter-vendor"

// "batchdata" is produced again since wave 93 (lane 93B) — ONLY by the BACKUP leg
// (tryBatchDataBackup), after a named RentCast miss. Wave 92 had retired it as a primary.
export type AvmSource = "rentcast" | "batchdata" | "zenrows_zillow" | "perplexity" | "osint" | "cached" | "market_appreciation_fallback"

export interface AvmResult {
  value: number
  confidence: number          // 0..1
  source: AvmSource
  fetchedAt: string           // ISO
  notes?: string
  /** Wave 99 (lane 99C): the provider's own range when it published one (RentCast / BatchData);
   *  absent for the tiers that have none. Normalized here so no caller reads vendor JSON. */
  rangeLow?: number | null
  rangeHigh?: number | null
}

interface AvmRequest {
  address: string
  zipCode?: string | null
  city?: string | null
  state?: string | null
  /**
   * The tenant this AVM pull is ATTRIBUTED to — not a credential selector.
   * RentCast is platform-gated (one platform key, no per-tenant key), so this
   * decides nothing about WHICH credential is used. It is what makes the paid
   * tier governable: `checkVendorBudget({ brokerageId })` below can only run
   * with a tenant in hand, and lib/property/rentcast.ts meters every call
   * against it. Absent brokerageId → the RentCast adapter is skipped entirely,
   * because an unattributable paid call is spend nobody can see.
   */
  brokerageId?: string | null
  /** Cached AVM if we've fetched recently — used by the cache-hit short circuit */
  cachedValue?: number | null
  cachedAt?: string | null
  /** Stale threshold in days — within this window we use cached. Default 14. */
  cacheStaleAfterDays?: number
  /** Allow caller to skip certain providers (e.g., for testing) */
  skipProviders?: AvmSource[]
  /**
   * When true, also try the PREMIUM paid tier (ZenRows/Zillow) after the free fallbacks. Wave 92
   * (lane 92B2): RentCast no longer waits for this flag — it is the FIRST tier for every call that
   * names a tenant (budget- and key-gated); this flag now governs only the premium scrape.
   */
  usePaidProviders?: boolean
}

const DEFAULT_CACHE_STALE_DAYS = 14

/**
 * Get the current AVM. Cascades through providers until one returns a
 * confident value. Falls back to cached value if all live providers fail.
 */
export async function getCurrentAvm(req: AvmRequest): Promise<AvmResult | null> {
  const skip = new Set(req.skipProviders ?? [])
  const cacheDays = req.cacheStaleAfterDays ?? DEFAULT_CACHE_STALE_DAYS

  // ── 0. Cache hit short-circuit ─────────────────────────────────────────
  if (req.cachedValue && req.cachedAt && !skip.has("cached")) {
    const ageDays = (Date.now() - new Date(req.cachedAt).getTime()) / (24 * 60 * 60 * 1000)
    if (ageDays < cacheDays) {
      return {
        value: req.cachedValue,
        confidence: 0.7,
        source: "cached",
        fetchedAt: req.cachedAt,
      }
    }
  }

  // ── 1 + 1b. THE PROPERTY_VALUATION CAPABILITY (wave 99, lane 99C — LAW 3) ──────
  // TOMBSTONE (wave 99, §1.3): the inline RentCast-first tier (wave 92, lane 92B2) and the inline
  // BatchData backup tier (wave 93, lane 93B) stood here. Survivor: requestPropertyValuation below —
  // the same eligibility gate, the same RentCast-then-backup order, the same confidence floors —
  // now asked as ONE capability through the health-aware router, so a RentCast in a `failing`
  // cool-down is routed around instead of paying a timeout per home. Healthy providers → the same
  // calls in the same order as before. Over budget → RentCast AND the premium paid tier are skipped;
  // the free fallbacks below still answer. A tenant-less call never reaches the paid tier.
  let overBudget = false
  if (req.brokerageId) {
    const v = await requestPropertyValuation({ brokerageId: req.brokerageId, address: req.address, exclude: [...skip] })
    overBudget = v.overBudget
    if (v.valuation) return v.valuation
  }

  // ── 2. Perplexity Sonar (FALLBACK) ──────────────────────────────────────
  // ~$0.01/call via web-search-grounded AI. Reached when RentCast is not eligible for this tenant
  // (no platform key, budget paused, no tenant on the call) or answered without a confident value.
  if (!skip.has("perplexity")) {
    const px = await tryPerplexitySonar(req)
    if (px && px.confidence >= 0.5) return px
  }

  // ── 3. OSINT public records (free fallback) ────────────────────────────
  if (!skip.has("osint")) {
    const os = await tryOsintPublicRecords(req)
    if (os && os.confidence >= 0.45) return os
  }

  // ── 4. PREMIUM paid tier — agent-triggered only (usePaidProviders) ──────
  // TOMBSTONE (wave 92, lane 92B, §1.3): the BatchData AVM leg (tryBatchData →
  // enrichPropertyWithBatchData, gated as purpose "valuation") stood in this tier. A home value is
  // a RentCast read — survivor: the RentCast-first tier above. "valuation" left
  // BATCHDATA_ELIGIBLE_PURPOSES (lib/ai-isa/property-lookup-rail.ts), so no valuation lane can reach
  // BatchData again. What remains here is the Zillow scrape, still premium-only and still skipped
  // over budget (the budget governs the whole paid tier, as before).
  if (req.usePaidProviders && !overBudget) {
    if (!skip.has("zenrows_zillow") && process.env.ZENROWS_API_KEY) {
      const zen = await tryZillowViaZenRows(req)
      if (zen && zen.confidence >= 0.55) return zen
    }
  }

  // ── 5. Market appreciation fallback ────────────────────────────────────
  // Take the cached value (even if stale) and apply zip-level appreciation.
  if (req.cachedValue && req.zipCode) {
    const adjusted = await marketAppreciationFallback(req.cachedValue, req.zipCode, req.cachedAt)
    if (adjusted) return adjusted
  }

  return null
}

// ─── Provider adapters ──────────────────────────────────────────────────────
//
// Every adapter below makes a REAL call (RentCast connector-gateway, BatchData
// client, ZenRows Zillow scrape, Perplexity via the AI gateway) — creds-gated,
// silent-fail to the next provider. The one deliberate null is OSINT (public
// records yield life events, not values).

/** The RentCast leg's answer: the AVM (or null), WHY it is null — the miss the backup reads — and
 *  the USD this request metered (0 when not eligible or served from RentCast's 14-day cache). */
type RentcastLeg = { result: AvmResult | null; outcome: RentcastReadOutcome; eligibilityReason: string | null; costUsd: number }

async function tryRentcast(req: ValuationRequest, seam?: PropertyValuationDeps["rentcast"]): Promise<RentcastLeg> {
  if (!req.brokerageId) return { result: null, outcome: "not_eligible", eligibilityReason: null, costUsd: 0 }
  try {
    const { getRentcastAVM, RENTCAST_USD_PER_REQUEST } = await import("@/lib/property/rentcast")
    const call = { brokerageId: req.brokerageId, address: req.address, ...(req.systemSource ? { systemSource: req.systemSource } : {}), ...(req.contactId ? { contactId: req.contactId } : {}) }
    const avm = seam ? await seam(call) : await getRentcastAVM(call)
    // getRentcastAVM meters every request it makes (meterCall at RENTCAST_USD_PER_REQUEST); this only REPORTS it.
    const costUsd = avm.outcome !== "not_eligible" && avm.cacheHit !== true ? RENTCAST_USD_PER_REQUEST : 0
    if (!avm.value || avm.value <= 0) return { result: null, outcome: avm.outcome === "answered" ? "no_record" : avm.outcome, eligibilityReason: avm.eligibility.reason, costUsd }
    // Tighter range around the point estimate → higher confidence.
    const spread = avm.rangeLow && avm.rangeHigh && avm.value > 0 ? (avm.rangeHigh - avm.rangeLow) / avm.value : 0.3
    const confidence = Math.max(0.6, Math.min(0.92, 0.9 - spread))
    return {
      result: {
        value: avm.value,
        confidence,
        source: "rentcast",
        fetchedAt: new Date().toISOString(),
        notes: avm.rangeLow && avm.rangeHigh ? `RentCast AVM (range $${avm.rangeLow.toLocaleString()}–$${avm.rangeHigh.toLocaleString()})` : "RentCast AVM",
        rangeLow: avm.rangeLow ?? null,
        rangeHigh: avm.rangeHigh ?? null,
      },
      outcome: "answered",
      eligibilityReason: avm.eligibility.reason,
      costUsd,
    }
  } catch {
    return { result: null, outcome: "error", eligibilityReason: null, costUsd: 0 }
  }
}

/** The AVM half of the backup — BatchData's own valuation for the address, after a RentCast miss.
 *  The fallback meters its own spend (meterVendorSpend, vendor "batchdata"); costUsd only REPORTS it. */
async function tryBatchDataBackup(req: ValuationRequest, miss: RentcastMissReason, deps?: BatchDataFallbackDeps): Promise<{ result: AvmResult | null; costUsd: number; reason: string }> {
  if (!req.brokerageId) return { result: null, costUsd: 0, reason: "no tenant" }
  const bd = await batchDataPropertyFallback({ brokerageId: req.brokerageId, address: req.address, kind: "avm", rentcastMiss: miss, systemSource: req.systemSource ?? "avm_provider_chain", contactId: req.contactId ?? null }, deps)
  const costUsd = bd.answeredBy === "batchdata" && !bd.cacheHit ? (bd.result?.cost ?? 0) : 0
  const v = bd.result?.valuation
  if (bd.answeredBy !== "batchdata" || !v?.value) return { result: null, costUsd, reason: bd.reason }
  const spread = v.rangeLow && v.rangeHigh ? (v.rangeHigh - v.rangeLow) / v.value : 0.35
  return {
    result: {
      value: v.value,
      confidence: Math.max(0.55, Math.min(0.85, 0.85 - spread)),
      source: "batchdata",
      fetchedAt: new Date().toISOString(),
      notes: `BatchData AVM — the BACKUP, used because RentCast did not answer (${miss})${bd.cacheHit ? "; served from the 14-day fallback cache" : ""}`,
      rangeLow: v.rangeLow ?? null,
      rangeHigh: v.rangeHigh ?? null,
    },
    costUsd,
    reason: bd.reason,
  }
}

// ─── THE PROPERTY_VALUATION CAPABILITY (wave 99, lane 99C — LAW 3) ──────────────────────
// Owner LAW 3: "Agents request capabilities, not vendors." A caller asks "what is this home worth?"
// and names NO vendor; the provider order is CONTACT_PROVIDER_ROUTES.property_valuation (the ONE
// price/route table, lib/ai-isa/property-lookup-rail.ts), routed by routeCapability over the
// gateway's derived provider health (lib/agentic-os/connector-gateway.ts::deriveProviderHealth):
// a provider in a `failing` cool-down is skipped WITH its reason; every other state is asked.
// Each leg meters through its existing path (RentCast: meterCall in getRentcastAVM; BatchData:
// meterVendorSpend in batchDataPropertyFallback) — nothing is booked twice, costUsd only reports.

export interface ValuationRequest {
  brokerageId: string | null | undefined
  address: string
  /** The vendor-ledger lane the metered call is attributed to (each leg's own default otherwise). */
  systemSource?: string
  contactId?: string | null
  /** Providers the CALLER rules out (e.g. AI-agent surfaces keep BatchData out: ["batchdata"]). */
  exclude?: readonly string[]
}

/** The normalized answer — the same shape whichever provider answered; never vendor JSON. */
export type PropertyValuation = AvmResult & { source: "rentcast" | "batchdata" }

export interface PropertyValuationOutcome {
  valuation: PropertyValuation | null
  /** Why RentCast did not answer — null when it answered or was never asked. */
  rentcastMiss: RentcastMissReason | null
  /** The tenant's vendor budget is spent — the paid tier is closed. */
  overBudget: boolean
  providersTried: string[]
  skipped: Array<{ provider: string; reason: string }>
  /** USD this request metered (cache hits and refusals cost 0). */
  costUsd: number
}

/** Injectable seams so a proof runs the capability with zero network (scripts/connector-gateway-simulator.ts). */
export interface PropertyValuationDeps {
  providerHealth?: (serviceKey: string) => Promise<{ state: string; routeAround: boolean; reason: string }>
  eligibility?: (brokerageId: string) => Promise<{ eligible: boolean; overBudget: boolean }>
  rentcast?: (p: { brokerageId: string; address: string; systemSource?: string; contactId?: string | null }) => Promise<{ value: number | null; rangeLow: number | null; rangeHigh: number | null; outcome: RentcastReadOutcome; eligibility: { reason: string | null }; cacheHit?: boolean }>
  fallback?: BatchDataFallbackDeps
  /** Wave 108G — the tenant's promoted provider skips (optimization_tuning.provider_skip.property_valuation, the
   *  provider_selection class of lib/kernel/self-optimization.ts). Default reads the tenant policy; unreadable → none. */
  tenantProviderSkips?: (brokerageId: string) => Promise<string[]>
}

/** THE ONE ELIGIBILITY GATE for the RentCast leg (lib/property/rentcast-eligibility.ts, readKind
 *  "property_data": a home value has no IDX substitute; the platform key and the budget decide). */
async function productionValuationEligibility(brokerageId: string): Promise<{ eligible: boolean; overBudget: boolean }> {
  const { resolveRentcastEligibility, rentcastBudgetBlocked } = await import("@/lib/property/rentcast-eligibility")
  const eligibility = await resolveRentcastEligibility({ brokerageId, readKind: "property_data" })
  const overBudget = eligibility.budget.checked
    ? eligibility.reason === "budget_exhausted"
    : (await rentcastBudgetBlocked(brokerageId)).blocked
  return { eligible: eligibility.eligible, overBudget }
}

/**
 * THE capability entry. Never throws. Order of questions:
 *   1. a tenant on the request (an unattributable paid call is spend nobody can see) — else nothing;
 *   2. the route: CONTACT_PROVIDER_ROUTES.property_valuation minus the caller's exclusions minus any
 *      provider in a `failing` cool-down (routeCapability);
 *   3. RentCast (primary) under the ONE eligibility gate — a miss is NAMED; a RentCast routed around
 *      for health is the miss "error" (its newest calls faulted), so the backup may answer;
 *   4. BatchData (backup) ONLY behind a named RentCast miss, through the ONE BatchData gate.
 */
export async function requestPropertyValuation(req: ValuationRequest, deps?: PropertyValuationDeps): Promise<PropertyValuationOutcome> {
  const out: PropertyValuationOutcome = { valuation: null, rentcastMiss: null, overBudget: false, providersTried: [], skipped: [], costUsd: 0 }
  if (!req.brokerageId || !req.address?.trim()) {
    out.skipped.push({ provider: "*", reason: !req.brokerageId ? "no tenant on the request — the paid valuation tier is never reached unattributed (§4)" : "no address to value" })
    return out
  }
  try {
    const { CONTACT_PROVIDER_ROUTES, routeCapability } = await import("@/lib/ai-isa/property-lookup-rail")
    const exclude = new Set<string>(req.exclude ?? [])
    const healthFn = deps?.providerHealth
      ?? (async (k: string) => (await import("@/lib/agentic-os/connector-gateway")).loadProviderHealth(k))
    const health: Record<string, { state: string; routeAround: boolean; reason: string } | null> = {}
    for (const e of CONTACT_PROVIDER_ROUTES.property_valuation) {
      if (!exclude.has(e.provider)) health[e.provider] = await healthFn(e.provider).catch(() => null)
    }
    const routed = routeCapability("property_valuation", health, exclude)
    out.skipped.push(...routed.skipped)
    // TENANT PROVIDER SKIP (wave 108G, promoted by the manager team after a deterministic reliability re-measure):
    // a BACKUP this tenant's own calls show failing is not paid for. The owner-ruled primary (RentCast) is never skipped.
    const primary = CONTACT_PROVIDER_ROUTES.property_valuation[0]?.provider
    const tenantSkips = new Set((await (deps?.tenantProviderSkips ?? ((b: string) => import("@/lib/kernel/self-optimization").then((m) => m.loadTenantProviderSkips(b))))(req.brokerageId).catch(() => [] as string[])).filter((p) => p !== primary))
    for (const p of routed.providers) if (tenantSkips.has(p)) out.skipped.push({ provider: p, reason: "skipped for this tenant (optimization_tuning.provider_skip — promoted provider_selection)" })
    const route = { ...routed, providers: routed.providers.filter((p) => !tenantSkips.has(p)) }

    let eligible = false
    if (!exclude.has("rentcast")) {
      const e = await (deps?.eligibility ?? productionValuationEligibility)(req.brokerageId)
      eligible = e.eligible
      out.overBudget = e.overBudget
      if (!eligible || out.overBudget) out.rentcastMiss = out.overBudget ? "over_budget" : "unconfigured"
      else if (!route.providers.includes("rentcast")) out.rentcastMiss = "error"
    }

    for (const provider of route.providers) {
      if (provider === "rentcast") {
        if (!eligible || out.overBudget) { out.skipped.push({ provider, reason: `not eligible (${out.rentcastMiss})` }); continue }
        out.providersTried.push(provider)
        const rc = await tryRentcast(req, deps?.rentcast)
        out.costUsd += rc.costUsd
        if (rc.result && rc.result.confidence >= 0.6) { out.valuation = rc.result as PropertyValuation; return out }
        out.rentcastMiss = rc.result ? "no_record" : rentcastMissFrom(rc.outcome, rc.eligibilityReason)
      } else if (provider === "batchdata") {
        if (!out.rentcastMiss) { out.skipped.push({ provider, reason: "the backup — reached only after a named RentCast miss" }); continue }
        out.providersTried.push(provider)
        const bd = await tryBatchDataBackup(req, out.rentcastMiss, deps?.fallback)
        out.costUsd += bd.costUsd
        if (bd.result && bd.result.confidence >= 0.55) { out.valuation = bd.result as PropertyValuation; return out }
        out.skipped.push({ provider, reason: bd.reason })
      }
    }
  } catch (e) {
    out.skipped.push({ provider: "*", reason: `valuation capability threw: ${e instanceof Error ? e.message : String(e)}` })
  }
  return out
}

// ─── THE BATCHDATA BACKUP — one door for every property read (wave 93, lane 93B) ───────

/** PURE — RentCast's read outcome → the miss the BatchData gate judges (null = RentCast answered,
 *  or a sale-listings-only IDX reason a property read can never carry).
 *  @proofSeam exported so scripts/rentcast-platform-guard.ts (section E) can execute the vocabulary
 *  directly; its production readers are getCurrentAvm and getPropertyRecordWithFallback in this file. */
export function rentcastMissFrom(outcome: RentcastReadOutcome, eligibilityReason: string | null): RentcastMissReason | null {
  if (outcome === "answered") return null
  if (outcome === "not_eligible") {
    if (eligibilityReason === "budget_exhausted") return "over_budget"
    if (eligibilityReason === "no_platform_key") return "unconfigured"
    return null
  }
  return outcome
}

/** Injectable seams so the proof runs the backup with zero network (scripts/rentcast-platform-guard.ts). */
export interface BatchDataFallbackDeps {
  access?: (req: { brokerageId: string; purpose: "valuation"; afterRentcastMiss: RentcastMissReason }) => Promise<{ allowed: boolean; reason: string }>
  fetch?: (address: string, opts: { comps?: boolean }) => Promise<BatchDataPropertyFallback>
  meter?: (input: { vendorName: string; usageType: string; cost: number; brokerageId: string; systemSource: string; metadata: Record<string, unknown> }) => Promise<unknown>
  cache?: { get: (key: string) => Promise<BatchDataPropertyFallback | null>; set: (key: string, value: BatchDataPropertyFallback, costCents: number) => Promise<unknown> } | null
}

const BATCHDATA_FALLBACK_CACHE_DAYS = 14

/**
 * THE ONE BATCHDATA BACKUP for a property read (lookup, value, comps). Order of questions:
 *   1. the gate (resolveBatchDataAccess, purpose "valuation" + afterRentcastMiss) — refused → null;
 *   2. the 14-day fallback cache (a hit costs nothing and books nothing);
 *   3. ONE BatchData Property Search (fetchBatchDataPropertyFallback);
 *   4. the ledger: vendor "batchdata", usage `property_fallback_<kind>`, metadata answered_by +
 *      fallback_for "rentcast" + the miss — so "which provider answered" is a ledger fact.
 * Never throws. `answeredBy` is "batchdata" only when a row came back.
 */
export async function batchDataPropertyFallback(
  req: { brokerageId: string; address: string; kind: "avm" | "record" | "comps"; rentcastMiss: RentcastMissReason; systemSource?: string; contactId?: string | null },
  deps: BatchDataFallbackDeps = {},
): Promise<{ answeredBy: "batchdata" | null; result: BatchDataPropertyFallback | null; reason: string; cacheHit: boolean }> {
  try {
    const access = deps.access
      ? await deps.access({ brokerageId: req.brokerageId, purpose: "valuation", afterRentcastMiss: req.rentcastMiss })
      : await (await import("@/lib/ai-isa/property-lookup-rail")).resolveBatchDataAccess({ brokerageId: req.brokerageId, purpose: "valuation", afterRentcastMiss: req.rentcastMiss })
    if (!access.allowed) return { answeredBy: null, result: null, reason: access.reason, cacheHit: false }
    const key = `batchdata:fallback|${req.kind === "comps" ? "comps" : "property"}|${req.address.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`
    const cache = deps.cache !== undefined ? deps.cache : await productionFallbackCache()
    const hit = cache ? await cache.get(key).catch(() => null) : null
    if (hit && hit.found) return { answeredBy: "batchdata", result: hit, reason: "BatchData backup served from the 14-day fallback cache — no request billed", cacheHit: true }
    const fetcher = deps.fetch
      ?? ((address: string, opts: { comps?: boolean }) => import("@/lib/external/batchdata-client").then((m) => m.fetchBatchDataPropertyFallback(address, opts)))
    const result = await fetcher(req.address, { comps: req.kind === "comps" })
    if (!result.ok || !result.found) {
      return { answeredBy: null, result, reason: result.error ? `BatchData backup failed: ${result.error}` : "BatchData backup answered with no record for this address", cacheHit: false }
    }
    const meter = deps.meter
      ?? ((m: Parameters<NonNullable<BatchDataFallbackDeps["meter"]>>[0]) => import("@/lib/vendor-governance/meter-vendor").then((v) => v.meterVendorSpend(m)))
    await Promise.resolve(meter({
      vendorName: "batchdata",
      usageType: `property_fallback_${req.kind}`,
      cost: result.cost,
      brokerageId: req.brokerageId,
      systemSource: req.systemSource ?? "property_provider_chain",
      metadata: { answered_by: "batchdata", fallback_for: "rentcast", rentcast_miss: req.rentcastMiss, contact_id: req.contactId ?? null },
    })).catch(() => null)
    if (cache) void Promise.resolve(cache.set(key, result, Math.round(result.cost * 100))).catch(() => null)
    return { answeredBy: "batchdata", result, reason: `BatchData answered as the backup (RentCast miss: ${req.rentcastMiss})`, cacheHit: false }
  } catch (e) {
    return { answeredBy: null, result: null, reason: `BatchData backup threw: ${e instanceof Error ? e.message : String(e)}`, cacheHit: false }
  }
}

/** The shared provider-payload store (lib/cma/comp-supplement-cache.ts) as the fallback cache. */
async function productionFallbackCache(): Promise<BatchDataFallbackDeps["cache"]> {
  try {
    const store = await import("@/lib/cma/comp-supplement-cache")
    return {
      get: (key) => store.getCachedProviderPayload<BatchDataPropertyFallback>(key, BATCHDATA_FALLBACK_CACHE_DAYS),
      set: (key, value, costCents) => store.setCachedProviderPayload(key, value, costCents),
    }
  } catch { return null }
}

/** One property record, whichever provider answered (the lookup half of the chain). */
export interface ChainPropertyRecord {
  provider: "rentcast" | "batchdata"
  address: string | null; city: string | null; state: string | null; zip: string | null
  bedrooms: number | null; bathrooms: number | null; squareFeet: number | null; yearBuilt: number | null
  propertyType: string | null; assessedValue: number | null; annualPropertyTax: number | null; taxYear: number | null
  ownerNames: string[]; lastSaleDate: string | null; lastSalePrice: number | null
  /** The full RentCast staff record when RentCast answered (every attribute); null on the backup. */
  rentcastDetail: RentcastPropertyDetail | null
}

/**
 * THE PROPERTY LOOKUP on the chain (wave 93, lane 93B): RentCast's full record first; on a named
 * miss, the BatchData backup. SERVER-SIDE callers only (net-sheet tax preload, deal investigator) —
 * the AI agents' lookup_property_facts rides the conversation rail, which never reaches BatchData.
 * Wave 139 (lane 139D): a caller that NEEDS facts the answering record left empty names them in
 * `gapFields`; only those gaps walk the property_facts capability route (fillPropertyFactGaps) —
 * a caller that names none (the net-sheet tax preload) never buys a gap fill.
 */
export async function getPropertyRecordWithFallback(
  params: { brokerageId: string; address: string; systemSource?: string; contactId?: string | null; gapFields?: readonly PropertyFactGapField[]; gapFillMaxUsd?: number },
  deps: { rentcast?: (p: { brokerageId: string; address: string; systemSource?: string; contactId?: string | null }) => Promise<{ detail: RentcastPropertyDetail | null; outcome: RentcastReadOutcome; eligibility: { reason: string } }>; fallback?: BatchDataFallbackDeps; gapFill?: PropertyFactGapFillDeps } = {},
): Promise<{ record: ChainPropertyRecord | null; rentcastMiss: RentcastMissReason | null; note: string; backupCostUsd: number; gapFill: PropertyFactGapFill | null }> {
  const withGaps = async (out: { record: ChainPropertyRecord; rentcastMiss: RentcastMissReason | null; note: string; backupCostUsd: number }) => {
    if (!params.gapFields?.length) return { ...out, gapFill: null }
    const maxUsd = params.gapFillMaxUsd === undefined ? undefined : Math.max(0, params.gapFillMaxUsd - out.backupCostUsd)
    const g = await fillPropertyFactGaps(out.record, { brokerageId: params.brokerageId, systemSource: params.systemSource, contactId: params.contactId, rentcastMiss: out.rentcastMiss, maxUsd }, params.gapFields, deps.gapFill)
    return { ...out, record: g.record, gapFill: g.fill }
  }
  const rc = deps.rentcast
    ? await deps.rentcast(params)
    : await (await import("@/lib/property/rentcast")).getRentcastPropertyDetailWithOutcome(params)
  if (rc.detail) {
    const d = rc.detail
    return withGaps({
      record: {
        provider: "rentcast", address: d.address, city: d.city, state: d.state, zip: d.zip,
        bedrooms: d.bedrooms, bathrooms: d.bathrooms, squareFeet: d.squareFeet, yearBuilt: d.yearBuilt,
        propertyType: d.propertyType, assessedValue: d.assessedValue, annualPropertyTax: d.annualPropertyTax, taxYear: d.taxYear,
        ownerNames: d.ownerNames, lastSaleDate: d.lastSaleDate, lastSalePrice: d.lastSalePrice, rentcastDetail: d,
      },
      rentcastMiss: null,
      note: "RentCast property record",
      backupCostUsd: 0,
    })
  }
  const miss = rentcastMissFrom(rc.outcome, rc.eligibility.reason)
  if (!miss) return { record: null, rentcastMiss: null, note: `RentCast did not answer (${rc.outcome}) and no backup applies`, backupCostUsd: 0, gapFill: null }
  const bd = await batchDataPropertyFallback({ ...params, kind: "record", rentcastMiss: miss }, deps.fallback)
  const f = bd.result?.facts
  if (bd.answeredBy !== "batchdata" || !f) return { record: null, rentcastMiss: miss, note: `RentCast missed (${miss}); ${bd.reason}`, backupCostUsd: 0, gapFill: null }
  return withGaps({
    record: {
      provider: "batchdata", address: f.address, city: f.city, state: f.state, zip: f.zip,
      bedrooms: f.beds, bathrooms: f.baths, squareFeet: f.sqft, yearBuilt: f.yearBuilt, propertyType: f.propertyType,
      assessedValue: f.assessedValue, annualPropertyTax: f.annualPropertyTax, taxYear: f.taxYear,
      ownerNames: f.ownerNames, lastSaleDate: f.lastSaleDate, lastSalePrice: f.lastSalePrice, rentcastDetail: null,
    },
    rentcastMiss: miss,
    note: `BatchData property record — the backup after a RentCast miss (${miss})`,
    backupCostUsd: bd.cacheHit ? 0 : (bd.result?.cost ?? 0),
  })
}

// ─── PROPERTY FACTS GAP FILL — the property_facts capability route, walked (wave 139, lane 139D) ───
// Owner (wave 138): "Versium (ALSO a property-data provider)"; owner order for a property read stands:
// RentCast primary, BatchData backup (waves 92/93) — Versium never answers in their place. It fills
// only the facts the record left EMPTY that the caller says it needs (gap-only enrichment), through
// THE route table (CONTACT_PROVIDER_ROUTES.property_facts, routeCapability — health-aware), never a
// competing rail. BatchData is excluded from this walk: its ONE door (batchDataPropertyFallback above)
// already ran or the owner's backup rule refused it — a second BatchData purchase is never made here.
// Versium's property facts are exact values only (year built, dwelling type, purchase date); its
// price / value RANGES never reach the record (lib/external/versium-client.ts appendVersiumPropertyFacts).

/** The record fields a gap fill may write — exact facts only, never a valuation figure. */
type PropertyFactGapField = "yearBuilt" | "propertyType" | "lastSaleDate"

/** Injectable seams so the proof walks the route with zero network (scripts/provider-adapter-guard.ts §O). */
interface PropertyFactGapFillDeps {
  providerHealth?: (serviceKey: string) => Promise<CapabilityProviderHealth | null>
  configured?: () => boolean
  checkBudget?: (p: { brokerageId: string; addCost: number }) => Promise<{ allowed: boolean }>
  versium?: (addr: { address: string | null; city: string | null; state: string | null; zip: string | null }) => Promise<VersiumPropertyFactsResult>
  meter?: (m: MeterVendorInput) => Promise<unknown>
}

interface PropertyFactGapFill {
  /** The gaps the caller needed that the record left empty. */
  asked: PropertyFactGapField[]
  /** Which provider filled each gap. */
  filled: Partial<Record<PropertyFactGapField, "versium">>
  /** The route's providers in order, and who was left out with why. */
  route: string[]
  skipped: Array<{ provider: string; reason: string }>
  provenance: VersiumProvenance | null
  /** USD this fill metered (a no-match and every refusal cost 0). */
  costUsd: number
}

/** Walk the property_facts route for the record's empty facts. Never throws. */
async function fillPropertyFactGaps(
  record: ChainPropertyRecord,
  req: { brokerageId: string; systemSource?: string; contactId?: string | null; rentcastMiss: RentcastMissReason | null; maxUsd?: number },
  wanted: readonly PropertyFactGapField[],
  deps: PropertyFactGapFillDeps = {},
): Promise<{ record: ChainPropertyRecord; fill: PropertyFactGapFill }> {
  const fill: PropertyFactGapFill = { asked: wanted.filter((f) => record[f] === null || record[f] === undefined || record[f] === ""), filled: {}, route: [], skipped: [], provenance: null, costUsd: 0 }
  if (!fill.asked.length) return { record, fill }
  const next: ChainPropertyRecord = { ...record }
  try {
    const { CONTACT_PROVIDER_ROUTES, routeCapability } = await import("@/lib/ai-isa/property-lookup-rail")
    const exclude = new Set<string>(["batchdata"])
    const healthFn = deps.providerHealth ?? (async (k: string) => (await import("@/lib/agentic-os/connector-gateway")).loadProviderHealth(k))
    const health: Record<string, CapabilityProviderHealth | null> = {}
    for (const e of CONTACT_PROVIDER_ROUTES.property_facts) if (!exclude.has(e.provider)) health[e.provider] = await healthFn(e.provider).catch(() => null)
    const route = routeCapability("property_facts", health, exclude)
    fill.route = [...route.providers]
    fill.skipped.push(...route.skipped.map((s) => ({ provider: s.provider, reason: s.provider === "batchdata" ? "the chain's ONE BatchData door already ran (or the owner's backup rule refused it) — never a second BatchData purchase" : s.reason })))
    for (const provider of route.providers) {
      const gaps = fill.asked.filter((f) => !fill.filled[f])
      if (!gaps.length) break
      const unitUsd = CONTACT_PROVIDER_ROUTES.property_facts.find((e) => e.provider === provider)?.unitCostUsd ?? 0
      if (req.maxUsd !== undefined && unitUsd > req.maxUsd - fill.costUsd) { fill.skipped.push({ provider, reason: `over the caller's remaining cap ($${(req.maxUsd - fill.costUsd).toFixed(2)})` }); continue }
      if (provider !== "versium") { fill.skipped.push({ provider, reason: "no gap-fill executor for this provider" }); continue }
      const configured = deps.configured ?? (deps.versium ? () => true : (await import("@/lib/external/versium-client")).isVersiumConfigured)
      if (!configured()) { fill.skipped.push({ provider, reason: "unconfigured (no VERSIUM_API_KEY) — nothing asked, nothing spent" }); continue }
      if (!next.address || !(next.zip || (next.city && next.state))) { fill.skipped.push({ provider, reason: "the record carries no full postal address to ask by" }); continue }
      // THE vendor budget gate, asked BEFORE the paid call with the worst-case bill (one match credit) —
      // a gate that cannot run refuses (CLAUDE.md §4).
      try {
        const checkBudget = deps.checkBudget ?? (async (p: { brokerageId: string; addCost: number }) => (await import("@/lib/vendor-governance/budget-gate")).checkVendorBudget(p))
        const budget = await checkBudget({ brokerageId: req.brokerageId, addCost: unitUsd })
        if (!budget.allowed) { fill.skipped.push({ provider, reason: "vendor budget gate refused" }); continue }
      } catch (e) { fill.skipped.push({ provider, reason: `budget gate unavailable — refused: ${e instanceof Error ? e.message : String(e)}` }); continue }
      const ask = deps.versium ?? (async (a: Parameters<NonNullable<PropertyFactGapFillDeps["versium"]>>[0]) => (await import("@/lib/external/versium-client")).appendVersiumPropertyFacts(a))
      const r = await ask({ address: next.address, city: next.city, state: next.state, zip: next.zip })
      if (r.cost > 0) {
        const meter = deps.meter ?? (async (m: MeterVendorInput) => (await import("@/lib/vendor-governance/meter-vendor")).meterVendorSpend(m))
        let booked: unknown
        try { booked = await meter({ vendorName: "versium", usageType: "property_facts_gap_fill", unitCount: r.credits, cost: r.cost, brokerageId: req.brokerageId, systemSource: req.systemSource ?? "property_provider_chain", metadata: { capability: "property.enrich_facts", answered_by: r.facts ? "versium" : null, gaps_asked: gaps, record_provider: record.provider, rentcast_miss: req.rentcastMiss, contact_id: req.contactId ?? null, credits: r.credits }, attribution: { contactId: req.contactId ?? null } }) } catch (e) { booked = e instanceof Error ? e.message : String(e) }
        // The booking's answer is READ (CLAUDE.md §3): spend the ledger never saw is reported, never swallowed.
        if (booked === false || typeof booked === "string") console.warn(`[provider-chain] $${r.cost} versium property_facts_gap_fill NOT booked (brokerage ${req.brokerageId})${typeof booked === "string" ? `: ${booked}` : ""}`)
        fill.costUsd += r.cost
      }
      if (r.skipped || r.error || !r.facts) { fill.skipped.push({ provider, reason: r.skipped ?? r.error ?? "no match (free)" }); continue }
      for (const f of gaps) {
        const v = r.facts[f]
        if (v === null || v === undefined) continue
        if (f === "yearBuilt") next.yearBuilt = v as number
        else if (f === "propertyType") next.propertyType = v as string
        else next.lastSaleDate = v as string
        fill.filled[f] = "versium"
      }
      fill.provenance = r.provenance
    }
  } catch (e) {
    fill.skipped.push({ provider: "*", reason: `gap fill threw: ${e instanceof Error ? e.message : String(e)}` })
  }
  return { record: next, fill }
}

async function tryZillowViaZenRows(req: AvmRequest): Promise<AvmResult | null> {
  try {
    const { scrapeWithZenRows } = await import("@/lib/external/zenrows-client")
    // Zillow URL pattern: /homes/<address>_rb/
    const slug = req.address.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()
    const url = `https://www.zillow.com/homes/${slug}_rb/`
    const response = await scrapeWithZenRows(url, { jsRender: true, premiumProxy: true })
    if (!response || !response.body) return null
    // Parse Zestimate from HTML body — looks for `"zestimate":NUMBER` JSON pattern
    const m = response.body.match(/"zestimate"\s*:\s*(\d+)/i)
    if (!m) return null
    const value = parseInt(m[1], 10)
    if (!value || value < 10000) return null
    return {
      value,
      confidence: 0.65,
      source: "zenrows_zillow",
      fetchedAt: new Date().toISOString(),
      notes: "Zillow Zestimate scraped via ZenRows",
    }
  } catch {
    return null
  }
}

async function tryPerplexitySonar(req: AvmRequest): Promise<AvmResult | null> {
  try {
    const { generateTextRouted } = await import("@/lib/ai/models")
    const { text } = await generateTextRouted({
      feature: "home_value_estimate",
      prompt:
        `Research the current estimated home value for ${req.address}` +
        (req.city ? `, ${req.city}` : "") +
        (req.state ? `, ${req.state}` : "") +
        (req.zipCode ? ` ${req.zipCode}` : "") +
        `.\n\nUse Redfin, Zillow Zestimate, Realtor.com, public records, and recent comparable sales within 1 mile in the last 6 months. Return JSON ONLY:\n{ "value": <integer dollars>, "confidence": <0-1 float>, "source_count": <int>, "notes": "<brief>" }\n\nReturn JSON only.`,
      temperature: 0.2,
      maxTokens: 400,
    })
    const cleaned = text.replace(/```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim()
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (!match) return null
    const parsed = JSON.parse(match[0]) as { value?: number; confidence?: number; notes?: string }
    if (!parsed.value || parsed.value < 10000) return null
    return {
      value: Math.round(parsed.value),
      confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0.6)),
      source: "perplexity",
      fetchedAt: new Date().toISOString(),
      notes: parsed.notes,
    }
  } catch {
    return null
  }
}

async function tryOsintPublicRecords(_req: AvmRequest): Promise<AvmResult | null> {
  // OSINT client provides life events + property records but not direct AVM.
  // Defer to existing osint-client.ts integration; for AVM we rely on the
  // higher-confidence providers above. Returns null to fall through to
  // appreciation fallback.
  return null
}

async function marketAppreciationFallback(
  cachedValue: number,
  zipCode: string,
  cachedAt: string | null | undefined
): Promise<AvmResult | null> {
  if (!cachedValue) return null

  // Read the newest zip-level trend and apply pro-rata appreciation to the
  // stale cached value for the time elapsed since it was fetched.
  let adjusted = cachedValue
  let trendNote = "no zip trend on file"
  try {
    const { createServiceClient } = await import("@/lib/supabase/service")
    const supabase = createServiceClient()
    const { data: md } = await supabase
      .from("market_data")
      .select("price_trend_pct_1yr, data_date")
      .eq("zip_code", zipCode)
      .not("price_trend_pct_1yr", "is", null)
      .order("data_date", { ascending: false })
      .limit(1)
      .maybeSingle()
    const annualPct = md?.price_trend_pct_1yr != null ? Number(md.price_trend_pct_1yr) : null
    if (annualPct != null && Number.isFinite(annualPct) && cachedAt) {
      const yearsStale = Math.max(0, (Date.now() - new Date(cachedAt).getTime()) / (365.25 * 24 * 60 * 60 * 1000))
      // Clamp: never extrapolate beyond 3 years or ±25%/yr of drift.
      const clampedYears = Math.min(yearsStale, 3)
      const clampedPct = Math.max(-25, Math.min(25, annualPct))
      adjusted = Math.round(cachedValue * Math.pow(1 + clampedPct / 100, clampedYears))
      trendNote = `${clampedPct}%/yr zip trend applied over ${clampedYears.toFixed(1)}y`
    }
  } catch {
    /* trend read is best-effort — fall through with the raw cached value */
  }

  return {
    value: adjusted,
    confidence: 0.4,
    source: "market_appreciation_fallback",
    fetchedAt: new Date().toISOString(),
    notes: `Stale cached value adjusted for zip ${zipCode} (${trendNote})`,
  }
}

// ─── Helpers used by signal generators ──────────────────────────────────────

/**
 * Compute equity ratio (0..1). Prefers true equity from `transactions.purchase_price`
 * + `transactions.close_date` (clients we represented). Falls back to a
 * heuristic using zip-level appreciation when only the cached AVM is available.
 *
 * @returns ratio in 0..1, or null if neither data set is sufficient.
 */
export function computeEquityRatio(input: {
  currentAvm: number | null
  purchasePrice?: number | null
  purchaseDate?: string | null
  /** Years owned, used as fallback when purchaseDate isn't available */
  yearsOwned?: number | null
  /** Zip-level appreciation per year as decimal, e.g., 0.05 = 5% */
  zipAnnualAppreciation?: number | null
  /** Assumed initial loan-to-value at purchase time when we don't know mortgage balance */
  assumedInitialLtv?: number
  /** Assumed years of mortgage paydown over hold period — light approximation */
  assumedAnnualPaydownPct?: number
}): number | null {
  const ltv = input.assumedInitialLtv ?? 0.8
  const paydown = input.assumedAnnualPaydownPct ?? 0.015 // ~1.5%/yr early-amort

  if (!input.currentAvm || input.currentAvm <= 0) return null

  // ── Path 1: True equity — we have purchase_price + close_date ────────
  if (input.purchasePrice && input.purchasePrice > 0) {
    const yrs = input.purchaseDate
      ? (Date.now() - new Date(input.purchaseDate).getTime()) / (365.25 * 24 * 60 * 60 * 1000)
      : input.yearsOwned ?? 0
    // Estimated remaining balance = initial loan minus accumulated paydown
    const initialLoan = input.purchasePrice * ltv
    const remainingPct = Math.max(0, 1 - paydown * yrs)
    const remainingBalance = initialLoan * remainingPct
    const equity = input.currentAvm - remainingBalance
    return Math.max(0, Math.min(1, equity / input.currentAvm))
  }

  // ── Path 2: Heuristic — only have AVM + tenure + zip appreciation ────
  if (input.yearsOwned != null && input.yearsOwned > 0 && input.zipAnnualAppreciation != null) {
    // Imply purchase_price from current AVM and appreciation
    const impliedPurchase = input.currentAvm / Math.pow(1 + input.zipAnnualAppreciation, input.yearsOwned)
    const initialLoan = impliedPurchase * ltv
    const remainingPct = Math.max(0, 1 - paydown * input.yearsOwned)
    const remainingBalance = initialLoan * remainingPct
    const equity = input.currentAvm - remainingBalance
    return Math.max(0, Math.min(1, equity / input.currentAvm))
  }

  return null
}

/**
 * Parse free-text length_of_residence into approximate years.
 *   "5+ years"  → 5
 *   "10 years"  → 10
 *   "Less than 1 year" → 0.5
 *   numeric strings → number
 */
export function parseLengthOfResidence(text: string | null | undefined): number | null {
  if (!text) return null
  const t = text.toLowerCase().trim()
  if (/less than\s*1/.test(t)) return 0.5
  const m = t.match(/(\d+(?:\.\d+)?)/)
  if (!m) return null
  const n = parseFloat(m[1])
  if (isNaN(n)) return null
  return n
}
