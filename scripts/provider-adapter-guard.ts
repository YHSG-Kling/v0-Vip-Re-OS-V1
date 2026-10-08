/**
 * scripts/provider-adapter-guard.ts — test:provider-adapter (wave 137, lane 137C).
 *
 * THE PROVIDER ADAPTER CONTRACT + PROVIDER SELF-HEALING, proven in memory (no network, no database):
 *   A. DERIVATION — every provider the fabric routes (CONTACT_PROVIDER_ROUTES ∪ SYSTEM_DEFAULTS) has ONE
 *      valid declaration; derived count == routed count (derived, never pinned). POSITIVE CONTROLS: a
 *      routed provider with its facts removed is reported missing; a declared provider nothing routes is
 *      reported unrouted.
 *   B. USAGE BOOKING — an executed call books exactly once at the declared price; a refused call books
 *      nothing; a tenant-account adapter books nothing.
 *   C. DOWN → FAILOVER through routeCapability (and a provider with no healthy alternate escalates).
 *   D. UP + VERSION DRIFT → the declared config alternate is applied through the auto-applier (evidence
 *      row, idempotent flip), egress carries it, the call is retried ONCE; a second heal never re-applies.
 *   E. UP + CODE-LEVEL DRIFT → a proposal, nothing applied.
 *   F. VALIDATOR — an unmetered paid adapter is refused (positive control: the real one is valid).
 *   G. CENSUS — no manager / skill module imports a provider client directly (stripped source; positive
 *      control; exceptions published with reasons, a stale exception fails).
 *   H. WIRING + VERSION PINS — the cron calls the healer, the gateway applies the alternate, the
 *      auto-applier knows the kind; declared versions equal the versions the code pins; ONE QuickBooks
 *      minor version (QBO_MINOR_VERSION = 75, wave 139) and no literal pin anywhere (positive control).
 *   I–M (wave 138, 138A) census / research roots / probe routing / failover→healer / one vocabulary.
 *   N. (wave 139, 139B) ZERO HIDDEN PROVIDER CALLS — a raw-fetch census (positive control: a planted
 *      raw fetch to a provider host is flagged), the gateway path is tenant scoped and books its
 *      outcome row (behavioural, fetch stubbed), an unhealthy provider is skipped (egress health
 *      gate; router failover where an alternate exists), the declared transport matches the code.
 *   O. URL INTEGRITY (wave 139, 139D) — every docs / status / changelog URL is on an official domain
 *      and not a placeholder shape, or NULL with its published reason; planted placeholders, an
 *      invented domain and a silent null are each refused (positive controls).
 *   P. VERSIUM PROPERTY (wave 139, 139D) — declared on property_facts ⇒ walked: getPropertyRecordWithFallback
 *      fills ONLY the caller's empty facts through routeCapability (BatchData excluded, budget-gated,
 *      health-aware, booked once); never asked without a named gap; never on property_valuation; the
 *      adapter maps no price / value range / person field.
 * BLIND SPOTS (published): the live probe and the derived health are injected (their own proofs are
 * test:connector-gateway / test:connector-healer); the census reads static + dynamic import specifiers
 * only (a provider reached through a re-export barrel is not seen); the cron route is checked by
 * stripped-source wiring, not executed. Wave 139: URLs are judged by SHAPE + OFFICIAL DOMAIN (no network
 * in a proof) — that a page still answers was verified by the lane's research run (2026-10-08), not
 * here; the declared-alternate apply path runs on a fixture (no live provider declares a config
 * alternate since QBO pins 75), and the real applier is exercised on its refusal path only; the
 * Versium gap fill runs on injected seams (the live Versium call shape is appendVersiumPropertyFacts).
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import {
  deriveProviderAdapters, routedProviders, validateAdapterSet, validateProviderAdapter, adapterFor,
  bookAdapterUsage, decideProviderHeal, resolveAdapterKey, type ProviderAdapter,
} from "../lib/kernel/provider-adapters"
import { healProviderFailure } from "../lib/agentic-os/connector-healer"
import { buildAuthedRequest, applyAlternateToRequest, loadAppliedAlternate, foldProbeVerdict, deriveProviderHealth } from "../lib/agentic-os/connector-gateway"
import { CONTACT_PROVIDER_ROUTES, routeCapability } from "../lib/ai-isa/property-lookup-rail"
import { runtimeFiles } from "./runtime-roots"
import { existsSync } from "node:fs"
import { VENDOR_PRICING, DIRECT_MAIL_PIECE_COST_USD } from "../lib/vendor-governance/cost-normalizer"
import { PLATFORM_VENDOR_RATES } from "../lib/vendor-governance/meter-vendor"
import { QBO_MINOR_VERSION } from "../lib/agentic-os/connector-registry"
import { PROBE_SPECS } from "../lib/agentic-os/connector-probe"
import { appendVersiumPropertyFacts } from "../lib/external/versium-client"

/**
 * PUBLISHED declaration faults (wave 138, lane 138A) — a provider the census found that is truthfully
 * declared but breaks the constitution today (an unpriced or unmetered platform-paid call). The
 * validator refuses each (adapterFor does not serve it: the healer only proposes); this list is a
 * RATCHET — a fault not listed fails the guard, a listed one that is fixed fails until it is removed.
 */
// Wave 139 (lane 139C) — all six wave-138 faults CLOSED, so the ratchet is empty (each was removed the
// moment it stopped being real, as this list demands): zyte + tavily priced in VENDOR_PRICING (VARIABLE,
// sourced); openai image generation/edit booked through logAIImageUsage; voicedrop booked per delivered
// drop with its price explicitly UNKNOWN; google_maps server-minted images booked through
// bookMapsImageSpend; mapbox re-proven at HEAD to make NO request (vocabulary_only). The per-capability
// cost record + its proofs: scripts/cost-completeness-guard.ts.
const KNOWN_DECLARATION_FAULTS: Record<string, string> = {}

/** Env / gateway / module / webhook names that are NOT an external provider — each with its reason. */
const NON_PROVIDER: Record<string, string> = {
  supabase: "the platform's own database/auth/storage — the OS runs ON it; not a provider adapter",
  cron: "CRON_SECRET — our own cron-route auth",
  admin_maintenance: "our own maintenance-route key",
  agent_assistant_tool: "guards OUR assistant-tool webhook (not a vendor account)",
  internal_api: "our own internal-route secret",
  secrets_encryption: "our own at-rest credential encryption key",
  relay_shared: "our own voice relay shared secret",
  workflow_webhook: "our own workflow trigger webhook secret",
  inbound_suppression: "our own inbound-suppression webhook (any sender)",
  inbound_mail: "the multi-provider inbound-parse route — each provider's own verification key is censused under its adapter",
  asset_download: "a signed-URL fetch of a provider's own asset — the provider is the caller's",
  rss: "arbitrary publishers' public RSS feeds — no vendor relationship",
}

interface CensusSignal { kind: "env" | "gateway" | "module" | "webhook"; name: string; file: string }

/** PURE — the provider signals in a corpus (stripped source; module + webhook paths from file names). */
function censusSignals(files: Array<{ path: string; src: string }>): CensusSignal[] {
  const out = new Map<string, CensusSignal>()
  const add = (s: CensusSignal) => { const k = `${s.kind}:${s.name}`; if (!out.has(k)) out.set(k, s) }
  const GENERIC = new Set(["accounting", "calendar", "email", "esign", "messaging", "payment", "content-safety", "dispatch", "inbound-router", "index", "mailing-cass-gate", "outbound-sender", "tenancy-matrix", "webhook-contract", "permissions"])
  for (const { path, src } of files) {
    const p = path.replace(/^\.\//, "")
    const s = stripComments(src)
    for (const m of s.matchAll(/process\.env(?:\.|\[["'])([A-Z0-9_]+)/g)) if (/(_API_KEY|_TOKEN|_SECRET|_CLIENT_ID|_KEY)$/.test(m[1])) add({ kind: "env", name: m[1], file: p })
    if (/\bcallConnector\b/.test(s)) for (const m of s.matchAll(/\bconnector:\s*["'`]([a-z0-9_-]+)/g)) add({ kind: "gateway", name: m[1], file: p })
    let mod: string | null = null
    if (/^lib\/.*\/?([a-z0-9-]+)-client\.ts$/.test(p)) mod = /([a-z0-9-]+)-client\.ts$/.exec(p)![1]
    else if (/^lib\/integrations\/providers\/[a-z0-9-]+-provider\.ts$/.test(p)) mod = /([a-z0-9-]+)-provider\.ts$/.exec(p)![1]
    else if (/^lib\/crm\/providers\/[a-z0-9-]+\.ts$/.test(p)) mod = /([a-z0-9-]+)\.ts$/.exec(p)![1]
    else if (/^lib\/providers\/[a-z0-9-]+\//.test(p)) mod = /^lib\/providers\/([a-z0-9-]+)\//.exec(p)![1]
    else if (/^lib\/providers\/[a-z0-9-]+\.ts$/.test(p)) mod = /([a-z0-9-]+)\.ts$/.exec(p)![1]
    else if (/^lib\/(remotion|did|elevenlabs|voicedrop)\//.test(p)) mod = /^lib\/([a-z0-9-]+)\//.exec(p)![1]
    if (mod && !GENERIC.has(mod)) add({ kind: "module", name: mod, file: p })
    const wh = /^app\/api\/webhooks\/([a-z0-9-]+)\//.exec(p)
    if (wh) add({ kind: "webhook", name: wh[1], file: p })
  }
  return [...out.values()]
}

/** A signal → the declared provider it belongs to, a non-provider reason, or null (UNACCOUNTED). */
function accountFor(sig: CensusSignal, envOwner: Map<string, string>): { provider: string } | { nonProvider: string } | null {
  if (sig.kind === "env" && envOwner.has(sig.name)) return { provider: envOwner.get(sig.name)! }
  const k = resolveAdapterKey(sig.name, { prefix: true })
  if (k) return { provider: k }
  const n = sig.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^next_public_/, "")
  const tokens = n.split("_")
  for (let i = tokens.length; i >= 1; i--) { const pre = tokens.slice(0, i).join("_"); if (NON_PROVIDER[pre]) return { nonProvider: pre } }
  return null
}

let pass = 0, fail = 0
const ok = (c: unknown, m: string) => { if (c) { pass++; console.log(`  ✓ ${m}`) } else { fail++; console.log(`  ✗ ${m}`) } }
const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

// ── in-memory supabase-js stand-in (same shape as scripts/os-health-guard.ts) ──
type Row = Record<string, any>
function fakeClient(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = JSON.parse(JSON.stringify(seed))
  let idSeq = 0
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = []
    let mode: "select" | "insert" | "update" = "select", payload: any = null, single: "one" | "maybe" | null = null, returning = false
    const run = () => {
      const t = (tables[table] ??= [])
      if (mode === "insert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r: Row) => ({ id: `00000000-0000-4000-8000-${String(++idSeq).padStart(12, "0")}`, ...r }))
        t.push(...rows)
        return { data: returning ? (single ? rows[0] : rows) : null, error: null }
      }
      const hit = t.filter((r) => filters.every(([c, v]) => r[c] === v))
      if (mode === "update") { hit.forEach((r) => Object.assign(r, payload)); return { data: returning ? hit.map((r) => ({ id: r.id })) : null, error: null } }
      if (single) return { data: hit[hit.length - 1] ?? null, error: single === "one" && !hit.length ? { message: "no rows" } : null }
      return { data: hit, error: null }
    }
    const b: any = {
      select: () => { if (mode !== "select") returning = true; return b },
      insert: (p: any) => { mode = "insert"; payload = p; return b },
      update: (p: any) => { mode = "update"; payload = p; return b },
      eq: (c: string, v: unknown) => { filters.push([c, v]); return b },
      order: () => b, limit: () => b, in: () => b, gte: () => b,
      maybeSingle: () => { single = "maybe"; return b },
      single: () => { single = "one"; return b },
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    }
    return b
  }
  return { from, tables: () => tables }
}

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const NOW = new Date("2026-10-07T12:00:00.000Z")
const UP = async () => ({ state: "healthy", routeAround: false, reason: "no faults" })
const ledgerActions = (c: ReturnType<typeof fakeClient>) => (c.tables().agent_action_ledger ?? []).map((r) => `${r.action}:${r.status}`)

async function main() {
  // ── A. derivation ─────────────────────────────────────────────────────────
  console.log("\nA. every routed provider has one valid declaration")
  const derived = deriveProviderAdapters()
  const routed = routedProviders()
  // Wave 138: the routed NAMES (five route tables, many spellings) fold onto fewer adapters, and a
  // gateway-only / published-exception provider adds adapters no table names — so the count asserted
  // is DERIVED both ways: every routed name resolves, and every adapter is routed or publishes why not.
  const routedKeys = new Set(routed.map((n) => resolveAdapterKey(n)).filter(Boolean))
  ok(routed.length > 0 && routedKeys.size > 0 && derived.adapters.filter((a) => a.route.paths.some((p) => p !== "connector_gateway")).every((a) => routedKeys.has(a.provider)),
    `${routed.length} routed names fold onto ${routedKeys.size} declared adapters (of ${derived.adapters.length}; the rest are gateway-only or published exceptions)`)
  const tableProviders = new Set(Object.values(CONTACT_PROVIDER_ROUTES).flat().map((e) => e.provider))
  ok([...tableProviders].every((p) => routed.includes(p)), `every CONTACT_PROVIDER_ROUTES provider is routed (${[...tableProviders].join(", ")})`)
  ok(derived.missing.length === 0 && derived.unrouted.length === 0, `no missing / unrouted declaration (missing=${derived.missing.join(",") || "-"} unrouted=${derived.unrouted.join(",") || "-"})`)
  const setErrs = validateAdapterSet(derived)
  const unknownFaults = setErrs.filter((e) => !KNOWN_DECLARATION_FAULTS[e.split(":")[0]])
  ok(unknownFaults.length === 0, `validateAdapterSet clean except the PUBLISHED faults (${setErrs.length} fault line(s) across ${Object.keys(KNOWN_DECLARATION_FAULTS).length} published adapters)${unknownFaults.length ? ": " + unknownFaults.slice(0, 4).join(" | ") : ""}`)
  for (const [p, why] of Object.entries(KNOWN_DECLARATION_FAULTS)) {
    ok(setErrs.some((e) => e.startsWith(`${p}:`)) && !adapterFor(p), `published fault still real (else delete it) and NOT served (fail closed): ${p}`)
    console.log(`      open item: ${why}`)
  }
  ok(derived.adapters.every((a) => a.api.version && a.health.serviceKeys.length && a.provenance.includes("ADAPTER_FACTS")), "every adapter declares version + health key + provenance")
  // positive controls — remove a routed provider's facts / add an unrouted one
  const factsMinus: Record<string, any> = {}
  for (const a of derived.adapters) if (a.provider !== "versium") factsMinus[a.provider] = { serviceKeys: a.health.serviceKeys, outputs: a.outputs, transport: a.api.transport, version: a.api.version, baseUrl: a.api.baseUrl, ledger: a.cost.ledger, booking: a.cost.booking }
  const ctrl = deriveProviderAdapters(factsMinus)
  ok(ctrl.missing.includes("versium") && validateAdapterSet(ctrl).some((e) => /versium: ROUTED but no adapter/.test(e)), "POSITIVE CONTROL: a routed provider without a declaration is refused")
  const ctrl2 = deriveProviderAdapters({ ...factsMinus, versium: factsMinus.rentcast, madeup_vendor: factsMinus.rentcast })
  ok(ctrl2.unrouted.includes("madeup_vendor") && validateAdapterSet(ctrl2).some((e) => /madeup_vendor: declared but nothing routes/.test(e)), "POSITIVE CONTROL: a declaration nothing routes is refused (plug in through the route table)")
  ok(adapterFor("did")?.provider === "did" && adapterFor("followupboss")?.provider === "follow_up_boss" && adapterFor("vercel-ai-gateway")?.provider === "anthropic", "adapterFor resolves provider names AND gateway service keys")

  // ── B. booking ─────────────────────────────────────────────────────────────
  console.log("\nB. one booking per executed call, none on refusal")
  const rentcast = adapterFor("rentcast") as ProviderAdapter
  const booked: any[] = []
  const meter = async (i: any) => { booked.push(i); return true }
  const b1 = await bookAdapterUsage(rentcast, { brokerageId: A, executed: true, systemSource: "guard", usageType: "valuation" }, { meter })
  ok(b1 && booked.length === 1 && booked[0].cost === rentcast.cost.unitUsd && booked[0].brokerageId === A, `executed call booked once at the declared price ($${rentcast.cost.unitUsd}, ${rentcast.cost.priceSource})`)
  const b2 = await bookAdapterUsage(rentcast, { brokerageId: A, executed: false, systemSource: "guard", usageType: "valuation" }, { meter })
  ok(!b2 && booked.length === 1, "refused call books none")
  const b3 = await bookAdapterUsage(adapterFor("quickbooks") as ProviderAdapter, { brokerageId: A, executed: true, systemSource: "guard", usageType: "sync" }, { meter })
  ok(!b3 && booked.length === 1, "tenant-account adapter books nothing on the platform ledger")

  // ── C. down → failover ─────────────────────────────────────────────────────
  console.log("\nC. DOWN → failover through the router")
  const dDown = decideProviderHeal(rentcast, { probe: "unreachable", derived: null, shapeChange: null, appliedAlternateId: null, now: NOW })
  ok(dDown.step === "failover" && dDown.routes.some((r) => r.capability === "property_valuation" && r.providers[0] === "batchdata" && r.skipped.some((x) => x.provider === "rentcast")), "rentcast unreachable → property_valuation fails over to batchdata (rentcast skipped)")
  const cC = fakeClient()
  const proposals: any[] = []
  const repC = await healProviderFailure({ connector: "rentcast", brokerageId: A, failures: [{ status: null, path: null, error: "timeout" }], cycle: "c" },
    { client: cC, now: NOW, probe: async () => "unreachable", derivedHealth: UP, appliedAlternateId: async () => null, propose: async (p) => { proposals.push(p); return { proposal: null, error: "x" } } })
  ok(repC.decision.step === "failover" && ledgerActions(cC).join(",") === "provider.heal.probe:executed,provider.heal.failover:executed", `failover ledgered: ${ledgerActions(cC).join(", ")}`)
  ok(proposals.length === 0 && !(cC.tables().connector_healing_proposals ?? []).length, "a DOWN provider is failed over, never 'fixed' by a proposal")
  const dEsc = decideProviderHeal(adapterFor("twilio") as ProviderAdapter, { probe: "unreachable", derived: null, shapeChange: null, appliedAlternateId: null, now: NOW })
  ok(dEsc.step === "escalate", "POSITIVE CONTROL: a down provider with no healthy alternate escalates (failover first, escalate only without one)")
  const dUp = decideProviderHeal(rentcast, { probe: "ok", derived: { state: "healthy", routeAround: false, reason: "" }, shapeChange: null, appliedAlternateId: null, now: NOW })
  ok(dUp.step === "none", "UP with no drift → nothing to heal (the gateway retry owns a blip)")

  // ── D. up + version drift → apply declared + retry once ───────────────────
  // Wave 139 (lane 139D): the LIVE QuickBooks declaration now pins QBO_MINOR_VERSION (75) and declares
  // NO alternate and NO deprecation — it has nothing to heal (asserted below). The apply path is
  // therefore proven on a FIXTURE of the retired pre-75 declaration (an assertion is never pinned to a
  // waypoint, CLAUDE.md §2), injected through the healer's resolveAdapter / apply / appliedAlternateId
  // seams; the REAL applier and the REAL egress reader are exercised on what the live code now holds.
  console.log("\nD. UP + version drift → declared alternate applied, retried once (fixture); the live QBO pin has nothing to heal")
  const qboLive = adapterFor("quickbooks") as ProviderAdapter
  const FIXTURE_ALT = { id: "fixture_minor_next", level: "config" as const, version: "v3 minorversion=75", query: { minorversion: "75" }, supersedesCurrent: true, reason: "fixture: a pre-75 declaration's superseding minor version" }
  const qboFixture: ProviderAdapter = { ...qboLive, api: { ...qboLive.api, version: "v3 minorversion=73", deprecatedAfter: "2025-08-01", alternates: [FIXTURE_ALT] } }
  const cD = fakeClient()
  let retries = 0
  const appliedD: any[] = []
  const applyD = async (_c: unknown, p: any) => { appliedD.push(p); return { applied: true, proposalId: `pD${appliedD.length}`, reason: `applied ${p.alternateId}` } }
  const repD = await healProviderFailure({ connector: "quickbooks", brokerageId: A, failures: [{ status: 400, path: "companyinfo", error: "minor version" }], cycle: "d", retry: async () => { retries++; return { ok: true } } },
    { client: cD, now: NOW, probe: async () => "ok", derivedHealth: UP, appliedAlternateId: async () => null, resolveAdapter: () => qboFixture, apply: applyD as any, propose: async () => { throw new Error("must not propose") } })
  ok(repD.decision.step === "apply_declared" && repD.applied && appliedD.length === 1 && appliedD[0].alternateId === FIXTURE_ALT.id, "deprecated minor version (fixture) → the declared config alternate is applied through the applier seam")
  ok(retries === 1 && repD.retried && repD.retryOk === true, "retried exactly ONCE under the applied alternate")
  ok(ledgerActions(cD).join(",") === "provider.heal.probe:executed,provider.heal.apply:executed,provider.heal.retry:executed", `every step ledgered: ${ledgerActions(cD).join(", ")}`)
  ok((cD.tables().agent_action_ledger ?? []).every((r) => r.brokerage_id === A && r.reason_code === "OS_HEALTH_RECOVERY" && r.actor_manager_key === "data_steward"), "ledger rows carry the tenant, OS_HEALTH_RECOVERY and the data_steward actor")
  const egress = buildAuthedRequest(applyAlternateToRequest({ connector: "quickbooks", baseUrl: "https://quickbooks.api.intuit.com/v3/company/1", path: "companyinfo/1?minorversion=73" }, FIXTURE_ALT, qboFixture.api.baseUrl))
  ok(/minorversion=75/.test(egress.url) && !/minorversion=73/.test(egress.url), `egress carries the applied version (${new URL(egress.url).pathname}${new URL(egress.url).search})`)
  const repD2 = await healProviderFailure({ connector: "quickbooks", brokerageId: A, failures: [], cycle: "d2", retry: async () => { retries++; return { ok: true } } },
    { client: cD, now: NOW, probe: async () => "ok", derivedHealth: UP, appliedAlternateId: async () => FIXTURE_ALT.id, resolveAdapter: () => qboFixture, apply: applyD as any, propose: async () => ({ proposal: { id: "p2", connector: "quickbooks", proposal_kind: "endpoint_change", proposal_summary: "", confidence: 0, status: "pending" }, error: null }) })
  ok(repD2.decision.step === "none" && retries === 1 && appliedD.length === 1, "a second heal after the apply does NOT re-apply or retry — the applied alternate answered the deprecation")
  const repD3 = await healProviderFailure({ connector: "quickbooks", brokerageId: A, failures: [], cycle: "d3", retry: async () => { retries++; return { ok: true } } },
    { client: cD, now: NOW, probe: async () => "shape_drift", derivedHealth: UP, appliedAlternateId: async () => FIXTURE_ALT.id, resolveAdapter: () => qboFixture, apply: applyD as any, propose: async () => ({ proposal: { id: "p3", connector: "quickbooks", proposal_kind: "shape_update", proposal_summary: "", confidence: 0, status: "pending" }, error: null }) })
  ok(repD3.decision.step === "propose" && retries === 1 && repD3.proposalId === "p3" && appliedD.length === 1, "drift that persists AFTER the declared alternate → a proposal (never a second auto-apply)")
  // The LIVE declaration: pinned at 75, nothing deprecated, nothing superseding — an UP QBO is not "healed".
  ok(qboLive.api.alternates.length === 0 && !qboLive.api.deprecatedAfter && decideProviderHeal(qboLive, { probe: "ok", derived: null, shapeChange: null, appliedAlternateId: null, now: NOW }).step === "none",
    `live QBO declaration (${qboLive.api.version}) has no alternate / deprecation → an UP QBO has nothing to heal`)
  // The REAL applier + the REAL egress reader on the RETIRED alternate: a stale applied row is inert.
  const retired = await (await import("../lib/agentic-os/connector-auto-applier")).applyDeclaredAlternate(fakeClient(), { connector: "quickbooks", alternateId: "qbo_minorversion_75", failureSignature: "x", evidence: {} })
  ok(!retired.applied && /not a declared config-level alternate/.test(retired.reason), "POSITIVE CONTROL: the real applier refuses the RETIRED qbo_minorversion_75 (tombstoned — never re-applied)")
  const staleApplied = fakeClient({ connector_healing_proposals: [{ id: "old", connector: "quickbooks", proposal_kind: "declared_alternate", status: "applied", applied_at: "2026-10-01T00:00:00Z", proposal_payload: { alternate_id: "qbo_minorversion_75" } }] })
  ok((await loadAppliedAlternate("quickbooks", staleApplied)) === null, "a stale APPLIED row naming the retired alternate resolves to nothing at egress (the gateway reads only declared alternates)")
  const forged = await (await import("../lib/agentic-os/connector-auto-applier")).applyDeclaredAlternate(fakeClient(), { connector: "rentcast", alternateId: "rentcast_mcp", failureSignature: "x", evidence: {} })
  ok(!forged.applied && /not a declared config-level alternate/.test(forged.reason), "POSITIVE CONTROL: a CODE-level alternate can never be applied through the applier")

  // ── E. up + code-level drift → proposal ───────────────────────────────────
  console.log("\nE. UP + code-level drift → proposal, not applied")
  const cE = fakeClient()
  const proposedE: any[] = []
  const repE = await healProviderFailure({ connector: "rentcast", brokerageId: A, failures: [{ status: 200, path: "/avm/value", error: "shape_drift" }], cycle: "e", retry: async () => { throw new Error("must not retry") } },
    { client: cE, now: NOW, probe: async () => "shape_drift", derivedHealth: UP, appliedAlternateId: async () => null,
      apply: async () => { throw new Error("must not apply") },
      propose: async (p) => { proposedE.push(p); return { proposal: { id: "pE", connector: "rentcast", proposal_kind: "shape_update", proposal_summary: "", confidence: 0.4, status: "pending" }, error: null } } })
  ok(repE.decision.step === "propose" && (repE.decision as any).proposalKind === "shape_update" && proposedE.length === 1 && !repE.applied && repE.proposalId === "pE", "rentcast shape drift (only a code-level MCP alternate) → shape_update proposal, nothing applied")
  ok(ledgerActions(cE).join(",") === "provider.heal.probe:executed,provider.heal.propose:executed", `proposal ledgered: ${ledgerActions(cE).join(", ")}`)
  const dAuth = decideProviderHeal(rentcast, { probe: "auth_failed", derived: null, shapeChange: null, appliedAlternateId: null, now: NOW })
  ok(dAuth.step === "propose" && (dAuth as any).proposalKind === "rotate_key", "UP + refused credential → rotate_key proposal (never auto)")
  const dMem = decideProviderHeal(rentcast, { probe: "ok", derived: null, shapeChange: { addedKeys: [], removedKeys: ["price"] }, appliedAlternateId: null, now: NOW })
  ok(dMem.step === "propose", "a key dropped in connector_shape_memory counts as drift")

  // ── F. validator ───────────────────────────────────────────────────────────
  console.log("\nF. validator refuses an unmetered paid adapter")
  ok(validateProviderAdapter(rentcast).length === 0, "POSITIVE CONTROL: the real rentcast declaration is valid")
  const unmetered: ProviderAdapter = { ...rentcast, cost: { ...rentcast.cost, ledger: "tenant_account", booking: "none" } }
  ok(validateProviderAdapter(unmetered).some((e) => /UNMETERED PAID/.test(e)), "a platform-paid adapter with no booking is REFUSED")
  ok(validateProviderAdapter({ ...rentcast, api: { ...rentcast.api, version: "" } }).some((e) => /version/.test(e)), "an adapter with no API version is refused")

  // ── G. census ─────────────────────────────────────────────────────────────
  console.log("\nG. no manager / skill module imports a provider client directly")
  const PROVIDER_CLIENT = /^(@\/lib\/(external\/|[a-z]+-client$|property\/rentcast|providers\/(twilio|lob|elevenlabs|peopledata|zenrows|apify|exa|simli)|did\/|elevenlabs\/)|twilio$|stripe$|openai$|@anthropic-ai\/sdk$|@lob\/|elevenlabs$)/
  const specifiers = (src: string) => [...stripComments(src).matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1])
  const ctrlSrc = `// tombstone: was import { x } from "@/lib/external/batchdata-client"\nconst { y } = await import("@/lib/external/versium-client")\nimport z from "@/lib/kernel/provider-adapters"`
  const ctrlHits = specifiers(ctrlSrc).filter((s) => PROVIDER_CLIENT.test(s))
  ok(ctrlHits.length === 1 && ctrlHits[0] === "@/lib/external/versium-client", "POSITIVE CONTROL: the finder sees a live dynamic import and NOT a tombstone comment")
  const walk = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap((f) => { const p = `${dir}/${f}`; return statSync(join(ROOT, p)).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : [] })
  const scope = [...walk("lib/managers"), ...walk("lib/agents"), ...walk("lib/agent-orchestration"), ...walk("lib/orchestrator"),
    ...readdirSync(join(ROOT, "lib/kernel")).filter((f) => /^(manager|skill)-.*\.ts$/.test(f)).map((f) => `lib/kernel/${f}`)]
  const EXCEPTIONS: Record<string, string> = {
    "lib/agents/marketing-agent-actions.ts|@/lib/external/lob-address-verify": "the marketing agent's verify_lead_address executor re-runs Lob CASS on ONE lead the dispatch gate keeps blocking — the same single-provider verification lib/providers/dispatch.ts runs; no capability route exists for address verification. Now BOOKED (meterVendorSpend, lane 137C).",
  }
  const found: string[] = []
  for (const f of scope) for (const s of specifiers(read(f))) if (PROVIDER_CLIENT.test(s)) found.push(`${f}|${s}`)
  const violations = found.filter((k) => !EXCEPTIONS[k])
  ok(violations.length === 0, `scanned ${scope.length} manager/skill/agent modules — ${violations.length} direct provider import(s)${violations.length ? ": " + violations.join(", ") : ""}`)
  for (const [k, why] of Object.entries(EXCEPTIONS)) { ok(found.includes(k), `exception still present (else delete it): ${k}`); console.log(`      reason: ${why}`) }

  // ── H. wiring + version pins ──────────────────────────────────────────────
  console.log("\nH. wiring + declared versions equal the code's pins")
  const cron = stripComments(read("app/api/cron/connector-health/route.ts"))
  ok(/healProviderFailure\(\{/.test(cron) && !/proposeConnectorHealing/.test(cron), "connector-health cron heals through healProviderFailure (probe-first), not the bare proposal writer")
  const gw = stripComments(read("lib/agentic-os/connector-gateway.ts"))
  ok(/const req = await withAppliedAlternate\(original\)/.test(gw) && /loadAppliedAlternate/.test(gw), "callConnector applies the applied declared alternate at egress")
  const applier = stripComments(read("lib/agentic-os/connector-auto-applier.ts"))
  ok(/declared_alternate:\s*\{\s*minConfidence/.test(applier) && /declaredConfigAlternate\(p\.connector/.test(applier), "auto-applier SAFE_KINDS includes declared_alternate, re-validated against the declaration")
  const stripeV = /STRIPE_API_VERSION = '([^']+)'/.exec(read("lib/stripe.ts"))?.[1]
  ok(!!stripeV && adapterFor("stripe")?.api.version === stripeV, `stripe declared version == lib/stripe.ts STRIPE_API_VERSION (${stripeV})`)
  // Wave 139 (lane 139D, owner "approve all" (3): QuickBooks minorversion = 75) — ONE constant.
  const qboCorpus = runtimeFiles().map((p) => ({ path: p.replace(/^\.\//, ""), src: stripComments(readFileSync(join(ROOT, p), "utf8")) }))
  const minorLiteral = (src: string) => /minorversion=\d|minorversion["']?\s*:\s*["'`]?\d/.test(src)
  const literalPins = qboCorpus.filter((f) => minorLiteral(f.src)).map((f) => f.path)
  ok(literalPins.length === 0, `no QBO minor-version LITERAL anywhere in runtime code — every pin reads QBO_MINOR_VERSION (${literalPins.join(", ") || "none"})`)
  ok(minorLiteral(`path: "/invoice?minorversion=73"`) && minorLiteral(`query: { minorversion: "74" }`) && !minorLiteral(stripComments(`// was "/invoice?minorversion=73"\nconst p = \`/invoice?minorversion=\${QBO_MINOR_VERSION}\``)),
    "POSITIVE CONTROL: the finder sees a live literal pin (path or query form), not a tombstone comment nor the constant's template")
  const constantSites = qboCorpus.filter((f) => /minorversion=\$\{QBO_MINOR_VERSION\}/.test(f.src)).map((f) => f.path)
  ok(constantSites.length >= 6 && ["lib/providers/accounting/quickbooks.ts", "lib/agentic-os/connector-probe.ts"].every((p) => constantSites.includes(p)),
    `every QBO request site speaks the ONE constant (${constantSites.length} files: ${constantSites.join(", ")})`)
  ok(QBO_MINOR_VERSION === "75", `QBO_MINOR_VERSION is the owner-ruled 75 (wave 139 approve-all (3); no newer Intuit minor version found 2026-10-08) — got ${QBO_MINOR_VERSION}`)
  ok(adapterFor("quickbooks")?.api.version === `v3 minorversion=${QBO_MINOR_VERSION}` && (() => { const u = PROBE_SPECS.quickbooks?.url; return (typeof u === "function" ? u({ config: { realmId: "1" } } as any) : u) ?? "" })().endsWith(`minorversion=${QBO_MINOR_VERSION}`),
    `the adapter declaration (${adapterFor("quickbooks")?.api.version}) and the live probe speak the same constant`)
  const pkg = read("package.json")
  ok(new RegExp("npm run test:provider-adapter(\\s|&|$)").test(pkg), "test:provider-adapter is in the guard chain")

  // ── I. census — EVERY provider the code references is a declared kernel connection ──
  console.log("\nI. census: every provider signal in the runtime corpus is accounted for")
  const corpus = runtimeFiles().map((p) => ({ path: p.replace(/^\.\//, ""), src: readFileSync(join(ROOT, p), "utf8") }))
  const envOwner = new Map<string, string>()
  for (const a of derived.adapters) for (const v of a.credential.envVars) envOwner.set(v, a.provider)
  const signals = censusSignals(corpus)
  const accounted = signals.map((s) => ({ s, r: accountFor(s, envOwner) }))
  const unaccounted = accounted.filter((x) => !x.r)
  const byKind = (k: CensusSignal["kind"]) => signals.filter((s) => s.kind === k).length
  ok(signals.length > 0 && unaccounted.length === 0,
    `${signals.length} signals over ${corpus.length} runtime files (env ${byKind("env")} · gateway ${byKind("gateway")} · module ${byKind("module")} · webhook ${byKind("webhook")}) — ${unaccounted.length} unaccounted${unaccounted.length ? ": " + unaccounted.slice(0, 8).map((x) => `${x.s.kind}:${x.s.name}@${x.s.file}`).join(", ") : ""}`)
  const censusKeys = new Set<string>()
  for (const x of accounted) if (x.r && "provider" in x.r) censusKeys.add(x.r.provider)
  for (const n of routed) { const k = resolveAdapterKey(n); if (k) censusKeys.add(k) }
  const declaredKeys = new Set(derived.adapters.map((a) => a.provider))
  const phantom = [...declaredKeys].filter((k) => !censusKeys.has(k))
  const undeclared = [...censusKeys].filter((k) => !declaredKeys.has(k))
  ok(censusKeys.size === declaredKeys.size && phantom.length === 0 && undeclared.length === 0,
    `derived census count (${censusKeys.size}) == declared adapter count (${declaredKeys.size})${phantom.length ? ` · phantom: ${phantom.join(",")}` : ""}${undeclared.length ? ` · undeclared: ${undeclared.join(",")}` : ""}`)
  const gwHit = new Set(accounted.filter((x) => x.s.kind === "gateway" && x.r && "provider" in x.r).map((x) => (x.r as { provider: string }).provider))
  const gwClaimNoSite = derived.adapters.filter((a) => a.route.paths.includes("connector_gateway") && !gwHit.has(a.provider)).map((a) => a.provider)
  ok(gwClaimNoSite.length === 0, `every adapter claiming the connector_gateway path has a live callConnector site (${gwHit.size} gateway-reached providers)${gwClaimNoSite.length ? " — claimed with no site: " + gwClaimNoSite.join(",") : ""}`)
  const usedExclusions = new Set(accounted.filter((x) => x.r && "nonProvider" in x.r).map((x) => (x.r as { nonProvider: string }).nonProvider))
  const staleExclusions = Object.keys(NON_PROVIDER).filter((k) => !usedExclusions.has(k))
  ok(staleExclusions.length === 0, `every NON_PROVIDER exclusion is still hit (${usedExclusions.size}; stale: ${staleExclusions.join(",") || "-"})`)
  const exceptions = derived.adapters.filter((a) => a.route.exception)
  ok(exceptions.every((a) => (a.route.exception ?? "").length >= 40), `${exceptions.length} provider(s) reached outside the rails each PUBLISH a reason (${exceptions.map((a) => a.provider).join(", ")})`)
  // POSITIVE CONTROL — a planted client file with an env key is flagged twice (module + env); a tombstone is not read.
  const planted = censusSignals([{ path: "lib/external/acmeleads-client.ts", src: "// tombstone: was process.env.OLDVENDOR_API_KEY\nexport const k = process.env.ACMELEADS_API_KEY\n" }])
  const plantedOut = planted.filter((s) => !accountFor(s, envOwner))
  ok(plantedOut.length === 2 && plantedOut.some((s) => s.kind === "env" && s.name === "ACMELEADS_API_KEY") && plantedOut.some((s) => s.kind === "module") && !planted.some((s) => s.name === "OLDVENDOR_API_KEY"),
    "POSITIVE CONTROL: a planted client file with an env key is flagged (module + env), and a tombstone comment is not a signal")

  // ── J. declarations — research roots + bookings that exist in code ──
  console.log("\nJ. every declaration carries its research roots; every named booking exists")
  // Wave 139 (139D): a docs root is a verified https page OR null WITH its published reason (section N).
  ok(derived.adapters.every((a) => a.api.docsUrl ? /^https:\/\//.test(a.api.docsUrl) : (a.api.urlNote ?? "").trim().length >= 40),
    `every adapter names an https docs root or publishes why it has none (${derived.adapters.filter((a) => a.api.docsUrl).length} docs roots, ${derived.adapters.filter((a) => !a.api.docsUrl).length} null-with-reason, ${derived.adapters.filter((a) => a.api.statusUrl).length} status pages, ${derived.adapters.filter((a) => a.api.changelogUrl).length} changelogs declared)`)
  const bookingFaults: string[] = []
  for (const a of derived.adapters) {
    if (a.cost.payer !== "platform" || a.cost.ledger === "free" || /^none\b/.test(a.cost.booking)) continue
    const m = /^([A-Za-z]+) \(([^)]+)\)/.exec(a.cost.booking)
    if (!m || !existsSync(join(ROOT, m[2])) || !new RegExp(`\\b${m[1]}\\(`).test(stripComments(read(m[2])))) bookingFaults.push(`${a.provider}: ${a.cost.booking}`)
  }
  ok(bookingFaults.length === 0, `every platform-paid booking names a module that calls it (${bookingFaults.length ? bookingFaults.join(" | ") : "all present"})`)
  const vocabOnly = derived.adapters.filter((a) => a.lifecycle !== "live").map((a) => `${a.provider}:${a.lifecycle}`)
  console.log(`      not-live declarations (published): ${vocabOnly.join(", ")}`)

  // ── K. the router uses PROBE results ──
  console.log("\nK. a probe-DOWN provider is skipped by routeCapability (evidence row cited)")
  const healthy = deriveProviderHealth([], NOW)
  const probeDown = foldProbeVerdict(healthy, { status: "unreachable", at: new Date(NOW.getTime() - 60_000).toISOString(), ref: "she-1" }, NOW)
  const rK = routeCapability("property_valuation", { rentcast: probeDown, batchdata: healthy })
  ok(rK.providers[0] === "batchdata" && rK.skipped.some((x) => x.provider === "rentcast" && /live probe unreachable/.test(x.reason) && /self_heal_events she-1/.test(x.reason)), `rentcast probe-unreachable → skipped, batchdata serves (${rK.skipped.map((x) => x.reason).join("; ").slice(0, 120)})`)
  const stale = foldProbeVerdict(healthy, { status: "unreachable", at: new Date(NOW.getTime() - 60 * 60_000).toISOString(), ref: "she-0" }, NOW)
  const upAuth = foldProbeVerdict(healthy, { status: "auth_failed", at: new Date(NOW.getTime() - 60_000).toISOString(), ref: "she-2" }, NOW)
  ok(!stale.routeAround && !upAuth.routeAround && routeCapability("property_valuation", { rentcast: upAuth }).providers[0] === "rentcast",
    "POSITIVE CONTROLS: a probe older than the cool-down, and an UP verdict (auth_failed), never route around")
  const gwSrc = stripComments(read("lib/agentic-os/connector-gateway.ts"))
  ok(/foldProbeVerdict\(value,/.test(gwSrc) && /from\("self_heal_events"\)/.test(gwSrc) && /eq\("action", "provider_probe"\)/.test(gwSrc), "loadProviderHealth folds the newest platform probe verdict (self_heal_events provider_probe) into the health the router reads")

  // ── L. os-health failover → the provider healer ──
  console.log("\nL. os-health's provider failover hands the provider to healProviderFailure")
  const osh = stripComments(read("lib/kernel/os-health.ts"))
  const failoverArm = /case "failover": \{[\s\S]*?\n {6}\}/.exec(osh)?.[0] ?? ""
  ok(/healProviderFailure\(/.test(failoverArm) && /deps\.healProvider/.test(failoverArm) && /routed around by routeCapability/.test(failoverArm), "the failover arm routes around AND calls the healer's exported entry (healProviderFailure)")

  // ── M. one vocabulary ──
  console.log("\nM. one vocabulary: the Lob price, the PeopleData spelling")
  ok(VENDOR_PRICING.lob.costPerUnit === DIRECT_MAIL_PIECE_COST_USD.postcard && PLATFORM_VENDOR_RATES.lob.perUnit === DIRECT_MAIL_PIECE_COST_USD.postcard && adapterFor("lob")?.cost.unitUsd === DIRECT_MAIL_PIECE_COST_USD.postcard,
    `VENDOR_PRICING.lob == PLATFORM_VENDOR_RATES.lob == the adapter == DIRECT_MAIL_PIECE_COST_USD.postcard ($${DIRECT_MAIL_PIECE_COST_USD.postcard})`)
  const lobLiteral = (src: string) => /\blob\b[^\n]{0,40}\b(perUnit|costPerUnit)\s*:\s*\d|DIRECT_MAIL_PIECE_COST_USD[^=\n]*=\s*\{\s*letter:\s*\d/.test(stripComments(src))
  const lobLiteralFiles = corpus.filter((f) => f.path !== "lib/vendor-governance/cost-normalizer.ts" && lobLiteral(f.src)).map((f) => f.path)
  ok(lobLiteralFiles.length === 0, `no second Lob price literal outside cost-normalizer.ts (${lobLiteralFiles.join(", ") || "none"})`)
  ok(lobLiteral(`export const PLATFORM_VENDOR_RATES = { lob: { perUnit: 0.84, unit: "piece" } }`) && !lobLiteral(`// lob: { perUnit: 0.84 }`), "POSITIVE CONTROL: the finder sees a live second Lob price, not a comment")
  const peoples = (src: string) => /peoples_?data/i.test(stripComments(src))
  const peoplesFiles = corpus.filter((f) => peoples(f.src)).map((f) => f.path)
  ok(peoplesFiles.length === 0, `"peoplesdata" spelled nowhere in runtime code (${peoplesFiles.join(", ") || "none"}) — ONE spelling: peopledata`)
  ok(peoples(`const provider = "peoplesdata"`) && !peoples(`// tombstone: "peoplesdata" retired`), "POSITIVE CONTROL: the finder sees a live \"peoplesdata\" literal, not a tombstone")

  await sectionN(corpus, derived)
  // ── O. URL integrity (wave 139, lane 139D) ──
  console.log("\nO. every docs / status / changelog URL is a verified official page or NULL with its reason")
  const urlFaults = derived.adapters.flatMap((a) => validateProviderAdapter(a).filter((e) => /URL|urlNote/.test(e)).map((e) => `${a.provider}: ${e}`))
  const urlCount = derived.adapters.reduce((n, a) => n + [a.api.docsUrl, a.api.statusUrl, a.api.changelogUrl].filter(Boolean).length, 0)
  ok(urlFaults.length === 0, `${urlCount} declared URLs over ${derived.adapters.length} adapters — ${urlFaults.length} placeholder / off-domain / unexplained-null fault(s)${urlFaults.length ? ": " + urlFaults.slice(0, 6).join(" | ") : ""}`)
  for (const a of derived.adapters.filter((x) => x.api.urlNote)) console.log(`      ${a.provider}: ${a.api.docsUrl ? "docs " + a.api.docsUrl + " · " : "docs NULL · "}${a.api.urlNote}`)
  // The wave-138 research roots — each a site homepage standing in for docs — are flagged by the finder…
  const RETIRED_ROOTS = ["https://lofty.com", "https://skyslope.com", "https://my.brokermint.com", "https://www.formsimplicity.com", "https://www.showingtime.com", "https://www.slybroadcast.com", "https://www.arello.org", "https://www.listhub.com"]
  const rootFlagged = (u: string) => { const a = adapterFor("lofty") as ProviderAdapter; return validateProviderAdapter({ ...a, api: { ...a.api, docsUrl: u } }).some((e) => /homepage/.test(e)) }
  ok(RETIRED_ROOTS.every(rootFlagged), `POSITIVE CONTROL: all ${RETIRED_ROOTS.length} wave-138 homepage roots are refused as placeholders by validateProviderAdapter`)
  // …and none remains declared (derived from the live declarations — a regression fails here).
  const declaredUrls = new Set(derived.adapters.flatMap((a) => [a.api.docsUrl, a.api.statusUrl, a.api.changelogUrl]).filter(Boolean).map((u) => String(u).replace(/\/$/, "")))
  ok(RETIRED_ROOTS.every((u) => !declaredUrls.has(u)), "no wave-138 placeholder root is declared any more")
  const loftyA = adapterFor("lofty") as ProviderAdapter
  const plant = (api: Partial<ProviderAdapter["api"]>) => validateProviderAdapter({ ...loftyA, api: { ...loftyA.api, ...api } })
  ok(validateProviderAdapter(loftyA).length === 0, `POSITIVE CONTROL: the real (verified) lofty declaration is valid (${loftyA.api.docsUrl})`)
  ok(plant({ docsUrl: "https://lofty.com" }).some((e) => /homepage/.test(e)), "a planted homepage docs root is REFUSED (placeholder)")
  ok(plant({ docsUrl: "https://docs.example.com/api" }).some((e) => /placeholder host/.test(e)), "a planted reserved-host docs URL is REFUSED")
  ok(plant({ docsUrl: "https://docs.lofty-api.io/v1" }).some((e) => /not on an official lofty domain/.test(e)), "a planted INVENTED domain (well-shaped, off-domain) is REFUSED")
  ok(plant({ statusUrl: "https://lofty.com/blog" }).some((e) => /names no status page/.test(e)) && plant({ changelogUrl: "https://developer.lofty.com/intro" }).some((e) => /names no changelog/.test(e)), "a 'status' / 'changelog' URL that is neither is REFUSED")
  ok(plant({ docsUrl: null, urlNote: null }).some((e) => /no docs URL and no published reason/.test(e)), "a NULL docs root with no reason is REFUSED (never silent)")
  ok(plant({ docsUrl: null, urlNote: "docs: no public developer documentation could be verified on 2026-10-08 (fixture)" }).filter((e) => /URL|urlNote/.test(e)).length === 0, "a NULL docs root WITH its published reason is accepted")

  // ── P. Versium property: declared ⇒ routed AND walked (gap-only), never a valuation ──
  console.log("\nP. Versium as a property-data provider: routed + walked on the property_facts route, gap-only")
  const versiumA = adapterFor("versium") as ProviderAdapter
  const declaresProperty = CONTACT_PROVIDER_ROUTES.property_facts.some((e) => e.provider === "versium")
  ok(declaresProperty === versiumA.capabilities.includes("property_facts"), `the declaration matches the route table (versium property_facts: ${declaresProperty ? "DECLARED" : "not declared"})`)
  ok(!CONTACT_PROVIDER_ROUTES.property_valuation.some((e) => e.provider === "versium"), "Versium is NEVER on property_valuation (RentCast primary, BatchData backup — owner rulings)")
  const chainSrc = stripComments(read("lib/avm/provider-chain.ts"))
  const investigatorSrc = stripComments(read("lib/agentic-os/deal-investigator.ts"))
  ok(!declaresProperty || (/routeCapability\("property_facts"/.test(chainSrc) && /getPropertyRecordWithFallback\(\{[\s\S]{0,400}gapFields:/.test(investigatorSrc)),
    "declared ⇒ WALKED: the provider chain routes property_facts through routeCapability, and a real caller (the deal investigator) names the gaps it needs")
  const chain = await import("../lib/avm/provider-chain")
  const rcRow = { address: "1 Main St", city: "Anytown", state: "ZZ", zip: "00001", bedrooms: 3, bathrooms: 2, squareFeet: 1800, yearBuilt: null, propertyType: "Single Family", assessedValue: 210000, annualPropertyTax: 4100, taxYear: 2025, ownerNames: [], lastSaleDate: null, lastSalePrice: 199000 } as any
  const rentcastSeam = (detail: any) => async () => ({ detail, outcome: "answered" as const, eligibility: { reason: "eligible" } })
  const asks: any[] = [], meters: any[] = []
  const gap = (over: Record<string, unknown> = {}) => ({
    providerHealth: async () => null, checkBudget: async () => ({ allowed: true }),
    versium: async (addr: any) => { asks.push(addr); return { facts: { yearBuilt: 1987, propertyType: "Condominium", lastSaleDate: "2015-06-01" }, credits: 1, cost: 0.05, provenance: null } },
    meter: async (m: any) => { meters.push(m); return true }, ...over,
  })
  const ALL = ["yearBuilt", "propertyType", "lastSaleDate"] as const
  const o1 = await chain.getPropertyRecordWithFallback({ brokerageId: A, address: "1 Main St, Anytown, ZZ 00001", contactId: "c-1", gapFields: ALL }, { rentcast: rentcastSeam(rcRow), gapFill: gap() as any })
  ok(o1.record?.provider === "rentcast" && o1.record.yearBuilt === 1987 && o1.record.lastSaleDate === "2015-06-01" && o1.record.propertyType === "Single Family",
    `EXECUTED: RentCast answered with gaps → Versium filled ONLY the empty facts (yearBuilt, lastSaleDate); RentCast's propertyType was NOT overwritten (filled: ${Object.keys(o1.gapFill?.filled ?? {}).join(", ")})`)
  ok(asks.length === 1 && Object.keys(asks[0]).sort().join(",") === "address,city,state,zip", "Versium was asked ONCE, by the postal address alone (no name / email / phone)")
  ok(o1.gapFill?.route.join(",") === "versium" && (o1.gapFill?.skipped ?? []).some((s) => s.provider === "batchdata" && /ONE BatchData door/.test(s.reason)), "the walk is routeCapability(property_facts) minus BatchData (its one door already ran)")
  ok(meters.length === 1 && meters[0].vendorName === "versium" && meters[0].usageType === "property_facts_gap_fill" && meters[0].cost === 0.05 && meters[0].brokerageId === A && o1.gapFill?.costUsd === 0.05, "the match credit is booked ONCE to the tenant on the vendor ledger (meterVendorSpend seam) and reported")
  ok(o1.record?.assessedValue === 210000 && o1.record.lastSalePrice === 199000, "no value / price field is touched by the gap fill (never a valuation)")
  const before = asks.length
  const o2 = await chain.getPropertyRecordWithFallback({ brokerageId: A, address: "1 Main St" }, { rentcast: rentcastSeam(rcRow), gapFill: gap() as any })
  const o3 = await chain.getPropertyRecordWithFallback({ brokerageId: A, address: "1 Main St", gapFields: ALL }, { rentcast: rentcastSeam({ ...rcRow, yearBuilt: 1990, lastSaleDate: "2001-01-01" }), gapFill: gap() as any })
  const o4 = await chain.getPropertyRecordWithFallback({ brokerageId: A, address: "1 Main St", gapFields: ALL }, { rentcast: rentcastSeam(rcRow), gapFill: gap({ providerHealth: async () => ({ state: "failing", routeAround: true, reason: "3 consecutive faults" }) }) as any })
  const o5 = await chain.getPropertyRecordWithFallback({ brokerageId: A, address: "1 Main St", gapFields: ALL }, { rentcast: rentcastSeam(rcRow), gapFill: gap({ checkBudget: async () => ({ allowed: false }) }) as any })
  const o6 = await chain.getPropertyRecordWithFallback({ brokerageId: A, address: "1 Main St", gapFields: ALL, gapFillMaxUsd: 0.01 }, { rentcast: rentcastSeam(rcRow), gapFill: gap() as any })
  ok(asks.length === before && o2.gapFill === null && o3.gapFill?.asked.length === 0 && o4.record?.yearBuilt === null && o5.record?.yearBuilt === null && o6.record?.yearBuilt === null,
    "POSITIVE CONTROLS: no gaps named (net-sheet) / no gaps left / Versium failing (routed around) / budget refused / over the caller's cap → Versium is NEVER asked")
  const mBefore = meters.length
  const o7 = await chain.getPropertyRecordWithFallback({ brokerageId: A, address: "1 Main St", gapFields: ALL }, { rentcast: rentcastSeam(rcRow), gapFill: gap({ versium: async () => ({ facts: null, credits: 0, cost: 0, provenance: null }) }) as any })
  ok(meters.length === mBefore && o7.record?.yearBuilt === null && (o7.gapFill?.costUsd ?? -1) === 0, "a Versium no-match is free: nothing filled, nothing booked")
  // The adapter's own mapping — documented sample row (api-documentation.versium.com/reference/api-output-1).
  const sample = { "Individual Level Match": "Yes", "Home Year Built": "2008", "Home Purchase Date": "20081219", "Home Purchase Price": "$350,000-399,999", "Dwelling Type": "Single Family Dwelling Unit", "Home Value": "$500,000-749,999", "Home Market Value": "568200", "Credit Rating": "700-749", "Household Income": "$150,000-199,999" }
  // Through the REAL adapter (appendVersiumPropertyFacts) with only the network injected.
  const sent: Array<{ output: string; q: Record<string, string> }> = []
  const vCall = (row: Record<string, unknown>) => async (output: "demographic" | "financial", q: Record<string, string>) => { sent.push({ output, q }); return { ok: true, status: 200, data: { versium: { match_counts: { financial: 1 }, results: [row] } } } }
  const r1 = await appendVersiumPropertyFacts({ address: "1 Main St", city: "Anytown", state: "ZZ", zip: "00001" }, { call: vCall(sample) })
  const mapped = r1.facts
  ok(!!mapped && mapped.yearBuilt === 2008 && mapped.propertyType === "Single Family Dwelling Unit" && mapped.lastSaleDate === "2008-12-19" && r1.credits === 1 && r1.cost === 0.05 && r1.provenance?.capability === "property.enrich_facts",
    `the documented sample maps to exact facts through appendVersiumPropertyFacts (${JSON.stringify(mapped)}; 1 credit, $${r1.cost}, provenance property.enrich_facts)`)
  ok(sent.length === 1 && sent[0].output === "financial" && !("first" in sent[0].q) && !("last" in sent[0].q) && !("email" in sent[0].q) && !("phone" in sent[0].q) && sent[0].q.address === "1 Main St",
    "ONE `financial` request, keyed by the postal address alone (no person identifier is ever sent)")
  ok(!/350,000|500,000|568200|700-749|150,000/.test(JSON.stringify(r1)) && Object.keys(mapped ?? {}).sort().join(",") === "lastSaleDate,propertyType,yearBuilt", "no price / value range / market value / credit / income field is ever mapped")
  const r2 = await appendVersiumPropertyFacts({ address: "1 Main St", city: null, state: null, zip: "00001" }, { call: vCall({ "Home Purchase Date": "200812", "Home Year Built": "20o8" }) })
  const r3 = await appendVersiumPropertyFacts({ address: null, city: "Anytown", state: "ZZ", zip: "00001" }, { call: vCall(sample) })
  ok(r2.facts === null && r2.credits === 1 && r3.skipped === "no_address" && sent.length === 2,
    "POSITIVE CONTROLS: a month-only date is never padded and a malformed year is dropped (a billed match with no usable fact still reports its credit); no street address → nothing asked")

  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// N. ZERO HIDDEN PROVIDER CALLS (wave 139, lane 139B). Section I's census reads env keys, client
//    module names, webhook dirs and callConnector literals — a BARE fetch to a vendor host with none
//    of those (Open-Meteo, a second Tavily client, six Google Ads calls behind a declaration that
//    said "no ads call path exists") was invisible to it. This census reads every `fetch(` in the
//    stripped runtime corpus and resolves its URL (a literal, or a same-file const holding one): an
//    external host outside the gateway is a HIDDEN PROVIDER CALL unless RAW_FETCH_EXCEPTIONS
//    publishes a TECHNICAL reason. Plus: the gateway path is tenant scoped, an unhealthy provider is
//    skipped, migrated paths book their outcome row, and the declared transport matches the code.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** A raw fetch that may stay raw — `file|host` → the technical reason it cannot ride callConnector. */
const RAW_FETCH_EXCEPTIONS: Record<string, string> = {
  "lib/voice/elevenlabs-tts.ts|api.elevenlabs.io": "STREAMING TTS — the raw Response body is piped to the client as it arrives; callConnector buffers every response (json/text/arraybuffer) and cannot hand back a stream. The buffered TTS path in the same file uses the gateway (scripts/elevenlabs-egress-guard.ts pins exactly one raw /stream fetch).",
  "app/components/ui/address-autocomplete.tsx|nominatim.openstreetmap.org": "BROWSER call (\"use client\") — the gateway is server-only (it imports the service-role client for its outcome row), so a client component cannot reach it; keyless free geocoder, nothing to meter. Recommendation: a server action over osint_free's nominatim connector.",
  "app/crm/contacts/[contactId]/offers/components/offer-initiation-flow.tsx|nominatim.openstreetmap.org": "BROWSER call (\"use client\") — same as address-autocomplete: the server-only gateway cannot run in a client component; keyless free geocoder. Recommendation: the same server action.",
}

/** Files that ARE the egress (the gateway's own fetch, the probe's) — never a hidden call. */
const EGRESS_FILES = new Set(["lib/agentic-os/connector-gateway.ts", "lib/agentic-os/connector-probe.ts"])

/** PURE — every raw `fetch(` whose URL resolves to an external https host (stripped source; a URL
 *  held in a parameter / property / non-literal const is NOT resolved — published blind spot). */
function rawProviderFetches(files: Array<{ path: string; src: string }>): { hits: Array<{ file: string; host: string; line: number }>; total: number; unresolved: number } {
  const hits: Array<{ file: string; host: string; line: number }> = []
  let total = 0, unresolved = 0
  for (const { path, src } of files) {
    if (EGRESS_FILES.has(path)) continue
    const s = stripComments(src)
    if (!/(?<![.\w])fetch\s*\(/.test(s)) continue
    const consts = new Map<string, string>()
    for (const m of s.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w<>[\]| ]+)?=\s*["'`](https?:\/\/[^"'`$/?]+)/g)) consts.set(m[1], m[2])
    for (const m of s.matchAll(/(?<![.\w])fetch\s*\(\s*([^,)\n]{0,200})/g)) {
      total++
      const arg = m[1].trim()
      const lit = /^["'`](https?:\/\/[^/"'`$?]+)/.exec(arg)
      const ref = lit ? null : (/^`\$\{([A-Za-z_$][\w$]*)\}/.exec(arg) ?? /^([A-Za-z_$][\w$]*)\b/.exec(arg))
      const origin = lit?.[1] ?? (ref && consts.get(ref[1])) ?? null
      if (!origin) { unresolved++; continue }
      let host = ""
      try { host = new URL(origin).hostname.toLowerCase() } catch { unresolved++; continue }
      if (host === "localhost" || host.startsWith("127.") || host.endsWith(".supabase.co")) continue
      hits.push({ file: path, host, line: s.slice(0, m.index).split("\n").length })
    }
  }
  return { hits, total, unresolved }
}

/** The SDK half of the transport audit — the official npm SDK a provider's code imports. */
const SDK_PACKAGE_OF: Record<string, string> = {
  twilio: "twilio", stripe: "stripe", lob: "lob", "@hubspot/api-client": "hubspot", "exa-js": "exa",
  "apify-client": "apify", zenrows: "zenrows", peopledatalabs: "peopledata", "facebook-nodejs-business-sdk": "meta",
  "@elevenlabs/elevenlabs-js": "elevenlabs", "intuit-oauth": "quickbooks", "web-push": "web_push", "@ai-sdk/gateway": "anthropic",
}

async function sectionN(corpus: Array<{ path: string; src: string }>, derived: ReturnType<typeof deriveProviderAdapters>) {
  console.log("\nN. zero hidden provider calls — the raw-fetch census, tenant scope, health skip, outcome booking, transport truth")
  const { hits, total, unresolved } = rawProviderFetches(corpus)
  const key = (h: { file: string; host: string }) => `${h.file}|${h.host}`
  const hidden = hits.filter((h) => !RAW_FETCH_EXCEPTIONS[key(h)])
  ok(total > 0 && hidden.length === 0,
    `${total} raw fetch( calls in ${corpus.length} runtime files · ${hits.length} resolve to an external host · ${hits.length - hidden.length} published exception(s) · ${hidden.length} UNEXPLAINED hidden provider call(s)${hidden.length ? ": " + hidden.map((h) => `${h.host}@${h.file}:${h.line}`).join(", ") : ""} (blind spot: ${unresolved} fetch( with a non-literal URL — self-calls, signed asset URLs, OAuth token URLs held in a property)`)
  const stale = Object.keys(RAW_FETCH_EXCEPTIONS).filter((k) => !hits.some((h) => key(h) === k))
  ok(stale.length === 0, `every RAW_FETCH_EXCEPTION is still a real raw call (else delete it): ${stale.join(", ") || "none stale"}`)
  for (const [k, why] of Object.entries(RAW_FETCH_EXCEPTIONS)) { ok(why.length >= 80, `exception ${k} publishes a technical reason`); }
  // POSITIVE CONTROLS — a planted raw provider fetch (literal + const forms) is flagged; a tombstone,
  // a self-call and the gateway's own fetch are not.
  const planted = rawProviderFetches([
    { path: "lib/external/acmeleads-client.ts", src: `// tombstone: was fetch("https://api.pexels.com/v1/search")\nexport async function a() { return fetch("https://api.acmeleads.com/v1/people?q=1") }\nconst ACME = "https://api.acme.io/v2"\nexport async function b() { return fetch(\`\${ACME}/x\`) }\nexport async function c(baseUrl: string) { return fetch(\`\${baseUrl}/api/cron/x\`) }\n` },
    { path: "lib/agentic-os/connector-gateway.ts", src: `const res = await fetch("https://api.vendor.com/x")` },
  ])
  ok(planted.hits.length === 2 && planted.hits.some((h) => h.host === "api.acmeleads.com") && planted.hits.some((h) => h.host === "api.acme.io") && !planted.hits.some((h) => h.host === "api.pexels.com") && planted.unresolved === 1,
    "POSITIVE CONTROL: a planted raw fetch to a provider host (literal AND const forms) is flagged; a tombstone, a self-call and the gateway's own fetch are not")

  // The migrated sites — each module reaches its provider through callConnector, carries the tenant
  // where the call is made FOR a tenant, and keeps no raw provider fetch.
  const MIGRATED: Array<{ file: string; connector: string; tenant: boolean }> = [
    { file: "lib/marketing/image-library.ts", connector: "pexels", tenant: true },
    { file: "lib/external/geoapify-client.ts", connector: "geoapify", tenant: true },
    { file: "lib/providers/openai-ads.ts", connector: "openai_ads", tenant: true },
    { file: "lib/providers/vibe.ts", connector: "vibe", tenant: true },
    { file: "lib/ads/connectors/google.ts", connector: "google_ads", tenant: true },
    { file: "app/actions/open-house-automation.ts", connector: "open_meteo", tenant: true },
    { file: "lib/kernel/email-deliverability.ts", connector: "sendgrid", tenant: false },
    { file: "lib/platform/custom-domains.ts", connector: "vercel", tenant: false },
  ]
  for (const m of MIGRATED) {
    const s = stripComments(read(m.file))
    const site = new RegExp(`callConnector[\\s\\S]{0,400}connector:\\s*"${m.connector}"`).test(s)
    const tenant = !m.tenant || new RegExp(`connector:\\s*"${m.connector}"[^\\n]*brokerageId|brokerageId[^\\n]*connector:\\s*"${m.connector}"|connector:\\s*"${m.connector}",\\s*\\n\\s*brokerageId`).test(s)
    ok(site && tenant && !hits.some((h) => h.file === m.file) && !!adapterFor(m.connector)?.route.paths.includes("connector_gateway"),
      `${m.file} → callConnector("${m.connector}")${m.tenant ? " with the tenant" : " (platform scope)"}, no raw provider fetch, adapter routed + served`)
  }
  const brand = stripComments(read("app/actions/superadmin/platform-brand.ts"))
  ok(/tavilySearch\(/.test(brand) && !/api\.tavily\.com/.test(brand), "the platform-brand harvest's duplicate raw Tavily client is merged onto the survivor tavilySearch (lib/external/tavily-client.ts)")
  const regSrc = stripComments(read("lib/ads/connectors/registry.ts"))
  ok((regSrc.match(/brokerageId \}/g) ?? []).length >= 3, "loadConnectorCredential stamps the tenant it loaded FOR on every credential it returns (vibe_ctv, chatgpt, platform_credentials)")
  const exceptionsLeft = derived.adapters.filter((a) => a.route.exception).map((a) => a.provider)
  ok(!exceptionsLeft.some((p) => ["pexels", "geoapify", "openai_ads", "vibe", "google_ads", "vercel"].includes(p)), `the outside-the-rails list shrank: ${exceptionsLeft.length} remain (${exceptionsLeft.join(", ")})`)

  // ── behavioural: the gateway path is tenant scoped + books its outcome row (fetch stubbed, fake
  //    service env — nothing leaves the process; every supabase REST call lands in the stub) ──
  const T = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

  const saved = { fetch: globalThis.fetch, url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY, geo: process.env.GEOAPIFY_API_KEY }
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string | null }> = []
  let healthRows: Array<Record<string, unknown>> = []
  const now = Date.now()
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(typeof input === "string" ? input : input?.url ?? input)
    const h: Record<string, string> = {}
    const src = init?.headers ?? {}
    if (typeof src.forEach === "function") src.forEach((v: string, k: string) => { h[k.toLowerCase()] = v })
    else for (const [k, v] of Object.entries(src)) h[k.toLowerCase()] = String(v)
    const body = typeof init?.body === "string" ? init.body : null
    calls.push({ url, method: String(init?.method ?? "GET"), headers: h, body })
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } })
    if (url.startsWith("https://fake-139b.supabase.test/rest/v1/api_response_logs") && String(init?.method ?? "GET") === "GET") return json(/service_key=eq\.geoapify(&|$)/.test(url) ? healthRows : [])
    if (url.startsWith("https://fake-139b.supabase.test/")) return json([], 201)
    if (url.startsWith("https://api.pexels.com/")) return json({ photos: [{ src: { large2x: "https://images.pexels.com/1.jpg", medium: "https://images.pexels.com/1m.jpg" }, alt: "kitchen", photographer: "A" }] })
    if (url.startsWith("https://googleads.googleapis.com/")) return json([{ results: [{ metrics: { costMicros: "5000000", impressions: "100", clicks: "4", conversions: "1", conversionsValue: "0" } }] }])
    if (url.startsWith("https://api.geoapify.com/")) return json({ features: [] })
    return json({ error: { message: "unexpected host in proof" } }, 599)
  }) as typeof fetch
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake-139b.supabase.test"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role"
  process.env.GEOAPIFY_API_KEY = "geo-key"
  const flush = () => new Promise((r) => setTimeout(r, 60))
  const logInserts = () => calls.filter((c) => c.url.includes("/rest/v1/api_response_logs") && c.method === "POST").map((c) => { try { const b = JSON.parse(c.body ?? "null"); return Array.isArray(b) ? b[0] : b } catch { return null } })
  try {
    const { searchPexels } = await import("../lib/marketing/image-library")
    const px = await searchPexels("kitchen island", 3, "tenant-pexels-key", T)
    await flush()
    const pxVendor = calls.find((c) => c.url.startsWith("https://api.pexels.com/"))
    const pxLog = logInserts().find((r) => r?.service_key === "pexels")
    ok(px.ok && px.images.length === 1 && pxVendor?.headers.authorization === "tenant-pexels-key" && /per_page=3/.test(pxVendor.url) && pxLog?.brokerage_id === T && pxLog?.endpoint === "search" && pxLog?.is_error === false,
      `searchPexels → ONE gateway egress (Authorization = the tenant's key) + ONE api_response_logs outcome row booked for the tenant (service_key=${pxLog?.service_key}, brokerage_id=${pxLog?.brokerage_id === T ? "the caller's" : pxLog?.brokerage_id}, endpoint=${pxLog?.endpoint})`)

    const { googleConnector } = await import("../lib/ads/connectors/google")
    const perfAny = await googleConnector.fetchPerformance({ campaignExternalId: "42", sinceIso: new Date(now - 86_400_000).toISOString(), cred: { accessToken: "ya29.t", accountId: "123-456-7890", config: { developer_token: "dev-tok", login_customer_id: "111-222-3333" }, brokerageId: T } })
    const perf = perfAny && "spend" in perfAny ? perfAny : null
    await flush()
    const gVendor = calls.find((c) => c.url.startsWith("https://googleads.googleapis.com/"))
    const gLog = logInserts().find((r) => r?.service_key === "google_ads")
    ok(perf?.spend === 5 && gVendor?.method === "POST" && /customers\/1234567890\/googleAds:searchStream$/.test(gVendor.url) && gVendor.headers.authorization === "Bearer ya29.t" && gVendor.headers["developer-token"] === "dev-tok" && gVendor.headers["login-customer-id"] === "1112223333" && gLog?.brokerage_id === T,
      `google_ads searchStream → the gateway (bearer + developer-token + login-customer-id), mapped spend $${perf?.spend}, outcome row booked for the tenant`)

    // HEALTH: geoapify in a failing cool-down (3 newest faults inside the window) → skipped WITHOUT egress.
    healthRows = [0, 1, 2].map((i) => ({ recorded_at: new Date(now - (i + 1) * 30_000).toISOString(), is_error: true, error_type: "network_or_timeout" }))
    const before = calls.filter((c) => c.url.startsWith("https://api.geoapify.com/")).length
    const { fetchNearbyPlaces } = await import("../lib/external/geoapify-client")
    const geo = await fetchNearbyPlaces("1 Main St", { brokerageId: T })
    const after = calls.filter((c) => c.url.startsWith("https://api.geoapify.com/")).length
    ok(!geo.ok && /^provider_failing: geoapify is failing/.test((geo as { reason: string }).reason) && after === before,
      `an UNHEALTHY provider is skipped at the egress: geoapify failing → no request left the process (${(geo as { reason?: string }).reason?.slice(0, 90)}…)`)
    // POSITIVE CONTROL — a healthy connector with skipWhenFailing still egresses (one attempt, retry off).
    const { callConnector } = await import("../lib/agentic-os/connector-gateway")
    const ctrl = await callConnector({ connector: "geoapify_ctrl_139b", baseUrl: "https://api.geoapify.com", path: "v1/geocode/search", skipWhenFailing: true, retry: false, timeoutMs: 2500, brokerageId: T })
    ok(ctrl.ok && calls.filter((c) => c.url.startsWith("https://api.geoapify.com/")).length === after + 1, "POSITIVE CONTROL: a healthy provider under skipWhenFailing egresses exactly once")
    // REDACTION + SCOPE on the rows logApiResponse really posts: a query-carried key never reaches the
    // ledger; a `url`-mode (presigned) call logs its HOST only; an untenanted call stays platform scope.
    await callConnector({ connector: "redaction_ctrl_139b", baseUrl: "https://api.geoapify.com", path: "v1/geocode/search", query: { text: "x" }, auth: { style: "query", name: "apiKey", value: "SECRET-KEY" }, brokerageId: T, retry: false })
    await callConnector({ connector: "presigned_ctrl_139b", url: "https://api.geoapify.com/bucket/tenant-object.mp4?X-Amz-Signature=SECRET-SIG", method: "POST", body: {} })
    await flush()
    const qRow = logInserts().find((r) => r?.service_key === "redaction_ctrl_139b")
    const uRow = logInserts().find((r) => r?.service_key === "presigned_ctrl_139b")
    ok(qRow?.brokerage_id === T && qRow?.endpoint === "v1/geocode/search" && !JSON.stringify(qRow).includes("SECRET") && uRow?.brokerage_id === null && uRow?.endpoint === "api.geoapify.com" && !JSON.stringify(uRow).includes("SECRET") && !JSON.stringify(uRow).includes("tenant-object"),
      "the posted outcome rows: the tenant lands on the row; no query-carried key, presigned signature or object path reaches the ledger; an untenanted call stays platform scope (null), never an invented tenant")
  } finally {
    globalThis.fetch = saved.fetch
    if (saved.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url
    if (saved.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key
    if (saved.geo === undefined) delete process.env.GEOAPIFY_API_KEY; else process.env.GEOAPIFY_API_KEY = saved.geo
  }
  ok(!calls.some((c) => !c.url.startsWith("https://fake-139b.supabase.test/") && !/^https:\/\/(api\.pexels\.com|googleads\.googleapis\.com|api\.geoapify\.com)\//.test(c.url)), `the stub saw only the proof's hosts (${calls.length} requests, none to a live database)`)

  // FAILOVER where an alternate exists: a derived-health failing provider is skipped by the router.
  const failing = deriveProviderHealth([0, 1, 2].map((i) => ({ at: new Date(now - (i + 1) * 30_000), ok: false, errorType: "provider_error" })), new Date(now))
  const rF = routeCapability("property_facts", { batchdata: failing })
  ok(failing.routeAround && rF.providers[0] !== "batchdata" && rF.skipped.some((x) => x.provider === "batchdata"), `an unhealthy provider WITH an alternate is skipped by routeCapability: property_facts → ${rF.providers[0]} (batchdata failing)`)
  const migratedAlternates = ["pexels", "geoapify", "openai_ads", "vibe", "google_ads", "open_meteo"].filter((p) => Object.values(CONTACT_PROVIDER_ROUTES).some((rows) => rows.some((r) => resolveAdapterKey(r.provider) === p)))
  console.log(`      migrated providers with a routed alternate: ${migratedAlternates.join(", ") || "none — each fails fast on health (skipWhenFailing where latency-bound) and escalates through os-health"}`)

  // ── transport truth: the declared transport matches the code ──
  const imported = new Map<string, Set<string>>()
  for (const f of corpus) {
    const s = stripComments(f.src)
    for (const m of s.matchAll(/(?:from\s+|import\s*\(\s*|require\(\s*|createRequire\([^)]*\)\(\s*)["']([^"']+)["']/g)) {
      const pkg = m[1].startsWith("@") ? m[1].split("/").slice(0, 2).join("/") : m[1].split("/")[0]
      if (SDK_PACKAGE_OF[pkg]) (imported.get(pkg) ?? imported.set(pkg, new Set()).get(pkg)!).add(f.path)
    }
  }
  const staleSdk = Object.keys(SDK_PACKAGE_OF).filter((p) => !imported.has(p))
  ok(staleSdk.length === 0, `every SDK in the transport audit is really imported by runtime code (${imported.size}/${Object.keys(SDK_PACKAGE_OF).length}; stale: ${staleSdk.join(",") || "-"})`)
  const sdkProviders = new Set([...imported.keys()].map((p) => SDK_PACKAGE_OF[p]))
  // A provider reached ONLY through its SDK (no callConnector site) must not be declared "rest"; one
  // declared "sdk" must have an SDK import. Mixed providers (SDK + gateway) keep their primary.
  const mismatches = (adapters: ProviderAdapter[]) => ({
    restButSdkOnly: adapters.filter((a) => a.api.transport === "rest" && sdkProviders.has(a.provider) && !a.route.paths.includes("connector_gateway")).map((a) => a.provider),
    sdkWithoutImport: adapters.filter((a) => a.api.transport === "sdk" && !sdkProviders.has(a.provider)).map((a) => a.provider),
  })
  const mm = mismatches(derived.adapters)
  ok(mm.restButSdkOnly.length === 0 && mm.sdkWithoutImport.length === 0, `declared transport matches the code (rest-declared but SDK-only: ${mm.restButSdkOnly.join(",") || "-"}; sdk-declared with no SDK import: ${mm.sdkWithoutImport.join(",") || "-"})`)
  const forged = mismatches(derived.adapters.map((a) => a.provider === "hubspot" ? { ...a, api: { ...a.api, transport: "rest" as const } } : a.provider === "pexels" ? { ...a, api: { ...a.api, transport: "sdk" as const } } : a))
  ok(forged.restButSdkOnly.includes("hubspot") && forged.sdkWithoutImport.includes("pexels"), "POSITIVE CONTROL: a forged SDK-only provider declared rest (hubspot) and a forged sdk declaration with no SDK import (pexels) are both flagged")
  console.log(`      SDK transports in code: ${[...imported.entries()].map(([p, fs]) => `${SDK_PACKAGE_OF[p]}←${p} (${fs.size})`).join(", ")}`)
}
main().catch((e) => { console.error(e); process.exit(1) })
