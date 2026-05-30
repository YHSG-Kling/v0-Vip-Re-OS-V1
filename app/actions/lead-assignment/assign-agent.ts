"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { evaluateAssignmentEligibility } from "@/lib/lead-assignment"
import { promoteLeadToContactService as promoteLeadToContact } from "@/lib/contact-promotion"

export interface AssignmentResult {
  success: boolean
  message: string
  assignedAgentId?: string
}

// Brokers, admins, and superadmins can assign leads. Agents cannot reassign
// leads to other agents — that's a privilege check the audit caught earlier.
const ASSIGN_ROLES = ["broker", "broker_owner", "broker_admin", "admin", "super_admin", "superadmin", "team_lead", "team_leader"]

/**
 * Assigns an agent to a qualified lead
 * - Validates eligibility first
 * - Updates leads table
 * - Logs assignment to activities
 * - Captures errors to automation_errors
 *
 * Previously: trusted caller-supplied brokerageId/agentId/assignedBy. Any
 * signed-in user could reassign any lead to any agent in any brokerage.
 * Now: brokerageId is resolved from the session, caller must have
 * broker/admin role, and lead+agent must both belong to caller's brokerage.
 */
export async function assignAgentToLead(
  leadId: string,
  agentId: string,
  _brokerageId?: string,  // ignored — derived from session
  _assignedBy?: string    // ignored — derived from session
): Promise<AssignmentResult> {
  // Auth gate
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return { success: false, message: "Unauthorized" }
  const { data: callerRow } = await authClient
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (!callerRow?.brokerage_id) return { success: false, message: "Unauthorized" }
  if (!ASSIGN_ROLES.includes(callerRow.user_type ?? "")) {
    return { success: false, message: "Only brokers and admins can assign leads" }
  }
  const brokerageId = callerRow.brokerage_id
  const assignedBy = user.id

  const supabase = createServiceClient()

  try {
    // Verify the lead belongs to caller's brokerage before doing anything
    const { data: leadRow } = await supabase
      .from("leads")
      .select("brokerage_id")
      .eq("id", leadId)
      .maybeSingle()
    if (!leadRow) return { success: false, message: "Lead not found" }
    if (leadRow.brokerage_id !== brokerageId) {
      return { success: false, message: "Forbidden" }
    }

    // Step 1: Validate eligibility
    const eligibility = await evaluateAssignmentEligibility(leadId, brokerageId)

    if (!eligibility.isEligible) {
      return {
        success: false,
        message: eligibility.reason || "Lead is not eligible for assignment"
      }
    }

    // Step 2: Verify agent exists and belongs to brokerage
    const { data: agent, error: agentError } = await supabase
      .from("agents")
      .select("id, user_id, brokerage_id")
      .eq("id", agentId)
      .eq("is_active", true)
      .single()

    if (agentError || !agent) {
      return {
        success: false,
        message: "Agent not found or inactive"
      }
    }

    if (agent.brokerage_id?.toString() !== brokerageId) {
      return {
        success: false,
        message: "Agent does not belong to the same brokerage"
      }
    }

    // Step 3: Assign agent to lead — scoped to caller's brokerage
    const { error: updateError } = await supabase
      .from("leads")
      .update({
        agent_id: agentId,
        updated_at: new Date().toISOString()
      })
      .eq("id", leadId)
      .eq("brokerage_id", brokerageId)

    if (updateError) {
      throw new Error(`Failed to assign agent: ${updateError.message}`)
    }

    // Step 4: Log assignment activity — Agent task (correct location, no changes) — activity_type: agent_assignment
    await supabase.from("activities").insert({
      contact_id: leadId,
      agent_id: agentId,
      activity_type: "agent_assignment",
      title: "Agent Assigned",
      description: `Agent assigned to lead by ${assignedBy}`,
      status: "completed",
      brokerage_id: brokerageId,
      created_at: new Date().toISOString()
    })

    console.log(`[AgentAssignment] Successfully assigned agent ${agentId} to lead ${leadId}`)

    // Step 5: TRIGGER LEAD-TO-CONTACT PROMOTION
    // The moment an agent is assigned, the relationship begins
    // Lead must be promoted to Contact (canonical lifecycle rule)
    console.log(`[v0] Triggering lead-to-contact promotion for ${leadId}`)
    
    const promotionResult = await promoteLeadToContact(leadId)
    
    if (!promotionResult.success) {
      console.error(`[v0] Failed to promote lead ${leadId}: ${promotionResult.message}`)
      // Log warning but don't fail assignment
      // The agent is assigned; promotion can be retried
      await supabase.from("automation_errors").insert({
        workflow_name: "post_assignment_promotion",
        error_message: `Agent assigned but promotion failed: ${promotionResult.message}`,
        severity: "high",
        status: "unresolved",
        context_json: JSON.stringify({
          leadId,
          agentId,
          timestamp: new Date().toISOString()
        }),
        created_at: new Date().toISOString()
      })
    } else {
      console.log(`[v0] Lead ${leadId} promoted to contact ${promotionResult.contactId}`)
    }

    return {
      success: true,
      message: "Agent successfully assigned to lead",
      assignedAgentId: agentId
    }

  } catch (error: any) {
    console.error("[assignAgentToLead] Error:", error)

    // Log to automation_errors
    await supabase.from("automation_errors").insert({
      workflow_name: "agent_assignment",
      error_message: error.message || "Unknown error during agent assignment",
      severity: "high",
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
      message: "An error occurred during agent assignment"
    }
  }
}
