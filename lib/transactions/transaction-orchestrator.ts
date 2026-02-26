import { createServiceClient } from "@/lib/supabase/service"
import { TransactionStage } from "./transaction-stages"
import { advanceStage, canAdvanceStage } from "./stage-progression"
import { assertUserHasRole } from "./role-guard"

export interface TransactionOrchestratorParams {
  transactionId: string
  brokerageId: string
  userId: string
  userRole: string
}

/**
 * Central orchestrator for transaction lifecycle operations
 * Enforces role-based permissions and stage progression rules
 */
export class TransactionOrchestrator {
  private params: TransactionOrchestratorParams

  constructor(params: TransactionOrchestratorParams) {
    this.params = params
  }

  /**
   * Attempt to advance transaction to target stage
   * Validates permissions, checks blockers, updates stage
   */
  async advanceToStage(targetStage: TransactionStage, reason?: string) {
    // Check role permission
    const hasPermission = await assertUserHasRole(
      this.params.userId,
      ["admin", "broker", "tc", "agent"],
      this.params.brokerageId
    )

    if (!hasPermission) {
      return {
        success: false,
        error: "User does not have permission to advance transaction stages"
      }
    }

    // Delegate to stage progression engine
    return advanceStage({
      transactionId: this.params.transactionId,
      targetStage,
      brokerageId: this.params.brokerageId,
      userId: this.params.userId,
      reason
    })
  }

  /**
   * Check if transaction can advance to target stage
   * Returns validation result with blockers
   */
  async checkAdvancement(targetStage: TransactionStage) {
    const supabase = createServiceClient()

    const { data: transaction } = await supabase
      .from("transactions")
      .select("stage")
      .eq("id", this.params.transactionId)
      .eq("brokerage_id", this.params.brokerageId)
      .maybeSingle()

    if (!transaction) {
      return { allowed: false, blockers: ["Transaction not found"] }
    }

    return canAdvanceStage(
      this.params.transactionId,
      transaction.stage as TransactionStage,
      targetStage,
      this.params.brokerageId
    )
  }

  /**
   * Get current transaction stage and status
   */
  async getCurrentStage(): Promise<{ stage: TransactionStage; status: string } | null> {
    const supabase = createServiceClient()

    const { data: transaction } = await supabase
      .from("transactions")
      .select("stage, status")
      .eq("id", this.params.transactionId)
      .eq("brokerage_id", this.params.brokerageId)
      .maybeSingle()

    if (!transaction) return null

    return {
      stage: transaction.stage as TransactionStage,
      status: transaction.status
    }
  }
}
