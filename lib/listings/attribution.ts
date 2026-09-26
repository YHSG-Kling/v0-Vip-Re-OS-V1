/**
 * LISTING ATTRIBUTION — the one sentence every RentCast-fed (or IDX-fed) listing
 * display must carry.
 *
 * Owner ruling (wave 70, verbatim): "the settings page needs to not say
 * otherwise platforms rentcast feed just platform feed but rentcast i know
 * legally when we display a listing it must say provided from rentcast, etc."
 *
 * Two separate obligations in one sentence, and this file is the SECOND half:
 *   1. The tenant SETTINGS surface never names RentCast to the tenant — it is
 *      the platform's own credential, so the tenant-facing copy says "platform
 *      feed" (see app/dashboard/settings/integrations/lead-sources/).
 *   2. EVERY surface that actually DISPLAYS a RentCast-fed listing to a person
 *      — a buyer, a seller, a lead — carries the words "Listing data provided
 *      by RentCast", because that is a legal attribution requirement on the
 *      data itself, independent of who paid for the API call.
 *
 * RentCast's own attribution/Terms-of-Use page could not be fetched at the
 * time of writing (CRAWL_NOT_FOUND against developers.rentcast.io's ToU/
 * attribution path) — the wording above is the owner's own stated requirement,
 * used verbatim rather than guessed at from a page that would not resolve.
 *
 * RESOLVED (lane 76C, 2026-09-18): https://www.rentcast.io/terms fetched live
 * — it is RentCast's platform Terms of Use ("end user software license
 * agreement … created and maintained by Fortnoff Financial LLC"). It is a
 * TERMS page, not a dedicated attribution clause: §3.3 ("Our Marks") reserves
 * RentCast's trademarks, so the attribution line links to the terms as the
 * governing document rather than restating them. Every rendered RentCast
 * attribution now carries that link (RENTCAST_TERMS_URL / listingAttributionHref
 * below, <ListingAttribution />); the wording itself stays the owner's.
 *
 * IDX BOARD WORDING: this codebase stores no per-board MLS name anywhere —
 * checked first (scripts/schema-snapshot.ts): brokerage_settings carries only
 * `idx_api_key`, no board_name/mls_board column, and lib/idxbroker-client.ts
 * exposes no board-name field either. There is therefore no specific credential
 * to read a board name FROM, so the IDX line below is the generic, defensible
 * "courtesy of" wording every MLS's own IDX rules require at minimum, rather
 * than a fabricated board name.
 *
 * `ListingAttributionSource` intentionally matches the vocabularies already in
 * force elsewhere rather than inventing a fourth: lib/buyer-search/search-
 * engine.ts's `BuyerSearchResult.source` ('platform' | 'rentcast' | 'idx') and
 * lib/cma/comp-types.ts's `CompProviderId` ('idxbroker' | 'rentcast' |
 * 'batchdata' | 'perplexity' | 'none') both collapse onto it below.
 */

export type ListingAttributionSource =
  | "platform"
  | "rentcast"
  | "idx"
  | "idxbroker"
  | "batchdata"
  | "perplexity"
  | "own"
  | "none"
  | null
  | undefined

const RENTCAST_ATTRIBUTION = "Listing data provided by RentCast"
/** RentCast's governing Terms of Use — verified live 2026-09-18 (see header).
 *  ONE constant (§6); every rendered RentCast attribution links here. */
export const RENTCAST_TERMS_URL = "https://www.rentcast.io/terms"

/**
 * The link an attribution line should carry, or null when the source has no
 * published terms page this codebase has verified (IDX boards differ per MLS;
 * BatchData/Perplexity comps are labelled, not linked). Kept beside
 * listingAttributionLine so wording and link never drift apart.
 */
export function listingAttributionHref(source: ListingAttributionSource): string | null {
  return source === "rentcast" ? RENTCAST_TERMS_URL : null
}
/** No per-board name is stored anywhere in this codebase — see file header. */
const IDX_ATTRIBUTION = "Listing courtesy of the local MLS via IDX"
/**
 * BatchData comps feed the CMA's adjustment grid, not a listing display —
 * carried here so a caller that DOES surface a BatchData-sourced comp row
 * (e.g. the CMA report's comp table) has a defensible line rather than none.
 */
const BATCHDATA_ATTRIBUTION = "Comparable data provided by BatchData"
/** Perplexity gap-fill rows are already labelled UNVERIFIED elsewhere
 *  (lib/cma/comp-provider.ts AI_GAP_FILL_SLOTS); this line is the short form
 *  for a surface with room for one sentence, not a replacement for that label. */
const PERPLEXITY_ATTRIBUTION = "Sourced by AI web search (Perplexity) — unverified"

/**
 * THE ONE FUNCTION. Returns "" for the platform's own listings/comps (an
 * empty attribution line renders as nothing, deliberately — an own listing
 * needs no third-party credit) and the exact required sentence for anything
 * RentCast-, IDX-, BatchData- or Perplexity-fed.
 */
export function listingAttributionLine(source: ListingAttributionSource): string {
  switch (source) {
    case "rentcast":
      return RENTCAST_ATTRIBUTION
    case "idx":
    case "idxbroker":
      return IDX_ATTRIBUTION
    case "batchdata":
      return BATCHDATA_ATTRIBUTION
    case "perplexity":
      return PERPLEXITY_ATTRIBUTION
    case "platform":
    case "own":
    case "none":
    case null:
    case undefined:
    default:
      return ""
  }
}
