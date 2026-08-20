import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { addSuppression } from '@/lib/kernel/compliance/check-suppression'
import { validateTwilioSignature } from '@/lib/voice/twilio-voice'
import { twilioTokenCandidates } from '@/lib/voice/sms-inbound'

/**
 * app/api/sms/inbound-optout/route.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Receives inbound SMS webhooks from Twilio or similar providers.
 * Detects STOP keywords per TCPA/CTIA rules and immediately suppresses
 * the phone number from future SMS sends.
 *
 * CTIA recognized STOP keywords: STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT
 *
 * ── NOT THE CANONICAL INBOUND SMS INGRESS ───────────────────────────────────
 * The SmsUrl this platform actually binds on every provisioned tenant number is
 * /api/providers/inbound (set at lib/voice/twilio-voice.ts:151, described as the
 * one messaging rail at lib/kernel/manager-registry.ts:606). That route already
 * covers this one's whole job with MORE care: it verifies the Twilio signature
 * against the OWNING SUBACCOUNT's token, resolves the tenant from the CALLED
 * number, and runs the same CTIA keyword set through
 * lib/ai-isa/opt-out-utils.ts:16 → app/actions/ai-isa/process-opt-out.ts.
 * This handler survives only because its URL may still be pasted into a Twilio
 * console somewhere, and a STOP that reaches a 404 is a TCPA problem, not a
 * tidiness one. It is NOT wired by this repo's own provisioning; if the fleet
 * console shows no number pointing here, delete it — the survivor is named above.
 *
 * ── WHY THE SIGNATURE CHECK BELOW EXISTS ────────────────────────────────────
 * It had NO caller authentication at all. The handler runs on the service client
 * and matched contacts by phone ACROSS EVERY BROKERAGE, so an unauthenticated
 * POST of `From=<any phone>&Body=STOP` suppressed that person in every tenant
 * that had them — a cross-tenant write and a denial-of-communication vector, and
 * the TwiML reply told the victim it had happened. The gate is the same one the
 * canonical ingress uses (subaccount token resolved by the To number, master env
 * token as fallback) so a request Twilio really signed still passes here.
 */

const STOP_KEYWORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*$/i

const STOP_REPLY =
  'You have been successfully unsubscribed. You will receive no more messages from this number. Reply START to re-subscribe.'

export async function POST(req: NextRequest) {
  try {
    const body = await req.text()
    const params = new URLSearchParams(body)

    const from    = params.get('From')    ?? params.get('from')
    const msgBody = params.get('Body')    ?? params.get('body') ?? ''
    const to      = params.get('To')      ?? params.get('to')   ?? ''

    if (!from) {
      return NextResponse.json({ error: 'Missing From number' }, { status: 400 })
    }

    // ── Caller verification (X-Twilio-Signature) ────────────────────────────
    // Signed over the exact form params Twilio POSTed, so the object is built
    // from the parsed body rather than from the three fields read above.
    const signedParams: Record<string, string> = {}
    for (const [k, v] of params.entries()) signedParams[k] = v

    const signature = req.headers.get('x-twilio-signature')
    const svcForAuth = createServiceClient()
    const tokens = await twilioTokenCandidates(svcForAuth, signedParams)
    if (tokens.length === 0) {
      console.error('[sms-optout] no Twilio auth token available for To=%s — refusing', to)
      return NextResponse.json({ error: 'Not configured' }, { status: 503 })
    }
    if (!tokens.some((t) => validateTwilioSignature(t, req.url, signedParams, signature))) {
      console.warn('[sms-optout] invalid X-Twilio-Signature for To=%s — refused', to)
      return new NextResponse('invalid signature', { status: 403 })
    }

    // Normalize phone — strip spaces/dashes for lookup
    const normalizedPhone = from.replace(/\s|-/g, '')

    if (!STOP_KEYWORDS.test(msgBody)) {
      // Not a STOP — pass through for normal inbound handling
      return NextResponse.json({ success: true, action: 'pass_through' })
    }

    // STOP keyword detected — suppress immediately
    const supabase = createServiceClient()

    // Look up contact(s) by phone across all brokerages.
    //
    // SELECTS `id`, NOT `contact_id`. `contacts` carries TWO distinct unique
    // uuid columns — the primary key `id` and a secondary `contact_id` — and
    // they are NEVER equal (app/api/unsubscribe/route.ts:10-27 records the live
    // verification). `contact_suppression_list.contact_id` is a FOREIGN KEY onto
    // `contacts(id)`, so this handler was handing addSuppression the OTHER uuid:
    // every STOP produced a foreign-key violation, addSuppression returned void
    // and swallowed it, and the sender replied "You have been successfully
    // unsubscribed" to a person it had not suppressed. Same defect the email
    // footer had, in the one channel where the reply PROMISES the suppression.
    const { data: contacts, error: contactsError } = await supabase
      .from('contacts')
      .select('id, brokerage_id, phone')
      .or(`phone.eq.${from},phone.eq.${normalizedPhone}`)

    // FAIL LOUD, not silently-pass-through: a refused lookup is not "no such
    // contact". Answering 200 here would tell the carrier the STOP was handled.
    if (contactsError) {
      console.error('[sms-optout] contact lookup refused:', contactsError.message)
      return NextResponse.json({ error: 'Could not process opt-out' }, { status: 503 })
    }

    if (contacts && contacts.length > 0) {
      // Suppress in all brokerages that have this contact
      const results = await Promise.all(
        contacts.map((c) =>
          addSuppression({
            brokerageId: c.brokerage_id,
            contactId:   c.id,
            phone:       c.phone ?? from,
            channel:     'sms',
            reason:      `STOP keyword received: "${msgBody.trim()}"`,
            source:      'sms_stop',
          })
        )
      )

      // CHECK THE RESULT. A STOP is a legal obligation under TCPA/CTIA; the
      // reply below states it as done, so a refusal must not be answered with
      // that reply. 503 makes the provider retry the webhook.
      const refused = results.filter((r) => !r.suppressed || r.contactFlagsUpdated === false)
      if (refused.length > 0) {
        console.error(
          `[sms-optout] ${refused.length}/${results.length} STOP suppression(s) REFUSED for ${from}:`,
          refused.flatMap((r) => r.errors).join(' | ') || '(no error reported)',
        )
        return NextResponse.json({ error: 'Could not record opt-out' }, { status: 503 })
      }
    } else {
      // Phone not in contacts. The comment here used to say the brokerage came from the
      // "to" number's provider config — but the query never used `to`. It took the FIRST
      // twilio credential row in the table, so an unknown number's STOP was suppressed
      // under an arbitrary tenant.
      //
      // `to` IS the tenant's own number, and phone_number_events records which brokerage
      // provisioned it. Resolve through that; if the number cannot be attributed, log and
      // do nothing rather than suppress under a brokerage that never messaged them.
      const { data: numberOwner } = await supabase
        .from('phone_number_events')
        .select('brokerage_id')
        .eq('phone_number', to)
        .not('brokerage_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      const providerConfig = numberOwner as { brokerage_id?: string | null } | null
      if (!providerConfig?.brokerage_id) {
        console.warn(`[sms-optout] STOP from unknown number to unattributable number ${to} — not suppressed`)
      }

      if (providerConfig?.brokerage_id) {
        const applied = await addSuppression({
          brokerageId: providerConfig.brokerage_id,
          phone:       from,
          channel:     'sms',
          reason:      `STOP keyword received from unknown number: "${msgBody.trim()}"`,
          source:      'sms_stop',
        })
        // No contactId here (the number is not in contacts), so
        // contactFlagsUpdated is null by design — only the list row can bind
        // this suppression, and `checkSuppression` matches it on `phone`.
        if (!applied.suppressed) {
          console.error(
            `[sms-optout] STOP suppression for unknown number ${from} REFUSED:`,
            applied.errors.join(' | ') || '(no error reported)',
          )
          return NextResponse.json({ error: 'Could not record opt-out' }, { status: 503 })
        }
      }
    }

    // Return Twilio-compatible TwiML response
    return new NextResponse(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${STOP_REPLY}</Message></Response>`,
      {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      }
    )
  } catch (err: any) {
    console.error('[v0] SMS opt-out handler error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
