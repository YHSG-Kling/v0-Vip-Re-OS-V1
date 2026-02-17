import { createServiceClient } from '@/lib/supabase/service'
import { validateWaterfall, centsToDollars, sumCents } from '../utils'
import { CURRENT_ENGINE_VERSION } from '../types'
import type { WaterfallContext } from '../types'

/**
 * STEP 11: Validate & Persist
 * Validate totals match and persist to database
 */
export async function validateAndPersist(
  context: WaterfallContext,
  calculationMode: 'preview' | 'final' = 'final',
  triggeredBy?: string
): Promise<void> {
  const supabase = createServiceClient()

  // Collect all distributions
  const allDistributions = [
    ...context.grossAdjustments,
    ...context.agentAdjustments,
    ...context.brokerageAdjustments,
    ...context.teamDistributions,
    ...context.revenueShareDistributions,
    ...context.feeDistributions,
    {
      distribution_type: 'agent' as const,
      agent_id: context.agentId,
      calculatedCents: context.agentFinalNetCents,
      source_of_funds: 'agent' as const,
      description: 'Agent final net'
    },
    {
      distribution_type: 'brokerage' as const,
      calculatedCents: context.brokerageFinalCents,
      source_of_funds: 'brokerage' as const,
      description: 'Brokerage final'
    }
  ]

  // Validate waterfall
  const totalDistributedCents = sumCents(allDistributions.map(d => d.calculatedCents))
  const validation = validateWaterfall(context.adjustedGrossCents, totalDistributedCents)

  if (!validation.valid) {
    throw new Error(
      `[commission-engine] Waterfall validation failed. ` +
      `Gross: $${centsToDollars(context.adjustedGrossCents)}, ` +
      `Distributed: $${centsToDollars(totalDistributedCents)}, ` +
      `Difference: ${validation.difference} cents`
    )
  }

  // Preview mode - don't persist
  if (calculationMode === 'preview') {
    return
  }

  // Persist to database
  // 1. Insert summary into commissions table
  const { data: commission, error: commissionError } = await supabase
    .from('commissions')
    .insert({
      transaction_id: context.transactionId,
      brokerage_id: context.brokerageId,
      agent_id: context.agentId,
      gross_commission: centsToDollars(context.grossCommissionCents),
      agent_commission: centsToDollars(context.agentFinalNetCents),
      brokerage_commission: centsToDollars(context.brokerageFinalCents),
      calculation_version: CURRENT_ENGINE_VERSION,
      created_at: new Date().toISOString()
    })
    .select()
    .single()

  if (commissionError || !commission) {
    throw new Error(`[commission-engine] Failed to insert commission summary: ${commissionError?.message}`)
  }

  // 2. Insert detailed distributions
  const distributionRows = allDistributions.map(dist => ({
    commission_id: commission.id,
    transaction_id: context.transactionId,
    brokerage_id: context.brokerageId,
    distribution_type: dist.distribution_type,
    agent_id: dist.agent_id,
    amount: centsToDollars(dist.calculatedCents),
    source_of_funds: dist.source_of_funds,
    description: dist.description,
    adjustment_id: dist.adjustment_id,
    created_at: new Date().toISOString()
  }))

  const { error: distributionsError } = await supabase
    .from('commission_distributions')
    .insert(distributionRows)

  if (distributionsError) {
    throw new Error(`[commission-engine] Failed to insert distributions: ${distributionsError.message}`)
  }

  // 3. Log lifecycle event
  const { data: userData } = await supabase.auth.getUser()

  await supabase.from('lifecycle_events').insert({
    entity_type: 'commission',
    entity_id: commission.id,
    event_type: 'commission.calculated',
    brokerage_id: context.brokerageId,
    actor_user_id: triggeredBy || userData.user?.id,
    metadata: {
      transaction_id: context.transactionId,
      calculation_version: CURRENT_ENGINE_VERSION,
      resolved_from: context.resolvedFrom,
      gross_commission: centsToDollars(context.grossCommissionCents),
      cap_applied: context.capApplied,
      cap_status: context.capStatus
    }
  })
}
