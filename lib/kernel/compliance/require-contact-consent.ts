/**
 * lib/kernel/compliance/require-contact-consent.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Universal TCPA consent persistence helper. Called on every customer-facing
 * form submit that creates or updates a lead or contact.
 *
 * Writes to:
 *   leads.tcpa_consent / tcpa_consent_at / tcpa_consent_text / source / ip / ua
 *   contacts.tcpa_consent / tcpa_consent_at / text / source / ip
 *   contact_consent_events (always inserted — full audit trail)
 *
 * WAVE 147 (lane 147A — owner ruling 1, contract C8): THE CONSENT RECORD CARRIES ITS SCOPE. A consent row now also
 * records (m889) the wording HASH + the door's VERSION label, the PURPOSES the person agreed to be contacted about, the
 * CHANNELS the wording itself names, the source URL, an evidence pointer, the person, when it was given, an idempotency key
 * (one consent per tenant × identity × evidence) and the earlier row a later preference change SUPERSEDES. The scope is what
 * lets the arbiter answer "may I text this person about equity?" from the record alone (`consentScopeFor` +
 * `answerConsentQuestion`, below). It is ADVISORY to the arbiter: the deterministic dispatch gate (TCPA consent, DNC, opt-outs,
 * quiet hours in lib/providers/dispatch.ts) is unchanged and still decides what may be sent.
 */

import { createHash } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/service'

// ─── THE SCOPE VOCABULARY (one spelling each, CLAUDE.md §6; m889 CHECKs hold the database to the same lists) ─────────────

/** The channels a consent's WORDING can name. A channel the wording does not name is never on the record. */
export const CONSENT_CHANNELS = ['sms', 'voice', 'email', 'direct_mail'] as const
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number]

/**
 * What a person agreed to be contacted ABOUT. Derived from the wording (`purposesNamedInConsentText`) plus what the door itself
 * offered (a home-value form offers `home_valuation`, a showing request `property_inquiry`). Never a protected trait.
 */
export const CONSENT_PURPOSES = [
  'real_estate_services',  // the broad grant: help buying / selling / owning a home ("regarding real estate services / needs")
  'requested_information', // only the thing they asked for (the guide, the report, the valuation, the answer)
  'property_inquiry',      // a specific property / listing they asked about
  'home_valuation',        // what their own home is worth
  'equity_review',         // the equity position of a home they own
  'market_updates',        // local market reports
  'listing_alerts',        // new listings matching their search
  'event_followup',        // an event they attended (an open house)
] as const
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number]

/**
 * Which purposes a recorded purpose COVERS. The broad grant covers every real-estate purpose; a narrow grant covers itself and
 * the thing that was asked for — nothing it does not name (a home-value request does not cover listing alerts).
 */
export const CONSENT_PURPOSE_COVERS: Readonly<Record<ConsentPurpose, readonly ConsentPurpose[]>> = Object.freeze({
  real_estate_services: CONSENT_PURPOSES,
  requested_information: ['requested_information'],
  property_inquiry: ['property_inquiry', 'requested_information'],
  home_valuation: ['home_valuation', 'requested_information'],
  equity_review: ['equity_review', 'requested_information'],
  market_updates: ['market_updates', 'requested_information'],
  listing_alerts: ['listing_alerts', 'requested_information'],
  event_followup: ['event_followup', 'requested_information'],
})

const PURPOSE_SET = new Set<string>(CONSENT_PURPOSES)
const CHANNEL_SET = new Set<string>(CONSENT_CHANNELS)
/** PURE — keep only canonical purposes (an unrecognised one would be refused by the m889 CHECK and lose the row). */
export function canonicalConsentPurposes(values: readonly unknown[] | null | undefined): ConsentPurpose[] {
  return [...new Set((values ?? []).map((v) => String(v ?? '').trim()).filter((v) => PURPOSE_SET.has(v)))] as ConsentPurpose[]
}
/** PURE — keep only canonical channels. */
function canonicalConsentChannels(values: readonly unknown[] | null | undefined): ConsentChannel[] {
  return [...new Set((values ?? []).map((v) => String(v ?? '').trim()).filter((v) => CHANNEL_SET.has(v)))] as ConsentChannel[]
}

/** PURE — sha256 of the whitespace-normalised wording; null for no wording. The same words → the same hash. */
export function consentTextHash(text: string | null | undefined): string | null {
  const norm = (text ?? '').replace(/\s+/g, ' ').trim()
  return norm ? createHash('sha256').update(norm).digest('hex') : null
}

/**
 * PURE — the channels the WORDING names, read literally. "calls" → voice, "texts" / "SMS" → sms, "email" → email,
 * "direct mail" / "mailers" / "postal mail" → direct_mail. Generic words ("communications", "contact you") name NO channel:
 * the record says what was agreed to, never what it might plausibly mean.
 */
export function channelsNamedInConsentText(text: string | null | undefined): ConsentChannel[] {
  const t = (text ?? '').toLowerCase()
  const out: ConsentChannel[] = []
  if (/\b(phone )?calls?\b|\bautodial|\bprerecorded\b|\bvoice ?mail/.test(t)) out.push('voice')
  if (/\btexts?\b|\btext messages?\b|\bsms\b|\bmms\b/.test(t)) out.push('sms')
  if (/\be-?mails?\b/.test(t)) out.push('email')
  if (/\bdirect mail\b|\bpostal mail\b|\bmailers?\b|\bpostcards?\b/.test(t)) out.push('direct_mail')
  return out
}

/** PURE — the purposes the WORDING names (the broad real-estate grant is the one the platform's own disclosures use). */
export function purposesNamedInConsentText(text: string | null | undefined): ConsentPurpose[] {
  const t = (text ?? '').toLowerCase()
  const out: ConsentPurpose[] = []
  if (/real[ -]estate (services|needs|matters)|buying,? selling|buy or sell/.test(t)) out.push('real_estate_services')
  if (/market (updates?|reports?)/.test(t)) out.push('market_updates')
  if (/listing alerts?|new listings/.test(t)) out.push('listing_alerts')
  if (/home value|home'?s? (worth|value)|valuation/.test(t)) out.push('home_valuation')
  return out
}

/** The m889 scope of one consent row. Every field optional — a legacy caller passes none and writes the legacy row. */
export interface ConsentScopeInput {
  textVersion?: string | null
  purposes?: readonly ConsentPurpose[]
  /** Channels the wording names — derived from the text when omitted. */
  channels?: readonly ConsentChannel[]
  sourceUrl?: string | null
  evidence?: Record<string, unknown> | null
  idempotencyKey?: string | null
  personId?: string | null
  capturedAt?: string | null
}

/** The m889 columns — named ONLY when the row carries a scope, so a legacy write never names an absent column. */
const M889_COLUMNS = ['consent_text_hash', 'consent_text_version', 'purposes', 'channels', 'source_url', 'evidence', 'idempotency_key', 'person_id', 'captured_at', 'supersedes_id'] as const

/** A refusal that means "the m889 columns are not deployed yet" (PostgREST PGRST204 / Postgres 42703). */
function isScopeColumnAbsent(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false
  if (err.code === 'PGRST204' || err.code === '42703') return true
  const m = String(err.message ?? '')
  return M889_COLUMNS.some((c) => m.includes(c)) && /column|schema cache/i.test(m)
}

type ConsentClient = { from: (table: string) => any }

export const TCPA_CONSENT_TEXT =
  'By checking this box, you agree to receive calls, texts, emails, and direct mail from {brokerageName} and its agents regarding your real estate needs. Consent is not a condition of purchase. You may unsubscribe or opt out at any time.'

/** Replace {brokerageName} token with the real brokerage name */
export function buildConsentText(brokerageName: string): string {
  return TCPA_CONSENT_TEXT.replace('{brokerageName}', brokerageName)
}

export interface PersistConsentParams {
  brokerageId: string
  agentId?: string | null
  /** If the consent is being recorded against a lead row */
  leadId?: string | null
  /** If the consent is being recorded against a contact row */
  contactId?: string | null
  consentText: string
  consentSource: string        // current page path or form name
  consented: boolean
  ipAddress?: string | null
  userAgent?: string | null
  /**
   * WHICH consent this artifact records (wave 104, lane 104E; owner answer 1, 2026-10-05: "a separate
   * email-consent checkbox on the website widget — email-only submissions get their own consent artifact").
   *   · 'phone' (default) — the TCPA rule: leads/contacts tcpa_* columns are stamped and the ledger row is
   *     consent_type 'tcpa'. Unchanged for every existing caller.
   *   · 'email' — an EMAIL contact consent (the widget's separate box): ONLY the ledger row is written
   *     (consent_type 'email'); the tcpa_* columns say nothing about phone consent the visitor never gave.
   * consent_type is a free text column live (no CHECK — information_schema, 2026-10-05).
   */
  channel?: 'phone' | 'email'
  /** Wave 147 (C8): the m889 scope this row records. Omitted → the legacy row, byte-for-byte as before. */
  scope?: ConsentScopeInput | null
  /**
   * Wave 147 (C8): false when the caller has ALREADY stamped the party's tcpa_* columns in the same command (captureContact
   * writes them on the create / merge it just did) — this call then writes ONLY the ledger row. Default true (unchanged).
   */
  stampPartyColumns?: boolean
  /** The client the writes ride (an injected service client / an in-memory proof client). Default: the service client. */
  client?: ConsentClient
}

/** The contact_consent_events.consent_type each channel records — ONE spelling (CLAUDE.md §6). */
export const CONSENT_TYPE_FOR_CHANNEL = { phone: 'tcpa', email: 'email' } as const

export interface PersistConsentResult {
  /** False when the CONTACTS consent write was refused — the consent state the
   *  caller believes it recorded is NOT what the row holds. */
  ok: boolean
  error?: string
  /** THE CONSENT ARTIFACT (wave 103, lane 103D; m706): the contact_consent_events.id this call
   *  inserted, or null when the ledger refused it. A caller that must store something ONLY on a
   *  consent artifact (behavioral_signals.email_captured — the consented visitor email capture,
   *  lib/lead-intelligence/visitor-email-capture.ts) keys on this id and stores nothing without it. */
  consentEventId: string | null
  /** Wave 147: the row already existed under this idempotency key — nothing was written (a retry re-read it). */
  replay?: boolean
  /** Wave 147: the m889 scope landed (false = the columns are not deployed; the legacy row was written instead, said loudly). */
  scopeStored?: boolean
  /** Wave 147: the earlier consent row this one supersedes (same party, same consent_type), when one existed. */
  supersedesId?: string | null
}

/**
 * WHY THIS RETURNS A RESULT (it used to return void).
 *
 * `params.consented` is a BOOLEAN — this helper records an opt-OUT as readily as
 * an opt-in (app/actions/tcpa-compliance.ts calls it with whatever the staff
 * member picked). supabase-js RESOLVES a refused UPDATE, so the contacts write
 * below could be rejected — a CHECK, an RLS refusal, a PGRST204 phantom column —
 * and this function still returned normally. Its one server-action caller then
 * returned `{ success: true }` and the compliance panel told a human the opt-out
 * was recorded while the row still said `tcpa_consent = true`.
 *
 * That is a fail-open on the consent record, which CLAUDE.md §4 forbids. The
 * contacts write's error is now read and handed back, and the caller stops
 * reporting success on it.
 */
export async function persistContactConsent(params: PersistConsentParams): Promise<PersistConsentResult> {
  const supabase = params.client ?? createServiceClient()
  const now = new Date().toISOString()
  const channel = params.channel ?? 'phone'
  const stampParty = params.stampPartyColumns !== false
  const scope = params.scope ?? null

  // 0. WAVE 147 — IDEMPOTENT REPLAY. One consent per (tenant, identity, evidence): a retry of the same submission re-reads the
  //    row its first attempt wrote and writes nothing (no second consent, no second party stamp). An unreadable key read is
  //    reported, never read as "absent" (a duplicate consent is a false record; a missing one is recoverable).
  //    Read PARTY-scoped with `*` and matched here: before m889 is applied the key column is absent from the row (nothing
  //    matches — correct), where a filter naming it would be refused outright. The m889 unique index is the race backstop.
  const keyParty = params.contactId ? { col: 'contact_id', id: params.contactId } : params.leadId ? { col: 'lead_id', id: params.leadId } : null
  if (scope?.idempotencyKey && keyParty) {
    const { data: priorRows, error: priorErr } = await supabase.from('contact_consent_events').select('*')
      .eq('brokerage_id', params.brokerageId).eq(keyParty.col, keyParty.id).limit(200)
    if (priorErr) return { ok: false, error: `consent idempotency read refused: ${priorErr.message}`, consentEventId: null }
    const prior = ((priorRows ?? []) as Array<{ id?: string; idempotency_key?: string | null }>).find((r) => r.idempotency_key === scope.idempotencyKey)
    if (prior?.id) return { ok: true, consentEventId: prior.id, replay: true, scopeStored: true }
  }

  // 1. Update leads row if provided — the TCPA (phone) rule only; an email consent never stamps tcpa_*.
  //    Tenant-anchored (wave 147): a service-client UPDATE by id alone is the cross-tenant shape (CLAUDE.md §4).
  if (params.leadId && channel === 'phone' && stampParty) {
    const { error: leadConsentErr } = await supabase
      .from('leads')
      .update({
        tcpa_consent:            params.consented,
        tcpa_consent_at:         now,
        tcpa_consent_text:       params.consentText,
        tcpa_consent_source:     params.consentSource,
        tcpa_consent_ip:         params.ipAddress ?? null,
        tcpa_consent_user_agent: params.userAgent ?? null,
        updated_at:              now,
      })
      .eq('id', params.leadId)
      .eq('brokerage_id', params.brokerageId)
    if (leadConsentErr) console.error(`[require-contact-consent] TCPA consent NOT recorded on the lead: ${leadConsentErr.message}`)
  }

  // 2. Update contacts row if provided
  let contactConsentError: string | null = null
  if (params.contactId && channel === 'phone' && stampParty) {
    const { error } = await supabase
      .from('contacts')
      .update({
        tcpa_consent:        params.consented,
        tcpa_consent_at:     now,
        tcpa_consent_date:   now,   // existing column — keep in sync
        tcpa_consent_text:   params.consentText,
        tcpa_consent_source: params.consentSource,
        tcpa_consent_ip:     params.ipAddress ?? null,
        updated_at:          now,
      })
      .eq('id', params.contactId)
      .eq('brokerage_id', params.brokerageId)
    if (error) {
      contactConsentError = error.message
      console.error(
        `[persistContactConsent] contacts consent write REFUSED for ${params.contactId} (consented=${params.consented}):`,
        error.message,
      )
    }
  }

  // 3. Always insert a consent event for audit trail. `.select("id")` — the row's id IS the consent
  //    artifact a capture may depend on (m706); a refused insert comes back as null, never as a
  //    made-up id (CLAUDE.md §3).
  const consentType = CONSENT_TYPE_FOR_CHANNEL[channel]
  const legacyRow = {
    contact_id:     params.contactId ?? null,
    lead_id:        params.leadId ?? null,
    brokerage_id:   params.brokerageId,
    agent_id:       params.agentId ?? null,
    consent_type:   CONSENT_TYPE_FOR_CHANNEL[channel],
    consent_text:   params.consentText,
    consent_source: params.consentSource,
    consented:      params.consented,
    ip_address:     params.ipAddress ?? null,
    user_agent:     params.userAgent ?? null,
    created_at:     now,
  }

  // 3a. WAVE 147 — A LATER PREFERENCE CHANGE REFERENCES THE CONSENT IT CHANGES. Every scoped row (and every opt-out, scoped or
  //     not — the tcpa panel / unsubscribe route) names the newest earlier row of the same party + consent_type as the one it
  //     supersedes. Only the m889 path writes the pointer; a legacy deployment simply has none.
  let supersedesId: string | null = null
  const party = params.contactId ? { col: 'contact_id', id: params.contactId } : params.leadId ? { col: 'lead_id', id: params.leadId } : null
  if (party && (scope || params.consented === false)) {
    const { data: earlier, error: earlierErr } = await supabase.from('contact_consent_events').select('id')
      .eq('brokerage_id', params.brokerageId).eq(party.col, party.id).eq('consent_type', consentType)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (earlierErr) console.warn(`[require-contact-consent] superseded-consent read refused (the new row names none): ${earlierErr.message}`)
    supersedesId = (earlier as { id?: string } | null)?.id ?? null
  }

  const scopedRow = scope || supersedesId
    ? {
        ...legacyRow,
        consent_text_hash:    consentTextHash(params.consentText),
        consent_text_version: scope?.textVersion ?? null,
        purposes:             canonicalConsentPurposes(scope?.purposes ?? []),
        channels:             params.consented ? canonicalConsentChannels(scope?.channels ?? channelsNamedInConsentText(params.consentText)) : [],
        source_url:           scope?.sourceUrl ?? null,
        evidence:             scope?.evidence ?? {},
        idempotency_key:      scope?.idempotencyKey ?? null,
        person_id:            scope?.personId ?? null,
        captured_at:          scope?.capturedAt ?? now,
        supersedes_id:        supersedesId,
      }
    : null

  let { data: consentEvent, error: consentEventErr } = await supabase.from('contact_consent_events').insert({ ...(scopedRow ?? legacyRow) }).select('id').maybeSingle()
  let scopeStored = scopedRow ? !consentEventErr : undefined
  if (scopedRow && consentEventErr && isScopeColumnAbsent(consentEventErr)) {
    // m889 not deployed: the consent itself must still land (it is the artifact every gate reads). Said loudly.
    console.error(`[require-contact-consent] m889 consent SCOPE columns absent — the legacy row is written, the scope is NOT recorded: ${consentEventErr.message}`)
    ;({ data: consentEvent, error: consentEventErr } = await supabase.from('contact_consent_events').insert(legacyRow).select('id').maybeSingle())
    scopeStored = false
  }
  if (consentEventErr) console.error(`[require-contact-consent] consent event NOT recorded on the consent ledger: ${consentEventErr.message}`)
  const consentEventId = (consentEvent as { id?: string } | null)?.id ?? null

  // Reported AFTER the audit event so a refused consent write still leaves the
  // attempt on the trail — the caller learns the row does not agree with it.
  const extra = { ...(scopeStored !== undefined ? { scopeStored } : {}), supersedesId }
  return contactConsentError
    ? { ok: false, error: contactConsentError, consentEventId, ...extra }
    : { ok: true, consentEventId, ...extra }
}

// ─── THE CONSENT-SCOPE ANSWER (wave 147, lane 147A — creative latitude of the C8 brief) ───────────────────────────────────
//
// "May I text this person about equity?" answered from the RECORD ALONE: the newest consent row per channel decides (an opt-out
// row, or a channel opt-out flag on the contact, withdraws), and the purposes on that row must COVER the question's purpose.
// ADVISORY: the arbiter reads it to choose among PERMITTED options; the dispatch gate still decides what is permitted.

export type ConsentAnswerBasis = 'consent_record' | 'withdrawn' | 'channel_opt_out' | 'purpose_not_covered' | 'channel_not_named' | 'legacy_record' | 'no_record' | 'unreadable'

export interface ConsentScopeRow {
  id: string
  consent_type: string | null
  consented: boolean | null
  purposes?: string[] | null
  channels?: string[] | null
  created_at: string | null
  consent_source?: string | null
}

export interface ConsentScope {
  /** The rows read, newest first (empty when none / unreadable). */
  rows: ConsentScopeRow[]
  /** Channel opt-outs on the contact itself (sms_opt_out, dnc_status, email_unsubscribed, …) — they withdraw whatever a row says. */
  optedOut: ConsentChannel[]
  /** The scope columns were readable (false = pre-m889 deployment: rows carry no purposes / channels). */
  scopeReadable: boolean
  /** A refused core read — the answer is then `unreadable`, never "no consent" (fail closed: nobody checked ≠ checked and none). */
  error?: string
}

export interface ConsentAnswer {
  allowed: boolean
  basis: ConsentAnswerBasis
  consentEventId: string | null
  reason: string
}

/** The consent_type families that speak for a channel on a LEGACY row (no `channels` recorded). */
const LEGACY_TYPE_CHANNELS: Readonly<Record<string, readonly ConsentChannel[]>> = { tcpa: ['sms', 'voice'], email: ['email'] }

/** PURE. The answer to (channel, purpose) over a read scope. */
export function answerConsentQuestion(scope: ConsentScope, question: { channel: ConsentChannel; purpose: ConsentPurpose }): ConsentAnswer {
  if (scope.error) return { allowed: false, basis: 'unreadable', consentEventId: null, reason: `the consent record could not be read (${scope.error}) — ask a human; never assume` }
  if (scope.optedOut.includes(question.channel)) return { allowed: false, basis: 'channel_opt_out', consentEventId: null, reason: `the contact opted out of ${question.channel}` }
  for (const r of scope.rows) {
    const channels = canonicalConsentChannels(r.channels ?? [])
    const legacy = channels.length === 0 && canonicalConsentPurposes(r.purposes ?? []).length === 0
    const speaksFor = legacy ? (LEGACY_TYPE_CHANNELS[String(r.consent_type ?? '')] ?? []) : channels
    if (r.consented === false) {
      // A withdrawal of this channel family ends the question for it, whatever an older row granted.
      if ((LEGACY_TYPE_CHANNELS[String(r.consent_type ?? '')] ?? []).includes(question.channel) || speaksFor.includes(question.channel)) {
        return { allowed: false, basis: 'withdrawn', consentEventId: r.id, reason: `consent for ${question.channel} was withdrawn (${r.created_at ?? 'date unknown'})` }
      }
      continue
    }
    if (!speaksFor.includes(question.channel)) continue
    if (legacy) {
      return { allowed: false, basis: 'legacy_record', consentEventId: r.id, reason: `a ${r.consent_type} consent is on file but predates purpose recording — it says nothing about ${question.purpose}; the TCPA gate still governs the send, a human decides the purpose` }
    }
    const covered = canonicalConsentPurposes(r.purposes ?? []).some((p) => CONSENT_PURPOSE_COVERS[p].includes(question.purpose))
    return covered
      ? { allowed: true, basis: 'consent_record', consentEventId: r.id, reason: `consent ${r.id} names ${question.channel} and covers ${question.purpose}` }
      : { allowed: false, basis: 'purpose_not_covered', consentEventId: r.id, reason: `consent ${r.id} names ${question.channel} but its purposes (${(r.purposes ?? []).join(', ') || 'none'}) do not cover ${question.purpose}` }
  }
  return scope.rows.length === 0
    ? { allowed: false, basis: 'no_record', consentEventId: null, reason: 'no consent is on record for this contact' }
    : { allowed: false, basis: 'channel_not_named', consentEventId: null, reason: `no consent on record names ${question.channel}` }
}

/** The contact columns that withdraw a channel whatever a consent row says (live columns, scripts/schema-snapshot.ts). */
const OPT_OUT_COLUMNS = 'sms_opt_out, sms_unsubscribed, phone_opt_out, call_stop_flag, dnc_status, email_opt_out, email_unsubscribed, direct_mail_opt_out'

/** Read one contact's consent scope in its tenant. Never throws; a refused core read is `error`, never an empty scope. */
export async function consentScopeFor(svc: ConsentClient, target: { brokerageId: string; contactId: string }): Promise<ConsentScope> {
  const empty: ConsentScope = { rows: [], optedOut: [], scopeReadable: false }
  if (!target.brokerageId || !target.contactId) return { ...empty, error: 'brokerageId and contactId are both required' }
  try {
    const { data: c, error: cErr } = await svc.from('contacts').select(OPT_OUT_COLUMNS).eq('id', target.contactId).eq('brokerage_id', target.brokerageId).maybeSingle()
    if (cErr) return { ...empty, error: `contact read refused: ${cErr.message}` }
    if (!c) return { ...empty, error: 'contact not in this tenant' }
    const row = c as Record<string, unknown>
    const optedOut: ConsentChannel[] = []
    if (row.sms_opt_out === true || row.sms_unsubscribed === true || row.dnc_status === true) optedOut.push('sms')
    if (row.phone_opt_out === true || row.call_stop_flag === true || row.dnc_status === true) optedOut.push('voice')
    if (row.email_opt_out === true || row.email_unsubscribed === true) optedOut.push('email')
    if (row.direct_mail_opt_out === true) optedOut.push('direct_mail')

    // `*`, not a column list: before m889 is applied the scope columns are simply absent from the row (scopeReadable false) —
    // a named phantom column would be refused outright (42703) and read as "unreadable".
    const res = await svc.from('contact_consent_events').select('*')
      .eq('brokerage_id', target.brokerageId).eq('contact_id', target.contactId).order('created_at', { ascending: false }).limit(50)
    if (res.error) return { ...empty, optedOut, error: `consent ledger read refused: ${res.error.message}` }
    const rows = (res.data ?? []) as Array<ConsentScopeRow & Record<string, unknown>>
    const scopeReadable = rows.length === 0 || rows.some((r) => 'purposes' in r || 'channels' in r)
    return { rows, optedOut, scopeReadable }
  } catch (e) {
    return { ...empty, error: `threw: ${e instanceof Error ? e.message : String(e)}` }
  }
}
