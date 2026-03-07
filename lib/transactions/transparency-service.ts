import { createServiceClient } from "@/lib/supabase/service"
import type { TransactionStage } from "./transaction-stages"

export class TransparencyService {
  private supabase = createServiceClient()

  async createUpdate(params: {
    transactionId: string
    brokerageId: string
    stage: TransactionStage
    eventType: string
    metadata?: Record<string, any>
  }): Promise<void> {
    const message = this.generateClientSafeMessage(params.stage, params.eventType, params.metadata)
    
    await this.supabase.from("transparency_updates").insert({
      transaction_id: params.transactionId,
      brokerage_id: params.brokerageId,
      update_type: params.eventType,
      message,
      metadata: params.metadata,
      created_at: new Date().toISOString()
    })
  }

  private generateClientSafeMessage(
    stage: TransactionStage,
    eventType: string,
    metadata?: Record<string, any>
  ): string {
    switch (eventType) {
      case "transaction.stage.changed":
        return this.getStageChangeMessage(stage, metadata)
      case "transaction.milestone.completed":
        return this.getMilestoneMessage(metadata?.milestone_name)
      case "transaction.earnest_money.due":
        return `Earnest money payment is due by ${metadata?.due_date}`
      case "transaction.inspection.scheduled":
        return `Inspection scheduled for ${metadata?.inspection_date}`
      case "transaction.appraisal.ordered":
        return "Appraisal has been ordered and is in progress"
      case "transaction.financing.clear_to_close":
        return "Financing approved - Clear to Close received"
      case "transaction.walkthrough.scheduled":
        return `Final walkthrough scheduled for ${metadata?.walkthrough_date}`
      case "transaction.closing.date_confirmed":
        return `Closing confirmed for ${metadata?.closing_date}`
      case "transaction.closed":
        return "Transaction has closed - Congratulations!"
      case "transaction.quote.approved":
        return `${metadata?.vendor_type} quote approved - ${metadata?.vendor_name}`
      case "transaction.quote.declined":
        return `${metadata?.vendor_type} quote declined - getting alternatives`
      default:
        return "Transaction update"
    }
  }

  private getStageChangeMessage(stage: TransactionStage, metadata?: Record<string, any>): string {
    switch (stage) {
      case "UNDER_CONTRACT":
        return `Under Contract! Earnest money due by ${metadata?.earnest_money_date || "TBD"}. Inspection deadline: ${metadata?.inspection_deadline || "TBD"}`
      case "INSPECTION":
        return "Inspection phase - reviewing property condition"
      case "APPRAISAL":
        return "Appraisal in progress"
      case "FINANCING_PENDING":
        return `Financing in progress - deadline: ${metadata?.financing_deadline || "TBD"}`
      case "CLOSING_PREP":
        return `Preparing for closing on ${metadata?.closing_date || "TBD"}`
      case "CLOSED":
        return "Closed - Welcome home!"
      case "LOST":
        return metadata?.client_safe_reason || "Transaction did not proceed"
      default:
        return "Transaction updated"
    }
  }

  private getMilestoneMessage(milestoneName?: string): string {
    const clientVisibleMilestones: Record<string, string> = {
      earnest_money_due: "Earnest money payment recorded",
      inspection_completed: "Inspection completed",
      appraisal_completed: "Appraisal completed",
      clear_to_close_received: "Clear to Close received",
      final_walkthrough_scheduled: "Final walkthrough scheduled",
      closing_date: "Closing date confirmed"
    }
    
    return clientVisibleMilestones[milestoneName || ""] || "Milestone completed"
  }
}
