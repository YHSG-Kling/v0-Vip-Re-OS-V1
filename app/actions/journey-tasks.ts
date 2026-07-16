"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { emitEvent } from "./orchestrator"

// Complete a milestone task
export async function completeTask(data: {
  contactId: string
  transactionId?: string
  taskId: string
  taskName: string
  stageId?: string
  stageName?: string
  taskType?: string
  notes?: string
  formData?: Record<string, any>
}) {
  try {
    const supabase = await createClient()

    // If there's a transaction, create/update milestone
    if (data.transactionId) {
      // Check if milestone exists
      const { data: existing } = await supabase
        .from("transaction_milestones")
        .select("*")
        .eq("transaction_id", data.transactionId)
        .ilike("milestone_name", `%${data.taskName}%`)
        .single()

      if (existing) {
        // Update existing milestone
        await supabase
          .from("transaction_milestones")
          .update({
            status: "completed",
            completed_at: new Date().toISOString(),
            notes: data.notes,
          })
          .eq("id", existing.id)
      } else {
        // Create new milestone
        await supabase.from("transaction_milestones").insert({
          transaction_id: data.transactionId,
          milestone_name: data.taskName,
          status: "completed",
          completed_at: new Date().toISOString(),
          notes: data.notes,
        })
      }
    }

    // Track the activity (fallback/legacy)
    try {
      await supabase.from("client_portal_activity").insert({
        contact_id: data.contactId,
        activity_type: "task_completed",
        metadata: {
          task_id: data.taskId,
          task_name: data.taskName,
          form_data: data.formData,
          notes: data.notes,
        },
      })
    } catch {
      // Table might not exist, ignore
    }

    // If form data includes document submission, handle it
    if (data.formData?.document_type) {
      await supabase.from("client_documents").insert({
        contact_id: data.contactId,
        transaction_id: data.transactionId,
        document_type: data.formData.document_type,
        document_name: data.formData.document_name || data.taskName,
        status: "submitted",
        metadata: data.formData,
      })
    }

    revalidatePath(`/portal/${data.contactId}`)
    revalidatePath(`/portal/${data.contactId}/journey`)

    // Emit workflow event for task completion
    try {
      await emitEvent({
        brokerage_id: "default",
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
      // Don't fail the task completion if event emission fails
      console.error("[v0] Error emitting task completion event:", eventError)
    }

    return { success: true }
  } catch (error: any) {
    console.error("[v0] Error completing task:", error)
    return { success: false, error: error.message }
  }
}

// Submit task form data (for tasks that require input)
export async function submitTaskForm(data: {
  contactId: string
  transactionId?: string
  taskId: string
  taskName: string
  taskType: string
  formData: Record<string, any>
}) {
  try {
    const supabase = await createClient()

    // pass 14: task_submissions was a PHANTOM table — the "fallback"
    // client_portal_activity write below was the only path that ever worked, so
    // it is now the PRIMARY (keep-one). The submission payload rides metadata.
    const submission: { id: string } | null = null
    const error = { message: "consolidated" } as const

    // Also mark the task as complete
    await completeTask({
      contactId: data.contactId,
      transactionId: data.transactionId,
      taskId: data.taskId,
      taskName: data.taskName,
      formData: data.formData,
    })

    if (error) {
      // Table might not exist, just track activity
      await supabase.from("client_portal_activity").insert({
        contact_id: data.contactId,
        activity_type: "task_form_submitted",
        metadata: {
          task_id: data.taskId,
          task_name: data.taskName,
          task_type: data.taskType,
          form_data: data.formData,
        },
      })
    }

    revalidatePath(`/portal/${data.contactId}`)
    revalidatePath(`/portal/${data.contactId}/journey`)

    return { success: true, data: submission }
  } catch (error: any) {
    console.error("[v0] Error submitting task form:", error)
    return { success: false, error: error.message }
  }
}

// Get task completion status for a contact
export async function getTaskCompletions(contactId: string) {
  try {
    const supabase = await createClient()

    // Read from transaction_milestones (canonical source)
    const { data: milestones } = await supabase
      .from("transaction_milestones")
      .select("*")
      .eq("transaction_id", contactId) // note: may need join via transactions table
      .order("completed_at", { ascending: false })

    return milestones || []
  } catch (error) {
    console.error("[v0] Error fetching task completions:", error)
    return []
  }
}

// Get journey stage progress for a contact
export async function getStageProgress(contactId: string) {
  // journey_stage_progress is legacy — callers handle null gracefully
  return null
}

// Update journey stage progress
export async function updateStageProgress(data: {
  contactId: string
  persona: string
  currentStageId: string
  currentStageIndex: number
  stagesCompleted: number
  totalStages: number
}) {
  // Stage progress is now tracked via transaction_milestones.
  // journey_stage_progress is legacy — no new writes.
  // The portal reads progress from transaction_milestones directly.
  revalidatePath(`/portal/${data.contactId}`)
  revalidatePath(`/portal/${data.contactId}/journey`)
  return { success: true }
}

// Event handlers for workflow orchestration
export async function handleTaskCompletedEvent(payload: any) {
  const supabase = await createClient()
  
  // Notify agent of task completion
  try {
    const { data: contact } = await supabase
      .from("contacts")
      .select("agent_id, brokerage_id")
      .eq("id", payload.contact_id)
      .maybeSingle()
    if (contact?.agent_id) {
      await supabase.from("agent_notifications").insert({
        agent_id: contact.agent_id,
        brokerage_id: contact.brokerage_id,
        type: "task_completed",
        title: `Client completed: ${payload.task_name}`,
        body: `${payload.task_name} completed in the ${payload.stage_name} stage.`,
        data: { contact_id: payload.contact_id, task_name: payload.task_name, stage_name: payload.stage_name },
      })
    }
  } catch { /* non-critical */ }
  
  return { success: true }
}

export async function handleStageCompletedEvent(payload: any) {
  const supabase = await createClient()
  
  // Create a celebration notification. client_portal_messages canonical columns:
  // body + direction (agent_to_client) + channel + read; agent_id/brokerage_id NOT NULL.
  try {
    const { data: c } = await supabase
      .from("contacts").select("agent_id, brokerage_id").eq("id", payload.contact_id).maybeSingle()
    if (c?.agent_id && c?.brokerage_id) {
      await supabase.from("client_portal_messages").insert({
        contact_id: payload.contact_id,
        agent_id: c.agent_id,
        brokerage_id: c.brokerage_id,
        direction: "agent_to_client",
        channel: "portal",
        body: `Stage Complete: ${payload.stage_name}\n\nCongratulations! You've completed the ${payload.stage_name} stage. Moving on to ${payload.next_stage_name}.`,
        metadata: { kind: "milestone", stage_name: payload.stage_name },
        read: false,
      })
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
    const { data: c } = await supabase
      .from("contacts").select("agent_id, brokerage_id").eq("id", payload.contact_id).maybeSingle()
    if (c?.agent_id && c?.brokerage_id) {
      await supabase.from("client_portal_messages").insert({
        contact_id: payload.contact_id,
        agent_id: c.agent_id,
        brokerage_id: c.brokerage_id,
        direction: "agent_to_client",
        channel: "portal",
        body: "Journey Complete!\n\nCongratulations on completing your real estate journey! We're honored to have been part of this milestone.",
        metadata: { kind: "celebration" },
        read: false,
      })
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
