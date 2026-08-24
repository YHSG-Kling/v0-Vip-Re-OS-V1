import { createServiceClient } from "@/lib/supabase/service"

export interface AgentActivityStatus {
  leadId: string
  agentId: string
  daysSinceAssignment: number
  hasAgentContacted: boolean
  lastAgentActivity: string | null
  lastAIActivity: string | null
  isStale: boolean
  slaStatus: "within_sla" | "approaching_sla" | "breached_sla"
  recommendedAction: string
}

/**
 * Monitors agent activity after assignment
 * 
 * Checks if agent has taken action on assigned lead
 * Does NOT reassign leads automatically
 * Does NOT stop AI ISA from continuing
 */
export async function monitorAgentActivity(
  leadId: string,
  brokerageId: string
): Promise<AgentActivityStatus> {
  const supabase = createServiceClient()

  // `brokerageId` IS THE TENANT PREDICATE (CLAUDE.md §4) — accepted here and read by
  // NOTHING until 2026-08-24. Every read below runs on the SERVICE client, which
  // bypasses RLS, keyed only on the id the caller handed in: a lead id belonging to
  // another brokerage returned that brokerage's assignment date, its agent id and its
  // activity history, and this function then published an SLA verdict about it.
  // `leads` and `activities` both carry `brokerage_id` (scripts/schema-snapshot.ts).
  //
  // FAIL CLOSED (§4): no tenant means refuse, not read wide.
  if (!brokerageId) {
    throw new Error("monitorAgentActivity requires a brokerageId — refusing an un-scoped service-client read")
  }

  console.log(`[v0] Monitoring agent activity for lead ${leadId}`)

  // Get lead details
  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("agent_id, stage_entered_at, lead_stage")
    .eq("id", leadId)
    .eq("brokerage_id", brokerageId)
    .single()

  // supabase-js RESOLVES refusals (§3). Without this the refused tenant predicate is
  // byte-identical to "this lead has no agent", and the caller is told the wrong thing.
  if (leadError && leadError.code !== "PGRST116") {
    throw new Error(`Lead lookup refused: ${leadError.message}`)
  }
  if (!lead || !lead.agent_id) {
    throw new Error("Lead not assigned to agent")
  }

  const assignmentDate = lead.stage_entered_at ? new Date(lead.stage_entered_at) : new Date()
  const now = new Date()
  const daysSinceAssignment = Math.floor((now.getTime() - assignmentDate.getTime()) / (1000 * 60 * 60 * 24))

  // Get agent activities for this lead
  const { data: agentActivities } = await supabase
    .from("activities")
    .select("created_at, activity_type")
    .eq("contact_id", leadId)
    .eq("brokerage_id", brokerageId)
    .eq("agent_id", lead.agent_id)
    .not("activity_type", "in", '("agent_assignment","ai_isa_email","ai_isa_conversation","ai_isa_qualification")')
    .order("created_at", { ascending: false })
    .limit(1)

  // Get latest AI ISA activity
  const { data: aiActivities } = await supabase
    .from("activities")
    .select("created_at, activity_type")
    .eq("contact_id", leadId)
    .eq("brokerage_id", brokerageId)
    .in("activity_type", ["ai_isa_email", "ai_isa_conversation", "ai_isa_qualification"])
    .order("created_at", { ascending: false })
    .limit(1)

  const hasAgentContacted = (agentActivities?.length || 0) > 0
  const lastAgentActivity = agentActivities?.[0]?.created_at || null
  const lastAIActivity = aiActivities?.[0]?.created_at || null

  // Determine SLA status (agent should contact within 48 hours)
  const SLA_HOURS = 48
  const slaDeadline = new Date(assignmentDate.getTime() + SLA_HOURS * 60 * 60 * 1000)
  
  let slaStatus: "within_sla" | "approaching_sla" | "breached_sla"
  if (hasAgentContacted) {
    slaStatus = "within_sla"
  } else if (now < slaDeadline) {
    // Check if we're within 12 hours of deadline
    const hoursUntilDeadline = (slaDeadline.getTime() - now.getTime()) / (1000 * 60 * 60)
    slaStatus = hoursUntilDeadline <= 12 ? "approaching_sla" : "within_sla"
  } else {
    slaStatus = "breached_sla"
  }

  // Determine if lead is stale (no agent activity AND no AI activity for 7 days)
  let isStale = false
  if (!hasAgentContacted && daysSinceAssignment >= 7) {
    isStale = true
  } else if (lastAgentActivity) {
    const daysSinceLastActivity = Math.floor(
      (now.getTime() - new Date(lastAgentActivity).getTime()) / (1000 * 60 * 60 * 24)
    )
    isStale = daysSinceLastActivity >= 7
  }

  // Recommended action
  let recommendedAction = ""
  if (slaStatus === "breached_sla") {
    recommendedAction = "Escalate to broker - agent has not contacted lead within SLA"
  } else if (slaStatus === "approaching_sla") {
    recommendedAction = "Remind agent - SLA deadline approaching"
  } else if (isStale) {
    recommendedAction = "Escalate to broker - no activity for 7 days"
  } else {
    recommendedAction = "Continue monitoring - AI ISA handling engagement"
  }

  return {
    leadId,
    agentId: lead.agent_id,
    daysSinceAssignment,
    hasAgentContacted,
    lastAgentActivity,
    lastAIActivity,
    isStale,
    slaStatus,
    recommendedAction
  }
}
