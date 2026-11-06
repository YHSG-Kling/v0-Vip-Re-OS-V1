/**
 * lib/kernel/compliance/check-suppression.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Called before EVERY email or SMS send. Checks:
 *   1. contacts.email_unsubscribed / sms_unsubscribed flags
 *   2. contacts.email_opt_out / sms_opt_out flags (legacy columns)
 *   3. contacts.dnc_status for phone AND sms (wave 148: a text is a "call" under the TCPA — the FCC applies the National
 *      DNC protections to texts — so a DNC'd number is not texted either)
 *   4. contact_suppression_list rows by contact_id, email, or phone
 *   5. platform_suppression_list (wave 148 — the cross-tenant list lib/platform/suppression-list.ts documents as read "before
 *      any outbound channel attempt"; this gate never read it, so a spam-complaint / litigator / federal-DNC entry still sent)
 *
 * CONTRACT C16 (wave 148, lane 148B): THIS is the one suppression READ every sender rides (lib/providers/dispatch.ts email /
 * SMS / direct mail, the outbound call gates, the campaign scheduler's dispatch, the arbiter's and responder's sends through
 * dispatch) and `addSuppression` below is the one WRITE every revocation lands in (SMS STOP / revocation words, the email
 * unsubscribe link + one-click List-Unsubscribe, portal preferences, DNC). A STOP at T0 refuses every channel's send at T0+1:
 * the flags and the list row are written before the STOP is acknowledged, and every send reads them before it spends.
 *
 * Returns { suppressed: boolean, reason?: string }
 */

import { createServiceClient } from '@/lib/supabase/service'

export type SuppressionChannel = 'email' | 'sms' | 'phone' | 'mail'

export interface CheckSuppressionParams {
  brokerageId: string
  contactId?: string | null
  email?: string | null
  phone?: string | null
  channel: SuppressionChannel
  /**
   * THE MAILING ADDRESS ABOUT TO BE PRINTED ON THE PIECE (channel 'mail' only).
   *
   * Added because contactId / email / phone are the WRONG THREE IDENTITIES for
   * this channel. A direct-mail recipient is identified by a mailbox, and the
   * normal recipient of an acquisition mailer — a purchased farm list, an
   * audience import — has no contact row, no lead row, no email and no phone.
   * For that person the OR list below was EMPTY, so this function returned
   * `{ suppressed: false }` having asked no question, while m493's postcard
   * carried a printed promise that they could stop it.
   *
   * Supplying these two values arms the address arm (m503's
   * `contact_suppression_list.mailing_address_key`). Omitting them changes
   * nothing for the three other channels, which have no address.
   */
  mailingStreet?: string | null
  mailingZip?: string | null
}

/** The client every read / write rides — the service client by default; an in-memory client in a proof (wave 148). */
type SuppressionClient = { from: (table: string) => any }

/**
 * PURE — the stored spellings a phone may sit under in contact_suppression_list.phone (a free-text column: a STOP writes the
 * carrier's E.164 "+15551234567", an unsubscribe page or a contact row writes "(555) 123-4567"). Asked as an `.in()` set so a
 * number-only send matches a row written in another format (the defect: `phone.eq.<raw>` matched only the identical string).
 */
function suppressionPhoneVariants(phone: string | null | undefined): string[] {
  const raw = String(phone ?? '').trim()
  if (!raw) return []
  const digits = raw.replace(/\D/g, '')
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  const out = new Set<string>([raw])
  if (ten.length === 10) {
    out.add(ten); out.add(`1${ten}`); out.add(`+1${ten}`)
    out.add(`(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`)
    out.add(`${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}`)
  }
  return [...out]
}

export interface SuppressionResult {
  suppressed: boolean
  reason?: string
}

/**
 * PURE — does a platform_suppression_list row with this reason bind a send on this channel? `federal_dnc` is the telephone
 * registry (calls and texts only); every other reason — and an unknown or missing one (fail closed) — binds every channel.
 */
function platformReasonBinds(reason: string | null | undefined, channel: SuppressionChannel): boolean {
  if (reason === 'federal_dnc') return channel === 'sms' || channel === 'phone'
  return true
}

export async function checkSuppression(
  params: CheckSuppressionParams,
  opts: { client?: SuppressionClient } = {},
): Promise<SuppressionResult> {
  const supabase: any = opts.client ?? createServiceClient()

  // The contact's OWN email / phone (wave 150): a contact-id-only send (direct mail, a queued step that carries no address)
  // still asks the platform list about the person's identities below — never only the ones the caller happened to pass.
  let contactEmail: string | null = null
  let contactPhone: string | null = null

  // ── 1. Check contact flags ────────────────────────────────────────────────
  if (params.contactId) {
    const { data: contact, error: contactError } = await supabase
      .from('contacts')
      .select(
        'email_unsubscribed, email_opt_out, sms_unsubscribed, sms_opt_out, dnc_status, call_stop_flag, phone_opt_out, direct_mail_opt_out, email, phone'
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
      contactEmail = (contact as { email?: string | null }).email ?? null
      contactPhone = (contact as { phone?: string | null }).phone ?? null
      if (params.channel === 'email') {
        if (contact.email_unsubscribed || contact.email_opt_out) {
          return { suppressed: true, reason: 'Contact has unsubscribed from email' }
        }
      }
      if (params.channel === 'sms') {
        if (contact.sms_unsubscribed || contact.sms_opt_out) {
          return { suppressed: true, reason: 'Contact has opted out of SMS' }
        }
        // A text is a call under the TCPA (the FCC applies the National DNC protections to texts): a DNC'd number is not texted.
        if (contact.dnc_status) {
          return { suppressed: true, reason: 'Contact is on DNC — no calls or texts' }
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
  // Wave 148: ONE READ PER IDENTITY instead of one `.or("contact_id.eq.<id>,email.eq.<raw>,phone.eq.<raw>")` string — a raw
  // phone like "(555) 123-4567" carries the or-grammar's own delimiters and broke the filter, and `phone.eq.<raw>` matched
  // only the identical spelling (a STOP stored "+15551234567" never matched a send to "555-123-4567"). The phone is asked in
  // every stored spelling, the email case-folded. Each read FAILS CLOSED exactly as the single read did.
  if (params.contactId || params.email || params.phone) {
    const base = () => supabase
      .from('contact_suppression_list')
      .select('id, suppression_reason')
      .eq('brokerage_id', params.brokerageId)
      .eq('channel', params.channel)
    const reads: Array<{ what: string; q: any }> = []
    if (params.contactId) reads.push({ what: 'contact', q: base().eq('contact_id', params.contactId) })
    if (params.email) {
      const e = String(params.email).trim()
      reads.push({ what: 'email', q: base().in('email', [...new Set([e, e.toLowerCase()])]) })
    }
    const phones = suppressionPhoneVariants(params.phone)
    if (phones.length) reads.push({ what: 'phone', q: base().in('phone', phones) })

    for (const r of reads) {
      const { data: suppressionRows, error: suppressionError } = await r.q.limit(1)

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
      // error was swallowed, and the send proceeded.
      if (suppressionError) {
        console.error(`[checkSuppression] suppression list read (${r.what}) refused:`, suppressionError.message)
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
  }

  // ── 2b. THE PLATFORM LIST (wave 148, C16) — cross-tenant hard suppression (spam complaint, litigator, federal DNC,
  //    explicit opt-out the ISA escalated). lib/platform/suppression-list.ts documents "Reads happen before any outbound
  //    channel attempt"; until now only the distribution engine and the predictive auto-send read it. Phone is keyed by its
  //    last 10 digits, email lower-cased (that module's own normalisation). FAIL CLOSED like every arm above.
  //
  // WAVE 150 (lane 150U — suppression EVERYWHERE): the platform list's own contract is "NO subscriber may contact this
  // person via ANY channel" (lib/platform/suppression-list.ts header). This arm asked only the identity that matched the
  // channel (an email only for email, a phone only for sms/phone) and skipped MAIL entirely — so a litigator or a
  // spam-complaint entry still received a postcard, and a person who said "stop" by text still received a marketing email
  // to the address the sender also knew. Now every identity the caller supplied is asked on every channel, and the REASON
  // decides reach: `federal_dnc` is a telephone rule (calls + texts — the TCPA's DNC registry, never email or mail); every
  // other reason (explicit opt-out, TCPA violation, spam complaint, litigator, manual admin) binds all channels.
  if (params.email || params.phone || contactEmail || contactPhone) {
    const tens = [...new Set([params.phone, contactPhone].map((ph) => String(ph ?? '').replace(/\D/g, '')).filter((d) => d.length >= 10).map((d) => d.slice(-10)))]
    const emails = [...new Set([params.email, contactEmail].map((e) => String(e ?? '').trim().toLowerCase()).filter(Boolean))]
    const platformReads: Array<{ what: string; q: any }> = []
    if (emails.length) platformReads.push({ what: 'email', q: supabase.from('platform_suppression_list').select('id, reason').in('email', emails) })
    if (tens.length) platformReads.push({ what: 'phone', q: supabase.from('platform_suppression_list').select('id, reason').in('phone_digits', tens) })
    for (const r of platformReads) {
      const { data: rows, error } = await r.q.limit(5)
      if (error) {
        console.error(`[checkSuppression] platform suppression list read (${r.what}) refused:`, error.message)
        return { suppressed: true, reason: `Platform suppression list unreadable — refusing to send (${error.message})` }
      }
      const binding = ((rows ?? []) as Array<{ reason?: string | null }>).find((row) => platformReasonBinds(row.reason, params.channel))
      if (binding) return { suppressed: true, reason: `Platform-suppressed: ${binding.reason}` }
    }
  }

  // ── 3. THE ADDRESS ARM — the only identity a mail-only recipient has ──────
  //
  // Runs for channel 'mail' only, and only when the caller handed over the
  // address it is about to print. It is a SEPARATE query from the OR above on
  // purpose: the m503 column may not exist yet in a given database, and a
  // PGRST204 on this arm must not be able to break the contact/email/phone arm
  // that has always worked.
  //
  // The three "no"s this arm can return are NOT the same answer — see
  // lib/direct-mail/address-suppression.ts. Only `unreadable` fails closed;
  // `pendingMigration` cannot hide a row because no row can exist without the
  // column, and `unkeyable` means the arm was never able to ask.
  if (params.channel === 'mail' && (params.mailingStreet || params.mailingZip)) {
    const { checkAddressSuppression } = await import('@/lib/direct-mail/address-suppression')
    const addr = await checkAddressSuppression(supabase, {
      brokerageId: params.brokerageId,
      street: params.mailingStreet,
      zip: params.mailingZip,
    })
    if (addr.suppressed) {
      return { suppressed: true, reason: addr.reason ?? 'This mailing address has opted out of mail' }
    }
    if (addr.unreadable) {
      return { suppressed: true, reason: addr.reason ?? 'Address suppression list unreadable — refusing to send' }
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
}, opts: {
  /** Wave 148: the client the three writes ride (the caller's service client; an in-memory client in a proof). */
  client?: SuppressionClient
  /** Wave 148: false when the caller ALREADY wrote the contact's opt-out flags in the same act (lib/ai-isa/opt-out-writer.ts
   *  writeOptOut) — only the list row and the ledger row are written here. Default true (unchanged). */
  writeContactFlags?: boolean
} = {}): Promise<AddSuppressionResult> {
  const supabase: any = opts.client ?? createServiceClient()
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
  if (params.contactId && opts.writeContactFlags !== false) {
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
