import type { CalculateCommissionParams, CommissionCalculationResult } from "./types"
import { transitionLifecycle } from "@/lib/kernel/lifecycle"
import { getDefaultCommissionStructure } from "@/lib/brokerage/get-default-commission-structure"
import { resolveGrossRate } from "./waterfall/01-resolve-rate"
import { calculateGrossCommission } from "./waterfall/02-calculate-gross"
import { applyGrossAdjustments } from "./waterfall/03-apply-gross-adjustments"
import { applyReferralDeduction } from "./waterfall/03b-referral-deduction"
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

    // FAIL CLOSED (wave 143, lane 143C; CLAUDE.md §4 "nobody checked must never render as checked and fine"): a FINAL
    // calculation posts a ledger and a payable. With no agreement terms in force on the deal's date the split resolves
    // to 0 % — the agent would be posted $0 and the brokerage 100 % — which is a silent wrong number, not a calculation.
    // Refuse by name so the broker sets the agent's terms; a PREVIEW still runs (it shows the finding, posts nothing).
    if (calculationMode === 'final' && context.agreement && context.agreement.terms === null) {
      throw new Error(
        `[commission-engine] No commission agreement terms are in force for agent ${context.agentId} on ${context.agreement.asOf} ` +
        `(${context.agreement.findings.join('; ') || 'none recorded'}). Set the agent's commission terms, then recalculate.`
      )
    }

    // Step 2: Calculate gross commission
    context = calculateGrossCommission(context)

    // Step 3: Apply gross adjustments — the AGENT concessions (wave 144, lane 144D: a held concession refuses a FINAL)
    context = await applyGrossAdjustments(context, calculationMode)

    // Step 3b: Referral deduction (wave 143) — the agreed referral fee (inside agent, or outside partner — wave 144) comes
    // off the top, before the split; an owed partner fee with no authorizable payee holds a FINAL
    context = await applyReferralDeduction(context, calculationMode)

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
    // The fee schedule comes from the SAME agreement stage 01 resolved for the deal's period (wave 143, lane
    // 143C) — a second live read here would price fees on today's profile while the split used the period's.
    const commissionStructure = await getDefaultCommissionStructure(
      brokerageId, context.agentId, undefined, context.agreement ? context.agreement.terms : undefined,
    )
    context = await applyFees(context, commissionStructure)

    // Step 11: Validate and persist
    return await validateAndPersist(context, calculationMode, triggeredBy)
    
  } catch (error: any) {
    const { createServiceClient } = await import("@/lib/supabase/service")
    const supabase = createServiceClient()
    
    await transitionLifecycle({
      brokerageId: brokerageId,
      entityType:  "transaction",
      entityId:    transactionId,
      fromState:   "active",
      toState:     "commission_calculation_failed",
      actorUserId: triggeredBy ?? "",
      actorRole:   "agent",
      eventType:   "commission.calculation_failed",
      metadata:    { error: error.message },
    }).catch(() => { /* best-effort — never mask original error */ })
    
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
