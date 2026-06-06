"use server"

/**
 * Home Value lead capture — homeowner submits name + contact after seeing
 * their estimate on the public Home Value page. Creates a contact under
 * the agent's brokerage with source='home_value_tool', captures consent,
 * notifies the agent.
 */

import { createServiceClient } from "@/lib/supabase/service"

export interface HomeValueLeadInput {
  agentId: string
  brokerageId: string
  agentUserId: string
  fullName: string
  email: string
  phone?: string
  consentToContact: boolean   // TCPA consent — required to enable phone/SMS outreach
  property: {
    address: string
    city: string
    state: string
    zip?: string
    estimatedValue: number | null
  }
}

export async function captureHomeValueLead(input: HomeValueLeadInput): Promise<{
  success: boolean
  contactId?: string
  error?: string
}> {
  if (!input.consentToContact) {
    return { success: false, error: "Consent to contact is required" }
  }
  if (!input.email && !input.phone) {
    return { success: false, error: "Email or phone is required" }
  }

  const svc = createServiceClient()

  // Split name
  const nameParts = input.fullName.trim().split(/\s+/)
  const firstName = nameParts[0] ?? ""
  const lastName = nameParts.slice(1).join(" ") || null

  // Create contact directly (consent captured via the form — TCPA-compliant)
  const { data: contact, error } = await svc
    .from("contacts")
    .insert({
      brokerage_id: input.brokerageId,
      agent_id: input.agentId,
      first_name: firstName,
      last_name: lastName,
      email: input.email || null,
      phone: input.phone || null,
      contact_type: "lead",                    // not yet qualified
      lifecycle_state: "new",
      source: "home_value_tool",
      source_subtype: "public_avm_page",
      tcpa_consent: input.consentToContact,
      tcpa_consent_source: "home_value_form",
      tcpa_consent_at: new Date().toISOString(),
      metadata: {
        property_of_interest: {
          address: input.property.address,
          city: input.property.city,
          state: input.property.state,
          zip: input.property.zip,
          estimated_value: input.property.estimatedValue,
        },
        captured_via: "home_value_public_page",
      },
    })
    .select("id")
    .single()

  if (error || !contact) {
    return { success: false, error: error?.message ?? "Failed to create contact" }
  }

  // Log activity on the contact timeline
  await svc.from("activities").insert({
    contact_id: contact.id,
    brokerage_id: input.brokerageId,
    agent_user_id: input.agentUserId,
    activity_type: "home_value_lead_captured",
    title: "Home value lead captured",
    description: `Homeowner requested an estimate for ${input.property.address}, ${input.property.city}${
      input.property.estimatedValue ? ` — AVM: $${input.property.estimatedValue.toLocaleString()}` : ""
    }`,
    metadata: {
      property: input.property,
    },
  })

  // Notify the agent — surfaces in their morning brief
  await svc.from("notifications").insert({
    user_id: input.agentUserId,
    brokerage_id: input.brokerageId,
    title: "🏠 New home value lead",
    body: `${input.fullName} requested a value for ${input.property.address}${
      input.property.estimatedValue ? ` — est. $${input.property.estimatedValue.toLocaleString()}` : ""
    }`,
    type: "new_lead",
    entity_type: "contact",
    entity_id: contact.id,
    priority: "high",
    is_read: false,
  })

  return { success: true, contactId: contact.id }
}
