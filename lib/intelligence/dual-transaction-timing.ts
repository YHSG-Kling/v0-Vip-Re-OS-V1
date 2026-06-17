// lib/intelligence/dual-transaction-timing.ts
//
// DUAL-TRANSACTION TIMING (pure) — the move-up choreography. dual-intent-linker already establishes
// that ONE contact is BOTH a seller (selling their current home) and a buyer (buying the next), and
// surfaces the dependency. What's missing is the TIMING coordination a great team runs live: when the
// sale of the current home nears closing, the Shopping Agent must ramp the buyer search; when the
// buyer finds a home before the sale closes, it likely needs a SALE-CONTINGENT offer; when both are
// under contract, the close dates must align (or a bridge/rent-back covers the gap). This decides
// which manager-to-manager play the moment calls for, so the two sides never drift out of sync.
// Pure (no I/O), unit-tested directly; the runner publishes the coordination on the bus.

export type DualSellerStage = "listing_active" | "under_contract" | "closing_soon" | "sold" | "none"
export type DualPlay = "ramp_buyer_search" | "prep_sale_contingent_offer" | "align_close_dates" | "hold" | null
export type Mgr = "listing_concierge" | "shopping_agent"

export interface DualTxnInput {
  /** where the SELLER side (their current home) is. */
  sellerStage: DualSellerStage
  /** days until the seller's sale closes (null when not yet under contract). */
  sellerCloseInDays: number | null
  /** is the BUYER side actively touring / searching? */
  buyerActivelyShopping: boolean
  /** has the buyer written an offer on the next home? */
  buyerHasOffer: boolean
}

export interface DualTxnTiming {
  coordinate: boolean
  play: DualPlay
  from: Mgr | null
  to: Mgr | null
  reason: string
}

const RAMP_WINDOW_DAYS = 45 // start the buyer search this far out from the sale close.

/** Decide the move-up timing coordination play. Pure. */
export function planDualTransactionTiming(input: DualTxnInput): DualTxnTiming {
  const none = (reason: string): DualTxnTiming => ({ coordinate: false, play: "hold", from: null, to: null, reason })

  const underContract = input.sellerStage === "under_contract" || input.sellerStage === "closing_soon"
  const closeSoon = typeof input.sellerCloseInDays === "number" && input.sellerCloseInDays <= RAMP_WINDOW_DAYS && input.sellerCloseInDays >= 0

  // 1. Both transactions live and the sale is CLOSING → align the two close dates (or rent-back/bridge).
  if (input.sellerStage === "closing_soon" && input.buyerHasOffer) {
    return {
      coordinate: true, play: "align_close_dates", from: "shopping_agent", to: "listing_concierge",
      reason: "both transactions are live — align the close dates (or arrange a rent-back/bridge) so they're never homeless or double-paying",
    }
  }

  // 2. Sale is under contract and closing approaches, but the buyer search hasn't ramped → ramp it.
  if (underContract && closeSoon && !input.buyerActivelyShopping && !input.buyerHasOffer) {
    return {
      coordinate: true, play: "ramp_buyer_search", from: "listing_concierge", to: "shopping_agent",
      reason: `their sale closes in ${input.sellerCloseInDays}d — start the buyer search now so they're not left without a home`,
    }
  }

  // 3. Buyer is ready to offer before the sale has closed (under-contract or only listed) → the next
  //    offer likely needs a SALE-CONTINGENT structure; coordinate it + a plan to sell fast.
  if (input.buyerHasOffer && (input.sellerStage === "under_contract" || input.sellerStage === "listing_active")) {
    return {
      coordinate: true, play: "prep_sale_contingent_offer", from: "shopping_agent", to: "listing_concierge",
      reason: "the buyer is ready to offer before their sale closes — coordinate a sale-contingent structure + timing",
    }
  }

  return none("the two sides are in sync — no timing coordination needed yet")
}
