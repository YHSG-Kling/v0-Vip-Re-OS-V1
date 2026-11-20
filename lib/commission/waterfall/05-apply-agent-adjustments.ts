import { createServiceClient } from '@/lib/supabase/service'
import { dollarsToCents } from '../utils'
import type { WaterfallContext, DistributionRecord } from '../types'

/**
 * STEP 5: Apply Agent Adjustments
 * Query commission_adjustments for agent-side changes
 *
 * WAVE 144 (lane 144D) — DIRECTION IS LOAD-BEARING HERE TOO, AND THE ROW MUST CONSERVE. commission_adjustments.value is
 * CHECKed `>= 0`; the `direction` column (credit | surcharge) says which way it moves. This stage added every magnitude to
 * the agent's portion AND counted the same magnitude as a distribution, so any row — credit or surcharge — broke stage 11's
 * identity (gross == distributed + finals) by twice its amount, and a CREDIT raised the agent's money. No writer has produced
 * an applies_to 'agent' row yet (measured live 2026-10-25: 0 rows), which is why it never surfaced.
 * NOW: a CREDIT is money leaving the agent's portion to the row's recipient — the agent's portion falls by it and the
 * distribution carries it (+, conserved). A SURCHARGE has no source of funds inside the deal (the gross is fixed by stage 03),
 * so it is REFUSED by name rather than conjured. An overdraw is refused rather than paid. A refused read throws (§3).
 * An AGENT CONCESSION (owner ruling 4) is not this row: it comes off that agent's GROSS commission at stage 03.
 */
export async function applyAgentAdjustments(
  context: WaterfallContext
): Promise<WaterfallContext> {
  const supabase = createServiceClient()

  const { data: adjustments, error } = await supabase
    .from('commission_adjustments')
    .select('*')
    .eq('transaction_id', context.transactionId)
    .eq('applies_to', 'agent')
    .eq('is_active', true)

  if (error) {
    throw new Error(`[commission-engine:agent-adjustments] commission adjustments read refused: ${error.message}`)
  }

  if (!adjustments || adjustments.length === 0) {
    return context
  }

  let agentPortionCents = context.agentPortionCents
  const agentAdjustments: DistributionRecord[] = []

  for (const adj of adjustments) {
    const magnitudeCents = adj.value_type === 'flat'
      ? dollarsToCents(adj.value)
      : Math.round(context.agentPortionCents * (adj.value / 100))
    if (adj.direction !== 'credit') {
      throw new Error(`[commission-engine:agent-adjustments] agent-side adjustment ${adj.id} is a ${String(adj.direction)} — it has no source of funds inside the deal; record it as a gross adjustment or correct it`)
    }

    agentPortionCents -= magnitudeCents

    agentAdjustments.push({
      distribution_type: 'fee',
      calculation_type: adj.value_type,
      calculation_value: adj.value,
      calculated_amount: magnitudeCents / 100,
      source_of_funds: 'agent',
      rule_id: adj.id,
      notes: adj.notes
    })
  }

  if (agentPortionCents < 0) {
    throw new Error(`[commission-engine:agent-adjustments] agent-side adjustments on transaction ${context.transactionId} overdraw the agent's portion`)
  }

  return {
    ...context,
    agentPortionCents,
    agentAdjustments
  }
}
