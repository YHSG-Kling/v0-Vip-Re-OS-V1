/**
 * lib/external/batchdata-mcp.ts
 *
 * Adapter for BatchData's Model Context Protocol (MCP) server
 * (github.com/batchdataco/batchdata-mcp-server). MCP exposes richer / cheaper data than the REST
 * API in some agentic contexts — agentic callers can route property / owner / motivation queries
 * through MCP when configured, with automatic fallback to the existing REST `batchdata-client`
 * path when the MCP is unavailable or returns no data.
 *
 * Configuration: set `BATCHDATA_MCP_URL` to the MCP server's JSON-RPC endpoint. When unset,
 * `callBatchDataMcp` returns `{ok:false, error:"BatchData MCP not configured"}` and the caller
 * should fall back to the REST adapter.
 *
 * Routing: every call still flows through the canonical `connector-gateway` so the never-throws
 * + healer-observability + single-egress guarantees hold. Failures surface to the connector-health
 * cron / healer just like any other vendor call.
 */

/** Standard MCP tool-call response envelope (JSON-RPC 2.0 with the MCP tools/call schema). */
export interface BatchDataMcpResult<T = unknown> {
  ok:      boolean
  status:  number | null
  data:    T | null
  error:   string | null
  /** True when BATCHDATA_MCP_URL was unset and the caller should fall back to REST. */
  unconfigured?: boolean
}

const MCP_URL_ENV = "BATCHDATA_MCP_URL"
const MCP_AUTH_ENV = "BATCHDATA_MCP_AUTH"   // optional bearer token for the MCP endpoint
const TIMEOUT_MS = 20_000

/**
 * Call a single BatchData MCP tool. The tool name + args are passed straight through the MCP
 * `tools/call` method per the JSON-RPC 2.0 + MCP tool schema. Result shape is whatever the tool
 * returns — caller supplies the type parameter. NEVER throws (gateway contract).
 *
 *   const r = await callBatchDataMcp<PropertyRecord>("property.search", { state: "TX", city: "Austin" })
 *   if (r.unconfigured) {  // MCP not enabled — caller falls back to REST
 *     return await fetchMotivatedSellers(...)
 *   }
 *   if (!r.ok) {  // real failure — healer will eventually notice via the gateway
 *     return await fetchMotivatedSellers(...)  // best-effort fallback
 *   }
 *   return r.data
 */
export async function callBatchDataMcp<T = unknown>(
  tool: string,
  args: Record<string, unknown> = {},
): Promise<BatchDataMcpResult<T>> {
  const mcpUrl = process.env[MCP_URL_ENV]
  if (!mcpUrl) {
    return { ok: false, status: null, data: null, error: "BatchData MCP not configured", unconfigured: true }
  }
  const token = process.env[MCP_AUTH_ENV]

  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const res = await callConnector<{ result?: { content?: Array<{ type: string; text?: string; json?: T }> }; error?: { message: string } }>({
    connector: "batchdata_mcp",
    url:       mcpUrl,
    method:    "POST",
    auth:      token ? { style: "bearer", token } : { style: "none" },
    body: {
      jsonrpc: "2.0",
      id:      `bd-${Date.now()}`,
      method:  "tools/call",
      params:  { name: tool, arguments: args },
    },
    timeoutMs: TIMEOUT_MS,
  })

  if (!res.ok || !res.data) {
    return { ok: false, status: res.status, data: null, error: res.error ?? "BatchData MCP unreachable" }
  }
  if (res.data.error) {
    return { ok: false, status: res.status, data: null, error: res.data.error.message }
  }

  // MCP tool responses ship either inline `json` (preferred when servers honor the typed-result
  // schema) or a stringified `text` part the agent is expected to parse.
  const parts = res.data.result?.content ?? []
  for (const part of parts) {
    if (part?.type === "json"  && part.json !== undefined) {
      return { ok: true, status: res.status, data: part.json as T, error: null }
    }
    if (part?.type === "text"  && typeof part.text === "string") {
      try { return { ok: true, status: res.status, data: JSON.parse(part.text) as T, error: null } }
      catch { /* fall through to next part */ }
    }
  }
  return { ok: false, status: res.status, data: null, error: "BatchData MCP returned no usable content" }
}

/**
 * Convenience helper: prefer MCP, fall back to REST. The `rest` argument is a thunk producing the
 * REST-shaped result so we don't pay the REST cost when MCP succeeds. Both paths feed the same
 * upstream consumer.
 */
// ─── BUY BOX + COMPS — typed wrappers over the batchdata-mcp-server's own tools ───────
// Tool names match github.com/batchdataco/batchdata-mcp-server's published tool set
// (the same names this environment's own `mcp__batchdata__*` tools carry, minus that
// prefix — this environment's prefix is a LOCAL naming convention for the tool-search
// registry, not part of the wire protocol `tools/call` sends). No independently
// confirmed REST equivalent exists for Buy Box (batchdata.io/buy-box-api is marketing
// copy, not an API reference), so investor-match discovery is MCP-ONLY: when
// BATCHDATA_MCP_URL is unset, callers get `{unconfigured:true}` and there is no REST
// fallback to try, unlike every other function in this module pair.

/** One investor's buy-box match against a subject property — read defensively across
 *  the tool's plausible response shapes (an array under `matches`/`results`/`investors`,
 *  or a bare array). */
export interface BuyBoxMatchRow {
  [key: string]: unknown
}

function extractRows(data: unknown): BuyBoxMatchRow[] {
  if (Array.isArray(data)) return data as BuyBoxMatchRow[]
  const d = data as Record<string, any> | null
  const candidate = d?.matches ?? d?.results ?? d?.investors ?? d?.properties ?? d?.comps
  return Array.isArray(candidate) ? candidate : []
}

/** Preview (cheap/no-charge sample) of investor buy-box matches for a subject property. */
export async function investorBuyboxPreview(args: { address: string; city?: string; state?: string; zip?: string }): Promise<{ ok: boolean; rows: BuyBoxMatchRow[]; unconfigured: boolean; error: string | null }> {
  const r = await callBatchDataMcp("investor_buybox_preview", args)
  return { ok: r.ok, rows: r.ok ? extractRows(r.data) : [], unconfigured: !!r.unconfigured, error: r.error }
}

/** Billed count of matches (no rows) — used to size a buy-box pull before paying for it. */
export async function investorBuyboxCount(args: { address: string; city?: string; state?: string; zip?: string }): Promise<{ ok: boolean; count: number | null; unconfigured: boolean; error: string | null }> {
  const r = await callBatchDataMcp<Record<string, any>>("investor_buybox_count", args)
  const count = r.ok ? (typeof r.data?.count === "number" ? r.data.count : (typeof r.data === "number" ? r.data : null)) : null
  return { ok: r.ok, count, unconfigured: !!r.unconfigured, error: r.error }
}

/** Full (billed) page of investor buy-box matches. */
export async function investorBuyboxPage(args: { address: string; city?: string; state?: string; zip?: string; take?: number; skip?: number }): Promise<{ ok: boolean; rows: BuyBoxMatchRow[]; unconfigured: boolean; error: string | null }> {
  const r = await callBatchDataMcp("investor_buybox_page", args)
  return { ok: r.ok, rows: r.ok ? extractRows(r.data) : [], unconfigured: !!r.unconfigured, error: r.error }
}

/** Preview of the comps dataset for an address — the MCP-side mirror of
 *  lib/external/batchdata-client.ts::fetchBatchDataComps's REST call, used when a
 *  caller already routes other property reads through MCP and wants ONE egress path
 *  rather than mixing REST and MCP for the same CMA. */
export async function comparablePropertyPreview(args: { address: string; city?: string; state?: string; zip?: string }): Promise<{ ok: boolean; rows: BuyBoxMatchRow[]; unconfigured: boolean; error: string | null }> {
  const r = await callBatchDataMcp("comparable_property_preview", args)
  return { ok: r.ok, rows: r.ok ? extractRows(r.data) : [], unconfigured: !!r.unconfigured, error: r.error }
}

export async function comparablePropertyCount(args: { address: string; city?: string; state?: string; zip?: string }): Promise<{ ok: boolean; count: number | null; unconfigured: boolean; error: string | null }> {
  const r = await callBatchDataMcp<Record<string, any>>("comparable_property_count", args)
  const count = r.ok ? (typeof r.data?.count === "number" ? r.data.count : (typeof r.data === "number" ? r.data : null)) : null
  return { ok: r.ok, count, unconfigured: !!r.unconfigured, error: r.error }
}

export async function comparablePropertyPage(args: { address: string; city?: string; state?: string; zip?: string; take?: number; skip?: number }): Promise<{ ok: boolean; rows: BuyBoxMatchRow[]; unconfigured: boolean; error: string | null }> {
  const r = await callBatchDataMcp("comparable_property_page", args)
  return { ok: r.ok, rows: r.ok ? extractRows(r.data) : [], unconfigured: !!r.unconfigured, error: r.error }
}

export async function batchDataPreferMcp<T>(
  mcpTool: string,
  mcpArgs: Record<string, unknown>,
  rest:    () => Promise<T>,
): Promise<{ via: "mcp" | "rest"; data: T | null; error: string | null }> {
  const mcp = await callBatchDataMcp<T>(mcpTool, mcpArgs)
  if (mcp.ok && mcp.data !== null) return { via: "mcp",  data: mcp.data, error: null }
  if (mcp.unconfigured) {
    try { return { via: "rest", data: await rest(), error: null } }
    catch (e: any) { return { via: "rest", data: null, error: e?.message ?? "REST fallback failed" } }
  }
  // MCP failed for a non-config reason — still try REST.
  try { return { via: "rest", data: await rest(), error: null } }
  catch (e: any) { return { via: "rest", data: null, error: `mcp: ${mcp.error}; rest: ${e?.message}` } }
}
