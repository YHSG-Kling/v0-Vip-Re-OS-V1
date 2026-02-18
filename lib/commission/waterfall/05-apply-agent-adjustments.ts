import { createServiceClient } from '@/lib/supabase/service'
import { dollarsToCents } from '../utils'
import type { WaterfallContext, DistributionRecord } from '../types'

/**
 * STEP 5: Apply Agent Adjustments
 * Query commission_adjustments for agent-side changes
 */
export async function applyAgentAdjustments(
  context: WaterfallContext
): Promise<WaterfallContext> {
  const supabase = createServiceClient()

  const { data: adjustments } = await supabase
    .from('commission_adjustments')
    .select('*')
    .eq('transaction_id', context.transactionId)
    .eq('applies_to', 'agent')
    .eq('is_active', true)

  if (!adjustments || adjustments.length === 0) {
    return context
  }

  let agentPortionCents = context.agentPortionCents
  const agentAdjustments: DistributionRecord[] = []

  for (const adj of adjustments) {
    const adjustmentCents = adj.value_type === 'flat'
      ? dollarsToCents(adj.value)
      : Math.round(context.agentPortionCents * (adj.value / 100))

    agentPortionCents += adjustmentCents

    agentAdjustments.push({
      distribution_type: 'fee',
      calculation_type: adj.value_type,
      calculation_value: adj.value,
      calculated_amount: adjustmentCents / 100,
      source_of_funds: 'agent',
      rule_id: adj.id,
      notes: adj.notes
    })
  }

  return {
    ...context,
    agentPortionCents,
    agentAdjustments
  }
}
