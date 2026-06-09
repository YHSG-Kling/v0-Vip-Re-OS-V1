/**
 * Creates a contact record from a promoted lead
 * 
 * Critical Rules:
 * - Only copy relationship-safe data
 * - Do NOT copy internal intelligence fields (lead_score, enrichment_status)
 * - Associate with agent and brokerage
 * - Contacts represent active relationships
 */

import { peopleDataProfileToContactColumns } from '@/lib/lead-pipeline/enrichment-column-map'

export interface ContactCreationData {
  leadId: string
  lead: any
  agentId: string
  brokerageId: string
}

export async function createContactFromLead(
  supabase: any,
  data: ContactCreationData
): Promise<{ contactId?: string; error?: string }> {
  
  try {
    // Map lead data to contact schema
    // Only copy relationship-safe fields
    const contactData = {
      // Basic identity
      first_name: data.lead.first_name,
      last_name: data.lead.last_name,
      email: data.lead.email,
      phone: data.lead.phone,
      // Carry the secondary phone upward (leads -> contacts). Independently gateable so a
      // DNC/opt-out on one line never silently drops the other reachable number.
      phone_secondary: data.lead.phone_secondary ?? null,

      // Attribution
      source: data.lead.source || 'lead_promotion',

      // Relationship context
      agent_id: data.agentId,
      brokerage_id: data.brokerageId,

      // Contact type and persona (if available)
      contact_type: data.lead.lead_type || 'prospect',
      contact_persona: data.lead.contact_persona,

      // Intent indicators (if available)
      timeline: data.lead.timeline,
      intent_score: data.lead.intent_score,

      // Address — carry BOTH the physical address and the MAILING address upward, faithfully.
      // A contact can own a property but not live there, so the mailing breakdown is kept
      // distinct from the physical address (raw/leads/contacts now share the same field set).
      address:                  data.lead.address ?? null,
      city:                     data.lead.city ?? null,
      state:                    data.lead.state ?? null,
      zip_code:                 data.lead.zip_code ?? null,
      mailing_address:          data.lead.mailing_address ?? null,
      mailing_address_source:   data.lead.mailing_address_source ?? null,
      mailing_address_verified: data.lead.mailing_address_verified ?? null,
      mailing_city:             data.lead.mailing_city ?? null,
      mailing_state:            data.lead.mailing_state ?? null,
      mailing_zip:              data.lead.mailing_zip ?? null,

      // Consent provenance — carry over what was captured during the lead phase. Faithful (no
      // fabricated consent) — converted contacts inherit exactly the consent state on the lead, so
      // downstream phone/SMS gates evaluate against real captured consent (TCPA-safe).
      tcpa_consent:        data.lead.tcpa_consent ?? null,
      tcpa_consent_date:   data.lead.tcpa_consent_at ?? null,
      tcpa_consent_ip:     data.lead.tcpa_consent_ip ?? null,
      tcpa_consent_source: data.lead.tcpa_consent_source ?? null,
      tcpa_consent_text:   data.lead.tcpa_consent_text ?? null,

      // Suppression flags also carry forward so the contact never "loses" an opt-out at conversion.
      email_opt_out:        data.lead.email_opt_out        ?? false,
      sms_opt_out:          data.lead.sms_opt_out          ?? false,
      phone_opt_out:        data.lead.phone_opt_out        ?? false,
      direct_mail_opt_out:  data.lead.direct_mail_opt_out  ?? false,
      opted_out_at:         data.lead.opted_out_at         ?? null,

      // Enrichment — conserve everything PeopleData gave the lead so promotion is LOSSLESS.
      // The full payload travels as enrichment_profile (jsonb), and the demographic / financial /
      // social fields are ALSO promoted into the contacts first-class columns (age_range,
      // household_income, home_owner_status, occupation, education_level, social URLs, life_events,
      // peopledata_id, enriched_at, enrichment_source) so they're queryable on the contact, not
      // stranded in jsonb. Without this, an enriched lead lost its whole profile at promotion.
      ...peopleDataProfileToContactColumns(data.lead.enrichment_profile, {
        enrichedAt: data.lead.last_enriched_at ?? undefined,
      }),
      enrichment_profile:    data.lead.enrichment_profile ?? null,
      enrichment_confidence: data.lead.enrichment_confidence ?? null,
      last_enriched_at:      data.lead.last_enriched_at ?? null,
      equity_estimate:       data.lead.equity_estimate ?? null,
      email_verified:        data.lead.email_verified ?? null,

      // Status
      status: 'active',

      // Metadata
      notes: `Promoted from lead ${data.leadId}`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }

    const { data: contact, error } = await supabase
      .from("contacts")
      .insert(contactData)
      .select()
      .single()

    if (error) {
      throw new Error(`Failed to create contact: ${error.message}`)
    }

    return { contactId: contact.id }

  } catch (error: any) {
    console.error("[createContactFromLead] Error:", error)
    return {
      error: error.message || "Failed to create contact"
    }
  }
}
