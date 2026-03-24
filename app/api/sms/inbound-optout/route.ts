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
      // Phone not in contacts — add a brokerage-agnostic suppression by phone only
      // Use a sentinel brokerage lookup via the "to" number's provider config
      const { data: providerConfig } = await supabase
        .from('integration_credentials')
        .select('brokerage_id')
        .eq('provider_name', 'twilio')
        .maybeSingle()

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
