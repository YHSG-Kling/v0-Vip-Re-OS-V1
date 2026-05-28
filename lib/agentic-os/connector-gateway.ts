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
  baseUrl: string
  path: string
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  query?: Record<string, string>
  body?: unknown
  /** Extra vendor-required headers (e.g. an API version header). Merged after auth. */
  headers?: Record<string, string>
  auth: GatewayAuth
  /** Optional response shape — when present, the response is adapted + drift is reported. */
  shape?: ConnectorShapeSpec
  /** "json" (default) parses the body as JSON; "text" returns the raw string (HTML scrapers). */
  responseType?: "json" | "text"
  timeoutMs?: number
}

export interface GatewayResponse<T = any> {
  ok: boolean
  status: number | null
  data: T | null
  /** Shape drift detected on the response (vendor renamed/dropped fields), when a shape was given. */
  drift: ShapeDrift | null
  error: string | null
}

/** Pure: build the request URL + headers for an auth style. Exported for tests. */
export function buildAuthedRequest(req: GatewayRequest): { url: string; headers: Record<string, string> } {
  const url = new URL(req.path.replace(/^\//, ""), req.baseUrl.endsWith("/") ? req.baseUrl : `${req.baseUrl}/`)
  for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v)

  const headers: Record<string, string> = { Accept: "application/json", ...(req.headers ?? {}) }
  if (req.body !== undefined) headers["Content-Type"] = "application/json"

  switch (req.auth.style) {
    case "bearer":
      headers.Authorization = `Bearer ${req.auth.token}`
      break
    case "basic":
      headers.Authorization = `Basic ${Buffer.from(`${req.auth.username}:${req.auth.password}`).toString("base64")}`
      break
    case "header":
      headers[req.auth.name] = req.auth.value
      break
    case "query":
      url.searchParams.set(req.auth.name, req.auth.value)
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
 */
export async function callConnector<T = any>(req: GatewayRequest): Promise<GatewayResponse<T>> {
  const { url, headers } = buildAuthedRequest(req)
  try {
    const res = await fetch(url, {
      method: req.method ?? (req.body !== undefined ? "POST" : "GET"),
      headers,
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      signal: AbortSignal.timeout(req.timeoutMs ?? 15_000),
    })
    // Text responses (HTML scrapers) bypass JSON parsing + shape adaptation.
    if (req.responseType === "text") {
      const text = await res.text().catch(() => "")
      if (!res.ok) return { ok: false, status: res.status, data: null, drift: null, error: `HTTP ${res.status}` }
      return { ok: true, status: res.status, data: text as unknown as T, drift: null, error: null }
    }
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const msg = (raw?.error as any)?.message || (raw?.message as string) || `HTTP ${res.status}`
      return { ok: false, status: res.status, data: null, drift: null, error: String(msg).slice(0, 300) }
    }
    let data: any = raw
    let drift: ShapeDrift | null = null
    if (req.shape) {
      const adapted = adaptResponse(raw, req.shape)
      data = adapted.value
      drift = adapted.drift
    }
    return { ok: true, status: res.status, data: data as T, drift, error: null }
  } catch (err) {
    return { ok: false, status: null, data: null, drift: null, error: err instanceof Error ? err.message : String(err) }
  }
}
