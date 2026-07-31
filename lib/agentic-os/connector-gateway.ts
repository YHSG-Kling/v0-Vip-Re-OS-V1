// lib/agentic-os/connector-gateway.ts
// THE SINGLE EGRESS PATH. Per the architecture rule, every outbound api / oauth / mcp call
// leaves the app through this one function, and every response comes back IN through
// connector-shape.adaptResponse (so a vendor field rename self-heals + is reported as drift).
// New connectors are a SPEC over this gateway (a base URL, an auth style, a response shape) —
// never a bespoke fetch scattered across feature code (the /ecc:api-connector-builder rule).
//
// The auth-header builder is pure + exported so it is unit-tested without a network.

import { adaptResponse, type ConnectorShapeSpec, type ShapeDrift } from "./connector-shape"

export type GatewayAuth =
  | { style: "bearer"; token: string }                       // Authorization: Bearer <token>
  | { style: "basic"; username: string; password: string }  // Authorization: Basic base64(u:p)
  | { style: "header"; name: string; value: string }         // custom header (e.g. accesskey)
  | { style: "query"; name: string; value: string }          // ?<name>=<value>
  | { style: "none" }

export interface GatewayRequest {
  /** Connector id, for logging/drift attribution. */
  connector: string
  /** Base URL — required UNLESS `url` is set (the override). */
  baseUrl?: string
  /** Path — required UNLESS `url` is set. */
  path?: string
  /** Absolute URL override. When set, baseUrl/path are ignored and this exact URL is used —
   *  for dynamic targets a connector spec can't express: signed asset-download URLs and the
   *  resumable-upload URLs vendors hand back in a response header. Query/auth/headers still apply. */
  url?: string
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  query?: Record<string, string>
  body?: unknown
  /** Extra vendor-required headers (e.g. an API version header). Merged after auth. */
  headers?: Record<string, string>
  /** Optional — defaults to `{style:"none"}` when omitted, so public probes / health checks
   *  don't need to spell out anonymous auth. */
  auth?: GatewayAuth
  /** Optional response shape — when present, the response is adapted + drift is reported. */
  shape?: ConnectorShapeSpec
  /** "json" (default) parses the body as JSON; "text" returns the raw string (HTML scrapers);
   *  "arraybuffer" returns the raw bytes as a Buffer (binary responses, e.g. TTS audio). */
  responseType?: "json" | "text" | "arraybuffer"
  /** How the request body is encoded. "json" (default) → JSON.stringify; "form" →
   *  application/x-www-form-urlencoded (Stripe, Intuit-style APIs); "binary" → the body is sent
   *  as-is (Buffer/Uint8Array) and Content-Type is taken from `headers` (resumable byte uploads).
   *  Body must be a flat string/number map when "form" (nested keys pre-flattened, e.g. "metadata[id]"). */
  /** "multipart" → the body is a FormData and is passed through untouched, with
   *  NO Content-Type set so fetch supplies the multipart boundary itself (a
   *  hand-set multipart Content-Type without the generated boundary is rejected
   *  by every vendor). Declared explicitly rather than smuggled through
   *  "binary": that mode documents Buffer/Uint8Array, and FormData only worked
   *  there because BodyInit happens to accept it. */
  bodyType?: "json" | "form" | "binary" | "multipart"
  timeoutMs?: number
}

export interface GatewayResponse<T = any> {
  ok: boolean
  status: number | null
  data: T | null
  /** Lowercased response headers — some vendors return the result identifier (SendGrid
   *  x-message-id) or the next-step URL (resumable-upload Location) only in a header. */
  headers: Record<string, string>
  /** Shape drift detected on the response (vendor renamed/dropped fields), when a shape was given. */
  drift: ShapeDrift | null
  error: string | null
}

/** Pure: build the request URL + headers for an auth style. Exported for tests. */
export function buildAuthedRequest(req: GatewayRequest): { url: string; headers: Record<string, string> } {
  if (!req.url && (!req.baseUrl || req.path === undefined)) {
    throw new Error("GatewayRequest requires either `url` OR both `baseUrl` and `path`")
  }
  const url = req.url
    ? new URL(req.url)
    : new URL((req.path as string).replace(/^\//, ""), (req.baseUrl as string).endsWith("/") ? req.baseUrl as string : `${req.baseUrl}/`)
  for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v)

  const headers: Record<string, string> = { Accept: "application/json", ...(req.headers ?? {}) }
  if (req.body !== undefined && req.bodyType !== "binary" && req.bodyType !== "multipart") {
    headers["Content-Type"] = req.bodyType === "form" ? "application/x-www-form-urlencoded" : "application/json"
  }
  // binary: Content-Type is whatever the caller put in `headers` (e.g. video/*); never overridden.
  // multipart: NO Content-Type at all — fetch generates it with the boundary.

  // auth is optional — when omitted, no auth header is added (callers like public probes /
  // self-healer pings don't need auth). Without this guard the `.style` access throws and the
  // "never throws" contract in callConnector is violated.
  const auth = req.auth ?? { style: "none" as const }
  switch (auth.style) {
    case "bearer":
      headers.Authorization = `Bearer ${auth.token}`
      break
    case "basic":
      headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`
      break
    case "header":
      headers[auth.name] = auth.value
      break
    case "query":
      url.searchParams.set(auth.name, auth.value)
      break
    case "none":
      break
  }
  return { url: url.toString(), headers }
}

/**
 * The one outbound call. Real fetch → adapt the response shape → structured result. Never
 * throws: a thrown fetch / timeout returns ok:false with status null. This is the only place
 * feature code should reach an external HTTP vendor.
 *
 * TELEMETRY (burn-down round 6): because this IS the single egress choke, it is
 * also the one honest source of per-call latency/status — every call lands a
 * best-effort api_response_logs row (the System Health SLA panel read that
 * table for months with no writer). Fire-and-forget; telemetry never delays or
 * fails a vendor call.
 */
export async function callConnector<T = any>(req: GatewayRequest): Promise<GatewayResponse<T>> {
  const startedAt = Date.now()
  const result = await executeConnector<T>(req)
  void logApiResponse(req, result, Date.now() - startedAt)
  return result
}

async function logApiResponse(req: GatewayRequest, result: GatewayResponse<any>, elapsedMs: number): Promise<void> {
  try {
    const { createServiceClient } = await import("@/lib/supabase/service")
    const svc = createServiceClient()
    const endpoint = (req.path ?? "").split("?")[0].slice(0, 300) // never log query strings (keys/PII)
    await svc.from("api_response_logs").insert({
      brokerage_id: null, // gateway calls are provider-scoped; tenant attribution lives in vendor_usage metering
      service_key: req.connector,
      endpoint,
      method: req.method ?? (req.body !== undefined ? "POST" : "GET"),
      response_time_ms: elapsedMs,
      status_code: result.status,
      is_error: !result.ok,
      error_type: result.ok ? null : (result.status == null ? "network_or_timeout" : result.status === 429 ? "rate_limited" : result.status >= 500 ? "provider_error" : "request_rejected"),
      recorded_at: new Date().toISOString(),
    })
  } catch { /* telemetry is best-effort by contract */ }
}

async function executeConnector<T = any>(req: GatewayRequest): Promise<GatewayResponse<T>> {
  // buildAuthedRequest can throw on malformed baseUrl/path (new URL) — honor the "never throws"
  // contract by surfacing the failure as a structured ok:false instead.
  let url: string, headers: Record<string, string>
  try {
    ({ url, headers } = buildAuthedRequest(req))
  } catch (err) {
    return {
      ok: false, status: null, data: null, headers: {}, drift: null,
      error: `Request build failed: ${err instanceof Error ? err.message : String(err)}`,
    } as GatewayResponse<T>
  }
  const serializedBody = req.body === undefined
    ? undefined
    : req.bodyType === "form"
      ? (() => {
          // Array values become REPEATED keys (Twilio's array params, e.g.
          // MessageSamples, require MessageSamples=a&MessageSamples=b — the
          // plain URLSearchParams(record) constructor comma-joins them, which
          // vendors reject). Scalars keep the original behavior; null/undefined
          // entries are skipped instead of serializing as "undefined".
          const p = new URLSearchParams()
          for (const [k, v] of Object.entries(req.body as Record<string, unknown>)) {
            if (v === undefined || v === null) continue
            if (Array.isArray(v)) for (const item of v) p.append(k, String(item))
            else p.append(k, String(v))
          }
          return p.toString()
        })()
      : req.bodyType === "binary" || req.bodyType === "multipart"
        ? (req.body as BodyInit)
        : JSON.stringify(req.body)
  try {
    const res = await fetch(url, {
      method: req.method ?? (req.body !== undefined ? "POST" : "GET"),
      headers,
      ...(serializedBody !== undefined ? { body: serializedBody } : {}),
      signal: AbortSignal.timeout(req.timeoutMs ?? 15_000),
    })
    const respHeaders: Record<string, string> = {}
    if (res.headers && typeof res.headers.forEach === "function") {
      res.headers.forEach((v, k) => { respHeaders[k.toLowerCase()] = v })
    }
    // Text responses (HTML scrapers) bypass JSON parsing + shape adaptation.
    if (req.responseType === "text") {
      const text = await res.text().catch(() => "")
      if (!res.ok) return { ok: false, status: res.status, data: null, headers: respHeaders, drift: null, error: `HTTP ${res.status}` }
      return { ok: true, status: res.status, data: text as unknown as T, headers: respHeaders, drift: null, error: null }
    }
    // Binary responses (e.g. TTS audio, asset downloads) → raw bytes as a Buffer. On failure the
    // (text) error body is surfaced so callers can map provider error codes.
    if (req.responseType === "arraybuffer") {
      if (!res.ok) {
        const errText = await res.text().catch(() => "")
        return { ok: false, status: res.status, data: null, headers: respHeaders, drift: null, error: errText || `HTTP ${res.status}` }
      }
      const ab = await res.arrayBuffer().catch(() => null)
      return { ok: true, status: res.status, data: (ab ? Buffer.from(ab) : null) as unknown as T, headers: respHeaders, drift: null, error: null }
    }
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      // Prefer a structured message; otherwise surface the raw error body (a JSON snippet) so
      // providers with non-standard error envelopes (e.g. QuickBooks `{Fault:{Error:[…]}}`) keep
      // their diagnostic detail instead of collapsing to a bare "HTTP <status>".
      const structured = (raw?.error as any)?.message || (raw?.message as string)
      const snippet = structured || (raw && Object.keys(raw).length ? JSON.stringify(raw) : "")
      const msg = snippet ? `${snippet}` : `HTTP ${res.status}`
      return { ok: false, status: res.status, data: null, headers: respHeaders, drift: null, error: String(msg).slice(0, 300) }
    }
    let data: any = raw
    let drift: ShapeDrift | null = null
    if (req.shape) {
      const adapted = adaptResponse(raw, req.shape)
      data = adapted.value
      drift = adapted.drift
    }
    return { ok: true, status: res.status, data: data as T, headers: respHeaders, drift, error: null }
  } catch (err) {
    return { ok: false, status: null, data: null, headers: {}, drift: null, error: err instanceof Error ? err.message : String(err) }
  }
}
