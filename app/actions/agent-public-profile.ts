"use server"

/**
 * Lead capture from the agent's public profile (/p/[agentSlug]).
 *
 * This is INTENTIONALLY public — visitors browsing an agent's marketing page
 * don't have a Supabase session. We can't gate this with auth.getUser().
 *
 * Previous version: trusted caller-supplied agentId / agentUserId / brokerageId,
 * so an attacker could write inquiry contacts attached to ANY (agent_id,
 * brokerage_id) pair they chose, including mismatched cross-brokerage pairs.
 *
 * Fix: validate the (agentId, agentUserId, brokerageId) triple by looking up
 * the agent row server-side and confirming all three fields are consistent.
 * Any mismatch → reject.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { queueContactEnrichment } from "@/lib/enrichment/contact-enrichment-core"

export interface ProfileLeadInput {
  agentId: string
  agentUserId: string
  brokerageId: string
  fullName: string
  email?: string
  phone?: string
  message?: string
  consentToContact: boolean
}

export async function captureProfileLead(input: ProfileLeadInput): Promise<{
  success: boolean
  contactId?: string
  error?: string
}> {
  if (!input.consentToContact) return { success: false, error: "Consent required" }
  if (!input.email && !input.phone) {
    return { success: false, error: "Email or phone required" }
  }

  const svc = createServiceClient()

  // Verify the (agentId, agentUserId, brokerageId) triple is a real, consistent
  // agent record. Without this, a caller can pass any combination of IDs and
  // get orphan / mismatched rows inserted.
  const { data: agent } = await svc
    .from("agents")
    .select("id, user_id, brokerage_id")
    .eq("id", input.agentId)
    .maybeSingle()

  if (!agent) return { success: false, error: "Agent not found" }
  if (agent.user_id !== input.agentUserId || agent.brokerage_id !== input.brokerageId) {
    return { success: false, error: "Agent identity mismatch" }
  }

  const nameParts = input.fullName.trim().split(/\s+/)
  const firstName = nameParts[0] ?? ""
  const lastName = nameParts.slice(1).join(" ") || null

  const { data: contact, error } = await svc
    .from("contacts")
    .insert({
      brokerage_id: agent.brokerage_id,
      agent_id: agent.id,
      first_name: firstName,
      last_name: lastName,
      email: input.email || null,
      phone: input.phone || null,
      contact_type: "lead",
      lifecycle_state: "new",
      source: "agent_public_profile",
      source_subtype: "profile_inquiry",
      tcpa_consent: input.consentToContact,
      tcpa_consent_source: "agent_public_profile",
      tcpa_consent_at: new Date().toISOString(),
      notes: input.message ?? null,
    })
    .select("id")
    .single()

  if (error || !contact) {
    return { success: false, error: error?.message ?? "Failed to create contact" }
  }

  // ENRICH AS SOON AS THE CONTACT COMES IN (owner's ruling). This door creates a
  // contact row directly and emits no kernel event, so the event-reactor lane
  // never saw it. Best-effort and voided: the queue write must never block or
  // fail the inquiry. Suppression (no enrichment during a live listing or
  // transaction) and de-duplication live inside queueContactEnrichment.
  void queueContactEnrichment({
    contactId: contact.id,
    brokerageId: agent.brokerage_id,
    triggerType: "agent_public_profile",
    supabase: svc,
  }).catch(() => {})

  // THIS ROW IS THE RECORD OF THE INQUIRY. The kernel's conversation memory
  // reads it back as "this person reached out"; losing it silently makes the
  // assistant believe the inquiry never happened. Read the error and say so.
  const { error: inquiryActivityError } = await svc.from("activities").insert({
    contact_id: contact.id,
    brokerage_id: agent.brokerage_id,
    agent_user_id: agent.user_id,
    activity_type: "profile_inquiry",
    description: `Inquiry from agent public profile: ${input.message ? `"${input.message}"` : "general contact request"}`,
    metadata: { source: "agent_public_profile" },
  })
  if (inquiryActivityError) {
    console.error("[agentPublicProfile] profile_inquiry activity REJECTED — the contact's timeline will not show this inquiry:", inquiryActivityError.message)
  }

  await svc.from("notifications").insert({
    user_id: agent.user_id,
    brokerage_id: agent.brokerage_id,
    title: "📩 New profile inquiry",
    body: `${input.fullName} reached out from your public profile${input.message ? `: "${input.message}"` : ""}`,
    type: "new_lead",
    entity_type: "contact",
    entity_id: contact.id,
    priority: "high",
    is_read: false,
  })

  return { success: true, contactId: contact.id }
}
