#!/usr/bin/env tsx
/**
 * scripts/wave156-g-provider-economics-guard.ts — test:wave156-g-provider-economics (wave 156, lane 156G)
 *
 * PROVIDER ECONOMICS: cost per VERIFIED USABLE PERSON, a real pre-pull discipline, and the spend rules the vendors do not
 * enforce for us. Every section DRIVES exported product code with counted seams (scripts/deal-desk-guard.ts harness:
 * node:module registerHooks, scripts/in-memory-supabase.ts). No provider is reached, nothing is bought, no key is real.
 *
 * §A  RENTCAST BOOKS SUCCESSFUL REQUESTS ONLY. RentCast: "We only track the number of successful API requests … returns a 200
 *     status code and a response body … You will also not be billed for requests that return an error"
 *     (developers.rentcast.io/reference/billing-and-pricing, read 2026-11-25). getRentcastPropertyRecord is driven against a
 *     counted gateway: a 500 books ZERO ledger rows; a 200 books exactly one at RENTCAST_USD_PER_REQUEST (positive control).
 * §B  THE SAME PROPERTY IS NOT PURCHASED TWICE. Two concurrent reads of one address → ONE vendor request, ONE ledger row; a
 *     later read is a cache hit (0 requests); two DIFFERENT addresses → two requests (positive control).
 * §C  THE PLATFORM'S OWN RENTCAST HARD CUTOFF (RentCast: "We do not currently support hard usage caps"). Driven through the
 *     REST reader AND the MCP tool door: at the plan-included ceiling (1,000 successful requests this month, no owner
 *     setting) the request is REFUSED with zero egress; at 999 it is allowed once and the next is refused (reservation);
 *     an owner ceiling (m1019) wins; an unreadable ledger refuses (fail closed); an un-applied column reads as the plan
 *     ceiling; the MCP door books nothing for a failed call.
 * §D  DATAFINITI: A DORMANT ACCOUNT MAKES ZERO SPEND, A FREE COUNT NEVER DOWNLOADS, TENANT CREDENTIALS STAY TENANT-OWNED.
 *     runDatafinitiDatasetDoor is driven with a counted transport: the platform route at the declared activation
 *     (dormant_pending_rights) makes 0 calls (not even the free schema); a tenant connection pending the owner's licensing
 *     makes 0 calls; another tenant's connection is refused with 0 calls; a tenant credential with no token is refused and
 *     NEVER falls back to the platform token. Positive control: with activation + rights flipped IN THE TEST ONLY, a
 *     preflight runs df_get_schema + df_count (free) and nothing else — no df_search, no df_start_download, 0 charged.
 * §E  THE PRE-PULL WATERFALL IN THE EXISTING ROUTER (decidePrePull over routeCapability): every stage — own record $0,
 *     already purchased, free count first, nothing found, held (license / budget unreadable / over budget), raw evidence
 *     when identity is insufficient, the cheapest LICENSED provider for the missing fields only, a narrow supplement — and
 *     FAILOVER ONLY WHERE LICENSED: a dormant provider is never a failover target (positive control: active → it is).
 *     The Versium contact leg asks the waterfall's rights step (comment-stripped source).
 * §F  THE VERSIUM MINIMUM IS MODELED (costUnderCommitment): the $5,000 / 250,000-credit annual plan costs $416.67 a month
 *     whatever is used, so at 1,000 matches a month the real rate is ~$0.42, not the marketing "$0.02 and lower".
 * §G  COHORT FINANCE (foldCohortFinance / loadAcquisitionEconomics): unknown components stay unknown (lower bound flagged),
 *     no match rate is fabricated, person-data enrichment spend is counted, tenant-paid spend is not the platform's.
 * §H  A SIMULATED OR DORMANT PROVIDER IS NEVER DISPLAYED AS LIVE CONNECTED: the settings services registry (getServicesRegistry)
 *     shows BatchData / PeopleData — dormant survivors — as "dormant", never "connected"; the platform provider console's
 *     test route labels an accepted BatchData key with its dormant routing and makes NO billed HouseCanary valuation call;
 *     the capability matrix has no "ready" route without live evidence.
 *
 * RED AT BASE: G156_ROOT=/home/user/v0-Vip-Re-OS-V1 npx tsx scripts/wave156-g-provider-economics-guard.ts loads that tree's
 * modules. Expected red there: §A failed-request booking, §B concurrent double purchase, §C every cutoff check, §E/§F/§G (the
 * functions did not exist), §H dormant shown as connected and the billed HouseCanary call. §D is green at base on purpose —
 * the Datafiniti door was already correct and this guard pins it.
 *
 * BLIND SPOTS (published): the cutoff counts a calendar month (RentCast's period starts on the activation day); fire-and-
 * forget ledger writes let separate serverless instances overshoot by the requests in flight between ledger reads (30 s);
 * the connector-health probe's RentCast /markets call (lib/agentic-os/connector-probe.ts) is unmetered and outside the
 * counter; no live call was made, so the 200-vs-error billing rule is the vendor's documentation, not an observed invoice.
 */
import { registerHooks } from "node:module"
import { readFileSync, existsSync, statSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { join } from "node:path"
import { memSupabase, type MemClient } from "./in-memory-supabase"
import { stripComments } from "./strip-comments"

const WT = process.cwd()
const ROOT = process.env.G156_ROOT || WT
let passed = 0, failed = 0
const fails: string[] = []
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; fails.push(name); console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 300)}`}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const raw = (f: string): string => { const p = join(ROOT, f); return existsSync(p) ? readFileSync(p, "utf8") : "" }

const B1 = "b0000001-0000-4000-8000-000000000156", B2 = "b0000002-0000-4000-8000-000000000156", U1 = "a0000001-0000-4000-8000-000000000156"
const thisMonth = () => new Date().toISOString().slice(0, 7)

// ═══ seams ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
const G = globalThis as any
G.__G = {
  mem: memSupabase({}) as MemClient,
  gateway: [] as any[], gatewayAnswer: (_req: any) => ({ ok: true, status: 200, data: [{ id: "p1", formattedAddress: "x", bedrooms: 3 }], error: null }),
  usage: [] as any[], meter: [] as any[], cache: new Map<string, unknown>(), mcp: [] as any[], mcpOk: true,
}
process.env.RENTCAST_API_KEY = "fixture-not-a-key"
const realUrl = (p: string) => pathToFileURL(join(ROOT, p)).href
const OVERRIDE: Record<string, string> = {
  "lib/supabase/service.ts": "export function createServiceClient(){ return globalThis.__G.mem }",
  "lib/supabase/server.ts": "export async function createClient(){ return globalThis.__G.mem }",
  "lib/agentic-os/connector-gateway.ts": "export async function callConnector(req){ globalThis.__G.gateway.push(req); return globalThis.__G.gatewayAnswer(req) }; export async function loadProviderHealth(){ return { state: 'healthy', routeAround: false, reason: 'fixture' } }",
  "lib/vendor-governance/usage-logger.ts": "export async function logVendorUsage(e){ globalThis.__G.usage.push(e); return { ok: true } }",
  "lib/vendor-governance/meter-vendor.ts": "export async function meterVendorSpend(m){ globalThis.__G.meter.push(m); return true }",
  "lib/cma/comp-supplement-cache.ts": "export async function getCachedProviderPayload(k){ return globalThis.__G.cache.get(k) ?? null }; export async function setCachedProviderPayload(k, p){ globalThis.__G.cache.set(k, p) }",
  "lib/connections/resolve-scoped.ts": "export async function resolveScopedConnectionResult(){ return { status: 'not_connected' } }",
  "lib/vendor-governance/budget-gate.ts": "export async function checkVendorBudget(){ return { allowed: true, degraded: false } }",
  "lib/external/rentcast-mcp.ts": "export async function listRentcastMcpTools(){ return { ok: true, tools: [{ name: 'property_lookup', description: 'fixture', inputSchema: { type: 'object', properties: {} } }] } }; export async function callRentcastMcp(name, args){ globalThis.__G.mcp.push({ name, args }); return globalThis.__G.mcpOk ? { ok: true, data: { fixture: true } } : { ok: false, error: 'fixture 500' } }",
  "lib/identity/get-agent-context.ts": "export async function getAgentContext(){ return { brokerageId: globalThis.__G.brokerageId ?? null, userId: null, agentId: null } }",
  "lib/kernel/api-auth.ts": "export async function requireSuperadminAuth(){ return { ok: true, userId: 'staff' } }",
}
const BY_SPEC: Record<string, string> = {
  "server-only": "export {}",
  "next/cache": "export function revalidatePath(){}; export function revalidateTag(){}; export function unstable_noStore(){}; export function unstable_cache(f){ return f }",
  "next/headers": "export async function headers(){ return new Map() }; export async function cookies(){ return { get(){}, getAll(){ return [] }, set(){}, delete(){} } }",
}
const dataUrl = (code: string) => `data:text/javascript,${encodeURIComponent(code)}`
function aliasPath(rel: string): string | null {
  for (const c of [rel, `${rel}.ts`, `${rel}.tsx`, `${rel}/index.ts`, `${rel}/index.tsx`]) {
    const p = join(ROOT, c)
    if (existsSync(p) && !statSync(p).isDirectory()) return p
  }
  return null
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    if (BY_SPEC[spec] !== undefined) return { url: dataUrl(BY_SPEC[spec]), shortCircuit: true }
    const aliased = spec.startsWith("@/") ? aliasPath(spec.slice(2)) : null
    const r = aliased ? { url: pathToFileURL(aliased).href, shortCircuit: true } : next(spec, ctx)
    if (String(ctx?.parentURL ?? "").startsWith("data:")) return r
    const path = String(r.url ?? "").split("?")[0]
    const ov = Object.keys(OVERRIDE).find((k) => path === realUrl(k))
    if (ov) return { url: dataUrl(`export * from ${JSON.stringify(realUrl(ov))}; ${OVERRIDE[ov]}`), shortCircuit: true }
    return r
  },
})
const load = (p: string) => import(pathToFileURL(join(ROOT, p)).href)

function ledgerRows(n: number, month = thisMonth()) {
  return Array.from({ length: n }, (_, i) => ({ id: `v${i}`, vendor_name: "rentcast", units_used: 1, total_cost: 0.074, created_at: `${month}-02T00:00:00.000Z`, request_metadata: {} }))
}
async function world(opts: { used?: number; setting?: unknown; refuseLedger?: boolean; settingsColumnMissing?: boolean } = {}) {
  G.__G.mem = memSupabase({
    platform_settings: [{ id: true, ...(opts.settingsColumnMissing ? {} : { provider_request_caps: opts.setting ?? null }) }],
    vendor_usage_tracking: ledgerRows(opts.used ?? 0),
  }, { ...(opts.refuseLedger ? { refuse: { vendor_usage_tracking: "permission denied (fixture)" } } : {}), ...(opts.settingsColumnMissing ? { missingColumns: { platform_settings: ["provider_request_caps"] } } : {}) })
  G.__G.gateway = []; G.__G.usage = []; G.__G.meter = []; G.__G.mcp = []; G.__G.mcpOk = true
  G.__G.gatewayAnswer = () => ({ ok: true, status: 200, data: [{ id: "p1", formattedAddress: "x", bedrooms: 3 }], error: null })
  try { (await load("lib/property/rentcast-eligibility.ts")).resetRentcastPlatformCapState?.() } catch { /* base */ }
}
let addrN = 0
const addr = () => `${100 + ++addrN} Fixture Ln, Testville, TX 7${String(addrN).padStart(4, "0")}`
const rentcastCalls = () => (G.__G.gateway as any[]).filter((r) => r.connector === "rentcast").length

async function main() {
  console.log(`wave156-g-provider-economics-guard (modules from ${ROOT === WT ? "this tree" : ROOT})`)
  const rc = await load("lib/property/rentcast.ts")
  const caller = { brokerageId: B1 }

  section("§A RentCast books successful requests only")
  await world()
  G.__G.gatewayAnswer = () => ({ ok: false, status: 500, data: null, error: "fixture 500" })
  const failedRead = await rc.getRentcastPropertyRecord({ ...caller, address: addr() })
  check("a 500 reached the vendor once (the request was made)", rentcastCalls() === 1, rentcastCalls())
  check("a failed (non-200) RentCast request books ZERO ledger rows — RentCast does not bill an error", failedRead === null && G.__G.usage.length === 0, G.__G.usage)
  await world()
  await rc.getRentcastPropertyRecord({ ...caller, address: addr() })
  check("positive control: a 200 books exactly one row at RENTCAST_USD_PER_REQUEST", G.__G.usage.length === 1 && G.__G.usage[0].estimatedCost === rc.RENTCAST_USD_PER_REQUEST && G.__G.usage[0].vendorName === "rentcast", G.__G.usage)

  section("§B the same property is not purchased twice")
  await world()
  const same = addr()
  await Promise.all([rc.getRentcastPropertyRecord({ ...caller, address: same }), rc.getRentcastPropertyRecord({ ...caller, address: same })])
  check("two CONCURRENT reads of one address make ONE vendor request", rentcastCalls() === 1, rentcastCalls())
  check("…and book ONE ledger row", G.__G.usage.length === 1, G.__G.usage.length)
  await rc.getRentcastPropertyRecord({ ...caller, address: same })
  check("a later read of the same address is a cache hit — still one request in total", rentcastCalls() === 1, rentcastCalls())
  await world()
  await Promise.all([rc.getRentcastPropertyRecord({ ...caller, address: addr() }), rc.getRentcastPropertyRecord({ ...caller, address: addr() })])
  check("positive control: two DIFFERENT addresses make two requests", rentcastCalls() === 2, rentcastCalls())

  section("§C the platform's own RentCast hard cutoff (RentCast has none)")
  const el = await load("lib/property/rentcast-eligibility.ts")
  check("the cutoff exists beside the ONE RentCast gate (reserveRentcastPlatformRequest / decideRentcastPlatformCap)", typeof el.reserveRentcastPlatformRequest === "function" && typeof el.decideRentcastPlatformCap === "function")
  const included = el.RENTCAST_PLAN_INCLUDED_REQUESTS ?? 1000
  await world({ used: included })
  const atCap = await rc.getRentcastPropertyRecord({ ...caller, address: addr() })
  check(`at the plan-included ceiling (${included} successful requests this month, no owner setting) the REST read is refused with ZERO egress`, atCap === null && rentcastCalls() === 0, { calls: rentcastCalls() })
  check("…and books nothing", G.__G.usage.length === 0)
  await world({ used: included - 1 })
  await rc.getRentcastPropertyRecord({ ...caller, address: addr() })
  await rc.getRentcastPropertyRecord({ ...caller, address: addr() })
  check("one below the ceiling: the next request goes out, the one after is refused (in-process reservation)", rentcastCalls() === 1, rentcastCalls())
  await world({ used: 5, setting: { rentcast: { monthly_requests: 5 } } })
  await rc.getRentcastPropertyRecord({ ...caller, address: addr() })
  check("an OWNER ceiling (m1019 provider_request_caps.rentcast.monthly_requests = 5) is enforced at 5", rentcastCalls() === 0, rentcastCalls())
  await world({ used: 4, setting: { rentcast: { monthly_requests: 5 } } })
  await rc.getRentcastPropertyRecord({ ...caller, address: addr() })
  check("positive control: under the owner ceiling the request goes out", rentcastCalls() === 1, rentcastCalls())
  await world({ refuseLedger: true })
  await rc.getRentcastPropertyRecord({ ...caller, address: addr() })
  check("an UNREADABLE request ledger refuses (fail closed) — zero egress", rentcastCalls() === 0, rentcastCalls())
  await world({ settingsColumnMissing: true })
  const v = await el.reserveRentcastPlatformRequest?.().catch(() => null)
  check("before m1019 is applied (column absent) the plan-included ceiling applies, said in capSource", v?.allowed === true && v?.verdict?.capSource === "plan_included_requests" && v?.verdict?.cap === included, v?.verdict)
  // The MCP tool door.
  const tools = await load("lib/external/rentcast-ai-tools.ts")
  await world({ used: included })
  const reg = await tools.rentCastMcpTools({ brokerageId: B1, userId: U1 })
  const t = Object.values(reg)[0] as any
  const capped = t ? await t.execute({}, { toolCallId: "x", messages: [] }) : null
  check("the MCP tool door is refused at the ceiling — no MCP call, nothing metered", !!t && capped?.success === false && G.__G.mcp.length === 0 && G.__G.meter.length === 0, { capped, mcp: G.__G.mcp.length, meter: G.__G.meter.length })
  await world()
  G.__G.mcpOk = false
  const reg2 = await tools.rentCastMcpTools({ brokerageId: B1, userId: U1 })
  const t2 = Object.values(reg2)[0] as any
  await t2?.execute({}, { toolCallId: "y", messages: [] })
  check("a FAILED MCP call books nothing (RentCast bills successful requests only)", G.__G.mcp.length === 1 && G.__G.meter.length === 0, { mcp: G.__G.mcp.length, meter: G.__G.meter })
  G.__G.mcpOk = true
  await t2?.execute({}, { toolCallId: "z", messages: [] })
  check("positive control: a successful MCP call books one row at RENTCAST_USD_PER_REQUEST", G.__G.meter.length === 1 && G.__G.meter[0].cost === rc.RENTCAST_USD_PER_REQUEST, G.__G.meter)

  section("§D Datafiniti — dormant makes zero spend; a free count never downloads; tenant credentials stay tenant-owned")
  const door = await load("lib/lead-pipeline/datafiniti-dataset-door.ts")
  const dc = await load("lib/external/datafiniti-client.ts")
  const df: any[] = []
  const envelope = (payload: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: payload } })
  const transport = async (req: any) => {
    df.push(req)
    const name = req.body?.params?.name
    if (name === "df_get_schema") return { status: 200, data: envelope({ schema: { province: "string", city: "string", mostRecentStatus: "string" } }), error: null, headers: {} }
    if (name === "df_count") return { status: 200, data: envelope({ num_found: 42 }), error: null, headers: {} }
    return { status: 200, data: envelope({ records: [{ id: "r1" }], num_found: 1 }), error: null, headers: {} }
  }
  const need = { dataType: "property", terms: [{ field: "province", op: "eq", value: "TX" }], uses: ["enrichment"], gapFields: ["mostRecentStatus"], delivery: "download", numRecords: 40 }
  const platformRep = await door.runDatafinitiDatasetDoor({ mode: "execute", brokerageId: B1, route: "platform", need, approval: { approvedBy: U1, maxCredits: 1000 }, requestId: "r1" }, { client: { transport, env: { DATAFINITI_API_TOKEN: "fixture" } } })
  check("platform route at the DECLARED activation (dormant_pending_rights): refused at rights, ZERO calls (not even the free schema)", platformRep.refused !== null && platformRep.stage === "rights" && df.length === 0, { stage: platformRep.stage, calls: df.length })
  const pending = { state: "pending_owner_licensing", mayIngest: false, reason: "fixture" }
  const tenantRep = await door.runDatafinitiDatasetDoor({ mode: "execute", brokerageId: B1, route: "tenant", tenantConnection: { id: "c1", brokerageId: B1, token: "tenant-fixture", verdict: pending }, need, approval: { approvedBy: U1, maxCredits: 1000 }, requestId: "r2" }, { client: { transport } })
  check("a tenant's own Datafiniti key pending the owner's licensing decision: ZERO calls", tenantRep.stage === "rights" && df.length === 0, { stage: tenantRep.stage, calls: df.length })
  const crossRep = await door.runDatafinitiDatasetDoor({ mode: "discover", brokerageId: B1, route: "tenant", tenantConnection: { id: "c2", brokerageId: B2, token: "other-tenant", verdict: { state: "connected", mayIngest: true, reason: "" } } }, { client: { transport } })
  check("another tenant's connection never serves this tenant (refused, ZERO calls)", crossRep.refused !== null && /another tenant/.test(crossRep.refused) && df.length === 0, crossRep.refused)
  const noToken = await dc.countDatafinitiPeople({ owner: "tenant", brokerageId: B1, connectionId: "c3", token: null }, { lastName: "Fixture", province: "TX" }, { transport, env: { DATAFINITI_API_TOKEN: "platform-fixture" } })
  check("a tenant credential with no token is refused and NEVER falls back to the platform token (zero calls)", noToken.ok === false && df.length === 0, noToken)
  const permitted = { multi_tenant: "permitted", storage: "permitted", enrichment: "permitted", ai_processing: "permitted", export: "permitted", outreach: "permitted", retentionDays: 30, source: "TEST ONLY" }
  const active = { ...((await load("lib/ai-isa/property-lookup-rail.ts")).PROVIDER_ACTIVATION.datafiniti), state: "active" }
  const pre = await door.runDatafinitiDatasetDoor({ mode: "preflight", brokerageId: B1, route: "platform", need }, { client: { transport, env: { DATAFINITI_API_TOKEN: "fixture" } }, activation: active, rights: permitted })
  const names = df.map((r) => r.body?.params?.name)
  check("positive control (activation + rights flipped IN THE TEST ONLY): a preflight runs df_get_schema + df_count and nothing else", names.length === 2 && names[0] === "df_get_schema" && names[1] === "df_count", names)
  check("…the free count downloaded nothing and charged nothing (no df_search / df_start_download; calls.charged 0)", !names.includes("df_start_download") && !names.includes("df_search") && pre.calls.charged === 0 && pre.count === 42, { calls: pre.calls, count: pre.count })

  section("§E the pre-pull waterfall in the existing router; failover only where licensed")
  const rail = await load("lib/ai-isa/property-lookup-rail.ts")
  const plan = rail.decidePrePull as undefined | ((n: any) => any)
  check("decidePrePull exists in the ONE router file (property-lookup-rail.ts) — no second router", typeof plan === "function")
  if (typeof plan === "function") {
    const fresh = { email: { verified: true, ageDays: 10 }, phone: { verified: true, ageDays: 10 } }
    check("own verified fresh record → reuse, $0, nothing bought", plan({ capability: "owner_contact", materialFields: ["email", "phone"], held: fresh }).stage === "reuse_own_record")
    check("a stale own record is NOT reused (re-asked)", plan({ capability: "owner_contact", materialFields: ["email"], held: { email: { verified: true, ageDays: 400 } } }).stage !== "reuse_own_record")
    check("already purchased inside its window → never bought twice", plan({ capability: "owner_contact", materialFields: ["email"], alreadyPurchased: true }).stage === "already_purchased")
    const fc = plan({ capability: "owner_contact", materialFields: ["email"], freeCount: { available: true, count: null } })
    check("a free count is asked FIRST — no purchase line", fc.stage === "free_count" && fc.buy.length === 0)
    check("a free count of 0 → nothing to buy", plan({ capability: "owner_contact", materialFields: ["email"], freeCount: { available: true, count: 0 } }).stage === "nothing_found")
    const dormantAll = { versium: { state: "dormant_pending_rights" }, batchdata: { state: "dormant_survivor" }, peopledata: { state: "dormant_survivor" } }
    const held = plan({ capability: "owner_contact", materialFields: ["email"], activation: dormantAll })
    check("no licensed provider → HELD with the reason, nothing bought", held.stage === "held" && held.buy.length === 0 && held.reasons.some((r: string) => /license/.test(r)), held)
    check("budget unreadable → held (fail closed)", plan({ capability: "owner_contact", materialFields: ["email"], budgetAllowed: null }).stage === "held")
    check("over budget → held", plan({ capability: "owner_contact", materialFields: ["email"], budgetAllowed: false }).stage === "held")
    check("identity insufficient → keep raw evidence, never an asserted person", plan({ capability: "owner_contact", materialFields: ["email"], identitySufficient: false }).stage === "keep_raw_evidence")
    const mixed = { versium: { state: "active" }, batchdata: { state: "dormant_survivor" }, peopledata: { state: "active" } }
    const sup = plan({ capability: "owner_contact", materialFields: ["email", "phone"], activation: mixed, supplies: { versium: ["email"], batchdata: ["phone"], peopledata: ["phone"] } })
    check("cheapest LICENSED provider buys only its missing fields; a NARROW supplement covers the verified gap", sup.stage === "buy" && sup.buy.length === 2 && sup.buy[0].provider === "versium" && sup.buy[0].fields.join() === "email" && sup.buy[1].provider === "peopledata" && sup.buy[1].fields.join() === "phone", sup.buy)
    check("FAILOVER ONLY WHERE LICENSED: the dormant BatchData (cheaper than PeopleData) is never a failover target", !sup.buy.some((b: any) => b.provider === "batchdata") && sup.reasons.some((r: string) => /batchdata skipped — license/.test(r)), sup.reasons)
    const allActive = plan({ capability: "owner_contact", materialFields: ["email", "phone"], activation: { versium: { state: "active" }, batchdata: { state: "active" }, peopledata: { state: "active" } }, supplies: { versium: ["email"], batchdata: ["phone"], peopledata: ["phone"] } })
    check("positive control: once BatchData is licensed it IS the (cheaper) supplement", allActive.buy[1]?.provider === "batchdata", allActive.buy)
    const r = rail.routeCapability("owner_contact", {}, new Set(), { batchdata: { state: "dormant_survivor" } })
    check("routeCapability with activation leaves a dormant provider out WITH its reason", !r.providers.includes("batchdata") && r.skipped.some((s: any) => s.provider === "batchdata" && /license/.test(s.reason)), r)
    check("routeCapability without activation is unchanged (positive control — existing callers)", rail.routeCapability("owner_contact", {}).providers.includes("batchdata"))
    const gap = plan({ capability: "owner_contact", materialFields: ["email", "phone"], activation: { versium: { state: "active" }, batchdata: { state: "dormant_survivor" }, peopledata: { state: "dormant_survivor" } }, supplies: { versium: ["email"] } })
    check("a gap no LICENSED provider supplies is left missing, never bought from an unlicensed source", gap.stage === "buy" && gap.buy.length === 1 && gap.gap.join() === "phone", gap)
  }
  const legSrc = stripComments(raw("lib/ai-isa/property-lookup-rail.ts"))
  const legBody = legSrc.slice(legSrc.indexOf("export async function runVersiumContactLeg"), legSrc.indexOf("type VersiumLegDeps"))
  check("the Versium contact leg asks the waterfall's rights step before any paid call (stripped source)", /decidePrePull\(/.test(legBody) && legBody.indexOf("decidePrePull(") < legBody.indexOf("appendVersiumContact("))
  check("positive control: the leg-body slice is real (it contains the paid call)", /appendVersiumContact\(/.test(legBody))

  section("§F the Versium minimum is modeled — the marketing floor is not the marginal cost")
  const econ = await load("lib/vendor-governance/acquisition-economics.ts")
  const terms = (econ.PROVIDER_COMMITMENT_TERMS ?? []) as any[]
  const annual = terms.find((x) => x.provider === "versium" && x.termMonths === 12)
  check("the Versium annual commitment is declared with its source and executedQuote: false", !!annual && annual.executedQuote === false && /versium\.com\/pricing/.test(annual.source))
  if (annual && typeof econ.costUnderCommitment === "function") {
    const low = econ.costUnderCommitment(annual, 1_000)
    check("at 1,000 credits a month the $5,000/yr minimum binds: $416.67/month, ~$0.42 per credit (not $0.02)", low.monthlyUsd === 416.67 && low.minimumBinding === true && low.effectiveUnitUsd > 0.4, low)
    const full = econ.costUnderCommitment(annual, 250_000 / 12)
    check("positive control: at full use the effective rate is the plan's $0.02", full.effectiveUnitUsd === 0.02 && full.minimumBinding === false, full)
    const over = econ.costUnderCommitment(annual, 50_000)
    check("past the allowance the overage is priced at the published fixed rate", over.monthlyUsd !== null && over.monthlyUsd > 416.67, over)
    const df10 = terms.find((x) => x.provider === "datafiniti")
    check("an unpublished overage is UNKNOWN (null), never $0", !!df10 && econ.costUnderCommitment(df10, 20_000).monthlyUsd === null)
  } else check("costUnderCommitment exists", false)

  section("§G cohort finance — cost per usable person; unknowns stay unknown")
  if (typeof econ.foldCohortFinance === "function") {
    const c = econ.foldCohortFinance({ subscriptionAllocationUsd: null, billedRequestsUsd: 100, aiToolUsd: null, validationUsd: null, usablePersons: null, promotedLeads: 50, qualifiedContacts: 10, closedOpportunities: null })
    check("an unmeasured numerator part → complete: false (every figure a LOWER BOUND), named in unknowns", c.complete === false && c.unknowns.some((u: string) => /subscription/.test(u)) && c.knownCostUsd === 100)
    check("no blinded match verification → cost per usable person is NULL, never a fabricated match rate", c.costPerUsablePersonUsd === null && c.unknowns.some((u: string) => /correctly matched/.test(u)))
    check("cost per promoted Lead / qualified Contact computed where counted", c.costPerPromotedLeadUsd === 2 && c.costPerQualifiedContactUsd === 10)
    const full = econ.foldCohortFinance({ subscriptionAllocationUsd: 416.67, billedRequestsUsd: 83.33, aiToolUsd: 50, validationUsd: 50, usablePersons: 400, promotedLeads: 100, qualifiedContacts: 20, closedOpportunities: 2 })
    check("positive control: every part known → complete, $600 / 400 usable persons = $1.50", full.complete === true && full.costPerUsablePersonUsd === 1.5 && full.costPerClosedOpportunityUsd === 300, full)
    const since = new Date(Date.now() - 86_400_000).toISOString()
    const now = new Date().toISOString()
    const db = memSupabase({
      vendor_usage_tracking: [
        { id: "1", vendor_name: "versium", total_cost: 0.1, created_at: now, request_metadata: { system_source: "lead_enrichment" } },
        { id: "2", vendor_name: "rentcast", total_cost: 0.074, created_at: now, request_metadata: { system_source: "cma" } },
        { id: "3", vendor_name: "versium", total_cost: 5, created_at: now, request_metadata: { system_source: "lead_enrichment", coverage: "tenant_paid" } },
        { id: "4", vendor_name: "exa", total_cost: 0.4, created_at: now, request_metadata: { system_source: "lead_scraping" } },
      ],
      raw_scraped_leads: [{ id: "r1", dedupe_status: "unique", lead_id: "l1", created_at: now }, { id: "r2", dedupe_status: "duplicate_of_lead", lead_id: null, created_at: now }],
      leads: [{ id: "l1", raw_record_id: "r1", contact_id: "c1", created_at: now }],
    } as never)
    const rep = await econ.loadAcquisitionEconomics(db as never, { sinceIso: since, duplicateUnitUsd: null })
    check("loadAcquisitionEconomics carries the cohort: acquisition $0.40 + person enrichment $0.10 (RentCast property data and tenant-paid rows excluded)", rep.cohort?.knownCostUsd === 0.5, rep.cohort)
    check("…$0.50 per promoted Lead and per qualified Contact, usable person unknown", rep.cohort?.costPerPromotedLeadUsd === 0.5 && rep.cohort?.costPerQualifiedContactUsd === 0.5 && rep.cohort?.costPerUsablePersonUsd === null, rep.cohort)
  } else check("foldCohortFinance exists", false)

  section("§H a simulated or dormant provider is never displayed as live connected")
  process.env.BATCHDATA_API_KEY = "fixture"; process.env.PDL_API_KEY = "fixture"
  G.__G.mem = memSupabase({ brokerage_integrations: [] }); G.__G.brokerageId = B1
  const svcCfg = await load("app/actions/services-config.ts")
  const { services } = await svcCfg.getServicesRegistry()
  const byId = Object.fromEntries((services as any[]).map((s) => [s.id, s.status]))
  check("BatchData (dormant survivor) with a key set reads 'dormant', never 'connected'", byId.batchdata === "dormant", byId)
  check("PeopleData Labs (dormant survivor) reads 'dormant', never 'connected'", byId.peopledatalabs === "dormant", byId)
  check("no env-derived service reads 'connected' (a key being set is not a live connection)", !(services as any[]).some((s) => s.status === "connected"), byId)
  const content = stripComments(raw("app/settings/services/services-content.tsx"))
  check("the settings card words 'configured' and 'dormant' honestly (positive: the labels exist in the rendered source)", /Key configured \(not live-verified\)/.test(content) && /Dormant \(not in use\)/.test(content))
  process.env.HOUSECANARY_API_KEY = "fixture"; process.env.HOUSECANARY_API_SECRET = "fixture"
  const route = await load("app/api/admin/system/providers/test/route.ts")
  const post = async (provider: string) => (await route.POST(new Request("http://x/api", { method: "POST", body: JSON.stringify({ provider }), headers: { "content-type": "application/json" } }) as never)).json()
  G.__G.gateway = []; G.__G.gatewayAnswer = () => ({ ok: false, status: 400, data: null, error: "empty body" })
  const bd = await post("batchdata")
  check("an accepted BatchData key is labelled with its DORMANT routing (the console never shows it as a live connection)", bd.ok === true && bd.routing === "dormant_survivor", bd)
  G.__G.gateway = []
  const hc = await post("housecanary")
  check("the HouseCanary 'test' makes NO billed valuation call", G.__G.gateway.length === 0 && hc.ok === false, { calls: G.__G.gateway.length, hc })
  const client = stripComments(raw("app/dashboard/admin/system/providers/system-providers-client.tsx"))
  check("the console badge reads the routing and says 'dormant, not routed' for a dormant provider", /routing=\{state\.result\?\.routing\}/.test(client) && /dormant, not routed/.test(client))
  const matrix = (await load("lib/providers/provider-capability-matrix.ts")).providerCapabilityMatrix() as any[]
  const readyWithout = matrix.filter((m) => (m.states.platform === "ready" || m.states.tenant === "ready") && !/live: (?!none)/.test(m.validation))
  check("the capability matrix shows no 'ready' route without live evidence", readyWithout.length === 0, readyWithout.map((m) => m.provider))
  check("positive control: the matrix rows are real (rentcast / versium / datafiniti present, Datafiniti awaiting license)", ["rentcast", "versium", "datafiniti"].every((p) => matrix.some((m) => m.provider === p)) && /awaiting/.test(matrix.find((m) => m.provider === "datafiniti")?.honestState ?? ""))

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1) }
}

main().catch((e) => { console.error(e); console.log(`\n${passed} passed, ${failed + 1} failed (threw)`); process.exit(1) })
