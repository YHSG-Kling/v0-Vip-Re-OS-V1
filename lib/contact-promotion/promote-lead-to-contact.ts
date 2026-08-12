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

  // TENANT ANCHOR, HOISTED ABOVE THE TRY ON PURPOSE.
  //
  // The catch below files an automation_errors row, and `lead` is scoped INSIDE
  // the try — so a tenant resolved there is not a tenant the catch can use. The
  // alternative, looking the lead up again from inside the error handler, is the
  // trap this wave was warned about: that lookup can itself be refused or throw,
  // and losing the ORIGINAL error to a failure in the code that reports it is
  // strictly worse than filing the error with less context. So the anchor is a
  // plain variable, filled the moment the lead read succeeds and never touched
  // again.
  let promotionBrokerageId: string | null = null

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

    // The lead IS the record every row in this function is filed against, so its
    // brokerage is the anchor for both automation_errors writes below.
    promotionBrokerageId = (lead.brokerage_id as string | null) ?? null

    // Step 2: Idempotency check
    // tenant anchor (scope burn-down): the probe is pinned to the validated
    // lead's brokerage — the notes marker alone must never match cross-tenant.
    if (lead.is_active === false) {
      const { data: existingContact } = await supabase
        .from("contacts")
        .select("id")
        .eq("brokerage_id", lead.brokerage_id)
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
      // TENANT — the lead's own brokerage, resolved once above. This is the
      // worst-shaped failure this function has (a contact exists and the lead is
      // still active, so the pair will be promoted again), and unstamped it is
      // both invisible in the automations console and un-resolvable through it,
      // because `workflows.ts:531` uses `.eq("brokerage_id", …)` as an ownership
      // check and returns "Forbidden" on a miss.
      if (!promotionBrokerageId) {
        console.error(
          `[promoteLeadToContactService] lead ${leadId} carries no brokerage_id — deactivation-failure row NOT written rather than written where the console can neither see nor resolve it`,
        )
      } else {
        const { error: deactivateLogError } = await supabase.from("automation_errors").insert({
          brokerage_id: promotionBrokerageId,
          workflow_name: "lead_promotion",
          error_message: `Contact created but lead deactivation failed: ${deactivateResult.error}`,
          severity: "high",
          status: "open",
          context_json: JSON.stringify({ leadId, contactId: contactResult.contactId, timestamp: new Date().toISOString() }),
          created_at: new Date().toISOString(),
        })
        if (deactivateLogError) {
          console.error("[promoteLeadToContactService] automation_errors insert refused:", deactivateLogError.message)
        }
      }
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
    // TENANT — the hoisted anchor. It is null only when the failure happened
    // BEFORE the lead was read, which is exactly the case where no tenant exists
    // to attribute the failure to; the original error is already on the console
    // above, so nothing is lost by not filing an unreadable row.
    if (!promotionBrokerageId) {
      console.error(
        `[promoteLeadToContactService] no brokerage resolved for lead ${leadId} before the failure — automation_errors row NOT written rather than written where the console can neither see nor resolve it`,
      )
    } else {
      const { error: promotionLogError } = await supabase.from("automation_errors").insert({
        brokerage_id: promotionBrokerageId,
        workflow_name: "lead_promotion",
        error_message: error.message || "Unknown error during lead promotion",
        severity: "critical",
        status: "open",
        context_json: JSON.stringify({ leadId, timestamp: new Date().toISOString() }),
        created_at: new Date().toISOString(),
      })
      if (promotionLogError) {
        console.error("[promoteLeadToContactService] automation_errors insert refused:", promotionLogError.message)
      }
    }
    return { success: false, message: "An error occurred during lead promotion" }
  }
}
