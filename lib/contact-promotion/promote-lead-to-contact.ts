/**
 * lib/contact-promotion/promote-lead-to-contact.ts
 * Canonical lib-layer implementation of lead promotion.
 * app/actions/contact-promotion/promote-lead-to-contact.ts re-exports from here.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { validatePromotionEligibility } from "./promotion-eligibility"
import { createContactFromLead } from "./contact-creator"
import { deactivateLead } from "./lead-deactivator"
import { logPromotionActivity } from "./promotion-logger"

export interface PromotionResult {
  success: boolean
  message: string
  contactId?: string
}

export async function promoteLeadToContactService(
  leadId: string
): Promise<PromotionResult> {
  const supabase = createServiceClient()

  try {
    // Step 1: Fetch lead
    const { data: lead, error: leadError } = await supabase
      .from("leads")
      .select("*")
      .eq("id", leadId)
      .single()

    if (leadError || !lead) {
      return { success: false, message: "Lead not found" }
    }

    // Step 2: Idempotency check
    if (lead.is_active === false) {
      const { data: existingContact } = await supabase
        .from("contacts")
        .select("id")
        .eq("notes", `Promoted from lead ${leadId}`)
        .limit(1)
        .single()

      if (existingContact) {
        return { success: true, message: "Lead already promoted to contact", contactId: existingContact.id }
      }
      return { success: false, message: "Lead is inactive but no contact found" }
    }

    // Step 3: Validate eligibility
    const eligibility = await validatePromotionEligibility(lead)
    if (!eligibility.isEligible) {
      return { success: false, message: eligibility.reason }
    }

    // Step 4: Verify agent
    const { data: agent, error: agentError } = await supabase
      .from("agents")
      .select("id, user_id, brokerage_id")
      .eq("id", lead.agent_id)
      .eq("is_active", true)
      .single()

    if (agentError || !agent) {
      return { success: false, message: "Assigned agent not found or inactive" }
    }

    // Step 5: Create contact
    const contactResult = await createContactFromLead(supabase, {
      leadId,
      lead,
      agentId: lead.agent_id,
      brokerageId: lead.brokerage_id,
    })

    if (contactResult.error || !contactResult.contactId) {
      throw new Error(contactResult.error || "Failed to create contact")
    }

    // Step 6: Deactivate lead (preserve for audit)
    const deactivateResult = await deactivateLead(supabase, leadId)
    if (!deactivateResult.success) {
      await supabase.from("automation_errors").insert({
        workflow_name: "lead_promotion",
        error_message: `Contact created but lead deactivation failed: ${deactivateResult.error}`,
        severity: "high",
        status: "open",
        context_json: JSON.stringify({ leadId, contactId: contactResult.contactId, timestamp: new Date().toISOString() }),
        created_at: new Date().toISOString(),
      })
    }

    // Step 7: Log audit trail
    await logPromotionActivity(supabase, {
      leadId,
      contactId: contactResult.contactId,
      agentId: lead.agent_id,
      brokerageId: lead.brokerage_id,
      reason: "Agent assigned - relationship lifecycle begins",
    })

    return {
      success: true,
      message: "Lead successfully promoted to contact",
      contactId: contactResult.contactId,
    }
  } catch (error: any) {
    console.error("[promoteLeadToContactService] Error:", error)
    await supabase.from("automation_errors").insert({
      workflow_name: "lead_promotion",
      error_message: error.message || "Unknown error during lead promotion",
      severity: "critical",
      status: "open",
      context_json: JSON.stringify({ leadId, timestamp: new Date().toISOString() }),
      created_at: new Date().toISOString(),
    })
    return { success: false, message: "An error occurred during lead promotion" }
  }
}
