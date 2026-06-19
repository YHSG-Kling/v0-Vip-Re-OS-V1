
import { createClient } from "@/lib/supabase/server"
import { dispatchSms, dispatchEmail } from "@/lib/providers/dispatch"
import { generateVideoScript } from "@/lib/content-generation"

/**
 * Advance a listing to a new stage directly via Supabase.
 * Kept local to lib/orchestrator to avoid importing lib/application (upward dep).
 * Full validation/lifecycle logic should be invoked at the app/ layer.
 */
async function advanceListingStage(listingId: string, stage: string): Promise<{ success: boolean }> {
  if (!listingId) return { success: false }
  const supabase = await createClient()
  await supabase
    .from("listings")
    .update({ lifecycle_stage: stage, updated_at: new Date().toISOString() })
    .eq("id", listingId)
  return { success: true }
}

// Lightweight task & contact helpers — direct Supabase writes, no app/actions dependency
async function createTask(params: {
  title: string
  brokerageId: string
  description?: string
  dueDate?: string
  assignedTo?: string
  contactId?: string
  listingId?: string
  priority?: string
}) {
  const supabase = await createClient()
  // tasks.brokerage_id and tasks.assigned_to_agent_id are both NOT NULL.
  // Live column is assigned_to_agent_id (not assigned_to).
  const { data } = await supabase.from("tasks").insert({
    brokerage_id: params.brokerageId,
    title: params.title,
    description: params.description,
    due_date: params.dueDate,
    assigned_to_agent_id: params.assignedTo,
    contact_id: params.contactId,
    listing_id: params.listingId,
    priority: params.priority || "medium",
    status: "pending",
  }).select().single()
  return { success: true, task: data }
}

async function updateContactStage(params: { contactId: string; newStage: string; notes?: string }) {
  const supabase = await createClient()
  await supabase.from("contacts").update({
    lifecycle_state: params.newStage,
    updated_at: new Date().toISOString(),
  }).eq("id", params.contactId)
  return { success: true }
}

type WorkflowStep = {
  id: string
  name: string
  action: string
  params: any
  retry_count?: number
  max_retries?: number
  depends_on?: string[]
}

type WorkflowConfig = {
  id: string
  name: string
  trigger: string
  steps: WorkflowStep[]
  error_handling?: "stop" | "continue" | "retry"
}

export class WorkflowOrchestrator {
  private async getSupabase() {
    return createClient()
  }

  async executeWorkflow(config: WorkflowConfig, context: any) {
    const supabase = await this.getSupabase()

    // Create execution record
    const { data: execution, error } = await supabase
      .from("workflow_executions")
      .insert({
        workflow_id: config.id,
        workflow_name: config.name,
        // workflow_executions has no trigger_type/trigger_data/contact_id/listing_id/
        // transaction_id columns — fold them into the context jsonb (no data lost).
        context: {
          ...context,
          triggerType: config.trigger,
          triggerData: context.triggerData ?? {},
          contactId: context.contactId ?? null,
          listingId: context.listingId ?? null,
          transactionId: context.transactionId ?? null,
        },
        status: "running",
        agent_id: context.agentId,
        brokerage_id: context.brokerageId,
        started_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (error || !execution) {
      console.error("[WorkflowOrchestrator] Failed to create execution:", error)
      throw new Error("Failed to start workflow execution")
    }

    try {
      // Execute steps in order
      for (const step of config.steps) {
        await this.executeStep(execution.id, step, context)
      }

      // Mark execution as completed
      await this.completeExecution(execution.id, "completed")

      return {
        success: true,
        execution_id: execution.id,
        message: `Workflow "${config.name}" completed successfully`,
      }
    } catch (error: any) {
      console.error("[WorkflowOrchestrator] Workflow failed:", error)

      await this.completeExecution(execution.id, "failed", error.message)

      // Handle retry logic
      if (config.error_handling === "retry") {
        const retryCount = execution.retry_count || 0
        const maxRetries = execution.max_retries || 3

        if (retryCount < maxRetries) {
          await this.scheduleRetry(execution.id, config, context, retryCount + 1)
        }
      }

      throw error
    }
  }

  private async executeStep(executionId: string, step: WorkflowStep, context: any): Promise<unknown> {
    const supabase = await this.getSupabase()

    // Log step start
    const { data: stepExecution } = await supabase
      .from("workflow_step_executions")
      .insert({
        execution_id: executionId,
        step_id: step.id,
        step_name: step.name,
        action_type: step.action,
        params: step.params,
        status: "running",
        started_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (!stepExecution) {
      throw new Error(`Failed to log step execution: ${step.name}`)
    }

    try {
      // Execute the action
      const result = await this.routeAction(step.action, step.params, context)

      // Log step completion
      await supabase
        .from("workflow_step_executions")
        .update({
          status: "completed",
          result: result,
          completed_at: new Date().toISOString(),
        })
        .eq("id", stepExecution.id)

      return result
    } catch (error: any) {
      console.error(`[WorkflowOrchestrator] Step "${step.name}" failed:`, error)

      // Retry logic with exponential backoff
      const retryCount = step.retry_count || 0
      const maxRetries = step.max_retries || 3

      if (retryCount < maxRetries) {
        const backoffMs = Math.pow(2, retryCount) * 1000 // 1s, 2s, 4s...
        console.log(`[WorkflowOrchestrator] Retrying step "${step.name}" in ${backoffMs}ms`)

        await this.sleep(backoffMs)

        return this.executeStep(
          executionId,
          {
            ...step,
            retry_count: retryCount + 1,
          },
          context,
        )
      }

      // Log step failure
      await supabase
        .from("workflow_step_executions")
        .update({
          status: "failed",
          error_message: error.message,
          completed_at: new Date().toISOString(),
        })
        .eq("id", stepExecution.id)

      throw error
    }
  }

  private async routeAction(action: string, params: any, context: any): Promise<any> {
    console.log(`[WorkflowOrchestrator] Routing action: ${action}`)

    switch (action) {
      case "send_email":
        // Route through the gate (suppression/consent/de-confliction) — no raw send.
        return await dispatchEmail({
          brokerageId: context.brokerageId ?? "",
          to: context.contactEmail ?? context.email ?? "",
          from: context.fromEmail ?? (process.env.SENDGRID_FROM_EMAIL || "noreply@yourdomain.com"),
          subject: params.subject ?? "",
          html: params.body ?? params.html ?? "",
          contactId: context.contactId,
          channelPurpose: "campaign",
          systemSource: "workflow",
        })

      case "send_sms":
        return await dispatchSms({
          brokerageId: context.brokerageId ?? "",
          to: context.contactPhone ?? context.phone ?? "",
          message: params.message ?? "",
          contactId: context.contactId,
          systemSource: "workflow",
        })

      case "create_task":
        if (!context.brokerageId) {
          return { success: false, error: "create_task: workflow context missing brokerageId" }
        }
        if (!context.agentId) {
          return { success: false, error: "create_task: workflow context missing agentId (tasks.assigned_to_agent_id is NOT NULL)" }
        }
        return await createTask({
          brokerageId: context.brokerageId,
          title: params.title,
          description: params.description,
          dueDate: params.dueDate || this.addDays(new Date(), params.due_days || 1),
          assignedTo: context.agentId,
          contactId: context.contactId,
          listingId: context.listingId,
          priority: params.priority || "medium",
        })

      case "generate_video":
        return await generateVideoScript({
          content_type: "video_script",
          contact_id: context.contactId,
          custom_prompt: params.context ?? "",
        })

      case "update_contact":
        return await updateContactStage({
          contactId: context.contactId,
          newStage: params.stage,
          notes: params.notes,
        })

      case "advance_stage":
        return await advanceListingStage(context.listingId, params.stage)

      case "schedule_appointment":
        // Placeholder for appointment scheduling
        return { success: true, message: "Appointment scheduled" }

      case "request_document":
        // Placeholder for document request
        return { success: true, message: "Document requested" }

      case "delay":
        await this.sleep(params.milliseconds || 1000)
        return { success: true, message: `Delayed ${params.milliseconds}ms` }

      default:
        throw new Error(`Unknown action type: ${action}`)
    }
  }

  private async completeExecution(executionId: string, status: string, errorMessage?: string) {
    const supabase = await this.getSupabase()

    await supabase
      .from("workflow_executions")
      .update({
        status,
        error_message: errorMessage,
        completed_at: new Date().toISOString(),
      })
      .eq("id", executionId)
  }

  private async scheduleRetry(executionId: string, config: WorkflowConfig, context: any, retryCount: number) {
    const supabase = await this.getSupabase()

    // Schedule retry for 5 minutes later with exponential backoff
    const delayMinutes = Math.pow(2, retryCount) * 5 // 5, 10, 20 minutes...
    const scheduledFor = new Date(Date.now() + delayMinutes * 60 * 1000)

    await supabase.from("workflow_retries").insert({
      execution_id: executionId,
      workflow_config: { ...config, context },
      scheduled_for: scheduledFor.toISOString(),
    })

    console.log(`[WorkflowOrchestrator] Scheduled retry ${retryCount} for ${scheduledFor.toISOString()}`)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private addDays(date: Date, days: number): string {
    const result = new Date(date)
    result.setDate(result.getDate() + days)
    return result.toISOString()
  }
}

export const WORKFLOW_DEFINITIONS: Record<string, WorkflowConfig> = {
  NEW_LEAD_ONBOARDING: {
    id: "new_lead_onboarding",
    name: "New Lead Onboarding",
    trigger: "contact_created",
    steps: [
      {
        id: "step_1",
        name: "Send Welcome Email",
        action: "send_email",
        params: { template: "welcome", subject: "Welcome!" },
        max_retries: 3,
      },
      {
        id: "step_2",
        name: "Create Follow-Up Task",
        action: "create_task",
        params: { title: "Call new lead within 24 hours", due_days: 1, priority: "high" },
        max_retries: 2,
      },
      {
        id: "step_3",
        name: "Send Welcome SMS",
        action: "send_sms",
        params: { template: "welcome_sms" },
        max_retries: 3,
      },
    ],
    error_handling: "continue",
  },

  LISTING_AGREEMENT_SIGNED: {
    id: "listing_agreement_signed",
    name: "Listing Agreement Signed",
    trigger: "listing_stage_change",
    steps: [
      {
        id: "step_1",
        name: "Advance to Pre-Marketing",
        action: "advance_stage",
        params: { stage: "Pre-Marketing Setup" },
      },
      {
        id: "step_2",
        name: "Create Photo Task",
        action: "create_task",
        params: { title: "Schedule professional photos", due_days: 2, priority: "high" },
      },
      {
        id: "step_3",
        name: "Send Congrats SMS",
        action: "send_sms",
        params: { template: "listing_signed_congrats" },
      },
      {
        id: "step_4",
        name: "Generate Welcome Video Script",
        action: "generate_video",
        params: { type: "listing_signed", context: { celebration: true } },
      },
    ],
    error_handling: "retry",
  },

  UNDER_CONTRACT: {
    id: "under_contract",
    name: "Under Contract Workflow",
    trigger: "transaction_created",
    steps: [
      {
        id: "step_1",
        name: "Send Congratulations Email",
        action: "send_email",
        params: { template: "under_contract_congrats", subject: "Congratulations! You're Under Contract" },
      },
      {
        id: "step_2",
        name: "Update Contact Stage",
        action: "update_contact",
        params: { stage: "Under Contract", notes: "Transaction created" },
      },
      {
        id: "step_3",
        name: "Create Inspection Task",
        action: "create_task",
        params: { title: "Schedule home inspection", due_days: 3, priority: "high" },
      },
      {
        id: "step_4",
        name: "Create Appraisal Task",
        action: "create_task",
        params: { title: "Order appraisal", due_days: 3, priority: "high" },
      },
    ],
    error_handling: "retry",
  },

  OFFER_RECEIVED: {
    id: "offer_received",
    name: "Offer Received Workflow",
    trigger: "offer_submitted",
    steps: [
      {
        id: "step_1",
        name: "Notify Seller via SMS",
        action: "send_sms",
        params: { message: "Great news! You've received an offer on your property." },
      },
      {
        id: "step_2",
        name: "Send Offer Summary Email",
        action: "send_email",
        params: { template: "offer_received", subject: "New Offer Received" },
      },
      {
        id: "step_3",
        name: "Create Review Task",
        action: "create_task",
        params: { title: "Review offer with seller", due_days: 1, priority: "urgent" },
      },
    ],
    error_handling: "continue",
  },

  CLOSING_APPROACHING: {
    id: "closing_approaching",
    name: "Closing Approaching Workflow",
    trigger: "7_days_before_closing",
    steps: [
      {
        id: "step_1",
        name: "Send Closing Checklist Email",
        action: "send_email",
        params: { template: "closing_checklist", subject: "Your Closing Checklist - 7 Days to Go!" },
      },
      {
        id: "step_2",
        name: "Create Final Walkthrough Task",
        action: "create_task",
        params: { title: "Schedule final walkthrough", due_days: 2, priority: "high" },
      },
      {
        id: "step_3",
        name: "Create Closing Gift Task",
        action: "create_task",
        params: { title: "Prepare closing gift", due_days: 3 },
      },
    ],
    error_handling: "retry",
  },
}

export async function triggerWorkflow(
  workflowId: string,
  context: {
    agentId?: string
    brokerageId?: string
    contactId?: string
    listingId?: string
    transactionId?: string
    triggerData?: any
  },
) {
  const workflow = WORKFLOW_DEFINITIONS[workflowId]

  if (!workflow) {
    throw new Error(`Workflow not found: ${workflowId}`)
  }

  const orchestrator = new WorkflowOrchestrator()
  return orchestrator.executeWorkflow(workflow, context)
}
