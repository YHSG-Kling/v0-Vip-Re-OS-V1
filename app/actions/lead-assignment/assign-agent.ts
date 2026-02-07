"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { evaluateAssignmentEligibility } from "@/lib/lead-assignment/assignment-eligibility"
import { promoteLeadToContact } from "@/app/actions/contact-promotion/promote-lead-to-contact"

export interface AssignmentResult {
  success: boolean
  message: string
  assignedAgentId?: string
}

/**
 * Assigns an agent to a qualified lead
 * - Validates eligibility first
 * - Updates leads table
 * - Logs assignment to activities
 * - Captures errors to automation_errors
 */
export async function assignAgentToLead(
  leadId: string,
  agentId: string,
  brokerageId: string,
  assignedBy: string = "system"
): Promise<AssignmentResult> {
  const supabase = createServiceClient()

  try {
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

    // Step 3: Assign agent to lead
    const { error: updateError } = await supabase
      .from("leads")
      .update({
        agent_id: agentId,
        updated_at: new Date().toISOString()
      })
      .eq("id", leadId)

    if (updateError) {
      throw new Error(`Failed to assign agent: ${updateError.message}`)
    }

    // Step 4: Log assignment activity
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

    console.log(`[v0] Successfully assigned agent ${agentId} to lead ${leadId}`)

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
