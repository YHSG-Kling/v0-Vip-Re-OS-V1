import { createServiceClient } from '@/lib/supabase/service'
import { validateWaterfall, centsToDollars, sumCents, dollarsToCents } from '../utils'
import { CURRENT_ENGINE_VERSION } from '../types'
import type { WaterfallContext, CommissionCalculationResult } from '../types'

/**
 * STEP 11: Validate & Persist
 * Validate totals match and persist to database
 * ONLY THIS STEP UPDATES DATABASE
 */
export async function validateAndPersist(
  context: WaterfallContext,
  calculationMode: 'preview' | 'final',
  triggeredBy?: string | null
): Promise<CommissionCalculationResult> {
  // Collect all distributions
  const allDistributions = [
    ...context.grossAdjustments,
    ...context.agentAdjustments,
    ...context.brokerageAdjustments,
    ...context.teamDistributions,
    ...context.revenueShareDistributions,
    ...context.feeDistributions
  ]

  // Validate waterfall
  const totalDistributedCents = sumCents([
    ...allDistributions.map(d => dollarsToCents(d.calculated_amount)),
    context.agentFinalNetCents,
    context.brokerageFinalCents
  ])
  
  const validation = validateWaterfall(context.adjustedGrossCents, totalDistributedCents)

  if (!validation.valid) {
    throw new Error(
      `[commission-engine] Waterfall validation failed. ` +
      `Gross: $${centsToDollars(context.adjustedGrossCents)}, ` +
      `Distributed: $${centsToDollars(totalDistributedCents)}, ` +
      `Difference: ${validation.difference} cents`
    )
  }

  // Preview mode - don't persist, return result
  if (calculationMode === 'preview') {
    return {
      success: true,
      preview: true,
      gross_commission: centsToDollars(context.grossCommissionCents),
      net_to_agent: centsToDollars(context.agentFinalNetCents),
      net_to_brokerage: centsToDollars(context.brokerageFinalCents),
      cap_applied: context.capApplied,
      cap_status: context.capStatus,
      total_fees: centsToDollars(context.totalFeesCents),
      distributions: [
        ...allDistributions,
        {
          distribution_type: 'agent',
          agent_id: context.agentId,
          calculation_type: 'flat',
          calculated_amount: centsToDollars(context.agentFinalNetCents),
          source_of_funds: 'brokerage',
          cap_applied: context.capApplied,
          cap_status: context.capStatus
        },
        {
          distribution_type: 'brokerage',
          calculation_type: 'flat',
          calculated_amount: centsToDollars(context.brokerageFinalCents),
          source_of_funds: 'brokerage'
        }
      ]
    }
  }

  // Final mode - persist to database
  const supabase = createServiceClient()

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
  const distributionRows = [
    ...allDistributions.map(dist => ({
      commission_id: commission.id,
      transaction_id: context.transactionId,
      brokerage_id: context.brokerageId,
      distribution_type: dist.distribution_type,
      agent_id: dist.agent_id,
      amount: dist.calculated_amount,
      source_of_funds: dist.source_of_funds,
      notes: dist.notes,
      created_at: new Date().toISOString()
    })),
    {
      commission_id: commission.id,
      transaction_id: context.transactionId,
      brokerage_id: context.brokerageId,
      distribution_type: 'agent',
      agent_id: context.agentId,
      amount: centsToDollars(context.agentFinalNetCents),
      source_of_funds: 'brokerage',
      notes: 'Agent final net',
      created_at: new Date().toISOString()
    },
    {
      commission_id: commission.id,
      transaction_id: context.transactionId,
      brokerage_id: context.brokerageId,
      distribution_type: 'brokerage',
      amount: centsToDollars(context.brokerageFinalCents),
      source_of_funds: 'brokerage',
      notes: 'Brokerage final',
      created_at: new Date().toISOString()
    }
  ]

  const { error: distributionsError } = await supabase
    .from('commission_distributions')
    .insert(distributionRows)

  if (distributionsError) {
    throw new Error(`[commission-engine] Failed to insert distributions: ${distributionsError.message}`)
  }

  // 3. Update cap tracking (fetch → add → update)
  if (context.capApplied || context.amountTowardsCap > 0) {
    const { data: capTracking } = await supabase
      .from('agent_cap_tracking')
      .select('*')
      .eq('agent_id', context.agentId)
      .eq('brokerage_id', context.brokerageId)
      .eq('is_active', true)
      .single()

    if (capTracking) {
      const newPaidToDate = capTracking.cap_paid_to_date + centsToDollars(context.amountTowardsCap)
      const isCapped = newPaidToDate >= capTracking.cap_amount

      await supabase
        .from('agent_cap_tracking')
        .update({
          cap_paid_to_date: newPaidToDate,
          is_capped: isCapped,
          updated_at: new Date().toISOString()
        })
        .eq('id', capTracking.id)
    }
  }

  // 4. Log lifecycle event
  await supabase.from('lifecycle_events').insert({
    entity_type: 'commission',
    entity_id: commission.id,
    event_type: 'commission.calculated',
    brokerage_id: context.brokerageId,
    actor_user_id: triggeredBy,
    metadata: {
      transaction_id: context.transactionId,
      calculation_version: CURRENT_ENGINE_VERSION,
      resolved_from: context.resolvedFrom,
      gross_commission: centsToDollars(context.grossCommissionCents),
      cap_applied: context.capApplied,
      cap_status: context.capStatus
    }
  })

  return {
    success: true,
    commissionId: commission.id,
    gross_commission: centsToDollars(context.grossCommissionCents),
    net_to_agent: centsToDollars(context.agentFinalNetCents),
    net_to_brokerage: centsToDollars(context.brokerageFinalCents),
    cap_applied: context.capApplied,
    cap_status: context.capStatus,
    total_fees: centsToDollars(context.totalFeesCents),
    distributions: distributionRows.map(d => ({
      distribution_type: d.distribution_type as any,
      agent_id: d.agent_id,
      calculation_type: 'flat',
      calculated_amount: d.amount,
      source_of_funds: d.source_of_funds as any,
      notes: d.notes
    }))
  }
}
