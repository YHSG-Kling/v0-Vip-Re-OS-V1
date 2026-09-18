"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireContactAccess } from "@/lib/portal/require-contact-access"
import { revalidatePath } from "next/cache"
import { emitEvent } from "./orchestrator"

// ─────────────────────────────────────────────────────────────────────────────
// THE CLIENT-PORTAL JOURNEY TASK RAIL.
//
// This file owns the CLIENT's own to-do list — the per-persona journeyStages
// declared in lib/portal/persona-config.ts. It is NOT the agent's transaction
// milestone list. That distinction is the whole design:
//
//   transaction_milestones  — TRANSACTION-scoped, AGENT-owned, already has many
//                             writers (lib/transactions/milestone-service.ts,
//                             lib/kernel/transactions.ts:506, ai-contract-review,
//                             lender-portal-actions, cda-portal, flow-integrity).
//                             The portal READS it (lib/kernel/portal.ts) and must
//                             never write it: a client typing a note is not a
//                             coordinator closing a milestone.
//   client_portal_activity  — CONTACT-scoped client-action ledger. This is where
//                             a completed journey task belongs, and it is where
//                             the next reader looks: app/actions/contact-details.ts
//                             reads it back onto the agent's contact detail pane.
//   journey_stage_progress  — CONTACT-scoped stage cursor. It EXISTS in the live
//                             schema (brokerage_id/contact_id/stage_name/
//                             progress_pct/current_task, all NOT NULL where marked)
//                             and had ZERO writers and ZERO readers. It is not
//                             "legacy" — it was simply never wired.
//
// TENANT + IDENTITY. journey_stage_progress has RLS ENABLED and ZERO POLICIES, so
// every anon-key read and write against it is refused. It is therefore reached
// with the SERVICE client, and because the service role bypasses RLS every one of
// those statements carries an EXPLICIT brokerage_id filter. The brokerage always
// comes from requireContactAccess() — never from a parameter.
//
// contacts.agent_id is AGENTS-class and client_portal_activity.agent_id FKs
// agents(id), so the stamp below is a straight copy, not a users/agents swap.
// ─────────────────────────────────────────────────────────────────────────────

/** Shape every mutation in this file returns. `success:false` is the server's verdict. */
export type JourneyTaskResult =
  | { success: true; recorded: "client_portal_activity"; stageRecorded: boolean }
  | { success: false; error: string }

/** Resolve the contact's tenant anchor + owning agent for the activity stamp. */
async function resolveContactAnchor(contactId: string): Promise<
  | { ok: true; brokerageId: string; agentId: string | null; isContactSelf: boolean }
  | { ok: false; error: string }
> {
  const access = await requireContactAccess(contactId)
  if (!access.ok) return { ok: false, error: access.error }

  const svc = createServiceClient()
  const { data: contact, error } = await svc
    .from("contacts")
    .select("agent_id, brokerage_id")
    .eq("id", contactId)
    .eq("brokerage_id", access.brokerageId)
    .maybeSingle()

  if (error) return { ok: false, error: `Contact lookup failed: ${error.message}` }
  if (!contact) return { ok: false, error: "Contact not found" }

  return {
    ok: true,
    brokerageId: access.brokerageId,
    agentId: (contact.agent_id as string | null) ?? null,
    isContactSelf: access.isContactSelf,
  }
}

// Complete a journey task. Records to client_portal_activity (the ledger the
// agent's contact detail pane reads back) and advances the stage cursor.
export async function completeTask(data: {
  contactId: string
  transactionId?: string
  taskId: string
  taskName: string
  stageId?: string
  stageName?: string
  stageIndex?: number
  totalStages?: number
  persona?: string
  taskType?: string
  notes?: string
  formData?: Record<string, any>
}): Promise<JourneyTaskResult> {
  const anchor = await resolveContactAnchor(data.contactId)
  if (!anchor.ok) return { success: false, error: anchor.error }

  const svc = createServiceClient()

  // THE RECORD. Anchored to the tenant AND the owning agent, because
  // client_portal_activity's SELECT policy grants the agent side only through
  // has_brokerage_access(brokerage_id) or agent_id = current_user_agent_id():
  // an unstamped row is readable by the client who wrote it and by NOBODY ELSE,
  // which is a write-only ledger wearing the costume of a working one.
  const { data: activity, error: activityError } = await svc
    .from("client_portal_activity")
    .insert({
      contact_id: data.contactId,
      brokerage_id: anchor.brokerageId,
      agent_id: anchor.agentId,
      activity_type: "task_completed",
      metadata: {
        task_id: data.taskId,
        task_name: data.taskName,
        stage_id: data.stageId ?? null,
        stage_name: data.stageName ?? null,
        task_type: data.taskType ?? null,
        transaction_id: data.transactionId ?? null,
        form_data: data.formData ?? null,
        notes: data.notes ?? null,
      },
    })
    .select("id")
    .single()

  if (activityError || !activity) {
    console.error("[journey-tasks] completeTask activity insert failed:", activityError?.message)
    return { success: false, error: activityError?.message ?? "Could not record the task" }
  }

  // DOCUMENT SUBMISSION. client_documents.document_url is NOT NULL in the live
  // schema, so the previous unconditional insert was rejected on EVERY call and
  // the rejection was never read — a client could "submit" a document forever and
  // no row ever existed. The write now runs only when a real URL was supplied,
  // carries the tenant anchor, and its failure is surfaced instead of swallowed.
  const documentUrl: string | undefined =
    data.formData?.document_url || data.formData?.file_url || undefined
  if (data.formData?.document_type && documentUrl) {
    const { error: docError } = await svc.from("client_documents").insert({
      contact_id: data.contactId,
      transaction_id: data.transactionId ?? null,
      brokerage_id: anchor.brokerageId,
      document_type: data.formData.document_type,
      document_name: data.formData.document_name || data.taskName,
      document_url: documentUrl,
      status: "submitted",
      metadata: data.formData,
    })
    if (docError) {
      console.error("[journey-tasks] client_documents insert failed:", docError.message)
      return { success: false, error: `Task recorded, but the document failed to attach: ${docError.message}` }
    }
  }

  // Advance the client's stage cursor.
  let stageRecorded = false
  if (data.stageId) {
    const stageResult = await updateStageProgress({
      contactId: data.contactId,
      persona: data.persona ?? "",
      currentStageId: data.stageId,
      currentStageName: data.stageName,
      currentTask: data.taskName,
      currentStageIndex: data.stageIndex ?? 0,
      stagesCompleted: data.stageIndex ?? 0,
      totalStages: data.totalStages ?? 0,
    })
    if (!stageResult.success) {
      return { success: false, error: `Task recorded, but stage progress failed: ${stageResult.error}` }
    }
    stageRecorded = true
  }

  revalidatePath(`/portal/${data.contactId}`)
  revalidatePath(`/portal/${data.contactId}/journey`)

  // Emit workflow event for task completion. The brokerage is the REAL one —
  // the literal "default" that used to sit here matches no brokerages.id, so
  // every subscriber that scoped by tenant dropped the event on the floor.
  try {
    await emitEvent({
      brokerage_id: anchor.brokerageId,
      event_type: "journey.task_completed",
      payload: {
        contact_id: data.contactId,
        transaction_id: data.transactionId,
        task_id: data.taskId,
        task_name: data.taskName,
        stage_id: data.stageId,
        stage_name: data.stageName,
        task_type: data.taskType,
        form_data: data.formData,
      },
      source: "ui",
    })
  } catch (eventError) {
    // The task IS recorded; a failed fan-out must not un-record it.
    console.error("[journey-tasks] Error emitting task completion event:", eventError)
  }

  return { success: true, recorded: "client_portal_activity", stageRecorded }
}

// Submit task form data (for tasks that require input).
//
// KEEP-ONE. This used to call completeTask() AND then write a SECOND
// client_portal_activity row ("task_form_submitted") for the same event, because
// the dead `error = { message: "consolidated" }` sentinel made the fallback branch
// unconditionally true. One client action produced two ledger rows and the
// completion count double-counted. There is now exactly one record per task, and
// completeTask owns it — the form payload rides its metadata.form_data.
export async function submitTaskForm(data: {
  contactId: string
  transactionId?: string
  taskId: string
  taskName: string
  taskType: string
  stageId?: string
  stageName?: string
  stageIndex?: number
  totalStages?: number
  persona?: string
  formData: Record<string, any>
}): Promise<JourneyTaskResult> {
  return completeTask({
    contactId: data.contactId,
    transactionId: data.transactionId,
    taskId: data.taskId,
    taskName: data.taskName,
    taskType: data.taskType,
    stageId: data.stageId,
    stageName: data.stageName,
    stageIndex: data.stageIndex,
    totalStages: data.totalStages,
    persona: data.persona,
    notes: typeof data.formData?.notes === "string" ? data.formData.notes : undefined,
    formData: data.formData,
  })
}

/** The shape lib/portal/journey-utils.ts:calculateJourneyProgress consumes. */
export interface JourneyTaskCompletion {
  id: string
  contact_id: string
  task_id: string
  stage_id?: string
  completed_at: string
}

// Get task completion status for a contact.
//
// FIXED PHANTOM JOIN: this used to filter transaction_milestones on
// `transaction_id = contactId`. A contacts.id is never a transactions.id, so the
// query matched nothing on every call and the caller saw "no tasks completed"
// forever. Completions live in client_portal_activity (see the header note), which
// is where completeTask writes them.
export async function getTaskCompletions(contactId: string): Promise<JourneyTaskCompletion[]> {
  const access = await requireContactAccess(contactId)
  if (!access.ok) return []

  const svc = createServiceClient()
  const { data, error } = await svc
    .from("client_portal_activity")
    .select("id, contact_id, activity_type, metadata, created_at")
    .eq("contact_id", contactId)
    .eq("brokerage_id", access.brokerageId) // service role bypasses RLS — scope explicitly
    .eq("activity_type", "task_completed")
    .order("created_at", { ascending: false })

  if (error) {
    console.error("[journey-tasks] getTaskCompletions read failed:", error.message)
    return []
  }

  // One row per task: a task re-submitted keeps its most recent completion only.
  const seen = new Set<string>()
  const completions: JourneyTaskCompletion[] = []
  for (const row of data ?? []) {
    const meta = (row.metadata ?? {}) as Record<string, unknown>
    const taskId = typeof meta.task_id === "string" ? meta.task_id : null
    if (!taskId || seen.has(taskId)) continue
    seen.add(taskId)
    completions.push({
      id: row.id as string,
      contact_id: row.contact_id as string,
      task_id: taskId,
      stage_id: typeof meta.stage_id === "string" ? meta.stage_id : undefined,
      completed_at: row.created_at as string,
    })
  }
  return completions
}

/** The shape lib/portal/journey-utils.ts:calculateJourneyProgress consumes. */
export interface JourneyStageProgressRow {
  id: string
  contact_id: string
  current_stage_id?: string
  current_stage_index?: number
  stages_completed?: number
  stage_name: string
  progress_pct: number
  current_task: string | null
  started_at: string | null
  completed_at: string | null
  updated_at: string
}

// Get journey stage progress for a contact.
//
// journey_stage_progress is NOT legacy — it exists in the live schema and simply
// had no writer and no reader. RLS is ENABLED on it with ZERO POLICIES, so the
// anon key is refused on every statement; the service client is the only way in,
// and it therefore carries an explicit brokerage filter.
export async function getStageProgress(contactId: string): Promise<JourneyStageProgressRow | null> {
  const access = await requireContactAccess(contactId)
  if (!access.ok) return null

  const svc = createServiceClient()
  const { data, error } = await svc
    .from("journey_stage_progress")
    .select("*")
    .eq("contact_id", contactId)
    .eq("brokerage_id", access.brokerageId) // service role bypasses RLS — scope explicitly
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error("[journey-tasks] getStageProgress read failed:", error.message)
    return null
  }
  if (!data) return null

  const meta = (data.current_task ?? "") as string
  return {
    id: data.id as string,
    contact_id: data.contact_id as string,
    current_stage_id: (data.stage_name as string) ?? undefined,
    current_stage_index: undefined,
    stages_completed: undefined,
    stage_name: data.stage_name as string,
    progress_pct: (data.progress_pct as number) ?? 0,
    current_task: meta || null,
    started_at: (data.started_at as string | null) ?? null,
    completed_at: (data.completed_at as string | null) ?? null,
    updated_at: data.updated_at as string,
  }
}

// Update journey stage progress.
//
// journey_stage_progress has no unique index on (contact_id, stage_name), so this
// is a read-then-write rather than an upsert — an ON CONFLICT the schema cannot
// satisfy would be rejected as 42P10 on every call.
export async function updateStageProgress(data: {
  contactId: string
  persona: string
  currentStageId: string
  currentStageName?: string
  currentTask?: string
  currentStageIndex: number
  stagesCompleted: number
  totalStages: number
}): Promise<{ success: true } | { success: false; error: string }> {
  const access = await requireContactAccess(data.contactId)
  if (!access.ok) return { success: false, error: access.error }

  const svc = createServiceClient()
  const now = new Date().toISOString()
  const progressPct =
    data.totalStages > 0
      ? Math.max(0, Math.min(100, Math.round((data.stagesCompleted / data.totalStages) * 100)))
      : 0

  const { data: existing, error: readError } = await svc
    .from("journey_stage_progress")
    .select("id, started_at")
    .eq("contact_id", data.contactId)
    .eq("brokerage_id", access.brokerageId) // service role bypasses RLS — scope explicitly
    .eq("stage_name", data.currentStageId)
    .maybeSingle()

  if (readError) {
    console.error("[journey-tasks] updateStageProgress read failed:", readError.message)
    return { success: false, error: readError.message }
  }

  if (existing) {
    const { error: updErr } = await svc
      .from("journey_stage_progress")
      .update({
        progress_pct: progressPct,
        current_task: data.currentTask ?? data.currentStageName ?? null,
        completed_at: progressPct >= 100 ? now : null,
        updated_at: now,
      })
      .eq("id", existing.id)
      .eq("brokerage_id", access.brokerageId)
    if (updErr) {
      console.error("[journey-tasks] updateStageProgress update failed:", updErr.message)
      return { success: false, error: updErr.message }
    }
  } else {
    const { error: insErr } = await svc.from("journey_stage_progress").insert({
      brokerage_id: access.brokerageId,
      contact_id: data.contactId,
      stage_name: data.currentStageId,
      progress_pct: progressPct,
      current_task: data.currentTask ?? data.currentStageName ?? null,
      started_at: now,
      completed_at: progressPct >= 100 ? now : null,
      created_at: now,
      updated_at: now,
    })
    if (insErr) {
      console.error("[journey-tasks] updateStageProgress insert failed:", insErr.message)
      return { success: false, error: insErr.message }
    }
  }

  revalidatePath(`/portal/${data.contactId}`)
  revalidatePath(`/portal/${data.contactId}/journey`)
  return { success: true }
}

// Event handlers for workflow orchestration
export async function handleTaskCompletedEvent(payload: any) {
  const supabase = await createClient()
  
  // Notify agent of task completion
  try {
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select("agent_id, brokerage_id")
      .eq("id", payload.contact_id)
      .maybeSingle()
    if (contactError) console.error("[journey-tasks] task-completed contact read failed:", contactError.message)
    if (contact?.agent_id) {
      // Keep-one: `notifications` is the canonical in-app alert table (the bell
      // reads it) — agent_notifications was a write-only ledger. contacts.agent_id
      // is agents.id; notifications.user_id is users-class, so resolve through the
      // canonical identity helper.
      const { resolveAgentRecordToUserId } = await import("@/lib/kernel/agent-identity-resolver")
      const userId = await resolveAgentRecordToUserId(contact.agent_id)
      if (userId) {
        const { error: notifErr } = await supabase.from("notifications").insert({
          user_id: userId,
          brokerage_id: contact.brokerage_id,
          type: "task_completed",
          title: `Client completed: ${payload.task_name}`,
          body: `${payload.task_name} completed in the ${payload.stage_name} stage.`,
          entity_type: "contact",
          entity_id: payload.contact_id,
          priority: "medium",
          channel: "in_app",
          is_read: false,
          created_at: new Date().toISOString(),
        })
        if (notifErr) console.error("[journey-tasks] task-completed notification insert failed:", notifErr.message)
      }
    }
  } catch { /* non-critical */ }
  
  return { success: true }
}

export async function handleStageCompletedEvent(payload: any) {
  const supabase = await createClient()
  
  // Create a celebration notification. client_portal_messages canonical columns:
  // body + direction (agent_to_client) + channel + read; agent_id/brokerage_id NOT NULL.
  try {
    const { data: c, error: cError } = await supabase
      .from("contacts").select("agent_id, brokerage_id").eq("id", payload.contact_id).maybeSingle()
    if (cError) console.error("[journey-tasks] stage-completed contact read failed:", cError.message)
    if (c?.agent_id && c?.brokerage_id) {
      const { error: msgError } = await supabase.from("client_portal_messages").insert({
        contact_id: payload.contact_id,
        agent_id: c.agent_id,
        brokerage_id: c.brokerage_id,
        direction: "agent_to_client",
        channel: "portal",
        body: `Stage Complete: ${payload.stage_name}\n\nCongratulations! You've completed the ${payload.stage_name} stage. Moving on to ${payload.next_stage_name}.`,
        metadata: { kind: "milestone", stage_name: payload.stage_name },
        read: false,
      })
      if (msgError) console.error("[journey-tasks] stage-complete message insert failed:", msgError.message)
    }
  } catch {
    // non-critical
  }

  return { success: true }
}

export async function handleAllTasksCompletedEvent(payload: any) {
  const supabase = await createClient()
  
  // Send celebration message (canonical client_portal_messages shape).
  try {
    const { data: c, error: cError } = await supabase
      .from("contacts").select("agent_id, brokerage_id").eq("id", payload.contact_id).maybeSingle()
    if (cError) console.error("[journey-tasks] all-tasks contact read failed:", cError.message)
    if (c?.agent_id && c?.brokerage_id) {
      const { error: msgError } = await supabase.from("client_portal_messages").insert({
        contact_id: payload.contact_id,
        agent_id: c.agent_id,
        brokerage_id: c.brokerage_id,
        direction: "agent_to_client",
        channel: "portal",
        body: "Journey Complete!\n\nCongratulations on completing your real estate journey! We're honored to have been part of this milestone.",
        metadata: { kind: "celebration" },
        read: false,
      })
      if (msgError) console.error("[journey-tasks] celebration message insert failed:", msgError.message)
    }
  } catch {
    // non-critical
  }

  return { success: true }
}

// Pre-populate form data based on task type
export async function getTaskFormFields(taskType: string): Promise<{
  fields: { name: string; label: string; type: string; required: boolean; options?: string[] }[]
  description: string
}> {
  switch (taskType) {
    case "pre_approval":
      return {
        description: "Upload your pre-approval letter or provide lender details",
        fields: [
          { name: "lender_name", label: "Lender Name", type: "text", required: true },
          { name: "loan_amount", label: "Pre-Approval Amount", type: "number", required: true },
          { name: "loan_type", label: "Loan Type", type: "select", required: true, options: ["Conventional", "FHA", "VA", "USDA", "Jumbo"] },
          { name: "expiration_date", label: "Expiration Date", type: "date", required: true },
          { name: "notes", label: "Additional Notes", type: "textarea", required: false },
        ],
      }
    case "budget_setup":
      return {
        description: "Define your budget and financing preferences",
        fields: [
          { name: "max_budget", label: "Maximum Budget", type: "number", required: true },
          { name: "down_payment_percent", label: "Down Payment %", type: "number", required: true },
          { name: "monthly_payment_max", label: "Max Monthly Payment", type: "number", required: false },
          { name: "financing_type", label: "Financing Type", type: "select", required: true, options: ["Cash", "Conventional", "FHA", "VA", "USDA"] },
        ],
      }
    case "criteria_setup":
      return {
        description: "Define your property search criteria",
        fields: [
          { name: "min_beds", label: "Minimum Bedrooms", type: "number", required: true },
          { name: "min_baths", label: "Minimum Bathrooms", type: "number", required: true },
          { name: "min_sqft", label: "Minimum Square Feet", type: "number", required: false },
          { name: "property_types", label: "Property Types", type: "multiselect", required: true, options: ["Single Family", "Condo", "Townhouse", "Multi-Family"] },
          { name: "preferred_areas", label: "Preferred Areas/Neighborhoods", type: "text", required: false },
          { name: "must_haves", label: "Must-Have Features", type: "textarea", required: false },
          { name: "deal_breakers", label: "Deal Breakers", type: "textarea", required: false },
        ],
      }
    case "investment_criteria":
      return {
        description: "Define your investment criteria and goals",
        fields: [
          { name: "target_cap_rate", label: "Target Cap Rate (%)", type: "number", required: true },
          { name: "investment_strategy", label: "Strategy", type: "select", required: true, options: ["Buy and Hold", "Fix and Flip", "BRRRR", "Wholesale", "House Hacking"] },
          { name: "max_purchase_price", label: "Max Purchase Price", type: "number", required: true },
          { name: "target_cash_flow", label: "Target Monthly Cash Flow", type: "number", required: false },
          { name: "property_types", label: "Property Types", type: "multiselect", required: true, options: ["Single Family", "Duplex", "Triplex", "Quadplex", "Multi-Family (5+)", "Commercial"] },
          { name: "renovation_comfort", label: "Renovation Comfort Level", type: "select", required: true, options: ["Turn-key only", "Minor repairs", "Moderate renovation", "Full gut renovation"] },
        ],
      }
    case "showing_feedback":
      return {
        description: "Share your thoughts on the property you just toured",
        fields: [
          { name: "overall_rating", label: "Overall Rating (1-5)", type: "number", required: true },
          { name: "liked", label: "What did you like?", type: "textarea", required: false },
          { name: "concerns", label: "Any concerns?", type: "textarea", required: false },
          { name: "interest_level", label: "Interest Level", type: "select", required: true, options: ["Very Interested", "Interested", "Neutral", "Not Interested"] },
          { name: "next_steps", label: "Suggested Next Steps", type: "select", required: false, options: ["Schedule second showing", "Submit offer", "Keep looking", "Remove from list"] },
        ],
      }
    case "document_upload":
      return {
        description: "Upload required documents",
        fields: [
          { name: "document_type", label: "Document Type", type: "select", required: true, options: ["ID/License", "Pay Stubs", "Tax Returns", "Bank Statements", "Employment Verification", "Other"] },
          { name: "notes", label: "Notes", type: "textarea", required: false },
        ],
      }
    default:
      return {
        description: "Provide details to complete this task",
        fields: [
          { name: "notes", label: "Notes/Details", type: "textarea", required: false },
          { name: "completed", label: "Mark as Complete", type: "checkbox", required: true },
        ],
      }
  }
}
