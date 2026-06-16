// lib/intelligence/inbound-seller-intent.ts
//
// INBOUND SELLER-INTENT (pure) — a homeowner who asks "what's my home worth" (a home-value tool or a
// home-valuation lead magnet) is making the single strongest INBOUND seller-intent signal in real
// estate. Today those captures create a contact and notify the agent, then sit there. This decides
// when that inbound intent is strong enough to ENGAGE the Listing Concierge — so the team responds
// like a human listing lead would: a precise CMA + a gated "thinking of selling?" follow-up, instead
// of a lead rotting in an inbox. Distinct from the OUTBOUND scraped seller_intent_hot (raw leads);
// this is contact-backed and inbound. Pure (no I/O), unit-tested directly.

export interface InboundSellerIntentInput {
  /** the capture source — e.g. "home_value_tool", "lead_magnet:home_valuation". */
  source: string
  /** did they give us a property address (the home they're asking about)? */
  hasPropertyAddress: boolean
  /** the AVM estimate shown, if any. */
  estimatedValue: number | null
  /** TCPA/marketing consent captured at the form. */
  consent: boolean
}

export interface InboundSellerIntent {
  /** should the Listing Concierge be engaged? */
  engage: boolean
  /** home-value requests are hot seller intent; a soft magnet without property is warm. */
  intentStrength: "hot" | "warm"
  reason: string
}

const HOME_VALUE_SOURCE = /home.?value|valuation|what.?s.?my.?home/i

/** Classify an inbound capture's seller intent and whether to engage the Listing Concierge. Pure. */
export function classifyInboundSellerIntent(input: InboundSellerIntentInput): InboundSellerIntent {
  const isValuation = HOME_VALUE_SOURCE.test(input.source ?? "")

  // A home-value / valuation request WITH a property address is hot seller intent — engage.
  if (isValuation && input.hasPropertyAddress) {
    return { engage: true, intentStrength: "hot", reason: "asked for their home's value on a specific property — strong inbound seller intent" }
  }
  // A valuation source without a property address is still warm seller intent — engage lightly.
  if (isValuation) {
    return { engage: true, intentStrength: "warm", reason: "requested a home value (no specific address) — warm seller intent" }
  }
  // A non-valuation magnet (buyer guide, etc.) isn't seller intent — don't engage the listing side.
  return { engage: false, intentStrength: "warm", reason: "not a seller-intent capture — no Listing Concierge engagement" }
}
