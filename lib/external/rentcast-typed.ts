/**
 * lib/external/rentcast-typed.ts
 *
 * Compile-time-typed wrappers around the RentCast REST surface, derived from the official OpenAPI
 * spec via `openapi-typescript` (regenerate with scripts/codegen-rentcast.sh). Drift between our
 * code and RentCast's API now surfaces at TYPE-CHECK time instead of as 4xx/5xx in production —
 * the canonical lead path is RentCast for MLS data and we don't want it to silently fail.
 *
 * Two ways to use this module:
 *   1. The exported result types (RentcastSaleListing, RentcastMarketsResponse, etc.) — adopted
 *      by `lib/property/rentcast.ts` (2026-08-31) so its row mappers and parsers read the exact
 *      shape RentCast promises (without having to read the spec).
 *   2. `callRentcastGet(path, query, apiKey)` — a thin gateway-aware caller that routes the
 *      request through `connector-gateway` (single-egress, healer-observable, never throws) and
 *      returns the typed response. `lib/property/rentcast.ts` is now built on it; the direct
 *      callers in lib/agentic-os/deal-investigator.ts and
 *      lib/lead-pipeline/contact-signal-rescrape.ts use it too (without `as any` — the query
 *      types are the contract, not decoration).
 *   3. `callRentcastGetById(pathTemplate, id, apiKey)` — the `{id}`-path form. The original
 *      header claimed a fully-formed path (e.g. `/listings/sale/abc123`) could be passed to
 *      `callRentcastGet`; the type system rightly refuses that (a template string is not a key of
 *      `paths`), so the by-id endpoints were unreachable through the façade and
 *      lib/property/rentcast.ts kept a private untyped transport just for them. This is the
 *      missing half, built instead.
 */
import type { paths } from "./_generated/rentcast-openapi"

// ────────────────────────────────────────────────────────────────────────────
// Convenience type aliases — typed result shapes for every RentCast endpoint we use.
// ────────────────────────────────────────────────────────────────────────────

// TOMBSTONE (orphan doctrine §1.3, 2026-08-31): the aliases for endpoints NOTHING in the tree
// calls — RentcastPropertiesQuery / RentcastPropertiesResponse (GET /properties),
// RentcastPropertyResponse (GET /properties/{id}) and RentcastAvmRentQuery /
// RentcastAvmRentResponse (GET /avm/rent/long-term, further down) — are deleted. The capability
// lives in the generated spec itself: lib/external/_generated/rentcast-openapi.ts `paths`
// carries every endpoint, and an alias is a one-line derivation the day a caller lands (rent
// estimation today reads /listings/rental/long-term through searchRentcastRentalListings, not
// the rent AVM). This module aliases only the endpoints the product actually calls, so "typed
// façade" keeps meaning "the wire we use", not "the vendor's whole catalog".

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

// (RentcastAvmRentQuery / RentcastAvmRentResponse deleted — see the tombstone at the top of
// this block: no caller uses the rent AVM endpoint.)

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
    // The path goes to the gateway VERBATIM, leading slash and all. The gateway
    // normalises the slash itself when building the URL — but it logs `req.path`
    // AS PASSED into the vendor-usage ledger (connector-gateway.ts:191), so a
    // pre-stripped path here silently changes the endpoint vocabulary every
    // ledger reader and the rent-lane simulator key on ("/listings/rental/
    // long-term" became "listings/rental/long-term" and twenty assertions went
    // red). Normalisation is the gateway's job; the caller's job is fidelity.
    path,
    method:    "GET",
    query:     q,
    auth:      { style: "header", name: "X-Api-Key", value: apiKey },
  })
  return { ok: res.ok, status: res.status, data: res.data, error: res.error }
}

/** The `{id}`-parameterised GET paths in the spec. Their `query` is `never`, so `callRentcastGet`
 *  cannot be called for them — this caller is the only typed route in. */
type RentcastByIdPath = Extract<keyof paths, `${string}{id}`>

/**
 * Typed RentCast GET for a single record by id — substitutes `{id}` into the path template so the
 * response type still comes from the matching OpenAPI entry. Same gateway, same never-throws
 * contract as `callRentcastGet`.
 */
export async function callRentcastGetById<P extends RentcastByIdPath>(
  pathTemplate: P,
  id: string,
  apiKey: string,
): Promise<{ ok: boolean; status: number | null; data: RentcastGetResult<P> | null; error: string | null }> {
  if (!apiKey || !apiKey.trim()) {
    return { ok: false, status: null, data: null, error: "RentCast apiKey is required" }
  }
  if (!id || !id.trim()) {
    return { ok: false, status: null, data: null, error: "RentCast record id is required" }
  }
  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const res = await callConnector<RentcastGetResult<P>>({
    connector: "rentcast",
    baseUrl:   "https://api.rentcast.io/v1",
    // Verbatim path, same reason as callRentcastGet above — the gateway logs
    // req.path as passed, so the ledger's endpoint vocabulary keeps its slash.
    path:      pathTemplate.replace("{id}", encodeURIComponent(id)),
    method:    "GET",
    query:     {},
    auth:      { style: "header", name: "X-Api-Key", value: apiKey },
  })
  return { ok: res.ok, status: res.status, data: res.data, error: res.error }
}
