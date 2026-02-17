import type { CommissionCalculationParams, CommissionCalculationResult, WaterfallContext } from './types'
import { resolveRate } from './waterfall/01-resolve-rate'
import { calculateGross } from './waterfall/02-calculate-gross'
import { applyGrossAdjustments } from './waterfall/03-apply-gross-adjustments'
import { splitAgentBrokerage } from './waterfall/04-split-agent-brokerage'
import { applyAgentAdjustments } from './waterfall/05-apply-agent-adjustments'
import { applyBrokerageAdjustments } from './waterfall/06-apply-brokerage-adjustments'
import { applyCap } from './waterfall/07-apply-cap'
import { applyTeamSplit } from './waterfall/08-team-split'
import { applyRevenueShare } from './waterfall/09-revenue-share'
import { applyFees } from './waterfall/10-fees'
import { validateAndPersist } from './waterfall/11-validate-persist'
import { CURRENT_ENGINE_VERSION } from './types'

/**
 * COMMISSION ENGINE 8.0 - Main Entry Point
 * 
 * Single function to calculate all commission distributions using 11-step waterfall
 * 
 * @param params - transactionId, brokerageId, calculationMode, triggeredBy
 * @returns CommissionCalculationResult with all distributions
 */
export async function calculateCommission(
  params: CommissionCalculationParams
): Promise<CommissionCalculationResult> {
  const { transactionId, brokerageId, calculationMode = 'final', triggeredBy } = params

  try {
    // Initialize context
    const context: Partial<WaterfallContext> = {
      transactionId,
      brokerageId
    }

    // STEP 1: Resolve Gross Rate
    const step1 = await resolveRate(transactionId, brokerageId)
    Object.assign(context, step1)

    // STEP 2: Calculate Gross Commission
    const step2 = await calculateGross(transactionId, context.grossRateDecimal!)
    Object.assign(context, step2)

    // STEP 3: Apply Gross-Level Adjustments
    const step3 = await applyGrossAdjustments(transactionId, context.grossCommissionCents!)
    Object.assign(context, step3)

    // STEP 4: Split Agent/Brokerage
    const step4 = splitAgentBrokerage(context.adjustedGrossCents!, context.agentSplitPercent!)
    Object.assign(context, step4)

    // STEP 5: Apply Agent-Level Adjustments
    const step5 = await applyAgentAdjustments(transactionId, context.agentPortionCents!)
    Object.assign(context, step5)

    // STEP 6: Apply Brokerage-Level Adjustments
    const step6 = await applyBrokerageAdjustments(transactionId, context.brokeragePortionCents!)
    Object.assign(context, step6)

    // STEP 7: Apply Cap (CORRECTED - Brokerage-Side Cap)
    const step7 = await applyCap(
      context.agentId!,
      brokerageId,
      context.agentPortionCents!,
      context.brokeragePortionCents!
    )
    Object.assign(context, step7)

    // STEP 8: Team Split
    const step8 = await applyTeamSplit(context.agentId!, brokerageId, context.agentNetCents!)
    Object.assign(context, step8)

    // STEP 9: Revenue Share
    const step9 = await applyRevenueShare(context.agentId!, brokerageId, context.agentFinalCents!)
    Object.assign(context, step9)

    // STEP 10: Fees
    const step10 = await applyFees(context.agentId!, brokerageId, context.agentFinalCents!)
    Object.assign(context, step10)

    // Collect all distributions
    const allDistributions = [
      ...context.grossAdjustments!,
      ...context.agentAdjustments!,
      ...context.brokerageAdjustments!,
      ...context.teamDistributions!,
      ...context.revenueShareDistributions!,
      ...context.feeDistributions!
    ]

    context.allDistributions = allDistributions

    // STEP 11: Validate & Persist
    await validateAndPersist(context as WaterfallContext, calculationMode, triggeredBy)

    return {
      success: true,
      transactionId,
      grossCommissionCents: context.grossCommissionCents!,
      adjustedGrossCents: context.adjustedGrossCents!,
      agentNetCents: context.agentNetCents!,
      brokerageFinalCents: context.brokerageFinalCents!,
      agentFinalNetCents: context.agentFinalNetCents!,
      totalFeesCents: context.totalFeesCents!,
      distributions: allDistributions,
      metadata: {
        resolvedFrom: context.resolvedFrom!,
        grossRateDecimal: context.grossRateDecimal!,
        capApplied: context.capApplied!,
        capStatus: context.capStatus,
        calculationVersion: CURRENT_ENGINE_VERSION
      }
    }
  } catch (error) {
    console.error('[v0] Commission Engine Error:', error)
    throw error
  }
}
