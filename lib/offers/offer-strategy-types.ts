// lib/offers/offer-strategy-types.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE types + schema + summary for the buyer offer-strategy plan. Split out from the
// advisor (which imports the server-only AI gateway) so the schema, type, and the
// agent-facing summary are importable from pure/test contexts without dragging server-only.

import { z } from "zod"

export const BuyerOfferStrategySchema = z.object({
  recommendedOfferPrice: z.number(),
  priceRangeLow: z.number(),
  priceRangeHigh: z.number(),
  winProbability: z.number().min(0).max(100),
  strategy: z.enum(["aggressive", "competitive", "conservative"]),
  reasoning: z.string(),
  escalationRecommendation: z.object({
    recommended: z.boolean(),
    suggestedMax: z.number().nullable(),
    suggestedIncrement: z.number().nullable(),
    reasoning: z.string(),
  }),
  contingencyStrategy: z.object({
    inspection: z.enum(["full", "limited", "waive"]),
    appraisal: z.enum(["full", "gap_coverage", "waive"]),
    financing: z.enum(["full", "shortened", "waive"]),
    reasoning: z.string(),
  }),
  earnestMoneyRecommendation: z.object({
    amount: z.number(),
    percentage: z.number(),
    reasoning: z.string(),
  }),
  closeDateStrategy: z.string(),
  personalLetterRecommendation: z.boolean(),
  additionalSuggestions: z.array(z.string()),
})

export type BuyerOfferStrategy = z.infer<typeof BuyerOfferStrategySchema>

export interface BuyerOfferStrategyInput {
  listPrice: number
  daysOnMarket: number
  competingOffers?: number
  marketConditions: "hot" | "balanced" | "cooling"
  buyerMotivation: "must_have" | "would_like" | "nice_to_have"
  buyerMaxBudget: number
}

/** PURE. The agent-facing one-line summary of the strategy (the concrete plan, at a glance). */
export function summarizeOfferStrategy(s: BuyerOfferStrategy): string {
  const money = (n: number) => `$${Math.round(n).toLocaleString()}`
  return (
    `Recommended offer ${money(s.recommendedOfferPrice)} (range ${money(s.priceRangeLow)}–${money(s.priceRangeHigh)}), ` +
    `${s.strategy}, ~${Math.round(s.winProbability)}% win. ` +
    `Earnest ${money(s.earnestMoneyRecommendation.amount)} (${s.earnestMoneyRecommendation.percentage}%). ` +
    `Contingencies — inspection: ${s.contingencyStrategy.inspection}, appraisal: ${s.contingencyStrategy.appraisal}, financing: ${s.contingencyStrategy.financing}. ` +
    (s.escalationRecommendation.recommended && s.escalationRecommendation.suggestedMax
      ? `Escalate to ${money(s.escalationRecommendation.suggestedMax)} in ${s.escalationRecommendation.suggestedIncrement ? money(s.escalationRecommendation.suggestedIncrement) : "set"} steps.`
      : "No escalation.")
  )
}
