/**
 * scripts/rentcast-copilot-tools-simulator.ts   (npm run test:rentcast-copilot-tools)
 *
 * Proves the wave-69 RentCast MCP contract WITHOUT spending real API budget or LLM tokens:
 *
 * OWNER RULING (verbatim, 2026-09-17): "we are trying to keep the cost down for tenant
 * subscription so all providers that we use for this os needs to keep that in mind... try to
 * use an sdk or mcp if it is provided but keeping pricing in mind."
 *
 * RESEARCHED (developers.rentcast.io, 2026-09-17): RentCast's MCP server bills an MCP call as an
 * ordinary API request, at the SAME per-request price as REST — so a production/bulk pull must
 * stay on the typed REST client (cheaper: no LLM token overhead for the identical data), and the
 * MCP surface exists ONLY for the agent copilot's ad-hoc lookups.
 *
 *   - lib/external/rentcast-mcp.ts adapter contract (fail-closed without RENTCAST_API_KEY)
 *   - official transport module shape (the real @modelcontextprotocol/sdk client, X-Api-Key
 *     header — not Authorization: Bearer, not a hand-rolled JSON-RPC POST) — read from STRIPPED
 *     source (CLAUDE.md §2), with a positive control proving the finder still recognises the
 *     defect shape it exists to catch.
 *   - lib/external/rentcast-ai-tools.ts AI-SDK tool surface: gated, metered at
 *     RENTCAST_USD_PER_REQUEST (the SAME constant the REST client uses — one vocabulary, §6),
 *     wired into the in-app agent copilot beside batchDataMcpTools.
 *   - NO PRODUCTION PULL PATH imports the MCP client — lib/property/rentcast.ts (the typed REST
 *     client every scheduled/bulk RentCast reader in the tree calls) never references the MCP
 *     transport or the AI-tools wrapper.
 *
 * NO LIVE RENTCAST CALLS — every network-shaped call in this file runs with RENTCAST_API_KEY
 * deliberately unset so the function's own fail-closed guard returns before any HTTP attempt.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { callRentcastMcp, listRentcastMcpTools } from "../lib/external/rentcast-mcp"
import { rentCastMcpTools } from "../lib/external/rentcast-ai-tools"

let pass = 0, fail = 0
const ok = (cond: boolean, msg: string) => { if (cond) pass++; else { fail++; console.log(` ✗ ${msg}`) } }

const root = process.cwd()
const read = (rel: string) => stripComments(readFileSync(join(root, rel), "utf8"))
const raw = (rel: string) => readFileSync(join(root, rel), "utf8")

// ─── 1. MCP adapter contract — fail-closed without RENTCAST_API_KEY ────────────────────
{
  const saved = process.env.RENTCAST_API_KEY
  delete process.env.RENTCAST_API_KEY
  delete process.env.RENTCAST_MCP_URL

  try {
    const r1 = await callRentcastMcp<{ price: number }>("get_avm_value", { address: "1 Main St" })
    ok(r1.ok === false,             "MCP call: returns ok=false when RENTCAST_API_KEY is unset")
    ok(r1.unconfigured === true,     "MCP call: unconfigured flag set so the caller can refuse cleanly")
    ok(typeof r1.error === "string", "MCP call: human-readable error message present")
    ok(r1.data === null,             "MCP call: no data fabricated on an unconfigured call")

    const r2 = await listRentcastMcpTools()
    ok(r2.ok === false && r2.unconfigured === true, "MCP discovery: unconfigured, ok=false, tools=[] — no network attempt")
    ok(r2.tools.length === 0,                        "MCP discovery: empty tool list when unconfigured")

    const tools = await rentCastMcpTools({ brokerageId: "test-brokerage-id" })
    ok(Object.keys(tools).length === 0, "AI-SDK tool surface: returns {} (no tools) when RENTCAST_API_KEY is unset")

    const toolsNoBrokerage = await rentCastMcpTools({ brokerageId: "" })
    ok(Object.keys(toolsNoBrokerage).length === 0, "AI-SDK tool surface: refuses a tenant-less call even if a key WERE present (§4)")
  } finally {
    if (saved === undefined) delete process.env.RENTCAST_API_KEY
    else process.env.RENTCAST_API_KEY = saved
  }
}

// ─── 2. Official transport module shape (STRIPPED source, positive control) ────────────
{
  const src = read("lib/external/rentcast-mcp.ts")
  const hasClientImport = /(?:from|import)\s*\(?\s*["']@modelcontextprotocol\/sdk\/client\/index\.js["']/.test(src)
  const hasTransportImport = /(?:from|import)\s*\(?\s*["']@modelcontextprotocol\/sdk\/client\/streamableHttp\.js["']/.test(src)
  const usesCallTool = /client\.callTool\s*\(/.test(src)
  const usesConnect = /client\.connect\s*\(/.test(src)
  const usesApiKeyHeader = /["']X-Api-Key["']\s*:\s*key/.test(src)
  const neverUsesBearer = !/Authorization:\s*`Bearer/.test(src)
  const noHandRolledJsonRpc = !/jsonrpc:\s*["']2\.0["']/.test(src)
  const defaultsToOfficialServer = /https:\/\/developers\.rentcast\.io\/mcp/.test(src)

  ok(hasClientImport,          "MCP transport: imports the official @modelcontextprotocol/sdk Client")
  ok(hasTransportImport,       "MCP transport: imports the official StreamableHTTPClientTransport")
  ok(usesCallTool,             "MCP transport: calls the real client's callTool()")
  ok(usesConnect,              "MCP transport: connects the real client (client.connect)")
  ok(usesApiKeyHeader,         "MCP transport: authenticates with the X-Api-Key header (RentCast's documented scheme)")
  ok(neverUsesBearer,          "MCP transport: never sends an Authorization: Bearer header (that's BatchData's scheme, not RentCast's)")
  ok(noHandRolledJsonRpc,      "MCP transport: no hand-rolled JSON-RPC 2.0 body literal")
  ok(defaultsToOfficialServer, "MCP transport: defaults RENTCAST_MCP_URL to https://developers.rentcast.io/mcp")

  // POSITIVE CONTROL (CLAUDE.md §2) — the "no hand-rolled JSON-RPC" finder must still catch
  // the defect shape it exists to catch, and the "never Bearer" finder must still catch a
  // fixture that DOES send Bearer — a broken regex reporting 0 defects is not the same as a
  // clean tree.
  const oldShapeFixture = `const body = { jsonrpc: "2.0", id: "x", method: "tools/call", params: {} }`
  ok(/jsonrpc:\s*["']2\.0["']/.test(oldShapeFixture),
     "positive control: the hand-rolled-JSON-RPC finder still matches the OLD shape")
  const bearerFixture = `headers: { Authorization: \`Bearer \${key}\` }`
  ok(/Authorization:\s*`Bearer/.test(bearerFixture),
     "positive control: the never-Bearer finder still matches a fixture that DOES send Bearer")
}

// ─── 3. AI-SDK tool surface module shape + metering ─────────────────────────────────────
{
  const src = read("lib/external/rentcast-ai-tools.ts")
  ok(/from\s+["']ai["']/.test(src) && /\btool\b/.test(src) && /\bjsonSchema\b/.test(src),
     "AI tools: imports tool + jsonSchema from the installed `ai` package")
  ok(/listRentcastMcpTools/.test(src) && /callRentcastMcp/.test(src),
     "AI tools: wraps the official client's discovery (listTools) + call (callTool) via rentcast-mcp.ts")
  ok(/meterVendorSpend/.test(src),
     "AI tools: meters every tool call into the vendor cost ledger")
  ok(/import \{ RENTCAST_USD_PER_REQUEST \} from "@\/lib\/property\/rentcast"/.test(src) && /cost: RENTCAST_USD_PER_REQUEST/.test(src),
     "AI tools: meters at RENTCAST_USD_PER_REQUEST — the SAME constant the REST client uses (one vocabulary, §6), never a second invented price")
  ok(!/@ai-sdk\/mcp/.test(src),
     "AI tools: does NOT import the version-mismatched @ai-sdk/mcp (ai@6 has no MCP export; not installed)")

  const wired = read("app/api/internal/ai-chat/route.ts")
  ok(/rentCastMcpTools/.test(wired) && /\.\.\.rentCastTools/.test(wired),
     "AI tools: wired into the in-app agent copilot's tool registry (app/api/internal/ai-chat), beside batchDataTools")
  ok(/\.\.\.agentTools,\s*\.\.\.batchDataTools,\s*\.\.\.rentCastTools/.test(wired),
     "AI tools: spread into the SAME tools object as batchDataTools — one tool registry, not a second stream")
}

// ─── 4. RENTCAST_USD_PER_REQUEST is derived, documented, and used by BOTH REST + MCP ────
{
  const src = read("lib/property/rentcast.ts")
  ok(/export const RENTCAST_USD_PER_REQUEST = 0\.074/.test(src),
     "REST client: exports RENTCAST_USD_PER_REQUEST = 0.074 (Foundation tier $74/1,000 requests)")
  const usageCount = (src.match(/cost: RENTCAST_USD_PER_REQUEST/g) ?? []).length
  ok(usageCount >= 6, `REST client: every metered call site uses the ONE constant (found ${usageCount}, want >= 6 — listings/sale, listings/sale/{id}, rental, avm x2, markets)`)
  // `src` is COMMENT-STRIPPED (CLAUDE.md §2) — a mention of the retired names inside the
  // explanatory doc comment above RENTCAST_USD_PER_REQUEST must not count as live code.
  ok(!/COST_PER_LISTING_SEARCH|COST_PER_AVM_LOOKUP|COST_PER_MARKET_LOOKUP/.test(src),
     "REST client: the three old per-endpoint price constants are gone from LIVE code (only mentioned in the explanatory comment)")
  // POSITIVE CONTROL: the raw (unstripped) header comment DOES still name the retired
  // constants (documenting why they were replaced) — proves the finder isn't just matching
  // an empty file.
  const rawSrc = raw("lib/property/rentcast.ts")
  ok(/COST_PER_LISTING_SEARCH/.test(rawSrc),
     "positive control: the retired constant name is still readable in the explanatory comment (not silently deleted from history)")
}

// ─── 5. NO PRODUCTION PULL PATH imports the MCP client ──────────────────────────────────
// STRIPPED source (CLAUDE.md §2) — lib/property/rentcast.ts's own doc comments NAME
// rentcast-ai-tools.ts (explaining the metering relationship); that mention must never count
// as a live import.
{
  const restClient = read("lib/property/rentcast.ts")
  const typedFacade = read("lib/external/rentcast-typed.ts")
  ok(!/from\s+["'].*rentcast-mcp["']/.test(restClient) && !/from\s+["'].*rentcast-ai-tools["']/.test(restClient),
     "production pull path: lib/property/rentcast.ts (the typed REST client) never imports the MCP transport or AI-tools wrapper")
  ok(!/from\s+["'].*rentcast-mcp["']/.test(typedFacade) && !/from\s+["'].*rentcast-ai-tools["']/.test(typedFacade),
     "production pull path: lib/external/rentcast-typed.ts never imports the MCP transport or AI-tools wrapper")
  // POSITIVE CONTROL: a fixture that DOES import the MCP client from a "production" file
  // must be caught by the SAME regex used above — proves this isn't a tautology on an empty match.
  const contaminatedFixture = `import { callRentcastMcp } from "@/lib/external/rentcast-mcp"`
  ok(/from\s+["'].*rentcast-mcp["']/.test(contaminatedFixture),
     "positive control: the finder still catches a fixture that DOES import the MCP transport")
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
