"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"

/**
 * Generate a 7-day copilot plan for a contact.
 * Writes the plan to the activities table (entity_type = 'contact') and
 * creates/updates a row in copilot_plans so the CRM page can read it back.
 */
export async function generateCopilotPlan(
  contactId: string,
  agentId: string
): Promise<{ success: boolean; plan?: any; error?: string }> {
  try {
    const supabase = await createClient()
    const { brokerageId, isAuthenticated } = await getAgentContext()

    if (!isAuthenticated) return { success: false, error: "Not authenticated" }
    if (!brokerageId) return { success: false, error: "No brokerage context" }

    // Get contact info for personalized plan
    const { data: contact } = await supabase
      .from("contacts")
      .select("first_name, last_name, contact_type, buyer_stage, status, last_contacted_at")
      .eq("id", contactId)
      .maybeSingle()

    if (!contact) return { success: false, error: "Contact not found" }

    // Generate plan steps via AI
    const { generateObject } = await import("ai")
    const { anthropic } = await import("@ai-sdk/anthropic")
    const { z } = await import("zod")

    const { object: plan } = await generateObject({
      model: anthropic("claude-sonnet-4-20250514"),
      schema: z.object({
        plan_name: z.string(),
        next_action: z.string(),
        next_action_date: z.string(), // ISO date YYYY-MM-DD
        steps: z.array(
          z.object({
            day: z.number(),
            action: z.string(),
            channel: z.enum(["email", "sms", "call", "task", "portal"]),
          })
        ),
      }),
      prompt: `Create a concise 7-day follow-up plan for a real estate agent's contact.

Contact: ${contact.first_name} ${contact.last_name}
Type: ${contact.contact_type ?? "unknown"}
Stage: ${contact.buyer_stage ?? contact.status ?? "new"}
Last contacted: ${contact.last_contacted_at ? new Date(contact.last_contacted_at).toLocaleDateString() : "never"}

Generate a realistic, specific 7-day plan with daily actions. The next_action should be the most important immediate step. next_action_date should be today ${new Date().toISOString().split("T")[0]}.`,
    })

    // Archive any existing active plan for this contact
    await supabase
      .from("copilot_plans")
      .update({ status: "superseded", updated_at: new Date().toISOString() })
      .eq("contact_id", contactId)
      .eq("status", "active")

    // Insert new copilot plan
    const { data: newPlan, error: planError } = await supabase
      .from("copilot_plans")
      .insert({
        contact_id: contactId,
        agent_id: agentId,
        brokerage_id: brokerageId,
        plan_name: plan.plan_name,
        next_action: plan.next_action,
        next_action_date: plan.next_action_date,
        status: "active",
        plan_data: plan.steps,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (planError) {
      console.error("[generateCopilotPlan] Insert error:", planError)
      return { success: false, error: planError.message }
    }

    // Log as activity so the timeline shows this plan was generated
    await supabase.from("activities").insert({
      brokerage_id: brokerageId,
      agent_id: agentId,
      contact_id: contactId,
      activity_type: "ai_plan_generated",
      title: `AI Copilot Plan: ${plan.plan_name}`,
      description: plan.next_action,
      notes: JSON.stringify(plan.steps),
      entity_type: "contact",
      status: "active",
      priority: "high",
    })

    return { success: true, plan: newPlan }
  } catch (error: any) {
    console.error("[generateCopilotPlan] Error:", error)
    return { success: false, error: error?.message ?? "Failed to generate plan" }
  }
}
