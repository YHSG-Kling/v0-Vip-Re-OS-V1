"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"

/**
 * Execute AI-powered tool for workflow automation.
 * Routes to appropriate handler based on tool name.
 */
export async function executeAITool(toolName: string, inputData: any, context: any) {
  try {
    // Route to appropriate AI tool handler
    const handlers: Record<string, Function> = {
      "fair-housing-check": checkFairHousingCompliance,
      "generate-plan": generateCopilotPlan,
      "send-message": sendMessage,
      "calculate-metrics": calculateListingMetrics,
    }

    const handler = handlers[toolName]
    if (!handler) {
      return { success: false, error: `Unknown tool: ${toolName}` }
    }

    return await handler(inputData, context)
  } catch (error: any) {
    console.error("[executeAITool] Error:", error)
    return { success: false, error: error?.message ?? "Tool execution failed" }
  }
}

/**
 * Check message content for fair housing compliance violations.
 */
export async function checkFairHousingCompliance(
  userId: string,
  contentType: string,
  text: string
): Promise<{ success: boolean; compliant: boolean; violations?: string[] }> {
  try {
    const supabase = await createClient()
    const { brokerageId, isAuthenticated } = await getAgentContext()

    if (!isAuthenticated) return { success: false, compliant: false }

    // Fair Housing compliance check patterns
    const fairHousingViolations = [
      { pattern: /familial status|children|pregnant/gi, rule: "No familial status discrimination" },
      { pattern: /disability|handicap|medical condition/gi, rule: "No disability discrimination" },
      { pattern: /religion|church|synagogue|mosque/gi, rule: "No religious discrimination" },
      { pattern: /race|color|ethnicity/gi, rule: "No racial discrimination" },
      { pattern: /national origin|immigrant/gi, rule: "No national origin discrimination" },
      { pattern: /gender|sexual orientation|LGBTQ/gi, rule: "No gender/orientation discrimination" },
      { pattern: /age|senior|elderly/gi, rule: "No age discrimination" },
    ]

    const violations: string[] = []
    fairHousingViolations.forEach(({ pattern, rule }) => {
      if (pattern.test(text)) {
        violations.push(rule)
      }
    })

    // Log compliance check
    if (violations.length > 0 && brokerageId) {
      await supabase.from("activities").insert({
        brokerage_id: brokerageId,
        entity_type: "compliance",
        activity_type: "fair_housing_violation_detected",
        title: "Fair Housing Violation Detected",
        description: violations.join("; "),
        status: "flagged",
      })
    }

    return {
      success: true,
      compliant: violations.length === 0,
      violations: violations.length > 0 ? violations : undefined,
    }
  } catch (error: any) {
    console.error("[checkFairHousingCompliance] Error:", error)
    return { success: false, compliant: false }
  }
}

/**
 * Generate a 7-day copilot plan for a contact.
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

    // Get contact info
    const { data: contact } = await supabase
      .from("contacts")
      .select("first_name, last_name, contact_type, buyer_stage, status, last_contacted_at")
      .eq("id", contactId)
      .maybeSingle()

    if (!contact) return { success: false, error: "Contact not found" }

    // Generate plan via AI
    const { generateObject } = await import("ai")
    const { anthropic } = await import("@ai-sdk/anthropic")
    const { z } = await import("zod")

    const { object: plan } = await generateObject({
      model: anthropic("claude-sonnet-4-20250514"),
      schema: z.object({
        plan_name: z.string(),
        next_action: z.string(),
        next_action_date: z.string(),
        steps: z.array(
          z.object({
            day: z.number(),
            action: z.string(),
            channel: z.enum(["email", "sms", "call", "task", "portal"]),
          })
        ),
      }),
      prompt: `Create a 7-day follow-up plan for a contact.

Contact: ${contact.first_name} ${contact.last_name}
Type: ${contact.contact_type ?? "unknown"}
Stage: ${contact.buyer_stage ?? contact.status ?? "new"}
Last contacted: ${contact.last_contacted_at ? new Date(contact.last_contacted_at).toLocaleDateString() : "never"}

Generate a specific 7-day plan with daily actions.`,
    })

    // Archive existing plan
    await supabase
      .from("copilot_plans")
      .update({ status: "superseded", updated_at: new Date().toISOString() })
      .eq("contact_id", contactId)
      .eq("status", "active")

    // Insert new plan
    const { data: newPlan } = await supabase
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
      })
      .select()
      .single()

    return { success: true, plan: newPlan }
  } catch (error: any) {
    console.error("[generateCopilotPlan] Error:", error)
    return { success: false, error: error?.message ?? "Failed to generate plan" }
  }
}

/**
 * Start a smart drip campaign for a contact.
 */
export async function startSmartDrip(
  contactId: string,
  drip_type: string,
  agentId: string
): Promise<{ success: boolean; dripId?: string; error?: string }> {
  try {
    const supabase = await createClient()
    const { brokerageId, isAuthenticated } = await getAgentContext()

    if (!isAuthenticated) return { success: false, error: "Not authenticated" }
    if (!brokerageId) return { success: false, error: "No brokerage context" }

    const { data: drip } = await supabase
      .from("drip_campaigns")
      .insert({
        contact_id: contactId,
        agent_id: agentId,
        brokerage_id: brokerageId,
        drip_type,
        status: "active",
      })
      .select()
      .single()

    return { success: true, dripId: drip?.id }
  } catch (error: any) {
    return { success: false, error: error?.message ?? "Failed to start drip" }
  }
}

/**
 * Send a message to a contact.
 */
export async function sendMessage(
  contactId: string,
  message: string,
  channel: string,
  agentId: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const supabase = await createClient()
    const { brokerageId, isAuthenticated } = await getAgentContext()

    if (!isAuthenticated) return { success: false, error: "Not authenticated" }

    const { data: msg } = await supabase
      .from("messages")
      .insert({
        contact_id: contactId,
        agent_id: agentId,
        brokerage_id: brokerageId,
        content: message,
        channel,
        status: "sent",
      })
      .select()
      .single()

    return { success: true, messageId: msg?.id }
  } catch (error: any) {
    return { success: false, error: error?.message ?? "Failed to send message" }
  }
}

/**
 * Calculate real estate listing metrics.
 */
export async function calculateListingMetrics(listingId: string, params: any = {}) {
  try {
    const supabase = await createClient()
    const { brokerageId, isAuthenticated } = await getAgentContext()

    if (!isAuthenticated) return { success: false, error: "Not authenticated" }

    const { data: listing } = await supabase
      .from("listings")
      .select("*")
      .eq("id", listingId)
      .maybeSingle()

    if (!listing) return { success: false, error: "Listing not found" }

    // Calculate metrics
    const metrics = {
      price_per_sqft: listing.price && listing.square_feet ? listing.price / listing.square_feet : null,
      dom_percentile: null, // Would be calculated from market data
      market_position: "neutral",
    }

    return { success: true, metrics }
  } catch (error: any) {
    return { success: false, error: error?.message ?? "Failed to calculate metrics" }
  }
}

/**
 * Trigger CMA package generation.
 */
export async function triggerCMAPackage(
  propertyId: string,
  agentId: string
): Promise<{ success: boolean; packageId?: string; error?: string }> {
  try {
    const supabase = await createClient()
    const { brokerageId, isAuthenticated } = await getAgentContext()

    if (!isAuthenticated) return { success: false, error: "Not authenticated" }

    const { data: pkg } = await supabase
      .from("cma_packages")
      .insert({
        property_id: propertyId,
        agent_id: agentId,
        brokerage_id: brokerageId,
        status: "generating",
      })
      .select()
      .single()

    return { success: true, packageId: pkg?.id }
  } catch (error: any) {
    return { success: false, error: error?.message ?? "Failed to trigger CMA" }
  }
}

/**
 * Grant portal access to a contact.
 */
export async function grantPortalAccess(
  contactId: string,
  accessType: string,
  agentId: string
): Promise<{ success: boolean; accessId?: string; error?: string }> {
  try {
    const supabase = await createClient()
    const { brokerageId, isAuthenticated } = await getAgentContext()

    if (!isAuthenticated) return { success: false, error: "Not authenticated" }

    const { data: access } = await supabase
      .from("portal_access")
      .insert({
        contact_id: contactId,
        agent_id: agentId,
        brokerage_id: brokerageId,
        access_type: accessType,
        status: "active",
      })
      .select()
      .single()

    return { success: true, accessId: access?.id }
  } catch (error: any) {
    return { success: false, error: error?.message ?? "Failed to grant portal access" }
  }
}

/**
 * Trigger compliance checklist for a transaction.
 */
export async function triggerComplianceChecklist(
  transactionId: string,
  agentId: string
): Promise<{ success: boolean; checklistId?: string; error?: string }> {
  try {
    const supabase = await createClient()
    const { brokerageId, isAuthenticated } = await getAgentContext()

    if (!isAuthenticated) return { success: false, error: "Not authenticated" }

    const { data: checklist } = await supabase
      .from("compliance_checklists")
      .insert({
        transaction_id: transactionId,
        agent_id: agentId,
        brokerage_id: brokerageId,
        status: "active",
      })
      .select()
      .single()

    return { success: true, checklistId: checklist?.id }
  } catch (error: any) {
    return { success: false, error: error?.message ?? "Failed to trigger compliance checklist" }
  }
}

/**
 * Generate marketing script content.
 */
export async function generateScriptContent(
  scriptType: string,
  context: any,
  agentId: string
): Promise<{ success: boolean; content?: string; error?: string }> {
  try {
    const supabase = await createClient()
    const { brokerageId, isAuthenticated } = await getAgentContext()

    if (!isAuthenticated) return { success: false, error: "Not authenticated" }

    const { generateText } = await import("ai")
    const { anthropic } = await import("@ai-sdk/anthropic")

    const { text: script } = await generateText({
      model: anthropic("claude-sonnet-4-20250514"),
      prompt: `Generate a ${scriptType} script for a real estate agent. Context: ${JSON.stringify(context)}`,
    })

    // Store generated script
    await supabase.from("scripts").insert({
      agent_id: agentId,
      brokerage_id: brokerageId,
      script_type: scriptType,
      content: script,
      status: "generated",
    })

    return { success: true, content: script }
  } catch (error: any) {
    return { success: false, error: error?.message ?? "Failed to generate script" }
  }
}

/**
 * Send a newsletter campaign.
 */
export async function sendNewsletterCampaign(
  campaignId: string,
  agentId: string
): Promise<{ success: boolean; sentCount?: number; error?: string }> {
  try {
    const supabase = await createClient()
    const { brokerageId, isAuthenticated } = await getAgentContext()

    if (!isAuthenticated) return { success: false, error: "Not authenticated" }

    const { data: campaign } = await supabase
      .from("newsletter_campaigns")
      .select("*")
      .eq("id", campaignId)
      .single()

    if (!campaign) return { success: false, error: "Campaign not found" }

    // Mark campaign as sent
    await supabase
      .from("newsletter_campaigns")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("id", campaignId)

    return { success: true, sentCount: campaign.recipient_count }
  } catch (error: any) {
    return { success: false, error: error?.message ?? "Failed to send campaign" }
  }
}

/**
 * Retry a failed workflow execution.
 */
export async function retryFailedWorkflow(
  workflowId: string,
  agentId: string
): Promise<{ success: boolean; retryId?: string; error?: string }> {
  try {
    const supabase = await createClient()
    const { brokerageId, isAuthenticated } = await getAgentContext()

    if (!isAuthenticated) return { success: false, error: "Not authenticated" }

    const { data: retry } = await supabase
      .from("workflow_executions")
      .insert({
        workflow_id: workflowId,
        agent_id: agentId,
        brokerage_id: brokerageId,
        status: "retrying",
      })
      .select()
      .single()

    return { success: true, retryId: retry?.id }
  } catch (error: any) {
    return { success: false, error: error?.message ?? "Failed to retry workflow" }
  }
}

/**
 * Log user activity for audit trail.
 */
export async function logUserActivity(
  userId: string,
  activity: string,
  details: any = {}
): Promise<{ success: boolean; activityId?: string }> {
  try {
    const supabase = await createClient()
    const { brokerageId } = await getAgentContext()

    const { data: log } = await supabase
      .from("audit_log")
      .insert({
        user_id: userId,
        brokerage_id: brokerageId,
        action: activity,
        details,
        created_at: new Date().toISOString(),
      })
      .select()
      .single()

    return { success: true, activityId: log?.id }
  } catch (error: any) {
    console.error("[logUserActivity] Error:", error)
    return { success: true } // Don't fail user action if logging fails
  }
}
