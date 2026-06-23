/**
 * Creates a contact record from a promoted lead — THE canonical lead→contact
 * converter (Data Steward owned). Canonical business process: leads are AI-ISA +
 * brokerage owned while unconsented; the moment the ISA qualifies, the lead is
 * CONVERTED to a contact with the agent resolved by the contact-assignment
 * settings (agent → team lead → team-lead/brokerage admin → platform).
 *
 * Critical Rules:
 * - LOSSLESS: identity + physical/mailing address + secondary phone + enrichment
 *   profile + ISA qualification carry all move upward (nothing dropped at the hop).
 * - agentId MUST be agents.id (contacts.agent_id FK semantics per migration 111 —
 *   a users.id here makes the contact INVISIBLE to the agent's CRM via RLS).
 * - Do NOT copy internal pipeline fields (enrichment_status etc.).
 */

import { peopleDataProfileToContactColumns } from '@/lib/lead-pipeline/enrichment-column-map'

export interface ContactCreationData {
  leadId: string
  lead: any
  /** agents.id of the assigned agent (NOT users.id). */
  agentId: string
  brokerageId: string
}

/**
 * The ISA qualified the lead by intent; that intent IS the contact type going
 * forward (canonical contact_type vocabulary): buyer/seller/investor; 'both'
 * maps to buyer with persona 'both'.
 */
export function motivationToContactType(m: string | null | undefined): string | null {
  if (!m) return null
  const lower = m.toLowerCase()
  if (lower.includes('investor')) return 'investor'
  if (lower.includes('seller')) return 'seller'
  if (lower.includes('both')) return 'buyer'
  if (lower.includes('buyer')) return 'buyer'
  return null
}

export async function createContactFromLead(
  supabase: any,
  data: ContactCreationData
): Promise<{ contactId?: string; error?: string }> {
  
  try {
    // The contact belongs to the assigned agent's OFFICE + TEAM, so resolve them from the agent and
    // stamp them on the contact. Without this every converted contact landed with location_id/team_id
    // = null, so any location/team-scoped contacts query (the command center, a location admin's CRM,
    // scoped reporting) silently excluded it even though its agent sits in that office. Best-effort —
    // a missing agent row just leaves them null (same as before).
    let agentLocationId: string | null = null
    let agentTeamId: string | null = null
    {
      const { data: agentRow } = await supabase
        .from("agents")
        .select("location_id, team_id")
        .eq("id", data.agentId)
        .maybeSingle()
      agentLocationId = agentRow?.location_id ?? null
      agentTeamId = agentRow?.team_id ?? null
    }

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

      // Attribution — full source provenance moves upward
      source: data.lead.source || 'lead_promotion',
      source_family: data.lead.source_family ?? null,
      source_channel: data.lead.source_channel ?? null,
      source_subtype: data.lead.source_subtype ?? null,

      // Relationship context (agentId is agents.id — see ContactCreationData)
      agent_id: data.agentId,
      brokerage_id: data.brokerageId,
      // Office + team inherited from the assigned agent so the contact rolls up to the right
      // location/team in scoped reporting and the command center.
      location_id: agentLocationId,
      team_id: agentTeamId,

      // Contact type and persona — the ISA's qualified intent IS the contact type
      contact_type:
        motivationToContactType(data.lead.motivation_type) ??
        motivationToContactType(data.lead.lead_type) ??
        (data.lead.lead_type || 'prospect'),
      contact_persona:
        (data.lead.motivation_type ?? '').toLowerCase().includes('both')
          ? 'both'
          : (data.lead.contact_persona ?? data.lead.persona ?? null),

      // Intent indicators (if available)
      timeline: data.lead.timeline,
      intent_score: data.lead.intent_score,

      // ISA qualification carry — the agent sees the FULL picture the moment the
      // contact lands in their CRM (budget, motivation, urgency, financing, the
      // handoff brief and the qualification score).
      budget_min: data.lead.budget_min ?? null,
      budget_max: data.lead.budget_max ?? null,
      motivation_type: data.lead.motivation_type ?? null,
      motivation_confidence: data.lead.motivation_confidence ?? null,
      urgency_level: data.lead.urgency_level ?? null,
      lender_status: data.lead.lender_status ?? null,
      qualification_summary: data.lead.qualification_summary ?? null,
      isa_handoff_brief: data.lead.isa_handoff_brief ?? null,
      isa_handoff_at: data.lead.isa_handoff_brief ? new Date().toISOString() : null,
      isa_qualification_score: data.lead.lead_score ?? null,

      // Address — carry BOTH the physical address and the MAILING address upward, faithfully.
      // A contact can own a property but not live there, so the mailing breakdown is kept
      // distinct from the physical address (raw/leads/contacts now share the same field set).
      address:                  data.lead.address ?? null,
      city:                     data.lead.city ?? null,
      state:                    data.lead.state ?? null,
      zip_code:                 data.lead.zip_code ?? data.lead.property_zip_code ?? null,
      mailing_address:          data.lead.mailing_address ?? null,
      mailing_address_source:   data.lead.mailing_address_source ?? null,
      mailing_address_verified: data.lead.mailing_address_verified ?? null,
      mailing_city:             data.lead.mailing_city ?? null,
      mailing_state:            data.lead.mailing_state ?? null,
      mailing_zip:              data.lead.mailing_zip ?? null,

      // Consent provenance — carry over what was captured during the lead phase. Faithful (no
      // fabricated consent) — converted contacts inherit exactly the consent state on the lead.
      // web_form / qr_scan sources captured explicit consent at submission (documented business
      // rule, same as the kernel handler used), so those count as consented even when the lead
      // row's flag wasn't stamped.
      tcpa_consent:
        data.lead.tcpa_consent === true ||
        ['web_form', 'qr_scan'].includes(data.lead.source ?? ''),
      tcpa_consent_date:   data.lead.tcpa_consent_at ?? null,
      tcpa_consent_at:     data.lead.tcpa_consent_at ?? null,
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
      isa_reengage_allowed: true,
      dnc_status: false,

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
