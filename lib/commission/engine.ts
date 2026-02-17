import type { CalculateCommissionParams, CommissionCalculationResult } from "./types"
import { resolveGrossRate } from "./waterfall/01-resolve-rate"
import { calculateGrossCommission } from "./waterfall/02-calculate-gross"
import { applyGrossAdjustments } from "./waterfall/03-apply-gross-adjustments"
import { splitAgentBrokerage } from "./waterfall/04-split-agent-brokerage"
import { applyAgentAdjustments } from "./waterfall/05-apply-agent-adjustments"
import { applyBrokerageAdjustments } from "./waterfall/06-apply-brokerage-adjustments"
import { applyCap } from "./waterfall/07-apply-cap"
import { applyTeamSplit } from "./waterfall/08-team-split"
import { applyRevenueShare } from "./waterfall/09-revenue-share"
import { applyFees } from "./waterfall/10-fees"
import { validateAndPersist } from "./waterfall/11-validate-persist"

/**
 * Commission Engine 8.0
 * Pure functional waterfall - single context object flows through all steps
 * No mutation, no side effects until Step 11
 */
export async function calculateCommission(
  params: CalculateCommissionParams
): Promise<CommissionCalculationResult> {
  
  const { transactionId, brokerageId, calculationMode = 'final', triggeredBy = null } = params
  
  try {
    // Step 1: Resolve gross rate
    let context = await resolveGrossRate(transactionId, brokerageId)

    // Step 2: Calculate gross commission
    context = calculateGrossCommission(context)

    // Step 3: Apply gross adjustments
    context = await applyGrossAdjustments(context)

    // Step 4: Split agent/brokerage
    context = splitAgentBrokerage(context)

    // Step 5: Apply agent adjustments
    context = await applyAgentAdjustments(context)

    // Step 6: Apply brokerage adjustments
    context = await applyBrokerageAdjustments(context)

    // Step 7: Apply cap
    context = await applyCap(context)

    // Step 8: Apply team split
    context = await applyTeamSplit(context)

    // Step 9: Apply revenue share
    context = await applyRevenueShare(context)

    // Step 10: Apply fees
    context = await applyFees(context)

    // Step 11: Validate and persist
    return await validateAndPersist(context, calculationMode, triggeredBy)
    
  } catch (error: any) {
    const { createServiceClient } = await import("@/lib/supabase/service")
    const supabase = createServiceClient()
    
    await supabase.from("lifecycle_events").insert({
      entity_type: "transaction",
      entity_id: transactionId,
      event_type: "transaction.commission.calculation_failed",
      brokerage_id: brokerageId,
      actor_user_id: triggeredBy,
      metadata: {
        error: error.message,
        stack: error.stack
      }
    })
    
    return {
      success: false,
      gross_commission: 0,
      net_to_agent: 0,
      net_to_brokerage: 0,
      cap_applied: false,
      total_fees: 0,
      error: error.message
    }
  }
}
