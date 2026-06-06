// lib/property/listing-source.ts
// Pure listing-source selection — no network/server imports, so it is directly
// unit-testable (and importable from the E2E harness). Captures the contract:
// RentCast is the platform DEFAULT; a subscriber's connected IDX feed takes
// precedence when it actually returns results for the query.

export type ListingSource = "idx" | "rentcast" | "none"

/**
 * Decide which listing provider to serve a property search from.
 *   - IDX wins only when the brokerage has it connected AND it returned results
 *     (IDX is account-scoped, so an empty result falls through to RentCast).
 *   - RentCast is the default whenever it's available.
 *   - "none" when neither can serve.
 */
export function resolveListingSource(opts: {
  hasIdx: boolean
  idxResultCount: number
  hasRentcast: boolean
}): ListingSource {
  if (opts.hasIdx && opts.idxResultCount > 0) return "idx"
  if (opts.hasRentcast) return "rentcast"
  return "none"
}
