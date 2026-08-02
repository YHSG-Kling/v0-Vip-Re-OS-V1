"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity"

/**
 * SECURITY: every entry point that mutates per-tenant data verifies the
 * target row (contact/listing/transaction/campaign/etc.) belongs to the
 * authenticated brokerage BEFORE performing any write. Caller-supplied
 * brokerage_id / user_id values are never trusted — they are always derived
 * from getAgentContext().
 */

// Helper: assert a row from `table` with `id` belongs to `brokerageId`.
// Returns the row when valid; returns null on missing/forbidden so the caller
// can short-circuit. Uses the service client so RLS doesn't mask the check.
async function assertOwnership(
  table: string,
  id: string,
  brokerageId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const svc = createServiceClient()
  const { data } = await svc.from(table).select("brokerage_id").eq("id", id).maybeSingle()
  if (!data) return { ok: false, error: `${table} not found` }
  if (data.brokerage_id !== brokerageId) return { ok: false, error: "Forbidden" }
  return { ok: true }
}

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
  _userId: string | undefined, // ignored — derived from session
  contentType: string,
  text: string
): Promise<{ success: boolean; compliant: boolean; violations?: string[] }> {
  try {
    const supabase = await createClient()
    const ctx = await getAgentContext()

    if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, compliant: false }
    const brokerageId = ctx.brokerageId

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
    if (violations.length > 0) {
      // A COMPLIANCE VIOLATION record. Losing it silently is losing the evidence
      // that the violation was detected at all.
      const { error: violationLogError } = await supabase.from("activities").insert({
        brokerage_id: brokerageId,
        entity_type: "compliance",
        activity_type: "fair_housing_violation_detected",
        title: "Fair Housing Violation Detected",
        description: violations.join("; "),
        status: "flagged",
      })
      if (violationLogError) {
        console.error("[checkFairHousingCompliance] violation NOT logged:", violationLogError.message)
      }
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
  _agentId?: string // ignored — derived from session
): Promise<{ success: boolean; plan?: any; error?: string }> {
  try {
    const supabase = await createClient()
    const ctx = await getAgentContext()

    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }
    if (!ctx.brokerageId) return { success: false, error: "No brokerage context" }
    const brokerageId = ctx.brokerageId
    const agentId = ctx.agentId

    // Verify contact ownership
    const own = await assertOwnership("contacts", contactId, brokerageId)
    if (!own.ok) return { success: false, error: own.error }

    // Get contact info
    const { data: contact } = await supabase
      .from("contacts")
      .select("first_name, last_name, contact_type, buyer_stage, status, last_contacted_at")
      .eq("id", contactId)
      .maybeSingle()

    if (!contact) return { success: false, error: "Contact not found" }

    // Generate plan via AI — use resolveModel so the Vercel AI Gateway handles routing.
    // Never import provider SDKs directly; they require separate API keys.
    const { generateObject } = await import("@/lib/ai/generate")
    const { resolveModel } = await import("@/lib/ai/resolve-model")
    const { z } = await import("zod")

    const { object: plan } = await generateObject({
      model: resolveModel("openai/gpt-4o-mini"),
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
  _agentId?: string // ignored — derived from session
): Promise<{ success: boolean; dripId?: string; error?: string }> {
  try {
    const supabase = await createClient()
    const ctx = await getAgentContext()

    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }
    if (!ctx.brokerageId) return { success: false, error: "No brokerage context" }
    const brokerageId = ctx.brokerageId
    const agentId = ctx.agentId

    // Verify contact ownership
    const own = await assertOwnership("contacts", contactId, brokerageId)
    if (!own.ok) return { success: false, error: own.error }

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
  _agentId?: string // ignored — derived from session
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const supabase = await createClient()
    const ctx = await getAgentContext()

    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }
    if (!ctx.brokerageId) return { success: false, error: "No brokerage context" }
    const brokerageId = ctx.brokerageId
    const agentId = ctx.agentId

    // Verify contact ownership
    const own = await assertOwnership("contacts", contactId, brokerageId)
    if (!own.ok) return { success: false, error: own.error }

    // messages.conversation_id is NOT NULL — resolve or create the thread via
    // the ONE canonical helper (keep-one; this file had the original inline copy).
    const { ensureConversationForContact } = await import("@/lib/kernel/conversation-thread")
    const conversationId = await ensureConversationForContact(supabase, { contactId, brokerageId, agentId })
    if (!conversationId) return { success: false, error: "Could not resolve conversation" }

    const { data: msg } = await supabase
      .from("messages")
      .insert({
        conversation_id: conversationId,
        contact_id: contactId,
        agent_id: agentId,
        brokerage_id: brokerageId,
        type: channel,        // real column for the medium (email/sms/in_app)
        direction: "outbound",
        body: message,        // real column (was phantom "content")
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
export async function calculateListingMetrics(listingId: string, _params: any = {}) {
  try {
    const supabase = await createClient()
    const ctx = await getAgentContext()

    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }
    if (!ctx.brokerageId) return { success: false, error: "No brokerage context" }

    // Verify listing ownership
    const own = await assertOwnership("listings", listingId, ctx.brokerageId)
    if (!own.ok) return { success: false, error: own.error }

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
  _agentId?: string // ignored — derived from session
): Promise<{ success: boolean; packageId?: string; error?: string }> {
  try {
    const supabase = await createClient()
    const ctx = await getAgentContext()

    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }
    if (!ctx.brokerageId) return { success: false, error: "No brokerage context" }
    const brokerageId = ctx.brokerageId
    const agentId = ctx.agentId

    // Verify property/listing ownership (CMA packages target listings)
    const own = await assertOwnership("listings", propertyId, brokerageId)
    if (!own.ok) return { success: false, error: own.error }

    // NOTE: cma_reports is the canonical CMA content table (read across the app).
    // The old cma_packages insert here created a status:'generating' row that was
    // never updated or read anywhere — dead write removed (keep-one sweep).

    return { success: true }
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
  _agentId?: string // ignored — derived from session
): Promise<{ success: boolean; accessId?: string; error?: string }> {
  try {
    const supabase = await createClient()
    const ctx = await getAgentContext()

    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }
    if (!ctx.brokerageId) return { success: false, error: "No brokerage context" }
    const brokerageId = ctx.brokerageId
    const agentId = ctx.agentId

    // Verify contact ownership
    const own = await assertOwnership("contacts", contactId, brokerageId)
    if (!own.ok) return { success: false, error: own.error }

    // portal_access_logs is the canonical portal-access-log table. Map the
    // legacy access_type → action; the active/inactive flag lives in metadata
    // since the real schema doesn't carry a `status` column.
    const { data: access } = await supabase
      .from("portal_access_logs")
      .insert({
        contact_id: contactId,
        agent_id: agentId,
        brokerage_id: brokerageId,
        module_key: "portal",
        action: accessType,
        metadata: { status: "active" },
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
  _agentId?: string // ignored — derived from session
): Promise<{ success: boolean; checklistId?: string; error?: string }> {
  try {
    const supabase = await createClient()
    const ctx = await getAgentContext()

    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }
    if (!ctx.brokerageId) return { success: false, error: "No brokerage context" }
    const brokerageId = ctx.brokerageId
    const agentId = ctx.agentId

    // Verify transaction ownership
    const own = await assertOwnership("transactions", transactionId, brokerageId)
    if (!own.ok) return { success: false, error: own.error }

    // compliance_checklists has no agent_id/status; checklist_type is NOT NULL.
    const { data: checklist } = await supabase
      .from("compliance_checklists")
      .insert({
        transaction_id: transactionId,
        brokerage_id: brokerageId,
        checklist_type: "disclosures",
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
  _agentId?: string // ignored — derived from session
): Promise<{ success: boolean; content?: string; error?: string }> {
  try {
    const supabase = await createClient()
    const ctx = await getAgentContext()

    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }
    if (!ctx.brokerageId) return { success: false, error: "No brokerage context" }
    const brokerageId = ctx.brokerageId
    const agentId = ctx.agentId

    const { generateText } = await import("ai")
    const { anthropic } = await import("@ai-sdk/anthropic")

    const { text: script } = await generateText({
      model: anthropic("claude-sonnet-4-20250514"),
      prompt: `Generate a ${scriptType} script for a real estate agent. Context: ${JSON.stringify(context)}`,
    })

    // Store generated script. scripts is scoped by created_by (no agent_id/brokerage_id);
    // title is NOT NULL; script_type→category; status CHECK is draft|approved|archived.
    await supabase.from("scripts").insert({
      title: `${scriptType} script`,
      category: scriptType,
      content: script,
      status: "draft",
      created_by: ctx.userId,
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
  _agentId?: string // ignored — derived from session
): Promise<{ success: boolean; sentCount?: number; error?: string }> {
  try {
    const supabase = await createClient()
    const ctx = await getAgentContext()

    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }
    if (!ctx.brokerageId) return { success: false, error: "No brokerage context" }

    // newsletter_campaigns has no brokerage_id column — scope ownership via
    // created_by = caller's user id. Brokerage-wide visibility isn't modelled
    // on this table yet; this prevents cross-tenant send commands.
    const svc = createServiceClient()
    const { data: campaign } = await svc
      .from("newsletter_campaigns")
      .select("*")
      .eq("id", campaignId)
      .maybeSingle()
    if (!campaign) return { success: false, error: "Campaign not found" }
    if (campaign.created_by && campaign.created_by !== ctx.userId) {
      return { success: false, error: "Forbidden" }
    }

    // Mark campaign as sent
    await supabase
      .from("newsletter_campaigns")
      .update({ status: "sent", send_date: new Date().toISOString() })
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
  _agentId?: string // ignored — derived from session
): Promise<{ success: boolean; retryId?: string; error?: string }> {
  try {
    const supabase = await createClient()
    const ctx = await getAgentContext()

    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }
    if (!ctx.brokerageId) return { success: false, error: "No brokerage context" }
    const brokerageId = ctx.brokerageId
    void supabase

    // The retired Engine A's workflow_executions retry table is gone. A "failed
    // workflow" is now an automation_errors row (the automations console). Verify
    // ownership, then RESOLVE the error — the retry acknowledges + clears it.
    // workflowId here is the automation_errors.id.
    const svc = createServiceClient()
    const { data: errRow } = await svc
      .from("automation_errors")
      .select("id, brokerage_id")
      .eq("id", workflowId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    if (!errRow) {
      return { success: false, error: "Forbidden" }
    }

    const { error: updErr } = await svc
      .from("automation_errors")
      .update({
        status: "resolved",
        resolved_at: new Date().toISOString(),
        resolved_by: ctx.userId,
        resolution_notes: "Retried from the automations console",
      })
      .eq("id", workflowId)
    if (updErr) {
      return { success: false, error: updErr.message }
    }

    return { success: true, retryId: workflowId }
  } catch (error: any) {
    return { success: false, error: error?.message ?? "Failed to retry workflow" }
  }
}

/**
 * Log user activity for audit trail.
 */
export async function logUserActivity(
  _userId: string | undefined, // ignored — derived from session
  activity: string,
  details: any = {}
): Promise<{ success: boolean; activityId?: string }> {
  try {
    const supabase = await createClient()
    const ctx = await getAgentContext()

    if (!ctx.isAuthenticated) return { success: true } // silently no-op for unauth

    const { data: log } = await supabase
      .from("audit_log")
      .insert({
        user_id: ctx.userId,
        action: activity,
        after: details ?? null, // canonical payload column (no brokerage_id/details columns)
      })
      .select()
      .single()

    return { success: true, activityId: log?.id }
  } catch (error: any) {
    console.error("[logUserActivity] Error:", error)
    return { success: true } // Don't fail user action if logging fails
  }
}

export async function executeWorkflow(workflowId: string, contextData: Record<string, unknown> = {}) {
  try {
    return await executeAITool(workflowId, contextData, {})
  } catch (error: any) {
    console.error("[executeWorkflow] Error:", error)
    return { success: false, error: error?.message ?? "Workflow execution failed" }
  }
}
