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
// C15 (wave 148): the ONE consent component's pure wording + submission contract — the same module the React component imports.
import {
  CONSENT_COMPONENT_VERSION, consentComponentWording, consentGrantsFor, consentWordingText, parseConsentSubmission,
  type ConsentComponentSubmission, type ConsentDoorKey,
} from '@/lib/kernel/compliance/consent-component'
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

  // ── WAVE 148 (lane 148B — owner rulings 4 + 12): THE DOOR'S OWN SEMANTICS, CARRIED BY THE ONE DOOR ──────────────────────
  // The seven doors that used to insert contacts their own way each wrote a few columns of their own. Those columns are
  // now first-class here so a door can move onto captureContact WITHOUT losing them. Every one is CREATE-path data; on a
  // MERGE they are fill-if-empty (prior history is preserved — the first touch, the first source, the first owner win).

  /**
   * users.id of the agent/user who CREATED the form, profile, QR code, open house or import the person came through —
   * owner ruling 12 ("these will also hold the agent/user that creates so the person gets assigned back to them").
   * Stored in contacts.source_agent_id (FK users — "who SOURCED it", the column lib/agents/agent-deactivation.ts already
   * classifies the book by), fill-if-empty on merge. When `ownerAgentId` is absent the creator's agents row becomes the
   * assignment hint, so the person is assigned back to the creator.
   */
  creatorUserId?: string | null
  /** Team affinity of the door (a team-owned widget / QR) — the assignment resolver's team hint. */
  teamId?: string | null
  /** contacts.status on CREATE only (vocabulary: check-vocabularies contacts.status). Never changed on a merge. */
  status?: string | null
  source_family?: string | null
  source_subtype?: string | null
  /** contacts.source_channel (first-touch arrival channel) — fill-if-empty on merge. */
  source_channel?: string | null
  /** The VERIFIED (this tenant's) marketing_campaigns.id — first-touch attribution, fill-if-empty on merge. */
  campaign_attribution_id?: string | null
  /** contacts.embed_widget_id — the widget the person arrived through, fill-if-empty on merge. */
  embed_widget_id?: string | null
  contact_persona?: string | null
  /** contacts.ai_isa_enabled on CREATE only. */
  ai_isa_enabled?: boolean | null
  /** contacts.isa_reengage_allowed on CREATE only (default true; a kiosk contact holds false). */
  isa_reengage_allowed?: boolean | null
  /** The IP the TCPA box was ticked from — stamped only with the consent it evidences. */
  tcpa_consent_ip?: string | null
  /**
   * THE PERSON'S SITUATION (owner ruling 12: "other fields for identity and attributes about that person's situation").
   * What the person SAID on the form — never inferred. Vocabularies are the live CHECKs (contacts.timeline buckets per
   * CLAUDE.md §5: 1-3 / 3-6 / 6-12, never 30/60/90). Fill-if-empty on merge; a conflicting answer is kept in notes.
   */
  timeline?: string | null
  budget_min?: number | null
  budget_max?: number | null
  property_type?: string | null
  beds?: number | null
  baths?: number | null
  preferred_contact_time?: string | null
  /** Merged into contacts.metadata key by key, fill-if-empty (an earlier capture's keys are never overwritten). */
  metadata?: Record<string, unknown> | null
  /** The open-house origin the welcome mentions (lib/kernel/client-welcome.ts EnsureClientWelcomeOptions.origin). */
  welcomeOrigin?: import('@/lib/kernel/client-welcome').EnsureClientWelcomeOptions['origin']
  /**
   * WAVE 148 (148Z — ruling 4, lane 148B Still open 1): a STAFF create through the CRM (lib/kernel/crm.ts
   * createOrUpdateContactFromDirectIntake — the add dialog, the transaction sheet, the widget callback, the lead desk's manual
   * conversion). Two semantics only that door needs, both narrower-or-equal to a public door's:
   *   · a person may be filed by NAME ALONE (a transaction party whose email / phone the agent does not hold yet) — the
   *     viability gate exists to refuse anonymous public junk, and a staff member naming a client is not that;
   *   · the lead-conversion FAST PATH is never taken — the CRM dedupes every create (it always did), including the lead desk's
   *     conversion whose lead may never have been deduped against the book.
   * Public doors never set it. It grants no consent, no owner and no status the caller could not already pass.
   */
  staffCreate?: boolean
}

/**
 * THE INJECTED-CLIENT CONTRACT (wave 148, lane 148B — owner ruling 4; the blocker lane 147Z recorded: "captureContact has no
 * injected-client seam. It creates its own service client, so the doors running on a session client or an injected test
 * client cannot ride it unchanged").
 *
 * `client` — every read and write captureContact makes (dedupe, owner lookup, assignment, the contact upsert, the lifecycle
 * echo, the score, person evidence, the welcome ledger, the enrichment queue) rides it. A door passes the client it already
 * gated with: a service client after its own tenant gate, the session client where RLS is the gate, an in-memory client in
 * a proof. Omitted → the service client (unchanged for every existing caller).
 *
 * `effects` — the side effects that mint their OWN service client (the notification engine's fan-out and the portal invite)
 * or run paid/model work (the welcome, the enrichment drain). Each is best-effort AFTER the contact exists: a failure is
 * logged by name and never unwinds a landed capture. A proof stubs them; production passes none.
 */
export type CaptureClient = { from: (table: string) => any; rpc?: (...a: any[]) => any }
export interface CaptureContactEffects {
  notify?: typeof processKernelEvent
  welcome?: (svc: CaptureClient, contact: { id: string; brokerageId: string; contactType: string | null; firstName: string | null; lastName: string | null }, opts: { origin?: CaptureContactParams['welcomeOrigin'] }) => Promise<unknown>
  portalInvite?: (p: { contactId: string; agentUserId: string; sendMagicLink: boolean }) => Promise<unknown>
  /** WAVE 150 (lane 150PU, canary 4): the assigned agent's personal portal welcome video — commissioned LAST, after the portal
   *  invite and the welcome, so nothing the person receives waits on a render (the spine renders asynchronously). */
  welcomeVideo?: (svc: CaptureClient, p: { contactId: string; agentId: string; brokerageId: string; origin?: CaptureContactParams['welcomeOrigin'] }) => Promise<unknown>
  enrich?: (p: { brokerageId: string; contactId: string; client: CaptureClient }) => Promise<void>
}
export interface CaptureContactOptions {
  client?: CaptureClient
  effects?: CaptureContactEffects
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
  supabase: CaptureClient,
  params: CaptureContactParams,
  contactId: string,
  action: 'created' | 'merged',
  matchScore: number,
): Promise<{ personId: string | null; personIdentity: NormalizedPersonIdentity | null }> {
  try {
    const { resolvePerson, linkPersonEvidence } = await import('@/lib/kernel/person-identity')
    const person = await resolvePerson(supabase as never, {
      brokerageId: params.brokerageId,
      firstName: params.first_name ?? null, lastName: params.last_name ?? null,
      email: params.email ?? null, phone: params.phone ?? null,
    })
    if (!person.ok) {
      if (person.reason !== 'no_identity_anchor') console.warn(`[contact-capture] person identity not resolved: ${person.reason}`)
      return { personId: null, personIdentity: null }
    }
    const link = await linkPersonEvidence(supabase as never, {
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

// ─── Dedupe (wave 148, lane 148B — "dedupe before insert") ────────────────────
//
// PURE — the identity keys a capture dedupes on: the normalised email, and the phone's digit forms. contacts.phone_digits
// is GENERATED as regexp_replace(phone, '\D', '', 'g') (lib/application/lead-application-service.ts, m488), so a number
// stored as "+1 (555) 123-4567" holds "15551234567" and one stored as "555-123-4567" holds "5551234567": both forms are asked.
function captureIdentityKeys(p: { email?: string | null; phone?: string | null }): { email: string | null; phoneDigits: string[] } {
  const email = (p.email ?? '').trim().toLowerCase() || null
  const all = (p.phone ?? '').replace(/\D/g, '')
  const ten = all.length === 11 && all.startsWith('1') ? all.slice(1) : all
  const phoneDigits = ten.length >= 10 ? [...new Set([ten, `1${ten}`, all])] : []
  return { email, phoneDigits }
}

/**
 * The tenant's existing contacts that share an identity key with the capture. SEPARATE `.ilike` / `.in` / `.eq` reads instead
 * of one `.or("email.eq.<raw>,phone.eq.<raw>")` string: a public form's raw email or phone spliced into the or-grammar is a
 * filter INJECTION (a value carrying `,id.not.is.null` widened the match to the whole tenant, and the fuzzy scorer then merged
 * the submission into whichever contact scored best). FAIL CLOSED: a refused read THROWS — "nobody checked" must never become
 * "no match" and a second contact for a person already in the book (the defect lib/kernel/open-house.ts guarded against).
 */
async function findCaptureCandidates(supabase: CaptureClient, brokerageId: string, p: { email?: string | null; phone?: string | null }): Promise<Array<Record<string, any>>> {
  const keys = captureIdentityKeys(p)
  const byId = new Map<string, Record<string, any>>()
  const reads: Array<{ what: string; q: any }> = []
  if (keys.email) reads.push({ what: 'email', q: supabase.from('contacts').select('*').eq('brokerage_id', brokerageId).ilike('email', keys.email.replace(/[\\%_]/g, (c) => `\\${c}`)) })
  if (keys.phoneDigits.length) reads.push({ what: 'phone_digits', q: supabase.from('contacts').select('*').eq('brokerage_id', brokerageId).in('phone_digits', keys.phoneDigits) })
  if ((p.phone ?? '').trim()) reads.push({ what: 'phone', q: supabase.from('contacts').select('*').eq('brokerage_id', brokerageId).eq('phone', (p.phone ?? '').trim()) })
  for (const r of reads) {
    const { data, error } = await r.q.limit(25)
    if (error) throw new Error(`Contact dedupe read (${r.what}) refused — nothing was created: ${error.message}`)
    for (const row of (data ?? []) as Array<Record<string, any>>) {
      if (row?.id && !row.deleted_at) byId.set(row.id, row)
    }
  }
  return [...byId.values()]
}

/** The incoming value lands only where the stored one is empty (fill-if-empty); a REAL conflict is reported for the notes. */
function fillIfEmpty(existing: Record<string, any> | null | undefined, incoming: Record<string, unknown>): { patch: Record<string, unknown>; conflicts: string[] } {
  const patch: Record<string, unknown> = {}
  const conflicts: string[] = []
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined || v === null || v === '') continue
    const prior = existing?.[k]
    if (prior === undefined || prior === null || prior === '') patch[k] = v
    else if (String(prior).trim().toLowerCase() !== String(v).trim().toLowerCase()) conflicts.push(`${k}: kept "${prior}", also saw "${v}"`)
  }
  return { patch, conflicts }
}

/** The door-semantics + situation columns of a capture (wave 148), only those the door actually supplied. */
function captureColumns(params: CaptureContactParams): { firstTouch: Record<string, unknown>; situation: Record<string, unknown>; createOnly: Record<string, unknown> } {
  const strip = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''))
  return {
    firstTouch: strip({
      source_agent_id: params.creatorUserId, source_channel: params.source_channel, campaign_attribution_id: params.campaign_attribution_id,
      embed_widget_id: params.embed_widget_id, contact_persona: params.contact_persona, team_id: params.teamId,
    }),
    situation: strip({
      timeline: params.timeline, budget_min: params.budget_min, budget_max: params.budget_max, property_type: params.property_type,
      beds: params.beds, baths: params.baths, preferred_contact_time: params.preferred_contact_time,
    }),
    createOnly: strip({ status: params.status, source_family: params.source_family, source_subtype: params.source_subtype, ai_isa_enabled: params.ai_isa_enabled }),
  }
}

/** Best-effort side effect: logged by name, never thrown (the contact already exists; "nobody checked" is said, not hidden). */
async function bestEffortEffect(name: string, fn: () => Promise<unknown>): Promise<void> {
  try { await fn() } catch (err) {
    console.error(`[captureContact] ${name} failed (the capture stands):`, err instanceof Error ? err.message : String(err))
  }
}

// ─── captureContact ───────────────────────────────────────────────────────────

export async function captureContact(
  params: CaptureContactParams,
  opts: CaptureContactOptions = {},
): Promise<CaptureContactResult> {
  const supabase: CaptureClient = opts.client ?? createServiceClient()
  const effects = opts.effects ?? {}
  const notify = effects.notify ?? processKernelEvent
  // WAVE 148Z (lane J2's canary): the score step's fan-out rides the SAME `notify` the door was given — it called
  // processKernelEvent directly, which mints its own service client, so an injected-client capture still made two of its own.
  const enrich = effects.enrich ?? ((p: { brokerageId: string; contactId: string; client: CaptureClient }) => queueContactEnrichmentAndScore({ brokerageId: p.brokerageId, contactId: p.contactId }, { client: p.client, notify }))
  const welcome = effects.welcome ?? (async (svc: CaptureClient, contact: { id: string; brokerageId: string; contactType: string | null; firstName: string | null; lastName: string | null }, o: { origin?: CaptureContactParams['welcomeOrigin'] }) => {
    const { ensureClientWelcome } = await import('@/lib/kernel/client-welcome')
    return ensureClientWelcome(svc as any, contact, { origin: o.origin ?? null })
  })
  const portalInvite = effects.portalInvite ?? (async (p: { contactId: string; agentUserId: string; sendMagicLink: boolean }) => {
    const { createSystemPortalInvite } = await import('@/lib/portal/portal-invite-core')
    return createSystemPortalInvite({ contactId: p.contactId, agentUserId: p.agentUserId, sendMagicLink: p.sendMagicLink })
  })
  // ONE commissioning path (lib/contact-promotion/welcome-avatar-video.ts ensureWelcomeAvatarVideo — the spine's own idempotency
  // ledger answers `already_commissioned` before any draft, so a door that ALSO reaches deliverConversionWelcome spends once).
  const welcomeVideo = effects.welcomeVideo ?? (async (svc: CaptureClient, p: { contactId: string; agentId: string; brokerageId: string; origin?: CaptureContactParams['welcomeOrigin'] }) => {
    const { ensureWelcomeAvatarVideo } = await import('@/lib/contact-promotion/welcome-avatar-video')
    const r = await ensureWelcomeAvatarVideo(svc, { contactId: p.contactId, agentId: p.agentId, brokerageId: p.brokerageId, origin: p.origin ?? null })
    for (const w of r.warnings) console.warn(`[captureContact] welcome video: ${w}`)
    return r
  })

  // ── Viability gate ───────────────────────────────────────────────────────
  const hasName = !!(
    (params.first_name ?? '').trim() || (params.last_name ?? '').trim()
  )
  const hasContact = !!(
    (params.email ?? '').trim() || (params.phone ?? '').trim()
  )
  if (!hasName || (!hasContact && params.staffCreate !== true)) {
    throw new Error(
      'Contact viability failed: missing name or contact method',
    )
  }

  // ── Normalize owner hint (contacts.agent_id is agents.id) ────────────────
  // Accept either `ownerAgentId` (agents.id, the correct contract) or the
  // legacy `agentUserId` (users.id). If only the legacy field is set, look
  // up the matching agents.id via the agents table. Wave 148 (ruling 12): with
  // neither, the CREATOR's agents row is the hint — the person is assigned back
  // to the agent/user who made the form.
  let ownerAgentHint: string | null = params.ownerAgentId ?? null
  const ownerUserHint = !ownerAgentHint ? (params.agentUserId ?? params.creatorUserId ?? null) : null
  if (ownerUserHint) {
    const { data: agentRow, error: agentRowError } = await supabase
      .from('agents')
      .select('id')
      .eq('user_id', ownerUserHint)
      .eq('brokerage_id', params.brokerageId)
      .maybeSingle()
    if (agentRowError) console.warn(`[captureContact] owner hint lookup refused (assignment falls back to the rules): ${agentRowError.message}`)
    ownerAgentHint = agentRow?.id ?? null
  }
  const columns = captureColumns(params)
  const teamHint = params.teamId ?? null

  // ── Lead-conversion fast path ────────────────────────────────────────────
  // When a contact is being promoted from a lead record the lead was already
  // deduplicated and enriched. Skip directly to CREATE and skip enrichment
  // queue — the caller (contact-creator.ts) owns that data transfer.
  const isLeadConversion =
    (!!params.fromLeadId || LEAD_CONVERSION_SOURCES.has(params.source)) && params.staffCreate !== true

  if (isLeadConversion) {
    const assignment = await resolveAgentForContact({
      brokerageId: params.brokerageId,
      ownerAgentId: ownerAgentHint,
      teamId: teamHint,
      source: params.source,
      client: supabase,
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
        ...columns.firstTouch, ...columns.situation, ...columns.createOnly,
        preferred_channel: params.preferred_channel ?? 'email',
        source: params.source,
        tcpa_consent: params.tcpa_consent,
        tcpa_consent_date: params.tcpa_consent
          ? (params.tcpa_consent_date ?? new Date().toISOString())
          : null,
        isa_reengage_allowed: params.isa_reengage_allowed ?? true,
        dnc_status: false,
        notes: [params.fromLeadId ? `Promoted from lead ${params.fromLeadId}` : null, params.notes ?? null]
          .filter(Boolean).join('\n') || undefined,
        ...(params.language || params.metadata ? { metadata: { ...(params.metadata ?? {}), ...(params.language ? { captured_language: params.language } : {}) } } : {}),
      })
      .select('id')
      .single()

    if (createError || !created) {
      throw new Error(`Failed to create contact from lead: ${createError?.message ?? 'no data'}`)
    }

    await sentinelWrite(supabase as never, supabase.from('lifecycle_events').insert({
      brokerage_id: params.brokerageId,
      entity_type: 'contact',
      entity_id: created.id,
      event_type: KernelEvent.CONTACT_CAPTURED,
      metadata: { source: params.source, from_lead_id: params.fromLeadId ?? null },
    }), { table: "lifecycle_events", flow: "lifecycle_events_echo", reason: "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped" })

    // CLIENT WELCOME (concierge #1–2) — a new buyer/seller client gets the
    // gated warm-welcome + journey-map draft. Best-effort, never blocks capture.
    await bestEffortEffect('client welcome', () => welcome(supabase, {
      id: created.id, brokerageId: params.brokerageId,
      contactType: params.contact_type ?? null,
      firstName: params.first_name ?? null, lastName: params.last_name ?? null,
    }, { origin: params.welcomeOrigin }))

    return { contactId: created.id, action: 'created' }
  }

  // ── Dedup — only for direct public-form captures ─────────────────────────
  const candidates = await findCaptureCandidates(supabase, params.brokerageId, params)
  const incomingKeys = captureIdentityKeys(params)

  // ── Score each candidate ─────────────────────────────────────────────────
  // EXACT EMAIL IS THE SAME PERSON (wave 148): a returning person who typed a different phone (or a nickname) scored below
  // the fuzzy threshold on email alone and got a SECOND contact carrying the same email. A same-tenant exact email match is
  // a merge; the differing phone / name is kept as a conflict note by the lossless merge below, never dropped.
  let bestId: string | null = null
  let bestScore = 0

  // Phones are compared on their last ten digits (wave 148): "+1 512 555 0100" and "(512) 555-0100" are one number.
  const ten = (p: string | null | undefined) => { const d = String(p ?? '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : d }
  for (const c of candidates) {
    const result = calculateFuzzyMatch(
      {
        first_name: params.first_name ?? '',
        last_name: params.last_name ?? '',
        email: params.email ?? '',
        phone: ten(params.phone),
      },
      {
        first_name: c.first_name ?? '',
        last_name: c.last_name ?? '',
        email: c.email ?? '',
        phone: ten(c.phone),
      },
    )
    const exactEmail = !!incomingKeys.email && String(c.email ?? '').trim().toLowerCase() === incomingKeys.email
    const score = exactEmail ? Math.max(result.score, DEDUP_THRESHOLD) : result.score
    if (score > bestScore) {
      bestScore = score
      bestId = c.id
    }
  }

  // ── MERGE path ───────────────────────────────────────────────────────────
  if (bestId !== null && bestScore >= DEDUP_THRESHOLD) {
    const existing = candidates.find((x) => x.id === bestId)

    // Resolve agent to assign on merge if existing contact has none.
    // agents.id (NOT users.id) — contacts.agent_id is agents.id.
    let mergeAgentId: string | null = null
    if (!existing?.agent_id && !params.skipAutoAssign) {
      const assignment = await resolveAgentForContact({
        brokerageId: params.brokerageId,
        ownerAgentId: ownerAgentHint,
        teamId: teamHint,
        source: params.source,
        client: supabase,
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
    // Wave 148: the door's own metadata keys ride the same fill-if-empty rule.
    const existingMetadata = (existing?.metadata as Record<string, unknown> | null) ?? null
    const incomingMetadata: Record<string, unknown> = { ...(params.metadata ?? {}), ...(params.language ? { captured_language: params.language } : {}) }
    const metadataAdds = Object.fromEntries(Object.entries(incomingMetadata).filter(([k, v]) => v !== undefined && v !== null && (existingMetadata?.[k] === undefined || existingMetadata?.[k] === null)))
    const mergedMetadata = Object.keys(metadataAdds).length ? { ...(existingMetadata ?? {}), ...metadataAdds } : null

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
    // Wave 148: first-touch columns are FILL-IF-EMPTY silently (a later campaign never steals the first one's credit); the
    // person's SITUATION is fill-if-empty too, but a different stated answer is a real conflict and is kept in notes.
    const firstTouchFill = fillIfEmpty(existing, columns.firstTouch)
    const situationFill = fillIfEmpty(existing, columns.situation)
    // FIELD PROVENANCE IS A PER-FIELD MAP (wave 147, lane 147Z — merging the open-house kiosk onto C8 exposed this): the
    // shallow spread above REPLACED the stored field_provenance block wholesale, erasing every other field's recorded source,
    // and stamped this capture as the source of values the lossless merge KEPT from elsewhere. Layer the incoming stamps over
    // the prior block (the persistence door's rule — lib/enrichment/field-provenance-store.ts persistFieldProvenance), and only
    // for a field whose stored value IS the incoming one.
    if (mergedEnrichmentProfile) {
      const priorFp = (existing?.enrichment_profile as Record<string, unknown> | null)?.field_provenance
      const incomingFp = (params.enrichmentProfile as Record<string, unknown> | null | undefined)?.field_provenance
      if (incomingFp && typeof incomingFp === 'object') {
        const stored = { ...((existing as Record<string, unknown> | null) ?? {}), ...stewardMerged } as Record<string, unknown>
        const incoming = params as unknown as Record<string, unknown>
        const landed = Object.fromEntries(Object.entries(incomingFp as Record<string, unknown>).filter(([f]) =>
          !(f in stored) || stored[f] == null || String(stored[f]) === String(incoming[f] ?? '')))
        mergedEnrichmentProfile.field_provenance = { ...(priorFp && typeof priorFp === 'object' ? priorFp as Record<string, unknown> : {}), ...landed }
      }
    }
    const allConflicts = [...conflicts, ...situationFill.conflicts]
    const noteAdditions = [
      ...(allConflicts.length ? [`[merge ${new Date().toISOString().slice(0, 10)} via ${params.source}] ${allConflicts.join('; ')}`] : []),
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
    // Wave 148: and COUNTED — an UPDATE that matches no row resolves exactly like one that landed (CLAUDE.md §3).
    const { data: mergedRows, error: mergeError } = await supabase
      .from('contacts')
      .update({
        ...stewardMerged,
        ...firstTouchFill.patch,
        ...situationFill.patch,
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
        ...(params.tcpa_consent && params.tcpa_consent_ip ? { tcpa_consent_ip: params.tcpa_consent_ip } : {}),
        ...(mergedEnrichmentProfile ? { enrichment_profile: mergedEnrichmentProfile } : {}),
        ...(mergedMetadata ? { metadata: mergedMetadata } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq('id', bestId)
      .eq('brokerage_id', params.brokerageId)
      .select('id')

    if (mergeError) {
      throw new Error(`Failed to merge contact ${bestId}: ${mergeError.message}`)
    }
    if (!Array.isArray(mergedRows) || mergedRows.length === 0) {
      throw new Error(`Failed to merge contact ${bestId}: the update matched no row in brokerage ${params.brokerageId}`)
    }
    const mergedId: string = bestId

    await sentinelWrite(supabase as never, supabase.from('lifecycle_events').insert({
      brokerage_id: params.brokerageId,
      entity_type: 'contact',
      entity_id: mergedId,
      event_type: KernelEvent.CONTACT_DEDUP_MERGED,
      metadata: { score: bestScore, source: params.source },
    }), { table: "lifecycle_events", flow: "lifecycle_events_echo", reason: "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped" })

    await bestEffortEffect('merge notification fan-out', () => notify({
      event: KernelEvent.CONTACT_DEDUP_MERGED,
      brokerageId: params.brokerageId,
      entityType: 'contact',
      entityId: mergedId,
    }))

    await bestEffortEffect('enrichment queue', () => enrich({ brokerageId: params.brokerageId, contactId: mergedId, client: supabase }))

    // NO SECOND WELCOME, NO SECOND INVITE on a merge (wave 148 — "no duplicate welcome/invite/follow-up"): the person is
    // already known; the welcome ledger (agent_client_messages, ensureClientWelcome) and the portal invite belong to the
    // contact's creation, which already happened.
    const mergedPerson = await recordCapturePersonEvidence(supabase, params, bestId, 'merged', bestScore)
    return { contactId: mergedId, action: 'merged', ...mergedPerson }
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
  // Wave 148: the creating user rides the same attribution (assignment provenance).
  let createAttribution: { method: string; rule_id: string | null; creator_user_id: string | null } | null = null
  if (params.skipAutoAssign) {
    createAgentId = ownerAgentHint ?? null
  } else {
    const createAssignment = await resolveAgentForContact({
      brokerageId: params.brokerageId,
      ownerAgentId: ownerAgentHint,
      teamId: teamHint,
      source: params.source,
      client: supabase,
    })
    if (!createAssignment.agentId) {
      throw new Error(
        `captureContact: no eligible agent in brokerage ${params.brokerageId}`,
      )
    }
    createAgentId = createAssignment.agentId
    createAttribution = { method: createAssignment.method, rule_id: createAssignment.ruleId ?? null, creator_user_id: params.creatorUserId ?? null }
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
      ...columns.firstTouch, ...columns.situation, ...columns.createOnly,
      preferred_channel: params.preferred_channel ?? (params.tcpa_consent ? 'phone' : 'email'),
      source: params.source,
      tcpa_consent: params.tcpa_consent,
      tcpa_consent_date: params.tcpa_consent
        ? (params.tcpa_consent_date ?? new Date().toISOString())
        : null,
      ...(params.tcpa_consent && params.tcpa_consent_source ? { tcpa_consent_source: params.tcpa_consent_source } : {}),
      ...(params.tcpa_consent && params.tcpa_consent_text ? { tcpa_consent_text: params.tcpa_consent_text } : {}),
      ...(params.tcpa_consent && params.tcpa_consent_ip ? { tcpa_consent_ip: params.tcpa_consent_ip } : {}),
      ...(params.enrichmentProfile ? { enrichment_profile: params.enrichmentProfile } : {}),
      ...(params.language || params.metadata ? { metadata: { ...(params.metadata ?? {}), ...(params.language ? { captured_language: params.language } : {}) } } : {}),
      isa_reengage_allowed: params.isa_reengage_allowed ?? true,
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

  await sentinelWrite(supabase as never, supabase.from('lifecycle_events').insert({
    brokerage_id: params.brokerageId,
    entity_type: 'contact',
    entity_id: contactId,
    event_type: KernelEvent.CONTACT_CAPTURED,
    metadata: {
      source: params.source,
      ...(createAttribution ? { assignment: createAttribution } : {}),
    },
  }), { table: "lifecycle_events", flow: "lifecycle_events_echo", reason: "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped" })

  await bestEffortEffect('capture notification fan-out', () => notify({
    event: KernelEvent.CONTACT_CAPTURED,
    brokerageId: params.brokerageId,
    entityType: 'contact',
    entityId: contactId,
  }))

  // Warm-capture portal invite. These sources are self-provided / consented (web_form / qr_scan /
  // business_card / widget / open_house / home_value_form / showing_request — NOT in
  // LEAD_CONVERSION_SOURCES, which are invited via handleLeadAssigned). Resolve the assigned agent's
  // users.id to attribute the invite; the core compliance-gates the OTP email on
  // email_opt_out / email_unsubscribed. Best-effort — never block contact creation.
  // Skipped when there is no owning agent (skipAutoAssign + no hint, e.g. a represented
  // buyer): there is no agent to attribute the invite to, and we must not invite them
  // into the listing agent's portal.
  //
  // WAVE 150 (lane 150PU, canary 4 — "portal invitation immediate, welcome video asynchronous"): the invite runs FIRST, the
  // moment the contact exists. It used to wait behind the welcome (a model-drafted letter) and the enrichment queue, so the
  // person's portal waited on an LLM. The grant is idempotent (one invite per contact, portal_contact_invites UNIQUE), so the
  // welcome's own ensurePortalAccess afterwards re-reads the same row. The owning agent's read is READ (it was
  // `const { data: agentRow }` — a refused read silently skipped the invite and nobody was told).
  try {
    const agentRead = createAgentId
      ? await supabase.from('agents').select('user_id').eq('id', createAgentId).maybeSingle()
      : { data: null, error: null }
    if (agentRead.error) console.error(`[captureContact] portal invite NOT sent for contact ${contactId}: the owning agent read was refused (${agentRead.error.message})`)
    const agentRow = agentRead.data as { user_id?: string | null } | null
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
      await portalInvite({
        contactId,
        agentUserId: agentRow.user_id,
        sendMagicLink: resolveWelcomeManagers(params.contact_type ?? null).length === 0,
      })
    }
  } catch (err) {
    console.error('[captureContact] portal invite failed (non-fatal):', err)
  }

  // CLIENT WELCOME (concierge #1–2) — same gated draft on the direct-capture
  // path. Best-effort, never blocks capture. Idempotent per contact (the welcome
  // ledger), so a door that also hands off to deliverConversionWelcome cannot send two.
  await bestEffortEffect('client welcome', () => welcome(supabase, {
    id: contactId, brokerageId: params.brokerageId,
    contactType: params.contact_type ?? null,
    firstName: params.first_name ?? null, lastName: params.last_name ?? null,
  }, { origin: params.welcomeOrigin }))

  await bestEffortEffect('enrichment queue', () => enrich({ brokerageId: params.brokerageId, contactId, client: supabase }))

  // THE PORTAL WELCOME VIDEO — LAST, and only for a contact with an owning agent (the video is that agent's). The spine
  // drafts and renders out of band; the person already has their portal and their welcome. A refusal (no avatar on file,
  // an excluded contact type) is a warning, never a failed capture.
  if (createAgentId) {
    const agentIdForVideo = createAgentId
    await bestEffortEffect('portal welcome video', () => welcomeVideo(supabase, { contactId, agentId: agentIdForVideo, brokerageId: params.brokerageId, origin: params.welcomeOrigin }))
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
// WAVE 148 (lane 148B — owner ruling 4, "all seven doors that create contacts need to be on the same door"): the two doors that
// kept their OWN upsert in wave 147 (lib/kernel/lead-magnets.ts captureFormSubmission, lib/ads/ad-lead-intake.ts
// ingestConsentedAdLead) and the seven that inserted contacts their own way are all on this door now. The blocker — captureContact
// minted its own service client — is closed by the INJECTED-CLIENT CONTRACT (CaptureContactOptions.client / .effects): the
// capture rides the client the door gated with. completeConsentedIntake stays exported as the record half C8 runs.

/** The tables a consented form can be OWNED by — the tenant is read off the owning row, never taken from the body. */
// open_house_events (wave 147, lane 147Z): the kiosk sign-in's owning row — the event carries the tenant the attendee is filed under.
const CONSENT_FORM_OWNER_TABLES = ['lead_capture_forms', 'qr_codes', 'embed_widgets', 'chat_sessions', 'listings', 'agents', 'open_house_events'] as const
export type ConsentFormOwnerTable = (typeof CONSENT_FORM_OWNER_TABLES)[number]

/** One consent box on the submission. `family` is the box's channel family: 'phone' (TCPA — calls + texts) or 'email'. */
export interface ConsentGrantInput {
  /** 'phone' (TCPA — calls + texts), 'email', or 'mail' (direct mail — wave 148, the C15 component's fourth channel). */
  family: 'phone' | 'email' | 'mail'
  given: boolean
  /**
   * Wave 148 (C15): which BOX of the one consent component this grant is — 'service_delivery' or 'marketing'. Two boxes of
   * the same family (a service-delivery phone consent AND a marketing-text consent) are two consents with two wordings and
   * two purpose sets; the slot keeps their idempotency keys apart so the second is never replayed as the first.
   */
  slot?: string | null
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
  /**
   * Wave 148: the consent's SOURCE label when it differs from the contact's `source` (a lead magnet's contact source is the
   * arrival — 'landing_page' / 'website' — while its consent source has always been 'lead_magnet'). Default: params.source.
   */
  consentSource?: string | null
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
  /** Wave 148 (C15): every consent row written, keyed `<family>` or `<family>:<slot>` (the component writes one per box). */
  consentEventIdsBySlot?: Record<string, string | null>
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
    .map((g) => `${g.family}${g.slot ? `/${g.slot}` : ''}:${g.given ? 1 : 0}:${consentTextHash(g.text) ?? 'unrecorded'}`)
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
  opts: { client?: IntakeClient; effects?: CaptureContactEffects } = {},
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
        consents: params.consents.map((g) => ({ family: g.family, ...(g.slot ? { slot: g.slot } : {}), given: g.given, text_hash: consentTextHash(g.text), text_version: g.textVersion ?? null })),
        form_owner: params.intake.formOwner ?? null,
      },
    },
    async () => {
      let captured: CaptureContactResult
      try {
        // THE INJECTED-CLIENT CONTRACT (wave 148): the capture rides the SAME client this intake gated the tenant with —
        // the door's service client, or a proof's in-memory client — never a second one minted inside captureContact.
        captured = await captureContact({
          ...params,
          tcpa_consent: !!phoneGrant,
          tcpa_consent_date: phoneGrant ? capturedAt : null,
          tcpa_consent_text: phoneGrant?.text ?? null,
          tcpa_consent_source: phoneGrant ? (params.intake.consentSource ?? String(params.source)) : null,
          tcpa_consent_ip: phoneGrant && typeof params.intake.evidence?.ip === 'string' ? (params.intake.evidence.ip as string) : null,
        }, { client: svc, effects: opts.effects })
      } catch (e) {
        return { ...base, refused: 'capture_failed' as const, reason: e instanceof Error ? e.message : String(e), idempotencyKey }
      }
      const done = await completeConsentedIntake(svc, {
        brokerageId: params.brokerageId, contactId: captured.contactId, action: captured.action,
        personId: captured.personId ?? null, agentId: params.ownerAgentId ?? null,
        email: params.email ?? null, phone: params.phone ?? null,
        source: params.intake.consentSource ?? String(params.source), consents: params.consents, intake: { ...params.intake, capturedAt }, idempotencyKey,
        creatorUserId: params.creatorUserId ?? null,
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
 * THE PERSON'S SITUATION from an untrusted body (owner ruling 12 — app/components/forms/SituationFields.tsx posts it). PURE and
 * strict: only the live CHECK vocabularies pass (contacts.contact_type buyer · seller · both; contacts.timeline buckets), the
 * representation answer becomes the NAR Article 16 disclosure the listing door already honours. Anything else is dropped —
 * never guessed, never a protected characteristic.
 */
const SITUATION_INTENTS = new Set(['buyer', 'seller', 'both'])
const SITUATION_TIMELINES = new Set(['immediate', '1-3_months', '3-6_months', '6-12_months', '12+_months', 'researching'])
export function situationFromBody(raw: unknown): { contact_type?: string; timeline?: string; working_with_agent?: boolean } {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  return {
    ...(typeof r.intent === 'string' && SITUATION_INTENTS.has(r.intent) ? { contact_type: r.intent } : {}),
    ...(typeof r.timeline === 'string' && SITUATION_TIMELINES.has(r.timeline) ? { timeline: r.timeline } : {}),
    ...(typeof r.working_with_agent === 'boolean' ? { working_with_agent: r.working_with_agent } : {}),
  }
}

/**
 * WHO A C15 CONSENT NAMES — ONE rule for every door and every page that renders the component (CLAUDE.md §6): the form's
 * BROKERAGE by name (the legal entity the person is agreeing to hear from — the wording reads "<brokerage> and its agents",
 * the kiosk's long-standing precedent: sign-in-kiosk.tsx "prefers brokerages.name — the actual entity"), else the form's agent
 * by full name, else "our brokerage". A page that renders ConsentBoxes resolves its `brandName` through this same function
 * (or the same read), so the words the person reads and the words the server re-renders for the ledger are identical.
 */
export async function resolveConsentBrand(svc: CaptureClient, owner: { agentId?: string | null; brokerageId?: string | null }): Promise<string> {
  if (owner.brokerageId) {
    const { data: b } = await svc.from('brokerages').select('name').eq('id', owner.brokerageId).maybeSingle()
    const name = String((b as { name?: string | null } | null)?.name ?? '').trim()
    if (name) return name
  }
  if (owner.agentId) {
    const { data: a } = await svc.from('agents').select('user_id').eq('id', owner.agentId).maybeSingle()
    const userId = (a as { user_id?: string | null } | null)?.user_id ?? null
    if (userId) {
      const { data: u } = await svc.from('users').select('first_name, last_name').eq('id', userId).maybeSingle()
      const name = [(u as { first_name?: string | null } | null)?.first_name, (u as { last_name?: string | null } | null)?.last_name].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
      if (name) return name
    }
  }
  return 'our brokerage'
}

/**
 * CONTRACT C15 → C8 (wave 148, lane 148B): THE ONE CONSENT COMPONENT'S SUBMISSION, turned into the grants C8 records.
 *
 * The browser sends only BOOLEANS and a door key (lib/kernel/compliance/consent-component.ts ConsentComponentSubmission). The
 * wording stored on each consent row is RE-RENDERED here from the same pure function the component rendered, with the brand
 * the SERVER read off the form owner — never text the browser supplied. A browser that rendered a different brand is recorded
 * as evidence (`rendered_brand_mismatch`), not believed. A missing or malformed submission yields `submission: null` and NO
 * grants: the door then records no consent (consent is never fabricated, ruling 3).
 */
export function consentGrantsFromComponent(
  raw: unknown,
  ctx: { door: ConsentDoorKey; brandName: string | null | undefined; provided: { email: boolean; phone: boolean; address?: boolean } },
): { submission: ConsentComponentSubmission | null; grants: ConsentGrantInput[]; wordingHash: string | null; evidence: Record<string, unknown> } {
  const submission = parseConsentSubmission(raw)
  if (!submission) return { submission: null, grants: [], wordingHash: null, evidence: { consent_component: 'absent_or_malformed' } }
  // The door key is the SERVER's (the route knows which door it is); a submission naming another door is evidence only.
  const wording = consentComponentWording({ door: ctx.door, brandName: ctx.brandName })
  const grants = consentGrantsFor(submission, wording, ctx.provided).map((g): ConsentGrantInput => ({
    family: g.family, slot: g.slot, given: g.given, text: g.text, textVersion: g.textVersion,
    purposes: canonicalConsentPurposes(g.purposes), channels: g.channels,
  }))
  const evidence: Record<string, unknown> = {
    consent_component: CONSENT_COMPONENT_VERSION,
    consent_door: ctx.door,
    service_delivery: submission.service_delivery,
    marketing: submission.marketing,
    offered: submission.offered,
    ...(submission.door !== ctx.door ? { submitted_door_mismatch: submission.door } : {}),
    ...(submission.rendered_brand !== wording.brandName ? { rendered_brand_mismatch: submission.rendered_brand } : {}),
  }
  return { submission, grants, wordingHash: consentTextHash(consentWordingText(wording)), evidence }
}

/**
 * THE C8 RECORD HALF — after the Contact exists. Never throws; every best-effort step that did not land is named in `warnings`
 * (nobody checked never reads as checked and fine).
 *
 * WAVE 148 (148Z — lane 148B Outside-lane 4): UN-EXPORTED. It was exported "for the two doors that still own their upsert";
 * lane 148B moved both onto the full entry, so its ONLY caller is captureConsentedContact above (in this file) and the export
 * read as an orphan (scripts/orphan-export-guard.ts: 1 unreferenced export). No capability is removed — every door reaches it
 * through captureConsentedContact. The integrator re-baselines scripts/orphan-export-baseline.json deliberately.
 */
async function completeConsentedIntake(
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
    /** Wave 148 (C15 creator_user_id): the agent/user who created the form — recorded on every consent row's evidence. */
    creatorUserId?: string | null
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
    // `<family>` for a door with one box per family (unchanged keys for every pre-148 door); `<family>:<slot>` per C15 box.
    const slotKey = g.slot ? `${g.family}:${g.slot}` : g.family
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
        channels: g.channels ? [...g.channels] : g.family === 'email' ? ['email'] : g.family === 'mail' ? ['direct_mail'] : channelsNamedInConsentText(g.text),
        sourceUrl: input.intake.sourceUrl ?? null,
        evidence: { ...ev, intake_channel: input.intake.channel, form_owner: input.intake.formOwner ?? null, ...(g.slot ? { consent_box: g.slot } : {}), ...(input.creatorUserId ? { creator_user_id: input.creatorUserId } : {}) },
        idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:${slotKey}` : null,
        personId: input.personId ?? null,
        capturedAt,
      },
    }).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e), consentEventId: null } as const))
    if (g.family !== 'mail' && !out.consentEventIds[g.family]) out.consentEventIds[g.family] = w.consentEventId
    out.consentEventIdsBySlot = { ...(out.consentEventIdsBySlot ?? {}), [slotKey]: w.consentEventId }
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
  const channels = [...new Set(input.consents.filter((g) => g.given).flatMap((g) => g.channels ? [...g.channels] : g.family === 'email' ? ['email' as const] : g.family === 'mail' ? ['direct_mail' as const] : channelsNamedInConsentText(g.text)))]
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
}, opts: { client?: CaptureClient; notify?: typeof processKernelEvent } = {}): Promise<void> {
  // Wave 148: the capture's own client (the injected-client contract) — the queue row, the score and its echoes ride it.
  const supabase: any = opts.client ?? createServiceClient()
  // Wave 148Z (lane J2 hand-off): the score's fan-out is the door's `notify` effect (C8: "the side effects that mint their OWN
  // service client — the notification engine's fan-out"), never a direct processKernelEvent beside an injected client.
  const notify = opts.notify ?? processKernelEvent

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
    ...(opts.client ? { supabase: opts.client as never } : {}),
  })

  // Score immediately with available data (re-scored after enrichment completes). Tenant-pinned, and a refused read is SAID
  // (it used to be dropped) — the queue row above already landed, so this is a missing score, never a failed queue.
  const { data: contact, error: contactReadError } = await supabase
    .from('contacts')
    .select('*')
    .eq('id', params.contactId)
    .eq('brokerage_id', params.brokerageId)
    .maybeSingle()

  if (contactReadError) {
    console.error(`[queueContactEnrichmentAndScore] the enrichment queue row landed; the immediate score did not (contact read refused: ${contactReadError.message})`)
    return
  }
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

  // The fan-out is best-effort AFTER the queue row and the score landed. A failure here used to escape and be logged by the
  // caller as "enrichment queue failed" — a lie: the queue row was there. It is now named for what it is.
  try {
    await notify({
      event: KernelEvent.CONTACT_SCORED,
      brokerageId: params.brokerageId,
      entityType: 'contact',
      entityId: params.contactId,
    })
  } catch (err) {
    console.error(`[queueContactEnrichmentAndScore] score notification fan-out failed — the enrichment queue row and the score landed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
