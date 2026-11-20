// lib/external/datafiniti-client.ts
// ─────────────────────────────────────────────────────────────────────────────
// DATAFINITI — THE ONE TRANSPORT (wave 153, lane 153M; owner ruling B1 "Datainfinit needs to be built"). People Data REST below;
// wave 155 (lane 155I, owner R11) adds the documented MCP tool layer for all FOUR datasets (callDatafinitiTool, further down).
// No purchase, no key, no live call was made building it: every request below is driven offline through the injected
// transport seam by scripts/datafiniti-connector-guard.ts (test:datafiniti-connector). LIVE-VERIFIED: none.
//
// THE CONTRACT, AS READ (2026-11-16 — only what these pages document is implemented; nothing is guessed):
//   · docs.datafiniti.co/reference/people-data — POST https://api.datafiniti.co/v4/people/search, `Authorization: Bearer
//     <token>`, body { query (Datafiniti query syntax), num_records ("for non-downloads, the maximum is 10 records"), format
//     json|csv, download (boolean), view (a saved or pre-made view) }; 200 → { num_found, total_cost, records[], download_id
//     (only when download: true) }; 400 → { error, message, code, details[] }.
//   · docs.datafiniti.co/docs/people-count — num_records: 0 returns only num_found and "will cost 0 credits"; "this feature is
//     only for paid accounts" (a trial account may refuse it — the count is then UNAVAILABLE, never assumed).
//   · docs.datafiniti.co/docs/how-credits-work-api — GET https://api.datafiniti.co/v4/account "for no charge" (credits used per
//     data type incl. people_credits_used, plan_ids, features[].enabledFields, overages_enabled, overage_limit, disabled_code);
//     a search is charged "up to your num_records … only for the amount of records found … If 0 records are found, no credits
//     will be charged"; a download's `total_cost` is what the account was charged; exceeding the allotment answers 400
//     { errors: ["`num_records` requested will exceed credit allotment for plan."] }.
//   · docs.datafiniti.co/mcp-server — the REST bearer token is the only credential ("no separate MCP credential"; it
//     "regenerates whenever you change your Datafiniti password"); the MCP server at https://api.datafiniti.co/v4/mcp
//     (Streamable HTTP) documents df_download_status (queued | running | completed | cancelled, result links valid 7 days, no
//     credit cost). The REST download-status endpoint was NOT among the pages that could be read (reference/downloads did not
//     resolve), so download status is read through that ONE documented MCP tool over the same gateway — REST vs MCP judged:
//     REST for search/count/account (documented, typed), MCP only for the one lifecycle step REST did not document to us.
//   · NOT documented to us and therefore NOT built: the /v4/auth username/password exchange (the token is issued in the web
//     portal — a username/password is never stored, logged or sent by this module), the paginate endpoint's request shape,
//     a phone-number query field (phoneNumbers is a nested field whose query syntax is undocumented), 429 semantics (handled
//     as standard HTTP: a refused request, retried with backoff).
//
// CREDENTIALS — two owners, NEVER a cross-fallback (directive §3.2): the platform's own account by NAME
// (DATAFINITI_API_TOKEN, env) or a tenant's own token (decrypted by the caller from platform_credentials, owner_type
// 'brokerage'). A tenant credential with no token is REFUSED — it never falls through to the platform's env token, and the
// platform route never reads a tenant row. The token is never logged, never returned and never placed in an error string.
//
// CHARGES — a retry can double-charge a paid search, so a paid call is retried ONLY on 429 (a refusal: nothing processed).
// A 5xx / network failure on a paid call is OUTCOME UNKNOWN: no retry here; the producer reconciles against the free
// account read (people_credits_used) before any re-ask (owner ruling B10 — reconcile first, never a blind duplicate).
// Free calls (count, account, download status) retry 429 / 5xx / network with bounded backoff.

import { DATAFINITI_PEOPLE_PUBLISHED_PLANS, DATAFINITI_PEOPLE_CEILING_UNIT_USD } from "@/lib/vendor-governance/cost-normalizer"

export const DATAFINITI_API_BASE = "https://api.datafiniti.co/v4"
/** The platform credential BY NAME (never a value). */
const DATAFINITI_PLATFORM_TOKEN_ENV = "DATAFINITI_API_TOKEN"
/** "For non-downloads, the maximum is 10 records." (reference/people-data) */
export const DATAFINITI_SEARCH_MAX_RECORDS = 10
// df_download_status: "Download result-file links are valid for 7 days." (mcp-server) — the territory door re-reads the status
// (and so the links) on every resume, so no stored link is ever older than the run that reads it.
//
// THE CONTRACT THIS CLIENT WAS WRITTEN FROM (read 2026-11-16; documentation, not runtime state):
//   read:       docs.datafiniti.co/reference/people-data · /docs/people-data-schema · /docs/api-people-data · /docs/people-count ·
//               /docs/how-credits-work-api · /mcp-server · www.datafiniti.co/data/people-data
//   UNREADABLE: docs.datafiniti.co/reference/downloads · /reference/auth · /reference/account — so the username / password token
//               exchange and REST pagination are NOT built; download status uses the documented MCP tool instead.

// ─── the documented People record (schema page — "actual people records may not have every field present") ─────────

export interface DatafinitiPhoneNumber { number?: string; carrier?: string; type?: string; tested?: boolean; reachableStatus?: boolean; bdscore?: number; lastDateSeen?: string }
export interface DatafinitiOwnedProperty { propertyKey?: string; datePurchased?: string; dateSold?: string }
/** Every field is optional: the schema page states not every field is present on every record. */
export interface DatafinitiPeopleRecord {
  id?: string
  keys?: string[]
  firstName?: string; middleName?: string; lastName?: string
  birthDate?: string; birthYear?: number | string; deceased?: boolean; dateOfDeath?: string; gender?: string
  emails?: string[]; personalEmails?: string[]; professionalEmails?: string[]; primaryEmail?: string
  phoneNumbers?: DatafinitiPhoneNumber[]
  phoneNumberHighScoreMobile?: string; phoneNumberHighScoreMobileScore?: number
  phoneNumberHighScoreLand?: string; phoneNumberHighScoreLandScore?: number
  tcpa?: boolean
  /** The CURRENT WORK location (schema: "where this person works") — never a home or property address. */
  address?: string; city?: string; province?: string; postalCode?: string; country?: string
  businessName?: string; jobTitle?: string
  mostRecentPropertyPurchaseDate?: string; mostRecentPropertyPurchaseKey?: string
  propertiesOwnedHistory?: DatafinitiOwnedProperty[]
  /** Deprecated by the vendor as of 2026-01-08 — read only as a fallback key list, never preferred. */
  propertiesOwned?: string[]
  propertyKeys?: string[] | string
  dateAdded?: string; dateUpdated?: string
  sourceURLs?: string[]; domains?: string[]
  licenses?: Array<{ type?: string; value?: string }>
  [field: string]: unknown
}

export interface DatafinitiSearchResult {
  numFound: number
  /** The response's own total_cost (credits). null = the response carried none — booked as UNKNOWN, never $0. */
  totalCostCredits: number | null
  records: DatafinitiPeopleRecord[]
  downloadId: string | null
}

// ─── the typed query builder — no free text from agent prose ever reaches `query` ────────────────────────────────────

/** The ONLY filters a caller can express. Field names are the schema's; values are validated and quoted. */
export interface DatafinitiPeopleFilters {
  firstName?: string
  lastName?: string
  email?: string
  /** Work location (schema geographical fields describe where the person works). */
  city?: string
  province?: string
  postalCode?: string
  country?: string
  /** A Datafiniti property key (schema propertyKeys: "directly links a property to the person"). */
  propertyKey?: string
  /** dateUpdated ≥ this ISO date (Lucene range — the MCP page names the query language Lucene). */
  updatedSince?: string
}

const NAME_RE = /^[\p{L}][\p{L}'’ .-]{0,59}$/u
const EMAIL_RE = /^[^\s@"\\]{1,64}@[^\s@"\\]{1,190}\.[A-Za-z]{2,24}$/
const PROPERTY_KEY_RE = /^[a-z]{2}\/[a-z]{2}\/[a-z0-9-]{1,60}\/[a-z0-9-]{1,120}$/
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Quote one value for the query: wrap in double quotes; a backslash or a double quote inside is escaped. */
function quoteValue(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

/**
 * PURE — build the Datafiniti query from TYPED filters only. Every value is validated against its field's shape and quoted;
 * terms are joined with AND. Refuses an empty filter set (a "match everything" pull), any value failing its shape, and any
 * key that is not a declared filter (a caller cannot smuggle `query` text through an extra key).
 */
export function buildDatafinitiPeopleQuery(filters: DatafinitiPeopleFilters): { ok: true; query: string } | { ok: false; problems: string[] } {
  const problems: string[] = []
  const terms: string[] = []
  const allowed = new Set(["firstName", "lastName", "email", "city", "province", "postalCode", "country", "propertyKey", "updatedSince"])
  for (const k of Object.keys(filters ?? {})) if (!allowed.has(k)) problems.push(`${k}: not a declared filter — free-text query is never accepted`)
  const f = filters ?? {}
  const name = (field: "firstName" | "lastName") => {
    const v = f[field]
    if (v === undefined) return
    const t = String(v).trim()
    if (!NAME_RE.test(t)) problems.push(`${field}: letters, spaces, apostrophes, periods and hyphens only (≤ 60)`)
    else terms.push(`${field}:${quoteValue(t)}`)
  }
  name("firstName"); name("lastName")
  if (f.email !== undefined) {
    const t = String(f.email).trim().toLowerCase()
    if (!EMAIL_RE.test(t)) problems.push("email: not an email address")
    else terms.push(`emails:${quoteValue(t)}`)
  }
  if (f.city !== undefined) {
    const t = String(f.city).trim()
    if (!NAME_RE.test(t)) problems.push("city: letters, spaces, apostrophes, periods and hyphens only (≤ 60)")
    else terms.push(`city:${quoteValue(t)}`)
  }
  if (f.province !== undefined) {
    const t = String(f.province).trim().toUpperCase()
    if (!/^[A-Z]{2}$/.test(t)) problems.push("province: a two-letter state code")
    else terms.push(`province:${t}`)
  }
  if (f.postalCode !== undefined) {
    const t = String(f.postalCode).trim()
    if (!/^\d{5}(-\d{4})?$/.test(t)) problems.push("postalCode: a five-digit ZIP (optionally ZIP+4)")
    else terms.push(`postalCode:${quoteValue(t)}`)
  }
  if (f.country !== undefined) {
    const t = String(f.country).trim().toUpperCase()
    if (!/^[A-Z]{2}$/.test(t)) problems.push("country: a two-letter country code")
    else terms.push(`country:${t}`)
  }
  if (f.propertyKey !== undefined) {
    const t = String(f.propertyKey).trim().toLowerCase()
    if (!PROPERTY_KEY_RE.test(t)) problems.push("propertyKey: a Datafiniti property key (country/state/city/street, e.g. us/tx/sugarland/72grantslkcir)")
    else terms.push(`propertyKeys:${quoteValue(t)}`)
  }
  if (f.updatedSince !== undefined) {
    const t = String(f.updatedSince).trim().slice(0, 10)
    if (!ISO_DATE_RE.test(t) || Number.isNaN(Date.parse(t))) problems.push("updatedSince: an ISO date (YYYY-MM-DD)")
    else terms.push(`dateUpdated:[${t} TO *]`)
  }
  const identifying = terms.filter((t) => !/^(country|province|dateUpdated):/.test(t))
  if (terms.length === 0) problems.push("no filter — a match-everything pull is refused")
  else if (identifying.length === 0) problems.push("only country / state / date filters — name an identifying filter (name, email, city, ZIP or property key)")
  if (problems.length) return { ok: false, problems }
  return { ok: true, query: terms.join(" AND ") }
}

// ─── credentials (two owners, never mixed) ───────────────────────────────────────────────────────────────────────────

export type DatafinitiCredential =
  | { owner: "platform" }
  /** The tenant's own token, decrypted by the caller from ITS platform_credentials row. brokerageId comes from the session. */
  | { owner: "tenant"; brokerageId: string; connectionId: string; token: string | null }

function resolveToken(c: DatafinitiCredential, env: Record<string, string | undefined>): { ok: true; token: string; brokerageId: string | null } | { ok: false; reason: string } {
  if (c.owner === "tenant") {
    const t = (c.token ?? "").trim()
    // A tenant credential NEVER falls through to the platform token (directive §3.2 "do not cross fallback").
    if (!t) return { ok: false, reason: "the tenant's Datafiniti connection carries no token — the platform token is never substituted" }
    if (!c.brokerageId) return { ok: false, reason: "a tenant credential names no tenant" }
    return { ok: true, token: t, brokerageId: c.brokerageId }
  }
  const t = (env[DATAFINITI_PLATFORM_TOKEN_ENV] ?? "").trim()
  if (!t) return { ok: false, reason: `${DATAFINITI_PLATFORM_TOKEN_ENV} not configured (by name) — a tenant token is never substituted` }
  return { ok: true, token: t, brokerageId: null }
}

// ─── the transport seam ──────────────────────────────────────────────────────────────────────────────────────────────

export interface DatafinitiHttpRequest {
  method: "GET" | "POST"
  path: string
  body?: unknown
  token: string
  brokerageId: string | null
  headers?: Record<string, string>
  responseType?: "json" | "text"
}
export interface DatafinitiHttpResponse { status: number | null; data: unknown; error: string | null; headers: Record<string, string> }
export type DatafinitiTransport = (req: DatafinitiHttpRequest) => Promise<DatafinitiHttpResponse>

/** Production transport: THE single egress (lib/agentic-os/connector-gateway.ts callConnector). The gateway's own GET retry
 *  is OFF — this module owns the retry policy, because a paid POST must never be retried on an unknown outcome. */
export const gatewayDatafinitiTransport: DatafinitiTransport = async (req) => {
  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const res = await callConnector({
    connector: "datafiniti",
    baseUrl: DATAFINITI_API_BASE,
    path: req.path,
    method: req.method,
    auth: { style: "bearer", token: req.token },
    ...(req.body !== undefined ? { body: req.body } : {}),
    ...(req.headers ? { headers: req.headers } : {}),
    responseType: req.responseType ?? "json",
    brokerageId: req.brokerageId,
    retry: false,
    timeoutMs: 30_000,
  })
  return { status: res.status, data: res.ok ? res.data : (res.errorBody ?? null), error: res.ok ? null : redactDatafinitiSecrets(res.error), headers: res.headers ?? {} }
}

// ─── failures ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type DatafinitiFailureKind =
  | "not_configured" | "auth_failed" | "quota" | "rate_limited" | "server_error" | "network" | "bad_request"
  | "count_unavailable" | "shape_drift" | "outcome_unknown" | "invalid_request"
  /** Wave 155 (lane 155I): an MCP tool answered the documented { code, message, field } envelope — `code` says which. */
  | "coded_error"

export interface DatafinitiFailure { ok: false; kind: DatafinitiFailureKind; status: number | null; message: string; retryable: boolean; attempts: number; code?: string | null }

/** PURE — strip anything token-shaped from a message before it is stored or shown. */
export function redactDatafinitiSecrets(text: string | null | undefined): string {
  return String(text ?? "").replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]").replace(/\b[A-Za-z0-9]{32,}\b/g, "[redacted]").slice(0, 400)
}

/** PURE — the vendor's error messages, from either documented envelope ({ errors: [] } or { error, message, details[] }). */
export function datafinitiErrorMessages(body: unknown): string[] {
  if (!body || typeof body !== "object") return typeof body === "string" && body ? [body] : []
  const b = body as Record<string, unknown>
  const out: string[] = []
  if (Array.isArray(b.errors)) for (const e of b.errors) if (typeof e === "string") out.push(e)
  if (typeof b.message === "string") out.push(b.message)
  if (typeof b.error === "string") out.push(b.error)
  if (Array.isArray(b.details)) for (const d of b.details) if (d && typeof d === "object" && typeof (d as Record<string, unknown>).message === "string") out.push(String((d as Record<string, unknown>).message))
  return out
}

/** PURE — classify a non-2xx answer. 400 "exceed credit allotment" is the documented quota refusal. */
export function classifyDatafinitiFailure(status: number | null, body: unknown, op: "count" | "paid" | "free"): Omit<DatafinitiFailure, "attempts"> {
  const msgs = datafinitiErrorMessages(body)
  const message = redactDatafinitiSecrets(msgs.join("; ") || (status === null ? "network failure" : `HTTP ${status}`))
  if (status === null) return { ok: false, kind: op === "paid" ? "outcome_unknown" : "network", status, message, retryable: op !== "paid" }
  if (status === 401 || status === 403) {
    if (op === "count" && /paid|plan|count/i.test(message)) return { ok: false, kind: "count_unavailable", status, message, retryable: false }
    return { ok: false, kind: "auth_failed", status, message, retryable: false }
  }
  if (status === 429) return { ok: false, kind: "rate_limited", status, message, retryable: true }
  if (status >= 500) return { ok: false, kind: op === "paid" ? "outcome_unknown" : "server_error", status, message, retryable: op !== "paid" }
  if (status === 400 && /exceed credit allotment/i.test(message)) return { ok: false, kind: "quota", status, message, retryable: false }
  if (op === "count" && /paid account|plan/i.test(message)) return { ok: false, kind: "count_unavailable", status, message, retryable: false }
  return { ok: false, kind: "bad_request", status, message, retryable: false }
}

// ─── the client ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DatafinitiClientOptions {
  transport?: DatafinitiTransport
  /** Injected for the proofs; production waits for real. */
  sleep?: (ms: number) => Promise<void>
  /** Retries after the first attempt (bounded). Default 2. */
  maxRetries?: number
  /** Read for the PLATFORM token only (default process.env). */
  env?: Record<string, string | undefined>
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function backoffMs(attempt: number, headers: Record<string, string>): number {
  const ra = Number(headers["retry-after"])
  if (Number.isFinite(ra) && ra >= 0) return Math.min(ra * 1000, 30_000)
  return Math.min(500 * 2 ** attempt, 8_000)
}

async function send(
  opts: DatafinitiClientOptions, cred: DatafinitiCredential, req: Omit<DatafinitiHttpRequest, "token" | "brokerageId">, op: "count" | "paid" | "free",
): Promise<{ ok: true; data: unknown; attempts: number } | DatafinitiFailure> {
  const tok = resolveToken(cred, opts.env ?? process.env)
  if (!tok.ok) return { ok: false, kind: "not_configured", status: null, message: tok.reason, retryable: false, attempts: 0 }
  const transport = opts.transport ?? gatewayDatafinitiTransport
  const sleep = opts.sleep ?? defaultSleep
  const max = Math.max(0, Math.min(opts.maxRetries ?? 2, 4))
  let attempts = 0
  for (;;) {
    attempts++
    let res: DatafinitiHttpResponse
    try {
      res = await transport({ ...req, token: tok.token, brokerageId: tok.brokerageId })
    } catch (e) {
      res = { status: null, data: null, error: e instanceof Error ? e.message : String(e), headers: {} }
    }
    if (res.status !== null && res.status >= 200 && res.status < 300) return { ok: true, data: res.data, attempts }
    const f = classifyDatafinitiFailure(res.status, res.data ?? res.error, op)
    // A paid call retries ONLY a 429 (a refused request — nothing was processed, nothing charged).
    const mayRetry = f.retryable && (op !== "paid" || f.kind === "rate_limited")
    if (!mayRetry || attempts > max) return { ...f, attempts }
    await sleep(backoffMs(attempts - 1, res.headers ?? {}))
  }
}

function asNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

/**
 * The COUNT (num_records: 0) — documented at 0 credits, paid accounts only. Returns the count and NOTHING else: a response
 * that carries records anyway has them DROPPED (a count never delivers contacts) and the anomaly is reported.
 */
export async function countDatafinitiPeople(cred: DatafinitiCredential, filters: DatafinitiPeopleFilters, opts: DatafinitiClientOptions = {}):
  Promise<{ ok: true; numFound: number; costCredits: 0; anomalies: string[]; attempts: number } | DatafinitiFailure> {
  const q = buildDatafinitiPeopleQuery(filters)
  if (!q.ok) return { ok: false, kind: "invalid_request", status: null, message: q.problems.join("; "), retryable: false, attempts: 0 }
  const r = await send(opts, cred, { method: "POST", path: "/people/search", body: { query: q.query, num_records: 0 } }, "count")
  if (!r.ok) return r
  const d = (r.data ?? {}) as Record<string, unknown>
  const n = asNumber(d.num_found)
  if (n === null) return { ok: false, kind: "shape_drift", status: 200, message: "count answered without num_found", retryable: false, attempts: r.attempts }
  const anomalies: string[] = []
  if (Array.isArray(d.records) && d.records.length > 0) anomalies.push(`a count answered with ${d.records.length} record(s) — dropped, never delivered`)
  const tc = asNumber(d.total_cost)
  if (tc !== null && tc > 0) anomalies.push(`a count reported total_cost ${tc} — the docs say 0 credits; reconcile against the account read`)
  return { ok: true, numFound: n, costCredits: 0, anomalies, attempts: r.attempts }
}

function parseSearch(data: unknown, wantDownload: boolean): DatafinitiSearchResult | { drift: string } {
  const d = (data ?? {}) as Record<string, unknown>
  const numFound = asNumber(d.num_found)
  if (numFound === null) return { drift: "search answered without num_found" }
  const records = Array.isArray(d.records) ? (d.records.filter((r) => r && typeof r === "object") as DatafinitiPeopleRecord[]) : []
  if (!wantDownload && !Array.isArray(d.records)) return { drift: "search answered without a records array" }
  const dl = d.download_id
  const downloadId = typeof dl === "string" && dl.trim() ? dl.trim() : typeof dl === "number" && Number.isFinite(dl) ? String(dl) : null
  if (wantDownload && !downloadId) return { drift: "a download was requested but no download_id came back" }
  return { numFound, totalCostCredits: asNumber(d.total_cost), records, downloadId }
}

/** A PAID search (≤ 10 records, json). Cost is the response's own total_cost — null when absent (booked unknown, never 0). */
export async function searchDatafinitiPeople(
  cred: DatafinitiCredential,
  input: { filters: DatafinitiPeopleFilters; numRecords: number; view?: string | null },
  opts: DatafinitiClientOptions = {},
): Promise<({ ok: true; attempts: number } & DatafinitiSearchResult) | DatafinitiFailure> {
  const q = buildDatafinitiPeopleQuery(input.filters)
  if (!q.ok) return { ok: false, kind: "invalid_request", status: null, message: q.problems.join("; "), retryable: false, attempts: 0 }
  const n = Math.floor(input.numRecords)
  if (!(n >= 1 && n <= DATAFINITI_SEARCH_MAX_RECORDS)) return { ok: false, kind: "invalid_request", status: null, message: `num_records must be 1–${DATAFINITI_SEARCH_MAX_RECORDS} for a non-download search (a count is countDatafinitiPeople)`, retryable: false, attempts: 0 }
  const view = input.view ?? null
  if (view !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(view)) return { ok: false, kind: "invalid_request", status: null, message: "view: a saved / pre-made view NAME", retryable: false, attempts: 0 }
  const r = await send(opts, cred, { method: "POST", path: "/people/search", body: { query: q.query, num_records: n, format: "json", ...(view ? { view } : {}) } }, "paid")
  if (!r.ok) return r
  const p = parseSearch(r.data, false)
  if ("drift" in p) return { ok: false, kind: "shape_drift", status: 200, message: p.drift, retryable: false, attempts: r.attempts }
  return { ok: true, attempts: r.attempts, ...p }
}

/** Start a bulk DOWNLOAD (download: true). The response's download_id is the checkpoint; total_cost is the charge. */
export async function startDatafinitiPeopleDownload(
  cred: DatafinitiCredential,
  input: { filters: DatafinitiPeopleFilters; numRecords: number; format?: "json" | "csv"; view?: string | null },
  opts: DatafinitiClientOptions = {},
): Promise<({ ok: true; attempts: number } & DatafinitiSearchResult) | DatafinitiFailure> {
  const q = buildDatafinitiPeopleQuery(input.filters)
  if (!q.ok) return { ok: false, kind: "invalid_request", status: null, message: q.problems.join("; "), retryable: false, attempts: 0 }
  const n = Math.floor(input.numRecords)
  if (!(n >= 1)) return { ok: false, kind: "invalid_request", status: null, message: "num_records must be ≥ 1 for a download (the plan bounds the maximum)", retryable: false, attempts: 0 }
  const view = input.view ?? null
  if (view !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(view)) return { ok: false, kind: "invalid_request", status: null, message: "view: a saved / pre-made view NAME", retryable: false, attempts: 0 }
  const r = await send(opts, cred, { method: "POST", path: "/people/search", body: { query: q.query, num_records: n, download: true, format: input.format ?? "json", ...(view ? { view } : {}) } }, "paid")
  if (!r.ok) return r
  const p = parseSearch(r.data, true)
  if ("drift" in p) return { ok: false, kind: "shape_drift", status: 200, message: p.drift, retryable: false, attempts: r.attempts }
  return { ok: true, attempts: r.attempts, ...p }
}

export type DatafinitiDownloadStatus = "queued" | "running" | "completed" | "cancelled"

/** PURE — read a JSON-RPC answer that may arrive as JSON or as a Streamable-HTTP event stream (`data:` lines). */
export function parseMcpEnvelope(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>
  if (typeof raw !== "string") return null
  const lines = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean)
  for (const candidate of [...lines.reverse(), raw.trim()]) {
    try { const v = JSON.parse(candidate); if (v && typeof v === "object") return v as Record<string, unknown> } catch { /* next */ }
  }
  return null
}

function collectHttpsLinks(v: unknown, out: Set<string>, depth = 0): void {
  if (depth > 5 || out.size >= 50) return
  if (typeof v === "string") { if (/^https:\/\/\S+$/.test(v)) out.add(v); return }
  if (Array.isArray(v)) { for (const x of v) collectHttpsLinks(x, out, depth + 1); return }
  if (v && typeof v === "object") for (const x of Object.values(v)) collectHttpsLinks(x, out, depth + 1)
}

// ─── THE FOUR-DATASET MCP TOOL LAYER (wave 155, lane 155I — owner R11 "datafinity is more than a person") ─────────────
//
// docs.datafiniti.co/mcp-server (+ the property / business / people MCP pages and reference/search-and-downloads, read
// 2026-11-19): ONE endpoint (https://api.datafiniti.co/v4/mcp, Streamable HTTP, the SAME bearer token, permissions, field access
// and credit accounting as REST), ONE tool set selected by `data_type` — property · people · business · product. Six tools:
//   df_get_schema (FREE) · df_count (FREE) · df_search (charged per record RETURNED; num_records DEFAULT 1, MAX 50; 10,000-record
//   ceiling per query) · df_get_record (1 credit) · df_start_download (async; charged per record requested AND found, size bounded
//   by the plan) · df_download_status (FREE; result links expire after 7 days).
// Errors: HTTP 401 for a missing / expired / invalid token; otherwise { code, message, field } — branch on code. Two codes are
// transient (retry with backoff); every other documented code is final. Zero matches is a SUCCESS (num_found 0).
// NOT stated on those pages (so NOT assumed here): the MCP initialize / session handshake requirement, numeric rate limits,
// licensing / usage rights, full field lists (df_get_schema is the field authority), product field names.
// This is the transport only. THE decision (rights → schema → typed query → count → overlap / cost → approval → one charged
// step) is lib/lead-pipeline/datafiniti-dataset-door.ts runDatafinitiDatasetDoor — nothing else calls the charged tools.

export type DatafinitiDataType = "property" | "people" | "business" | "product"
export const DATAFINITI_DATA_TYPES: readonly DatafinitiDataType[] = Object.freeze(["property", "people", "business", "product"])
export type DatafinitiTool = "df_get_schema" | "df_count" | "df_search" | "df_get_record" | "df_start_download" | "df_download_status"
/** The documented credit class of each tool. A "paid" tool is never retried on an unknown outcome (5xx / network). */
export const DATAFINITI_TOOL_CHARGE: Readonly<Record<DatafinitiTool, "free" | "paid">> = Object.freeze({
  df_get_schema: "free", df_count: "free", df_search: "paid", df_get_record: "paid", df_start_download: "paid", df_download_status: "free",
})
/** df_search: "num_records … default 1, max 50" (mcp-server). */
export const DATAFINITI_MCP_SEARCH_MAX_RECORDS = 50
/** The documented FINAL codes — never retried. */
export const DATAFINITI_NON_RETRYABLE_CODES: readonly string[] = Object.freeze([
  "invalid_type", "invalid_enum", "missing_required_field", "out_of_range", "unknown_field", "invalid_field", "invalid_query",
  "invalid_view", "not_found", "credit_limit_exceeded", "plan_restriction", "feature_not_enabled", "forbidden",
])
/** The documented TRANSIENT codes — retried with bounded backoff. */
export const DATAFINITI_TRANSIENT_CODES: readonly string[] = Object.freeze(["query_runner_error", "internal_error"])

/** PURE — the documented { code, message, field } envelope, wherever an MCP answer carries it (JSON-RPC error.data, an
 *  isError tool result's text, or the structured content). null = no coded error in this answer. */
function datafinitiCodedError(env: Record<string, unknown> | null, payload: unknown, isError: boolean): { code: string; message: string; field: string | null } | null {
  const pick = (v: unknown): { code: string; message: string; field: string | null } | null => {
    if (!v || typeof v !== "object") return null
    const o = v as Record<string, unknown>
    const inner = o.error && typeof o.error === "object" ? (o.error as Record<string, unknown>) : o
    if (typeof inner.code !== "string" || !inner.code.trim()) return null
    return { code: inner.code.trim(), message: typeof inner.message === "string" ? inner.message : inner.code.trim(), field: typeof inner.field === "string" ? inner.field : null }
  }
  const rpc = env?.error && typeof env.error === "object" ? (env.error as Record<string, unknown>) : null
  if (rpc) return pick(rpc.data) ?? { code: typeof rpc.code === "string" ? rpc.code : "jsonrpc_error", message: typeof rpc.message === "string" ? rpc.message : "JSON-RPC error", field: null }
  const coded = pick(payload)
  if (coded) return coded
  return isError ? { code: "tool_error", message: typeof payload === "object" && payload && typeof (payload as Record<string, unknown>).message === "string" ? String((payload as Record<string, unknown>).message) : "the tool reported an error", field: null } : null
}

/**
 * ONE MCP tool call, any of the six, any data_type. Validates the documented required parameters BEFORE any call (a df_search
 * without an EXPLICIT num_records is refused — the vendor default of 1 is never relied on), classifies HTTP 401 (auth) apart
 * from the coded envelope, retries ONLY the two transient codes with backoff (a coded answer is a definite answer that
 * returned no records, so no credit was charged per the documented rule), and never retries a paid tool on a 5xx / network
 * failure (OUTCOME UNKNOWN — the caller reconciles first). Returns the tool's structured payload.
 */
export async function callDatafinitiTool(
  cred: DatafinitiCredential, tool: DatafinitiTool, args: Record<string, unknown>, opts: DatafinitiClientOptions = {},
): Promise<{ ok: true; payload: Record<string, unknown>; attempts: number } | DatafinitiFailure> {
  const invalid = (message: string): DatafinitiFailure => ({ ok: false, kind: "invalid_request", status: null, message, retryable: false, attempts: 0, code: null })
  if (!(tool in DATAFINITI_TOOL_CHARGE)) return invalid(`${String(tool)}: not one of the six documented Datafiniti MCP tools`)
  const a = { ...(args ?? {}) }
  if (tool !== "df_download_status" && !DATAFINITI_DATA_TYPES.includes(a.data_type as DatafinitiDataType)) return invalid(`data_type: one of ${DATAFINITI_DATA_TYPES.join(", ")}`)
  if ((tool === "df_count" || tool === "df_search" || tool === "df_start_download") && !(typeof a.query === "string" && a.query.trim() && a.query.length <= 4000)) return invalid("query: a non-empty query string (≤ 4000)")
  if (tool === "df_search") {
    const n = a.num_records
    if (!(typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= DATAFINITI_MCP_SEARCH_MAX_RECORDS)) return invalid(`num_records: set EXPLICITLY to an integer 1–${DATAFINITI_MCP_SEARCH_MAX_RECORDS} (the documented default is 1 and each returned record is charged)`)
  }
  if (tool === "df_get_record" && !(typeof a.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(a.id))) return invalid("id: the vendor record id")
  if (tool === "df_download_status" && !(typeof a.download_id === "string" && /^\d{1,20}$/.test(a.download_id))) return invalid("download_id: the numeric string df_start_download / a download search returned")
  const op = DATAFINITI_TOOL_CHARGE[tool] === "paid" ? "paid" : "free"
  const sleep = opts.sleep ?? defaultSleep
  const max = Math.max(0, Math.min(opts.maxRetries ?? 2, 4))
  let total = 0
  for (let codedTry = 0; ; codedTry++) {
    const r = await send(opts, cred, {
      method: "POST", path: "/mcp", responseType: "text",
      headers: { Accept: "application/json, text/event-stream" },
      body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: a } },
    }, op)
    total += r.attempts
    if (!r.ok) return { ...r, attempts: total, code: r.code ?? null }
    const env = parseMcpEnvelope(r.data)
    const result = (env?.result ?? null) as Record<string, unknown> | null
    let payload: unknown = result?.structuredContent ?? null
    if (!payload && result && Array.isArray(result.content)) {
      const text = (result.content as Array<Record<string, unknown>>).find((c) => c?.type === "text" && typeof c.text === "string")?.text as string | undefined
      if (text) { try { payload = JSON.parse(text) } catch { payload = { status: text.trim(), message: text.trim() } } }
    }
    const coded = datafinitiCodedError(env, payload, result?.isError === true)
    if (coded) {
      const transient = DATAFINITI_TRANSIENT_CODES.includes(coded.code)
      if (transient && codedTry < max) { await sleep(backoffMs(codedTry, {})); continue }
      return { ok: false, kind: "coded_error", status: 200, code: coded.code, message: redactDatafinitiSecrets(`${coded.code}${coded.field ? ` (${coded.field})` : ""}: ${coded.message}`), retryable: transient, attempts: total }
    }
    if (!env || !result) return { ok: false, kind: "shape_drift", status: 200, message: "no JSON-RPC result", retryable: false, attempts: total, code: null }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, kind: "shape_drift", status: 200, message: `${tool} answered no structured payload`, retryable: false, attempts: total, code: null }
    return { ok: true, payload: payload as Record<string, unknown>, attempts: total }
  }
}

/**
 * The download LIFECYCLE step: df_download_status over the documented MCP endpoint (no credit cost), through the ONE tool
 * call above. The tool's exact result payload is not documented beyond "status … and, once completed, links to the result
 * files" — a status outside the four documented values is SHAPE DRIFT, never guessed.
 */
export async function datafinitiDownloadStatus(cred: DatafinitiCredential, downloadId: string, opts: DatafinitiClientOptions = {}):
  Promise<{ ok: true; status: DatafinitiDownloadStatus; links: string[]; attempts: number } | DatafinitiFailure> {
  const r = await callDatafinitiTool(cred, "df_download_status", { download_id: String(downloadId ?? "").trim() }, opts)
  if (!r.ok) return r
  const status = String(r.payload.status ?? "").trim().toLowerCase()
  if (!["queued", "running", "completed", "cancelled"].includes(status)) return { ok: false, kind: "shape_drift", status: 200, message: `df_download_status answered an undocumented status "${status.slice(0, 40)}"`, retryable: false, attempts: r.attempts }
  const links = new Set<string>()
  if (status === "completed") collectHttpsLinks(r.payload, links)
  return { ok: true, status: status as DatafinitiDownloadStatus, links: [...links], attempts: r.attempts }
}

// ─── account / credit health (free) ──────────────────────────────────────────────────────────────────────────────────

export interface DatafinitiAccountHealth {
  peopleCreditsUsed: number | null
  peoplePlanIds: string[]
  peopleSearch: { view: boolean; download: boolean }
  peoplePaginate: boolean
  overagesEnabled: boolean | null
  overageLimit: number | null
  /** disabled_code ≠ 0 — the account is disabled; nothing is called on it. */
  disabled: boolean
  /** The per-record figure of the matched PUBLISHED tier, or the ceiling when no plan matches. */
  unit: { unitUsd: number; basis: "published_tier" | "published_ceiling"; planId: string | null }
}

/** PURE — match a plan id (documented example shape "people-1k-99") to a PUBLISHED tier; else the published ceiling. */
export function datafinitiUnitUsdForPlan(planIds: readonly string[]): DatafinitiAccountHealth["unit"] {
  for (const id of planIds) {
    const m = /^people-(\d+)(k?)-(\d+)$/i.exec(String(id).trim())
    if (!m) continue
    const records = Number(m[1]) * (m[2] ? 1000 : 1)
    const price = Number(m[3])
    const tier = DATAFINITI_PEOPLE_PUBLISHED_PLANS.find((t) => t.records === records && t.monthlyUsd === price)
    if (tier) return { unitUsd: Math.round((tier.monthlyUsd / tier.records) * 1e6) / 1e6, basis: "published_tier", planId: id }
  }
  return { unitUsd: DATAFINITI_PEOPLE_CEILING_UNIT_USD, basis: "published_ceiling", planId: null }
}

/**
 * GET /account — documented "for no charge". Returns credit HEALTH only: the account holder's name, email, organization and
 * customer id in the response are never read into this shape (they are not ours to keep).
 */
export async function getDatafinitiAccountHealth(cred: DatafinitiCredential, opts: DatafinitiClientOptions = {}):
  Promise<({ ok: true; attempts: number } & DatafinitiAccountHealth) | DatafinitiFailure> {
  const r = await send(opts, cred, { method: "GET", path: "/account" }, "free")
  if (!r.ok) return r
  const d = (r.data ?? {}) as Record<string, unknown>
  if (!("people_credits_used" in d) && !("plan_ids" in d)) return { ok: false, kind: "shape_drift", status: 200, message: "account answered without people_credits_used / plan_ids", retryable: false, attempts: r.attempts }
  const planIds = Array.isArray(d.plan_ids) ? d.plan_ids.filter((p): p is string => typeof p === "string") : []
  const features = Array.isArray(d.features) ? (d.features as Array<Record<string, unknown>>) : []
  const fields = (name: string) => {
    const f = features.find((x) => x && x.name === name)
    return Array.isArray(f?.enabledFields) ? (f!.enabledFields as unknown[]).map(String) : []
  }
  const peoplePlanIds = planIds.filter((p) => /^people-/i.test(p))
  const disabledCode = asNumber(d.disabled_code)
  return {
    ok: true, attempts: r.attempts,
    peopleCreditsUsed: asNumber(d.people_credits_used),
    peoplePlanIds,
    peopleSearch: { view: fields("people:search").includes("view"), download: fields("people:search").includes("download") },
    peoplePaginate: fields("people:paginate").includes("view"),
    overagesEnabled: typeof d.overages_enabled === "boolean" ? d.overages_enabled : null,
    overageLimit: asNumber(d.overage_limit),
    disabled: disabledCode !== null && disabledCode !== 0,
    unit: datafinitiUnitUsdForPlan(peoplePlanIds),
  }
}

// TOMBSTONE (orphan doctrine §1.3): datafinitiPlatformConfigured (a by-name presence check) had no caller — the acquisition door
// establishes "is the platform's own connection configured" for EVERY vendor in one place, by env NAME, in
// lib/lead-pipeline/pooled-pull.ts platformProviderDoorFacts (the registry's envVars), so a second per-vendor copy is not kept.
