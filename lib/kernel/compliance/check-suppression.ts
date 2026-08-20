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
        'email_unsubscribed, email_opt_out, sms_unsubscribed, sms_opt_out, dnc_status, call_stop_flag, phone_opt_out, direct_mail_opt_out'
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
        // `phone_opt_out` added: it is the column lib/lead-intent/lead-opt-out.ts
        // (CHANNEL_FLAG_COLUMN) and app/actions/ai-isa/process-opt-out.ts both
        // write for a phone opt-out, and this gate did not read it — so a person
        // who opted out through EITHER of those writers was still callable.
        if (contact.dnc_status || contact.call_stop_flag || contact.phone_opt_out) {
          return { suppressed: true, reason: 'Contact is on DNC / call stop list' }
        }
      }
      if (params.channel === 'mail') {
        // The contact-flag gate had NO 'mail' arm at all, so `direct_mail_opt_out`
        // — the flag app/actions/ai-isa/engage-contact.ts:492/612 and
        // app/api/cron/farm-mail-weekly gate their own sends on — was invisible
        // to the shared gate. A mail opt-out recorded as a flag and not as a
        // suppression-list row passed this check.
        if (contact.direct_mail_opt_out) {
          return { suppressed: true, reason: 'Contact has opted out of direct mail' }
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
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RESULT OF A CONSENT WITHDRAWAL. It used to be `void`.
 *
 * `addSuppression` performs THREE writes and, until this change, destructured
 * NONE of them and returned `Promise<void>`. supabase-js RESOLVES a refusal —
 * it does not throw — so every refusal these three writes could produce was
 * discarded and every caller was told the same thing a landed suppression tells
 * them: nothing at all.
 *
 * That is not an abstract fault. It is the mechanism recorded in
 * app/api/unsubscribe/route.ts:29-42: the route passed `contacts.contact_id`
 * where `contact_suppression_list.contact_id` is a FOREIGN KEY onto
 * `contacts(id)`, the insert was refused for FK violation, the refusal vanished
 * here, and the endpoint returned `{ success: true }` to a person it had not
 * unsubscribed. The `contacts` update had the mirror fault — `.eq('id', <the
 * other uuid>)` matches ZERO rows, which supabase-js also reports as success —
 * so this function reported a landed opt-out while writing nothing anywhere.
 *
 * What is being swallowed is a CONSENT WITHDRAWAL, so "we could not tell" and
 * "we did it" must never be the same value. Hence:
 *   · `suppressed` is true ONLY when the suppression-list row is known to exist;
 *   · `contactFlagsUpdated` distinguishes "not attempted" (null, no contactId)
 *     from "refused / matched no row" (false) — the zero-rows case is checked by
 *     selecting the updated ids back, because a zero-row UPDATE is not an error;
 *   · `errors` carries every refusal in write order, so a caller can log the
 *     real reason instead of guessing.
 *
 * BACKWARD COMPATIBLE by construction: this only widens `void` to a value.
 * Existing `await addSuppression({...})` call sites that ignore the return keep
 * compiling unchanged (verified: lib/direct-mail/mail-unsubscribe.ts:264 is
 * exactly that shape and is another lane's file this wave).
 * ─────────────────────────────────────────────────────────────────────────────
 */
export interface AddSuppressionResult {
  /** TRUE only when the `contact_suppression_list` row is KNOWN to have landed. */
  suppressed: boolean
  /** The suppression row's id, when the insert returned one. */
  suppressionId?: string
  /** null = not attempted (no contactId). true/false = landed / refused-or-missed. */
  contactFlagsUpdated: boolean | null
  /** The `contact_consent_events` audit row. */
  consentEventRecorded: boolean
  /** Every refusal, in write order. Empty iff nothing was refused. */
  errors: string[]
  /** The first refusal, for callers that only want a message. */
  error?: string
}

/**
 * `contact_consent_events.consent_type` — the value per channel.
 *
 * VERIFIED AGAINST THE LIVE CHECK VOCABULARY BEFORE CHOOSING, as required:
 * `contact_consent_events` does NOT appear in scripts/check-vocabularies.ts
 * (the digest-verified cache of every single-column CHECK in public — 434
 * tables / 754 columns, generated 2026-08-19). The column therefore carries NO
 * CHECK constraint; scripts/add-compliance-rail-tables.sql:44 declares it plain
 * `text NOT NULL` and lists example values in a COMMENT, not a constraint. So
 * the vocabulary CAN express mail, and NO MIGRATION IS NEEDED for it.
 *
 * THE DEFECT THIS ENDS: the value was computed as
 *   `params.channel === 'email' ? 'email_unsubscribe' : 'sms_stop'`
 * — a two-way branch over a FOUR-member channel union. A MAIL opt-out and a
 * PHONE/DNC request were both ledgered as `sms_stop`. The compliance ledger is
 * the artefact that has to survive an audit, and it was recording the wrong
 * channel for two of the four channels this module accepts.
 *
 * `email_unsubscribe` and `sms_stop` are kept as the spellings they already are
 * — live rows carry them — and the two missing channels are added rather than
 * the whole vocabulary being restyled, so no existing ledger row is orphaned by
 * a rename. (lib/kernel/crm.ts spelled sms `sms_opt_out`; that function never
 * ran, so it wrote no rows and there is nothing to reconcile — see the tombstone
 * there.)
 */
const CONSENT_TYPE_BY_CHANNEL: Record<SuppressionChannel, string> = {
  email: 'email_unsubscribe',
  sms:   'sms_stop',
  phone: 'phone_opt_out',
  mail:  'mail_opt_out',
}

/**
 * Add a contact to the suppression list and update the contact row.
 * Called by the unsubscribe route, the SMS STOP handler, and the direct-mail
 * opt-out applier.
 *
 * RETURNS A RESULT — see AddSuppressionResult above. Callers MUST check it
 * before telling a person they have been suppressed.
 */
export async function addSuppression(params: {
  brokerageId: string
  contactId?: string | null
  email?: string | null
  phone?: string | null
  channel: SuppressionChannel
  reason: string
  source: string   // 'email_footer' | 'sms_stop' | 'manual' | 'admin'
}): Promise<AddSuppressionResult> {
  const supabase = createServiceClient()
  const now = new Date().toISOString()
  const errors: string[] = []

  // ── WRITE 1 — the suppression-list row. This is the one `checkSuppression`
  //    reads, so it is the one that decides whether the opt-out BINDS.
  const { data: inserted, error: insertError } = await supabase
    .from('contact_suppression_list')
    .insert({
      brokerage_id:      params.brokerageId,
      contact_id:        params.contactId ?? null,
      email:             params.email ?? null,
      phone:             params.phone ?? null,
      channel:           params.channel,
      suppression_reason: params.reason,
      source:            params.source,
      created_at:        now,
    })
    .select('id')
    .maybeSingle()

  if (insertError) {
    console.error('[addSuppression] suppression row REFUSED:', insertError.message)
    errors.push(`contact_suppression_list: ${insertError.message}`)
  }
  const suppressed = !insertError && !!inserted?.id

  // ── WRITE 2 — the contact's own opt-out flags.
  let contactFlagsUpdated: boolean | null = null
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
      // `dnc_status` and `phone_opt_out` were NOT written. `checkSuppression`
      // reads dnc_status, and lib/lead-intent/lead-opt-out.ts + the AI-ISA
      // opt-out processor both key phone on `phone_opt_out`. Writing one of
      // three left the other two readers seeing a contact who never objected.
      updates.dnc_status     = true
      updates.phone_opt_out  = true
    }
    if (params.channel === 'mail') {
      // 'mail' had NO arm here at all — a direct-mail opt-out updated no contact
      // flag whatsoever. `direct_mail_opt_out` is the flag the two live mail
      // senders actually gate on (app/actions/ai-isa/engage-contact.ts:492 and
      // :612, app/api/cron/farm-mail-weekly), so a person who opted out of mail
      // kept receiving mail from both of them.
      updates.direct_mail_opt_out = true
    }

    // `.eq('id', …)` and NOTHING ELSE. `contacts.id` is the primary key, so it
    // already identifies exactly one row in exactly one tenant; adding a
    // brokerage predicate here cannot narrow a PK lookup and can only turn a
    // legitimate opt-out into a zero-row miss when the caller's brokerageId and
    // the contact's disagree. The caller resolved this id; we honour it.
    //
    // `.select('id')` is the point: a zero-row UPDATE is NOT an error in
    // PostgREST. Without reading the affected rows back, `.eq('id', <a uuid
    // that matches nobody>)` — the exact defect app/api/unsubscribe/route.ts
    // documents — is indistinguishable from a successful write.
    const { data: touched, error: updateError } = await supabase
      .from('contacts')
      .update(updates)
      .eq('id', params.contactId)
      .select('id')

    if (updateError) {
      console.error('[addSuppression] contact flag update REFUSED:', updateError.message)
      errors.push(`contacts: ${updateError.message}`)
      contactFlagsUpdated = false
    } else if (!Array.isArray(touched) || touched.length === 0) {
      console.error(
        `[addSuppression] contact flag update matched NO ROW for contacts.id=${params.contactId} — ` +
          'the id is not a contacts primary key (contacts.contact_id is a DIFFERENT uuid)',
      )
      errors.push(`contacts: update matched no row for id ${params.contactId}`)
      contactFlagsUpdated = false
    } else {
      contactFlagsUpdated = true
    }
  }

  // ── WRITE 3 — the consent ledger row. This is the audit artefact.
  const { error: consentError } = await supabase.from('contact_consent_events').insert({
    contact_id:     params.contactId ?? null,
    brokerage_id:   params.brokerageId,
    consent_type:   CONSENT_TYPE_BY_CHANNEL[params.channel],
    consent_text:   `${params.source}: ${params.reason}`,
    consent_source: params.source,
    consented:      false,   // opt-out
    created_at:     now,
  })
  if (consentError) {
    console.error('[addSuppression] consent event REFUSED:', consentError.message)
    errors.push(`contact_consent_events: ${consentError.message}`)
  }

  return {
    suppressed,
    ...(inserted?.id ? { suppressionId: inserted.id as string } : {}),
    contactFlagsUpdated,
    consentEventRecorded: !consentError,
    errors,
    ...(errors.length > 0 ? { error: errors[0] } : {}),
  }
}
