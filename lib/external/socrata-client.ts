/**
 * lib/external/socrata-client.ts
 *
 * Generic Socrata / SODA 2.x adapter — the data-standard most US cities + counties publish their
 * open data with (permits, code violations, probate filings, property transfers). Each dataset is
 * a `{host}/resource/{datasetId}.json` URL queryable via SoQL ($where / $select / $order / $limit).
 *
 * One adapter for every city portal:
 *   - data.austintexas.gov (Austin)
 *   - data.cityofchicago.org (Chicago)
 *   - data.lacity.org (Los Angeles)
 *   - data.sfgov.org (San Francisco)
 *   - data.dallasopendata.com (Dallas)
 *   - data.cityofnewyork.us (NYC) — etc.
 *
 * Public datasets often work WITHOUT an app token (rate-limited); set SOCRATA_APP_TOKEN env to
 * lift the limit. Routes through the canonical connector-gateway (never-throws, healer-observable).
 */

export interface SocrataQuery {
  /** SoQL $select clause (defaults to "*"). */
  select?: string
  /** SoQL $where clause (no leading "$where=" prefix). */
  where?:  string
  /** SoQL $order clause. */
  order?:  string
  /** Page size — Socrata default 1000, hard max 50000. */
  limit?:  number
  offset?: number
  /** Full-text search across all columns. */
  q?:      string
}

export interface SocrataResult<T = Record<string, unknown>> {
  ok:     boolean
  status: number | null
  data:   T[]
  error:  string | null
}

export async function socrataQuery<T = Record<string, unknown>>(params: {
  /** Host portal — e.g. "data.austintexas.gov" (no scheme). */
  host:      string
  /** Dataset 4x4 id — e.g. "3syk-w9eu" for Austin building permits. */
  datasetId: string
  query?:    SocrataQuery
}): Promise<SocrataResult<T>> {
  if (!params.host || !params.datasetId) {
    return { ok: false, status: null, data: [], error: "host and datasetId required" }
  }
  const appToken = process.env.SOCRATA_APP_TOKEN
  const q: Record<string, string> = {}
  const sq = params.query ?? {}
  if (sq.select) q.$select = sq.select
  if (sq.where)  q.$where  = sq.where
  if (sq.order)  q.$order  = sq.order
  if (sq.q)      q.$q      = sq.q
  q.$limit  = String(sq.limit  ?? 1000)
  q.$offset = String(sq.offset ?? 0)

  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const res = await callConnector<T[]>({
    connector: `socrata:${params.host}`,
    baseUrl:   `https://${params.host}`,
    path:      `resource/${params.datasetId}.json`,
    method:    "GET",
    query:     q,
    auth:      appToken ? { style: "header", name: "X-App-Token", value: appToken } : { style: "none" },
  })
  if (!res.ok || !res.data) {
    return { ok: false, status: res.status, data: [], error: res.error ?? "socrata query failed" }
  }
  return { ok: true, status: res.status, data: Array.isArray(res.data) ? res.data : [], error: null }
}

// ─────────────────────────────────────────────────────────────────────────────
// SoQL INTERPOLATION GUARD
// ─────────────────────────────────────────────────────────────────────────────
//
// `recentPermits` builds its $where by string concatenation. That is not injectable TODAY —
// `permitDateColumn` comes from a committed constant (socrata-market-registry.ts) and `sinceIso`
// is computed by the cron from Date.now(). It becomes injectable the MOMENT market config is
// operator-editable, which is the direction this lane is heading (see the registry header's
// discovery note). A `$where` is not a parameterized query: Socrata has no bind placeholders, so
// the only defence is refusing to build the clause at all when either half is not the shape it
// claims to be.
//
// Both guards are WHITELISTS, not escapes. An escape function has to be right about every
// metacharacter of a dialect we do not own; a whitelist has to be right about one shape we do.
//
/** A Socrata (SODA 2.x) field name: lowercase, starts with a letter, then letters/digits/`_`.
 *  Trailing underscores are REAL and load-bearing here — Socrata renders a column labelled
 *  "PERMIT#" as `permit_` and NYC's "JOB #" as `job__`. Anything with a space, quote, parenthesis,
 *  comma or operator in it is not a field name and is refused rather than escaped. */
const SOQL_FIELD_NAME = /^[a-z][a-z0-9_]{0,62}$/

/** `YYYY-MM-DD`, the only date shape this lane ever bounds on. Rejects a full timestamp on
 *  purpose: the callers all slice to a calendar day, and accepting more shapes widens what a
 *  future operator-supplied value could be. */
const ISO_CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/

/** PURE. True when `value` is a Socrata field name safe to interpolate into a SoQL clause. */
export function isSoqlFieldName(value: unknown): value is string {
  return typeof value === "string" && SOQL_FIELD_NAME.test(value)
}

/** PURE. True when `value` is a bare `YYYY-MM-DD` calendar day. */
export function isIsoCalendarDay(value: unknown): value is string {
  return typeof value === "string" && ISO_CALENDAR_DAY.test(value)
}

/** Convenience: scan a city's building-permits dataset for recent activity. The dataset id varies
 *  per city — keep a per-city map of "permit issued" datasets and call this with the right id.
 *
 *  REFUSES rather than escapes when either interpolated half is off-shape: the refusal is returned
 *  in the adapter's own `{ ok:false, error }` envelope, so the sweep counts and reports it exactly
 *  like a portal outage instead of throwing or — far worse — sending a clause it did not intend. */
export async function recentPermits<T = Record<string, unknown>>(params: {
  host: string
  datasetId: string
  sinceIso: string
  permitDateColumn: string
  limit?: number
}): Promise<SocrataResult<T>> {
  if (!isSoqlFieldName(params.permitDateColumn)) {
    return {
      ok: false, status: null, data: [],
      error: `refused: "${String(params.permitDateColumn)}" is not a Socrata field name`,
    }
  }
  if (!isIsoCalendarDay(params.sinceIso)) {
    return {
      ok: false, status: null, data: [],
      error: `refused: sinceIso "${String(params.sinceIso)}" is not a YYYY-MM-DD calendar day`,
    }
  }
  return socrataQuery<T>({
    host: params.host,
    datasetId: params.datasetId,
    query: {
      where: `${params.permitDateColumn} >= '${params.sinceIso}'`,
      order: `${params.permitDateColumn} DESC`,
      limit: params.limit ?? 1000,
    },
  })
}
