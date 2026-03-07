import { dollarsToCents } from '../utils'
import type { WaterfallContext, DistributionRecord, CommissionStructureResolved } from '../types'

/**
 * STEP 10: Apply Fees
 * Deduct transaction, desk, tech, E&O fees
 */
export async function applyFees(
  context: WaterfallContext,
  structure: CommissionStructureResolved
): Promise<WaterfallContext> {
  const feeDistributions: DistributionRecord[] = []
  let totalFeesCents = 0

  // Transaction Fee
  if (structure.transactionFeeValue > 0) {
    const feeCents = structure.transactionFeeType === 'flat'
      ? dollarsToCents(structure.transactionFeeValue)
      : Math.round(context.agentPortionCents * (structure.transactionFeeValue / 100))

    totalFeesCents += feeCents

    feeDistributions.push({
      distribution_type: 'fee',
      calculation_type: structure.transactionFeeType,
      calculation_value: structure.transactionFeeValue,
      calculated_amount: feeCents / 100,
      source_of_funds: 'agent'
    })
  }

  // Desk Fee
  if (structure.deskFeeValue > 0) {
    const feeCents = structure.deskFeeType === 'flat'
      ? dollarsToCents(structure.deskFeeValue)
      : Math.round(context.agentPortionCents * (structure.deskFeeValue / 100))

    totalFeesCents += feeCents

    feeDistributions.push({
      distribution_type: 'fee',
      calculation_type: structure.deskFeeType,
      calculation_value: structure.deskFeeValue,
      calculated_amount: feeCents / 100,
      source_of_funds: 'agent'
    })
  }

  // Technology Fee
  if (structure.technologyFeeValue > 0) {
    const feeCents = structure.technologyFeeType === 'flat'
      ? dollarsToCents(structure.technologyFeeValue)
      : Math.round(context.agentPortionCents * (structure.technologyFeeValue / 100))

    totalFeesCents += feeCents

    feeDistributions.push({
      distribution_type: 'fee',
      calculation_type: structure.technologyFeeType,
      calculation_value: structure.technologyFeeValue,
      calculated_amount: feeCents / 100,
      source_of_funds: 'agent'
    })
  }

  // E&O Insurance Fee
  if (structure.eoFeeValue > 0) {
    const feeCents = structure.eoFeeType === 'flat'
      ? dollarsToCents(structure.eoFeeValue)
      : Math.round(context.agentPortionCents * (structure.eoFeeValue / 100))

    totalFeesCents += feeCents

    feeDistributions.push({
      distribution_type: 'fee',
      calculation_type: structure.eoFeeType,
      calculation_value: structure.eoFeeValue,
      calculated_amount: feeCents / 100,
      source_of_funds: 'agent'
    })
  }

  const agentFinalNetCents = context.agentPortionCents - totalFeesCents

  return {
    ...context,
    totalFeesCents,
    feeDistributions,
    agentFinalNetCents
  }
}
