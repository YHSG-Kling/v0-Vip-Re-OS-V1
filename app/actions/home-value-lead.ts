"use server"

/**
 * Home Value lead capture — homeowner submits name + contact after seeing their estimate on the
 * public Home Value page. A "what's my home worth" request with consent is CLEAR seller intent, so it
 * must run through the MANAGED capture pipeline (lib/contact-pipeline/contact-capture.ts), not a flat
 * insert: dedup (never duplicate an existing contact) → enrichment queue → lead score → CONTACT_CAPTURED
 * kernel event → portal invite with magic link. Then hand the seller intent to the Listing Concierge.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { captureContact } from "@/lib/contact-pipeline/contact-capture"

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

  // ── Managed capture (dedup → enrich → score → portal invite → CONTACT_CAPTURED) ──
  // The property they asked about IS the homeowner's own address, so it doubles as the contact
  // address (feeds skip-trace enrichment). estimated_value + provenance ride enrichment_profile.
  let contactId: string
  try {
    const result = await captureContact({
      brokerageId: input.brokerageId,
      ownerAgentId: input.agentId,           // agents.id (contacts.agent_id contract)
      source: "home_value_form",
      first_name: firstName,
      last_name: lastName,
      email: input.email || null,
      phone: input.phone || null,
      address: input.property.address || null,
      city: input.property.city || null,
      state: input.property.state || null,
      zip_code: input.property.zip || null,
      contact_type: "seller",                // clear seller intent
      preferred_channel: input.phone ? "phone" : "email",
      tcpa_consent: input.consentToContact,
      tcpa_consent_date: new Date().toISOString(),
      tcpa_consent_source: "home_value_form",
      enrichmentProfile: {
        home_value_request: {
          property_address: input.property.address,
          estimated_value: input.property.estimatedValue,
          captured_via: "home_value_public_page",
          requested_at: new Date().toISOString(),
        },
      },
    })
    contactId = result.contactId
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed to capture contact" }
  }

  // Log the home-value-specific activity (carries the AVM context the generic capture doesn't).
  // Read the result: this row is the only record that the valuation was what
  // brought the lead in, and the follow-up copy keys off it.
  const { error: avmActivityError } = await svc.from("activities").insert({
    contact_id: contactId,
    brokerage_id: input.brokerageId,
    agent_user_id: input.agentUserId,
    activity_type: "home_value_lead_captured",
    title: "Home value lead captured",
    description: `Homeowner requested an estimate for ${input.property.address}, ${input.property.city}${
      input.property.estimatedValue ? ` — AVM: $${input.property.estimatedValue.toLocaleString()}` : ""
    }`,
    metadata: { property: input.property },
  })

  if (avmActivityError) {
    console.error("[home-value-lead] AVM activity NOT recorded:", avmActivityError.message)
  }

  // Notify the agent — surfaces in their morning brief with the AVM context.
  await svc.from("notifications").insert({
    user_id: input.agentUserId,
    brokerage_id: input.brokerageId,
    title: "🏠 New home value lead",
    body: `${input.fullName} requested a value for ${input.property.address}${
      input.property.estimatedValue ? ` — est. $${input.property.estimatedValue.toLocaleString()}` : ""
    }`,
    type: "new_lead",
    entity_type: "contact",
    entity_id: contactId,
    priority: "high",
    is_read: false,
  })

  // MANAGER-ORCHESTRATED — a "what's my home worth" request is the strongest inbound SELLER intent.
  // Hand it to the Listing Concierge over the bus so it responds like a human listing lead (a gated
  // precise-CMA follow-up), instead of leaving the lead to rot in the agent's inbox. Best-effort.
  try {
    const { publishInboundSellerIntent } = await import("@/lib/intelligence/inbound-seller-intent-runner")
    await publishInboundSellerIntent({
      brokerageId: input.brokerageId, contactId, source: "home_value_tool",
      property: { address: input.property.address, city: input.property.city, state: input.property.state, estimatedValue: input.property.estimatedValue },
    }, svc)
  } catch (err) {
    console.warn("[home-value-lead] seller-intent handoff failed:", err)
  }

  return { success: true, contactId }
}
