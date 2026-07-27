import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { addSuppression } from '@/lib/kernel/compliance/check-suppression'

/**
 * app/api/sms/inbound-optout/route.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Receives inbound SMS webhooks from Twilio or similar providers.
 * Detects STOP keywords per TCPA/CTIA rules and immediately suppresses
 * the phone number from future SMS sends.
 *
 * Wire this URL as the inbound SMS webhook in your Twilio / messaging provider.
 *
 * CTIA recognized STOP keywords: STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT
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

    // Normalize phone — strip spaces/dashes for lookup
    const normalizedPhone = from.replace(/\s|-/g, '')

    if (!STOP_KEYWORDS.test(msgBody)) {
      // Not a STOP — pass through for normal inbound handling
      return NextResponse.json({ success: true, action: 'pass_through' })
    }

    // STOP keyword detected — suppress immediately
    const supabase = createServiceClient()

    // Look up contact(s) by phone across all brokerages
    const { data: contacts } = await supabase
      .from('contacts')
      .select('contact_id, brokerage_id, phone')
      .or(`phone.eq.${from},phone.eq.${normalizedPhone}`)

    if (contacts && contacts.length > 0) {
      // Suppress in all brokerages that have this contact
      await Promise.all(
        contacts.map((c) =>
          addSuppression({
            brokerageId: c.brokerage_id,
            contactId:   c.contact_id,
            phone:       c.phone ?? from,
            channel:     'sms',
            reason:      `STOP keyword received: "${msgBody.trim()}"`,
            source:      'sms_stop',
          })
        )
      )
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
        await addSuppression({
          brokerageId: providerConfig.brokerage_id,
          phone:       from,
          channel:     'sms',
          reason:      `STOP keyword received from unknown number: "${msgBody.trim()}"`,
          source:      'sms_stop',
        })
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
