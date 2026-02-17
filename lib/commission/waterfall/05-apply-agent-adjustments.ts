import { getCommissionAdjustments } from '../resolve-adjustments'
import { dollarsToCents, calculatePercentCents } from '../utils'
import type { WaterfallContext, CommissionDistribution } from '../types'

/**
 * STEP 5: Apply Agent-Level Adjustments
 * Read commission_adjustments WHERE applies_to = 'agent'
 */
export async function applyAgentAdjustments(
  transactionId: string,
  agentPortionCents: number
): Promise<Pick<WaterfallContext, 'agentPortionCents' | 'agentAdjustments'>> {
  const adjustments = await getCommissionAdjustments(transactionId, 'agent')

  let adjustedAgentCents = agentPortionCents
  const agentAdjustments: CommissionDistribution[] = []

  for (const adj of adjustments) {
    let adjCents: number

    if (adj.value_type === 'percent') {
      adjCents = calculatePercentCents(agentPortionCents, adj.value)
    } else {
      adjCents = dollarsToCents(adj.value)
    }

    if (adj.direction === 'credit') {
      adjustedAgentCents -= adjCents
    } else {
      adjustedAgentCents += adjCents
    }

    agentAdjustments.push({
      distribution_type: 'adjustment',
      calculatedCents: adjCents,
      source_of_funds: 'agent',
      description: adj.description || `Agent adjustment: ${adj.value_type}`,
      adjustment_id: adj.id
    })
  }

  return {
    agentPortionCents: adjustedAgentCents,
    agentAdjustments
  }
}
