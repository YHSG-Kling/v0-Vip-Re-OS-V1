/**
 * lib/external/batchdata-mcp.ts
 *
 * Adapter for BatchData's Model Context Protocol (MCP) server — the OFFICIAL server
 * at `https://mcp.batchdata.com` (help.batchdata.io article 12860581, fetched
 * 2026-09-16), Streamable HTTP transport, `Authorization: Bearer <server-side token>`.
 * MCP exposes richer / cheaper data than the REST API in some agentic contexts —
 * agentic callers (this file's typed wrappers below, and the AI-SDK tool surface in
 * lib/external/batchdata-ai-tools.ts) route property / owner / motivation queries
 * through MCP when configured, with automatic fallback to the existing REST
 * `batchdata-client` path when the MCP is unavailable or returns no data.
 *
 * TRANSPORT (wave 67 rebuild of the wave-6x hand-rolled JSON-RPC POST): the OFFICIAL
 * client — `@modelcontextprotocol/sdk`'s `Client` + `StreamableHTTPClientTransport` —
 * replaces the hand-rolled `fetch`-via-connector-gateway JSON-RPC body this file used
 * to build itself. The SDK owns the wire protocol (session id, SSE upgrade, retry/
 * reconnection); this file owns configuration, auth, and the typed convenience
 * wrappers every caller already depends on.
 *
 * Configuration: `BATCHDATA_MCP_URL` (default `https://mcp.batchdata.com` when unset
 * — the official server is a real default, not merely a fallback guess) +
 * `BATCHDATA_MCP_AUTH` (falls back to `BATCHDATA_API_KEY` via
 * lib/external/batchdata-tokens.ts's "mcp" purpose — a server-side token can be
 * provisioned narrower than the search-lane key, see that module's own doc comment).
 * No token resolvable for the "mcp" purpose → every call returns
 * `{ok:false, unconfigured:true}` and the caller should fall back to REST. FAIL
 * CLOSED, NEVER THROWS INTO A CALLER — every exported function here catches its own
 * connect/call errors.
 *
 * One module-level lazily-connected client, reused across calls (connecting an MCP
 * session per call would pay the handshake cost every time); closing it on process
 * exit is not required (serverless / edge runtimes recycle the process anyway).
 */

import type { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js"
import { resolveBatchDataToken } from "@/lib/external/batchdata-tokens"

/** Standard MCP tool-call response envelope. */
export interface BatchDataMcpResult<T = unknown> {
  ok:      boolean
  status:  number | null
  data:    T | null
  error:   string | null
  /** True when no "mcp" purpose token was resolvable and the caller should fall back to REST. */
  unconfigured?: boolean
}

const MCP_URL_ENV = "BATCHDATA_MCP_URL"
const DEFAULT_MCP_URL = "https://mcp.batchdata.com"

// ─── Lazily-connected singleton client ─────────────────────────────────────────────
// Module-level so every call in this process reuses ONE MCP session rather than
// re-handshaking per call. Keyed by the resolved (url, token) pair so a token/URL
// change (e.g. between test runs, or a redeploy with a rotated key) does not keep
// reusing a stale connection under a new configuration.
let cachedClient: McpClient | null = null
let cachedKey: string | null = null
let connecting: Promise<McpClient | null> | null = null

async function getClient(): Promise<McpClient | null> {
  const token = resolveBatchDataToken("mcp")
  if (!token) return null // unconfigured — caller falls back to REST, never a fabricated connection
  const url = process.env[MCP_URL_ENV] || DEFAULT_MCP_URL
  const key = `${url}::${token}`

  if (cachedClient && cachedKey === key) return cachedClient
  if (connecting) return connecting

  connecting = (async () => {
    try {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js")
      const client = new Client({ name: "vip-re-os", version: "1.0.0" }, { capabilities: {} })
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      })
      await client.connect(transport)
      cachedClient = client
      cachedKey = key
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
 * Call a single BatchData MCP tool. The tool name + args are passed straight through
 * the MCP `tools/call` method via the official client. Result shape is whatever the
 * tool returns — caller supplies the type parameter. NEVER throws (gateway contract).
 *
 *   const r = await callBatchDataMcp<PropertyRecord>("lookup_property", { address: "..." })
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
  const client = await getClient()
  if (!client) {
    return { ok: false, status: null, data: null, error: "BatchData MCP not configured", unconfigured: true }
  }

  try {
    const result = await client.callTool({ name: tool, arguments: args }) as {
      content?: Array<{ type: string; text?: string; json?: T }>
      isError?: boolean
    }
    if (result?.isError) {
      const text = result.content?.find((p) => p?.type === "text")?.text
      return { ok: false, status: null, data: null, error: text ?? `BatchData MCP tool "${tool}" returned an error` }
    }

    // MCP tool responses ship either inline `json` (preferred when the server honors
    // the typed-result schema) or a stringified `text` part the agent is expected to
    // parse. Read defensively across both shapes, same posture as every other
    // provider-response reader in this repo.
    const parts = result?.content ?? []
    for (const part of parts) {
      if (part?.type === "json" && part.json !== undefined) {
        return { ok: true, status: 200, data: part.json as T, error: null }
      }
      if (part?.type === "text" && typeof part.text === "string") {
        try { return { ok: true, status: 200, data: JSON.parse(part.text) as T, error: null } }
        catch { /* fall through — not JSON, try the next part or fall out to "no usable content" */ }
      }
    }
    return { ok: false, status: 200, data: null, error: "BatchData MCP returned no usable content" }
  } catch (e) {
    // A thrown transport/session error invalidates the cached client so the NEXT
    // call reconnects instead of retrying a dead session forever.
    cachedClient = null
    cachedKey = null
    return { ok: false, status: null, data: null, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * List every tool this account's MCP server currently exposes — the discovery half
 * batchdata-ai-tools.ts uses to build the AI-SDK tool surface dynamically rather than
 * hard-coding the tool catalogue (which OAuth account-level dataset config can widen
 * or narrow — app.batchdata.com/api-tokens/mcp-oauth-config). NEVER throws.
 */
export async function listBatchDataMcpTools(): Promise<{
  ok: boolean
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>
  unconfigured: boolean
  error: string | null
}> {
  const client = await getClient()
  if (!client) return { ok: false, tools: [], unconfigured: true, error: "BatchData MCP not configured" }
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

/**
 * Convenience helper: prefer MCP, fall back to REST. The `rest` argument is a thunk
 * producing the REST-shaped result so we don't pay the REST cost when MCP succeeds.
 * Both paths feed the same upstream consumer.
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

// ─── BUY BOX + COMPS — typed wrappers over the batchdata-mcp-server's own tools ───────
// Tool names match the official BatchData MCP server's published tool set (the same
// names this environment's own `mcp__batchdata__*` tools carry, minus that prefix —
// this environment's prefix is a LOCAL naming convention for the tool-search
// registry, not part of the wire protocol `tools/call` sends). No independently
// confirmed REST equivalent exists for Buy Box (batchdata.io/buy-box-api is marketing
// copy, not an API reference), so investor-match discovery is MCP-ONLY: when no "mcp"
// purpose token is configured, callers get `{unconfigured:true}` and there is no REST
// fallback to try, unlike every other function in this module pair.

/** One investor's buy-box match against a subject property — read defensively across
 *  the tool's plausible response shapes (an array under `matches`/`results`/`investors`,
 *  or a bare array). */
export interface BuyBoxMatchRow {
  [key: string]: unknown
}

/** The ONE defensive multi-shape row reader ("an array under matches/results/… or a
 *  bare array") the four typed wrappers below share (CLAUDE.md §6).
 *  TOMBSTONE (lane 79B, CLAUDE.md §1.3): exported in wave 71 for lib/ai-isa/batchdata-
 *  isa-tools.ts's search_properties_* / lookup_property wrappers; those property tools
 *  are retired (BatchData is for acquisition / skip-trace / DNC only — survivor
 *  lib/ai-isa/property-lookup-rail.ts), so with no external importer left the reader
 *  is module-private again. Behavior unchanged; only the export keyword moved back. */
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

// ─── SCRUB-BEFORE-USE — thin typed mirrors over the wave-67 MCP tool set ──────────────
// (help.batchdata.io article 12860581: "check_dnc_status, check_tcpa_status, verify_phone").
// lib/compliance/phone-scrub-runner.ts called `callBatchDataMcp("check_dnc_status", …)` and
// `callBatchDataMcp("check_tcpa_status", …)` directly (the INTAKE-time scrub, wave 6x); these
// are the SAME two tools plus verify_phone, given a typed home here so the SEND-TIME scrub
// (lib/communication/tcpa-gate.ts — wave 68, "we do want to make sure that the phone/scrub and
// email before using it") does not hand-roll a third copy of the tool-name string or the
// tolerant-flag reader. One vocabulary (§6): phone-scrub-runner.ts now calls these too.
//
// FAIL CLOSED, NEVER THROWS: `unconfigured:true` is the caller's cue to refuse rather than
// assume clean — CLAUDE.md §4 ("a gate that cannot run must refuse, not pass").

/** Tolerant boolean read across the field-name variants BatchData's DNC/TCPA tools use. */
function readMcpFlag(data: unknown, keys: string[]): boolean | null {
  if (!data || typeof data !== "object") return null
  const obj = data as Record<string, unknown>
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === "boolean") return v
    if (typeof v === "string") {
      const s = v.trim().toLowerCase()
      if (["true", "yes", "listed", "dnc", "litigator"].includes(s)) return true
      if (["false", "no", "clean", "none", "not_listed"].includes(s)) return false
    }
  }
  return null
}

export interface DncStatusResult {
  ok: boolean
  /** null = tool ran but returned no parseable flag; unconfigured/failed → also null. */
  dnc: boolean | null
  unconfigured: boolean
  error: string | null
}

/** check_dnc_status — is this number on the national/state Do-Not-Call registry? */
export async function checkDncStatus(phoneTenDigits: string): Promise<DncStatusResult> {
  const r = await callBatchDataMcp<unknown>("check_dnc_status", { phone_number: phoneTenDigits })
  const dnc = r.ok ? readMcpFlag(r.data, ["dnc", "is_dnc", "isDnc", "dnc_status", "onDnc", "listed", "result"]) : null
  return { ok: r.ok, dnc, unconfigured: !!r.unconfigured, error: r.error }
}

export interface TcpaStatusResult {
  ok: boolean
  /** true = this number is associated with a known TCPA litigator. */
  tcpaLitigator: boolean | null
  unconfigured: boolean
  error: string | null
}

/** check_tcpa_status — is this number associated with a known TCPA litigator? */
export async function checkTcpaStatus(phoneTenDigits: string): Promise<TcpaStatusResult> {
  const r = await callBatchDataMcp<unknown>("check_tcpa_status", { phone_number: phoneTenDigits })
  const tcpaLitigator = r.ok
    ? readMcpFlag(r.data, ["tcpa", "litigator", "is_litigator", "isLitigator", "tcpaLitigator", "tcpa_litigator", "listed", "result"])
    : null
  return { ok: r.ok, tcpaLitigator, unconfigured: !!r.unconfigured, error: r.error }
}

export interface VerifyPhoneResult {
  ok: boolean
  reachable: boolean | null
  lineType: string | null
  unconfigured: boolean
  error: string | null
}

/** @proofSeam the 3rd wave-68 mirror; reachability is deliberately a SEPARATE verify
 *  pass (lib/compliance/phone-scrub.ts's own header) the fresh DNC/TCPA scrub did not
 *  need — kept ready for that pass, exercised by scripts/outbound-call-gates-simulator.ts. */
export async function verifyPhone(phoneTenDigits: string): Promise<VerifyPhoneResult> {
  const r = await callBatchDataMcp<Record<string, any>>("verify_phone", { phone_number: phoneTenDigits })
  const reachable = r.ok ? readMcpFlag(r.data, ["reachable", "is_valid", "isValid", "valid", "result"]) : null
  const lineType = r.ok && r.data && typeof r.data === "object" ? ((r.data as Record<string, any>).line_type ?? (r.data as Record<string, any>).lineType ?? null) : null
  return { ok: r.ok, reachable, lineType, unconfigured: !!r.unconfigured, error: r.error }
}
