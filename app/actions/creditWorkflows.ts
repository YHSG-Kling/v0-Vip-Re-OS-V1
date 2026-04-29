"use server"

import { supabaseService } from "@/services/supabaseService"

// =====================================================
// CREDIT & LENDER INTEGRATION WORKFLOWS
// =====================================================

export async function triggerCreditIntake(contactId: string, agentId: string) {
  try {
    const contact = await supabaseService.getContactById(contactId)
    if (!contact) {
      return { success: false, error: "Contact not found" }
    }

    // Create credit intake record
    await supabaseService.createRecord("credit_intakes", {
      contact_id: contactId,
      agent_id: agentId,
      contact_name: `${contact.first_name} ${contact.last_name}`,
      contact_email: contact.email,
      contact_phone: contact.phone,
      status: "pending",
      intake_type: "credit_repair",
      created_at: new Date().toISOString(),
    })

    // Log interaction
    await supabaseService.createInteraction({
      contact_id: contactId,
      interaction_type: "credit_intake_started",
      interaction_date: new Date().toISOString(),
      notes: "Credit intake process initiated",
      outcome: "pending",
    })

    return { success: true, message: `Credit intake started for ${contact.first_name} ${contact.last_name}` }
  } catch (error: any) {
    console.error("[Workflow] Credit intake failed:", error)
    return { success: false, error: error.message }
  }
}

export async function triggerCreditReferral(contactId: string, agentId: string, partnerId?: string) {
  try {
    const contact = await supabaseService.getContactById(contactId)
    if (!contact) {
      return { success: false, error: "Contact not found" }
    }

    // Create credit referral record
    const referral = await supabaseService.createRecord("partner_referrals", {
      contact_id: contactId,
      agent_id: agentId,
      partner_id: partnerId,
      partner_type: "credit_repair",
      status: "sent",
      contact_name: `${contact.first_name} ${contact.last_name}`,
      contact_email: contact.email,
      contact_phone: contact.phone,
      notes: "Credit repair referral",
      created_at: new Date().toISOString(),
    })

    // Log interaction
    await supabaseService.createInteraction({
      contact_id: contactId,
      interaction_type: "credit_referral_sent",
      interaction_date: new Date().toISOString(),
      notes: "Referred to credit repair partner",
      outcome: "sent",
    })

    return { success: true, message: "Credit referral sent", referralId: referral?.id }
  } catch (error: any) {
    console.error("[Workflow] Credit referral failed:", error)
    return { success: false, error: error.message }
  }
}

export async function triggerLenderReferral(contactId: string, agentId: string, lenderId?: string) {
  try {
    const contact = await supabaseService.getContactById(contactId)
    if (!contact) {
      return { success: false, error: "Contact not found" }
    }

    // Create lender referral record
    const referral = await supabaseService.createRecord("partner_referrals", {
      contact_id: contactId,
      agent_id: agentId,
      partner_id: lenderId,
      partner_type: "lender",
      status: "sent",
      contact_name: `${contact.first_name} ${contact.last_name}`,
      contact_email: contact.email,
      contact_phone: contact.phone,
      notes: "Lender referral for pre-approval",
      created_at: new Date().toISOString(),
    })

    // Log interaction
    await supabaseService.createInteraction({
      contact_id: contactId,
      interaction_type: "lender_referral_sent",
      interaction_date: new Date().toISOString(),
      notes: "Referred to lending partner",
      outcome: "sent",
    })

    return { success: true, message: "Lender referral sent", referralId: referral?.id }
  } catch (error: any) {
    console.error("[Workflow] Lender referral failed:", error)
    return { success: false, error: error.message }
  }
}
