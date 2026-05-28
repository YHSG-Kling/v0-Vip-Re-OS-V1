// SYSTEM: Contact Capture Pipeline Helpers (Track B — Contact-first)
// FILE: lib/contact-pipeline/contact-capture.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURPOSE: Unified helper for all direct-capture channels.
//   Dedup → Merge/Create → Queue Enrichment → Score → Emit events

import { KernelEvent } from '@/lib/kernel/events'
import { processKernelEvent } from '@/lib/kernel/notification-engine'
import { createServiceClient } from '@/lib/supabase/service'
import { calculateFuzzyMatch } from '@/lib/lead-pipeline/fuzzy-matcher'
import { calculateLeadScore } from '@/lib/lead-governance/multi-factor-scorer'
import { resolveAgentForContact } from '@/lib/lead-assignment/contact-assignment'

// ─── Constants ────────────────────────────────────────────────────────────────

const DEDUP_THRESHOLD = 0.85

// ─── Types ────────────────────────────────────────────────────────────────────

// Sources that originate from public-facing forms with TCPA consent.
// Lead-conversion paths (lead_promotion, lead_import) bypass this function
// entirely — they go through lib/contact-promotion/contact-creator.ts which
// already has the enriched lead data and must NOT re-dedup or re-enrich.
export type ContactCaptureSource =
  | 'web_form'
  | 'qr_scan'
  | 'business_card'
  | 'open_house'
  | 'widget'
  | 'home_value_form'
  | 'showing_request'
  | string

// Sources that represent a lead being promoted to a contact.
// When source matches one of these values, dedup and enrichment are skipped
// because the lead record was already enriched before promotion.
const LEAD_CONVERSION_SOURCES = new Set([
  'lead_promotion',
  'lead_import',
  'lead_conversion',
  'crm_import',
])

export interface CaptureContactParams {
  brokerageId: string
  /**
   * agents.id of the owning agent. contacts.agent_id is agents.id per
   * migration 111 — passing users.id here used to silently break agent
   * RLS visibility (auth.agent_id() returns agents.id).
   *
   * If omitted, lib/lead-assignment/contact-assignment.ts picks the owner
   * via the same precedence used elsewhere: solo-agent shortcut →
   * assignment_rules → load-balance fallback.
   */
  ownerAgentId?: string | null
  /**
   * @deprecated Pass `ownerAgentId` (agents.id) instead. Kept for source
   * compatibility with callers that pre-dated the contract correction;
   * when set, the value is treated as users.id and converted internally
   * to agents.id via the agents table.
   */
  agentUserId?: string | null
  source: ContactCaptureSource
  /** Set to the originating lead ID when this contact is being created from
   *  a lead record. Dedup and enrichment are skipped — the lead was already
   *  enriched and deduplicated before promotion. */
  fromLeadId?: string | null
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  phone?: string | null
  preferred_channel?: 'phone' | 'email' | 'sms' | null
  tcpa_consent: boolean
  tcpa_consent_date?: string | null
  rawPayload?: Record<string, unknown>
}

export interface CaptureContactResult {
  contactId: string
  action: 'created' | 'merged'
}

// ─── captureContact ───────────────────────────────────────────────────────────

export async function captureContact(
  params: CaptureContactParams,
): Promise<CaptureContactResult> {
  const supabase = createServiceClient()

  // ── Viability gate ───────────────────────────────────────────────────────
  const hasName = !!(
    (params.first_name ?? '').trim() || (params.last_name ?? '').trim()
  )
  const hasContact = !!(
    (params.email ?? '').trim() || (params.phone ?? '').trim()
  )
  if (!hasName || !hasContact) {
    throw new Error(
      'Contact viability failed: missing name or contact method',
    )
  }

  // ── Normalize owner hint (contacts.agent_id is agents.id) ────────────────
  // Accept either `ownerAgentId` (agents.id, the correct contract) or the
  // legacy `agentUserId` (users.id). If only the legacy field is set, look
  // up the matching agents.id via the agents table.
  let ownerAgentHint: string | null = params.ownerAgentId ?? null
  if (!ownerAgentHint && params.agentUserId) {
    const { data: agentRow } = await supabase
      .from('agents')
      .select('id')
      .eq('user_id', params.agentUserId)
      .eq('brokerage_id', params.brokerageId)
      .maybeSingle()
    ownerAgentHint = agentRow?.id ?? null
  }

  // ── Lead-conversion fast path ────────────────────────────────────────────
  // When a contact is being promoted from a lead record the lead was already
  // deduplicated and enriched. Skip directly to CREATE and skip enrichment
  // queue — the caller (contact-creator.ts) owns that data transfer.
  const isLeadConversion =
    !!params.fromLeadId || LEAD_CONVERSION_SOURCES.has(params.source)

  if (isLeadConversion) {
    const assignment = await resolveAgentForContact({
      brokerageId: params.brokerageId,
      ownerAgentId: ownerAgentHint,
      source: params.source,
    })
    if (!assignment.agentId) {
      throw new Error(
        `captureContact (lead-conversion): no eligible agent in brokerage ${params.brokerageId}`,
      )
    }

    const { data: created, error: createError } = await supabase
      .from('contacts')
      .insert({
        brokerage_id: params.brokerageId,
        agent_id: assignment.agentId, // agents.id
        first_name: params.first_name ?? null,
        last_name: params.last_name ?? null,
        email: params.email ?? null,
        phone: params.phone ?? null,
        preferred_channel: params.preferred_channel ?? 'email',
        source: params.source,
        tcpa_consent: params.tcpa_consent,
        tcpa_consent_date: params.tcpa_consent
          ? (params.tcpa_consent_date ?? new Date().toISOString())
          : null,
        isa_reengage_allowed: true,
        dnc_status: false,
        notes: params.fromLeadId ? `Promoted from lead ${params.fromLeadId}` : undefined,
      })
      .select('id')
      .single()

    if (createError || !created) {
      throw new Error(`Failed to create contact from lead: ${createError?.message ?? 'no data'}`)
    }

    await supabase.from('lifecycle_events').insert({
      brokerage_id: params.brokerageId,
      entity_type: 'contact',
      entity_id: created.id,
      event_type: KernelEvent.CONTACT_CAPTURED,
      metadata: { source: params.source, from_lead_id: params.fromLeadId ?? null },
    })

    return { contactId: created.id, action: 'created' }
  }

  // ── Dedup — only for direct public-form captures ─────────────────────────
  const orFilter = [
    params.email ? `email.eq.${params.email}` : null,
    params.phone ? `phone.eq.${params.phone}` : null,
  ]
    .filter(Boolean)
    .join(',')

  const { data: candidates } = orFilter
    ? await supabase
        .from('contacts')
        .select('*')
        .eq('brokerage_id', params.brokerageId)
        .or(orFilter)
    : { data: [] }

  // ── Score each candidate ─────────────────────────────────────────────────
  let bestId: string | null = null
  let bestScore = 0

  for (const c of candidates ?? []) {
    const result = calculateFuzzyMatch(
      {
        first_name: params.first_name ?? '',
        last_name: params.last_name ?? '',
        email: params.email ?? '',
        phone: params.phone ?? '',
      },
      {
        first_name: c.first_name ?? '',
        last_name: c.last_name ?? '',
        email: c.email ?? '',
        phone: c.phone ?? '',
      },
    )
    if (result.score > bestScore) {
      bestScore = result.score
      bestId = c.id
    }
  }

  // ── MERGE path ───────────────────────────────────────────────────────────
  if (bestId !== null && bestScore >= DEDUP_THRESHOLD) {
    const existing = (candidates ?? []).find((x) => x.id === bestId)

    // Resolve agent to assign on merge if existing contact has none.
    // agents.id (NOT users.id) — contacts.agent_id is agents.id.
    let mergeAgentId: string | null = null
    if (!existing?.agent_id) {
      const assignment = await resolveAgentForContact({
        brokerageId: params.brokerageId,
        ownerAgentId: ownerAgentHint,
        source: params.source,
      })
      mergeAgentId = assignment.agentId
    }

    await supabase
      .from('contacts')
      .update({
        first_name: existing?.first_name || params.first_name,
        last_name: existing?.last_name || params.last_name,
        email: existing?.email || params.email,
        phone: existing?.phone || params.phone,
        source: existing?.source || params.source,
        // Assign agent if not already set
        ...(mergeAgentId && !existing?.agent_id ? { agent_id: mergeAgentId } : {}),
        // Only upgrade preferred_channel if consent was just given
        preferred_channel: params.tcpa_consent
          ? (params.preferred_channel ?? existing?.preferred_channel)
          : existing?.preferred_channel,
        tcpa_consent: params.tcpa_consent ? true : existing?.tcpa_consent,
        tcpa_consent_date: params.tcpa_consent
          ? (params.tcpa_consent_date ?? new Date().toISOString())
          : existing?.tcpa_consent_date,
        updated_at: new Date().toISOString(),
      })
      .eq('id', bestId)

    await supabase.from('lifecycle_events').insert({
      brokerage_id: params.brokerageId,
      entity_type: 'contact',
      entity_id: bestId,
      event_type: KernelEvent.CONTACT_DEDUP_MERGED,
      metadata: { score: bestScore, source: params.source },
    })

    await processKernelEvent({
      event: KernelEvent.CONTACT_DEDUP_MERGED,
      brokerageId: params.brokerageId,
      entityType: 'contact',
      entityId: bestId,
    })

    await queueContactEnrichmentAndScore({
      brokerageId: params.brokerageId,
      contactId: bestId,
    })

    return { contactId: bestId, action: 'merged' }
  }

  // ── CREATE path ──────────────────────────────────────────────────────────
  // Resolve owner via the assignment helper so the same precedence applies
  // (owner hint → solo-agent → assignment_rules → load-balance fallback).
  // contacts.agent_id is agents.id per migration 111.
  const createAssignment = await resolveAgentForContact({
    brokerageId: params.brokerageId,
    ownerAgentId: ownerAgentHint,
    source: params.source,
  })
  if (!createAssignment.agentId) {
    throw new Error(
      `captureContact: no eligible agent in brokerage ${params.brokerageId}`,
    )
  }

  const { data: created, error: createError } = await supabase
    .from('contacts')
    .insert({
      brokerage_id: params.brokerageId,
      agent_id: createAssignment.agentId, // agents.id
      first_name: params.first_name ?? null,
      last_name: params.last_name ?? null,
      email: params.email ?? null,
      phone: params.phone ?? null,
      preferred_channel: params.preferred_channel ?? (params.tcpa_consent ? 'phone' : 'email'),
      source: params.source,
      tcpa_consent: params.tcpa_consent,
      tcpa_consent_date: params.tcpa_consent
        ? (params.tcpa_consent_date ?? new Date().toISOString())
        : null,
      isa_reengage_allowed: true,
      dnc_status: false,
    })
    .select('id')
    .single()

  if (createError || !created) {
    throw new Error(
      `Failed to create contact: ${createError?.message ?? 'no data returned'}`,
    )
  }

  const contactId = created.id

  await supabase.from('lifecycle_events').insert({
    brokerage_id: params.brokerageId,
    entity_type: 'contact',
    entity_id: contactId,
    event_type: KernelEvent.CONTACT_CAPTURED,
    metadata: { source: params.source },
  })

  await processKernelEvent({
    event: KernelEvent.CONTACT_CAPTURED,
    brokerageId: params.brokerageId,
    entityType: 'contact',
    entityId: contactId,
  })

  await queueContactEnrichmentAndScore({
    brokerageId: params.brokerageId,
    contactId,
  })

  return { contactId, action: 'created' }
}

// ─── queueContactEnrichmentAndScore ──────────────────────────────────────────

export async function queueContactEnrichmentAndScore(params: {
  brokerageId: string
  contactId: string
}): Promise<void> {
  const supabase = createServiceClient()

  // Queue enrichment — idempotent: skip if already pending or processing
  const { data: existing } = await supabase
    .from('lead_enrichment_queue')
    .select('id')
    .eq('brokerage_id', params.brokerageId)
    .eq('contact_id', params.contactId)
    .in('status', ['pending', 'processing'])
    .limit(1)
    .maybeSingle()

  if (!existing?.id) {
    await supabase.from('lead_enrichment_queue').insert({
      brokerage_id: params.brokerageId,
      contact_id: params.contactId,   // contact_id NOT lead_id
      lead_id: null,
      status: 'pending',
      enrichment_type: 'skip_trace',
      trigger_type: 'contact_captured',
    })

    await supabase.from('lifecycle_events').insert({
      brokerage_id: params.brokerageId,
      entity_type: 'contact',
      entity_id: params.contactId,
      event_type: KernelEvent.CONTACT_ENRICHMENT_QUEUED,
      metadata: {},
    })

    await processKernelEvent({
      event: KernelEvent.CONTACT_ENRICHMENT_QUEUED,
      brokerageId: params.brokerageId,
      entityType: 'contact',
      entityId: params.contactId,
    })
  }

  // Score immediately with available data (re-scored after enrichment completes)
  const { data: contact } = await supabase
    .from('contacts')
    .select('*')
    .eq('id', params.contactId)
    .single()

  if (!contact) return

  const scoreResult = calculateLeadScore(contact)

  await supabase.from('lead_score_history').insert({
    contact_id: params.contactId,   // contact_id NOT lead_id
    lead_id: null,
    brokerage_id: params.brokerageId,
    score: scoreResult.finalScore,
    scoring_factors: scoreResult.factors,
    explanation: scoreResult.explanation,
    scored_at: new Date().toISOString(),
  })

  await supabase
    .from('contacts')
    .update({ last_scored_at: new Date().toISOString() })
    .eq('id', params.contactId)

  await supabase.from('lifecycle_events').insert({
    brokerage_id: params.brokerageId,
    entity_type: 'contact',
    entity_id: params.contactId,
    event_type: KernelEvent.CONTACT_SCORED,
    metadata: { score: scoreResult.finalScore },
  })

  await processKernelEvent({
    event: KernelEvent.CONTACT_SCORED,
    brokerageId: params.brokerageId,
    entityType: 'contact',
    entityId: params.contactId,
  })
}
