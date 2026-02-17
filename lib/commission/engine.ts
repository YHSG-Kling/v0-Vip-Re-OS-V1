import type { CalculateCommissionParams, CommissionCalculationResult } from "./types"
import { CURRENT_ENGINE_VERSION } from "./types"
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

export async function calculateCommission(
  params: CalculateCommissionParams
): Promise<CommissionCalculationResult> {
  
  const { transactionId, brokerageId, calculationMode = 'final', triggeredBy = null } = params
  
  try {
    const { grossRateDecimal, resolvedFrom, agentId, agentSplitPercent, purchasePrice } = 
      await resolveGrossRate(transactionId, brokerageId)
    
    const { grossCommissionCents } = calculateGrossCommission(purchasePrice, grossRateDecimal)
    
    const { adjustedGrossCents, grossAdjustments } = 
      await applyGrossAdjustments(grossCommissionCents, transactionId, brokerageId)
    
    const { agentPortionCents, brokeragePortionCents } = 
      splitAgentBrokerage(adjustedGrossCents, agentSplitPercent)
    
    const { adjustedAgentCents, agentAdjustments } = 
      await applyAgentAdjustments(agentPortionCents, transactionId, brokerageId)
    
    const { adjustedBrokerageCents, brokerageAdjustments } = 
      await applyBrokerageAdjustments(brokeragePortionCents, transactionId, brokerageId)
    
    const { agentNetCents, brokerageFinalCents, capApplied, capStatus, amountTowardsCap } = 
      await applyCap(adjustedBrokerageCents, adjustedAgentCents, agentId, brokerageId)
    
    const { teamDistributions, agentFinalCents: agentAfterTeam } = 
      await applyTeamSplit(agentNetCents, agentId, brokerageId)
    
    const { revenueShareDistributions, agentFinalCents } = 
      await applyRevenueShare(agentAfterTeam, agentId, brokerageId)
    
    const { feeDistributions, agentFinalNetCents, totalFeesCents } = 
      await applyFees(agentFinalCents, agentId, brokerageId)
    
    const allDistributions = [
      ...grossAdjustments,
      ...agentAdjustments,
      ...brokerageAdjustments,
      ...teamDistributions,
      ...revenueShareDistributions,
      ...feeDistributions,
      {
        distribution_type: 'agent' as const,
        agent_id: agentId,
        calculation_type: 'flat' as const,
        calculated_amount: agentFinalNetCents / 100,
        source_of_funds: 'brokerage' as const,
        cap_applied: capApplied,
        cap_status: capStatus
      },
      {
        distribution_type: 'brokerage' as const,
        calculation_type: 'flat' as const,
        calculated_amount: brokerageFinalCents / 100,
        source_of_funds: 'brokerage' as const
      }
    ]
    
    return await validateAndPersist({
      transactionId,
      brokerageId,
      agentId,
      grossCommissionCents: adjustedGrossCents,
      agentFinalNetCents,
      brokerageFinalCents,
      totalFeesCents,
      capApplied,
      capStatus,
      amountTowardsCap,
      distributions: allDistributions,
      calculationMode,
      triggeredBy
    })
    
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
