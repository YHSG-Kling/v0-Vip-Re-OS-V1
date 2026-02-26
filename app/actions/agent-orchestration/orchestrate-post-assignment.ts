"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { generateAgentActionPlan, monitorAgentActivity } from "@/lib/agent-orchestration"

/**
 * AGENT ORCHESTRATION SYSTEM - POST-ASSIGNMENT COORDINATOR
 * 
 * Called immediately after agent assignment
 * 
 * WHAT IT DOES:
 * - Generates AI-recommended action plan for the agent
 * - Logs the plan as an activity for agent to review
 * - AI ISA CONTINUES running in parallel (emails, follow-ups, qualification)
 * 
 * WHAT IT DOES NOT DO:
 * - Does NOT wait for agent to act
 * - Does NOT stop AI automation
 * - Does NOT contact the lead (agent does that)
 * - Does NOT reassign leads
 */
export async function orchestratePostAssignment(
  leadId: string,
  agentId: string,
  brokerageId: string
) {
  console.log(`[v0] Orchestrating post-assignment for lead ${leadId}, agent ${agentId}`)

  const supabase = createServiceClient()

  try {
    // Step 1: Generate action plan for agent
    const actionPlan = await generateAgentActionPlan(leadId, agentId, brokerageId)

    console.log(`[v0] Generated ${actionPlan.recommendedActions.length} recommended actions for agent`)

    // Step 2: Log action plan as activity (so agent sees it)
    const planDescription = actionPlan.recommendedActions
      .map((item, idx) => `${idx + 1}. [${item.priority.toUpperCase()}] ${item.action} - ${item.reason}`)
      .join("\n\n")

    await supabase.from("activities").insert({
      contact_id: leadId,
      agent_id: agentId,
      activity_type: "agent_action_plan",
      title: "Recommended Action Plan",
      description: `${actionPlan.aiContextSummary}\n\n---\n\nRECOMMENDED ACTIONS:\n\n${planDescription}`,
      status: "pending",
      priority: "high",
      brokerage_id: brokerageId,
      created_at: new Date().toISOString()
    })

    console.log(`[v0] Action plan logged to activities table`)

    // Step 3: Log orchestration decision
    await supabase.from("activities").insert({
      contact_id: leadId,
      activity_type: "system_orchestration",
      title: "Post-Assignment Orchestration Complete",
      description: `Agent ${agentId} assigned. Action plan generated. AI ISA will continue engagement in parallel.`,
      status: "completed",
      brokerage_id: brokerageId,
      created_at: new Date().toISOString()
    })

    // IMPORTANT: AI ISA continues running regardless of agent actions
    // We do NOT wait for the agent to act
    // We do NOT stop AI follow-ups
    // Agent actions and AI actions coexist

    return {
      success: true,
      actionPlan,
      message: "Post-assignment orchestration complete. Agent has action plan. AI ISA continues."
    }

  } catch (error: any) {
    console.error("[orchestratePostAssignment] Error:", error)

    // Log error
    await supabase.from("automation_errors").insert({
      workflow_name: "post_assignment_orchestration",
      error_message: error.message || "Unknown error",
      severity: "medium",
      status: "unresolved",
      context_json: JSON.stringify({
        leadId,
        agentId,
        brokerageId,
        timestamp: new Date().toISOString()
      }),
      created_at: new Date().toISOString()
    })

    return {
      success: false,
      error: error.message
    }
  }
}

/**
 * AGENT INACTIVITY MONITORING
 * 
 * Checks if agent is inactive beyond SLA
 * If breached, escalates to broker
 * 
 * DOES NOT:
 * - Reassign the lead automatically
 * - Stop AI ISA from continuing
 * - Contact the lead
 */
export async function checkAndEscalateInactivity(
  leadId: string,
  brokerageId: string
) {
  console.log(`[v0] Checking agent inactivity for lead ${leadId}`)

  const supabase = createServiceClient()

  try {
    // Monitor activity
    const status = await monitorAgentActivity(leadId, brokerageId)

    // If SLA breached or lead is stale, escalate
    if (status.slaStatus === "breached_sla" || status.isStale) {
      console.log(`[v0] Escalating to broker - ${status.recommendedAction}`)

      // Log escalation
      await supabase.from("activities").insert({
        contact_id: leadId,
        agent_id: status.agentId,
        activity_type: "broker_escalation",
        title: "Agent Inactivity - Escalated to Broker",
        description: `Lead assigned ${status.daysSinceAssignment} days ago. ${status.hasAgentContacted ? "Last agent activity: " + status.lastAgentActivity : "Agent has not contacted lead"}. AI ISA continues engagement. Broker review required.`,
        status: "pending",
        priority: "high",
        brokerage_id: brokerageId,
        created_at: new Date().toISOString()
      })

      // TODO: Send notification to broker (email, SMS, in-app)

      return {
        success: true,
        escalated: true,
        status,
        message: "Escalated to broker due to agent inactivity"
      }
    } else {
      console.log(`[v0] Agent activity within acceptable range. Status: ${status.slaStatus}`)

      return {
        success: true,
        escalated: false,
        status,
        message: "Agent activity is within acceptable range"
      }
    }

  } catch (error: any) {
    console.error("[checkAndEscalateInactivity] Error:", error)

    // Log error
    await supabase.from("automation_errors").insert({
      workflow_name: "agent_inactivity_monitoring",
      error_message: error.message || "Unknown error",
      severity: "medium",
      status: "unresolved",
      context_json: JSON.stringify({
        leadId,
        brokerageId,
        timestamp: new Date().toISOString()
      }),
      created_at: new Date().toISOString()
    })

    return {
      success: false,
      error: error.message
    }
  }
}
