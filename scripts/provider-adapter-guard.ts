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
  bookAdapterUsage, decideProviderHeal, type ProviderAdapter,
} from "../lib/kernel/provider-adapters"
import { healProviderFailure } from "../lib/agentic-os/connector-healer"
import { buildAuthedRequest, applyAlternateToRequest, loadAppliedAlternate } from "../lib/agentic-os/connector-gateway"
import { CONTACT_PROVIDER_ROUTES } from "../lib/ai-isa/property-lookup-rail"

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
  ok(derived.adapters.length === routed.length && routed.length > 0, `derived adapters (${derived.adapters.length}) == routed providers (${routed.length})`)
  const tableProviders = new Set(Object.values(CONTACT_PROVIDER_ROUTES).flat().map((e) => e.provider))
  ok([...tableProviders].every((p) => routed.includes(p)), `every CONTACT_PROVIDER_ROUTES provider is routed (${[...tableProviders].join(", ")})`)
  ok(derived.missing.length === 0 && derived.unrouted.length === 0, `no missing / unrouted declaration (missing=${derived.missing.join(",") || "-"} unrouted=${derived.unrouted.join(",") || "-"})`)
  const setErrs = validateAdapterSet(derived)
  ok(setErrs.length === 0, `validateAdapterSet clean${setErrs.length ? ": " + setErrs.slice(0, 4).join(" | ") : ""}`)
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

  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
