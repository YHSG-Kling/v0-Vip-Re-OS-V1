import { createServiceClient } from "@/lib/supabase/service"
import { CRITICAL_MILESTONES } from "./transaction-stages"
import { transitionLifecycle } from "@/lib/kernel/lifecycle"

export interface CreateMilestoneParams {
  transactionId: string
  brokerageId: string
  milestoneName: string
  milestoneDate?: string
  status?: "pending" | "completed" | "overdue"
}

export interface CompleteMilestoneParams {
  transactionId: string
  brokerageId: string
  milestoneName: string
  completedBy: string
}

export interface OverrideMilestoneParams {
  transactionId: string
  brokerageId: string
  milestoneName: string
  overrideBy: string
  overrideReason: string
}

/**
 * Ensure all required milestones exist for a transaction
 * Creates missing milestones based on contract terms
 */
export async function ensureRequiredMilestones(
  transactionId: string,
  brokerageId: string,
  contractTerms: Record<string, string | Date>
): Promise<void> {
  const supabase = createServiceClient()
  
  // Required milestone names for all transactions
  const requiredMilestones = [
    "earnest_money_due",
    "inspection_deadline",
    "inspection_completed",
    "appraisal_ordered",
    "appraisal_deadline",
    "appraisal_completed",
    "financing_deadline",
    "clear_to_close_received",
    "final_walkthrough_scheduled",
    "cda_delivered",
    "cd_uploaded",
    "funding_confirmed",
    "closing_date"
  ]
  
  // Get existing milestones
  const { data: existing } = await supabase
    .from("transaction_milestones")
    .select("milestone_name")
    .eq("transaction_id", transactionId)
    .eq("brokerage_id", brokerageId)
  
  const existingNames = new Set(existing?.map(m => m.milestone_name) || [])
  
  // Create missing milestones
  const missingMilestones = requiredMilestones
    .filter(name => !existingNames.has(name))
    .map(name => ({
      transaction_id: transactionId,
      brokerage_id: brokerageId,
      milestone_name: name,
      milestone_date: contractTerms[name] ? new Date(contractTerms[name] as string).toISOString() : null,
      status: "pending" as const,
      created_at: new Date().toISOString()
    }))
  
  if (missingMilestones.length > 0) {
    const { error } = await supabase
      .from("transaction_milestones")
      .insert(missingMilestones)
    
    if (error) {
      throw new Error(`[milestone-service] Failed to create milestones: ${error.message}`)
    }
  }
}

/**
 * Complete a milestone
 */
export async function completeMilestone(params: CompleteMilestoneParams): Promise<void> {
  const { transactionId, brokerageId, milestoneName, completedBy } = params
  const supabase = createServiceClient()
  
  // Update milestone status
  const { error: updateError } = await supabase
    .from("transaction_milestones")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      completed_by: completedBy
    })
    .eq("transaction_id", transactionId)
    .eq("brokerage_id", brokerageId)
    .eq("milestone_name", milestoneName)
  
  if (updateError) {
    throw new Error(`[milestone-service] Failed to complete milestone: ${updateError.message}`)
  }
  
  // Log lifecycle event via kernel
  await transitionLifecycle({
    brokerageId: brokerageId,
    entityType:  "transaction",
    entityId:    transactionId,
    fromState:   "milestone_pending",
    toState:     "milestone_completed",
    actorUserId: completedBy,
    actorRole:   "tc",
    eventType:   "milestone.completed",
    metadata:    { milestone_name: milestoneName },
  })
}

/**
 * Override an overdue milestone with reason
 */
export async function overrideMilestone(params: OverrideMilestoneParams): Promise<void> {
  const { transactionId, brokerageId, milestoneName, overrideBy, overrideReason } = params
  const supabase = createServiceClient()
  
  if (!overrideReason || overrideReason.trim().length < 10) {
    throw new Error("[milestone-service] Override reason must be at least 10 characters")
  }
  
  // Update milestone with override
  const { error: updateError } = await supabase
    .from("transaction_milestones")
    .update({
      override_by: overrideBy,
      override_reason: overrideReason,
      override_at: new Date().toISOString()
    })
    .eq("transaction_id", transactionId)
    .eq("brokerage_id", brokerageId)
    .eq("milestone_name", milestoneName)
  
  if (updateError) {
    throw new Error(`[milestone-service] Failed to override milestone: ${updateError.message}`)
  }
  
  // Log lifecycle event via kernel
  await transitionLifecycle({
    brokerageId: brokerageId,
    entityType:  "transaction",
    entityId:    transactionId,
    fromState:   "milestone_pending",
    toState:     "milestone_overridden",
    actorUserId: overrideBy,
    actorRole:   "broker",
    eventType:   "milestone.overridden",
    metadata:    { milestone_name: milestoneName, override_reason: overrideReason },
  })
}

/**
 * Set or update milestone date (requires reason if critical milestone)
 */
export async function setMilestoneDate(
  transactionId: string,
  brokerageId: string,
  milestoneName: string,
  milestoneDate: string,
  updatedBy: string,
  reason?: string
): Promise<void> {
  const supabase = createServiceClient()
  
  // Check if critical milestone
  if (Object.values(CRITICAL_MILESTONES).flat().includes(milestoneName) && !reason) {
    throw new Error(`[milestone-service] Reason required to change critical milestone date: ${milestoneName}`)
  }
  
  // Get current milestone
  const { data: milestone } = await supabase
    .from("transaction_milestones")
    .select("milestone_date")
    .eq("transaction_id", transactionId)
    .eq("brokerage_id", brokerageId)
    .eq("milestone_name", milestoneName)
    .single()
  
  if (!milestone) {
    throw new Error(`[milestone-service] Milestone not found: ${milestoneName}`)
  }
  
  // Update milestone date
  const { error: updateError } = await supabase
    .from("transaction_milestones")
    .update({
      milestone_date: milestoneDate,
      updated_at: new Date().toISOString()
    })
    .eq("transaction_id", transactionId)
    .eq("brokerage_id", brokerageId)
    .eq("milestone_name", milestoneName)
  
  if (updateError) {
    throw new Error(`[milestone-service] Failed to update milestone date: ${updateError.message}`)
  }
  
  // Log lifecycle event via kernel
  await transitionLifecycle({
    brokerageId: brokerageId,
    entityType:  "transaction",
    entityId:    transactionId,
    fromState:   "milestone_pending",
    toState:     "milestone_date_changed",
    actorUserId: updatedBy,
    actorRole:   "tc",
    eventType:   "milestone.date_changed",
    metadata:    { milestone_name: milestoneName, previous_date: milestone.milestone_date, new_date: milestoneDate, reason: reason ?? null },
  })
}

/**
 * Get all milestones for a transaction
 */
export async function getMilestones(
  transactionId: string,
  brokerageId: string
): Promise<any[]> {
  const supabase = createServiceClient()
  
  const { data, error } = await supabase
    .from("transaction_milestones")
    .select("*")
    .eq("transaction_id", transactionId)
    .eq("brokerage_id", brokerageId)
    .order("milestone_date", { ascending: true })
  
  if (error) {
    throw new Error(`[milestone-service] Failed to get milestones: ${error.message}`)
  }
  
  return data || []
}
