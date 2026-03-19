"use server"

import { createClient } from "@/lib/supabase/server"
import { TransactionOrchestrator } from "@/lib/transactions/transaction-orchestrator"
import { TransactionStage, TRANSACTION_STAGES } from "@/lib/transactions/transaction-stages"
import { calculateDealHealth } from "@/lib/deal-health/health-scorer"
import { revalidatePath } from "next/cache"

// ─── THIN WRAPPERS AROUND TransactionOrchestrator ─────────────────────────────

/**
 * Check if the current user can advance a transaction to the target stage.
 * Returns validation result with any blockers.
 */
export async function checkStageAdvancement(params: {
  transactionId: string
  brokerageId: string
  targetStage: TransactionStage
}): Promise<{ allowed: boolean; blockers: string[] }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return { allowed: false, blockers: ["Not authenticated"] }
  }

  // Get user's role in brokerage
  const { data: profile } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle()

  const orchestrator = new TransactionOrchestrator({
    transactionId: params.transactionId,
    brokerageId:   params.brokerageId,
    userId:        user.id,
    userRole:      profile?.role ?? "agent",
  })

  return orchestrator.checkAdvancement(params.targetStage)
}

/**
 * Advance a transaction to the target stage.
 * Validates permissions and blockers before advancing.
 */
export async function advanceTransactionStage(params: {
  transactionId: string
  brokerageId: string
  targetStage: TransactionStage
  reason?: string
}): Promise<{ success: boolean; newStage?: TransactionStage; blockers?: string[]; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return { success: false, error: "Not authenticated" }
  }

  // Get user's role in brokerage
  const { data: profile } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle()

  const orchestrator = new TransactionOrchestrator({
    transactionId: params.transactionId,
    brokerageId:   params.brokerageId,
    userId:        user.id,
    userRole:      profile?.role ?? "agent",
  })

  const result = await orchestrator.advanceToStage(params.targetStage, params.reason)

  if (result.success) {
    revalidatePath(`/dashboard/transactions/${params.transactionId}`)
    revalidatePath(`/dashboard/coordinator`)
    revalidatePath(`/dashboard/transactions`)

    // Non-blocking: trigger deal health score recalculation
    calculateDealHealth({
      transactionId: params.transactionId,
      brokerageId:   params.brokerageId,
    }).catch(error => {
      console.error("[transaction-stage-machine] calculateDealHealth failed:", error)
    })
  }

  return result
}

/**
 * Mark a transaction as LOST with reason tracking.
 */
export async function markTransactionLost(params: {
  transactionId: string
  brokerageId: string
  lostReason: string
  category: string
  earnestMoneyOutcome: "returned" | "forfeited"
}): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return { success: false, error: "Not authenticated" }
  }

  // Get user's role
  const { data: profile } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle()

  const orchestrator = new TransactionOrchestrator({
    transactionId: params.transactionId,
    brokerageId:   params.brokerageId,
    userId:        user.id,
    userRole:      profile?.role ?? "agent",
  })

  // First advance to LOST stage
  const result = await orchestrator.advanceToStage(TRANSACTION_STAGES.LOST, params.lostReason)

  if (!result.success) {
    return { success: false, error: result.error }
  }

  // Record the lost reason details
  const { error: updateError } = await supabase
    .from("transactions")
    .update({
      lost_reason:           params.lostReason,
      lost_category:         params.category,
      earnest_money_outcome: params.earnestMoneyOutcome,
      lost_at:               new Date().toISOString(),
    })
    .eq("id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)

  if (updateError) {
    return { success: false, error: updateError.message }
  }

  revalidatePath(`/dashboard/transactions/${params.transactionId}`)
  revalidatePath(`/dashboard/coordinator`)
  revalidatePath(`/dashboard/transactions`)

  return { success: true }
}

/**
 * Get the current stage and allowed next stages for a transaction.
 */
export async function getTransactionStageInfo(params: {
  transactionId: string
  brokerageId: string
}): Promise<{
  currentStage: TransactionStage | null
  allowedNextStages: TransactionStage[]
  status: string | null
} | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return null

  const { data: profile } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle()

  const orchestrator = new TransactionOrchestrator({
    transactionId: params.transactionId,
    brokerageId:   params.brokerageId,
    userId:        user.id,
    userRole:      profile?.role ?? "agent",
  })

  const current = await orchestrator.getCurrentStage()
  if (!current) return null

  // Import allowed transitions
  const { STAGE_TRANSITIONS } = await import("@/lib/transactions/transaction-stages")
  const allowedNextStages = STAGE_TRANSITIONS[current.stage] || []

  return {
    currentStage:      current.stage,
    allowedNextStages: allowedNextStages as TransactionStage[],
    status:            current.status,
  }
}
