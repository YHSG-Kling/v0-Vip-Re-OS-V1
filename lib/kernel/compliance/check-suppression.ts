'use server'

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
  blocked: boolean
  reason?: string
}

export async function checkSuppression(
  params: CheckSuppressionParams
): Promise<SuppressionResult> {
  const supabase = createServiceClient()

  // ── 1. Check contact flags ────────────────────────────────────────────────
  if (params.contactId) {
    const { data: contact } = await supabase
      .from('contacts')
      .select(
        'email_unsubscribed, email_opt_out, sms_unsubscribed, sms_opt_out, dnc_status, call_stop_flag'
      )
      .eq('contact_id', params.contactId)
      .maybeSingle()

    if (contact) {
      if (params.channel === 'email') {
        if (contact.email_unsubscribed || contact.email_opt_out) {
          return { blocked: true, reason: 'Contact has unsubscribed from email' }
        }
      }
      if (params.channel === 'sms') {
        if (contact.sms_unsubscribed || contact.sms_opt_out) {
          return { blocked: true, reason: 'Contact has opted out of SMS' }
        }
      }
      if (params.channel === 'phone') {
        if (contact.dnc_status || contact.call_stop_flag) {
          return { blocked: true, reason: 'Contact is on DNC / call stop list' }
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

    const { data: suppressionRows } = await query.limit(1)

    if (suppressionRows && suppressionRows.length > 0) {
      return {
        blocked: true,
        reason: `Suppressed: ${suppressionRows[0].suppression_reason}`,
      }
    }
  }

  return { blocked: false }
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
      .eq('contact_id', params.contactId)
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
