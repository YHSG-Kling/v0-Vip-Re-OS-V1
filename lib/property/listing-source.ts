// lib/property/listing-source.ts
// Pure listing-source selection — no network/server imports, so it is directly
// unit-testable (and importable from the E2E harness). Captures the contract:
// RentCast is the platform DEFAULT, and it is NOT used at all by a tenant who
// has connected their own IDX Broker credentials.

export type ListingSource = "idx" | "rentcast" | "none"

/**
 * Decide which listing provider to serve a property search from.
 *
 * OWNER RULING (verbatim): "rentcast is platform owned and should not be used if
 * the tenant adds their idx broker credentials."
 *
 * THE RULE THIS FILE USED TO ENCODE WAS THE WRONG ONE, and it was the only
 * executable precedence in the tree:
 *
 *     if (opts.hasIdx && opts.idxResultCount > 0) return "idx"
 *
 * Read the condition. IDX had to be connected AND to have ALREADY RETURNED
 * ROWS — so IDX was called first and RentCast was skipped only when IDX
 * happened to produce results for that particular query. A tenant with their
 * own feed still paid for RentCast on every search that came back thin, which
 * is exactly the case a brokerage connects IDX to fix.
 *
 * Under the ruling the rule is stronger and simpler: CONNECTION alone decides.
 *   - IDX wins whenever the tenant has connected it — whatever it returns, and
 *     whether or not it has been called yet.
 *   - RentCast serves only tenants who have NOT connected one.
 *   - "none" when neither can serve.
 *
 * An IDX feed that returns nothing for a query now yields an honest empty
 * result from the tenant's own board, not a silent fall-through to a provider
 * the owner has ruled out for them.
 */
export function resolveListingSource(opts: {
  /** Has the TENANT connected their own IDX Broker credentials? Resolved by
   *  lib/property/rentcast-eligibility.ts through the same cascade
   *  IDXBrokerClient.forBrokerage uses — a PLATFORM-tier IDX credential is the
   *  product's fallback account and is deliberately not "the tenant's". */
  hasIdx: boolean
  /** Is RentCast both available (platform key) and PERMITTED for this tenant? */
  hasRentcast: boolean
  /**
   * ACCEPTED AND IGNORED. It was the whole defect above and nothing in this
   * function may read it again.
   *
   * It is still admitted on the shape for one reason, stated so it is not
   * mistaken for indecision: `scripts/lead-flow-e2e.ts` still passes it, that
   * file is outside this slice's write scope, and removing the field would turn
   * a rule change into a type error in a file this author may not edit. The
   * field and that harness's three IDX cases are a single follow-up — see the
   * wave report's handoff list. Nothing in the app passes it any more.
   */
  idxResultCount?: number
}): ListingSource {
  if (opts.hasIdx) return "idx"
  if (opts.hasRentcast) return "rentcast"
  return "none"
}
