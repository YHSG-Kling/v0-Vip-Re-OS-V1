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
}

export interface PersistConsentResult {
  /** False when the CONTACTS consent write was refused — the consent state the
   *  caller believes it recorded is NOT what the row holds. */
  ok: boolean
  error?: string
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

  // 1. Update leads row if provided
  if (params.leadId) {
    await supabase
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
  }

  // 2. Update contacts row if provided
  let contactConsentError: string | null = null
  if (params.contactId) {
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

  // 3. Always insert a consent event for audit trail
  await supabase.from('contact_consent_events').insert({
    contact_id:     params.contactId ?? null,
    lead_id:        params.leadId ?? null,
    brokerage_id:   params.brokerageId,
    agent_id:       params.agentId ?? null,
    consent_type:   'tcpa',
    consent_text:   params.consentText,
    consent_source: params.consentSource,
    consented:      params.consented,
    ip_address:     params.ipAddress ?? null,
    user_agent:     params.userAgent ?? null,
    created_at:     now,
  })

  // Reported AFTER the audit event so a refused consent write still leaves the
  // attempt on the trail — the caller learns the row does not agree with it.
  return contactConsentError
    ? { ok: false, error: contactConsentError }
    : { ok: true }
}
