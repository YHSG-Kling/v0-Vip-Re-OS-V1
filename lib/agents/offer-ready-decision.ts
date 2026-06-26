// lib/agents/offer-ready-decision.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE decision for the autonomous offer trigger — split from the server-only runner so it is
// importable from pure/test contexts. A buyer is "offer-ready" only when ALL THREE signals hold.

/** Days within which a saved target still counts as "active shopping" intent. */
export const OFFER_READY_TARGET_WINDOW_DAYS = 45

export interface OfferReadyInput {
  /** Pre-approval amount on file (> 0 = financially serious). */
  preApprovalAmount: number | null | undefined
  /** Has a non-dismissed saved target (in-house or external) with a price, saved recently. */
  hasRecentActiveTarget: boolean
  /** Already has any offer on record for this buyer (then they're past this moment). */
  hasOpenOrPastOffer: boolean
}

export interface OfferReadyDecision {
  ready: boolean
  reason: string
}

/**
 * isOfferReady — PURE. A buyer is at the offer moment when they're financially ready
 * (pre-approved) AND actively zeroed in on a property (a fresh saved target) AND haven't already
 * written an offer. All three must hold — pre-approval alone or a casual save is not "ready."
 */
export function isOfferReady(input: OfferReadyInput): OfferReadyDecision {
  if (input.hasOpenOrPastOffer) return { ready: false, reason: "already has an offer on record" }
  if (!(typeof input.preApprovalAmount === "number" && input.preApprovalAmount > 0))
    return { ready: false, reason: "not pre-approved" }
  if (!input.hasRecentActiveTarget) return { ready: false, reason: "no fresh active saved target" }
  return { ready: true, reason: "pre-approved + fresh saved target + no offer yet" }
}
