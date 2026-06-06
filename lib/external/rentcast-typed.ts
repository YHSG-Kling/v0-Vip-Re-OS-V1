/**
 * lib/external/rentcast-typed.ts
 *
 * Compile-time-typed wrappers around the RentCast REST surface, derived from the official OpenAPI
 * spec via `openapi-typescript` (regenerate with scripts/codegen-rentcast.sh). Drift between our
 * code and RentCast's API now surfaces at TYPE-CHECK time instead of as 4xx/5xx in production —
 * the canonical lead path is RentCast for MLS data and we don't want it to silently fail.
 *
 * Two ways to use this module:
 *   1. The exported result types (RentcastSaleListing, RentcastSalesIndexResponse, etc.) — drop
 *      them into the existing `lib/property/rentcast.ts` callsite return signatures so callers see
 *      the exact shape RentCast promises (without having to read the spec).
 *   2. `callRentcast(path, params)` — a thin gateway-aware caller that routes the request through
 *      `connector-gateway` (single-egress, healer-observable, never throws) and returns the typed
 *      response. Existing `lib/property/rentcast.ts` callers can adopt it incrementally.
 */
import type { paths } from "./_generated/rentcast-openapi"

// ────────────────────────────────────────────────────────────────────────────
// Convenience type aliases — typed result shapes for every RentCast endpoint we use.
// ────────────────────────────────────────────────────────────────────────────

/** GET /properties — array of property records. */
export type RentcastPropertiesQuery    = paths["/properties"]["get"]["parameters"]["query"]
export type RentcastPropertiesResponse = paths["/properties"]["get"]["responses"][200]["content"]["application/json"]

/** GET /properties/{id} — single property. */
export type RentcastPropertyResponse = paths["/properties/{id}"]["get"]["responses"][200]["content"]["application/json"]

/** GET /listings/sale — sale listings index (motivation + price + photos). */
export type RentcastSaleListingsQuery    = paths["/listings/sale"]["get"]["parameters"]["query"]
export type RentcastSaleListingsResponse = paths["/listings/sale"]["get"]["responses"][200]["content"]["application/json"]
export type RentcastSaleListing          = RentcastSaleListingsResponse extends Array<infer T> ? T : never

/** GET /listings/sale/{id} — single sale listing. */
export type RentcastSaleListingResponse = paths["/listings/sale/{id}"]["get"]["responses"][200]["content"]["application/json"]

/** GET /listings/rental/long-term — rental listings. */
export type RentcastRentalListingsQuery    = paths["/listings/rental/long-term"]["get"]["parameters"]["query"]
export type RentcastRentalListingsResponse = paths["/listings/rental/long-term"]["get"]["responses"][200]["content"]["application/json"]
export type RentcastRentalListing          = RentcastRentalListingsResponse extends Array<infer T> ? T : never

/** GET /avm/value — Automated Valuation Model (AVM) sale price estimate. */
export type RentcastAvmValueQuery    = paths["/avm/value"]["get"]["parameters"]["query"]
export type RentcastAvmValueResponse = paths["/avm/value"]["get"]["responses"][200]["content"]["application/json"]

/** GET /avm/rent/long-term — AVM long-term rental estimate. */
export type RentcastAvmRentQuery    = paths["/avm/rent/long-term"]["get"]["parameters"]["query"]
export type RentcastAvmRentResponse = paths["/avm/rent/long-term"]["get"]["responses"][200]["content"]["application/json"]

/** GET /markets — market statistics for a ZIP. */
export type RentcastMarketsQuery    = paths["/markets"]["get"]["parameters"]["query"]
export type RentcastMarketsResponse = paths["/markets"]["get"]["responses"][200]["content"]["application/json"]

// ────────────────────────────────────────────────────────────────────────────
// Gateway-aware typed caller
// ────────────────────────────────────────────────────────────────────────────

type RentcastGetPath = {
  [K in keyof paths]: paths[K] extends { get: { parameters: { query?: any }; responses: { 200: { content: { "application/json": any } } } } } ? K : never
}[keyof paths]

type RentcastGetQuery<P extends RentcastGetPath> =
  paths[P] extends { get: { parameters: { query?: infer Q } } } ? Q : never

type RentcastGetResult<P extends RentcastGetPath> =
  paths[P] extends { get: { responses: { 200: { content: { "application/json": infer R } } } } } ? R : never

/**
 * Typed RentCast GET — routes through the canonical connector-gateway (never-throws, healer-
 * observable). When `?id` style path params are needed pass the fully-formed path
 * (e.g. `/properties/abc123`) and an empty query; the type system still enforces the response
 * shape from the matching path entry in the OpenAPI spec.
 */
export async function callRentcastGet<P extends RentcastGetPath>(
  path: P,
  query: RentcastGetQuery<P>,
  apiKey: string,
): Promise<{ ok: boolean; status: number | null; data: RentcastGetResult<P> | null; error: string | null }> {
  // Reject up front — sending `X-Api-Key: ""` to RentCast produces a 401 that wastes a request
  // and misleads the healer into proposing an auth_change fix.
  if (!apiKey || !apiKey.trim()) {
    return { ok: false, status: null, data: null, error: "RentCast apiKey is required" }
  }
  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  // openapi-typescript types the query as Record<string, possibly undefined> — coerce to the
  // string-keyed map our gateway expects.
  const q: Record<string, string> = {}
  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query as Record<string, unknown>)) {
      if (v !== undefined && v !== null) q[k] = String(v)
    }
  }
  const res = await callConnector<RentcastGetResult<P>>({
    connector: "rentcast",
    baseUrl:   "https://api.rentcast.io/v1",
    path:      path.replace(/^\//, ""),
    method:    "GET",
    query:     q,
    auth:      { style: "header", name: "X-Api-Key", value: apiKey },
  })
  return { ok: res.ok, status: res.status, data: res.data, error: res.error }
}
