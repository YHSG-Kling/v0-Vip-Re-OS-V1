// lib/agentic-os/connector-gateway.ts
// THE SINGLE EGRESS PATH. Per the architecture rule, every outbound api / oauth / mcp call
// leaves the app through this one function, and every response comes back IN through
// connector-shape.adaptResponse (so a vendor field rename self-heals + is reported as drift).
// New connectors are a SPEC over this gateway (a base URL, an auth style, a response shape) —
// never a bespoke fetch scattered across feature code (the /ecc:api-connector-builder rule).
//
// The auth-header builder is pure + exported so it is unit-tested without a network.

import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { adaptResponse, type ConnectorShapeSpec, type ShapeDrift } from "./connector-shape"
import { retryAsync } from "@/lib/errors"
import { declaredConnectorAlternate, getConnectorSpec, type ConnectorAlternate } from "./connector-registry"

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
 *
 * TRANSIENT RETRY (orphan burn-down, lane O — retryAsync WIRED). This gateway
 * already CLASSIFIED a failure as rate_limited (429) / provider_error (5xx) /
 * network_or_timeout for the SLA panel, and then did nothing about any of them:
 * one blip on one vendor call failed the whole feature. `retryAsync`
 * (lib/errors) is the in-process backoff ladder that was written for exactly
 * this and had no caller.
 *
 * SCOPED TO GET, DELIBERATELY. Replaying a POST through this gateway is
 * replaying a Stripe charge, an SMS send, a CRM contact create or a social
 * publish — the gateway cannot know which of its connectors treat a repeated
 * POST as idempotent, and guessing wrong duplicates money or messages. GET is
 * idempotent by definition, so it is the only method retried here. Anything
 * else keeps today's exact behaviour: one attempt, structured result.
 *
 * A retried attempt is a REAL attempt and gets its own api_response_logs row,
 * so the SLA panel still sees the 429 that was recovered from rather than a
 * silently-healed gap.
 */

/** Carries a transient GatewayResponse out through retryAsync's throw protocol. */
class TransientGatewayFailure extends Error {
  constructor(public readonly result: GatewayResponse<any>) {
    super(result.error ?? "transient gateway failure")
    this.name = "TransientGatewayFailure"
  }
}

/** 429, any 5xx, or a null status (thrown fetch / AbortSignal timeout). */
function isTransient(result: GatewayResponse<any>): boolean {
  if (result.ok) return false
  return result.status === null || result.status === 429 || result.status >= 500
}

// ─── APPLIED DECLARED ALTERNATE (wave 137, lane 137C — provider self-healing) ─────────────────────
// When the healer applied a CONFIG-level alternate the connector DECLARES (CONNECTOR_REGISTRY[*].alternates
// — a newer API version query/header or a declared endpoint; the provider adapter declaration in
// lib/kernel/provider-adapters.ts reads the same list), every call to that connector carries it from
// then on. The config comes from the CODE declaration, never from the row. One bounded read per
// connector per minute; an unreadable answer is "none applied" — the request goes out as written.
// The registry is a leaf module: this edge adds nothing to any bundle that already reaches the gateway.

type AlternateReadClient = { from: (table: string) => any }
type AppliedAlternate = { alternate: ConnectorAlternate; currentBaseUrl: string }

/**
 * The alternate currently APPLIED for a connector (newest applied `declared_alternate` row in
 * connector_healing_proposals), resolved back through the registry declaration — an alternate the
 * declaration no longer lists is ignored. Read here at egress and by connector-healer.ts (already
 * applied → never re-applied). Never throws; an unreadable table is "none applied", logged (§3).
 */
export async function loadAppliedAlternate(connector: string, client?: AlternateReadClient): Promise<AppliedAlternate | null> {
  try {
    const svc = client ?? (await import("@/lib/supabase/service")).createServiceClient()
    const { data, error } = await svc.from("connector_healing_proposals")
      .select("proposal_payload, applied_at")
      .eq("connector", connector).eq("proposal_kind", "declared_alternate").eq("status", "applied")
      .order("applied_at", { ascending: false }).limit(1).maybeSingle()
    if (error) { console.error(`[connector-gateway] applied-alternate read refused for ${connector}: ${error.message}`); return null }
    const id = (data?.proposal_payload as { alternate_id?: string } | null)?.alternate_id
    if (!id) return null
    const declared = declaredConnectorAlternate(connector, id)
    return declared ? { alternate: declared.alternate, currentBaseUrl: declared.spec.baseUrl } : null
  } catch {
    return null
  }
}

/** PURE — a gateway request with an applied DECLARED alternate merged in: query + headers override,
 *  the base URL swaps only when the request targets the declared current endpoint.
 *  @proofSeam scripts/provider-adapter-guard.ts builds the egress URL through it; production reader:
 *  withAppliedAlternate below. */
export function applyAlternateToRequest(req: GatewayRequest, alt: ConnectorAlternate, currentBaseUrl: string): GatewayRequest {
  const next: GatewayRequest = { ...req }
  if (alt.query) next.query = { ...(req.query ?? {}), ...alt.query }
  if (alt.headers) next.headers = { ...(req.headers ?? {}), ...alt.headers }
  if (alt.baseUrl && req.baseUrl && currentBaseUrl && req.baseUrl.startsWith(currentBaseUrl)) next.baseUrl = alt.baseUrl + req.baseUrl.slice(currentBaseUrl.length)
  return next
}

const appliedAlternateCache = new Map<string, { value: AppliedAlternate | null; expiresAt: number }>()
async function withAppliedAlternate(req: GatewayRequest): Promise<GatewayRequest> {
  // Only a connector that DECLARES a config alternate can have one applied — no read for any other.
  if (!getConnectorSpec(req.connector)?.alternates?.some((a) => a.level === "config")) return req
  try {
    let hit = appliedAlternateCache.get(req.connector)
    if (!hit || hit.expiresAt <= Date.now()) {
      hit = { value: await loadAppliedAlternate(req.connector), expiresAt: Date.now() + 60_000 }
      appliedAlternateCache.set(req.connector, hit)
    }
    return hit.value ? applyAlternateToRequest(req, hit.value.alternate, hit.value.currentBaseUrl) : req
  } catch {
    return req
  }
}

export async function callConnector<T = any>(original: GatewayRequest): Promise<GatewayResponse<T>> {
  const req = await withAppliedAlternate(original)
  const attempt = async (): Promise<GatewayResponse<T>> => {
    const startedAt = Date.now()
    const result = await executeConnector<T>(req)
    void logApiResponse(req, result, Date.now() - startedAt)
    return result
  }

  const method = req.method ?? (req.body !== undefined ? "POST" : "GET")
  if (method !== "GET") return attempt()

  try {
    // maxRetries 2 = two attempts total, one 400ms retry. Bounded on purpose:
    // the per-attempt timeout defaults to 15s, and a serverless invocation that
    // spends a minute laddering a dead vendor is a worse failure than the one
    // it is trying to hide.
    return await retryAsync(async () => {
      const result = await attempt()
      if (isTransient(result)) throw new TransientGatewayFailure(result)
      return result
    }, { maxRetries: 2, delayMs: 400, backoff: true })
  } catch (err) {
    // Honor this function's "never throws" contract: hand back the LAST real
    // response rather than an invented one, so the caller still sees the
    // vendor's own status and message.
    if (err instanceof TransientGatewayFailure) return err.result as GatewayResponse<T>
    return {
      ok: false, status: null, data: null, headers: {}, drift: null,
      error: err instanceof Error ? err.message : String(err),
    } as GatewayResponse<T>
  }
}

async function logApiResponse(req: GatewayRequest, result: GatewayResponse<any>, elapsedMs: number): Promise<void> {
  try {
    const { createServiceClient } = await import("@/lib/supabase/service")
    const svc = createServiceClient()
    const endpoint = (req.path ?? "").split("?")[0].slice(0, 300) // never log query strings (keys/PII)
    await sentinelWrite(svc, svc.from("api_response_logs").insert({
      brokerage_id: null, // gateway calls are provider-scoped; tenant attribution lives in vendor_usage metering
      service_key: req.connector,
      endpoint,
      method: req.method ?? (req.body !== undefined ? "POST" : "GET"),
      response_time_ms: elapsedMs,
      status_code: result.status,
      is_error: !result.ok,
      error_type: result.ok ? null : (result.status == null ? "network_or_timeout" : result.status === 429 ? "rate_limited" : result.status >= 500 ? "provider_error" : "request_rejected"),
      recorded_at: new Date().toISOString(),
    }), { table: "api_response_logs", flow: "api_response_logs_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })
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

// ─── PROVIDER HEALTH STATE (wave 98, lane 98C — owner blueprint "provider health / failover state") ──
// DERIVED, never stored: the state is a pure function of the outcomes this gateway already ledgers
// (api_response_logs, written by logApiResponse above — the ONE per-call record of every vendor
// answer). No new vendor call, no new table. Only PROVIDER faults count (network_or_timeout,
// provider_error, rate_limited); a request_rejected 4xx is the caller's request, not the provider's
// health, so it neither counts as a fault nor as a success that clears one.
//   healthy      — no provider fault in the window (or no traffic: no evidence either way, said so).
//   degraded     — some faults, under the failing streak.
//   rate_limited — the newest outcome is a 429 (under the failing streak).
//   failing      — ≥ failingStreak consecutive newest faults, the newest inside the cool-down →
//                  the capability router ROUTES AROUND it to the next provider for the cool-down.
//   fallback     — the streak still stands but the cool-down has elapsed with no newer call: the
//                  router stops skipping and lets the next real call probe the provider (half-open);
//                  a fresh fault puts it back in `failing` with a fresh cool-down.
//   recovered    — the newest call succeeded after a failing streak inside the window.
export type ProviderHealthState = "healthy" | "degraded" | "rate_limited" | "failing" | "fallback" | "recovered"

export const PROVIDER_HEALTH_POLICY = Object.freeze({
  windowMs: 30 * 60_000,
  failingStreak: 3,
  cooldownMs: 10 * 60_000,
  degradedFaultRate: 0.2,
  maxSamples: 50,
})

const PROVIDER_FAULT_TYPES: ReadonlySet<string> = new Set(["network_or_timeout", "provider_error", "rate_limited"])

export interface ProviderOutcome { at: string | Date; ok: boolean; errorType: string | null }

export interface ProviderHealth {
  state: ProviderHealthState
  /** true ONLY in `failing` — the router skips this provider until cooldownUntil. */
  routeAround: boolean
  reason: string
  calls: number
  faults: number
  streak: number
  cooldownUntil: string | null
}

/** PURE — the health state from recent outcomes (any order; sorted newest-first here). */
export function deriveProviderHealth(outcomes: readonly ProviderOutcome[], now: Date = new Date()): ProviderHealth {
  const P = PROVIDER_HEALTH_POLICY
  const t = (o: ProviderOutcome) => new Date(o.at).getTime()
  const isFault = (o: ProviderOutcome) => !o.ok && PROVIDER_FAULT_TYPES.has(o.errorType ?? "")
  // request_rejected (and any non-provider error) is neutral — dropped before the streak is read.
  const counted = outcomes
    .filter((o) => Number.isFinite(t(o)) && now.getTime() - t(o) <= P.windowMs && (o.ok || isFault(o)))
    .sort((a, b) => t(b) - t(a))
    .slice(0, P.maxSamples)
  const faults = counted.filter(isFault).length
  const base = { calls: counted.length, faults, cooldownUntil: null as string | null }
  if (counted.length === 0) {
    return { ...base, state: "healthy", routeAround: false, streak: 0, reason: `no provider outcome in the last ${P.windowMs / 60_000} min — no evidence either way` }
  }
  let streak = 0
  while (streak < counted.length && isFault(counted[streak])) streak++
  if (streak >= P.failingStreak) {
    const until = t(counted[0]) + P.cooldownMs
    if (now.getTime() < until) {
      return { ...base, state: "failing", routeAround: true, streak, cooldownUntil: new Date(until).toISOString(),
        reason: `${streak} consecutive provider faults (newest ${counted[0].errorType}) — routed around until ${new Date(until).toISOString()}` }
    }
    return { ...base, state: "fallback", routeAround: false, streak,
      reason: `${streak} consecutive faults but the ${P.cooldownMs / 60_000} min cool-down has elapsed — the next call probes the provider` }
  }
  if (streak === 0) {
    let run = 0
    for (const o of counted) {
      run = isFault(o) ? run + 1 : 0
      if (run >= P.failingStreak) return { ...base, state: "recovered", routeAround: false, streak, reason: "the newest call succeeded after a failing streak in the window" }
    }
  }
  if (streak > 0 && counted[0].errorType === "rate_limited") {
    return { ...base, state: "rate_limited", routeAround: false, streak, reason: `newest call was rate limited (429), ${streak} in a row` }
  }
  if (faults > 0 && (streak > 0 || faults / counted.length >= P.degradedFaultRate)) {
    return { ...base, state: "degraded", routeAround: false, streak, reason: `${faults}/${counted.length} provider faults in the window` }
  }
  return { ...base, state: "healthy", routeAround: false, streak, reason: `${counted.length} call(s), ${faults} fault(s) in the window` }
}

const providerHealthCache = new Map<string, { value: ProviderHealth; expiresAt: number }>()
const PROVIDER_HEALTH_TTL_MS = 30_000

/**
 * I/O — the health of one connector (api_response_logs.service_key) from its recent outcomes.
 * One bounded read, cached 30s in-process. An UNREADABLE ledger is read and logged (§3) and returns
 * `healthy` with that reason: routing every call to the dearer provider because the ledger is down
 * would be a spend change nobody decided. Never throws.
 */
export async function loadProviderHealth(serviceKey: string, now: Date = new Date()): Promise<ProviderHealth> {
  const hit = providerHealthCache.get(serviceKey)
  if (hit && hit.expiresAt > Date.now()) return hit.value
  const unreadable = (why: string): ProviderHealth =>
    ({ state: "healthy", routeAround: false, reason: `health ledger unreadable (${why}) — not routed around`, calls: 0, faults: 0, streak: 0, cooldownUntil: null })
  let value: ProviderHealth
  try {
    const { createServiceClient } = await import("@/lib/supabase/service")
    const { data, error } = await createServiceClient()
      .from("api_response_logs")
      .select("recorded_at, is_error, error_type")
      .eq("service_key", serviceKey)
      .gte("recorded_at", new Date(now.getTime() - PROVIDER_HEALTH_POLICY.windowMs).toISOString())
      .order("recorded_at", { ascending: false })
      .limit(PROVIDER_HEALTH_POLICY.maxSamples)
    if (error) {
      console.warn(`[connector-gateway] provider health read refused for ${serviceKey}: ${error.message} — not routed around`)
      value = unreadable(error.message)
    } else {
      value = deriveProviderHealth(((data ?? []) as Array<{ recorded_at: string; is_error: boolean; error_type: string | null }>)
        .map((r) => ({ at: r.recorded_at, ok: r.is_error !== true, errorType: r.error_type })), now)
    }
  } catch (e) {
    value = unreadable(e instanceof Error ? e.message : String(e))
  }
  providerHealthCache.set(serviceKey, { value, expiresAt: Date.now() + PROVIDER_HEALTH_TTL_MS })
  return value
}
