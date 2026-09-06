import { createServiceClient } from "@/lib/supabase/service"
import { CRITICAL_MILESTONES } from "./transaction-stages"
import { resolveMilestoneIdentity } from "./milestone-identity"
import { REQUIRED_MILESTONE_IDS, catalogEntry, deadlineBearingMilestones, milestoneJourneyFor } from "./milestone-catalog"
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
 * Seed the FULL client journey for a transaction (service-client path, used by the
 * offer→transaction bridge). Builds from the single canonical catalog so an offer
 * transaction gets the same celebratory + deadline + compliance milestones a directly
 * created one does (Offer Accepted, Loan Approved, Keys Received, …), not just the thin
 * deadline-critical set. Dedupes by canonical IDENTITY so it never duplicates a
 * milestone that already exists. Pair with ensureRequiredMilestones to fill deadline
 * dates + mirror them.
 */
export async function seedJourneyMilestones(
  transactionId: string,
  brokerageId: string,
  transactionType: string
): Promise<void> {
  const supabase = createServiceClient()

  // A REFUSED EXISTENCE CHECK MUST NOT READ AS "NOTHING IS THERE". supabase-js
  // RESOLVES a denied query, so `const { data }` alone turns "I could not look"
  // into "the deal has no milestones" — and the only thing this read guards is
  // whether to seed. Failing open here does not lose data, it DUPLICATES the
  // deal's entire journey, which is worse: two rows per milestone, each
  // completable independently, and a portal timeline that never reads done.
  const { data: existing, error: existingError } = await supabase
    .from("transaction_milestones")
    .select("milestone_name, milestone_type")
    .eq("transaction_id", transactionId)
    .eq("brokerage_id", brokerageId)
  if (existingError) {
    throw new Error(
      `[seedJourneyMilestones] could not read the existing milestones for transaction ${transactionId} ` +
      `(${existingError.message}) — refusing to seed, because seeding on top of an unreadable journey duplicates it.`,
    )
  }

  const existingIds = new Set<string>()
  for (const m of (existing ?? []) as Array<{ milestone_name: string; milestone_type: string | null }>) {
    const id = resolveMilestoneIdentity(m)
    if (id) existingIds.add(id)
  }

  const now = new Date().toISOString()
  const rows = milestoneJourneyFor(transactionType)
    .filter((m) => !existingIds.has(m.id))
    .map((m) => ({
      transaction_id: transactionId,
      brokerage_id: brokerageId,
      milestone_name: m.name,
      milestone_type: m.id,
      is_client_visible: m.clientVisible,
      status: "pending" as const,
      created_at: now,
    }))

  if (rows.length > 0) {
    const { error } = await supabase.from("transaction_milestones").insert(rows)
    if (error) {
      throw new Error(`[milestone-service] Failed to seed journey milestones: ${error.message}`)
    }
  }
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

  // Dedupe by canonical IDENTITY (not raw milestone_name) so a milestone the journey
  // seeder already created with a human name ("Home Inspection") is recognised here
  // by its identity (inspection_deadline) and NOT duplicated. Names stay snake_case
  // for the rows we insert because completion code (cda-workflow, title watchtower,
  // milestone-service.completeMilestone) matches these by milestone_name. Identity,
  // visibility, and deadline metadata all come from the single milestone catalog.
  // Same rule as seedJourneyMilestones: this read decides whether a required
  // milestone is ADDED, so a refusal that reads as "absent" duplicates it.
  const { data: existing, error: existingError } = await supabase
    .from("transaction_milestones")
    .select("id, milestone_name, milestone_type, target_date")
    .eq("transaction_id", transactionId)
    .eq("brokerage_id", brokerageId)
  if (existingError) {
    throw new Error(
      `[ensureRequiredMilestones] could not read the existing milestones for transaction ${transactionId} ` +
      `(${existingError.message}) — refusing to add, because adding on top of an unreadable set duplicates it.`,
    )
  }

  const existingById = new Map<string, { rowId: string; target_date: string | null }>()
  for (const m of (existing ?? []) as Array<{ id: string; milestone_name: string; milestone_type: string | null; target_date: string | null }>) {
    const id = resolveMilestoneIdentity(m)
    if (id && !existingById.has(id)) existingById.set(id, { rowId: m.id, target_date: m.target_date })
  }

  const now = new Date().toISOString()
  const toInsert: Array<Record<string, unknown>> = []
  const dateFills: Array<{ rowId: string; date: string }> = []

  for (const id of REQUIRED_MILESTONE_IDS) {
    const entry = catalogEntry(id)
    const term = entry?.deadline ? contractTerms[entry.deadline.termKey] : undefined
    const date = term ? new Date(term as string).toISOString().slice(0, 10) : null
    const found = existingById.get(id)
    if (found) {
      // Fill the deadline date on a journey-seeded milestone that has none yet.
      if (date && !found.target_date) dateFills.push({ rowId: found.rowId, date })
      continue
    }
    toInsert.push({
      transaction_id: transactionId,
      brokerage_id: brokerageId,
      milestone_name: id,                          // snake_case — completion code matches by name
      milestone_type: id,                          // canonical identity
      is_client_visible: entry?.clientVisible ?? false,
      target_date: date,
      status: "pending" as const,
      created_at: now,
    })
  }

  if (toInsert.length > 0) {
    const { error } = await supabase.from("transaction_milestones").insert(toInsert)
    if (error) {
      throw new Error(`[milestone-service] Failed to create milestones: ${error.message}`)
    }
  }

  for (const fill of dateFills) {
    await supabase
      .from("transaction_milestones")
      .update({ target_date: fill.date, updated_at: now })
      .eq("id", fill.rowId)
      .then(() => null, () => null)
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
// Derived from the SINGLE milestone catalog so deadline metadata cannot drift from
// the milestone definitions. milestone === the canonical id (== the contractTerms key).
const DEADLINE_BEARING: Array<{
  milestone:        string
  deadlineType:     string
  calendarEventType?: "inspection" | "appraisal" | "financing_deadline" | "walkthrough" | "closing"
}> = deadlineBearingMilestones().map((e) => ({
  milestone:         e.deadline.termKey,
  deadlineType:      e.deadline.deadlineType,
  calendarEventType: e.deadline.calendarEventType,
}))

export async function ensureTransactionDeadlines(
  transactionId: string,
  brokerageId: string,
  contractTerms: Record<string, string | Date>
): Promise<void> {
  const supabase = createServiceClient()

  // Same class: this guards whether a deadline row is inserted.
  const { data: existing, error: existingError } = await supabase
    .from("transaction_deadlines")
    .select("deadline_type")
    .eq("transaction_id", transactionId)
    .eq("brokerage_id", brokerageId)
  if (existingError) {
    throw new Error(
      `[ensureTransactionDeadlines] could not read the existing deadlines for transaction ${transactionId} ` +
      `(${existingError.message}) — refusing to insert duplicates over an unreadable set.`,
    )
  }

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
  // The calendar mirror is best-effort by design — a missing mirror costs a
  // reminder, not the deal — but a refused read still must not masquerade as
  // "no events yet" and double every deadline on the agent's calendar. Reported
  // and skipped rather than thrown: the deadlines themselves are already saved.
  const { data: existingCalEvents, error: calReadError } = await supabase
    .from("calendar_events")
    .select("event_type")
    .eq("entity_type", "transaction")
    .eq("entity_id", transactionId)
    .eq("brokerage_id", brokerageId)
  if (calReadError) {
    console.error(
      `[ensureTransactionDeadlines] calendar mirror SKIPPED for transaction ${transactionId} — ` +
      `could not read existing events (${calReadError.message}); duplicating them would double every reminder.`,
    )
    return
  }

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

  // Fan-out to buyer / seller / lender / title portals + auto-enroll any
  // sequences that trigger on MILESTONE_COMPLETED. transitionLifecycle above
  // covers staff notifications (processKernelEvent only); this layer adds
  // the contact-facing channels (transparency_updates, client_portal_messages,
  // contact notifications) so every milestone completion — appraisal,
  // walkthrough, financing, repair, earnest money, closing — propagates
  // across the deal.
  try {
    const { emitTransactionEvent } = await import("@/lib/kernel/transactions")
    const { KernelEvent } = await import("@/lib/kernel/events")
    await emitTransactionEvent({
      event:       KernelEvent.MILESTONE_COMPLETED,
      brokerageId: brokerageId,
      entityId:    transactionId,
      actorUserId: completedBy,
      metadata:    { milestone_name: milestoneName },
    })
  } catch (err) {
    console.error("[completeMilestone] fan-out failed (non-blocking)", err)
  }
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
