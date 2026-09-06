import { createServiceClient } from "@/lib/supabase/service"
import { ActivityFactory } from "./activity-factory"
import { NotificationService } from "./notification-service"
import { transitionLifecycle } from "@/lib/kernel/lifecycle"

const activityFactory = new ActivityFactory()
const notificationService = new NotificationService()

const CRITICAL_MILESTONES = [
  "inspection_deadline",
  "appraisal_deadline",
  "financing_deadline",
  "cda_delivered"
]

const WARNING_THRESHOLDS = {
  earnest_money_due: 48, // hours
  inspection_deadline: 24,
  financing_deadline: 48
}

/**
 * Hourly cron job to check transaction deadlines
 * Marks overdue, sends warnings, creates activities
 */
export async function checkTransactionDeadlines() {
  const supabase = createServiceClient()
  
  // Get all active transactions
  const { data: transactions } = await supabase
    .from("transactions")
    .select("id, brokerage_id, agent_id, stage")
    .not("status", "in", '("closed","lost")')
    .order("created_at", { ascending: false })
  
  if (!transactions) return
  
  const now = new Date()
  
  for (const txn of transactions) {
    // Get pending milestones with dates
    const { data: milestones } = await supabase
      .from("transaction_milestones")
      .select("*")
      .eq("transaction_id", txn.id)
      .eq("brokerage_id", txn.brokerage_id)
      .eq("status", "pending")
      .not("target_date", "is", null)
    
    if (!milestones) continue
    
    for (const milestone of milestones) {
      const milestoneDate = new Date(milestone.target_date)
      const hoursUntil = (milestoneDate.getTime() - now.getTime()) / (1000 * 60 * 60)
      
      // Check if overdue
      if (now > milestoneDate) {
        await handleOverdue(txn, milestone)
      }
      // Check if warning threshold reached
      else if (milestone.milestone_name in WARNING_THRESHOLDS) {
        const threshold = WARNING_THRESHOLDS[milestone.milestone_name as keyof typeof WARNING_THRESHOLDS]
        if (hoursUntil <= threshold && hoursUntil > 0) {
          await sendWarning(txn, milestone, hoursUntil)
        }
      }
    }
  }
}

async function handleOverdue(
  txn: { id: string; brokerage_id: string; agent_id: string; stage: string },
  milestone: any
) {
  const supabase = createServiceClient()
  
  // Mark overdue
  await supabase
    .from("transaction_milestones")
    .update({ status: "overdue" })
    .eq("id", milestone.id)
    .eq("brokerage_id", txn.brokerage_id)
  
  // Log event via kernel
  await transitionLifecycle({
    brokerageId: txn.brokerage_id,
    entityType:  "transaction",
    entityId:    txn.id,
    fromState:   "milestone_pending",
    toState:     "milestone_overdue",
    actorUserId: "",
    actorRole:   "agent",
    eventType:   "milestone.overdue",
    metadata:    { milestone_name: milestone.milestone_name, target_date: milestone.target_date, stage: txn.stage },
  })
  
  // Create urgent activity for agent + TC
  await activityFactory.createMilestoneActivity({
    transactionId: txn.id,
    brokerageId: txn.brokerage_id,
    milestoneType: "overdue",
    assignedTo: txn.agent_id,
    priority: "high",
  })

  const isCritical = CRITICAL_MILESTONES.includes(milestone.milestone_name)

  // Notify agent, TC, and broker if critical
  await notificationService.notifyMilestoneOverdue({
    transactionId: txn.id,
    brokerageId: txn.brokerage_id,
    agentId: txn.agent_id,
    milestoneName: milestone.milestone_name,
    propertyAddress: txn.id, // address resolved downstream from transaction record
    isCritical,
  })
}

async function sendWarning(
  txn: { id: string; brokerage_id: string; agent_id: string },
  milestone: any,
  hoursUntil: number
) {
  const supabase = createServiceClient()
  
  // Check if warning already sent (prevent spam)
  const { data: existingWarning } = await supabase
    .from("lifecycle_events")
    .select("id")
    .eq("entity_id", txn.id)
    .eq("event_type", "transaction.milestone.warning")
    .eq("metadata->>milestone_name", milestone.milestone_name)
    .gte("created_at", new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString())
    .maybeSingle()
  
  if (existingWarning) return // Already warned recently
  
  // Log warning event via kernel
  await transitionLifecycle({
    brokerageId: txn.brokerage_id,
    entityType:  "transaction",
    entityId:    txn.id,
    fromState:   "milestone_pending",
    toState:     "milestone_warning",
    actorUserId: "",
    actorRole:   "agent",
    eventType:   "milestone.warning",
    metadata:    { milestone_name: milestone.milestone_name, target_date: milestone.target_date, hours_until: Math.round(hoursUntil) },
  })
  
  // Notify agent + TC
  await notificationService.notifyMilestoneWarning({
    transactionId: txn.id,
    brokerageId: txn.brokerage_id,
    agentId: txn.agent_id,
    milestoneName: milestone.milestone_name,
    propertyAddress: txn.id,
    dueDate: milestone.target_date,
    hoursUntilDue: Math.round(hoursUntil),
  })
}
