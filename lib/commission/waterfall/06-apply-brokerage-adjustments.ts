import { createServiceClient } from '@/lib/supabase/service'
import { dollarsToCents } from '../utils'
import type { WaterfallContext, DistributionRecord } from '../types'

/**
 * STEP 6: Apply Brokerage Adjustments
 * Query commission_adjustments for brokerage-side changes
 *
 * WAVE 144 (lane 144D) — the same defect stage 05 carried (see its header): every magnitude was ADDED to the brokerage's
 * portion and counted again as a distribution, so any row broke the conservation identity and a CREDIT raised the
 * brokerage's money. A CREDIT now leaves the brokerage's portion to the row's recipient (conserved); a SURCHARGE has no
 * source of funds inside the deal and is refused by name; an overdraw is refused; a refused read throws (§3).
 */
export async function applyBrokerageAdjustments(
  context: WaterfallContext
): Promise<WaterfallContext> {
  const supabase = createServiceClient()

  const { data: adjustments, error } = await supabase
    .from('commission_adjustments')
    .select('*')
    .eq('transaction_id', context.transactionId)
    .eq('applies_to', 'brokerage')
    .eq('is_active', true)

  if (error) {
    throw new Error(`[commission-engine:brokerage-adjustments] commission adjustments read refused: ${error.message}`)
  }

  if (!adjustments || adjustments.length === 0) {
    return context
  }

  let brokeragePortionCents = context.brokeragePortionCents
  const brokerageAdjustments: DistributionRecord[] = []

  for (const adj of adjustments) {
    const magnitudeCents = adj.value_type === 'flat'
      ? dollarsToCents(adj.value)
      : Math.round(context.brokeragePortionCents * (adj.value / 100))
    if (adj.direction !== 'credit') {
      throw new Error(`[commission-engine:brokerage-adjustments] brokerage-side adjustment ${adj.id} is a ${String(adj.direction)} — it has no source of funds inside the deal; record it as a gross adjustment or correct it`)
    }

    brokeragePortionCents -= magnitudeCents

    brokerageAdjustments.push({
      distribution_type: 'fee',
      calculation_type: adj.value_type,
      calculation_value: adj.value,
      calculated_amount: magnitudeCents / 100,
      source_of_funds: 'brokerage',
      rule_id: adj.id,
      notes: adj.notes
    })
  }

  if (brokeragePortionCents < 0) {
    throw new Error(`[commission-engine:brokerage-adjustments] brokerage-side adjustments on transaction ${context.transactionId} overdraw the brokerage's portion`)
  }

  return {
    ...context,
    brokeragePortionCents,
    brokerageAdjustments
  }
}
