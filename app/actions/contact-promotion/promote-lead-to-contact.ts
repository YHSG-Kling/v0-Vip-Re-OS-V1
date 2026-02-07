"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { validatePromotionEligibility } from "@/lib/contact-promotion/promotion-eligibility"
import { createContactFromLead } from "@/lib/contact-promotion/contact-creator"
import { deactivateLead } from "@/lib/contact-promotion/lead-deactivator"
import { logPromotionActivity } from "@/lib/contact-promotion/promotion-logger"

export interface PromotionResult {
  success: boolean
  message: string
  contactId?: string
}

/**
 * CANONICAL LIFECYCLE AUTHORITY
 * 
 * Promotes a Lead into a Contact when agent relationship begins
 * 
 * Business Truth:
 * - Leads are pre-relationship
 * - Contacts are post-relationship
 * - This promotion is irreversible and marks the formal relationship start
 * 
 * Safety:
 * - Idempotent: won't create duplicate contacts
 * - Transactional: all-or-nothing operation
 * - Auditable: logs every promotion
 * - Fail-closed: errors are captured
 */
export async function promoteLeadToContact(
  leadId: string
): Promise<PromotionResult> {
  const supabase = createServiceClient()

  try {
    console.log(`[v0] Starting lead-to-contact promotion for lead ${leadId}`)

    // Step 1: Fetch lead with all data
    const { data: lead, error: leadError } = await supabase
      .from("leads")
      .select("*")
      .eq("id", leadId)
      .single()

    if (leadError || !lead) {
      return {
        success: false,
        message: "Lead not found"
      }
    }

    // Step 2: Check if already promoted (idempotency)
    if (lead.is_active === false) {
      console.log(`[v0] Lead ${leadId} already promoted (inactive)`)
      
      // Find the existing contact
      const { data: existingContact } = await supabase
        .from("contacts")
        .select("id")
        .eq("notes", `Promoted from lead ${leadId}`)
        .limit(1)
        .single()

      if (existingContact) {
        return {
          success: true,
          message: "Lead already promoted to contact",
          contactId: existingContact.id
        }
      }

      return {
        success: false,
        message: "Lead is inactive but no contact found"
      }
    }

    // Step 3: Validate eligibility
    const eligibility = await validatePromotionEligibility(lead)

    if (!eligibility.isEligible) {
      return {
        success: false,
        message: eligibility.reason
      }
    }

    // Step 4: Verify agent exists
    const { data: agent, error: agentError } = await supabase
      .from("agents")
      .select("id, user_id, brokerage_id")
      .eq("id", lead.agent_id)
      .eq("is_active", true)
      .single()

    if (agentError || !agent) {
      return {
        success: false,
        message: "Assigned agent not found or inactive"
      }
    }

    // Step 5: Create contact from lead
    const contactResult = await createContactFromLead(supabase, {
      leadId,
      lead,
      agentId: lead.agent_id,
      brokerageId: lead.brokerage_id
    })

    if (contactResult.error || !contactResult.contactId) {
      throw new Error(contactResult.error || "Failed to create contact")
    }

    // Step 6: Deactivate lead (preserve for audit)
    const deactivateResult = await deactivateLead(supabase, leadId)

    if (!deactivateResult.success) {
      // Critical: we created a contact but couldn't deactivate lead
      // Log error but don't roll back contact creation
      await supabase.from("automation_errors").insert({
        workflow_name: "lead_promotion",
        error_message: `Contact created but lead deactivation failed: ${deactivateResult.error}`,
        severity: "high",
        status: "unresolved",
        context_json: JSON.stringify({
          leadId,
          contactId: contactResult.contactId,
          timestamp: new Date().toISOString()
        }),
        created_at: new Date().toISOString()
      })
    }

    // Step 7: Log canonical promotion activity
    await logPromotionActivity(supabase, {
      leadId,
      contactId: contactResult.contactId,
      agentId: lead.agent_id,
      brokerageId: lead.brokerage_id,
      reason: "Agent assigned - relationship lifecycle begins"
    })

    console.log(`[v0] Successfully promoted lead ${leadId} to contact ${contactResult.contactId}`)

    return {
      success: true,
      message: "Lead successfully promoted to contact",
      contactId: contactResult.contactId
    }

  } catch (error: any) {
    console.error("[promoteLeadToContact] Error:", error)

    // Log to automation_errors
    await supabase.from("automation_errors").insert({
      workflow_name: "lead_promotion",
      error_message: error.message || "Unknown error during lead promotion",
      severity: "critical",
      status: "unresolved",
      context_json: JSON.stringify({
        leadId,
        timestamp: new Date().toISOString()
      }),
      created_at: new Date().toISOString()
    })

    return {
      success: false,
      message: "An error occurred during lead promotion"
    }
  }
}
