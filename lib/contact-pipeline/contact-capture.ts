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
import { mergeIdentityFields } from '@/lib/data-steward/field-steward'
// NOTE: `queueContactEnrichment` is imported DYNAMICALLY at its call site below,
// not statically at module scope. lib/enrichment/contact-enrichment-core.ts is
// `server-only` (it holds the service client and the paid PeopleData/OSINT
// clients), and a static import here would pull that into every module graph
// that reaches this file — including the plain `tsx` guard simulators, which are
// not a server component and crash on `server-only` at load. lib/kernel/crm.ts
// already used the dynamic form for exactly this reason; these call sites were
// the inconsistency. The queue call is best-effort and already awaited/voided,
// so deferring the import costs nothing.

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
  /** Secondary line — independently gateable (m202); conserved through capture/merge. */
  phone_secondary?: string | null
  // Canonical physical + mailing address (Data Steward field set — m198/m199/m200).
  // A contact can own a property but not live there, so mailing stays distinct.
  address?: string | null
  city?: string | null
  state?: string | null
  zip_code?: string | null
  mailing_address?: string | null
  mailing_city?: string | null
  mailing_state?: string | null
  mailing_zip?: string | null
  /** Free-text notes; on merge these are APPENDED, never overwritten. The CSV import
   *  path routes every unmapped source column here (Data Steward: nothing dropped). */
  notes?: string | null
  // Classification fields — values MUST already be canonical (the import path runs
  // them through the Data Steward value normalizer; sanitizeEnumValue gates AI
  // proposals so a hallucinated value can never arrive here). On merge these
  // fill-if-empty only — an import never overwrites an existing classification.
  contact_type?: string | null
  lead_temperature?: string | null
  lender_status?: string | null
  preferred_channel?: 'phone' | 'email' | 'sms' | null
  tcpa_consent: boolean
  tcpa_consent_date?: string | null
  /** TCPA consent provenance — conserved when present (where + exact text consented to). */
  tcpa_consent_source?: string | null
  tcpa_consent_text?: string | null
  rawPayload?: Record<string, unknown>
  /** When true, do NOT auto-assign an agent — agent_id stays the resolved owner hint or
   *  null. For paths that must legally leave ownership unset, e.g. a listing-landing buyer
   *  who disclosed they are already represented by another agent (NAR Article 16). */
  skipAutoAssign?: boolean
  /** Merged into contacts.enrichment_profile (read-merge-write on dedup so existing
   *  enrichment is never clobbered) — e.g. the Article-16 representation_disclosure. */
  enrichmentProfile?: Record<string, unknown> | null
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
        phone_secondary: params.phone_secondary ?? null,
        address: params.address ?? null,
        city: params.city ?? null,
        state: params.state ?? null,
        zip_code: params.zip_code ?? null,
        mailing_address: params.mailing_address ?? null,
        mailing_city: params.mailing_city ?? null,
        mailing_state: params.mailing_state ?? null,
        mailing_zip: params.mailing_zip ?? null,
        ...(params.contact_type ? { contact_type: params.contact_type } : {}),
        ...(params.lead_temperature ? { lead_temperature: params.lead_temperature } : {}),
        ...(params.lender_status ? { lender_status: params.lender_status } : {}),
        preferred_channel: params.preferred_channel ?? 'email',
        source: params.source,
        tcpa_consent: params.tcpa_consent,
        tcpa_consent_date: params.tcpa_consent
          ? (params.tcpa_consent_date ?? new Date().toISOString())
          : null,
        isa_reengage_allowed: true,
        dnc_status: false,
        notes: [params.fromLeadId ? `Promoted from lead ${params.fromLeadId}` : null, params.notes ?? null]
          .filter(Boolean).join('\n') || undefined,
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

    // CLIENT WELCOME (concierge #1–2) — a new buyer/seller client gets the
    // gated warm-welcome + journey-map draft. Best-effort, never blocks capture.
    try {
      const { ensureClientWelcome } = await import('@/lib/kernel/client-welcome')
      await ensureClientWelcome(supabase as any, {
        id: created.id, brokerageId: params.brokerageId,
        contactType: params.contact_type ?? null,
        firstName: params.first_name ?? null, lastName: params.last_name ?? null,
      })
    } catch { /* welcome is care, not a dependency */ }

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
    if (!existing?.agent_id && !params.skipAutoAssign) {
      const assignment = await resolveAgentForContact({
        brokerageId: params.brokerageId,
        ownerAgentId: ownerAgentHint,
        source: params.source,
      })
      mergeAgentId = assignment.agentId
    }

    // Read-merge-write enrichment_profile so a landing-page disclosure (Article 16) is
    // conserved without clobbering existing enrichment (employer, income, …).
    const mergedEnrichmentProfile = params.enrichmentProfile
      ? { ...((existing?.enrichment_profile as Record<string, unknown> | null) ?? {}), ...params.enrichmentProfile }
      : null

    // Data Steward lossless merge over the canonical identity/address fields:
    // existing (the surviving row) keeps its non-empty values, empties are filled
    // from the incoming capture, and a REAL conflict (both present, different) is
    // preserved as a notes line — never silently dropped (the old `existing || incoming`
    // merge discarded the incoming value whenever the column was already set).
    const MERGE_FIELDS = [
      'first_name', 'last_name', 'email', 'phone', 'phone_secondary',
      'address', 'city', 'state', 'zip_code',
      'mailing_address', 'mailing_city', 'mailing_state', 'mailing_zip',
      // Classification fields ride the same lossless semantics: fill-if-empty,
      // conflicting imported classification preserved in notes, never overwritten.
      'contact_type', 'lead_temperature', 'lender_status',
    ] as const
    const { merged: stewardMerged, conflicts } = mergeIdentityFields(
      {
        first_name: existing?.first_name, last_name: existing?.last_name,
        email: existing?.email, phone: existing?.phone,
        phone_secondary: existing?.phone_secondary,
        address: existing?.address, city: existing?.city,
        state: existing?.state, zip_code: existing?.zip_code,
        mailing_address: existing?.mailing_address, mailing_city: existing?.mailing_city,
        mailing_state: existing?.mailing_state, mailing_zip: existing?.mailing_zip,
        contact_type: existing?.contact_type, lead_temperature: existing?.lead_temperature,
        lender_status: existing?.lender_status,
      },
      {
        first_name: params.first_name, last_name: params.last_name,
        email: params.email, phone: params.phone,
        phone_secondary: params.phone_secondary,
        address: params.address, city: params.city,
        state: params.state, zip_code: params.zip_code,
        mailing_address: params.mailing_address, mailing_city: params.mailing_city,
        mailing_state: params.mailing_state, mailing_zip: params.mailing_zip,
        contact_type: params.contact_type, lead_temperature: params.lead_temperature,
        lender_status: params.lender_status,
      },
      MERGE_FIELDS,
    )
    const noteAdditions = [
      ...(conflicts.length ? [`[merge ${new Date().toISOString().slice(0, 10)} via ${params.source}] ${conflicts.join('; ')}`] : []),
      ...(params.notes ? [params.notes] : []),
    ]
    const mergedNotes = [existing?.notes, ...noteAdditions].filter(Boolean).join('\n')

    await supabase
      .from('contacts')
      .update({
        ...stewardMerged,
        source: existing?.source || params.source,
        ...(mergedNotes ? { notes: mergedNotes } : {}),
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
        ...(params.tcpa_consent && params.tcpa_consent_source ? { tcpa_consent_source: params.tcpa_consent_source } : {}),
        ...(params.tcpa_consent && params.tcpa_consent_text ? { tcpa_consent_text: params.tcpa_consent_text } : {}),
        ...(mergedEnrichmentProfile ? { enrichment_profile: mergedEnrichmentProfile } : {}),
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
  // skipAutoAssign: honor an explicit owner hint if present, else leave ownership unset
  // (NAR Article 16 — never auto-poach a represented buyer). Otherwise resolve normally.
  let createAgentId: string | null
  // ASSIGNMENT ATTRIBUTION (round 38): WHICH policy picked the owner (matched
  // assignment_rules row / fallback method) is recorded on the CONTACT_CAPTURED
  // event below — the Track-B twin of assignment_log.rule_id on the lead path,
  // so the assignment-policy outcomes rail can grade rule-routed form/import
  // contacts too. Recording starts here; nothing earlier is retro-attributed.
  let createAttribution: { method: string; rule_id: string | null } | null = null
  if (params.skipAutoAssign) {
    createAgentId = ownerAgentHint ?? null
  } else {
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
    createAgentId = createAssignment.agentId
    createAttribution = { method: createAssignment.method, rule_id: createAssignment.ruleId ?? null }
  }

  const { data: created, error: createError } = await supabase
    .from('contacts')
    .insert({
      brokerage_id: params.brokerageId,
      agent_id: createAgentId, // agents.id (null when skipAutoAssign + no owner hint)
      first_name: params.first_name ?? null,
      last_name: params.last_name ?? null,
      email: params.email ?? null,
      phone: params.phone ?? null,
      phone_secondary: params.phone_secondary ?? null,
      address: params.address ?? null,
      city: params.city ?? null,
      state: params.state ?? null,
      zip_code: params.zip_code ?? null,
      mailing_address: params.mailing_address ?? null,
      mailing_city: params.mailing_city ?? null,
      mailing_state: params.mailing_state ?? null,
      mailing_zip: params.mailing_zip ?? null,
      ...(params.notes ? { notes: params.notes } : {}),
      ...(params.contact_type ? { contact_type: params.contact_type } : {}),
      ...(params.lead_temperature ? { lead_temperature: params.lead_temperature } : {}),
      ...(params.lender_status ? { lender_status: params.lender_status } : {}),
      preferred_channel: params.preferred_channel ?? (params.tcpa_consent ? 'phone' : 'email'),
      source: params.source,
      tcpa_consent: params.tcpa_consent,
      tcpa_consent_date: params.tcpa_consent
        ? (params.tcpa_consent_date ?? new Date().toISOString())
        : null,
      ...(params.tcpa_consent && params.tcpa_consent_source ? { tcpa_consent_source: params.tcpa_consent_source } : {}),
      ...(params.tcpa_consent && params.tcpa_consent_text ? { tcpa_consent_text: params.tcpa_consent_text } : {}),
      ...(params.enrichmentProfile ? { enrichment_profile: params.enrichmentProfile } : {}),
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
    metadata: {
      source: params.source,
      ...(createAttribution ? { assignment: createAttribution } : {}),
    },
  })

  await processKernelEvent({
    event: KernelEvent.CONTACT_CAPTURED,
    brokerageId: params.brokerageId,
    entityType: 'contact',
    entityId: contactId,
  })

  // CLIENT WELCOME (concierge #1–2) — same gated draft on the direct-capture
  // path. Best-effort, never blocks capture.
  try {
    const { ensureClientWelcome } = await import('@/lib/kernel/client-welcome')
    await ensureClientWelcome(supabase as any, {
      id: contactId, brokerageId: params.brokerageId,
      contactType: params.contact_type ?? null,
      firstName: params.first_name ?? null, lastName: params.last_name ?? null,
    })
  } catch { /* welcome is care, not a dependency */ }

  await queueContactEnrichmentAndScore({
    brokerageId: params.brokerageId,
    contactId,
  })

  // Warm-capture portal invite. These sources are self-provided / consented (web_form / qr_scan /
  // business_card / widget / open_house / home_value_form / showing_request — NOT in
  // LEAD_CONVERSION_SOURCES, which are invited via handleLeadAssigned). Resolve the assigned agent's
  // users.id to attribute the invite; the core compliance-gates the OTP email on
  // email_opt_out / email_unsubscribed. Best-effort — never block contact creation.
  // Skipped when there is no owning agent (skipAutoAssign + no hint, e.g. a represented
  // buyer): there is no agent to attribute the invite to, and we must not invite them
  // into the listing agent's portal.
  try {
    const { data: agentRow } = createAgentId
      ? await supabase.from('agents').select('user_id').eq('id', createAgentId).maybeSingle()
      : { data: null }
    if (agentRow?.user_id) {
      // ONE EMAIL, HERE TOO. `ensureClientWelcome` ran a few lines above and, for
      // any contact type resolveWelcomeSide accepts, it has already granted portal
      // access (sendMagicLink: false) and sent an agent-signed welcome carrying the
      // portal door. Re-inviting with the OTP mail armed put a SECOND, generic
      // email on top of it — the same duplicate the conversion lanes were carrying,
      // and the owner's them-first ruling forbids the generic one specifically.
      // The invite row itself is still (re)created either way: the grant and the
      // email are different things.
      const { resolveWelcomeSide } = await import('@/lib/kernel/client-welcome')
      const { createSystemPortalInvite } = await import('@/lib/portal/portal-invite-core')
      await createSystemPortalInvite({
        contactId,
        agentUserId: agentRow.user_id,
        sendMagicLink: resolveWelcomeSide(params.contact_type ?? null) === null,
      })
    }
  } catch (err) {
    console.error('[captureContact] portal invite failed (non-fatal):', err)
  }

  return { contactId, action: 'created' }
}

// ─── queueContactEnrichmentAndScore ──────────────────────────────────────────

export async function queueContactEnrichmentAndScore(params: {
  brokerageId: string
  contactId: string
}): Promise<void> {
  const supabase = createServiceClient()

  // Queue enrichment. This used to be a private copy of the queue write — one of
  // four in the repo, each with a different set of guards. The pending/processing
  // idempotency check this copy had was ported onto the survivor,
  // lib/enrichment/contact-enrichment-core.ts:queueContactEnrichment, which adds
  // the freshness check this copy lacked and the owner's live-deal suppression
  // rule that none of the four had. It also emits CONTACT_ENRICHMENT_QUEUED
  // through emitKernelEvent, which does the lifecycle_events insert AND the
  // reactor fan-out in one call — the pair of calls here could drift apart.
  //
  // The SCORING half below is this function's own capability and stays.
  await (await import("@/lib/enrichment/contact-enrichment-core")).queueContactEnrichment({
    brokerageId: params.brokerageId,
    contactId: params.contactId,
    triggerType: 'contact_captured',
  })

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
