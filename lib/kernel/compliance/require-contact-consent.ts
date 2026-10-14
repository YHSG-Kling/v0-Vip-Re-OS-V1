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
 */

import { createServiceClient } from '@/lib/supabase/service'

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
  const supabase = createServiceClient()
  const now = new Date().toISOString()
  const channel = params.channel ?? 'phone'

  // 1. Update leads row if provided — the TCPA (phone) rule only; an email consent never stamps tcpa_*.
  if (params.leadId && channel === 'phone') {
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
    if (leadConsentErr) console.error(`[require-contact-consent] TCPA consent NOT recorded on the lead: ${leadConsentErr.message}`)
  }

  // 2. Update contacts row if provided
  let contactConsentError: string | null = null
  if (params.contactId && channel === 'phone') {
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
  const { data: consentEvent, error: consentEventErr } = await supabase.from('contact_consent_events').insert({
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
  }).select('id').maybeSingle()
  if (consentEventErr) console.error(`[require-contact-consent] consent event NOT recorded on the consent ledger: ${consentEventErr.message}`)
  const consentEventId = (consentEvent as { id?: string } | null)?.id ?? null

  // Reported AFTER the audit event so a refused consent write still leaves the
  // attempt on the trail — the caller learns the row does not agree with it.
  return contactConsentError
    ? { ok: false, error: contactConsentError, consentEventId }
    : { ok: true, consentEventId }
}
