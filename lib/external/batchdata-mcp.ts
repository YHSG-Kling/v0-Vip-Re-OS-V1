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
