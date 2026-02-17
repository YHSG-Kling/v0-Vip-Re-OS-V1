import type { WaterfallContext } from '../types'

/**
 * STEP 4: Split Agent/Brokerage
 * agentPortionCents = adjustedGrossCents * (agentSplitPercent / 100)
 * brokeragePortionCents = adjustedGrossCents - agentPortionCents
 */
export function splitAgentBrokerage(
  context: WaterfallContext
): WaterfallContext {
  const agentSplitDecimal = context.agentSplitPercent / 100
  const agentPortionCents = Math.round(context.adjustedGrossCents * agentSplitDecimal)
  const brokeragePortionCents = context.adjustedGrossCents - agentPortionCents

  return {
    ...context,
    agentPortionCents,
    brokeragePortionCents
  }
}
