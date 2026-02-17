import { createServiceClient } from '@/lib/supabase/service'
import { dollarsToCents } from '../utils'
import type { WaterfallContext, DistributionRecord } from '../types'

/**
 * STEP 6: Apply Brokerage Adjustments
 * Query commission_adjustments for brokerage-side changes
 */
export async function applyBrokerageAdjustments(
  context: WaterfallContext
): Promise<WaterfallContext> {
  const supabase = createServiceClient()

  const { data: adjustments } = await supabase
    .from('commission_adjustments')
    .select('*')
    .eq('transaction_id', context.transactionId)
    .eq('applies_to', 'brokerage')
    .eq('is_active', true)

  if (!adjustments || adjustments.length === 0) {
    return context
  }

  let brokeragePortionCents = context.brokeragePortionCents
  const brokerageAdjustments: DistributionRecord[] = []

  for (const adj of adjustments) {
    const adjustmentCents = adj.adjustment_type === 'flat'
      ? dollarsToCents(adj.adjustment_value)
      : Math.round(context.brokeragePortionCents * (adj.adjustment_value / 100))

    brokeragePortionCents += adjustmentCents

    brokerageAdjustments.push({
      distribution_type: 'fee',
      calculation_type: adj.adjustment_type,
      calculation_value: adj.adjustment_value,
      calculated_amount: adjustmentCents / 100,
      source_of_funds: 'brokerage',
      rule_id: adj.id,
      notes: adj.reason
    })
  }

  return {
    ...context,
    brokeragePortionCents,
    brokerageAdjustments
  }
}
