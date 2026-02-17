import { getDefaultCommissionStructure } from '@/lib/brokerage/get-default-commission-structure'
import { dollarsToCents } from '../utils'
import type { WaterfallContext, DistributionRecord } from '../types'

/**
 * STEP 10: Fees
 * Apply transaction fee, desk fee, tech fee, E&O fee from commission structure
 */
export async function applyFees(
  context: WaterfallContext
): Promise<WaterfallContext> {
  const structure = await getDefaultCommissionStructure(
    context.brokerageId,
    context.agentId
  )

  const feeDistributions: DistributionRecord[] = []
  let totalFeesCents = 0

  // Transaction fee
  if (structure.transactionFeeValue > 0) {
    const feeCents = structure.transactionFeeType === 'flat'
      ? dollarsToCents(structure.transactionFeeValue)
      : Math.round(context.agentNetCents * (structure.transactionFeeValue / 100))
    
    totalFeesCents += feeCents
    feeDistributions.push({
      distribution_type: 'fee',
      calculation_type: structure.transactionFeeType,
      calculation_value: structure.transactionFeeValue,
      calculated_amount: feeCents / 100,
      source_of_funds: 'agent',
      notes: 'Transaction fee'
    })
  }

  // Desk fee
  if (structure.deskFeeValue > 0) {
    const feeCents = structure.deskFeeType === 'flat'
      ? dollarsToCents(structure.deskFeeValue)
      : Math.round(context.agentNetCents * (structure.deskFeeValue / 100))
    
    totalFeesCents += feeCents
    feeDistributions.push({
      distribution_type: 'fee',
      calculation_type: structure.deskFeeType,
      calculation_value: structure.deskFeeValue,
      calculated_amount: feeCents / 100,
      source_of_funds: 'agent',
      notes: 'Desk fee'
    })
  }

  // Technology fee
  if (structure.technologyFeeValue > 0) {
    const feeCents = structure.technologyFeeType === 'flat'
      ? dollarsToCents(structure.technologyFeeValue)
      : Math.round(context.agentNetCents * (structure.technologyFeeValue / 100))
    
    totalFeesCents += feeCents
    feeDistributions.push({
      distribution_type: 'fee',
      calculation_type: structure.technologyFeeType,
      calculation_value: structure.technologyFeeValue,
      calculated_amount: feeCents / 100,
      source_of_funds: 'agent',
      notes: 'Technology fee'
    })
  }

  // E&O fee
  if (structure.eoFeeValue > 0) {
    const feeCents = structure.eoFeeType === 'flat'
      ? dollarsToCents(structure.eoFeeValue)
      : Math.round(context.agentNetCents * (structure.eoFeeValue / 100))
    
    totalFeesCents += feeCents
    feeDistributions.push({
      distribution_type: 'fee',
      calculation_type: structure.eoFeeType,
      calculation_value: structure.eoFeeValue,
      calculated_amount: feeCents / 100,
      source_of_funds: 'agent',
      notes: 'E&O insurance fee'
    })
  }

  const agentFinalNetCents = context.agentNetCents - totalFeesCents

  return {
    ...context,
    agentFinalNetCents,
    totalFeesCents,
    feeDistributions
  }
}
