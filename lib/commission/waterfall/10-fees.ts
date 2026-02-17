import { createServiceClient } from '@/lib/supabase/service'
import { dollarsToCents, calculatePercentCents, sumCents } from '../utils'
import type { WaterfallContext, CommissionDistribution } from '../types'

/**
 * STEP 10: Fees
 * Apply transaction_fee, desk_fee, technology_fee, eo_fee
 */
export async function applyFees(
  agentId: string,
  brokerageId: string,
  agentFinalCents: number
): Promise<Pick<WaterfallContext, 'feeDistributions' | 'agentFinalNetCents' | 'totalFeesCents'>> {
  const supabase = createServiceClient()

  // Get agent commission profile for fee configuration
  const { data: profile } = await supabase
    .from('agent_commission_profiles')
    .select('*')
    .eq('agent_id', agentId)
    .eq('brokerage_id', brokerageId)
    .eq('is_active', true)
    .maybeSingle()

  if (!profile) {
    return {
      feeDistributions: [],
      agentFinalNetCents: agentFinalCents,
      totalFeesCents: 0
    }
  }

  const feeDistributions: CommissionDistribution[] = []
  const feeTypes = ['transaction_fee', 'desk_fee', 'technology_fee', 'eo_fee']

  for (const feeType of feeTypes) {
    const feeValueType = profile[`${feeType}_type`]
    const feeValue = profile[`${feeType}_value`]

    if (!feeValue || feeValue === 0) continue

    let feeCents: number

    if (feeValueType === 'flat') {
      feeCents = dollarsToCents(feeValue)
    } else {
      // percent
      feeCents = calculatePercentCents(agentFinalCents, feeValue)
    }

    feeDistributions.push({
      distribution_type: 'fee',
      calculatedCents: feeCents,
      source_of_funds: 'agent',
      description: `${feeType.replace(/_/g, ' ')}: ${feeValueType === 'flat' ? `$${feeValue}` : `${feeValue}%`}`
    })
  }

  const totalFeesCents = sumCents(feeDistributions.map(d => d.calculatedCents))
  const agentFinalNetCents = agentFinalCents - totalFeesCents

  return {
    feeDistributions,
    agentFinalNetCents,
    totalFeesCents
  }
}
