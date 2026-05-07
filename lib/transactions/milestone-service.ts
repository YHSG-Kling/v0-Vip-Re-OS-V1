import { createServiceClient } from "@/lib/supabase/service"
import { CRITICAL_MILESTONES, CLIENT_VISIBLE_MILESTONES } from "./transaction-stages"
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

  // Create missing milestones. is_client_visible is set per-milestone based
  // on the canonical CLIENT_VISIBLE_MILESTONES list — the seller/buyer
  // portals filter milestones by this flag, so internal-only items
  // (cda_delivered, cd_uploaded, etc.) don't leak into the client view.
  const clientVisibleSet = new Set(CLIENT_VISIBLE_MILESTONES as string[])
  const missingMilestones = requiredMilestones
    .filter(name => !existingNames.has(name))
    .map(name => ({
      transaction_id: transactionId,
      brokerage_id: brokerageId,
      milestone_name: name,
      target_date: contractTerms[name]
        ? new Date(contractTerms[name] as string).toISOString().slice(0, 10)
        : null,
      status: "pending" as const,
      is_client_visible: clientVisibleSet.has(name),
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

  // Mirror deadline-bearing milestones into transaction_deadlines so the
  // Deadlines tab + deal-health scorer + deadline watcher actually have
  // rows to read. Without this bridge, every auto-created transaction had
  // an empty Deadlines tab and the health score saw zero deadlines.
  await ensureTransactionDeadlines(transactionId, brokerageId, contractTerms)
}

/**
 * Mirror the deadline-bearing items (those with an actual target date the
 * deal must meet) into BOTH the `transaction_deadlines` table (read by the
 * Deadlines tab + deal-health scorer) AND the `calendar_events` table (read
 * by the deadline-watcher cron that fires upcoming-deadline notifications).
 *
 * Without this triple-write, the milestones existed but no downstream system
 * knew about them — Deadlines tab was empty, health score saw zero
 * deadlines, and the watcher fired no reminders.
 *
 * Only deadline-style items are mirrored — pure status milestones like
 * `inspection_completed` aren't deadlines, they're completion markers.
 */
const DEADLINE_BEARING: Array<{
  milestone:        string
  deadlineType:     string
  calendarEventType?: "inspection" | "appraisal" | "financing_deadline" | "walkthrough" | "closing"
}> = [
  { milestone: "earnest_money_due",   deadlineType: "earnest_money" },
  { milestone: "inspection_deadline", deadlineType: "inspection",  calendarEventType: "inspection" },
  { milestone: "appraisal_deadline",  deadlineType: "appraisal",   calendarEventType: "appraisal" },
  { milestone: "financing_deadline",  deadlineType: "financing",   calendarEventType: "financing_deadline" },
  { milestone: "closing_date",        deadlineType: "closing",     calendarEventType: "closing" },
]

export async function ensureTransactionDeadlines(
  transactionId: string,
  brokerageId: string,
  contractTerms: Record<string, string | Date>
): Promise<void> {
  const supabase = createServiceClient()

  const { data: existing } = await supabase
    .from("transaction_deadlines")
    .select("deadline_type")
    .eq("transaction_id", transactionId)
    .eq("brokerage_id", brokerageId)

  const existingTypes = new Set((existing ?? []).map((d: any) => d.deadline_type))
  const now = new Date().toISOString()

  const rowsToInsert = DEADLINE_BEARING
    .filter(d => contractTerms[d.milestone] && !existingTypes.has(d.deadlineType))
    .map(d => ({
      transaction_id: transactionId,
      brokerage_id:   brokerageId,
      deadline_type:  d.deadlineType,
      deadline_date:  new Date(contractTerms[d.milestone] as string).toISOString().slice(0, 10),
      status:         "pending",
      created_at:     now,
      updated_at:     now,
    }))

  if (rowsToInsert.length > 0) {
    const { error } = await supabase
      .from("transaction_deadlines")
      .insert(rowsToInsert)
    if (error) {
      console.error(`[milestone-service] Failed to mirror deadlines: ${error.message}`)
    }
  }

  // ── Mirror to calendar_events so the deadline watcher cron fires
  //    upcoming-deadline notifications. The watcher queries
  //    calendar_events with start_at <= 24h AND deadline_notified=false.
  const { data: existingCalEvents } = await supabase
    .from("calendar_events")
    .select("event_type")
    .eq("entity_type", "transaction")
    .eq("entity_id", transactionId)
    .eq("brokerage_id", brokerageId)

  const existingCalTypes = new Set((existingCalEvents ?? []).map((e: any) => e.event_type))

  const calRowsToInsert = DEADLINE_BEARING
    .filter(d => d.calendarEventType && contractTerms[d.milestone] && !existingCalTypes.has(d.calendarEventType))
    .map(d => {
      const date = new Date(contractTerms[d.milestone] as string)
      // Default deadline event time: end of business (5pm local proxy via UTC)
      date.setUTCHours(23, 0, 0, 0)
      return {
        brokerage_id:        brokerageId,
        entity_type:         "transaction",
        entity_id:           transactionId,
        event_type:          d.calendarEventType!,
        start_at:            date.toISOString(),
        timezone_name:       "America/New_York",
        is_system_generated: true,
        deadline_notified:   false,
        metadata:            { milestone_name: d.milestone, deadline_type: d.deadlineType },
        created_at:          now,
      }
    })

  if (calRowsToInsert.length > 0) {
    const { error: calErr } = await supabase
      .from("calendar_events")
      .insert(calRowsToInsert)
    if (calErr) {
      console.error(`[milestone-service] Failed to mirror calendar events: ${calErr.message}`)
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

  // Mirror completion to transaction_deadlines if this milestone has a
  // matching deadline row (so the Deadlines tab + health scorer see it
  // as completed too, not just the Milestones tab).
  const mapped = DEADLINE_BEARING.find(d => d.milestone === milestoneName)
  if (mapped) {
    await supabase
      .from("transaction_deadlines")
      .update({
        status:       "completed",
        completed_at: new Date().toISOString(),
        completed_by: completedBy,
        updated_at:   new Date().toISOString(),
      })
      .eq("transaction_id", transactionId)
      .eq("brokerage_id", brokerageId)
      .eq("deadline_type", mapped.deadlineType)
      .then(() => null, () => null)
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
    .select("target_date")
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
      target_date: milestoneDate,
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
    toState:     "target_date_changed",
    actorUserId: updatedBy,
    actorRole:   "tc",
    eventType:   "milestone.date_changed",
    metadata:    { milestone_name: milestoneName, previous_date: milestone.target_date, new_date: milestoneDate, reason: reason ?? null },
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
    .order("target_date", { ascending: true })
  
  if (error) {
    throw new Error(`[milestone-service] Failed to get milestones: ${error.message}`)
  }
  
  return data || []
}
