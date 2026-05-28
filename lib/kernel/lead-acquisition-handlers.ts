// SYSTEM: Kernel Lead-Acquisition Handlers (Track A — Lead-first)
// FILE: lib/kernel/lead-acquisition-handlers.ts
// TRACK: Scraped/Raw pipeline only. Forms/QR/Card/Imports use captureContact()
//   in lib/contact-pipeline/contact-capture.ts (Build 05).
// RULE: createServiceClient() is SYNC — never await it.
// RULE: No string literals for events. Always use KernelEvent.X enum values.
// RULE: context_json in automation_errors is TEXT — always JSON.stringify().
// RULE: Only this file writes leads.lifecycle_state. No other file may do so.

import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { calculateLeadScore, evaluateRoutingEligibility } from "@/lib/lead-governance/index"

// ─── VALID TRANSITIONS ────────────────────────────────────────────────────────
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  raw:            ['unconsented'],
  unconsented:    ['isa_qualifying'],
  isa_qualifying: ['consented'],
  consented:      ['assigned'],
  assigned:       ['appointment'],
  appointment:    ['representation'],
  representation: [],
}

// ─── TRANSITION GUARD ────────────────────────────────────────────────────────
export async function assertValidTransition(
  current: string,
  next: string,
  leadId: string
): Promise<void> {
  if (!(ALLOWED_TRANSITIONS[current] ?? []).includes(next)) {
    const supabase = createServiceClient()
    await supabase.from('automation_errors').insert({
      workflow_name: 'lifecycle_transition_guard',
      error_message: `Illegal transition: ${current} → ${next} on lead ${leadId}`,
      context_json: JSON.stringify({ leadId, current, next }),
      brokerage_id: null,
      severity: 'error',
      status: 'open',
    })
    throw new Error(`Illegal lifecycle transition: ${current} → ${next}`)
  }
}

// ─── HANDLER 1: handleLeadCaptured ───────────────────────────────────────────
export async function handleLeadCaptured(params: {
  leadId: string
  brokerageId: string
  actorUserId?: string
}): Promise<void> {
  const { leadId, brokerageId } = params
  const supabase = createServiceClient()

  await assertValidTransition('raw', 'unconsented', leadId)

  await supabase
    .from('leads')
    .update({
      lifecycle_state: 'unconsented',
      last_activity_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', leadId)

  await supabase.from('lifecycle_events').insert({
    entity_type: 'lead',
    entity_id: leadId,
    event_type: KernelEvent.LEAD_CAPTURED,
    brokerage_id: brokerageId,
    created_at: new Date().toISOString(),
  })

  await supabase.from('lead_enrichment_queue').insert({
    lead_id: leadId,
    brokerage_id: brokerageId,
    status: 'pending',
    enrichment_type: 'skip_trace',
    trigger_type: 'lead_captured',
    queued_at: new Date().toISOString(),
  })

  const targetAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  await supabase.from('lead_sla_tracking').insert({
    lead_id: leadId,
    brokerage_id: brokerageId,
    sla_type: 'first_contact',
    target_at: targetAt,
    breached: false,
    created_at: new Date().toISOString(),
  })

  await processKernelEvent({
    event: KernelEvent.LEAD_CAPTURED,
    brokerageId,
    entityType: 'lead',
    entityId: leadId,
  })
}

// ─── HANDLER 2: handleLeadScored ─────────────────────────────────────────────
export async function handleLeadScored(params: {
  leadId: string
  brokerageId: string
}): Promise<void> {
  const { leadId, brokerageId } = params
  const supabase = createServiceClient()

  const { data: lead, error: fetchError } = await supabase
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .single()

  if (fetchError || !lead) {
    throw new Error(`handleLeadScored: lead not found: ${leadId}`)
  }

  const result = calculateLeadScore(lead)

  const urgencyLevel: string =
    result.finalScore >= 75 ? 'hot'
    : result.finalScore >= 50 ? 'warm'
    : result.finalScore >= 25 ? 'cool'
    : 'cold'

  await supabase
    .from('leads')
    .update({
      lead_score: result.finalScore,
      urgency_level: urgencyLevel,
      last_activity_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', leadId)

  await supabase.from('lead_score_history').insert({
    lead_id: leadId,
    brokerage_id: brokerageId,
    score: result.finalScore,
    scoring_factors: result.factors,
    explanation: result.explanation,
    urgency_level: urgencyLevel,
    scored_at: new Date().toISOString(),
  })

  await supabase.from('lifecycle_events').insert({
    entity_type: 'lead',
    entity_id: leadId,
    event_type: KernelEvent.LEAD_SCORED,
    brokerage_id: brokerageId,
    created_at: new Date().toISOString(),
  })

  await processKernelEvent({
    event: KernelEvent.LEAD_SCORED,
    brokerageId,
    entityType: 'lead',
    entityId: leadId,
  })

  await handleISAQualificationStarted({ leadId, brokerageId })
}

// ─── HANDLER 3: handleISAQualificationStarted ────────────────────────────────
export async function handleISAQualificationStarted(params: {
  leadId: string
  brokerageId: string
}): Promise<void> {
  const { leadId, brokerageId } = params
  const supabase = createServiceClient()

  const { data: lead, error: fetchError } = await supabase
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .single()

  if (fetchError || !lead) {
    throw new Error(`handleISAQualificationStarted: lead not found: ${leadId}`)
  }

  await evaluateRoutingEligibility(lead, lead.lead_score ?? 0, brokerageId, supabase)

  await assertValidTransition('unconsented', 'isa_qualifying', leadId)

  await supabase
    .from('leads')
    .update({
      lifecycle_state: 'isa_qualifying',
      stage_entered_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', leadId)

  const targetAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString()
  await supabase.from('lead_sla_tracking').insert({
    lead_id: leadId,
    brokerage_id: brokerageId,
    sla_type: 'qualification',
    target_at: targetAt,
    breached: false,
    created_at: new Date().toISOString(),
  })

  await supabase.from('lifecycle_events').insert({
    entity_type: 'lead',
    entity_id: leadId,
    event_type: KernelEvent.ISA_QUALIFICATION_STARTED,
    brokerage_id: brokerageId,
    created_at: new Date().toISOString(),
  })

  await processKernelEvent({
    event: KernelEvent.ISA_QUALIFICATION_STARTED,
    brokerageId,
    entityType: 'lead',
    entityId: leadId,
  })
}

// ─── HANDLER 4: handleConsentReceived ────────────────────────────────────────
// ONLY called for lead-first track. NEVER for business cards, imports, or scraped.
// Forms and QR set tcpa_consent=true directly via captureContact() in Build 05.
export async function handleConsentReceived(params: {
  leadId: string
  brokerageId: string
  consentSource: 'form' | 'qr' | 'reply'
}): Promise<void> {
  const { leadId, brokerageId, consentSource } = params
  const supabase = createServiceClient()

  await assertValidTransition('isa_qualifying', 'consented', leadId)

  await supabase
    .from('leads')
    .update({
      lifecycle_state: 'consented',
      last_activity_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', leadId)

  await supabase.from('lifecycle_events').insert({
    entity_type: 'lead',
    entity_id: leadId,
    event_type: KernelEvent.CONSENT_RECEIVED,
    brokerage_id: brokerageId,
    metadata: { consentSource },
    created_at: new Date().toISOString(),
  })

  await processKernelEvent({
    event: KernelEvent.CONSENT_RECEIVED,
    brokerageId,
    entityType: 'lead',
    entityId: leadId,
  })

  await handleLeadReadyForAssignment({ leadId, brokerageId })
}

// ─── HANDLER 5: handleLeadReadyForAssignment ─────────────────────────────────
export async function handleLeadReadyForAssignment(params: {
  leadId: string
  brokerageId: string
}): Promise<void> {
  const { leadId, brokerageId } = params
  const supabase = createServiceClient()

  await supabase.from('lifecycle_events').insert({
    entity_type: 'lead',
    entity_id: leadId,
    event_type: KernelEvent.LEAD_READY_FOR_ASSIGNMENT,
    brokerage_id: brokerageId,
    created_at: new Date().toISOString(),
  })

  await processKernelEvent({
    event: KernelEvent.LEAD_READY_FOR_ASSIGNMENT,
    brokerageId,
    entityType: 'lead',
    entityId: leadId,
  })
}

// ─── HANDLER 6: handleLeadAssigned ───────────────────────────────────────────
// AUTO-CREATES contact on assignment.
// tcpa_consent = TRUE only for 'web_form' and 'qr_scan' sources.
export async function handleLeadAssigned(params: {
  leadId: string
  brokerageId: string
  agentId: string
  ruleId?: string
  method: string
  scoreAtAssignment: number
}): Promise<void> {
  const { leadId, brokerageId, agentId, ruleId, method, scoreAtAssignment } = params
  const supabase = createServiceClient()

  await assertValidTransition('consented', 'assigned', leadId)

  const { data: agentRow, error: agentError } = await supabase
    .from('agents')
    .select('user_id')
    .eq('id', agentId)
    .single()

  if (agentError || !agentRow) {
    throw new Error(`handleLeadAssigned: agent not found: ${agentId}`)
  }
  const agentUserId: string = agentRow.user_id

  const { data: leadData, error: leadError } = await supabase
    .from('leads')
    .select(
      'first_name, last_name, email, phone, source, source_family, source_channel, ' +
        'source_subtype, motivation_type, motivation_confidence, persona, lead_type, ' +
        'property_zip_code, budget_min, budget_max, timeline, urgency_level, ' +
        'lender_status, equity_estimate, qualification_summary, isa_handoff_brief, ' +
        'lead_score, tcpa_consent, tcpa_consent_at, tcpa_consent_text, tcpa_consent_source'
    )
    .eq('id', leadId)
    .single()

  if (leadError || !leadData) {
    throw new Error(`handleLeadAssigned: lead not found: ${leadId}`)
  }

  // Cast — newer columns aren't in the generated Supabase types yet
  const lead = leadData as unknown as {
    first_name: string | null
    last_name: string | null
    email: string | null
    phone: string | null
    source: string | null
    source_family: string | null
    source_channel: string | null
    source_subtype: string | null
    motivation_type: string | null
    motivation_confidence: number | null
    persona: string | null
    lead_type: string | null
    property_zip_code: string | null
    budget_min: number | null
    budget_max: number | null
    timeline: string | null
    urgency_level: string | null
    lender_status: string | null
    equity_estimate: number | null
    qualification_summary: string | null
    isa_handoff_brief: Record<string, unknown> | null
    lead_score: number | null
    tcpa_consent: boolean | null
    tcpa_consent_at: string | null
    tcpa_consent_text: string | null
    tcpa_consent_source: string | null
  }

  await supabase
    .from('leads')
    .update({
      lifecycle_state: 'assigned',
      agent_id: agentId,
      last_activity_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', leadId)

  await supabase.from('assignment_log').insert({
    lead_id: leadId,
    brokerage_id: brokerageId,
    agent_id: agentId,
    rule_id: ruleId ?? null,
    assignment_method: method,
    score_at_assignment: Math.round(scoreAtAssignment),
    created_at: new Date().toISOString(),
  })

  await supabase
    .from('lead_sla_tracking')
    .update({ completed_at: new Date().toISOString() })
    .eq('lead_id', leadId)
    .eq('sla_type', 'assignment')
    .is('completed_at', null)

  await supabase.from('lifecycle_events').insert({
    entity_type: 'lead',
    entity_id: leadId,
    event_type: KernelEvent.LEAD_ASSIGNED,
    brokerage_id: brokerageId,
    created_at: new Date().toISOString(),
  })

  // Auto-create contact.
  //
  // Carry forward contact_type from the lead's motivation/lead_type. The ISA
  // qualified the lead by intent; that intent IS the contact type going
  // forward. Mapping:
  //   buyer_motivated  → contact_type = 'buyer'
  //   seller_motivated → contact_type = 'seller'
  //   investor_*       → contact_type = 'investor'
  //   both             → contact_type = 'buyer' (primary), persona='both'
  //   else             → null (agent fills it in CRM)
  const motivationToContactType = (m: string | null): string | null => {
    if (!m) return null
    const lower = m.toLowerCase()
    if (lower.includes('investor')) return 'investor'
    if (lower.includes('seller')) return 'seller'
    if (lower.includes('both')) return 'buyer'
    if (lower.includes('buyer')) return 'buyer'
    return null
  }

  const contactType =
    motivationToContactType(lead.motivation_type) ??
    motivationToContactType(lead.lead_type) ??
    null

  const contactPersona =
    (lead.motivation_type ?? '').toLowerCase().includes('both')
      ? 'both'
      : lead.persona ?? null

  // TCPA consent flows from the lead. Form/QR submissions explicitly captured
  // consent; ISA qualification path also persists consent via
  // handleConsentReceived upstream. Either way, the lead row carries the
  // authoritative consent flags.
  const tcpaConsent =
    lead.tcpa_consent === true ||
    ['web_form', 'qr_scan'].includes(lead.source ?? '')
  const tcpaConsentAt = lead.tcpa_consent_at ?? new Date().toISOString()

  const { data: contact, error: contactError } = await supabase
    .from('contacts')
    .insert({
      brokerage_id: brokerageId,
      agent_id: agentUserId,
      first_name: lead.first_name,
      last_name: lead.last_name,
      email: lead.email,
      phone: lead.phone,
      source: lead.source,
      source_family: lead.source_family,
      source_channel: lead.source_channel,
      source_subtype: lead.source_subtype,
      contact_type: contactType,
      contact_persona: contactPersona,
      zip_code: lead.property_zip_code,
      // Carry forward ALL ISA-captured qualification data so the agent
      // sees the full picture the moment the contact arrives in their CRM.
      budget_min: lead.budget_min,
      budget_max: lead.budget_max,
      motivation_type: lead.motivation_type,
      motivation_confidence: lead.motivation_confidence,
      timeline: lead.timeline,
      urgency_level: lead.urgency_level,
      lender_status: lead.lender_status,
      equity_estimate: lead.equity_estimate,
      qualification_summary: lead.qualification_summary,
      isa_handoff_brief: lead.isa_handoff_brief,
      isa_handoff_at: lead.isa_handoff_brief ? new Date().toISOString() : null,
      isa_qualification_score: lead.lead_score,
      tcpa_consent: tcpaConsent,
      tcpa_consent_date: tcpaConsent ? tcpaConsentAt : null,
      tcpa_consent_at: tcpaConsent ? tcpaConsentAt : null,
      tcpa_consent_source: lead.tcpa_consent_source ?? null,
      tcpa_consent_text: lead.tcpa_consent_text ?? null,
      isa_reengage_allowed: true,
      dnc_status: false,
      created_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (contactError || !contact) {
    throw new Error(`handleLeadAssigned: failed to create contact: ${contactError?.message ?? 'no data'}`)
  }

  await supabase
    .from('leads')
    .update({
      contact_id: contact.id,
      is_active: false,
      updated_at: new Date().toISOString(),
    })
    .eq('id', leadId)

  await supabase.from('lifecycle_events').insert({
    entity_type: 'lead',
    entity_id: leadId,
    event_type: KernelEvent.LEAD_CONVERTED_TO_CONTACT,
    brokerage_id: brokerageId,
    metadata: { contactId: contact.id },
    created_at: new Date().toISOString(),
  })

  await processKernelEvent({
    event: KernelEvent.LEAD_ASSIGNED,
    brokerageId,
    entityType: 'lead',
    entityId: leadId,
  })

  await processKernelEvent({
    event: KernelEvent.LEAD_CONVERTED_TO_CONTACT,
    brokerageId,
    entityType: 'lead',
    entityId: leadId,
  })

  // ── Post-conversion side-effects ──────────────────────────────────────
  // 1. Queue scoring + enrichment so the new contact has fresh data.
  // 2. Send portal invite for buyer/seller/investor contact types so they
  //    can self-serve from minute one. Cooperating-agent contacts and
  //    contacts without a real-estate intent skip the portal.
  try {
    const { queueContactEnrichmentAndScore } = await import(
      '@/lib/contact-pipeline/contact-capture'
    )
    await queueContactEnrichmentAndScore({
      brokerageId,
      contactId: contact.id,
    })
  } catch {
    // best effort — failure should not unwind the assignment
  }

  if (contactType === 'buyer' || contactType === 'seller' || contactType === 'investor') {
    try {
      const { createPortalInviteForContact } = await import(
        '@/app/actions/portal-invites'
      )
      await createPortalInviteForContact({
        contactId: contact.id,
        brokerageId,
        invitedByUserId: agentUserId,
        sendMagicLink: true,
      })
    } catch {
      // best effort — agent can re-send invite from CRM if it failed
    }
  }
}

// ─── HANDLER 7: handleLeadConvertedToContact (manual path) ───────────────────
export async function handleLeadConvertedToContact(params: {
  leadId: string
  brokerageId: string
  contactId: string
}): Promise<void> {
  const { leadId, brokerageId, contactId } = params
  const supabase = createServiceClient()

  await supabase
    .from('leads')
    .update({
      is_active: false,
      contact_id: contactId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', leadId)

  await supabase.from('lifecycle_events').insert({
    entity_type: 'lead',
    entity_id: leadId,
    event_type: KernelEvent.LEAD_CONVERTED_TO_CONTACT,
    brokerage_id: brokerageId,
    metadata: { contactId },
    created_at: new Date().toISOString(),
  })

  await processKernelEvent({
    event: KernelEvent.LEAD_CONVERTED_TO_CONTACT,
    brokerageId,
    entityType: 'lead',
    entityId: leadId,
  })
}
