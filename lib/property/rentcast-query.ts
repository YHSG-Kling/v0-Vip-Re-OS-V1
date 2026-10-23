/**
 * lib/property/rentcast-query.ts — THE ONE RentCast listing-query builder (lane 91C).
 *
 * PURE: no key, no eligibility gate, no egress, no server-only import — the
 * lib/property/rentcast-normalize.ts pattern. Both listing readers in
 * lib/property/rentcast.ts (searchRentcastSaleListings,
 * searchRentcastRentalListings) build their request here, so the request SHAPE
 * — ranges, single-home mode, and the wave-91 recency window (`daysOld`, owner:
 * "we should only pull more recent data") — is provable without a network call
 * (scripts/buyer-nl-search-simulator.ts Layer 4).
 */
import { canonicalPropertyType, type PropertyType } from "@/lib/constants"
import type { RentcastSaleListingsQuery } from "@/lib/external/rentcast-typed"
import type { RentcastSearchFilters } from "./rentcast"

/** RentCast's own property-type vocabulary, as the generated query type spells it. */
type RentcastQueryPropertyType = NonNullable<NonNullable<RentcastSaleListingsQuery>["propertyType"]>

/**
 * OUR canonical property-type spellings → RENTCAST's (§6 — two vocabularies, one translator).
 *
 * The defect this closes was already named at lib/property-alerts/idx-alert-search.ts:343: an
 * untranslated canonical value ("single_family") sent as a provider filter returns an empty page
 * indistinguishable from "no homes". That lane's answer was to stop sending the filter; the other
 * callers (external-listings-search, rent-estimate) kept sending the untranslated string. Now the
 * query object is TYPED to RentCast's union, so the translation is forced to happen — here, at
 * the vendor boundary, never as a cast.
 *
 * `commercial` and `other` are deliberately absent: RentCast has no equivalent filter value, and
 * a wrong guess narrows the search to the wrong homes. Absent → the filter is OMITTED, which is
 * the same honest fallback idx-alert-search chose.
 */
const RENTCAST_PROPERTY_TYPE: Partial<Record<PropertyType, RentcastQueryPropertyType>> = {
  single_family: "Single Family",
  condo:         "Condo",
  townhouse:     "Townhouse",
  multi_family:  "Multi-Family",
  land:          "Land",
}

/** Narrow ANY caller-held property-type string to RentCast's vocabulary, or undefined (= omit
 *  the filter). Accepts display spellings too — canonicalPropertyType absorbs those first. */
function toRentcastPropertyType(raw: string | null | undefined): RentcastQueryPropertyType | undefined {
  const canonical = canonicalPropertyType(raw)
  return canonical ? RENTCAST_PROPERTY_TYPE[canonical] : undefined
}

/** RentCast's per-request listing ceiling (spec: `limit` "between 1 and 500"). */
export const RENTCAST_MAX_LISTINGS_PER_REQUEST = 500

/**
 * RentCast's `daysOld` range for a recency window, or undefined when the
 * window is absent/garbage. PURE. The spec states a minimum of 1, so a window
 * below 1 day is floored to 1 rather than sent as a range RentCast rejects.
 */
function rentcastDaysOldRange(listedWithinDays: number | null | undefined): string | undefined {
  if (listedWithinDays == null || !Number.isFinite(listedWithinDays)) return undefined
  const days = Math.max(1, Math.ceil(listedWithinDays))
  return `*:${days}`
}

/**
 * THE ONE AREA-QUERY BUILDER for both listing readers (sale + rental). PURE —
 * no key, no gate, no egress — so the request SHAPE is provable without a
 * network call (scripts/buyer-nl-search-simulator.ts, Layer 3).
 *
 * WHY ONE BUILDER (§6). The two readers each carried their own copy of this
 * block, and the copies had already drifted: the rental copy honoured a
 * max-only bedroom filter (`*:N`) and the sale copy silently dropped it. The
 * recency window below is exactly the kind of parameter that would land on one
 * copy and not the other. Differences that ARE real stay parameters: the
 * default page size per endpoint, and "Land" (a valid sale filter, meaningless
 * on the long-term rental endpoint).
 */
export function buildRentcastListingQuery(
  f: RentcastSearchFilters,
  opts: { defaultLimit: number; endpoint: "sale" | "rental" },
): NonNullable<RentcastSaleListingsQuery> {
  // A SINGLE-HOME LOOKUP IS ITS OWN QUERY MODE, not one more filter — see the
  // readers' notes: the documented shape is the address and NOTHING else.
  if (f.address) return { address: f.address }
  // Wave 92 (lane 92B) — RentCast's documented page bound: `limit` is 1..500 per request (spec:
  // "between 1 and 500"). A caller asking for more is CLAMPED here (one billed request returns at
  // most 500 rows; a larger ask is paginated by the caller with `offset`), never sent as a value
  // the provider rejects. `offset` is the provider's own pagination index.
  const q: NonNullable<RentcastSaleListingsQuery> = {
    status: f.status ?? "Active",
    limit: Math.min(RENTCAST_MAX_LISTINGS_PER_REQUEST, Math.max(1, Math.floor(f.limit ?? opts.defaultLimit))),
  }
  if (f.offset != null && Number.isFinite(f.offset) && f.offset > 0) q.offset = Math.floor(f.offset)
  if (f.city) q.city = f.city
  if (f.state) q.state = f.state
  if (f.zipCode) q.zipCode = f.zipCode
  // MCP-verified contract: bedrooms/bathrooms/price are RANGE params — a plain
  // "3" means EXACTLY 3 (a 3+ buyer would silently lose 4-bed homes); the min-
  // only form is "3:*". Price has no minPrice/maxPrice — one `price=min:max`.
  if (f.bedroomsMin != null && f.bedroomsMax != null) q.bedrooms = `${f.bedroomsMin}:${f.bedroomsMax}`
  else if (f.bedroomsMin != null) q.bedrooms = `${f.bedroomsMin}:*`
  else if (f.bedroomsMax != null) q.bedrooms = `*:${f.bedroomsMax}`
  if (f.bathroomsMin != null) q.bathrooms = `${f.bathroomsMin}:*`
  if (f.priceMin != null && f.priceMax != null) q.price = `${f.priceMin}:${f.priceMax}`
  else if (f.priceMin != null) q.price = `${f.priceMin}:*`
  else if (f.priceMax != null) q.price = `*:${f.priceMax}`
  const pt = toRentcastPropertyType(f.propertyType)
  // "Land" is a valid SALE filter but not a rental one (there is no such thing as a long-term
  // land rental on this endpoint) — omitted rather than guessed into a different type.
  if (pt && !(opts.endpoint === "rental" && pt === "Land")) q.propertyType = pt
  const daysOld = rentcastDaysOldRange(f.listedWithinDays)
  if (daysOld) q.daysOld = daysOld
  return q
}
