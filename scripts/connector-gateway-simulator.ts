/**
 * scripts/connector-gateway-simulator.ts
 *
 * Runnable contract test for lib/agentic-os/connector-gateway — the single outbound HTTP path for
 * every external vendor (scrapers, enrichment, AI providers). Validates the documented "never
 * throws" guarantee callers (insertRawRecord, peopledata-client, batchdata-client, zenrows-client,
 * apify-client, exa-client, tavily-client) depend on.
 *
 * Run: `npx tsx scripts/connector-gateway-simulator.ts`
 */
import { callConnector } from "../lib/agentic-os/connector-gateway"

let pass = 0, fail = 0
const checks: Array<[string, () => Promise<any>, (r: any) => boolean]> = [
  ["unreachable host → ok=false (no throw)", async () => callConnector<any>({
      connector: "gw-test-unreachable",
      baseUrl:   "https://this-host-does-not-exist-1234567.invalid",
      path:      "ping",
      method:    "GET",
    }), r => r.ok === false && r.data === null && r.error !== null],
  ["malformed URL → ok=false (no throw)", async () => callConnector<any>({
      connector: "gw-test-bad-url",
      baseUrl:   "ht!tp://not a url",
      path:      "/x",
      method:    "GET",
    }), r => r.ok === false && typeof r.error === "string"],
  ["auth omitted → no throw on auth.style access", async () => callConnector<any>({
      connector: "gw-test-no-auth",
      baseUrl:   "https://this-host-does-not-exist-2345678.invalid",
      path:      "/p",
      method:    "GET",
    }), r => r.ok === false],
  ["explicit auth:'none' still works", async () => callConnector<any>({
      connector: "gw-test-auth-none",
      baseUrl:   "https://this-host-does-not-exist-3456789.invalid",
      path:      "/p",
      method:    "GET",
      auth:      { style: "none" } as any,
    }), r => r.ok === false],
]

for (const [name, fn, check] of checks) {
  try {
    const r = await fn()
    if (check(r)) { console.log(` ✓ ${name}`); pass++ }
    else { console.log(` ✗ ${name} → ${JSON.stringify({ ok: r.ok, status: r.status, err: r.error?.slice?.(0, 120) })}`); fail++ }
  } catch (e: any) { console.log(` ✗ ${name} → THREW: ${e.message}`); fail++ }
}

// ── Wave 98 (lane 98C): PROVIDER HEALTH STATE derived from the gateway's own ledger rows ──────────
// The RULE (not a waypoint): every state is reached from outcomes alone, only `failing` routes around,
// the router skips a failing provider for the cool-down, and a 4xx request_rejected is neutral.
{
  const { deriveProviderHealth, PROVIDER_HEALTH_POLICY: P } = await import("../lib/agentic-os/connector-gateway")
  const { readFileSync } = await import("node:fs")
  const { stripComments } = await import("./strip-comments")
  const now = new Date("2026-10-03T12:00:00Z")
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString()
  const ok = (ms: number) => ({ at: ago(ms), ok: true, errorType: null })
  const bad = (ms: number, t = "provider_error") => ({ at: ago(ms), ok: false, errorType: t })
  const streak = Array.from({ length: P.failingStreak }, (_, i) => bad(60_000 * (i + 1)))
  const h = (rows: any[]) => deriveProviderHealth(rows, now)
  const expect = (name: string, cond: boolean, detail?: unknown) => {
    if (cond) { console.log(` ✓ ${name}`); pass++ } else { console.log(` ✗ ${name} → ${JSON.stringify(detail)}`); fail++ }
  }
  expect("health: no traffic → healthy, says so, not routed around", h([]).state === "healthy" && !h([]).routeAround && /no evidence/.test(h([]).reason))
  expect("health: all successes → healthy", h([ok(1000), ok(2000)]).state === "healthy")
  expect("health: one fault among successes → degraded", h([bad(1000), ok(2000), ok(3000)]).state === "degraded", h([bad(1000), ok(2000), ok(3000)]))
  expect("health: newest is a 429 under the streak → rate_limited", h([bad(1000, "rate_limited"), ok(2000)]).state === "rate_limited")
  const failing = h(streak)
  expect(`health: ${P.failingStreak} consecutive faults inside the cool-down → failing AND routed around (cool-down set)`, failing.state === "failing" && failing.routeAround && !!failing.cooldownUntil, failing)
  const stale = h(streak.map((r) => ({ ...r, at: new Date(new Date(r.at).getTime() - P.cooldownMs).toISOString() })))
  expect("health: the same streak after the cool-down → fallback (half-open probe), NOT routed around", stale.state === "fallback" && !stale.routeAround, stale)
  expect("health: a success after a failing streak → recovered", h([ok(500), ...streak]).state === "recovered")
  expect("health: request_rejected 4xx rows are NEUTRAL — three of them are not a failing provider (positive control: three provider_error rows are)",
    h(streak.map((r) => ({ ...r, errorType: "request_rejected" }))).state === "healthy" && failing.routeAround)
  expect("health: only `failing` routes around (every other state keeps the provider in the chain)",
    [h([]), h([bad(1000), ok(2000)]), stale, h([ok(500), ...streak]), h([bad(1000, "rate_limited")])].every((x) => !x.routeAround))
  const rail = stripComments(readFileSync("lib/ai-isa/property-lookup-rail.ts", "utf8"))
  expect("WIRED: the property rail consults provider health for the RentCast rung and skips it when routeAround (falls to the next rung)",
    /if \(rung === "rentcast"\)[\s\S]{0,300}?\("rentcast"\)[\s\S]{0,200}?routeAround[\s\S]{0,200}?continue/.test(rail))
  expect("WIRED: the Versium contact leg consults provider health and skips (caller's chain → PeopleData) when routeAround",
    /\("versium"\)[\s\S]{0,200}?routeAround[\s\S]{0,200}?provider_failing/.test(rail))
  expect("WIRED: the provider posture board derives the same state from the same ledger rows",
    /deriveProviderHealth\(/.test(stripComments(readFileSync("lib/platform/provider-posture.ts", "utf8"))))
  // Executed: the rail really routes around a failing RentCast (injected health + rungs — zero network).
  const { lookupPropertyForConversation } = await import("../lib/ai-isa/property-lookup-rail")
  const calls: string[] = []
  const rung = (name: string) => async () => { calls.push(name); return null }
  const req = { brokerageId: "00000000-0000-0000-0000-000000000001", purpose: "conversation", audience: "staff", address: { street: "1 Main St", city: "Austin", state: "TX", zip: "78701" } } as any
  const deps = (route: boolean) => ({
    rungs: { cache: rung("cache"), tenant_idx: rung("tenant_idx"), rentcast: rung("rentcast"), public_records: rung("public_records"), batchdata: rung("batchdata") } as any,
    policy: { batchDataTier: "off", batchDataOptedIn: false } as any,
    providerHealth: async () => ({ state: route ? "failing" : "healthy", routeAround: route, reason: "proof" }),
  })
  const routed = await lookupPropertyForConversation(req, deps(true))
  const routedCalls = [...calls]; calls.length = 0
  await lookupPropertyForConversation(req, deps(false))
  expect("EXECUTED: a failing RentCast is skipped (never called) and the ladder continues; a healthy one is called (positive control)",
    !routedCalls.includes("rentcast") && routedCalls.includes("public_records") && routed.skipped.some((s: any) => s.rung === "rentcast" && /failing/.test(s.reason)) && calls.includes("rentcast"),
    { routedCalls, calls })
}

// ── Wave 99 (lane 99C, OWNER LAW 3): THE AVM CHAIN ON THE SAME HEALTH-AWARE ROUTER ─────────────────
// lib/avm/provider-chain.ts::requestPropertyValuation — the property_valuation capability. EXECUTED
// with injected seams (health, eligibility, RentCast, the BatchData gate/fetch/meter/cache): zero
// network, zero database. Each scenario has its positive control beside it.
{
  const { createRequire } = await import("node:module")
  const _require = createRequire(import.meta.url)
  try { const so = _require.resolve("server-only"); _require.cache[so] = { id: so, filename: so, loaded: true, exports: {} } as any } catch { /* nothing to shim */ }
  const chain = await import("../lib/avm/provider-chain")
  const railMod = await import("../lib/ai-isa/property-lookup-rail")
  const { RENTCAST_USD_PER_REQUEST } = await import("../lib/property/rentcast")
  const { BATCHDATA_PROPERTY_SEARCH_RECORD_COST_USD } = await import("../lib/external/batchdata-client")
  const expect = (name: string, cond: boolean, detail?: unknown) => {
    if (cond) { console.log(` ✓ ${name}`); pass++ } else { console.log(` ✗ ${name} → ${JSON.stringify(detail)}`); fail++ }
  }
  const calls: string[] = []
  const metered: any[] = []
  const NORMALIZED = new Set(["value", "confidence", "source", "fetchedAt", "notes", "rangeLow", "rangeHigh"])
  const deps = (o: { rcFailing?: boolean; rcAnswer?: "value" | "no_record" | "error"; overBudget?: boolean; cacheHit?: boolean } = {}) => ({
    providerHealth: async (k: string) => ({ state: o.rcFailing && k === "rentcast" ? "failing" : "healthy", routeAround: !!o.rcFailing && k === "rentcast", reason: "proof" }),
    eligibility: async () => ({ eligible: true, overBudget: !!o.overBudget }),
    rentcast: async () => {
      calls.push("rentcast")
      const a = o.rcAnswer ?? "value"
      return a === "value"
        ? { value: 500000, rangeLow: 480000, rangeHigh: 520000, outcome: "answered" as const, eligibility: { reason: null }, cacheHit: !!o.cacheHit }
        : { value: null, rangeLow: null, rangeHigh: null, outcome: a, eligibility: { reason: null }, cacheHit: false }
    },
    fallback: {
      // THE REAL gate decision (decideBatchDataAccess) over an injected policy — over_budget must still refuse.
      access: async (r: any) => railMod.decideBatchDataAccess(r, { batchDataTier: "lean", batchDataOptedIn: false }),
      fetch: async () => { calls.push("batchdata"); return { ok: true, found: true, facts: null, valuation: { value: 490000, rangeLow: 470000, rangeHigh: 515000 }, comps: [], cost: BATCHDATA_PROPERTY_SEARCH_RECORD_COST_USD, error: null } as any },
      meter: async (m: any) => { metered.push(m) },
      cache: null,
    },
  })
  const run = async (o: Parameters<typeof deps>[0], exclude?: string[]) => {
    calls.length = 0; metered.length = 0
    const r = await chain.requestPropertyValuation({ brokerageId: "00000000-0000-0000-0000-000000000001", address: "1 Main St, Austin, TX 78701", exclude }, deps(o))
    return { r, calls: [...calls], metered: [...metered] }
  }

  const healthy = await run({})
  expect("AVM all-healthy: RentCast answers FIRST and alone — BatchData never called (behaviour unchanged)",
    healthy.r.valuation?.source === "rentcast" && healthy.r.valuation.value === 500000 && healthy.calls.join(",") === "rentcast" && healthy.r.skipped.length === 0, healthy)
  expect("AVM all-healthy: the cost the RentCast leg metered is reported (RENTCAST_USD_PER_REQUEST); a 14-day cache hit reports $0 (positive control)",
    healthy.r.costUsd === RENTCAST_USD_PER_REQUEST && (await run({ cacheHit: true })).r.costUsd === 0)

  const failing = await run({ rcFailing: true })
  expect("AVM: a FAILING RentCast is skipped (never called) and the capability falls through to the BatchData backup",
    !failing.calls.includes("rentcast") && failing.calls.join(",") === "batchdata" && failing.r.valuation?.source === "batchdata"
    && failing.r.rentcastMiss === "error" && failing.r.skipped.some((s) => s.provider === "rentcast" && /provider_failing/.test(s.reason)), failing)
  expect("AVM: the backup's cost is METERED through the existing path (meterVendorSpend shape: vendor batchdata, property_fallback_avm, answered_by + fallback_for) and reported",
    failing.metered.length === 1 && failing.metered[0].vendorName === "batchdata" && failing.metered[0].usageType === "property_fallback_avm"
    && failing.metered[0].cost === BATCHDATA_PROPERTY_SEARCH_RECORD_COST_USD && failing.metered[0].metadata?.answered_by === "batchdata"
    && failing.metered[0].metadata?.fallback_for === "rentcast" && failing.r.costUsd === BATCHDATA_PROPERTY_SEARCH_RECORD_COST_USD, failing.metered)
  expect("AVM: the result shape is NORMALIZED — the same keys whichever provider answered, never vendor JSON (no price/priceRangeLow/vendor body)",
    [healthy.r.valuation, failing.r.valuation].every((v) => !!v && Object.keys(v).every((k) => NORMALIZED.has(k)) && typeof v.value === "number" && "rangeLow" in v && "rangeHigh" in v),
    [healthy.r.valuation, failing.r.valuation].map((v) => v && Object.keys(v)))

  const noRecord = await run({ rcAnswer: "no_record" })
  expect("AVM all-healthy, RentCast has no record → the wave-93 backup still answers (RentCast THEN BatchData — unchanged)",
    noRecord.calls.join(",") === "rentcast,batchdata" && noRecord.r.valuation?.source === "batchdata" && noRecord.r.rentcastMiss === "no_record", noRecord)
  const over = await run({ overBudget: true })
  expect("AVM over budget: neither RentCast nor the paid backup is called (over_budget is not a fallback trigger) — positive control for the failing case",
    over.calls.length === 0 && over.r.valuation === null && over.r.overBudget && over.r.rentcastMiss === "over_budget", over)
  const agentSurface = await run({ rcFailing: true }, ["batchdata"])
  expect("AVM: a caller exclusion holds even when RentCast is failing (AI-agent surfaces pass skipProviders [\"batchdata\"]) — nothing paid is called",
    agentSurface.calls.length === 0 && agentSurface.r.valuation === null && agentSurface.r.skipped.some((s) => s.provider === "batchdata" && /excluded/.test(s.reason)), agentSurface)
  const tenantless = await chain.requestPropertyValuation({ brokerageId: null, address: "1 Main St" }, deps({}))
  expect("AVM: a tenant-less request reaches no provider (§4) — refused with a reason",
    tenantless.valuation === null && tenantless.providersTried.length === 0 && /no tenant/.test(tenantless.skipped[0]?.reason ?? ""), tenantless)
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
