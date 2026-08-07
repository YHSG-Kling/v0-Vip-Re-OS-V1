/**
 * lib/kernel/compliance/check-suppression.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Called before EVERY email or SMS send. Checks:
 *   1. contacts.email_unsubscribed / sms_unsubscribed flags
 *   2. contacts.email_opt_out / sms_opt_out flags (legacy columns)
 *   3. contacts.dnc_status for phone
 *   4. contact_suppression_list rows by contact_id, email, or phone
 *
 * Returns { blocked: boolean, reason?: string }
 */

import { createServiceClient } from '@/lib/supabase/service'

export type SuppressionChannel = 'email' | 'sms' | 'phone' | 'mail'

export interface CheckSuppressionParams {
  brokerageId: string
  contactId?: string | null
  email?: string | null
  phone?: string | null
  channel: SuppressionChannel
}

export interface SuppressionResult {
  suppressed: boolean
  reason?: string
}

export async function checkSuppression(
  params: CheckSuppressionParams
): Promise<SuppressionResult> {
  const supabase = createServiceClient()

  // ── 1. Check contact flags ────────────────────────────────────────────────
  if (params.contactId) {
    const { data: contact, error: contactError } = await supabase
      .from('contacts')
      .select(
        'email_unsubscribed, email_opt_out, sms_unsubscribed, sms_opt_out, dnc_status, call_stop_flag'
      )
      .eq('id', params.contactId)
      .maybeSingle()

    // FAIL CLOSED, same reasoning as the suppression-list read below: an
    // unreadable contact is "we do not know whether they opted out", and the
    // only safe rendering of that is "do not send". Previously the error was
    // not destructured, so a refused read looked exactly like a contact with
    // every consent flag clear.
    if (contactError) {
      console.error("[checkSuppression] contact consent read refused:", contactError.message)
      return {
        suppressed: true,
        reason: `Contact consent flags unreadable — refusing to send (${contactError.message})`,
      }
    }

    if (contact) {
      if (params.channel === 'email') {
        if (contact.email_unsubscribed || contact.email_opt_out) {
          return { suppressed: true, reason: 'Contact has unsubscribed from email' }
        }
      }
      if (params.channel === 'sms') {
        if (contact.sms_unsubscribed || contact.sms_opt_out) {
          return { suppressed: true, reason: 'Contact has opted out of SMS' }
        }
      }
      if (params.channel === 'phone') {
        if (contact.dnc_status || contact.call_stop_flag) {
          return { suppressed: true, reason: 'Contact is on DNC / call stop list' }
        }
      }
    }
  }

  // ── 2. Check contact_suppression_list ────────────────────────────────────
  if (params.contactId || params.email || params.phone) {
    let query = supabase
      .from('contact_suppression_list')
      .select('id, suppression_reason')
      .eq('brokerage_id', params.brokerageId)
      .eq('channel', params.channel)

    // OR across contactId / email / phone
    const orClauses: string[] = []
    if (params.contactId) orClauses.push(`contact_id.eq.${params.contactId}`)
    if (params.email)     orClauses.push(`email.eq.${params.email}`)
    if (params.phone)     orClauses.push(`phone.eq.${params.phone}`)

    if (orClauses.length > 0) {
      query = query.or(orClauses.join(','))
    }

    const { data: suppressionRows, error: suppressionError } = await query.limit(1)

    // FAIL CLOSED. This read used to be `const { data } = await query` — the
    // error was never destructured, so a REFUSED query produced null rows and
    // fell through to `{ suppressed: false }`. A suppression check that cannot
    // read the suppression list must not report "not suppressed"; that is the
    // one answer it is certain it does not have.
    //
    // This was reachable, not theoretical. brokerage_id is a uuid column, and
    // callers reached this with brokerageId = "" (app/actions/external-services
    // resolveBrokerageId returned "" on every failure path). `.eq('brokerage_id','')`
    // is 22P02 `invalid input syntax for type uuid` — so the query errored, the
    // error was swallowed, and the send proceeded. The contact-flag gate above
    // still caught flag-based opt-outs, but this is the gate dispatch documents
    // as the one that catches LIST-ONLY entries the flag gate misses, so a
    // recipient on the suppression list and nowhere else was sent to.
    if (suppressionError) {
      console.error("[checkSuppression] suppression list read refused:", suppressionError.message)
      return {
        suppressed: true,
        reason: `Suppression list unreadable — refusing to send (${suppressionError.message})`,
      }
    }

    if (suppressionRows && suppressionRows.length > 0) {
      return {
        suppressed: true,
        reason: `Suppressed: ${suppressionRows[0].suppression_reason}`,
      }
    }
  }

  return { suppressed: false }
}

/**
 * Add a contact to the suppression list and update the contact row.
 * Called by unsubscribe page and SMS STOP handler.
 */
export async function addSuppression(params: {
  brokerageId: string
  contactId?: string | null
  email?: string | null
  phone?: string | null
  channel: SuppressionChannel
  reason: string
  source: string   // 'email_footer' | 'sms_stop' | 'manual' | 'admin'
}): Promise<void> {
  const supabase = createServiceClient()
  const now = new Date().toISOString()

  // Insert suppression row
  await supabase.from('contact_suppression_list').insert({
    brokerage_id:      params.brokerageId,
    contact_id:        params.contactId ?? null,
    email:             params.email ?? null,
    phone:             params.phone ?? null,
    channel:           params.channel,
    suppression_reason: params.reason,
    source:            params.source,
    created_at:        now,
  })

  // Update contact flags
  if (params.contactId) {
    const updates: Record<string, unknown> = { updated_at: now }
    if (params.channel === 'email') {
      updates.email_unsubscribed    = true
      updates.email_unsubscribed_at = now
      updates.email_opt_out         = true   // keep legacy in sync
    }
    if (params.channel === 'sms') {
      updates.sms_unsubscribed    = true
      updates.sms_unsubscribed_at = now
      updates.sms_opt_out         = true
    }
    if (params.channel === 'phone') {
      updates.call_stop_flag = true
    }

    await supabase
      .from('contacts')
      .update(updates)
      .eq('id', params.contactId)
  }

  // Also insert consent event for audit
  await supabase.from('contact_consent_events').insert({
    contact_id:     params.contactId ?? null,
    brokerage_id:   params.brokerageId,
    consent_type:   params.channel === 'email' ? 'email_unsubscribe' : 'sms_stop',
    consent_text:   `${params.source}: ${params.reason}`,
    consent_source: params.source,
    consented:      false,   // opt-out
    created_at:     now,
  })
}
