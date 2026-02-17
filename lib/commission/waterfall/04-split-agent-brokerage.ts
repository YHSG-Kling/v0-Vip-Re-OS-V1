import type { WaterfallContext } from '../types'

/**
 * STEP 4: Split Agent/Brokerage
 * agentPortionCents = adjustedGrossCents * (agentSplitPercent / 100)
 * brokeragePortionCents = adjustedGrossCents - agentPortionCents
 */
export function splitAgentBrokerage(
  adjustedGrossCents: number,
  agentSplitPercent: number
): Pick<WaterfallContext, 'agentPortionCents' | 'brokeragePortionCents'> {
  const agentSplitDecimal = agentSplitPercent / 100
  const agentPortionCents = Math.round(adjustedGrossCents * agentSplitDecimal)
  const brokeragePortionCents = adjustedGrossCents - agentPortionCents

  return {
    agentPortionCents,
    brokeragePortionCents
  }
}
