// lib/seller-equity/equity-estimate.ts
// ─────────────────────────────────────────────────────────────────────────────
// SELLER EQUITY & NET-PROCEEDS ESTIMATE — the seller-side analogue of the buyer's affordability tool,
// and the #1 thing sellers ask for (RealScout/Fello wishlist): not just a top-line value, but
// "after my mortgage payoff and selling costs, what do I actually WALK AWAY WITH?". PURE math + warm,
// them-first framing. NO new commission math — REUSES computeNetProceeds (lib/offers/net-sheet-calc),
// the single source of truth the interactive net sheet + multi-offer comparison already use, fed an
// AVM-estimated value instead of an offer price. Honest: when the mortgage balance isn't on file we
// show GROSS equity and invite the seller to add it, never a fabricated payoff.

import { computeNetProceeds } from "@/lib/offers/net-sheet-calc"

/** Standard seller-cost assumptions as a fraction of value (editable starting points, not invented data). */
export const DEFAULT_COMMISSION_RATE = 0.06
export const DEFAULT_TAX_RATE = 0.005       // county/city transfer + prorations
export const DEFAULT_OTHER_COST_RATE = 0.01 // title, escrow, attorney, misc prorations

export interface SellerEquityInput {
  /** AVM / list-price estimated value of the home (required). */
  estimatedValue: number
  /** The seller's remaining mortgage balance — null when not on file (we then show gross only). */
  mortgageBalance: number | null
  /** Commission as a decimal (default 6%). */
  commissionRate?: number
  /** Monthly HOA dues, if any (prorated). */
  hoaDuesMonthly?: number | null
}

export interface SellerEquityEstimate {
  estimatedValue: number
  mortgageBalance: number | null
  /** value − mortgage balance (the simple "what I own"). */
  grossEquity: number | null
  /** commission + taxes + HOA proration + other costs. */
  sellingCosts: number
  /** value − selling costs − mortgage payoff = what the seller actually keeps (null until balance known). */
  netProceeds: number | null
  breakdown: { commission: number; taxes: number; hoa: number; other: number; mortgagePayoff: number | null }
  /** false when mortgageBalance is null — the UI invites the seller to add it for a true net. */
  mortgageKnown: boolean
}

/** PURE. Estimate a seller's equity + net proceeds. Reuses the canonical net-proceeds math. */
export function estimateSellerNetProceeds(input: SellerEquityInput): SellerEquityEstimate {
  const value = Math.max(0, input.estimatedValue || 0)
  const commissionRate = input.commissionRate ?? DEFAULT_COMMISSION_RATE
  const commission = Math.round(value * commissionRate)
  const taxes = Math.round(value * DEFAULT_TAX_RATE)
  const hoa = input.hoaDuesMonthly ? Math.round(input.hoaDuesMonthly) : 0
  const other = Math.round(value * DEFAULT_OTHER_COST_RATE)
  const sellingCosts = commission + taxes + hoa + other
  const mortgageKnown = input.mortgageBalance !== null && input.mortgageBalance !== undefined
  const payoff = mortgageKnown ? Math.max(0, input.mortgageBalance as number) : null

  // REUSE the single source of truth: net = value − commission − payoff − taxes − HOA − other
  // (no buyer closing credit on a pre-listing estimate).
  const netProceeds = mortgageKnown
    ? Math.round(computeNetProceeds(
        { offerPrice: value, buyerClosingCredit: 0 },
        // transactionFee 0: a pre-listing equity estimate has no brokerage
        // transaction fee yet — no listing agreement exists to set one.
        { commissionRate, mortgagePayoff: payoff as number, countyCityTaxes: taxes, hoaDuesProration: hoa, otherProratedFees: other, transactionFee: 0 },
      ))
    : null

  return {
    estimatedValue: value,
    mortgageBalance: payoff,
    grossEquity: mortgageKnown ? value - (payoff as number) : null,
    sellingCosts,
    netProceeds,
    breakdown: { commission, taxes, hoa, other, mortgagePayoff: payoff },
    mortgageKnown,
  }
}

export interface ClientEquityFraming {
  /** Warm headline the seller sees. */
  label: string
  tone: "good" | "neutral"
  /** Confidence-building line that routes to the agent (the precise strategy stays with them). */
  line: string
}

/**
 * clientEquityFraming — PURE. The them-first layer: a seller should see possibility, not a cold number.
 * When we know the net, celebrate it warmly; when we don't, invite them to complete the picture with
 * their agent. Never alarming, always a reason to talk to the agent (who maps the real strategy).
 */
export function clientEquityFraming(est: SellerEquityEstimate): ClientEquityFraming {
  if (est.mortgageKnown && est.netProceeds !== null) {
    if (est.netProceeds > 0) {
      return { label: "Here's what you'd walk away with", tone: "good",
        line: "A real estimate of your net proceeds after costs — your agent can fine-tune it and map your next move." }
    }
    return { label: "Let's map your options together", tone: "neutral",
      line: "The numbers are tight at today's value — your agent can walk through timing, improvements, and strategy to get you where you want to be." }
  }
  return { label: "Add your mortgage balance for your true net", tone: "neutral",
    line: "We've estimated your home's value and selling costs — add your remaining mortgage and we'll show exactly what you'd keep." }
}
