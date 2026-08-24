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

  // `brokerageId` IS THE TENANT PREDICATE (CLAUDE.md §4). It was accepted here and
  // read by NOTHING until 2026-08-24: all three reads below run on the SERVICE
  // client — which bypasses RLS — keyed only on the id the caller handed in, so a
  // lead id from another brokerage produced that brokerage's lead, its activity
  // history and its message counts. `leads`, `activities` and `messages` all carry
  // `brokerage_id` (scripts/schema-snapshot.ts).
  //
  // FAIL CLOSED (§4): with no tenant this refuses rather than running the un-scoped
  // read. "Nobody checked" must never render as "checked and fine".
  if (!brokerageId) {
    throw new Error("generateAgentActionPlan requires a brokerageId — refusing an un-scoped service-client read")
  }

  console.log(`[v0] Generating action plan for agent ${agentId}, lead ${leadId}`)

  // Get lead details
  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("*")
    .eq("id", leadId)
    .eq("brokerage_id", brokerageId)
    .single()

  // supabase-js RESOLVES refusals (§3) — a swallowed error here is indistinguishable
  // from "no such lead", and both used to surface as the same bare throw.
  if (leadError && leadError.code !== "PGRST116") {
    throw new Error(`Lead lookup refused: ${leadError.message}`)
  }
  if (!lead) {
    throw new Error("Lead not found")
  }

  // Get AI ISA activity history
  const { data: aiActivities } = await supabase
    .from("activities")
    .select("*")
    .eq("contact_id", leadId)
    .eq("brokerage_id", brokerageId)
    .in("activity_type", ["ai_isa_email", "ai_isa_conversation", "ai_isa_qualification"])
    .order("created_at", { ascending: false })
    .limit(10)

  // Get conversation count
  const { data: messages } = await supabase
    .from("messages")
    .select("id, direction")
    .eq("contact_id", leadId)
    .eq("brokerage_id", brokerageId)

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

/**
 * `aiActivities` IS THE PLAN'S EVIDENCE — it was passed in and read by NOTHING until
 * 2026-08-24, so the plan told every agent to "review the AI qualification summary"
 * even when the AI had never touched the lead, and told them to "send a personal
 * introduction email" as the fourth unanswered email in a row. The caller has always
 * loaded the history; only the branch that spends it was missing.
 */
function determineRecommendedActions(lead: any, hasReplied: boolean, aiActivities: any[]): ActionPlanItem[] {
  const actions: ActionPlanItem[] = []

  const aiEmailCount = aiActivities.filter(a => a.activity_type === "ai_isa_email").length
  const hasQualification = aiActivities.some(a => a.activity_type === "ai_isa_qualification")
  const hasAnyAiTouch = aiActivities.length > 0

  // Action 1: Review what the AI actually produced — but only when it produced
  // something. An empty history means there is nothing to review, and sending the
  // agent to an empty summary is how a plan loses its credibility.
  if (hasAnyAiTouch) {
    actions.push({
      action: hasQualification
        ? "Review AI qualification summary and conversation history"
        : "Review AI conversation history",
      priority: "high",
      reason: hasQualification
        ? `AI has qualified this lead across ${aiActivities.length} logged touch${aiActivities.length > 1 ? "es" : ""} — read it before making contact`
        : `AI has ${aiActivities.length} logged touch${aiActivities.length > 1 ? "es" : ""} but no qualification yet — read what it has before making contact`,
      suggestedTiming: "Within 2 hours of assignment"
    })
  } else {
    actions.push({
      action: "Make first contact yourself — AI has not engaged this lead yet",
      priority: "high",
      reason: "No AI ISA activity is logged against this lead, so there is no summary to review",
      suggestedTiming: "Within 2 hours of assignment"
    })
  }

  // Action 2: If lead has replied to AI
  if (hasReplied) {
    actions.push({
      action: "Respond personally to lead's reply",
      priority: "high",
      reason: "Lead is engaged and expecting human follow-up",
      suggestedTiming: "Within 4 hours"
    })
  } else if (aiEmailCount >= 3) {
    // Three unanswered AI emails is not an argument for a fourth. Change channel.
    actions.push({
      action: "Change channel — call or text instead of another email",
      priority: "high",
      reason: `AI has already sent ${aiEmailCount} emails with no reply; another email is the least likely thing to work`,
      suggestedTiming: "Within 24 hours"
    })
  } else {
    // Action 2: If lead has NOT replied
    actions.push({
      action: "Send personal introduction email",
      priority: "medium",
      reason: aiEmailCount > 0
        ? `Introduce yourself — AI has sent ${aiEmailCount} email${aiEmailCount > 1 ? "s" : ""} with no reply, so a human name in the inbox is the change`
        : "Introduce yourself while AI continues automated follow-ups",
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
