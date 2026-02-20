import { createServiceClient } from "@/lib/supabase/service"
import type { TransactionStage } from "./transaction-stages"
import { createActivity } from "./activity-factory"
import { sendNotification } from "./notification-service"

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
      .not("milestone_date", "is", null)
    
    if (!milestones) continue
    
    for (const milestone of milestones) {
      const milestoneDate = new Date(milestone.milestone_date)
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
  
  // Log event
  await supabase.from("lifecycle_events").insert({
    entity_type: "transaction",
    entity_id: txn.id,
    event_type: "transaction.milestone.overdue",
    brokerage_id: txn.brokerage_id,
    metadata: {
      milestone_name: milestone.milestone_name,
      milestone_date: milestone.milestone_date,
      stage: txn.stage
    }
  })
  
  // Create urgent activity for agent + TC
  await createActivity({
    transactionId: txn.id,
    brokerageId: txn.brokerage_id,
    agentId: txn.agent_id,
    activityType: "milestone_overdue",
    title: `OVERDUE: ${milestone.milestone_name}`,
    description: `Milestone was due ${milestone.milestone_date}. Immediate action required.`,
    priority: "urgent",
    assignedTo: txn.agent_id
  })
  
  // Notify agent, TC, and broker if critical
  await sendNotification({
    recipientId: txn.agent_id,
    type: "milestone_overdue",
    title: "Milestone Overdue",
    message: `${milestone.milestone_name} is overdue for transaction ${txn.id}`,
    transactionId: txn.id,
    urgency: "high"
  })
  
  // Notify broker if critical milestone
  if (CRITICAL_MILESTONES.includes(milestone.milestone_name)) {
    const { data: brokerProfile } = await supabase
      .from("profiles")
      .select("id")
      .eq("brokerage_id", txn.brokerage_id)
      .eq("role", "broker")
      .single()
    
    if (brokerProfile) {
      await sendNotification({
        recipientId: brokerProfile.id,
        type: "critical_milestone_overdue",
        title: "Critical Milestone Overdue",
        message: `Critical milestone ${milestone.milestone_name} is overdue`,
        transactionId: txn.id,
        urgency: "critical"
      })
    }
  }
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
  
  // Log warning event
  await supabase.from("lifecycle_events").insert({
    entity_type: "transaction",
    entity_id: txn.id,
    event_type: "transaction.milestone.warning",
    brokerage_id: txn.brokerage_id,
    metadata: {
      milestone_name: milestone.milestone_name,
      milestone_date: milestone.milestone_date,
      hours_until: Math.round(hoursUntil)
    }
  })
  
  // Notify agent + TC
  await sendNotification({
    recipientId: txn.agent_id,
    type: "milestone_due_soon",
    title: "Milestone Due Soon",
    message: `${milestone.milestone_name} is due in ${Math.round(hoursUntil)} hours`,
    transactionId: txn.id,
    urgency: "medium"
  })
}
