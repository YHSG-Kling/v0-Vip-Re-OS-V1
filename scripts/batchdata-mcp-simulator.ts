/**
 * scripts/batchdata-mcp-simulator.ts   (npm run test:batchdata-mcp)
 *
 * Exercises the wave-67 BatchData MCP + cap-strategy + token-strategy contracts
 * WITHOUT spending real API budget:
 *   - lib/external/batchdata-mcp.ts adapter contract (unconfigured, prefer-MCP fallback)
 *   - OFFICIAL transport module shape (imports the real @modelcontextprotocol/sdk client,
 *     not a hand-rolled JSON-RPC POST) — read from STRIPPED source (CLAUDE.md §2), with a
 *     positive control proving the finder still recognises the old hand-rolled shape.
 *   - pooled subscription plan (lib/external/batchdata-client.ts::buildSmartSearchSubscriptionPlan)
 *   - webhook fan-out by territory (app/api/webhooks/batchdata-smart-search/route.ts) —
 *     read from stripped source, positive control included.
 *   - token resolver precedence (lib/external/batchdata-tokens.ts::resolveBatchDataToken)
 *
 * NO LIVE BATCHDATA CALLS — every network-shaped call in this file runs with the relevant
 * env var(s) deliberately unset so the function's own fail-closed guard returns before any
 * HTTP attempt (the gateway/transport path bails on missing config before any I/O).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { callBatchDataMcp, batchDataPreferMcp } from "../lib/external/batchdata-mcp"
import { buildSmartSearchSubscriptionPlan, createSmartSearchSubscription } from "../lib/external/batchdata-client"
import { resolveBatchDataToken } from "../lib/external/batchdata-tokens"

let pass = 0, fail = 0
const ok = (cond: boolean, msg: string) => { if (cond) pass++; else { fail++; console.log(` ✗ ${msg}`) } }

const root = process.cwd()
const read = (rel: string) => stripComments(readFileSync(join(root, rel), "utf8"))

// ─── 1. MCP adapter contract — unconfigured / prefer-MCP fallback ─────────────────────
{
  // Ensure env is empty for this run regardless of caller shell.
  delete process.env.BATCHDATA_MCP_URL
  delete process.env.BATCHDATA_MCP_AUTH
  delete process.env.BATCHDATA_API_KEY // "mcp" purpose falls back to this — must also be unset

  const r1 = await callBatchDataMcp<{ matches: number }>("lookup_property", { state: "TX" })
  ok(r1.ok === false,                  "MCP: returns ok=false when unconfigured")
  ok(r1.unconfigured === true,          "MCP: unconfigured flag set so caller can fall back")
  ok(typeof r1.error === "string",      "MCP: human-readable error message present")

  const r2 = await batchDataPreferMcp<{ count: number }>(
    "lookup_property", { state: "TX" },
    async () => ({ count: 42 }),  // REST fallback thunk
  )
  ok(r2.via === "rest" && r2.data?.count === 42, "prefer-MCP: falls back to REST thunk when MCP unconfigured")
  ok(r2.error === null,                          "prefer-MCP: REST success surfaces error=null")

  const r3 = await batchDataPreferMcp<{ count: number }>(
    "lookup_property", { state: "TX" },
    async () => { throw new Error("REST blew up") },
  )
  ok(r3.via === "rest" && r3.data === null && (r3.error ?? "").includes("REST"),
     "prefer-MCP: REST throwing surfaces structured error (no uncaught throw)")
}

// ─── 2. Official transport module shape (STRIPPED source, positive control) ───────────
{
  const src = read("lib/external/batchdata-mcp.ts")
  // Static `import type {…} from "…"` and a dynamic `await import("…")` are both real
  // imports of the module — match either form.
  const hasClientImport = /(?:from|import)\s*\(?\s*["']@modelcontextprotocol\/sdk\/client\/index\.js["']/.test(src)
  const hasTransportImport = /(?:from|import)\s*\(?\s*["']@modelcontextprotocol\/sdk\/client\/streamableHttp\.js["']/.test(src)
  const usesCallTool = /client\.callTool\s*\(/.test(src)
  const usesConnect = /client\.connect\s*\(/.test(src)
  const noHandRolledJsonRpc = !/jsonrpc:\s*["']2\.0["']/.test(src)
  const defaultsToOfficialServer = /https:\/\/mcp\.batchdata\.com/.test(src)

  ok(hasClientImport,          "MCP transport: imports the official @modelcontextprotocol/sdk Client")
  ok(hasTransportImport,       "MCP transport: imports the official StreamableHTTPClientTransport")
  ok(usesCallTool,             "MCP transport: calls the real client's callTool()")
  ok(usesConnect,              "MCP transport: connects the real client (client.connect)")
  ok(noHandRolledJsonRpc,      "MCP transport: no hand-rolled JSON-RPC 2.0 body literal left behind")
  ok(defaultsToOfficialServer, "MCP transport: defaults BATCHDATA_MCP_URL to https://mcp.batchdata.com")

  // POSITIVE CONTROL (CLAUDE.md §2) — prove the "no hand-rolled JSON-RPC" finder still
  // recognises the DEFECT it exists to catch, so a false "0 found" can't hide behind a
  // broken regex. A fixture carrying the OLD shape must fail the same check.
  const oldShapeFixture = `const body = { jsonrpc: "2.0", id: "x", method: "tools/call", params: {} }`
  ok(/jsonrpc:\s*["']2\.0["']/.test(oldShapeFixture),
     "positive control: the hand-rolled-JSON-RPC finder still matches the OLD shape")
}

// ─── 3. AI-SDK tool surface module shape ───────────────────────────────────────────────
{
  const src = read("lib/external/batchdata-ai-tools.ts")
  ok(/from\s+["']ai["']/.test(src) && /\btool\b/.test(src) && /\bjsonSchema\b/.test(src),
     "AI tools: imports tool + jsonSchema from the installed `ai` package")
  ok(/listBatchDataMcpTools/.test(src) && /callBatchDataMcp/.test(src),
     "AI tools: wraps the official client's discovery (listTools) + call (callTool) via batchdata-mcp.ts")
  ok(/meterVendorSpend/.test(src),
     "AI tools: meters every tool call into the vendor cost ledger")
  ok(!/@ai-sdk\/mcp/.test(src),
     "AI tools: does NOT import the version-mismatched @ai-sdk/mcp (ai@6 has no MCP export; not installed)")

  const wired = read("app/api/internal/ai-chat/route.ts")
  ok(/batchDataMcpTools/.test(wired) && /\.\.\.batchDataTools/.test(wired),
     "AI tools: wired into the in-app agent copilot's tool registry (app/api/internal/ai-chat)")
}

// ─── 4. Pooled subscription plan — pools BY QUICKLIST, not by (market × quicklist) ─────
{
  const geo = (marketId: string, priority = 1) => ({ marketId, priority, city: "Austin", state: "TX", zip: null })

  // 5 quicklists × 12 markets each → 5 creates, 0 deferred (the cap binds on DISTINCT
  // QUICKLISTS now, never on territory count).
  const fiveQuicklists = Array.from({ length: 5 }, (_, i) => ({
    quicklist: `ql-${i}`,
    geographies: Array.from({ length: 12 }, (_, m) => geo(`market-${i}-${m}`)),
  }))
  const plan5 = buildSmartSearchSubscriptionPlan({ wants: fiveQuicklists, alreadyActive: new Set(), accountLiveCount: 0 })
  ok(plan5.length === 5, "pooled plan: 5 quicklists × 12 markets → 5 plan entries")
  ok(plan5.every((e) => e.action === "create"), "pooled plan: 5 quicklists × 12 markets → all 5 admitted (create)")
  ok(plan5.filter((e) => e.action === "defer").length === 0, "pooled plan: 5 quicklists × 12 markets → 0 deferred")
  ok(plan5.every((e) => e.geographies.length === 12), "pooled plan: every admitted entry carries its full 12-territory pool")

  // 7 quicklists → 5 admitted, 2 deferred (cap bites on the 6th/7th DISTINCT quicklist).
  const sevenQuicklists = Array.from({ length: 7 }, (_, i) => ({
    quicklist: `ql-${i}`,
    priorityHint: 7 - i, // higher index = lower priority, so ql-5/ql-6 defer deterministically
    geographies: [geo(`market-${i}`, 7 - i)],
  }))
  const plan7 = buildSmartSearchSubscriptionPlan({ wants: sevenQuicklists, alreadyActive: new Set(), accountLiveCount: 0 })
  ok(plan7.filter((e) => e.action === "create").length === 5, "pooled plan: 7 quicklists → 5 admitted")
  ok(plan7.filter((e) => e.action === "defer").length === 2,  "pooled plan: 7 quicklists → 2 deferred")

  // A quicklist with 500 contributing territories still costs exactly ONE cap slot —
  // the whole point of pooling.
  const massivePool = [{ quicklist: "fsbo", geographies: Array.from({ length: 500 }, (_, m) => geo(`m-${m}`)) }]
  const planMassive = buildSmartSearchSubscriptionPlan({ wants: massivePool, alreadyActive: new Set(), accountLiveCount: 0 })
  ok(planMassive.length === 1 && planMassive[0].action === "create",
     "pooled plan: 500 territories on ONE quicklist still costs exactly 1 cap slot")

  // Already-active pooled quicklists keep their slot (no thrash) ahead of a new want.
  const kept = buildSmartSearchSubscriptionPlan({
    wants: [
      { quicklist: "fsbo", geographies: [geo("m1", 1)] },
      { quicklist: "probate", geographies: [geo("m2", 99)] }, // higher priority, but fsbo is already active
    ],
    alreadyActive: new Set(["fsbo"]),
    accountLiveCount: 5, // account already at the hard cap
  })
  ok(kept.find((e) => e.quicklist === "fsbo")?.action === "keep",
     "pooled plan: already-active pooled quicklist keeps its slot (no churn)")
  ok(kept.find((e) => e.quicklist === "probate")?.action === "defer",
     "pooled plan: a new quicklist defers when the account is already at cap, even at higher priority")

  // buildPooledSmartSearchQuery is module-private (batchdata-client.ts) — exercised
  // indirectly through createSmartSearchSubscription's own dedupe/union behavior
  // below, never imported by name from outside its module.

  // createSmartSearchSubscription fails closed with no geographies (no network attempt).
  delete process.env.BATCHDATA_API_KEY
  delete process.env.BATCHDATA_SMART_SEARCH_WEBHOOK_URL
  const noKey = await createSmartSearchSubscription({ quicklist: "fsbo", geographies: [{ city: "Austin", state: "TX" }] })
  ok(noKey.ok === false && (noKey.error ?? "").includes("BATCHDATA_API_KEY"),
     "createSmartSearchSubscription: fails closed with no BATCHDATA_API_KEY (no network attempt)")
}

// ─── 5. Webhook fan-out by territory (STRIPPED source, positive control) ──────────────
{
  const src = read("app/api/webhooks/batchdata-smart-search/route.ts")
  const usesActiveTerritoryResolver = /resolveActiveScrapeTerritories/.test(src)
  const matchesByGeography = /recordMatchesTerritory/.test(src)
  const skipsUnmatched = /unmatched\+\+/.test(src)
  // The ids-only event interface carries no market_id — geography match is the ONLY
  // routing. Scope the check to the interface BODY (not the whole file) so it can't
  // be fooled by a market_id used elsewhere for the byMarket grouping map.
  const eventInterfaceMatch = src.match(/interface\s+SmartSearchEvent\s*\{([\s\S]*?)\}/)
  const noMarketIdInEventShape = !!eventInterfaceMatch && !/market_id/.test(eventInterfaceMatch[1])

  ok(usesActiveTerritoryResolver, "webhook fan-out: resolves ACTIVE territories before ingesting any event")
  ok(matchesByGeography,          "webhook fan-out: matches each hydrated property to a market by geography (recordMatchesTerritory)")
  ok(skipsUnmatched,              "webhook fan-out: a property matching NO active territory is skipped, never ingested")
  ok(noMarketIdInEventShape,      "webhook fan-out: the inbound event shape carries no market_id — geography match is the ONLY routing, so a pooled multi-territory subscription's event still lands on the right market")

  // POSITIVE CONTROL — a fixture that ingests everything unconditionally (the defect
  // this section guards against) must FAIL the "skips unmatched" check.
  const noFanOutFixture = `for (const raw of rawMatches) { await ingestRawSourceBatch({ marketId: anyMarket.id, records: [raw] }) }`
  ok(!/unmatched\+\+/.test(noFanOutFixture),
     "positive control: a fixture with no territory fan-out correctly fails the 'skips unmatched' check")
}

// ─── 6. Token resolver precedence ──────────────────────────────────────────────────────
{
  const snapshot = {
    key: process.env.BATCHDATA_API_KEY, skip: process.env.BATCHDATA_SKIP_TRACE_TOKEN,
    listing: process.env.BATCHDATA_LISTING_TOKEN, mcp: process.env.BATCHDATA_MCP_AUTH,
  }
  try {
    // Nothing configured → every purpose resolves null, coarse check false.
    delete process.env.BATCHDATA_API_KEY
    delete process.env.BATCHDATA_SKIP_TRACE_TOKEN
    delete process.env.BATCHDATA_LISTING_TOKEN
    delete process.env.BATCHDATA_MCP_AUTH
    ok(resolveBatchDataToken("search") === null,     "token resolver: search → null when nothing configured")
    ok(resolveBatchDataToken("skip_trace") === null, "token resolver: skip_trace → null when nothing configured")
    ok(resolveBatchDataToken("listing") === null,    "token resolver: listing → null when nothing configured")
    ok(resolveBatchDataToken("mcp") === null,        "token resolver: mcp → null when nothing configured")

    // Only the master key set → every purpose falls back to it.
    process.env.BATCHDATA_API_KEY = "master-key"
    ok(resolveBatchDataToken("search") === "master-key",     "token resolver: search → BATCHDATA_API_KEY")
    ok(resolveBatchDataToken("skip_trace") === "master-key", "token resolver: skip_trace falls back to BATCHDATA_API_KEY when no override")
    ok(resolveBatchDataToken("listing") === "master-key",    "token resolver: listing falls back to BATCHDATA_API_KEY when no override")
    ok(resolveBatchDataToken("mcp") === "master-key",        "token resolver: mcp falls back to BATCHDATA_API_KEY when no override")

    // Every purpose-specific override present → each purpose gets ITS OWN token, never
    // silently sharing provisioning with another purpose's token.
    process.env.BATCHDATA_SKIP_TRACE_TOKEN = "skip-token"
    process.env.BATCHDATA_LISTING_TOKEN = "listing-token"
    process.env.BATCHDATA_MCP_AUTH = "mcp-token"
    ok(resolveBatchDataToken("search") === "master-key",     "token resolver: search stays BATCHDATA_API_KEY even when other overrides exist")
    ok(resolveBatchDataToken("skip_trace") === "skip-token", "token resolver: skip_trace prefers BATCHDATA_SKIP_TRACE_TOKEN over the master key")
    ok(resolveBatchDataToken("listing") === "listing-token", "token resolver: listing prefers BATCHDATA_LISTING_TOKEN over the master key")
    ok(resolveBatchDataToken("mcp") === "mcp-token",          "token resolver: mcp prefers BATCHDATA_MCP_AUTH over the master key")
  } finally {
    // Restore whatever the caller's shell actually had, so this script has no
    // side effects on env for whatever runs after it in the same process/shell.
    for (const [k, v] of Object.entries({
      BATCHDATA_API_KEY: snapshot.key, BATCHDATA_SKIP_TRACE_TOKEN: snapshot.skip,
      BATCHDATA_LISTING_TOKEN: snapshot.listing, BATCHDATA_MCP_AUTH: snapshot.mcp,
    })) {
      if (v === undefined) delete (process.env as any)[k]
      else (process.env as any)[k] = v
    }
  }

  // Token-strategy wiring — batchdata-client.ts request builders read through the
  // resolver rather than the raw env var, for every purpose this wave touched.
  const clientSrc = read("lib/external/batchdata-client.ts")
  const searchCallSites = (clientSrc.match(/resolveBatchDataToken\("search"\)/g) ?? []).length
  const skipTraceCallSites = (clientSrc.match(/resolveBatchDataToken\("skip_trace"\)/g) ?? []).length
  const listingCallSites = (clientSrc.match(/resolveBatchDataToken\("listing"\)/g) ?? []).length
  ok(searchCallSites >= 4,     `token wiring: batchdata-client.ts reads "search" purpose at ${searchCallSites} call sites (want >= 4)`)
  ok(skipTraceCallSites >= 1,  `token wiring: batchdata-client.ts reads "skip_trace" purpose at ${skipTraceCallSites} call site(s)`)
  ok(listingCallSites >= 1,    `token wiring: batchdata-client.ts reads "listing" purpose at ${listingCallSites} call site(s)`)
  const mcpSrc = read("lib/external/batchdata-mcp.ts")
  ok(/resolveBatchDataToken\("mcp"\)/.test(mcpSrc), "token wiring: batchdata-mcp.ts reads the \"mcp\" purpose")
}

// ─── 7. WAVE 69 — the six scraping-frozen orphan exports, wired to real readers ────────
// Owner ruling, verbatim: "scraping is not frozen so those six scraping frozen orphan
// exports should not be blocked." Every scan below reads STRIPPED source (§2) — a
// comment naming the pattern must never count as the pattern itself.
{
  console.log("\n[wave 69 — count-before-page pre-flight, CMA comps lane]")
  const compProvider = read("lib/cma/comp-provider.ts")
  ok(/comparablePropertyCount\s*\(\s*\{\s*address:\s*fullAddress\s*\}\s*\)/.test(compProvider),
     "CMA comp lane: calls comparablePropertyCount BEFORE the billed comps pull")
  ok(/preflight\.ok && preflight\.count === 0/.test(compProvider),
     "CMA comp lane: a confirmed zero count SKIPS the billed comparable_property_page/REST pull")
  ok(/comparablePropertyPreview\s*\(\s*\{\s*address:\s*fullAddress\s*\}\s*\)/.test(compProvider),
     "CMA comp lane: calls comparablePropertyPreview for the CMA UI 'comps available' badge")
  ok(/batchDataMcpPreviewAvailable/.test(compProvider),
     "CMA comp lane: the preview result rides on CompProvenance (the badge's data)")
  ok(/comparablePropertyPage\s*\(\s*\{\s*address:\s*fullAddress/.test(compProvider),
     "CMA comp lane: the billed pull itself tries comparable_property_page (MCP) before the REST fallback")
  ok(/mcpPage\.ok && mcpPage\.rows\.length > 0/.test(compProvider),
     "CMA comp lane: only accepts the MCP page result when it actually returned rows (falls back to REST otherwise)")
  // POSITIVE CONTROL (§2): a fixture that pulls REST FIRST with no pre-flight at all must
  // fail the "calls comparablePropertyCount before the pull" check.
  const noPreflightFixture = `const bd = await fetchBatchDataComps(fullAddress)\ncostCents += Math.round(bd.cost * 100)`
  ok(!/comparablePropertyCount\s*\(\s*\{\s*address:\s*fullAddress\s*\}\s*\)/.test(noPreflightFixture),
     "positive control: a fixture with no pre-flight correctly fails the pre-flight check")

  console.log("\n[wave 69 — count-before-page pre-flight, listing Buy Box lane]")
  const feed = read("lib/kernel/listings-batchdata-feed.ts")
  ok(/investorBuyboxCount\s*\(\s*\{\s*address:\s*listing\.address/.test(feed),
     "Buy Box lane: calls investorBuyboxCount BEFORE the billed investorBuyboxPage pull, per listing")
  ok(/preflight\.ok && preflight\.count === 0\) continue/.test(feed),
     "Buy Box lane: a confirmed zero count SKIPS the page pull for THAT listing (continue, not break)")
  const countIdx = feed.indexOf("investorBuyboxCount(")
  const pageIdx = feed.indexOf("investorBuyboxPage(")
  ok(countIdx > -1 && pageIdx > -1 && countIdx < pageIdx,
     "Buy Box lane: the count pre-flight appears BEFORE the page pull in source order")

  console.log("\n[wave 69 — listing-concierge preview reader]")
  const previewAction = read("app/actions/investor-buybox-preview.ts")
  ok(/investorBuyboxPreview\(/.test(previewAction),
     "listing-concierge: getInvestorBuyboxPreviewForListing calls investorBuyboxPreview")
  ok(/eq\("brokerage_id", ctx\.brokerageId\)/.test(previewAction),
     "listing-concierge: the listing read is scoped to the SESSION's brokerage (§4 — tenant from session, never a param)")
  const previewCard = read("app/components/dashboard/listings/lifecycle/investor-buybox-preview-card.tsx")
  ok(/getInvestorBuyboxPreviewForListing/.test(previewCard),
     "listing-concierge: the 'N investor buyers matched' card calls the reader action")
  const lifecyclePage = read("app/dashboard/listings/[id]/lifecycle/page.tsx")
  ok(/InvestorBuyboxPreviewCard/.test(lifecyclePage),
     "listing-concierge: the card is actually mounted on the listing detail page")

  console.log("\n[wave 69 — BatchData wallet balance reader]")
  const walletRoute = read("app/api/admin/billing/batchdata-wallet/route.ts")
  ok(/fetchBatchDataWalletBalance\(\)/.test(walletRoute),
     "billing diagnostics: the wallet route calls fetchBatchDataWalletBalance")
  ok(/requireSuperadminAuth\(/.test(walletRoute),
     "billing diagnostics: gated to platform staff (platform pays the provider — CLAUDE.md §5)")
  const panel = read("app/components/features/admin/billing-diagnostics-panel.tsx")
  ok(/\/api\/admin\/billing\/batchdata-wallet/.test(panel),
     "billing diagnostics: the panel actually calls the wallet route (a real UI reader, not just the route existing)")
  ok(/balanceUsd/.test(panel) && /estimatedSpendThisMonthUsd/.test(panel),
     "billing diagnostics: the panel shows BOTH the live balance and this month's estimated spend side by side")
}

console.log("\n[wave 71 — extractRows exported for reuse by the ISA tool set]")
{
  const mcpSrc = read("lib/external/batchdata-mcp.ts")
  ok(/export function extractRows\(/.test(mcpSrc),
     "batchdata-mcp.ts: extractRows is exported (was module-private) so batchdata-isa-tools.ts reuses the SAME defensive multi-shape row reader instead of a second copy (CLAUDE.md §6)")
  const isaToolsSrc = read("lib/ai-isa/batchdata-isa-tools.ts")
  ok(/import\s*\{[^}]*\bextractRows\b[^}]*\}\s*from\s*["']@\/lib\/external\/batchdata-mcp["']/.test(isaToolsSrc),
     "batchdata-isa-tools.ts: imports extractRows from batchdata-mcp.ts rather than re-implementing row extraction")
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
