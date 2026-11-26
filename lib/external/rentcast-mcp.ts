/**
 * lib/external/rentcast-mcp.ts
 *
 * Transport for RentCast's public Model Context Protocol (MCP) server —
 * https://developers.rentcast.io/mcp (developers.rentcast.io, fetched 2026-09-17), Streamable
 * HTTP transport, `X-Api-Key: <RENTCAST_API_KEY>` header enables live requests (the SAME
 * platform-gated key lib/property/rentcast.ts's REST client reads — RentCast is platform-owned,
 * there is no tenant RentCast credential; see that file's header).
 *
 * WHY THIS IS NEVER A PRODUCTION PULL PATH. RentCast's own docs state plainly: "All successful
 * API requests made using your API key, including through the MCP server, will be counted for
 * billing purposes" — an MCP call bills at the SAME per-request price as REST
 * (RENTCAST_USD_PER_REQUEST, lib/property/rentcast.ts) PLUS whatever LLM tokens the agent turn
 * spends reasoning about the tool call and its result. So MCP is strictly more expensive than
 * REST for identical data, and this transport is reached ONLY from the agent-copilot tool
 * surface (lib/external/rentcast-ai-tools.ts). Every scheduled/bulk RentCast pull (buyer search,
 * CMA comps, AVM, market stats) stays on the typed REST client (lib/property/rentcast.ts +
 * lib/external/rentcast-typed.ts) — proved by scripts/rentcast-copilot-tools-simulator.ts.
 *
 * Mirrors lib/external/batchdata-mcp.ts's transport shape (official @modelcontextprotocol/sdk
 * `Client` + `StreamableHTTPClientTransport`, one lazily-connected module-level client, never
 * throws into a caller) — the header name is the one real difference (RentCast: `X-Api-Key`;
 * BatchData: `Authorization: Bearer`).
 */
import type { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js"

export interface RentcastMcpResult<T = unknown> {
  ok: boolean
  data: T | null
  error: string | null
  /** True when RENTCAST_API_KEY is unset — the caller's cue this tool surface is dark. */
  unconfigured?: boolean
}

const MCP_URL_ENV = "RENTCAST_MCP_URL"
const DEFAULT_MCP_URL = "https://developers.rentcast.io/mcp"

// ─── Lazily-connected singleton client ─────────────────────────────────────────────
// Module-level so every call in this process reuses ONE MCP session rather than re-handshaking
// per call. Keyed by the resolved (url, key) pair so a key rotation or URL override does not
// keep reusing a stale connection under a new configuration.
let cachedClient: McpClient | null = null
let cachedKey: string | null = null
let connecting: Promise<McpClient | null> | null = null

function apiKey(): string | null {
  return process.env.RENTCAST_API_KEY || null
}

async function getClient(): Promise<McpClient | null> {
  const key = apiKey()
  if (!key) return null // unconfigured — never a fabricated connection
  const url = process.env[MCP_URL_ENV] || DEFAULT_MCP_URL
  const cacheKey = `${url}::${key}`

  if (cachedClient && cachedKey === cacheKey) return cachedClient
  if (connecting) return connecting

  connecting = (async () => {
    try {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js")
      const client = new Client({ name: "vip-re-os", version: "1.0.0" }, { capabilities: {} })
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { "X-Api-Key": key } },
      })
      await client.connect(transport)
      cachedClient = client
      cachedKey = cacheKey
      return client
    } catch {
      // Connection failed — never cache a broken client, never throw into the caller.
      cachedClient = null
      cachedKey = null
      return null
    } finally {
      connecting = null
    }
  })()
  return connecting
}

/**
 * Call a single RentCast MCP tool. NEVER throws (gateway contract) — a connect/call failure
 * resolves `{ ok: false, ... }` so the copilot tool surface can report a clean refusal.
 */
export async function callRentcastMcp<T = unknown>(
  tool: string,
  args: Record<string, unknown> = {},
): Promise<RentcastMcpResult<T>> {
  const client = await getClient()
  if (!client) {
    return { ok: false, data: null, error: "RentCast MCP not configured (RENTCAST_API_KEY unset)", unconfigured: true }
  }

  try {
    const result = await client.callTool({ name: tool, arguments: args }) as {
      content?: Array<{ type: string; text?: string; json?: T }>
      isError?: boolean
    }
    if (result?.isError) {
      const text = result.content?.find((p) => p?.type === "text")?.text
      return { ok: false, data: null, error: text ?? `RentCast MCP tool "${tool}" returned an error` }
    }

    // MCP tool responses ship either inline `json` or a stringified `text` part — read
    // defensively across both shapes, same posture as lib/external/batchdata-mcp.ts.
    const parts = result?.content ?? []
    for (const part of parts) {
      if (part?.type === "json" && part.json !== undefined) {
        return { ok: true, data: part.json as T, error: null }
      }
      if (part?.type === "text" && typeof part.text === "string") {
        try { return { ok: true, data: JSON.parse(part.text) as T, error: null } }
        catch { /* fall through — not JSON, try the next part or fall out to "no usable content" */ }
      }
    }
    return { ok: false, data: null, error: "RentCast MCP returned no usable content" }
  } catch (e) {
    // A thrown transport/session error invalidates the cached client so the NEXT call
    // reconnects instead of retrying a dead session forever.
    cachedClient = null
    cachedKey = null
    return { ok: false, data: null, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * List every tool this account's MCP server currently exposes — the discovery half
 * lib/external/rentcast-ai-tools.ts uses to build the AI-SDK tool surface dynamically rather
 * than hard-coding RentCast's tool catalogue (which is RentCast's to define/change). NEVER
 * throws.
 */
export async function listRentcastMcpTools(): Promise<{
  ok: boolean
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>
  unconfigured: boolean
  error: string | null
}> {
  const client = await getClient()
  if (!client) return { ok: false, tools: [], unconfigured: true, error: "RentCast MCP not configured (RENTCAST_API_KEY unset)" }
  try {
    const result = await client.listTools()
    const tools = (result?.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    }))
    return { ok: true, tools, unconfigured: false, error: null }
  } catch (e) {
    cachedClient = null
    cachedKey = null
    return { ok: false, tools: [], unconfigured: false, error: e instanceof Error ? e.message : String(e) }
  }
}
