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

/** Convenience: scan a city's building-permits dataset for recent activity. The dataset id varies
 *  per city — keep a per-city map of "permit issued" datasets and call this with the right id. */
export async function recentPermits<T = Record<string, unknown>>(params: {
  host: string
  datasetId: string
  sinceIso: string
  permitDateColumn: string
  limit?: number
}): Promise<SocrataResult<T>> {
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
