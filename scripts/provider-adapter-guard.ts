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
 *      auto-applier knows the kind; declared versions equal the versions the code pins.
 * BLIND SPOTS (published): the live probe and the derived health are injected (their own proofs are
 * test:connector-gateway / test:connector-healer); the census reads static + dynamic import specifiers
 * only (a provider reached through a re-export barrel is not seen); the cron route is checked by
 * stripped-source wiring, not executed.
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

/**
 * PUBLISHED declaration faults (wave 138, lane 138A) — a provider the census found that is truthfully
 * declared but breaks the constitution today (an unpriced or unmetered platform-paid call). The
 * validator refuses each (adapterFor does not serve it: the healer only proposes); this list is a
 * RATCHET — a fault not listed fails the guard, a listed one that is fixed fails until it is removed.
 */
const KNOWN_DECLARATION_FAULTS: Record<string, string> = {
  zyte: "zyte — platform-paid scraper with NO price constant (callers pass their own cost to bookSourceSpend); one Zyte price is owed (138B research: current Zyte API pricing)",
  tavily: "tavily — platform-paid search with NO price constant (callers pass their own cost); one Tavily price is owed",
  openai: "openai — direct-key image generation/edit (lib/ai/image-generation.ts, lib/listings/photo-intelligence.ts) is not booked to ai_tool_usage; route through the AI Gateway or book it",
  voicedrop: "voicedrop (Slybroadcast) — platform-key ringless drops are neither priced nor booked to vendor_usage_tracking",
  google_maps: "google_maps — platform Maps key (server static/street-view + browser) is neither priced nor booked per tenant",
  mapbox: "mapbox — platform browser token (team heatmap) is neither priced nor booked",
}

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
  console.log("\nD. UP + version drift → declared alternate applied, retried once")
  const cD = fakeClient()
  let retries = 0
  const repD = await healProviderFailure({ connector: "quickbooks", brokerageId: A, failures: [{ status: 400, path: "companyinfo", error: "minor version" }], cycle: "d", retry: async () => { retries++; return { ok: true } } },
    { client: cD, now: NOW, probe: async () => "ok", derivedHealth: UP, propose: async () => { throw new Error("must not propose") } })
  const propRows = cD.tables().connector_healing_proposals ?? []
  ok(repD.decision.step === "apply_declared" && repD.applied && propRows.length === 1 && propRows[0].proposal_kind === "declared_alternate" && propRows[0].status === "applied" && propRows[0].applied_by === "auto", "deprecated QBO minor version → declared alternate written as evidence and applied (pending → applied)")
  ok(propRows[0]?.proposal_payload?.alternate_id === "qbo_minorversion_75" && !JSON.stringify(propRows[0]?.proposal_payload ?? {}).includes("https://evil"), "the row stores the alternate ID; the config comes from the code declaration")
  ok(retries === 1 && repD.retried && repD.retryOk === true, "retried exactly ONCE under the applied alternate")
  ok(ledgerActions(cD).join(",") === "provider.heal.probe:executed,provider.heal.apply:executed,provider.heal.retry:executed", `every step ledgered: ${ledgerActions(cD).join(", ")}`)
  ok((cD.tables().agent_action_ledger ?? []).every((r) => r.brokerage_id === A && r.reason_code === "OS_HEALTH_RECOVERY" && r.actor_manager_key === "data_steward"), "ledger rows carry the tenant, OS_HEALTH_RECOVERY and the data_steward actor")
  const applied = await loadAppliedAlternate("quickbooks", cD)
  ok(applied?.alternate.id === "qbo_minorversion_75", "loadAppliedAlternate resolves the applied row back through the declaration")
  const egress = buildAuthedRequest(applyAlternateToRequest({ connector: "quickbooks", baseUrl: "https://quickbooks.api.intuit.com/v3/company/1", path: "companyinfo/1?minorversion=73" }, applied!.alternate, applied!.currentBaseUrl))
  ok(/minorversion=75/.test(egress.url) && !/minorversion=73/.test(egress.url), `egress carries the applied version (${new URL(egress.url).pathname}${new URL(egress.url).search})`)
  const repD2 = await healProviderFailure({ connector: "quickbooks", brokerageId: A, failures: [], cycle: "d2", retry: async () => { retries++; return { ok: true } } },
    { client: cD, now: NOW, probe: async () => "ok", derivedHealth: UP, propose: async () => ({ proposal: { id: "p2", connector: "quickbooks", proposal_kind: "endpoint_change", proposal_summary: "", confidence: 0, status: "pending" }, error: null }) })
  ok(repD2.decision.step === "none" && retries === 1 && (cD.tables().connector_healing_proposals ?? []).length === 1, "a second heal after the apply does NOT re-apply or retry — the applied alternate answered the deprecation")
  const repD3 = await healProviderFailure({ connector: "quickbooks", brokerageId: A, failures: [], cycle: "d3", retry: async () => { retries++; return { ok: true } } },
    { client: cD, now: NOW, probe: async () => "shape_drift", derivedHealth: UP, propose: async () => ({ proposal: { id: "p3", connector: "quickbooks", proposal_kind: "shape_update", proposal_summary: "", confidence: 0, status: "pending" }, error: null }) })
  ok(repD3.decision.step === "propose" && retries === 1 && repD3.proposalId === "p3", "drift that persists AFTER the declared alternate → a proposal (never a second auto-apply)")
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
  const qboPinned = /minorversion=(\d+)/.exec(stripComments(read("lib/providers/accounting/quickbooks.ts")))?.[1]
  ok(!!qboPinned && adapterFor("quickbooks")?.api.version.endsWith(`minorversion=${qboPinned}`), `quickbooks declared version == the minorversion the code pins (${qboPinned})`)
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
  ok(derived.adapters.every((a) => !!a.api.docsUrl && /^https:\/\//.test(a.api.docsUrl)), `every adapter names an https docs root for the provider-setup research step (${derived.adapters.filter((a) => a.api.statusUrl).length} status pages, ${derived.adapters.filter((a) => a.api.changelogUrl).length} changelogs declared)`)
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

  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
