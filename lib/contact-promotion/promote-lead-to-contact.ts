/**
 * lib/contact-promotion/promote-lead-to-contact.ts
 * Canonical lib-layer implementation of lead promotion.
 * app/actions/contact-promotion/promote-lead-to-contact.ts re-exports from here.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { validatePromotionEligibility } from "./promotion-eligibility"
import { createContactFromLead, resolveContactType } from "./contact-creator"
import { deactivateLead } from "./lead-deactivator"
import { logPromotionActivity } from "./promotion-logger"
import { carryLeadHistoryToContact } from "./history-carry"
import { deliverConversionWelcome } from "./conversion-welcome"

export interface PromotionResult {
  success: boolean
  message: string
  contactId?: string
  /**
   * Non-fatal problems in the BEST-EFFORT tail of the promotion (history carry,
   * portal access). The contact exists and the promotion SUCCEEDED; these are things
   * the operator needs to know about, not reasons to unwind. Always an array on a
   * successful promotion so a caller can log it without a null check.
   */
  warnings?: string[]
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

    // Step 2: Idempotency check.
    //
    // LINK FIRST. `leads.contact_id` is the real conversion record (it is what
    // migration 039's contact_lead_history joins on, and what the history carry in
    // Step 5b stamps), so it answers "already promoted?" directly and exactly. The
    // notes-marker probe is kept ONLY as the fallback for rows converted before the
    // link was stamped — it is a string match on a free-text column, and now that the
    // lead's own notes are appended after the marker it can no longer be an equality
    // test. `like(marker%)` matches both shapes.
    //
    // tenant anchor (scope burn-down): the fallback probe stays pinned to the
    // validated lead's brokerage — the notes marker alone must never match cross-tenant.
    //
    // The link check is HOISTED ABOVE the is_active gate on purpose. Deactivation is
    // a separate statement that can fail (the branch below files an automation_errors
    // row for exactly that case), and while it was the ONLY idempotency signal a lead
    // left active-but-converted got promoted a SECOND time on the next call — two
    // contacts for one person. `contact_id` is set in the same tail as the conversion,
    // so it answers the question even when deactivation did not land. Same semantic
    // lib/kernel/crm.ts:convertLeadToContact already uses.
    if (lead.contact_id) {
      return { success: true, message: "Lead already promoted to contact", contactId: lead.contact_id as string }
    }

    if (lead.is_active === false) {
      const { data: existingContact, error: existingError } = await supabase
        .from("contacts")
        .select("id")
        .eq("brokerage_id", lead.brokerage_id)
        .like("notes", `Promoted from lead ${leadId}%`)
        .limit(1)
        .maybeSingle()

      // supabase-js RESOLVES refusals. An unread error here reports "no contact
      // found" for a lead that has one, and the caller promotes it a second time.
      if (existingError) {
        return { success: false, message: `Could not verify prior promotion: ${existingError.message}` }
      }
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

    // Everything past this point is the BEST-EFFORT TAIL. The contact EXISTS. No
    // step below may throw, roll back, or turn a successful promotion into a failure
    // — each one reports into `warnings` the same way the deactivation failure below
    // reports into automation_errors.
    const warnings: string[] = []

    // Step 5b: Carry the lead's HISTORY to the new contact.
    //
    // Runs BEFORE deactivation on purpose: deactivation is the step that ends the
    // lead's life, and the lineage link is what keeps its history reachable
    // afterwards. Stamping the link first means that even if deactivation fails, the
    // contact is not standing on an orphaned history trail.
    const carry = await carryLeadHistoryToContact(supabase, {
      leadId,
      contactId: contactResult.contactId,
      brokerageId: lead.brokerage_id ?? null,
    })
    warnings.push(...carry.warnings)
    if (Object.keys(carry.repointed).length > 0) {
      console.log(
        `[promoteLeadToContactService] history re-pointed to contact ${contactResult.contactId}:`,
        carry.repointed,
      )
    }
    // MOVED is logged separately from RE-POINTED on purpose: a move RELEASES the
    // lead_id, so it is the only half of the carry that changes what the lead-side
    // read returns. Folding the two counts together would hide that.
    if (Object.keys(carry.moved).length > 0) {
      console.log(
        `[promoteLeadToContactService] history moved to contact ${contactResult.contactId} (lead released):`,
        carry.moved,
      )
    }

    // Step 6: Deactivate lead (preserve for audit)
    const deactivateResult = await deactivateLead(supabase, leadId)
    if (!deactivateResult.success) {
      warnings.push(`lead NOT deactivated after conversion: ${deactivateResult.error ?? "unknown error"}`)
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
    const promotionLog = await logPromotionActivity(supabase, {
      leadId,
      contactId: contactResult.contactId,
      agentId: lead.agent_id,
      brokerageId: lead.brokerage_id,
      reason: "Agent assigned - relationship lifecycle begins",
    })
    if (!promotionLog.success) {
      warnings.push(`promotion activity NOT logged: ${promotionLog.error ?? "unknown error"}`)
    }

    // Step 8: THE WELCOME — PORTAL ACCESS, THE PERSONAL VIDEO, AND THE ONE EMAIL.
    //
    // OWNER RULING: "the welcome email is the first on conversion that has the
    // welcome with portal info to also inclue the embedded personal video."
    //
    // This used to be TWO steps here (portal access, then the avatar video) and the
    // welcome EMAIL was a third sender living somewhere else entirely — the invite
    // core's hardcoded generic magic-link mail, with the video arriving later in a
    // separate cron email. Three senders, one ruling. They are consolidated behind
    // ONE entry point, which lib/kernel/lead-acquisition-handlers.ts calls
    // identically: neither lane holds a copy (§6), which is the lesson recorded on
    // the history carry above.
    //
    // ORDER INSIDE IT IS LOAD-BEARING: the portal_contact_invites row is created
    // FIRST and unconditionally, so a video that cannot be produced can never cost
    // the contact their portal. Only the EMAIL waits for the render, and only when
    // a render is actually in flight — with a bounded deadline past which the
    // welcome goes without the video rather than never going at all.
    //
    // BEST EFFORT and IDEMPOTENT: Step 2 above returns early on an already-promoted
    // lead; the reactor's unique index dedupes the render before any spend; and
    // ensureClientWelcome refuses a second welcome on the rationale tag.
    const welcome = await deliverConversionWelcome(supabase, {
      contactId: contactResult.contactId,
      agentId: lead.agent_id,
      agentUserId: agent.user_id ?? null,
      brokerageId: lead.brokerage_id,
      contactType: resolveContactType(lead.motivation_type, lead.lead_type),
      firstName: lead.first_name ?? null,
      lastName: lead.last_name ?? null,
    })
    warnings.push(...welcome.warnings)
    console.log(
      `[promoteLeadToContactService] welcome for contact ${contactResult.contactId}: ` +
        `portal=${welcome.portalGranted}, video=${welcome.videoReason}, email=${welcome.timing}` +
        `${welcome.emailState ? ` (${welcome.emailState})` : ""} — ${welcome.timingReason}`,
    )

    // Step 9: THE AGENT'S FIRST-TOUCH PLAN.
    //
    // WHY IT LANDS HERE. app/dashboard/agent/page.tsx:252-259 reads
    // `activities` where activity_type='agent_action_plan' and status='pending'
    // and renders the rows under "New Assignment Plans"
    // (agent-next-best-actions.tsx:136 → ActionPlanCard). That reader shipped
    // with NO WRITER anywhere in the tree — live `agent_action_plan` row count
    // was 0 — so the section was permanently empty. CLAUDE.md §1 case 2: the
    // reader is live and the capability is wanted, so the missing half gets
    // BUILT rather than the reader deleted.
    //
    // WHY THIS MOMENT. The plan's subject is the CONTACT (owner ruling: history
    // stops on the lead and continues on the contact), and this is the first
    // instant a contact exists with an agent on it. It runs AFTER the history
    // carry on purpose: the plan's whole value is "here is what the AI ISA
    // already did", and Step 5b is what re-points that history onto
    // `contact_id`. Planning before the carry would read an empty contact.
    //
    // BEST EFFORT, like every step in this tail: the contact exists and the lead
    // is deactivated. A refused plan is a warning, never a rollback.
    {
      const { generateAgentActionPlan, persistAgentActionPlan } =
        await import("@/lib/agent-orchestration")
      const planned = await generateAgentActionPlan(
        contactResult.contactId,
        lead.agent_id,
        lead.brokerage_id,
        supabase,
      )
      if (!planned.ok) {
        warnings.push(`agent action plan NOT generated: ${planned.reason}`)
      } else {
        const persisted = await persistAgentActionPlan(supabase, planned.plan, lead.brokerage_id)
        warnings.push(...persisted.warnings)
        console.log(
          `[promoteLeadToContactService] agent action plan for contact ${contactResult.contactId}: ` +
            `${persisted.written} action(s) written, consent basis '${planned.plan.consentBasis}'`,
        )
      }
    }

    if (warnings.length > 0) {
      console.warn(`[promoteLeadToContactService] lead ${leadId} promoted WITH warnings:`, warnings)
    }

    return {
      success: true,
      message: "Lead successfully promoted to contact",
      contactId: contactResult.contactId,
      warnings,
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
