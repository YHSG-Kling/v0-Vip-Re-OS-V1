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
import { sentinelWrite } from '@/lib/kernel/write-sentinel'
// PURE — no server-only, no SCHEMA_SNAPSHOT at module scope (see that file's
// own header note) — safe as a static import into this shared pipeline file.
import { localeToElevenLabsLanguage } from '@/lib/video/multilingual-reel'
import type { NormalizedPersonIdentity } from '@/lib/kernel/person-identity'
import { createHash } from 'node:crypto'
import {
  canonicalConsentPurposes, channelsNamedInConsentText, consentTextHash, purposesNamedInConsentText, type ConsentChannel, type ConsentPurpose,
} from '@/lib/kernel/compliance/require-contact-consent'
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

/**
 * resolveCapturedLanguage — THE ONE intake-time locale resolver (§6), lifted
 * out of app/api/forms/submit/route.ts (the one door that had it) so every
 * OTHER public intake door computes `CaptureContactParams.language` the same
 * way instead of re-deriving its own "which header/field wins" logic.
 *
 * Prefers an explicit locale/language FIELD the submission itself carried
 * (a form, widget or QR payload CAN name one — nothing forces it to), else
 * falls back to the request's `Accept-Language` header. Both are mapped
 * through `localeToElevenLabsLanguage` (lib/video/multilingual-reel.ts) so a
 * garbage/unmapped value never reaches `contacts.metadata->>'captured_language'`
 * as a fabricated language — this is tier 3 of `resolveContactLanguage`, a
 * guess, and only a MAPPED guess is worth storing.
 *
 * PURE — takes the two raw strings already read by the caller (never parses a
 * Request itself, so it works identically for a NextRequest route handler and
 * a "use server" action reading `headers()`).
 */
export function resolveCapturedLanguage(
  explicitLocale: string | null | undefined,
  acceptLanguageHeader: string | null | undefined,
): string | null {
  const fromField = localeToElevenLabsLanguage((explicitLocale ?? '').trim())
  if (fromField) return fromField
  const firstTag = (acceptLanguageHeader ?? '').split(',')[0]?.trim() ?? ''
  return localeToElevenLabsLanguage(firstTag)
}

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
  /**
   * TIER 3 OF lib/video/multilingual-reel.ts::resolveContactLanguage — the
   * intake-time locale, captured at first touch before any preferred_language
   * setting or transcribed call can exist. An ElevenLabs-mapped language code
   * (localeToElevenLabsLanguage output) the caller already resolved from the
   * form's own locale field or the request's Accept-Language header — this
   * function does not parse either itself (§6, no second resolver).
   *
   * Stored at contacts.metadata->>'captured_language' — NOT a typed column.
   * m620 APPLIED 2026-09-10 — tier 1 (contacts.preferred_language) is live; this stays tier 3 (supabase/migrations/m620-contacts-preferred-
   * language.sql, WRITTEN NOT APPLIED per CLAUDE.md §3) this IS the only place
   * an intake-time language lands; once preferred_language exists, a
   * follow-up lane backfills it from here — the same "typed column pending,
   * jsonb key live" pattern m617's business_card_scans columns already used.
   * fill-if-empty on merge (an existing captured_language is never overwritten
   * by a lower-confidence retry).
   */
  language?: string | null
}

export interface CaptureContactResult {
  contactId: string
  action: 'created' | 'merged'
  /** PERSON IDENTITY (wave 102.1, lane 102E) — the person_identities row this capture resolved to
   *  (lib/kernel/person-identity.ts), null when the capture had no gate identity (no email / no
   *  last name), on the lead-conversion fast path (history-carry links it), or when m697 refused. A
   *  caller that links its OWN row (a form submission) passes this id and never re-links the contact. */
  personId?: string | null
  /** The normalised identity the person was resolved on — for the caller's own evidence stamp. */
  personIdentity?: NormalizedPersonIdentity | null
}

// ─── Person identity evidence (wave 102.1, lane 102E) ─────────────────────────
//
// captureContact IS the public-capture dedup verdict (email/phone fuzzy match → merge, else
// create) for every consented door: forms, lead magnets, QR, embed/widget, home-value, business
// card, kiosk, listing landing. Wired ONCE here so every door inherits it instead of each wiring
// around it (the form route did until this lane). ONE evidence row on the contact — capture_match,
// scored by the capture's own dedup (a merge at its fuzzy score, a creation at 1.0) — through THE one
// service. The chokepoint's own event (CONTACT_DEDUP_MERGED / CONTACT_CAPTURED, emitted below) is
// the event; no person.identity_linked. A door that re-links the same contact (the kiosk greeting's
// capture_match) is a UNIQUE-protected no-op (duplicate: true). Best-effort: never blocks capture.
async function recordCapturePersonEvidence(
  supabase: ReturnType<typeof createServiceClient>,
  params: CaptureContactParams,
  contactId: string,
  action: 'created' | 'merged',
  matchScore: number,
): Promise<{ personId: string | null; personIdentity: NormalizedPersonIdentity | null }> {
  try {
    const { resolvePerson, linkPersonEvidence } = await import('@/lib/kernel/person-identity')
    const person = await resolvePerson(supabase, {
      brokerageId: params.brokerageId,
      firstName: params.first_name ?? null, lastName: params.last_name ?? null,
      email: params.email ?? null, phone: params.phone ?? null,
    })
    if (!person.ok) {
      if (person.reason !== 'no_identity_anchor') console.warn(`[contact-capture] person identity not resolved: ${person.reason}`)
      return { personId: null, personIdentity: null }
    }
    const link = await linkPersonEvidence(supabase, {
      brokerageId: params.brokerageId, personId: person.personId,
      entityType: 'contact', entityId: contactId, matchMethod: 'capture_match', matchScore,
      source: 'contact_capture', actor: { type: 'system', userId: null }, identity: person.identity,
      detail: { capture_action: action, capture_source: params.source },
      existingEvent: action === 'merged' ? KernelEvent.CONTACT_DEDUP_MERGED : KernelEvent.CONTACT_CAPTURED,
    })
    if (!link.ok) console.warn(`[contact-capture] person evidence not recorded: ${link.reason}`)
    return { personId: person.personId, personIdentity: person.identity }
  } catch (err) {
    console.warn('[contact-capture] person identity threw (capture unaffected):', err instanceof Error ? err.message : String(err))
    return { personId: null, personIdentity: null }
  }
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
        ...(params.language ? { metadata: { captured_language: params.language } } : {}),
      })
      .select('id')
      .single()

    if (createError || !created) {
      throw new Error(`Failed to create contact from lead: ${createError?.message ?? 'no data'}`)
    }

    await sentinelWrite(supabase, supabase.from('lifecycle_events').insert({
      brokerage_id: params.brokerageId,
      entity_type: 'contact',
      entity_id: created.id,
      event_type: KernelEvent.CONTACT_CAPTURED,
      metadata: { source: params.source, from_lead_id: params.fromLeadId ?? null },
    }), { table: "lifecycle_events", flow: "lifecycle_events_echo", reason: "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped" })

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

    // Same read-merge-write shape for the intake-language capture: FILL-IF-EMPTY
    // only — a contact who already told us a language (or gave us one on an
    // earlier capture) keeps it; a retry never demotes a real answer to a guess.
    const existingMetadata = (existing?.metadata as Record<string, unknown> | null) ?? null
    const mergedMetadata =
      params.language && !existingMetadata?.captured_language
        ? { ...(existingMetadata ?? {}), captured_language: params.language }
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

    // FAIL CLOSED (CLAUDE.md §4). This payload CARRIES TCPA CONSENT — it upgrades
    // an existing contact to consented (and moves preferred_channel to phone with
    // it) whenever the incoming capture ticked the box. supabase-js RESOLVES a
    // refused UPDATE, so this returned `{ action: 'merged' }` and emitted
    // CONTACT_DEDUP_MERGED for a merge that never landed — the consent, the notes,
    // the agent assignment, all of it. The CREATE path below already throws on
    // `createError`; the MERGE path now refuses the same way.
    const { error: mergeError } = await supabase
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
        ...(mergedMetadata ? { metadata: mergedMetadata } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq('id', bestId)

    if (mergeError) {
      throw new Error(`Failed to merge contact ${bestId}: ${mergeError.message}`)
    }

    await sentinelWrite(supabase, supabase.from('lifecycle_events').insert({
      brokerage_id: params.brokerageId,
      entity_type: 'contact',
      entity_id: bestId,
      event_type: KernelEvent.CONTACT_DEDUP_MERGED,
      metadata: { score: bestScore, source: params.source },
    }), { table: "lifecycle_events", flow: "lifecycle_events_echo", reason: "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped" })

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

    const mergedPerson = await recordCapturePersonEvidence(supabase, params, bestId, 'merged', bestScore)
    return { contactId: bestId, action: 'merged', ...mergedPerson }
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
      ...(params.language ? { metadata: { captured_language: params.language } } : {}),
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

  await sentinelWrite(supabase, supabase.from('lifecycle_events').insert({
    brokerage_id: params.brokerageId,
    entity_type: 'contact',
    entity_id: contactId,
    event_type: KernelEvent.CONTACT_CAPTURED,
    metadata: {
      source: params.source,
      ...(createAttribution ? { assignment: createAttribution } : {}),
    },
  }), { table: "lifecycle_events", flow: "lifecycle_events_echo", reason: "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped" })

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
      // any contact type a manager picks up, it has already granted portal access
      // (sendMagicLink: false) and sent an agent-signed welcome carrying the portal
      // door. Re-inviting with the OTP mail armed put a SECOND, generic email on top
      // of it — the same duplicate the conversion lanes were carrying, and the
      // owner's them-first ruling forbids the generic one specifically. The invite
      // row itself is still (re)created either way: the grant and the email are
      // different things.
      //
      // ARMED BY EXACTLY THE COMPLEMENT of resolveWelcomeManagers — an EMPTY manager
      // set means no agent-signed welcome exists to carry the door, so the magic
      // link is the only thing that will ever tell this contact their portal is
      // there. One function decides on both lanes (§6).
      const { resolveWelcomeManagers } = await import('@/lib/kernel/client-welcome')
      const { createSystemPortalInvite } = await import('@/lib/portal/portal-invite-core')
      await createSystemPortalInvite({
        contactId,
        agentUserId: agentRow.user_id,
        sendMagicLink: resolveWelcomeManagers(params.contact_type ?? null).length === 0,
      })
    }
  } catch (err) {
    console.error('[captureContact] portal invite failed (non-fatal):', err)
  }

  const createdPerson = await recordCapturePersonEvidence(supabase, params, contactId, 'created', 1)
  return { contactId, action: 'created', ...createdPerson }
}

// ═════════════════════════════════════════════════════════════════════════════
// CONTRACT C8 — THE CONSENTED SUBMISSION (wave 147, lane 147A; owner ruling 1, 2026-10-31)
// ═════════════════════════════════════════════════════════════════════════════
//
// OWNER RULING, verbatim: "When a person enters their info on a form, etc. there is a consent box so these need to go in as a
// contact not a lead." An identifiable person who submits WITH the applicable consent is deduplicated onto the canonical
// Contact directly; the consent wording, timestamp, source, channel, permitted purposes and tenant are recorded; no intermediate
// lead exists for qualification. Anonymous, purchased or mined records keep the raw-lead / lead identity gates
// (lib/kernel/scraping.ts ingestRawSourceBatch → lib/lead-pipeline/canonical-lead-eligibility.ts) — this door REFUSES them with
// `route: 'raw_pipeline'` rather than minting a contact from a fragment.
//
// THE ONE SURVIVOR IS captureContact (above) — the public-capture dedup verdict 14 doors already call, with person identity,
// the welcome (ensureClientWelcome, wave 146C), the portal invite and the enrichment queue wired ONCE inside. C8 is the contract
// AROUND it, not a second pipeline:
//
//   tenant (the verified form owner — a forged body names a form, never a tenant) → identifiable? → idempotency key (tenant ×
//   identity × consent evidence) → withActionLedger `contact.consented_intake.record` (a replay re-reads, never re-acts) →
//   captureContact (dedupe → Contact upsert → welcome → enrichment queue → person evidence) → completeConsentedIntake: the
//   consent record (m889 scope through THE one consent writer), any same-person open LEAD in the tenant closed onto the contact
//   (the C2 boundary: communication ends in the lead table), emitKernelEvent(contact_consented_intake), the AI ISA desk told on
//   the bus (publishManagerSignal contact_consented_intake).
//
// Two doors keep their OWN upsert this wave and call completeConsentedIntake directly after it (lib/kernel/lead-magnets.ts
// captureFormSubmission, lib/ads/ad-lead-intake.ts ingestConsentedAdLead) — their proofs drive them on an injected in-memory
// client that captureContact's dependency graph (assignment, notification engine, portal invite) cannot ride yet. Stated in the
// lane notes as the DUPLICATED upsert half still to merge, with the blocker; the consent / event / signal half is already one.

/** The tables a consented form can be OWNED by — the tenant is read off the owning row, never taken from the body. */
const CONSENT_FORM_OWNER_TABLES = ['lead_capture_forms', 'qr_codes', 'embed_widgets', 'chat_sessions', 'listings', 'agents'] as const
export type ConsentFormOwnerTable = (typeof CONSENT_FORM_OWNER_TABLES)[number]

/** One consent box on the submission. `family` is the box's channel family: 'phone' (TCPA — calls + texts) or 'email'. */
export interface ConsentGrantInput {
  family: 'phone' | 'email'
  given: boolean
  /** The exact wording the person saw beside the box. Null only when the door genuinely cannot say (recorded as unrecorded). */
  text: string | null
  /** The door's own version label for that wording (e.g. 'qr_landing:2026-10'). */
  textVersion?: string | null
  /** What the form itself offered (added to the purposes the wording names). */
  purposes?: readonly ConsentPurpose[]
  /**
   * Only for wording that REFERS to the methods the person provided ("…via the contact methods I provided") instead of naming
   * channels: the door names the channels those methods are. Otherwise omitted — the channels are what the wording names.
   */
  channels?: readonly ConsentChannel[]
}

export interface ConsentedIntakeEvidence {
  /** When the person submitted (the submission's own time). Defaults to now. */
  capturedAt?: string | null
  /** The intake channel — 'web_form' | 'qr' | 'embed' | 'chat_widget' | 'landing_page' | 'portal_inquiry' | 'ad_form' | 'lead_magnet' | … */
  channel: string
  sourceUrl?: string | null
  /** The evidence pointer: ip, user agent, form / submission / session / QR id. A provider's own submission id goes in
   *  `submission_ref` and makes a webhook retry hit the same idempotency key exactly. */
  evidence: Record<string, unknown>
  /** The row that OWNS the form — its brokerage_id must equal the capture's tenant (cross-tenant refusal). */
  formOwner?: { table: ConsentFormOwnerTable; id: string } | null
}

export type ConsentedIntakeParams =
  Omit<CaptureContactParams, 'tcpa_consent' | 'tcpa_consent_date' | 'tcpa_consent_text' | 'tcpa_consent_source'> & {
    consents: readonly ConsentGrantInput[]
    intake: ConsentedIntakeEvidence
  }

export type ConsentedIntakeRefusal = 'not_identifiable' | 'cross_tenant_form' | 'form_not_found' | 'form_owner_unreadable' | 'ledger_refused' | 'in_flight' | 'capture_failed'

export interface ConsentedIntakeResult {
  ok: boolean
  refused?: ConsentedIntakeRefusal
  reason?: string
  /** Set on a not_identifiable refusal: the record belongs in the raw pipeline (dedup → enrich → dedup → lead gate). */
  route?: 'raw_pipeline'
  /** The same submission was already recorded — nothing was re-done (no second contact, consent, welcome or signal). */
  replay?: boolean
  contactId?: string
  action?: 'created' | 'merged'
  personId?: string | null
  consentEventIds: { phone: string | null; email: string | null }
  idempotencyKey?: string
  /** The open same-person leads in this tenant the intake closed onto the contact (leads.contact_id stamped). */
  leadsClosed: string[]
  /** Enrichment evidence: a pending / processing lead_enrichment_queue row exists for the contact after the capture. */
  enrichmentQueued?: boolean
  signalId?: string | null
  eventEmitted?: boolean
  /** False when the m889 scope columns were absent and the legacy consent row was written instead. */
  scopeStored?: boolean
  warnings: string[]
}

type IntakeClient = { from: (table: string) => any; rpc?: (...a: any[]) => any }

/** PURE — the identity half of the idempotency key: normalised email, else phone digits. */
function consentedIntakeIdentityKey(p: { email?: string | null; phone?: string | null }): string | null {
  const email = (p.email ?? '').trim().toLowerCase()
  if (email) return `e:${email}`
  const digits = (p.phone ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  return digits ? `p:${digits}` : null
}

/**
 * PURE — one consent per (tenant, identity, consent evidence). The evidence part is the provider's own submission reference
 * when the door has one (a webhook retry carries it verbatim), else the submission time; plus every box's family, answer and
 * wording hash, so a different box or different wording is a different consent.
 */
function consentedIntakeIdempotencyKey(input: {
  brokerageId: string
  identityKey: string
  source: string
  consents: readonly ConsentGrantInput[]
  submissionRef?: string | null
  capturedAt: string
}): string {
  const grants = [...input.consents]
    .map((g) => `${g.family}:${g.given ? 1 : 0}:${consentTextHash(g.text) ?? 'unrecorded'}`)
    .sort()
    .join('|')
  const evidence = (input.submissionRef ?? '').trim() || input.capturedAt
  return 'c8:' + createHash('sha256').update([input.brokerageId, input.identityKey, input.source, grants, evidence].join('§')).digest('hex').slice(0, 40)
}

/** Read the owning row's tenant. Fail closed: unreadable is a refusal, a different tenant is a refusal. */
async function verifyFormOwner(
  svc: IntakeClient, brokerageId: string, owner: { table: ConsentFormOwnerTable; id: string },
): Promise<{ ok: true } | { ok: false; refused: ConsentedIntakeRefusal; reason: string }> {
  if (!(CONSENT_FORM_OWNER_TABLES as readonly string[]).includes(owner.table)) {
    return { ok: false, refused: 'form_owner_unreadable', reason: `form owner table ${owner.table} is not a consent-form owner` }
  }
  const { data, error } = await svc.from(owner.table).select('id, brokerage_id').eq('id', owner.id).maybeSingle()
  if (error) return { ok: false, refused: 'form_owner_unreadable', reason: `form owner read refused: ${error.message}` }
  if (!data) return { ok: false, refused: 'form_not_found', reason: `${owner.table} ${owner.id} not found` }
  const ownerTenant = (data as { brokerage_id?: string | null }).brokerage_id ?? null
  if (!ownerTenant || ownerTenant !== brokerageId) {
    return { ok: false, refused: 'cross_tenant_form', reason: `${owner.table} ${owner.id} belongs to another tenant — a form owned by one brokerage never creates a contact in another` }
  }
  return { ok: true }
}

/**
 * THE C8 ENTRY. Every consented public door calls this (the door census is in the lane-147A notes). Never throws on a refusal —
 * it answers with `refused`; a capture failure (no eligible agent, a refused insert) is `capture_failed` with the reason.
 */
export async function captureConsentedContact(
  params: ConsentedIntakeParams,
  opts: { client?: IntakeClient } = {},
): Promise<ConsentedIntakeResult> {
  const base: ConsentedIntakeResult = { ok: false, consentEventIds: { phone: null, email: null }, leadsClosed: [], warnings: [] }
  const svc: IntakeClient = opts.client ?? createServiceClient()

  // 1 — IDENTIFIABLE. A fragment (no name, or no email and no phone) is not a person we can put on a contact: it keeps the
  //     raw-lead gates. Refused, routed — never silently created.
  const hasName = !!((params.first_name ?? '').trim() || (params.last_name ?? '').trim())
  const identityKey = consentedIntakeIdentityKey(params)
  if (!hasName || !identityKey) {
    return { ...base, refused: 'not_identifiable', route: 'raw_pipeline', reason: 'not identifiable (a name AND an email or phone are required) — route it through the raw pipeline' }
  }

  // 2 — TENANT. The capture's brokerage must be the form owner's (the door read it off the owning row; this re-reads it).
  if (params.intake.formOwner) {
    const owner = await verifyFormOwner(svc, params.brokerageId, params.intake.formOwner)
    if (!owner.ok) return { ...base, refused: owner.refused, reason: owner.reason }
  }

  const capturedAt = params.intake.capturedAt ?? new Date().toISOString()
  const submissionRef = typeof params.intake.evidence?.submission_ref === 'string' ? (params.intake.evidence.submission_ref as string) : null
  const idempotencyKey = consentedIntakeIdempotencyKey({
    brokerageId: params.brokerageId, identityKey, source: String(params.source), consents: params.consents, submissionRef, capturedAt,
  })

  // 3 — REPLAY rides the action ledger's own idempotency (the claim on this key → 23505 → the winner's row → replay, never a
  //     second act). The consent writer's party-scoped key match is the second layer (an unledgered degrade still writes one
  //     consent per key), and m889's unique index the race backstop.
  const phoneGrant = params.consents.find((g) => g.family === 'phone' && g.given) ?? null
  const { withActionLedger } = await import('@/lib/kernel/action-ledger')
  const result = await withActionLedger<ConsentedIntakeResult>(
    {
      brokerageId: params.brokerageId,
      action: 'contact.consented_intake.record',
      actor: { type: 'system', userId: null },
      subject: { type: 'person', ref: identityKey.startsWith('e:') ? 'email' : 'phone' },
      idempotencyKey,
      reasonCode: 'CONVERSATION_RESPONSE',
      reasonDetail: `consented ${params.intake.channel} submission via ${String(params.source)}`.slice(0, 500),
      riskClass: 'LOW_RISK_WRITE',
      channel: params.intake.channel,
      systemSource: 'consented_intake',
      detail: {
        source: params.source, intake_channel: params.intake.channel, source_url: params.intake.sourceUrl ?? null,
        consents: params.consents.map((g) => ({ family: g.family, given: g.given, text_hash: consentTextHash(g.text), text_version: g.textVersion ?? null })),
        form_owner: params.intake.formOwner ?? null,
      },
    },
    async () => {
      let captured: CaptureContactResult
      try {
        captured = await captureContact({
          ...params,
          tcpa_consent: !!phoneGrant,
          tcpa_consent_date: phoneGrant ? capturedAt : null,
          tcpa_consent_text: phoneGrant?.text ?? null,
          tcpa_consent_source: phoneGrant ? String(params.source) : null,
        })
      } catch (e) {
        return { ...base, refused: 'capture_failed' as const, reason: e instanceof Error ? e.message : String(e), idempotencyKey }
      }
      const done = await completeConsentedIntake(svc, {
        brokerageId: params.brokerageId, contactId: captured.contactId, action: captured.action,
        personId: captured.personId ?? null, agentId: params.ownerAgentId ?? null,
        email: params.email ?? null, phone: params.phone ?? null,
        source: String(params.source), consents: params.consents, intake: { ...params.intake, capturedAt }, idempotencyKey,
      })
      return { ...done, ok: true, contactId: captured.contactId, action: captured.action, personId: captured.personId ?? null, idempotencyKey }
    },
    {
      settle: (r) => r.ok
        ? { status: 'executed', outcome: `contact_${r.action}`, provider: 'contact_capture', providerRef: r.contactId ?? null }
        : { status: 'failed', outcome: r.refused ?? 'failed', error: r.reason ?? null },
      replay: (claim) => {
        if (claim.kind === 'refused') return { ...base, refused: 'ledger_refused', reason: `the action ledger refused the claim (${claim.error}) — nothing was captured (fail closed)`, idempotencyKey }
        if (claim.kind === 'in_flight') return { ...base, refused: 'in_flight', reason: 'this exact submission is being recorded right now — not captured twice', idempotencyKey }
        const contactId = claim.entry.provider_ref ?? undefined
        return { ...base, ok: !!contactId, replay: true, contactId, idempotencyKey, ...(contactId ? {} : { refused: 'capture_failed' as const, reason: `an earlier attempt settled ${claim.entry.status} (${claim.entry.outcome ?? 'no outcome'})` }) }
      },
    },
    { client: svc },
  )
  if (result.replay && result.contactId) result.consentEventIds = await consentIdsForKey(svc, params.brokerageId, result.contactId, idempotencyKey)
  return result
}

/** The consent rows an earlier attempt wrote under this key (`<key>:phone` / `<key>:email`) on this contact — party-scoped `*`
 *  read matched here (a filter naming the m889 column would be refused before it is applied). Unreadable → nulls, said by the caller. */
async function consentIdsForKey(
  svc: IntakeClient, brokerageId: string, contactId: string, idempotencyKey: string,
): Promise<ConsentedIntakeResult['consentEventIds']> {
  try {
    const { data, error } = await svc.from('contact_consent_events').select('*').eq('brokerage_id', brokerageId).eq('contact_id', contactId).limit(200)
    if (error || !data) return { phone: null, email: null }
    const rows = data as Array<{ id: string; idempotency_key?: string | null }>
    return {
      phone: rows.find((r) => r.idempotency_key === `${idempotencyKey}:phone`)?.id ?? null,
      email: rows.find((r) => r.idempotency_key === `${idempotencyKey}:email`)?.id ?? null,
    }
  } catch {
    return { phone: null, email: null }
  }
}

/**
 * THE C8 RECORD HALF — after the Contact exists. Exported for the two doors that still own their upsert. Never throws; every
 * best-effort step that did not land is named in `warnings` (nobody checked never reads as checked and fine).
 */
export async function completeConsentedIntake(
  svc: IntakeClient,
  input: {
    brokerageId: string
    contactId: string
    action: 'created' | 'merged'
    personId?: string | null
    /** agents.id of the owner, when known (the consent row's agent_id). */
    agentId?: string | null
    email?: string | null
    phone?: string | null
    source: string
    consents: readonly ConsentGrantInput[]
    intake: ConsentedIntakeEvidence
    /** The C8 key; a door with its own upsert passes its own stable key (e.g. its submission id). */
    idempotencyKey?: string | null
    /** False when the door already stamped the contact's tcpa_* columns itself (default: false — captureContact did). */
    stampPartyColumns?: boolean
  },
): Promise<Omit<ConsentedIntakeResult, 'ok'>> {
  const out: Omit<ConsentedIntakeResult, 'ok'> = { consentEventIds: { phone: null, email: null }, leadsClosed: [], warnings: [] }
  const capturedAt = input.intake.capturedAt ?? new Date().toISOString()
  const ev = input.intake.evidence ?? {}
  const ip = typeof ev.ip === 'string' ? ev.ip : null
  const ua = typeof ev.user_agent === 'string' ? ev.user_agent : null

  // (a) THE CONSENT RECORD — one row per GIVEN box, through THE one consent writer, with the m889 scope. A box left unticked is
  //     not a withdrawal (a returning consented contact who skips it this time keeps what they gave before) and writes nothing.
  const { persistContactConsent } = await import('@/lib/kernel/compliance/require-contact-consent')
  for (const g of input.consents) {
    if (!g.given) continue
    const text = (g.text ?? '').trim() || `[consent wording not recorded by ${input.source}]`
    const w = await persistContactConsent({
      brokerageId: input.brokerageId, agentId: input.agentId ?? null, contactId: input.contactId,
      channel: g.family, consentText: text, consentSource: input.source, consented: true,
      ipAddress: ip, userAgent: ua, stampPartyColumns: input.stampPartyColumns ?? false, client: svc,
      scope: {
        textVersion: g.textVersion ?? (g.text ? null : 'unrecorded'),
        purposes: canonicalConsentPurposes([...(g.purposes ?? []), ...purposesNamedInConsentText(g.text)]),
        // An EMAIL box is an email consent by the door's own declaration (the widget's separate box); a PHONE box grants
        // exactly the channels its wording names (calls / texts — and email or mail when the same sentence names them).
        channels: g.channels ? [...g.channels] : g.family === 'email' ? ['email'] : channelsNamedInConsentText(g.text),
        sourceUrl: input.intake.sourceUrl ?? null,
        evidence: { ...ev, intake_channel: input.intake.channel, form_owner: input.intake.formOwner ?? null },
        idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:${g.family}` : null,
        personId: input.personId ?? null,
        capturedAt,
      },
    }).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e), consentEventId: null } as const))
    out.consentEventIds[g.family] = w.consentEventId
    if ('scopeStored' in w && w.scopeStored === false) out.scopeStored = false
    else if (w.consentEventId && out.scopeStored !== false) out.scopeStored = true
    if (!w.consentEventId) out.warnings.push(`${g.family} consent row NOT recorded: ${('error' in w && w.error) || 'the consent ledger refused it'}`)
  }

  // (b) THE C2 BOUNDARY — a same-person LEAD still open in THIS tenant (a scrape found them first) is closed onto the contact:
  //     leads.contact_id + converted_at through THE one link writer (history-carry), then deactivateLead. From here the lead
  //     table is provenance only; every lead-keyed sender already refuses a row with contact_id (conversion-finality).
  try {
    const email = (input.email ?? '').trim().toLowerCase()
    const digits = (input.phone ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
    const ors = [email ? `email.eq.${email}` : null, digits.length === 10 ? `phone_digits.eq.${digits}` : null].filter(Boolean).join(',')
    if (ors) {
      const { data: open, error: openErr } = await svc.from('leads').select('id')
        .eq('brokerage_id', input.brokerageId).is('contact_id', null).or(ors).limit(5)
      if (openErr) out.warnings.push(`open-lead read refused (no lead closed): ${openErr.message}`)
      for (const l of (open ?? []) as Array<{ id: string }>) {
        const { carryLeadHistoryToContact } = await import('@/lib/contact-promotion/history-carry')
        const carried = await carryLeadHistoryToContact(svc, { leadId: l.id, contactId: input.contactId, brokerageId: input.brokerageId })
        if (!carried.linked) { out.warnings.push(`lead ${l.id} NOT closed onto the contact: ${carried.warnings.join('; ')}`); continue }
        const { deactivateLead } = await import('@/lib/contact-promotion/lead-deactivator')
        const off = await deactivateLead(svc, l.id)
        if (!off.success) out.warnings.push(`lead ${l.id} linked but not deactivated: ${off.error ?? 'unknown'}`)
        out.leadsClosed.push(l.id)
      }
    }
  } catch (e) {
    out.warnings.push(`lead closure threw (contact unaffected): ${e instanceof Error ? e.message : String(e)}`)
  }

  // (c) ENRICHMENT EVIDENCE — captureContact queued Customer 360 enrichment through the survivor (queueContactEnrichment: the
  //     budget gates, live-deal suppression and freshness live there). Read back, not assumed.
  try {
    const { data: q, error: qErr } = await svc.from('lead_enrichment_queue').select('id')
      .eq('contact_id', input.contactId).in('status', ['pending', 'processing']).limit(1)
    if (qErr) out.warnings.push(`enrichment queue unreadable: ${qErr.message}`)
    else out.enrichmentQueued = ((q ?? []) as unknown[]).length > 0
  } catch (e) {
    out.warnings.push(`enrichment read threw: ${e instanceof Error ? e.message : String(e)}`)
  }

  const purposes = canonicalConsentPurposes(input.consents.filter((g) => g.given).flatMap((g) => [...(g.purposes ?? []), ...purposesNamedInConsentText(g.text)]))
  const channels = [...new Set(input.consents.filter((g) => g.given).flatMap((g) => g.channels ? [...g.channels] : g.family === 'email' ? ['email' as const] : channelsNamedInConsentText(g.text)))]
  const metadata = {
    consent_event_ids: out.consentEventIds, purposes, channels, source: input.source, intake_channel: input.intake.channel,
    capture_action: input.action, leads_closed: out.leadsClosed, idempotency_key: input.idempotencyKey ?? null, person_id: input.personId ?? null,
  }

  // (d) THE KERNEL EVENT (auditOnly — the row with lineage; the reactor has no rule).
  try {
    const { emitKernelEvent } = await import('@/lib/kernel/emit')
    const r = await emitKernelEvent({
      event: KernelEvent.CONTACT_CONSENTED_INTAKE, brokerageId: input.brokerageId, entityType: 'contact', entityId: input.contactId,
      contactId: input.contactId, auditOnly: true, metadata, client: svc,
    })
    out.eventEmitted = !!(r as { inserted?: boolean }).inserted
    if (!out.eventEmitted) out.warnings.push(`contact_consented_intake event not written: ${(r as { error?: string | null }).error ?? 'unknown'}`)
  } catch (e) {
    out.eventEmitted = false
    out.warnings.push(`contact_consented_intake emit threw: ${e instanceof Error ? e.message : String(e)}`)
  }

  // (e) THE ARBITER'S DESK IS TOLD — Data Steward → AI ISA on the governed bus, idempotent per open (to, type, contact).
  try {
    const { publishManagerSignal } = await import('@/lib/kernel/manager-signals')
    const consentWords = channels.length ? channels.join(' / ') : 'no channel named in the wording'
    const sig = await publishManagerSignal({
      brokerageId: input.brokerageId, fromManager: 'data_steward', toManager: 'ai_isa', signalType: 'contact_consented_intake',
      message: `A person ${input.action === 'created' ? 'joined' : 'came back'} through ${input.intake.channel} with consent (${consentWords}${purposes.length ? `; about ${purposes.join(', ')}` : ''}) — they are a CONTACT now. Decide the next step from their consent record and intent; the welcome already went.`,
      entityType: 'contact', entityId: input.contactId, contactId: input.contactId, payload: metadata,
    }, svc as never)
    out.signalId = sig.ok ? sig.signalId ?? null : null
    if (!sig.ok) out.warnings.push(`arbiter signal not published: ${sig.reason ?? 'unknown'}`)
  } catch (e) {
    out.warnings.push(`arbiter signal threw: ${e instanceof Error ? e.message : String(e)}`)
  }
  return out
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

  await sentinelWrite(supabase, supabase.from('lead_score_history').insert({
    contact_id: params.contactId,   // contact_id NOT lead_id
    lead_id: null,
    brokerage_id: params.brokerageId,
    score: scoreResult.finalScore,
    scoring_factors: scoreResult.factors,
    explanation: scoreResult.explanation,
    scored_at: new Date().toISOString(),
  }), { table: "lead_score_history", flow: "lead_score_history_write", reason: "score history row; the score itself is returned" })

  await sentinelWrite(
    supabase,
    supabase
      .from('contacts')
      .update({ last_scored_at: new Date().toISOString() })
      .eq('id', params.contactId),
    {
      table: 'contacts',
      flow: 'contact_capture_score_recency_stamp',
      brokerageId: params.brokerageId,
      reason:
        'round-robin recency stamp for the scorer; the score itself is already on lead_score_history above and re-scoring is idempotent, so a lost stamp costs an early re-score, not a fact',
    },
  )

  await sentinelWrite(supabase, supabase.from('lifecycle_events').insert({
    brokerage_id: params.brokerageId,
    entity_type: 'contact',
    entity_id: params.contactId,
    event_type: KernelEvent.CONTACT_SCORED,
    metadata: { score: scoreResult.finalScore },
  }), { table: "lifecycle_events", flow: "lifecycle_events_echo", reason: "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped" })

  await processKernelEvent({
    event: KernelEvent.CONTACT_SCORED,
    brokerageId: params.brokerageId,
    entityType: 'contact',
    entityId: params.contactId,
  })
}
