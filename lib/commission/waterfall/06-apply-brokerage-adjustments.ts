import { getCommissionAdjustments } from '../resolve-adjustments'
import { dollarsToCents, calculatePercentCents } from '../utils'
import type { WaterfallContext, CommissionDistribution } from '../types'

/**
 * STEP 6: Apply Brokerage-Level Adjustments
 * Read commission_adjustments WHERE applies_to = 'brokerage'
 */
export async function applyBrokerageAdjustments(
  transactionId: string,
  brokeragePortionCents: number
): Promise<Pick<WaterfallContext, 'brokeragePortionCents' | 'brokerageAdjustments'>> {
  const adjustments = await getCommissionAdjustments(transactionId, 'brokerage')

  let adjustedBrokerageCents = brokeragePortionCents
  const brokerageAdjustments: CommissionDistribution[] = []

  for (const adj of adjustments) {
    let adjCents: number

    if (adj.value_type === 'percent') {
      adjCents = calculatePercentCents(brokeragePortionCents, adj.value)
    } else {
      adjCents = dollarsToCents(adj.value)
    }

    if (adj.direction === 'credit') {
      adjustedBrokerageCents -= adjCents
    } else {
      adjustedBrokerageCents += adjCents
    }

    brokerageAdjustments.push({
      distribution_type: 'adjustment',
      calculatedCents: adjCents,
      source_of_funds: 'brokerage',
      description: adj.description || `Brokerage adjustment: ${adj.value_type}`,
      adjustment_id: adj.id
    })
  }

  return {
    brokeragePortionCents: adjustedBrokerageCents,
    brokerageAdjustments
  }
}
