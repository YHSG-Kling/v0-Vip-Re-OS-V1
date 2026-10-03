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

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
