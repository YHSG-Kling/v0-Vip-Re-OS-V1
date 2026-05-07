"use server"

/**
 * Lead capture from the agent's public profile (/p/[agentSlug]).
 * Mirrors home-value-lead.ts but for general inquiries from the profile page.
 */

import { createServiceClient } from "@/lib/supabase/service"

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

  const nameParts = input.fullName.trim().split(/\s+/)
  const firstName = nameParts[0] ?? ""
  const lastName = nameParts.slice(1).join(" ") || null

  const { data: contact, error } = await svc
    .from("contacts")
    .insert({
      brokerage_id: input.brokerageId,
      agent_id: input.agentId,
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

  await svc.from("activities").insert({
    contact_id: contact.id,
    brokerage_id: input.brokerageId,
    agent_user_id: input.agentUserId,
    activity_type: "profile_inquiry",
    description: `Inquiry from agent public profile: ${input.message ? `"${input.message}"` : "general contact request"}`,
    metadata: { source: "agent_public_profile" },
  })

  await svc.from("notifications").insert({
    user_id: input.agentUserId,
    brokerage_id: input.brokerageId,
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
