import { createServiceClient } from "@/lib/supabase/service"
import { TransactionStage } from "./transaction-stages"
import { advanceStage, canAdvanceStage, type StageProgressionResult } from "./stage-progression"
import { canTransitionStage } from "./role-guard"

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
  async advanceToStage(targetStage: TransactionStage, reason?: string): Promise<StageProgressionResult> {
    // WHO MAY MOVE THIS DEAL — the one gate (lane 93A). It replaced a throwing
    // check against the literal ["admin","broker","tc","agent"], which refused
    // team_lead and compliance_officer outright and admitted any agent to any
    // deal of the brokerage. A refusal is RETURNED, not thrown, so a "use server"
    // caller relays it instead of surfacing an opaque 500.
    const gate = await canTransitionStage({
      userId: this.params.userId,
      role: this.params.userRole,
      brokerageId: this.params.brokerageId,
      transactionId: this.params.transactionId,
    })
    if (!gate.allowed) return { success: false, error: gate.reason ?? "You cannot move this transaction" }

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
    // Same gate as advanceToStage: the preview must not say "allowed" to a
    // caller the move itself would refuse.
    const gate = await canTransitionStage({
      userId: this.params.userId,
      role: this.params.userRole,
      brokerageId: this.params.brokerageId,
      transactionId: this.params.transactionId,
    })
    if (!gate.allowed) return { allowed: false, blockers: [gate.reason ?? "You cannot move this transaction"] }

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
