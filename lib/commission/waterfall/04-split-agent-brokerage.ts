import type { WaterfallContext } from '../types'

/**
 * STEP 4: Split Agent/Brokerage
 * splittable = adjustedGrossCents - referralDeductionCents   (wave 143: the referral fee comes off the top, step 03b)
 * agentPortionCents = splittable * (agentSplitPercent / 100)
 * brokeragePortionCents = splittable - agentPortionCents
 */
export function splitAgentBrokerage(
  context: WaterfallContext
): WaterfallContext {
  const agentSplitDecimal = context.agentSplitPercent / 100
  const splittableCents = context.adjustedGrossCents - (context.referralDeductionCents ?? 0)
  const agentPortionCents = Math.round(splittableCents * agentSplitDecimal)
  const brokeragePortionCents = splittableCents - agentPortionCents

  return {
    ...context,
    agentPortionCents,
    brokeragePortionCents
  }
}
