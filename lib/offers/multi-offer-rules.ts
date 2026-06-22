// lib/offers/multi-offer-rules.ts
// PURE multi-offer governance rules (System 7.1A Domain 2). Extracted from
// app/actions/buyer-offer/handle-multi-offer.ts so the limit logic is unit-testable
// and identical between the action and the UI banner.

/** A buyer may hold at most this many PENDING offers at once (state-corruption guard). */
export const MAX_PENDING_OFFERS = 3

export interface OfferLimitVerdict {
  can_submit: boolean
  reason?: string
}

/** Can the buyer submit another offer given their current pending count? */
export function evaluateOfferLimit(pendingCount: number): OfferLimitVerdict {
  if (pendingCount >= MAX_PENDING_OFFERS) {
    return { can_submit: false, reason: `Maximum ${MAX_PENDING_OFFERS} pending offers reached` }
  }
  return { can_submit: true }
}

export type LimitProximity = "clear" | "approaching" | "at_limit"

/** UI severity for the buyer's offers banner: at the cap, one away, or clear. */
export function limitProximity(pendingCount: number): LimitProximity {
  if (pendingCount >= MAX_PENDING_OFFERS) return "at_limit"
  if (pendingCount === MAX_PENDING_OFFERS - 1) return "approaching"
  return "clear"
}
