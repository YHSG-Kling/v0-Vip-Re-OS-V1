/**
 * scripts/cost-completeness-guard.ts — test:cost-completeness (wave 139, lane 139C).
 *
 * COST / USAGE COMPLETENESS, proven in memory (no network, no database — the ledgers are an in-memory
 * fake that ENFORCES the live constraints, incl. m750's unique index, so the race path is real):
 *   A. THE PRICE IS A STATE — the ONE price table (cost-normalizer VENDOR_PRICING) is honest: a fixed /
 *      variable row carries a rate, an unknown / free row carries none, a variable / unknown row says
 *      where (or why not). An unknown vendor is priced UNKNOWN (null), never the old $0.01 guess.
 *      POSITIVE CONTROLS: forged rows of each defect are refused.
 *   B. THE PER-CAPABILITY COST RECORD — every platform-paid provider adapter (derived, never pinned)
 *      declares price source, unit, coverage, price state, ledger and booking; printed as the census.
 *   C. VENDOR LEDGER (vendor_usage_tracking via meterVendorSpend → logVendorUsage): a paid call books
 *      ONCE; a retry under the same key books nothing (hours later — no window); a RACE past the lookup
 *      is refused by the unique index (23505 → "already booked"); free books nothing; unknown books its
 *      units at $0 with price_state 'unknown'; a platform row needs the platform flag; no owner → refused.
 *   D. AI LEDGER (ai_tool_usage via logAIImageUsage): the same four properties for image spend, and the
 *      image price is final when the provider reports usage tokens, estimated otherwise.
 *   E. EACH NEWLY BOOKED PROVIDER, ITS POSITIVE CONTROL — zyte, tavily, openai images, voicedrop,
 *      google_maps book through their real booking functions into the fake ledger (and Mapbox is proven
 *      to make NO request, with a planted call as the control).
 *   F. WIRING (stripped source) — every generateImage / webSearch call site passes its spend attribution
 *      or books itself; each finder has a positive control.
 * BLIND SPOTS (published): the fake reproduces the constraints the code depends on, not PostgREST; a
 * generateImage / webSearch reached through a re-export or an aliased dynamic import is not seen;
 * browser-only Maps loads have no server rail (declared on the adapter); hard-coded tier overage
 * literals are LISTED (advisory — Stripe tier pricing is not set; a correction belongs to the owner).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import { runtimeFiles } from "./runtime-roots"
import {
  VENDOR_PRICING, normalizeVendorCost, priceVendorUsage, vendorPriceState,
  priceImageGeneration, imageUsageFrom, ZYTE_REQUEST_COST_USD, TAVILY_CREDITS_PER_SEARCH, TAVILY_CREDIT_USD,
  GOOGLE_MAPS_SKU_USD, type VendorPricing,
} from "../lib/vendor-governance/cost-normalizer"
import { meterVendorSpend } from "../lib/vendor-governance/meter-vendor"
import { logVendorUsage, type VendorUsageEvent } from "../lib/vendor-governance/usage-logger"
import { logAIImageUsage } from "../lib/ai/cost-tracking"
import { webSearch } from "../lib/ai/web-search"
import { bookSourceSpend } from "../lib/lead-pipeline/source-cost-ledger"
import { estimateZyteCost } from "../lib/external/zyte-client"
import { bookMapsImageSpend } from "../lib/property/street-view"
import { deriveProviderAdapters, validateAdapterSet } from "../lib/kernel/provider-adapters"

const ROOT = process.cwd()
let pass = 0, fail = 0
const ok = (c: boolean, n: string) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
const A = "11111111-1111-4111-8111-111111111111"
const B = "22222222-2222-4222-8222-222222222222"

// ─── the in-memory ledger: enforces the live constraints the code relies on ───────────────────────
type Row = Record<string, any>
interface FakeOpts { m750: boolean }
function fakeLedger(opts: FakeOpts = { m750: true }) {
  const tables: Record<string, Row[]> = { vendor_usage_tracking: [], ai_tool_usage: [], automation_errors: [] }
  let blindReads = 0
  const keyOf = (t: string, r: Row): string | null => {
    if (t === "vendor_usage_tracking") return r.request_metadata?.idempotency_key ?? null
    if (t === "ai_tool_usage") { try { return JSON.parse(r.context_json ?? "null")?.idempotency_key ?? null } catch { return null } }
    return null
  }
  const valueAt = (r: Row, col: string): unknown => {
    const m = /^(\w+)->>(\w+)$/.exec(col)
    if (!m) return r[col]
    const base = typeof r[m[1]] === "string" ? JSON.parse(r[m[1]]) : r[m[1]]
    const v = base?.[m[2]]
    return v === undefined || v === null ? null : String(v)
  }
  const likeToRe = (p: string) => new RegExp("^" + p.replace(/\\([%_\\])|([%_])|([.*+?^${}()|[\]])/g, (_s, esc, wild, meta) => esc ? `\\${esc}` : wild === "%" ? ".*" : wild === "_" ? "." : `\\${meta}`) + "$", "s")
  function insertRow(t: string, raw: Row): { error: { code: string; message: string } | null; row?: Row } {
    const r: Row = { id: `row-${tables[t].length + 1}-${Math.random().toString(36).slice(2, 7)}`, created_at: new Date().toISOString(), ...raw }
    if (t === "ai_tool_usage" && r.context_json && typeof r.context_json !== "string") r.context_json = JSON.stringify(r.context_json)
    if (t === "vendor_usage_tracking") {
      if (!opts.m750 && !r.brokerage_id) return { error: { code: "23502", message: "null value in column \"brokerage_id\" violates not-null constraint" } }
      if (opts.m750 && !r.brokerage_id && r.request_metadata?.platform_paid !== true) return { error: { code: "23514", message: "vendor_usage_tracking_platform_rows_are_declared" } }
    }
    if (t === "ai_tool_usage") {
      if (!r.user_id && !r.brokerage_id && !r.platform_paid) return { error: { code: "23514", message: "ai_tool_usage_anon_rows_carry_tenant" } }
      if ((r.tokens_used ?? 0) !== 0 && r.model_used == null) return { error: { code: "23514", message: "ai_tool_usage_tokens_name_their_model" } }
    }
    const k = keyOf(t, r)
    if (k && opts.m750 && tables[t].some((x) => keyOf(t, x) === k && (x.brokerage_id ?? "platform") === (r.brokerage_id ?? "platform"))) {
      return { error: { code: "23505", message: `duplicate key value violates unique constraint "${t}_idempotency_key_uq"` } }
    }
    tables[t].push(r)
    return { error: null, row: r }
  }
  function from(t: string) {
    const filters: Array<(r: Row) => boolean> = []
    let lim = Infinity
    let pendingInsert: Row | null = null
    const run = () => {
      if (pendingInsert) {
        const res = insertRow(t, pendingInsert)
        return res.error ? { data: null, error: res.error } : { data: [{ id: res.row!.id }], error: null }
      }
      if (blindReads > 0) { blindReads--; return { data: [], error: null } }
      return { data: tables[t].filter((r) => filters.every((f) => f(r))).slice(0, lim), error: null }
    }
    const q: any = {
      select: () => q,
      insert: (row: Row) => { pendingInsert = row; return q },
      eq: (c: string, v: unknown) => { filters.push((r) => valueAt(r, c) === v); return q },
      is: (c: string, v: unknown) => { filters.push((r) => (valueAt(r, c) ?? null) === v); return q },
      like: (c: string, p: string) => { const re = likeToRe(p); filters.push((r) => typeof r[c] === "string" && re.test(r[c])); return q },
      order: () => q,
      limit: (n: number) => { lim = n; return q },
      maybeSingle: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error } },
      single: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error } },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    }
    return q
  }
  return { client: { from } as any, tables, blind: (n: number) => { blindReads = n } }
}

async function main() {
  // ── A. the price table ────────────────────────────────────────────────────────────────────────
  console.log("\nA. the price is a STATE, never a guess")
  // A row breaking the honesty rules reads as UNKNOWN (fail closed) — so a declared fixed / variable /
  // free row that comes back unknown is a dishonest row.
  const declared = (p: VendorPricing) => p.priceState ?? (p.costPerUnit > 0 ? "fixed" : "free")
  const demoted = Object.entries(VENDOR_PRICING).filter(([k, p]) => declared(p) !== "unknown" && vendorPriceState(k) === "unknown").map(([k]) => k)
  ok(demoted.length === 0, `VENDOR_PRICING is honest — every row's declared state stands (${Object.keys(VENDOR_PRICING).length} rows${demoted.length ? "; DEMOTED to unknown: " + demoted.join(", ") : ""})`)
  const forged: Record<string, VendorPricing> = {
    zero_variable: { vendorName: "x", unitType: "api_calls", costPerUnit: 0, priceState: "variable", priceSource: "somewhere" },
    priced_unknown: { vendorName: "x", unitType: "api_calls", costPerUnit: 0.05, priceState: "unknown", priceSource: "unknown — guessed" },
    unsourced_variable: { vendorName: "x", unitType: "api_calls", costPerUnit: 0.01, priceState: "variable" },
    honest_variable: { vendorName: "x", unitType: "api_calls", costPerUnit: 0.01, priceState: "variable", priceSource: "https://example.test/pricing" },
  }
  ok(vendorPriceState("zero_variable", forged) === "unknown" && vendorPriceState("unsourced_variable", forged) === "unknown" && vendorPriceState("honest_variable", forged) === "variable" && vendorPriceState("priced_unknown", forged) === "unknown",
    "POSITIVE CONTROL: a $0 'variable' row and an unsourced 'variable' row are DEMOTED to unknown (fail closed); an honest variable row stands")
  ok(normalizeVendorCost("no_such_vendor_139c", 7) === 0 && priceVendorUsage("no_such_vendor_139c", 7).costUsd === null && vendorPriceState("no_such_vendor_139c") === "unknown",
    "an UNKNOWN vendor is priced unknown (null cost, $0 normalized) — the old $0.01/unit fabrication is gone")
  ok(normalizeVendorCost("peopledata", 1) === 0.25 && priceVendorUsage("zyte", 1).priceState === "variable" && priceVendorUsage("osint_free", 3).priceState === "free" && priceVendorUsage("voicedrop", 1).costUsd === null,
    "POSITIVE CONTROL: known rows still price — fixed (peopledata $0.25), variable (zyte), free (osint_free $0), unknown (voicedrop → null)")
  ok(estimateZyteCost("browserHtml") === ZYTE_REQUEST_COST_USD.browserHtml && VENDOR_PRICING.zyte.costPerUnit === ZYTE_REQUEST_COST_USD.browserHtml,
    `one Zyte price: the client reads the table ($${ZYTE_REQUEST_COST_USD.browserHtml}/rendered request, variable by per-domain tier)`)

  // ── B. the per-capability cost record ─────────────────────────────────────────────────────────
  console.log("\nB. every platform-paid capability declares its cost record (derived census)")
  const derived = deriveProviderAdapters()
  const setErrs = validateAdapterSet(derived)
  ok(setErrs.length === 0, `validateAdapterSet: 0 faults (${setErrs.slice(0, 3).join(" | ") || "clean — the six wave-138 published faults are closed"})`)
  const paid = derived.adapters.filter((a) => a.cost.payer === "platform" && a.cost.ledger !== "free" && a.cost.ledger !== "tenant_account")
  const recordFaults: string[] = []
  console.log("      provider · coverage · price state · unit price · unit · ledger · booking")
  for (const a of paid) {
    const priced = a.cost.priceState === "unknown" || a.cost.unitUsd > 0 || a.cost.ledger === "ai_tool_usage"
    if (!priced || a.cost.priceState === "tenant_account" || !a.cost.priceSource.trim() || !a.cost.booking.trim() || /^none\b/.test(a.cost.booking)) recordFaults.push(a.provider)
    console.log(`      ${a.provider} · platform_covered · ${a.cost.priceState} · ${a.cost.priceState === "unknown" ? "UNKNOWN" : `$${a.cost.unitUsd}`} · ${a.cost.unit} · ${a.cost.ledger} · ${a.cost.booking.split(" — ")[0]}`)
  }
  ok(paid.length > 0 && recordFaults.length === 0, `${paid.length} platform-paid adapters (of ${derived.adapters.length}) each declare price state + source + unit + ledger + a real booking${recordFaults.length ? ": " + recordFaults.join(", ") : ""}`)
  const tenantPaid = derived.adapters.filter((a) => a.cost.payer === "tenant").length
  const free = derived.adapters.filter((a) => a.cost.ledger === "free").length
  console.log(`      denominator: ${derived.adapters.length} adapters = ${paid.length} platform-paid + ${tenantPaid} tenant-paid (tenant's own account) + ${free} free/keyless/no-call`)
  const states = new Set(paid.map((a) => a.cost.priceState))
  ok(states.has("fixed") && states.has("variable") && states.has("unknown") && !states.has("tenant_account"), `fixed, variable and unknown prices are all represented and distinguishable; no platform-paid adapter reads as the tenant's price (${[...states].join(", ")})`)

  // ── C. the vendor ledger ──────────────────────────────────────────────────────────────────────
  console.log("\nC. vendor ledger: book once, a retry cannot double-book, free / unknown / platform distinguishable")
  const L = fakeLedger()
  const logger = (e: VendorUsageEvent) => logVendorUsage(e, { client: L.client })
  const vut = () => L.tables.vendor_usage_tracking
  const c1 = await meterVendorSpend({ vendorName: "zyte", usageType: "zillow", cost: 0.004, brokerageId: A, idempotencyKey: "k-zyte-1", priceState: "variable" }, { logger })
  ok(c1 && vut().length === 1 && vut()[0].request_metadata.price_state === "variable" && vut()[0].request_metadata.cost_basis === "estimated" && vut()[0].request_metadata.coverage === "platform_covered",
    "a paid call books ONE row carrying price_state / cost_basis / coverage")
  const later = new Date(Date.now() + 3 * 60 * 60 * 1000)
  const c2 = await logVendorUsage({ vendorName: "zyte", usageType: "zillow", unitCount: 1, estimatedCost: 0.004, systemSource: "retry", brokerageId: A, idempotencyKey: "k-zyte-1", timestamp: later }, { client: L.client })
  ok(c2.success && c2.duplicate === true && vut().length === 1, "a RETRY under the same key three hours later books nothing (no five-minute window)")
  L.blind(1)
  const c3 = await logVendorUsage({ vendorName: "zyte", usageType: "zillow", unitCount: 1, estimatedCost: 0.004, systemSource: "race", brokerageId: A, idempotencyKey: "k-zyte-1" }, { client: L.client })
  ok(c3.success && c3.duplicate === true && vut().length === 1, "a RACE past the lookup is refused by the unique index (23505) and read as already-booked")
  const c4 = await meterVendorSpend({ vendorName: "zyte", usageType: "zillow", cost: 0.004, brokerageId: A, idempotencyKey: "k-zyte-2" }, { logger })
  const c4b = await meterVendorSpend({ vendorName: "zyte", usageType: "zillow", cost: 0.004, brokerageId: B, idempotencyKey: "k-zyte-1" }, { logger })
  ok(c4 && c4b && vut().length === 3, "POSITIVE CONTROL: a different key, and the same key in ANOTHER tenant, each book (the key is tenant-scoped)")
  const free0 = await meterVendorSpend({ vendorName: "osint_free", usageType: "geocode", cost: 0, brokerageId: A }, { logger })
  ok(!free0 && vut().length === 3, "a FREE call (known $0) books nothing")
  const unk = await meterVendorSpend({ vendorName: "voicedrop", usageType: "voicemail_drop", cost: 0, priceState: "unknown", brokerageId: A, idempotencyKey: "voicedrop:slybroadcast:job-1" }, { logger })
  const unkRow = vut().find((r) => r.vendor_name === "voicedrop")
  ok(unk && !!unkRow && unkRow.total_cost === 0 && unkRow.request_metadata.price_state === "unknown" && unkRow.units_used === 1,
    "an UNKNOWN price books its unit at $0 with price_state 'unknown' — counted, never guessed, never mistaken for free")
  const plat = await meterVendorSpend({ vendorName: "tavily", usageType: "web_search", cost: 0.016, brokerageId: null, platformPaid: true, systemSource: "capability_radar", idempotencyKey: "radar-1" }, { logger })
  const platRow = vut().find((r) => r.request_metadata?.system_source === "capability_radar")
  ok(plat && !!platRow && platRow.brokerage_id === null && platRow.request_metadata.platform_paid === true, "a PLATFORM-covered call with no tenant lands as a declared platform row (m750)")
  const platDup = await meterVendorSpend({ vendorName: "tavily", usageType: "web_search", cost: 0.016, brokerageId: null, platformPaid: true, systemSource: "capability_radar", idempotencyKey: "radar-1" }, { logger })
  ok(platDup && vut().filter((r) => r.request_metadata?.system_source === "capability_radar").length === 1, "a platform row's retry is also booked once (platform-pinned key)")
  const orphan = await meterVendorSpend({ vendorName: "tavily", usageType: "web_search", cost: 0.016, brokerageId: null }, { logger })
  const orphanLog = await logVendorUsage({ vendorName: "x", usageType: "y", unitCount: 1, estimatedCost: 1, systemSource: "s", brokerageId: null }, { client: L.client })
  ok(!orphan && !orphanLog.success && /no tenant/.test(orphanLog.error ?? ""), "no tenant and no platform flag → refused (fail closed), and the refusal says why")
  const pre = fakeLedger({ m750: false })
  const preRes = await logVendorUsage({ vendorName: "tavily", usageType: "web_search", unitCount: 1, estimatedCost: 0.016, systemSource: "capability_radar", brokerageId: null, platformPaid: true }, { client: pre.client })
  ok(!preRes.success && /not-null/.test(preRes.error ?? "") && pre.tables.vendor_usage_tracking.length === 0, "BEFORE m750 a platform row is REFUSED and the refusal is RETURNED (never swallowed); tenant rows unaffected")
  const covStates = new Set(vut().map((r) => `${r.request_metadata.price_state}/${r.request_metadata.coverage}`))
  console.log(`      ledger rows: ${vut().length} · states seen: ${[...covStates].join(", ")}`)

  // ── D. the AI ledger (images) ─────────────────────────────────────────────────────────────────
  console.log("\nD. ai_tool_usage: image spend books once, final vs estimated, unknown distinguishable")
  const withUsage = priceImageGeneration({ model: "gpt-image-1", quality: "standard", size: "1024x1024", usage: imageUsageFrom({ input_tokens: 50, output_tokens: 1056, input_tokens_details: { text_tokens: 50, image_tokens: 0 } }) })
  const noUsage = priceImageGeneration({ model: "gpt-image-1", quality: "standard", size: "1024x1024", usage: imageUsageFrom(null) })
  const dalle = priceImageGeneration({ model: "dall-e-3", quality: "hd", size: "1792x1024" })
  ok(withUsage.costBasis === "final" && Math.abs(withUsage.costUsd - (50 * 5 + 1056 * 40) / 1e6) < 1e-9 && noUsage.costBasis === "estimated" && noUsage.costUsd === 0.042 && dalle.priceState === "fixed" && dalle.costUsd === 0.12,
    `image price: usage-reported → FINAL ($${withUsage.costUsd}); none → ESTIMATED ($${noUsage.costUsd}); dall-e-3 hd wide → fixed $${dalle.costUsd}`)
  const I = fakeLedger()
  const atu = () => I.tables.ai_tool_usage
  const img = { brokerageId: A, userId: null, feature: "workflow_ai_image", manager: "campaign_orchestrator", model: "openai/gpt-image-1 (AI Gateway)", costUsd: noUsage.costUsd, priceState: noUsage.priceState, costBasis: noUsage.costBasis, idempotencyKey: "workflow_image:enr-1:step-1" } as const
  const d1 = await logAIImageUsage(img, { client: I.client })
  const ctx = JSON.parse(atu()[0]?.context_json ?? "{}")
  ok(d1.booked && atu().length === 1 && atu()[0].cost_cents === 4 && atu()[0].model_used === null && atu()[0].tokens_used === 0 && ctx.price_state === "variable" && ctx.cost_basis === "estimated" && ctx.idempotency_key === img.idempotencyKey,
    "an image books ONE ai_tool_usage row (4¢, model in context_json, tokens 0 — the live CHECKs) with state + basis + key")
  const d2 = await logAIImageUsage(img, { client: I.client })
  ok(!d2.booked && d2.duplicate && atu().length === 1, "a retried workflow step (same key) books nothing")
  I.blind(1)
  const d3 = await logAIImageUsage(img, { client: I.client })
  ok(!d3.booked && d3.duplicate && atu().length === 1, "a RACE past the lookup is refused by the unique index (23505) and read as already-booked")
  const d4 = await logAIImageUsage({ ...img, idempotencyKey: "workflow_image:enr-1:step-2" }, { client: I.client })
  const d5 = await logAIImageUsage({ ...img, idempotencyKey: "workflow_image:enr-1_step-1" }, { client: I.client })
  ok(d4.booked && d5.booked && atu().length === 3, "POSITIVE CONTROL: a different step books; a key differing only where LIKE's '_' wildcard would match is NOT mistaken for the first (parsed, not pattern-matched)")
  const d6 = await logAIImageUsage({ ...img, idempotencyKey: null, costUsd: null, priceState: "unknown" }, { client: I.client })
  ok(d6.booked && JSON.parse(atu()[3].context_json).price_state === "unknown" && atu()[3].cost_cents === 0, "an unknown image price books at 0¢ with price_state 'unknown'")
  const d7 = await logAIImageUsage({ ...img, brokerageId: null, idempotencyKey: null }, { client: I.client })
  ok(!d7.booked && atu().length === 4 && /no tenant, user or platform flag/.test(d7.error ?? ""), "no tenant / user / platform flag → refused before the insert")

  // ── E. each newly booked provider — its positive control ──────────────────────────────────────
  console.log("\nE. each newly booked provider books through its real booking function")
  const E = fakeLedger()
  const elog = (e: VendorUsageEvent) => logVendorUsage(e, { client: E.client })
  const ev = () => E.tables.vendor_usage_tracking
  await bookSourceSpend({ source: "zillow", cost: estimateZyteCost("browserHtml"), brokerageId: A, providerOverride: "zyte" }, { logger: elog })
  ok(ev().some((r) => r.vendor_name === "zyte" && r.total_cost === ZYTE_REQUEST_COST_USD.browserHtml), "zyte: a portal scrape books at the table's variable rate through bookSourceSpend")
  const tavCost = TAVILY_CREDITS_PER_SEARCH.advanced * TAVILY_CREDIT_USD
  const wsMeter = (i: Parameters<typeof meterVendorSpend>[0]) => meterVendorSpend(i, { logger: elog })
  // The REAL webSearch, with its two searchers injected (no network): research mode → Tavily first.
  const tavilyFake = async () => ({ answer: "a", results: [{ title: "t", url: "https://x.test", content: "c", score: 1 }], images: [], cost: tavCost })
  const exaFake = async () => ({ results: [{ title: "t", url: "https://y.test", text: "s" }], cost: 0.007, costBasis: "final" as const })
  const noneFake = async () => ({ answer: null, results: [], images: [], cost: 0 })
  const noExa = async () => ({ results: [], cost: 0 })
  const t1 = (await webSearch({ query: "q", mode: "research", spend: { brokerageId: A, systemSource: "ai_search_citation_monitor" } }, { tavily: tavilyFake as never, exa: exaFake as never, meter: wsMeter })).booked
  const t0 = (await webSearch({ query: "q", mode: "research", spend: { brokerageId: A, systemSource: "x" } }, { tavily: noneFake as never, exa: noExa as never, meter: wsMeter })).booked
  const e1 = (await webSearch({ query: "q", mode: "intent", spend: { brokerageId: null, platformPaid: true, systemSource: "capability_radar" } }, { tavily: tavilyFake as never, exa: exaFake as never, meter: wsMeter })).booked
  const unattributedSearch = (await webSearch({ query: "q", mode: "research" }, { tavily: tavilyFake as never, exa: exaFake as never, meter: wsMeter })).booked
  ok(t1 === true && t0 === false && e1 === true && unattributedSearch === undefined && ev().filter((r) => r.vendor_name === "tavily").length === 1 && ev().some((r) => r.vendor_name === "tavily" && r.total_cost === tavCost) && ev().some((r) => r.vendor_name === "exa" && r.request_metadata.cost_basis === "final" && r.brokerage_id === null),
    `tavily: an advanced search books 2 credits × $${TAVILY_CREDIT_USD}; exa's SDK-reported cost books FINAL; a 'none' result books nothing`)
  const keyedUrl = "https://maps.googleapis.com/maps/api/streetview?size=800x600&location=1+Main+St&key=SECRET_KEY_139C"
  const mMeter = (i: Parameters<typeof meterVendorSpend>[0]) => meterVendorSpend(i, { logger: elog })
  await bookMapsImageSpend({ brokerageId: A, sku: "street_view_static", url: keyedUrl, systemSource: "lead_intelligence" }, { meter: mMeter })
  await bookMapsImageSpend({ brokerageId: A, sku: "street_view_static", url: keyedUrl.replace("SECRET_KEY_139C", "ROTATED"), systemSource: "listing_presentation" }, { meter: mMeter })
  await bookMapsImageSpend({ brokerageId: A, sku: "static_map", url: "https://maps.googleapis.com/maps/api/staticmap?center=1,2&key=SECRET_KEY_139C", systemSource: "listing_presentation" }, { meter: mMeter })
  const maps = ev().filter((r) => r.vendor_name === "google_maps")
  ok(maps.length === 2 && maps.some((r) => r.total_cost === GOOGLE_MAPS_SKU_USD.street_view_static) && maps.some((r) => r.total_cost === GOOGLE_MAPS_SKU_USD.static_map) && !JSON.stringify(maps).includes("SECRET_KEY_139C"),
    "google_maps: one booking per tenant · SKU · location · day (a second mint of the same image books nothing, a different SKU does) and the API key never reaches the ledger")
  const I2 = fakeLedger()
  const pe = await logAIImageUsage({ brokerageId: A, userId: null, feature: "photo_virtual_staging", model: "gpt-image-1 edit", costUsd: 0.063, priceState: "variable", costBasis: "estimated", idempotencyKey: "photo_edit:job-1" }, { client: I2.client })
  ok(pe.booked && I2.tables.ai_tool_usage.length === 1, "openai (photo edit): a staging edit books once under its photo-edit job key")
  ok(ev().some((r) => r.vendor_name === "voicedrop") || vut().some((r) => r.vendor_name === "voicedrop"), "voicedrop: a delivered drop books one unit, price explicitly unknown (C above, the orchestrator's exact call shape)")

  // ── F. wiring (stripped source) ───────────────────────────────────────────────────────────────
  console.log("\nF. wiring — every call site carries its spend attribution (stripped source, positive controls)")
  const corpus = runtimeFiles().map((p) => p.replace(/^\.\//, "")).filter((p) => /\.(ts|tsx)$/.test(p)).map((p) => ({ path: p, src: read(p) }))
  const argsOf = (code: string, open: number) => { let d = 0; for (let i = open; i < code.length; i++) { const c = code[i]; if (c === "(" || c === "{" || c === "[") d++; else if (c === ")" || c === "}" || c === "]") { d--; if (d === 0) return code.slice(open + 1, i) } } return code.slice(open + 1) }
  /** Call sites of `fn` imported (static or dynamic) from `mod`, whose args lack `spend` — in a file that does not book itself. */
  const unattributed = (src: string, fn: string, mod: RegExp, booksItself: RegExp): number => {
    const noComments = stripComments(src)
    const imports = new RegExp(`import\\s*(?:type\\s+)?\\{[^}]*\\b${fn}\\b[^}]*\\}\\s*from\\s*["']([^"']+)["']|\\{[^}]*\\b${fn}\\b[^}]*\\}\\s*=\\s*await\\s+import\\(\\s*["']([^"']+)["']\\s*\\)`, "g")
    let imported = false, m: RegExpExecArray | null
    while ((m = imports.exec(noComments))) if (mod.test(m[1] ?? m[2] ?? "")) imported = true
    if (!imported) return 0
    // A file that books the spend itself is read with its strings KEPT (the table name is a string).
    if (booksItself.test(noComments)) return 0
    const code = blankStrings(noComments)
    let n = 0
    const call = new RegExp(`\\b${fn}\\s*\\(`, "g")
    while ((m = call.exec(code))) {
      const before = code.slice(Math.max(0, m.index - 30), m.index)
      if (/function\s+$|async\s+$/.test(before)) continue
      if (!/\bspend\b/.test(argsOf(code, m.index + m[0].length - 1))) n++
    }
    return n
  }
  const IMG_MOD = /(^@\/|\/)lib\/ai\/image-generation$/
  const IMG_SELF = /\bfrom\(\s*["'`]ai_tool_usage["'`]\s*\)[\s\S]{0,120}?\.insert\s*\(|\blogAIImageUsage\s*\(/
  const imgFaults = corpus.filter((f) => f.path !== "lib/ai/image-generation.ts").map((f) => ({ f: f.path, n: unattributed(f.src, "generateImage", IMG_MOD, IMG_SELF) })).filter((x) => x.n > 0)
  const imgSites = corpus.filter((f) => /image-generation["']/.test(f.src) && /generateImage\s*\(/.test(stripComments(f.src))).length
  ok(imgFaults.length === 0, `every generateImage call site passes spend: or books the image itself (${imgSites} files reach it${imgFaults.length ? "; UNBOOKED: " + imgFaults.map((x) => `${x.f} ×${x.n}`).join(", ") : ""})`)
  const imgPlant = `import { generateImage } from "@/lib/ai/image-generation"\n// generateImage({ prompt }) in a comment\nexport async function x(b: string) { return generateImage({ prompt: "p", purpose: "generic" }) }`
  const imgOk = `const { generateImage } = await import("@/lib/ai/image-generation")\nconst r = await generateImage({ prompt: "p", purpose: "generic", spend: { brokerageId: b, feature: "f" } })`
  ok(unattributed(imgPlant, "generateImage", IMG_MOD, IMG_SELF) === 1 && unattributed(imgOk, "generateImage", IMG_MOD, IMG_SELF) === 0, "POSITIVE CONTROL: a planted unattributed generateImage call is found (the comment is not), an attributed dynamic-import call is not")
  const WS_MOD = /(^@\/|\/)lib\/ai\/web-search$/
  const WS_SELF = /\bmeterVendorSpend\s*\(|\bbookSourceSpend\s*\(/
  // regulatory-watcher's realRegSearchFetcher RETURNS res.cost: its two callers meter it (law-rule-healing
  // through its injected meter, the watcher pass through meterVendorSpend — wave 139). Named, checked below.
  const WS_RETURNS_COST = new Set(["lib/kernel/regulatory-watcher.ts"])
  const wsFaults = corpus.filter((f) => f.path !== "lib/ai/web-search.ts" && !WS_RETURNS_COST.has(f.path)).map((f) => ({ f: f.path, n: unattributed(f.src, "webSearch", WS_MOD, WS_SELF) })).filter((x) => x.n > 0)
  ok(wsFaults.length === 0, `every webSearch call site passes spend: or meters the returned cost itself${wsFaults.length ? "; UNBOOKED: " + wsFaults.map((x) => `${x.f} ×${x.n}`).join(", ") : ""}`)
  const rw = stripComments(read("lib/kernel/regulatory-watcher.ts")), lrh = stripComments(read("lib/kernel/law-rule-healing.ts"))
  ok(/cost:\s*res\.cost/.test(rw) && /meterVendorSpend\(\{[^}]*systemSource:\s*"regulatory_watcher"/.test(rw) && /meterVendorSpend\(input\)/.test(lrh), "the named exception holds: realRegSearchFetcher returns the cost and BOTH of its callers meter it")
  ok(unattributed(`import { webSearch } from "@/lib/ai/web-search"\nexport const f = () => webSearch({ query: "q" })`, "webSearch", WS_MOD, WS_SELF) === 1, "POSITIVE CONTROL: a planted unattributed webSearch call is found")
  const wired: Array<[string, RegExp, string]> = [
    ["lib/ai/image-generation.ts", /if \(input\.spend\) \{[\s\S]{0,200}logAIImageUsage\(/, "generateImage books through logAIImageUsage when attributed"],
    ["lib/listings/photo-intelligence.ts", /logAIImageUsage\(\{[\s\S]{0,400}idempotencyKey: `photo_edit:\$\{jobId\}`/, "photo edits book once per photo-edit job"],
    ["lib/voicedrop/orchestrate-voicedrop-send.ts", /if \(delivered\) \{[\s\S]{0,200}meterVendorSpend\(\{[\s\S]{0,120}cost: 0, priceState: "unknown"/, "a delivered voice drop books its unit, price unknown"],
    ["app/actions/lead-intelligence.ts", /bookMapsImageSpend\(\{[^}]*sku: "street_view_static"/, "the vision Street View fetch books its Maps image"],
    ["lib/workflow/intelligence/listing-presentation-builder.ts", /bookMapsImageSpend\(\{/, "the presentation cover books its Maps image"],
    ["lib/external/tavily-client.ts", /TAVILY_CREDITS_PER_SEARCH\[[\s\S]{0,80}\* TAVILY_CREDIT_USD/, "tavily's cost reads the one price table"],
    ["lib/external/zyte-client.ts", /return ZYTE_REQUEST_COST_USD\[mode\]/, "zyte's cost reads the one price table"],
  ]
  for (const [p, re, what] of wired) ok(re.test(stripComments(read(p))), `${what} (${p})`)
  const literalCost = (src: string) => /\bcost:\s*params\.searchDepth\s*===\s*"advanced"\s*\?\s*0\.\d+/.test(stripComments(src)) || /return\s+mode\s*===\s*"browserHtml"\s*\?\s*0\.\d+/.test(stripComments(src))
  ok(!literalCost(read("lib/external/tavily-client.ts")) && !literalCost(read("lib/external/zyte-client.ts")) && literalCost(`cost: params.searchDepth === "advanced" ? 0.01 : 0.005`), "no second price literal in the tavily / zyte clients (POSITIVE CONTROL: the old literal is recognised)")

  // Mapbox — re-proven at HEAD: no request exists, so there is nothing to book.
  const mapboxCall = (src: string) => /api\.mapbox\.com|from\s+["']mapbox-gl["']|["']@mapbox\/|import\(\s*["']mapbox-gl["']/.test(stripComments(src))
  const mapboxFiles = corpus.filter((f) => f.path !== "lib/kernel/provider-adapters.ts" && mapboxCall(f.src)).map((f) => f.path)
  ok(mapboxFiles.length === 0, `no Mapbox request anywhere in runtime code (${corpus.length} files; the adapter declaration excluded)${mapboxFiles.length ? ": " + mapboxFiles.join(", ") : ""}`)
  ok(mapboxCall(`await fetch("https://api.mapbox.com/styles/v1/x")`) && !mapboxCall(`// was api.mapbox.com`), "POSITIVE CONTROL: a planted Mapbox fetch is found; a comment is not")

  // Advisory (owner: Stripe tier pricing is NOT set) — hard-coded tier overage literals are LISTED.
  const overageLit = (src: string) => (stripComments(src).match(/\boverage\w*Cents\s*:\s*\d+/g) ?? []).length
  const overageFiles = corpus.map((f) => ({ f: f.path, n: overageLit(f.src) })).filter((x) => x.n > 0)
  console.log(`      advisory — hard-coded tier overage literals (owner decision, not fixed here): ${overageFiles.map((x) => `${x.f} ×${x.n}`).join(", ") || "none"}`)
  ok(overageLit(`solo: { overageSmsCents: 2 }`) === 1 && overageLit(`// overageSmsCents: 2`) === 0, "POSITIVE CONTROL: the overage-literal finder sees a live literal, not a comment")

  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
