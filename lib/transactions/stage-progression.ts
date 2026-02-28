import { createServiceClient } from "@/lib/supabase/service"
import { STAGE_TRANSITIONS, CRITICAL_MILESTONES, TransactionStage } from "./transaction-stages"
import { getMilestones } from "./milestone-service"
import { transitionLifecycle } from "@/lib/kernel/lifecycle"

export interface StageProgressionResult {
  success: boolean
  newStage?: TransactionStage
  blockers?: string[]
  error?: string
}

/**
 * Check if transaction can advance to next stage
 * Validates: contract_date set, compliance passed, all critical milestones complete
 */
export async function canAdvanceStage(
  transactionId: string,
  currentStage: TransactionStage,
  targetStage: TransactionStage,
  brokerageId: string
): Promise<{ allowed: boolean; blockers: string[] }> {
  const supabase = createServiceClient()
  const blockers: string[] = []

  // 1. Validate transition is allowed by state machine
  const allowedTargets = STAGE_TRANSITIONS[currentStage]
  if (!allowedTargets.includes(targetStage)) {
    return {
      allowed: false,
      blockers: [`Cannot transition from ${currentStage} to ${targetStage}. Not an allowed transition.`]
    }
  }

  // 2. Get transaction to check contract_date and compliance
  const { data: transaction } = await supabase
    .from("transactions")
    .select("contract_date, compliance_passed_at")
    .eq("id", transactionId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (!transaction) {
    return { allowed: false, blockers: ["Transaction not found"] }
  }

  // 3. Require contract_date for any post-contract stage
  if (!transaction.contract_date && targetStage !== "LOST") {
    blockers.push("contract_date must be set before advancing to post-contract stages")
  }

  // 4. Require compliance_passed_at for any post-contract stage
  if (!transaction.compliance_passed_at && targetStage !== "LOST") {
    blockers.push("compliance_passed_at must be set before advancing to post-contract stages")
  }

  // 5. Check critical milestones for current stage
  const criticalForStage = CRITICAL_MILESTONES[currentStage] || []
  if (criticalForStage.length > 0) {
    const milestones = await getMilestones(transactionId, brokerageId)
    
    for (const criticalName of criticalForStage) {
      const milestone = milestones.find(m => m.name === criticalName)
      if (!milestone) {
        blockers.push(`Critical milestone "${criticalName}" not found`)
      } else if (!milestone.completed_at) {
        blockers.push(`Critical milestone "${criticalName}" must be completed`)
      }
    }
  }

  return {
    allowed: blockers.length === 0,
    blockers
  }
}

/**
 * Advance transaction to next stage with full validation
 * Emits lifecycle event on success
 */
export async function advanceStage(params: {
  transactionId: string
  targetStage: TransactionStage
  brokerageId: string
  userId: string
  reason?: string
}): Promise<StageProgressionResult> {
  const supabase = createServiceClient()

  // 1. Get current stage
  const { data: transaction } = await supabase
    .from("transactions")
    .select("stage, status")
    .eq("id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()

  if (!transaction) {
    return { success: false, error: "Transaction not found" }
  }

  const currentStage = transaction.stage as TransactionStage

  // 2. Validate transition
  const validation = await canAdvanceStage(
    params.transactionId,
    currentStage,
    params.targetStage,
    params.brokerageId
  )

  if (!validation.allowed) {
    return {
      success: false,
      blockers: validation.blockers,
      error: `Stage advancement blocked: ${validation.blockers.join(", ")}`
    }
  }

  // 3. Update stage and status
  const { error: updateError } = await supabase
    .from("transactions")
    .update({
      stage: params.targetStage,
      status: params.targetStage, // status mirrors stage
      updated_at: new Date().toISOString()
    })
    .eq("id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)

  if (updateError) {
    return { success: false, error: updateError.message }
  }

  // 4. Emit lifecycle event via kernel
  await transitionLifecycle({
    brokerageId:  params.brokerageId,
    entityType:   "transaction",
    entityId:     params.transactionId,
    fromState:    currentStage,
    toState:      params.targetStage,
    actorUserId:  params.userId,
    actorRole:    "tc",
    eventType:    "stage.advanced",
    metadata:     { reason: params.reason ?? null },
  })

  // 5. Trigger commission calculations based on stage
  if (params.targetStage === "CLOSING_PREP") {
    // Trigger preview commission calculation
    const { calculateCommission } = await import("@/lib/commission/engine")
    await calculateCommission({
      transactionId: params.transactionId,
      brokerageId: params.brokerageId,
      calculationMode: 'preview',
      triggeredBy: params.userId
    }).catch(error => {
      console.error("[v0] Commission preview calculation failed:", error)
      // Don't block stage advancement on commission calculation failure
    })
  } else if (params.targetStage === "CLOSED") {
    // Trigger final commission calculation
    const { calculateCommission } = await import("@/lib/commission/engine")
    await calculateCommission({
      transactionId: params.transactionId,
      brokerageId: params.brokerageId,
      calculationMode: 'final',
      triggeredBy: params.userId
    }).catch(error => {
      console.error("[v0] Final commission calculation failed:", error)
      // Don't block stage advancement on commission calculation failure
    })
  }

  return {
    success: true,
    newStage: params.targetStage
  }
}
