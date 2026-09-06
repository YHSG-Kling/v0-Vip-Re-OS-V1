/**
 * CMA COMP TYPES — the one shape every comp source normalizes into.
 *
 * Lives in its own module (rather than inside a particular finder) because the
 * CMA now has MORE THAN ONE comp source and none of them may own the type:
 *   · lib/property/rentcast.ts        — RentCast, the platform-owned default
 *   · lib/idxbroker-client.ts         — the brokerage's connected IDX feed
 *   · lib/cma/perplexity-comp-finder  — the AI web-search GAP-FILLER, reachable
 *                                       only through comp-provider and only for
 *                                       the slots providers left empty (see its
 *                                       header for the full terms)
 *
 * `ScoredComp` is re-exported from perplexity-comp-finder for the callers that
 * already import it from there, so this move is source-compatible.
 */

import type { CompFeatures } from "./state-adjustment-rates"

/**
 * Which system actually produced a comp. Carried ON the comp and on the CMA
 * result so a report can never claim a provenance it did not have.
 *
 *   idxbroker  — the brokerage's connected IDX Broker feed (ACTIVE side only:
 *                a bare IDX key cannot serve sold comparables — see
 *                lib/idxbroker-client.ts for why)
 *   rentcast   — RentCast, the platform-owned comps provider (the DEFAULT)
 *   perplexity — the AI web-search comp finder, admitted ONLY as a per-slot
 *                GAP-FILLER after every provider has been tried and only for
 *                the ACTIVE and PENDING sides. A row carrying this is
 *                UNVERIFIED and must be labelled as such wherever it is shown.
 *                It can never appear on a closed sale — see AI_GAP_FILL_SLOTS
 *                in lib/cma/comp-provider.ts for the reasoning.
 *   none       — nothing was sourced for this side
 */
export type CompProviderId = "idxbroker" | "rentcast" | "perplexity" | "none"

/**
 * What the comp's `salePrice` actually IS. A closed sale and a live list price
 * are not interchangeable and a reader must never have to guess which one they
 * are holding — that guess is how "$450,000 sold" ends up on a seller's screen
 * for a house that is still on the market.
 */
export type CompPriceBasis = "closed_sale" | "list_price"

export interface ScoredComp extends CompFeatures {
  address: string
  status: "closed" | "pending" | "active"
  daysOnMarket?: number | null
  pricePerSqft?: number | null
  /** 0..1. Provider-supplied when the provider publishes one (RentCast's
   *  `correlation`), otherwise computed deterministically from the shared
   *  attributes. Never a model's opinion for a provider-sourced comp. */
  similarityScore: number
  /** Source URL / provider attribution string, when one exists. */
  citation?: string | null
  /**
   * Straight-line distance from the subject, in miles, WHEN THE PROVIDER
   * REPORTS ONE (RentCast does; IDX does not). Null means unknown — the UI
   * shows "—", never 0.
   */
  distanceMiles?: number | null
  /** Which provider produced this row. */
  sourceProvider?: CompProviderId | null
  /**
   * Whether `salePrice` is a closed sale or a live list price. Active and
   * pending comps carry `list_price`; only `closed_sale` rows may be described
   * to a consumer as a sale.
   */
  priceBasis?: CompPriceBasis
}

/**
 * A seller-reported improvement made since they bought the home.
 *
 * Free text, by nature — this is what the SELLER says they did, in their own
 * words, and the product's store for it is `property_upgrades`
 * (writer: app/actions/intent-writers.ts logUpgrade).
 */
export interface SellerUpgrade {
  description: string
  /** What the seller says it cost. Cost is NOT value — see the note on
   *  SellerUpgradeTreatment in the orchestrator for why this never becomes a
   *  dollar adjustment on its own. */
  estimatedCost?: number | null
  /** When the seller says the work was done, as far as it is known. */
  completedOn?: string | null
}
