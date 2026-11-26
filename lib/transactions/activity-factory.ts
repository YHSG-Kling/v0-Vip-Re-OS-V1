import { createServiceClient } from "@/lib/supabase/service"
import type { TransactionStage } from "./transaction-stages"

// Agent task (correct location, no changes) — activity_type: transaction.inspection.schedule, transaction.quotes.request, transaction.appraisal.monitor, transaction.walkthrough.schedule, transaction.cda.prepare, transaction.closing.coordinate, transaction.followup.client, commission.payment.track, milestone.overdue, milestone.warning, etc.
export class ActivityFactory {
  private supabase = createServiceClient()

  async createStageActivities(params: {
    transactionId: string
    brokerageId: string
    stage: TransactionStage
    agentId: string
    metadata?: Record<string, any>
  }): Promise<void> {
    const activities = this.getActivitiesForStage(params.stage, params.metadata)
    
    // Each stage activity is a task the transaction coordinator is expected to
    // act on. A dropped insert means a step of the closing simply never appears
    // on anyone's list, and the caller — which returns void — had no way to know.
    for (const activity of activities) {
      const { error } = await this.supabase.from("activities").insert({
        transaction_id: params.transactionId,
        brokerage_id: params.brokerageId,
        agent_id: params.agentId,
        activity_type: activity.type,
        title: activity.title,
        description: activity.description,
        priority: activity.priority || "medium",
        scheduled_at: activity.dueDate,
        status: "pending",
        metadata: { assigned_to: activity.assignedTo || params.agentId },
        created_at: new Date().toISOString()
      })
      if (error) {
        console.error(
          `[activity-factory] stage activity "${activity.type}" NOT created for transaction ${params.transactionId}:`,
          error.message,
        )
      }
    }
  }

  async createMilestoneActivity(params: {
    transactionId: string
    brokerageId: string
    milestoneType: string
    assignedTo: string
    priority?: string
  }): Promise<void> {
    const activity = this.getMilestoneActivity(params.milestoneType)

    const { error } = await this.supabase.from("activities").insert({
      transaction_id: params.transactionId,
      brokerage_id: params.brokerageId,
      agent_id: params.assignedTo,
      activity_type: activity.type,
      title: activity.title,
      description: activity.description,
      priority: params.priority || "high",
      status: "pending",
      created_at: new Date().toISOString()
    })
    if (error) {
      console.error(
        `[activity-factory] milestone activity "${activity.type}" NOT created for transaction ${params.transactionId}:`,
        error.message,
      )
    }
  }

  private getActivitiesForStage(stage: TransactionStage, metadata?: Record<string, any>): Array<{ type: string; title: string; description: string; priority?: string; dueDate?: string; assignedTo?: string }> {
    switch (stage) {
      case "UNDER_CONTRACT":
        return [
          {
            type: "transaction.inspection.schedule",
            title: "Schedule Inspection",
            description: "Coordinate with client to schedule property inspection",
            priority: "high",
            dueDate: metadata?.inspection_deadline
          }
        ]
      
      case "INSPECTION":
        return [
          {
            type: "transaction.quotes.request",
            title: "Request Inspector & Insurance Quotes",
            description: "Gather 3 inspector quotes and 3 insurance quotes for client approval",
            priority: "high"
          }
        ]
      
      case "APPRAISAL":
        return [
          {
            type: "transaction.appraisal.monitor",
            title: "Monitor Appraisal Progress",
            description: "Follow up with lender on appraisal completion",
            priority: "medium",
            dueDate: metadata?.appraisal_deadline
          }
        ]
      
      case "FINANCING_PENDING":
        return [
          {
            type: "transaction.walkthrough.schedule",
            title: "Schedule Final Walkthrough",
            description: "Coordinate final walkthrough with client",
            priority: "medium"
          },
          {
            type: "transaction.cda.prepare",
            title: "Prepare CDA",
            description: "Generate CDA for internal review",
            priority: "high"
          }
        ]
      
      case "CLOSING_PREP":
        return [
          {
            type: "transaction.closing.coordinate",
            title: "Coordinate Closing Details",
            description: "Confirm closing date, time, and location with all parties",
            priority: "high",
            dueDate: metadata?.closing_date
          }
        ]
      
      case "CLOSED":
        return [
          {
            type: "transaction.followup.client",
            title: "Client Thank You & Follow-up",
            description: "Send thank you and schedule follow-up",
            priority: "low"
          },
          {
            type: "commission.payment.track",
            title: "Track Commission Payment",
            description: "Monitor and record commission payment receipt",
            priority: "medium"
          }
        ]
      
      default:
        return []
    }
  }

  private getMilestoneActivity(milestoneType: string) {
    const activities: Record<string, { type: string; title: string; description: string }> = {
      overdue: {
        type: "milestone.overdue",
        title: "Overdue Milestone",
        description: "Critical milestone is past due - immediate action required"
      },
      warning: {
        type: "milestone.warning",
        title: "Milestone Due Soon",
        description: "Milestone approaching deadline"
      },
      renegotiation: {
        type: "transaction.renegotiation",
        title: "Renegotiation Required",
        description: "Review appraisal results and coordinate with parties"
      },
      gift_order: {
        type: "tc.gift.order",
        title: "Order Closing Gift",
        description: "Order and coordinate closing gift delivery"
      },
      cda_discrepancy: {
        type: "compliance.cda.review",
        title: "Review CDA Discrepancy",
        description: "CDA comparison shows discrepancy - review required"
      },
      alternative_quote: {
        type: "tc.quote.alternative",
        title: "Get Alternative Quote",
        description: "Client declined quote - obtain alternative vendor quote"
      }
    }
    
    return activities[milestoneType] || {
      type: "general",
      title: "Transaction Action Required",
      description: "Review and take action on transaction"
    }
  }
}
