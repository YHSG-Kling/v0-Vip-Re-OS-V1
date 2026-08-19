import { createServiceClient } from "@/lib/supabase/service"
import type { StandardTimeline } from "@/constants/crm-standards"

/**
 * The `leads.timeline` members that warrant a direct phone call rather than
 * seven more days of AI nurture. Typed against the one vocabulary so a renamed
 * or dropped member is a type error, not a silently unreachable branch.
 */
const URGENT_TIMELINES: readonly StandardTimeline[] = ["immediate", "1-3_months"]

export interface ActionPlanItem {
  action: string
  priority: "high" | "medium" | "low"
  reason: string
  suggestedTiming: string
}

export interface ActionPlan {
  leadId: string
  agentId: string
  planGeneratedAt: string
  recommendedActions: ActionPlanItem[]
  aiContextSummary: string
}

/**
 * Generates AI-recommended action plan for agents when leads are assigned
 * 
 * This does NOT execute actions - it only recommends what the agent should do
 * AI ISA continues operating independently regardless of agent actions
 */
export async function generateAgentActionPlan(
  leadId: string,
  agentId: string,
  brokerageId: string
): Promise<ActionPlan> {
  const supabase = createServiceClient()

  console.log(`[v0] Generating action plan for agent ${agentId}, lead ${leadId}`)

  // Get lead details
  const { data: lead } = await supabase
    .from("leads")
    .select("*")
    .eq("id", leadId)
    .single()

  if (!lead) {
    throw new Error("Lead not found")
  }

  // Get AI ISA activity history
  const { data: aiActivities } = await supabase
    .from("activities")
    .select("*")
    .eq("contact_id", leadId)
    .in("activity_type", ["ai_isa_email", "ai_isa_conversation", "ai_isa_qualification"])
    .order("created_at", { ascending: false })
    .limit(10)

  // Get conversation count
  const { data: messages } = await supabase
    .from("messages")
    .select("id, direction")
    .eq("contact_id", leadId)

  const inboundCount = messages?.filter(m => m.direction === "inbound").length || 0
  const hasReplied = inboundCount > 0

  // Build AI context summary
  const aiContextSummary = buildContextSummary(lead, aiActivities || [], hasReplied)

  // Generate recommended actions based on lead state
  const recommendedActions = determineRecommendedActions(lead, hasReplied, aiActivities || [])

  return {
    leadId,
    agentId,
    planGeneratedAt: new Date().toISOString(),
    recommendedActions,
    aiContextSummary
  }
}

function buildContextSummary(lead: any, aiActivities: any[], hasReplied: boolean): string {
  const parts: string[] = []

  // Lead score and qualification
  if (lead.lead_score) {
    parts.push(`Lead Score: ${lead.lead_score}/100`)
  }

  // Motivation
  if (lead.motivation_type) {
    parts.push(`Motivation: ${lead.motivation_type}${lead.motivation_confidence ? ` (${Math.round(lead.motivation_confidence * 100)}% confidence)` : ""}`)
  }

  // Timeline
  if (lead.timeline) {
    parts.push(`Timeline: ${lead.timeline}`)
  }

  // AI engagement history
  const emailsSent = aiActivities.filter(a => a.activity_type === "ai_isa_email").length
  if (emailsSent > 0) {
    parts.push(`AI sent ${emailsSent} email${emailsSent > 1 ? "s" : ""}`)
  }

  if (hasReplied) {
    parts.push("Lead has replied to AI")
  }

  return parts.join(" | ")
}

function determineRecommendedActions(lead: any, hasReplied: boolean, aiActivities: any[]): ActionPlanItem[] {
  const actions: ActionPlanItem[] = []

  // Action 1: Review AI qualification summary (always first)
  actions.push({
    action: "Review AI qualification summary and conversation history",
    priority: "high",
    reason: "Understand what AI has learned about this lead before making contact",
    suggestedTiming: "Within 2 hours of assignment"
  })

  // Action 2: If lead has replied to AI
  if (hasReplied) {
    actions.push({
      action: "Respond personally to lead's reply",
      priority: "high",
      reason: "Lead is engaged and expecting human follow-up",
      suggestedTiming: "Within 4 hours"
    })
  } else {
    // Action 2: If lead has NOT replied
    actions.push({
      action: "Send personal introduction email",
      priority: "medium",
      reason: "Introduce yourself while AI continues automated follow-ups",
      suggestedTiming: "Within 24 hours"
    })
  }

  // Action 3: Schedule call if timeline is urgent
  //
  // REPOINTED to the one timeline vocabulary (constants/crm-standards.ts:
  // STANDARD_TIMELINES). "1-3 months" was the SPACED spelling and matched
  // nothing, so a lead one-to-three months out was routed down the "monitor for
  // 7 days" branch — the opposite of what this rule says it does.
  if (URGENT_TIMELINES.includes(lead.timeline as StandardTimeline)) {
    actions.push({
      action: "Attempt phone call to schedule consultation",
      priority: "high",
      reason: `Lead timeline is ${lead.timeline} - warrants direct contact`,
      suggestedTiming: "Within 48 hours"
    })
  } else {
    actions.push({
      action: "Monitor AI engagement for 7 days before calling",
      priority: "low",
      reason: "Let AI build rapport first, then follow up personally",
      suggestedTiming: "After 7 days of AI engagement"
    })
  }

  // Action 4: Review property interest
  if (lead.property_interest || lead.budget_min || lead.budget_max) {
    actions.push({
      action: "Prepare relevant property listings for lead",
      priority: "medium",
      reason: "Show you understand their needs from day one",
      suggestedTiming: "Before first call"
    })
  }

  return actions
}
