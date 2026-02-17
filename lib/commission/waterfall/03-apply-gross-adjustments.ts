import { getCommissionAdjustments } from '../resolve-adjustments'
import { dollarsToCents, calculatePercentCents } from '../utils'
import type { WaterfallContext, CommissionDistribution } from '../types'

/**
 * STEP 3: Apply Gross-Level Adjustments
 * Read commission_adjustments WHERE applies_to = 'gross'
 */
export async function applyGrossAdjustments(
  transactionId: string,
  grossCommissionCents: number
): Promise<Pick<WaterfallContext, 'adjustedGrossCents' | 'grossAdjustments'>> {
  const adjustments = await getCommissionAdjustments(transactionId, 'gross')

  let adjustedGrossCents = grossCommissionCents
  const grossAdjustments: CommissionDistribution[] = []

  for (const adj of adjustments) {
    let adjCents: number

    if (adj.value_type === 'percent') {
      adjCents = calculatePercentCents(grossCommissionCents, adj.value)
    } else {
      adjCents = dollarsToCents(adj.value)
    }

    if (adj.direction === 'credit') {
      adjustedGrossCents -= adjCents
    } else {
      adjustedGrossCents += adjCents
    }

    grossAdjustments.push({
      distribution_type: 'adjustment',
      calculatedCents: adjCents,
      source_of_funds: 'gross',
      description: adj.description || `Gross adjustment: ${adj.value_type}`,
      adjustment_id: adj.id
    })
  }

  return {
    adjustedGrossCents,
    grossAdjustments
  }
}
