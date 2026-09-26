/**
 * PROVIDER-SOURCED RENT — the one place a monthly-rent figure is allowed to come
 * from in this product, and the shape that makes an absent one legible.
 *
 * ─── WHY THIS MODULE EXISTS ─────────────────────────────────────────────────
 * Three surfaces showed a renter/investor a monthly rent, and not one of them
 * had asked a data provider:
 *
 *   1. lib/property/property-evaluation.ts asked an LLM for
 *      `estimatedMonthlyRent` and a `rentComps[]` array — addresses AND dollar
 *      rents, authored by a generative model, rendered on an agent-branded page
 *      under the heading "Investor Metrics". This is the same defect class the
 *      CMA lane had just removed: a model authored a price and it reached a
 *      licensed appraiser. A model that invents a rent invents the comparables
 *      that "support" it, and the failure is invisible — the addresses are real
 *      streets and the numbers are plausible.
 *
 *   2. app/actions/smart-insights.ts computed `price * 0.0085`, with `price`
 *      itself defaulting to `500000` when the property record had none. A home
 *      with no price displayed a confident "$4,250/mo", and cap rate,
 *      cash-on-cash and five-year cash flow were all computed from it.
 *
 *   3. `searchRentcastRentalListings` — the function that could have answered
 *      the question honestly — had ZERO consumers anywhere in the tree.
 *
 * ─── WHAT THIS RETURNS, AND THE THREE GUARANTEES ────────────────────────────
 * The shape is deliberately modelled on `ProviderAvmBaseline` in
 * lib/cma/comp-provider.ts, because it is the same problem with a different
 * number and the CMA lane already settled how to hold it:
 *
 *  1. IT IS LABELLED WHEREVER IT SURFACES. `kind` is a fixed discriminator and
 *     `label` is the sentence a renderer must show beside the figure. A caller
 *     cannot destructure a bare number out of this without stepping over both.
 *
 *  2. IT IS A MEASUREMENT OVER PROVIDER ROWS, NOT AN OPINION. `monthlyRent` is
 *     the MEDIAN ASKING RENT of the rental listings RentCast actually returned,
 *     and every row it was computed from is carried on `comps` so the figure can
 *     be checked rather than believed. It is not a model's estimate, it is not a
 *     percentage of a sale price, and it is not an AVM.
 *
 *  3. MISSING READS AS MISSING. `available: false` with `monthlyRent: null` and
 *     a plain-language `unavailableNote`. Never 0, never a silently omitted
 *     line, and never a substituted guess. A rent tile that quietly disappears
 *     lets a reader assume none was ever offered; a rent tile showing $0 next to
 *     a $600k home is a defect that looks like data.
 *
 * ─── PRECEDENCE AND METERING, PER THE ESTABLISHED RULES ─────────────────────
 * ELIGIBILITY IS DECIDED BEFORE ANYTHING IS SPENT. `resolveRentcastEligibility`
 * is asked FIRST — a tenant who connected their own IDX Broker account never has
 * the platform's RentCast pull issued on their behalf, and the reason is carried
 * out on `eligibilityReason` so "we deliberately did not call" is never confused
 * with "the provider was unreachable". The gate inside
 * `searchRentcastRentalListings` would refuse anyway; asking here as well is not
 * redundancy, it is how this module can SAY WHY rather than report an empty.
 *
 * EVERY CALL LANDS ON THE VENDOR LEDGER WITH A TRUTHFUL LANE. `systemSource` is
 * REQUIRED on the request — not optional, not defaulted. RentCast metering used
 * to hard-code `buyer_search` on all six readers, so a CMA comp pull and an
 * equity-trigger AVM were both filed as buyer search and the one question the
 * ledger exists to answer had a single wrong answer. A caller that cannot name
 * its lane has no business spending a tenant's RentCast budget.
 *
 * ─── WHY THIS IS NOT A `server-only` MODULE ─────────────────────────────────
 * It sits on the same footing as lib/property/rentcast.ts and
 * lib/property/rentcast-eligibility.ts, both of which are deliberately not
 * `server-only`: the proofs import these readers directly to establish that a
 * dark vendor lane RESOLVES an honest empty instead of throwing. Its privileged
 * dependencies are reached through those modules, which do their own dynamic
 * imports of the server-only pieces.
 */

import { searchRentcastRentalListings, type RentcastListing } from "./rentcast"
import {
  resolveRentcastEligibility,
  type RentcastEligibilityReason,
} from "./rentcast-eligibility"

/**
 * How many rental listings to pull. Larger than the handful shown so the median
 * is taken over a real sample; RentCast's rental endpoint defaults to 20 and the
 * client passes this straight through as `limit`.
 */
const RENTAL_PULL_LIMIT = 25

/**
 * Below this many qualifying rows the median is not reported as a rent estimate.
 *
 * ONE rental listing is not a market — it is one landlord's asking price, and
 * presenting it as "estimated rent" would restore exactly the false confidence
 * this module exists to remove. Two is the smallest sample where a median means
 * anything at all, and the sample size is reported alongside the figure either
 * way so a reader can discount a thin one themselves.
 */
export const MIN_RENT_COMPS = 2

/** The sentence that must appear beside the figure on any surface that shows it. */
export const PROVIDER_RENT_LABEL =
  "Median asking rent of comparable long-term rental listings currently published by RentCast, the platform's property-data provider. It is a measurement of what similar homes nearby are ASKING, not a projection of what this property would lease for, not an appraisal, and not a guarantee of rental income."

/** One rental listing the median was computed from. Carried so the figure can be checked. */
export interface ProviderRentComp {
  address: string
  /** Monthly asking rent. Always a positive number — rows without one are dropped. */
  monthlyRent: number
  bedrooms: number | null
  bathrooms: number | null
  squareFeet: number | null
  propertyType: string | null
  daysOnMarket: number | null
}

/**
 * WHY THERE IS NO RENT FIGURE. Never collapsed to a boolean and never collapsed
 * to a zero: "we deliberately did not call this tenant's provider", "we had no
 * city to search", "the provider answered with nothing" and "there were too few
 * listings to take a median over" are four different facts about the product.
 */
export type RentUnavailableReason =
  | "no_tenant"          // no brokerage to gate, meter or bill the call against
  | "not_eligible"       // the gate refused — `eligibilityReason` names which question said no
  | "no_locality"        // nothing to search: no city/state and no zip
  | "provider_error"     // RentCast returned non-2xx, or the request failed
  | "no_listings"        // RentCast answered and published no comparable rentals there
  | "too_few_listings"   // fewer than MIN_RENT_COMPS rows carried a usable rent

export interface ProviderRentEstimate {
  /** Fixed discriminator. Its only job is to be impossible to confuse with a
   *  model-authored or price-derived number at a call site or in a JSON blob. */
  kind: "provider_sourced_rent_comps"
  provider: "rentcast"
  /** The words that must appear beside the number on any surface that shows it. */
  label: string
  /** True only when a provider actually published enough comparable rentals. */
  available: boolean
  /** Median asking rent of `comps`. Null when unavailable — NEVER 0. */
  monthlyRent: number | null
  /** Lowest / highest asking rent in the sample. Null when unavailable. */
  rangeLow: number | null
  rangeHigh: number | null
  /** How many rental listings the median was taken over. 0 when unavailable. */
  sampleSize: number
  /** The rows themselves, so the figure can be checked rather than believed. */
  comps: ProviderRentComp[]
  /** Why there is no figure, in the surface's own words. Null when available. */
  unavailableNote: string | null
  /** Which unavailability this is. Null when available. */
  unavailableReason: RentUnavailableReason | null
  /** What the eligibility gate decided, so a caller can distinguish a deliberate
   *  suppression from an outage. Null when the gate was never reached. */
  eligibilityReason: RentcastEligibilityReason | null
}

export interface RentEstimateRequest {
  /** The tenant the call is gated and metered against. Absent → no call at all. */
  brokerageId: string | null | undefined
  /** auth users.id of the acting agent — lets the gate see an AGENT-tier IDX
   *  connection. Never substituted for agents.id. */
  agentUserId?: string | null
  teamId?: string | null
  /** Vendor-ledger attribution only. Not a credential selector, not a tenant boundary. */
  contactId?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
  /** Subject bedrooms. When known the search is narrowed to the SAME bed count —
   *  a 2-bed and a 5-bed in one median is not a comparable set. */
  bedrooms?: number | null
  /** Subject bathrooms, used as a floor only (RentCast's `bathrooms` is a range). */
  bathroomsMin?: number | null
  propertyType?: string | null
  /**
   * WHICH LANE IS SPENDING. Required, deliberately. See the header: a hard-coded
   * lane is how the vendor ledger came to have one possible answer to the only
   * question it exists to answer.
   */
  systemSource: string
}

/** Build the honest "no figure, and here is why" answer. */
function unavailable(
  reason: RentUnavailableReason,
  note: string,
  eligibilityReason: RentcastEligibilityReason | null,
): ProviderRentEstimate {
  return {
    kind: "provider_sourced_rent_comps",
    provider: "rentcast",
    label: PROVIDER_RENT_LABEL,
    available: false,
    monthlyRent: null,
    rangeLow: null,
    rangeHigh: null,
    sampleSize: 0,
    comps: [],
    unavailableNote: note,
    unavailableReason: reason,
    eligibilityReason,
  }
}

/** Median of a non-empty sorted-able list of positive numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/**
 * WHAT DO COMPARABLE HOMES NEARBY ACTUALLY RENT FOR?
 *
 * Never throws. Every failure path returns a `ProviderRentEstimate` whose
 * `available` is false and whose `unavailableNote` is a sentence a surface can
 * print verbatim. There is deliberately no branch that produces `available: true`
 * with a null or zero `monthlyRent`.
 */
export async function estimateMonthlyRentFromComps(
  req: RentEstimateRequest,
): Promise<ProviderRentEstimate> {
  // ── 1. Is there a tenant to gate, meter and bill this against? ────────────
  //
  // RentCast is platform-GATED, not merely platform-owned: no call is issued
  // without a tenant to attribute the spend to. A caller that reached here with
  // no brokerage is not "unlucky", it is asking us to spend money nobody owns.
  if (!req.brokerageId) {
    return unavailable(
      "no_tenant",
      "no brokerage could be resolved for this request, and the rental-listing provider is metered per tenant — so no rent lookup was issued. This is a wiring gap, not a statement about the local rental market.",
      null,
    )
  }

  // ── 2. MAY RENTCAST RUN FOR THIS TENANT AT ALL? Asked BEFORE any spend ────
  //
  // Same order as lib/cma/comp-provider.ts, for the same reason: the alternative
  // is deciding whether we were allowed to spend after we already had.
  const eligibility = await resolveRentcastEligibility({
    brokerageId: req.brokerageId,
    agentUserId: req.agentUserId ?? null,
    teamId: req.teamId ?? null,
  })
  if (!eligibility.eligible) {
    // The reason is stated in the surface's own words, per reason, because "no
    // rent figure" means something completely different in each case.
    const note =
      eligibility.reason === "tenant_has_idx"
        ? `No rental comparables were pulled, and that was DELIBERATE, not a failure: this brokerage has connected its own IDX Broker credentials (at ${eligibility.idxOwnerType} level), and RentCast is the platform's provider for brokerages that have not. The IDX Broker feed this product reads serves the brokerage's own featured FOR-SALE inventory and carries no rental listings, so no provider covers the rental side for this tenant. Pull rental comparables from the MLS directly.`
        : eligibility.reason === "budget_exhausted"
        ? "No rental comparables were pulled: this brokerage is over its monthly vendor budget, so the paid property-data tier is paused for the rest of the billing month. Nothing was substituted in its place."
        : eligibility.reason === "idx_check_unreadable"
        ? "No rental comparables were pulled: it could not be determined whether this brokerage has its own IDX Broker feed connected, and the platform's RentCast account is not spent on that uncertainty. This is a lookup failure, NOT a statement that no rentals exist nearby — retry before drawing any conclusion from it."
        : "No rental comparables were pulled: the platform's RentCast key is not configured, so the rental-listing lane is dark. RentCast is platform-gated — there is no tenant credential that could substitute for it."
    return unavailable("not_eligible", note, eligibility.reason)
  }

  // ── 3. Is there anywhere to search? ───────────────────────────────────────
  //
  // RentCast's rental endpoint is area-scoped. With neither a city/state pair
  // nor a zip there is no query to issue, and widening to "anywhere" would
  // produce a national median presented as this neighbourhood's rent.
  const hasLocality = !!(req.zip || (req.city && req.state))
  if (!hasLocality) {
    return unavailable(
      "no_locality",
      "no city/state or ZIP code was available for this property, and rental comparables are searched by area — so no lookup could be issued. Nothing was estimated in its place.",
      eligibility.reason,
    )
  }

  // ── 4. The pull. Metered by the reader itself, once, on the lane WE name ──
  const beds = typeof req.bedrooms === "number" && req.bedrooms > 0 ? Math.round(req.bedrooms) : null
  const search = await searchRentcastRentalListings({
    brokerageId: req.brokerageId,
    agentUserId: req.agentUserId ?? null,
    teamId: req.teamId ?? null,
    systemSource: req.systemSource,
    contactId: req.contactId ?? null,
    filters: {
      city: req.city ?? undefined,
      state: req.state ?? undefined,
      zipCode: req.zip ?? undefined,
      // SAME bed count both ends — a rental comp set that mixes a studio with a
      // five-bedroom has a median that describes neither. When the subject's bed
      // count is unknown the filter is omitted and `sampleSize` plus the note
      // below tell the reader the sample was not narrowed.
      bedroomsMin: beds ?? undefined,
      bedroomsMax: beds ?? undefined,
      bathroomsMin:
        typeof req.bathroomsMin === "number" && req.bathroomsMin > 0 ? req.bathroomsMin : undefined,
      propertyType: req.propertyType ?? undefined,
      limit: RENTAL_PULL_LIMIT,
    },
  })

  if (!search.success) {
    return unavailable(
      "provider_error",
      `the rental-listing lookup did not complete (${search.error ?? "no reason reported"}), so no rent could be read. This is a lookup failure, not a statement that the property has no rental value — retry before drawing any conclusion from its absence.`,
      eligibility.reason,
    )
  }

  // ── 5. Only rows that actually carry a rent ───────────────────────────────
  const comps: ProviderRentComp[] = search.listings
    .filter((l: RentcastListing) => typeof l.price === "number" && Number.isFinite(l.price) && l.price > 0)
    .map((l: RentcastListing) => ({
      address: l.address,
      // Non-null by the filter above; `price` on a rental row IS the monthly rent.
      monthlyRent: l.price as number,
      bedrooms: l.bedrooms,
      bathrooms: l.bathrooms,
      squareFeet: l.squareFeet,
      propertyType: l.propertyType,
      daysOnMarket: l.daysOnMarket,
    }))

  if (comps.length === 0) {
    return unavailable(
      "no_listings",
      beds != null
        ? `RentCast was queried and published no ${beds}-bedroom long-term rental listings for this area, so there is nothing to take a rent from. Nothing was estimated in its place.`
        : "RentCast was queried and published no long-term rental listings for this area, so there is nothing to take a rent from. Nothing was estimated in its place.",
      eligibility.reason,
    )
  }
  if (comps.length < MIN_RENT_COMPS) {
    return unavailable(
      "too_few_listings",
      `only ${comps.length} comparable rental listing was published for this area — one landlord's asking price is not a market rent, so no figure is shown. The listing is not reported as an estimate.`,
      eligibility.reason,
    )
  }

  const rents = comps.map((c) => c.monthlyRent)
  return {
    kind: "provider_sourced_rent_comps",
    provider: "rentcast",
    label: PROVIDER_RENT_LABEL,
    available: true,
    monthlyRent: median(rents),
    rangeLow: Math.min(...rents),
    rangeHigh: Math.max(...rents),
    sampleSize: comps.length,
    comps,
    unavailableNote: null,
    unavailableReason: null,
    eligibilityReason: eligibility.reason,
  }
}

/**
 * One sentence naming what a rent figure IS, for a surface that has room for a
 * caption rather than the full label. Includes the sample size, because "median
 * of 14 listings" and "median of 2 listings" are different claims and a surface
 * that hides the difference is doing the same job the fabricated figure did.
 */
export function rentSourceCaption(est: ProviderRentEstimate): string {
  if (!est.available) return est.unavailableNote ?? "No rental comparables were available."
  return `Median asking rent of ${est.sampleSize} comparable RentCast rental listing${
    est.sampleSize === 1 ? "" : "s"
  }${est.rangeLow != null && est.rangeHigh != null ? ` (range $${est.rangeLow.toLocaleString()}–$${est.rangeHigh.toLocaleString()}/mo)` : ""}. Asking rents, not an appraisal or a guarantee of income.`
}
