/**
 * lib/external/arcgis-permits.ts
 *
 * ArcGIS FeatureServer adapter for the permit / code-violation sweep — the SECOND provider
 * behind lib/external/permit-signals.ts, alongside Socrata (lib/external/socrata-client.ts).
 *
 * ── WHY A SECOND PROVIDER AT ALL ─────────────────────────────────────────────
 * socrata-market-registry.ts marks three registered markets `unavailable` with, verbatim, the
 * same sentence: "Needs an ArcGIS FeatureServer adapter" (Miami, Atlanta) and "Denver publishes
 * permits through denvergov ArcGIS, not data.colorado.gov". Those are not dead markets. They are
 * markets whose data is live at an endpoint this OS could not speak to. Miami is the proof:
 *
 *   https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/miamidade_permit_data/FeatureServer/0
 *     $where=1=1                                    → 139,711 rows        (whole layer)
 *     $where=PermitIssuedDate >= DATE '2026-08-13'  →   1,161 rows (0.83%)
 *     max(PermitIssuedDate)                         → 2026-08-18
 *
 * measured 2026-08-20. A live feed, a real event-date column, and a bound that genuinely
 * SELECTS — the three things socrata-market-registry's failure taxonomy demands before a
 * dataset may be registered.
 *
 * ── THE DEFECT THIS FILE EXISTS TO PREVENT, AND IT IS WORSE HERE ─────────────
 * The recurring finding in this lane is that a dataset which CANNOT BE READ must never be
 * indistinguishable from a market with nothing happening in it. On Socrata that failure needs a
 * mistake to happen: a wrong column name is an HTTP 400, a dead id is an HTTP 404, and only a
 * TEXT date column compares lexicographically into a silent `[]`.
 *
 * ON ARCGIS IT IS THE DEFAULT. A FeatureServer answers **HTTP 200** to its own errors and puts
 * the failure in the BODY. All three of these were read live from Miami-Dade on 2026-08-20 and
 * every one of them came back 200 OK:
 *
 *   invalid field     → {"error":{"code":400,"message":"Cannot perform query. Invalid query
 *                        parameters.","details":["'Invalid field: NoSuchField' parameter is invalid"]}}
 *   layer deleted     → {"error":{"code":400,"message":"Invalid URL","details":["Invalid URL"]}}
 *   genuinely empty   → {"objectIdFieldName":"ObjectId", ... ,"features":[]}
 *
 * A caller that trusts the HTTP status reads ALL THREE as "this market had no permits". A
 * renamed column and a deleted layer would report as a quiet week, daily, forever — the exact
 * defect socrata-market-registry.ts has now documented five separate times, arriving by a new
 * road. `readArcgisError` is the whole answer: an error body is a REFUSAL, never zero rows, and
 * `parseArcgisResponse` is the only sanctioned way to turn a payload into rows.
 *
 * ── TRUNCATION IS ALSO NOT EMPTINESS ─────────────────────────────────────────
 * FeatureServers cap a page at `maxRecordCount` (1,000 on Miami-Dade) and say so with
 * `exceededTransferLimit: true`. Miami's own 7-day window is 1,161 rows — WIDER THAN ONE PAGE on
 * the very first market registered. So this adapter pages with `resultOffset` and, when it still
 * hits its cap, reports `truncated: true` rather than handing back a short list that looks
 * complete. A partial window presented as a whole one is how a sweep silently stops seeing the
 * back half of every week.
 *
 * ── WHAT IT REFUSES ──────────────────────────────────────────────────────────
 * The `where` clause is built by concatenation, exactly as socrata-client's is, and gets the same
 * treatment: WHITELISTS, NOT ESCAPES. An ArcGIS `where` is passed to a real SQL engine, so it is
 * strictly more dangerous than SoQL, and the defence is refusing to build the clause at all when
 * either half is not the shape it claims to be. The refusal comes back in the adapter's own
 * `{ ok:false, error }` envelope so the sweep counts it like any other outage.
 *
 * PURE/IO SPLIT: everything above `arcgisFeatureQuery` is pure and simulator-driven
 * (scripts/external-signal-lanes-simulator.ts). Only `arcgisFeatureQuery` and
 * `recentArcgisPermits` touch the network, and they leave through the canonical
 * connector-gateway like every other outbound call in this repo.
 */

import { isIsoCalendarDay } from "./socrata-client"

// ─────────────────────────────────────────────────────────────────────────────
// PURE — the interpolation guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An ArcGIS field name. CASE-SENSITIVE and typically CamelCase ("PermitIssuedDate"), which is why
 * this is NOT socrata-client's `SOQL_FIELD_NAME` — that one is anchored to lowercase because
 * Socrata lowercases every column, and reusing it here would refuse every real ArcGIS field.
 * Two dialects, two whitelists, stated rather than merged into one permissive regex.
 */
const ARCGIS_FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,62}$/

/** PURE. True when `value` is an ArcGIS field name safe to interpolate into a `where` clause. */
export function isArcgisFieldName(value: unknown): value is string {
  return typeof value === "string" && ARCGIS_FIELD_NAME.test(value)
}

/**
 * PURE. The `where` clause bounding a layer to rows on/after `sinceIso`, or null when either half
 * is off-shape.
 *
 * `DATE 'YYYY-MM-DD'` is the ArcGIS standardised-query date literal and is what every hosted
 * FeatureServer accepts. Returning NULL rather than a best-effort clause is the point: the caller
 * turns it into a stated refusal, and a refusal is reported, where a malformed clause would come
 * back 200-with-an-error-body and be counted as a quiet market.
 */
export function buildArcgisDateWhere(params: { field: string; sinceIso: string }): string | null {
  if (!isArcgisFieldName(params.field)) return null
  if (!isIsoCalendarDay(params.sinceIso)) return null
  return `${params.field} >= DATE '${params.sinceIso}'`
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE — reading a FeatureServer payload
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PURE. The error a FeatureServer reported INSIDE a 200 response, or null when there is none.
 *
 * THE LOAD-BEARING FUNCTION OF THIS FILE. See the header: ArcGIS answers its own failures with
 * HTTP 200 and an `error` object, so without this check a deleted layer and an empty week are
 * the same value. Both live shapes are handled — `message` alone, and `message` + `details[]` —
 * and the returned string carries the vendor's own words so the operator sees WHY without
 * opening a portal.
 */
export function readArcgisError(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null
  const err = (payload as { error?: unknown }).error
  if (!err || typeof err !== "object") return null
  const e = err as { code?: unknown; message?: unknown; details?: unknown }
  const code = typeof e.code === "number" ? e.code : null
  const message = typeof e.message === "string" && e.message.trim() ? e.message.trim() : "unspecified ArcGIS error"
  const details = Array.isArray(e.details)
    ? e.details.filter((d): d is string => typeof d === "string" && !!d.trim()).map((d) => d.trim())
    : []
  const tail = details.length > 0 ? ` — ${details.join("; ")}` : ""
  return code === null ? `${message}${tail}` : `ArcGIS ${code}: ${message}${tail}`
}

/**
 * PURE. `YYYY-MM-DD` for an ArcGIS date value, or null.
 *
 * A FeatureServer publishes a date one of TWO ways and the difference is not inferable from the
 * query — it depends on the field's declared esri type:
 *   · esriFieldTypeDateOnly  → the STRING "2026-08-18"   (Miami-Dade's PermitIssuedDate)
 *   · esriFieldTypeDate      → epoch MILLISECONDS as a number (1755475200000)
 * Both are normalised here to the one shape `readPermitEventDate` in permit-signals.ts already
 * parses, so a second provider does not become a second date vocabulary downstream.
 *
 * Anything else is REFUSED with null rather than coerced. `new Date(x)` accepts a startling
 * amount of garbage and returns a plausible day for it, and a guessed date silently widens or
 * narrows the window — the same reason readPermitEventDate refuses two-digit years.
 */
export function arcgisDateToIsoDay(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Epoch millis. Negative is a pre-1970 permit, which is not a thing this lane sweeps for and
    // is far more likely to be a sentinel, so it is refused rather than rendered as 1969.
    if (value <= 0) return null
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
  }
  if (typeof value === "string") {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim())
    return m ? m[1] : null
  }
  return null
}

/** One row, flattened out of `features[].attributes` into the flat shape permit-signals reads. */
export type ArcgisRow = Record<string, unknown>

export interface ArcgisParse {
  ok: boolean
  rows: ArcgisRow[]
  /** Stated reason when ok is false. Never null when ok is false. */
  error: string | null
  /** The server capped this page. The rows returned are a PREFIX of the match, not the match. */
  exceededTransferLimit: boolean
}

/**
 * PURE. Turn one FeatureServer `/query` payload into rows, or into a stated refusal.
 *
 * THE ONLY SANCTIONED WAY to read an ArcGIS response in this repo. Three outcomes, and keeping
 * them three is the entire contract:
 *   · an `error` body            → ok:false with the vendor's message  (NEVER zero rows)
 *   · a payload with no features → ok:false, "unreadable"              (NEVER zero rows)
 *   · `features: []`             → ok:true with zero rows              (a genuinely quiet window)
 *
 * The middle case matters as much as the first: a payload that is neither an error nor a feature
 * collection is a shape nobody anticipated (an HTML error page, a redirect body, a schema-only
 * response), and reporting THAT as an empty market is the same lie by a different route.
 *
 * `dateFields` names the columns to normalise through `arcgisDateToIsoDay`. Passing the date
 * column here is what lets the downstream readers stay provider-agnostic.
 */
export function parseArcgisResponse(payload: unknown, dateFields: string[] = []): ArcgisParse {
  const vendorError = readArcgisError(payload)
  if (vendorError) {
    return { ok: false, rows: [], error: vendorError, exceededTransferLimit: false }
  }
  if (!payload || typeof payload !== "object") {
    return { ok: false, rows: [], error: "ArcGIS response was not an object", exceededTransferLimit: false }
  }
  const features = (payload as { features?: unknown }).features
  if (!Array.isArray(features)) {
    // NOT zero rows. A body with no `features` array is a body this adapter does not understand,
    // and the honest report is that it could not be read.
    return {
      ok: false, rows: [],
      error: "ArcGIS response carried no `features` array — the layer or query shape is not what this adapter expects",
      exceededTransferLimit: false,
    }
  }

  const rows: ArcgisRow[] = []
  for (const f of features) {
    const attrs = (f as { attributes?: unknown } | null)?.attributes
    if (!attrs || typeof attrs !== "object") continue // a feature with no attributes carries no permit
    const row: ArcgisRow = { ...(attrs as Record<string, unknown>) }
    for (const field of dateFields) {
      if (!(field in row)) continue
      const iso = arcgisDateToIsoDay(row[field])
      // Only overwrite when the value PARSED. Clobbering an unparseable date with null would
      // erase the evidence that the column was there and unreadable, which is the difference
      // permit-signals counts as skippedNoEventDate rather than as an absent column.
      if (iso) row[field] = iso
    }
    rows.push(row)
  }

  return {
    ok: true,
    rows,
    error: null,
    exceededTransferLimit: (payload as { exceededTransferLimit?: unknown }).exceededTransferLimit === true,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE — the layer URL
// ─────────────────────────────────────────────────────────────────────────────

/** PURE. The host of a FeatureServer layer URL, for the connector id. Null when unparseable. */
export function arcgisHostOf(serviceUrl: string): string | null {
  try {
    const u = new URL(serviceUrl)
    return u.protocol === "https:" ? u.host : null
  } catch {
    return null
  }
}

/**
 * PURE. True when `serviceUrl` is an https FeatureServer LAYER url — `.../FeatureServer/<n>`.
 *
 * The trailing layer index is required. A FeatureServer root has no `/query` endpoint, so a URL
 * without it produces the "Invalid URL" error body above — a refusal this adapter can catch, but
 * one it should never have to, because the registry can only ever mean one layer.
 */
export function isArcgisLayerUrl(serviceUrl: unknown): serviceUrl is string {
  if (typeof serviceUrl !== "string") return false
  if (!/^https:\/\//.test(serviceUrl)) return false
  return /\/(FeatureServer|MapServer)\/\d+$/.test(serviceUrl)
}

// ─────────────────────────────────────────────────────────────────────────────
// IO — the fetch
// ─────────────────────────────────────────────────────────────────────────────

export interface ArcgisResult {
  ok: boolean
  status: number | null
  data: ArcgisRow[]
  error: string | null
  /** True when the cap was reached and more matching rows exist than were returned. */
  truncated: boolean
}

/** Hosted FeatureServers cap a page at maxRecordCount; 1000 is the common ceiling. */
const ARCGIS_PAGE_SIZE = 1000

/**
 * One `/query` call against one FeatureServer layer. Never throws — a transport failure comes
 * back as `ok:false` with a status, exactly like `socrataQuery`.
 *
 * NOTE THE TWO-STAGE VERDICT. `callConnector` reports HTTP-level success; `parseArcgisResponse`
 * reports FeatureServer-level success. Both must pass. A 200 carrying an error body is
 * `ok:false` here, and that is the whole reason this function is not three lines of fetch.
 */
export async function arcgisFeatureQuery(params: {
  /** Full layer URL, `.../FeatureServer/0`. */
  serviceUrl: string
  where: string
  outFields?: string
  orderByFields?: string
  resultOffset?: number
  resultRecordCount?: number
  /** Columns to normalise to `YYYY-MM-DD`. */
  dateFields?: string[]
}): Promise<ArcgisResult> {
  if (!isArcgisLayerUrl(params.serviceUrl)) {
    return {
      ok: false, status: null, data: [], truncated: false,
      error: `refused: "${String(params.serviceUrl)}" is not an https FeatureServer layer URL (.../FeatureServer/<n>)`,
    }
  }
  const host = arcgisHostOf(params.serviceUrl)
  if (!host) {
    return { ok: false, status: null, data: [], truncated: false, error: "refused: unparseable ArcGIS host" }
  }

  const query: Record<string, string> = {
    where: params.where,
    outFields: params.outFields ?? "*",
    returnGeometry: "false",
    f: "json",
    resultOffset: String(params.resultOffset ?? 0),
    resultRecordCount: String(params.resultRecordCount ?? ARCGIS_PAGE_SIZE),
  }
  if (params.orderByFields) query.orderByFields = params.orderByFields

  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const res = await callConnector<unknown>({
    connector: `arcgis:${host}`,
    url: params.serviceUrl.replace(/\/$/, "") + "/query",
    method: "GET",
    query,
    auth: { style: "none" }, // public open-data layers; no key exists to add
  })
  if (!res.ok) {
    return { ok: false, status: res.status, data: [], truncated: false, error: res.error ?? "arcgis query failed" }
  }

  const parsed = parseArcgisResponse(res.data, params.dateFields ?? [])
  if (!parsed.ok) {
    // A 200 that the FeatureServer itself calls a failure. Reported with the HTTP status attached
    // so the operator can see it WAS a 200 and still was not data.
    return { ok: false, status: res.status, data: [], truncated: false, error: parsed.error }
  }
  return { ok: true, status: res.status, data: parsed.rows, error: null, truncated: parsed.exceededTransferLimit }
}

/**
 * The ArcGIS twin of `recentPermits` — every row on/after `sinceIso`, paged past the server cap.
 *
 * REFUSES rather than escapes when either interpolated half is off-shape, in the adapter's own
 * envelope, so the sweep counts it exactly like a portal outage.
 *
 * PAGING STOPS FOR THREE REASONS and only one of them is "that is all the rows": the page came
 * back short, the caller's `limit` is reached, or a page refused. A refusal MID-WALK returns
 * `ok:false` and discards the partial — half a window reported as a whole one is the truncation
 * lie this file's header is about, and it is worse than no answer because it looks like one.
 */
export async function recentArcgisPermits(params: {
  serviceUrl: string
  dateField: string
  sinceIso: string
  /** Hard ceiling on rows returned across all pages. */
  limit?: number
}): Promise<ArcgisResult> {
  const where = buildArcgisDateWhere({ field: params.dateField, sinceIso: params.sinceIso })
  if (!where) {
    const badField = !isArcgisFieldName(params.dateField)
    return {
      ok: false, status: null, data: [], truncated: false,
      error: badField
        ? `refused: "${String(params.dateField)}" is not an ArcGIS field name`
        : `refused: sinceIso "${String(params.sinceIso)}" is not a YYYY-MM-DD calendar day`,
    }
  }

  const limit = Math.max(1, params.limit ?? ARCGIS_PAGE_SIZE)
  const rows: ArcgisRow[] = []
  let offset = 0
  let status: number | null = null

  // Bounded on purpose. A runaway pager against a layer whose `where` matches everything is a
  // serverless invocation that spends its whole budget on one market.
  const MAX_PAGES = 10
  for (let page = 0; page < MAX_PAGES; page++) {
    const want = Math.min(ARCGIS_PAGE_SIZE, limit - rows.length)
    if (want <= 0) break
    const res = await arcgisFeatureQuery({
      serviceUrl: params.serviceUrl,
      where,
      // Ordering by the bound column makes the page walk deterministic. Without an order an
      // offset walk over an unordered result may repeat or skip rows between pages.
      orderByFields: `${params.dateField} DESC`,
      resultOffset: offset,
      resultRecordCount: want,
      dateFields: [params.dateField],
    })
    status = res.status
    if (!res.ok) return { ok: false, status: res.status, data: [], truncated: false, error: res.error }

    rows.push(...res.data)
    // A short page means the match is exhausted; `truncated` is only meaningful on a full one.
    if (res.data.length < want) {
      return { ok: true, status, data: rows, error: null, truncated: false }
    }
    offset += res.data.length
  }

  // Fell out of the loop still filling pages: there are more matching rows than were returned.
  return { ok: true, status, data: rows, error: null, truncated: true }
}
