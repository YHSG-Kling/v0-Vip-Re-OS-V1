import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { addSuppression } from '@/lib/kernel/compliance/check-suppression'

export async function POST(req: NextRequest) {
  try {
    const { contactId, channel } = await req.json()

    if (!contactId || !channel) {
      return NextResponse.json({ error: 'contactId and channel are required' }, { status: 400 })
    }
    if (channel !== 'email' && channel !== 'sms') {
      return NextResponse.json({ error: 'channel must be email or sms' }, { status: 400 })
    }

    const supabase = createServiceClient()

    // Look up contact to get brokerage + email/phone
    const { data: contact, error: contactErr } = await supabase
      .from('contacts')
      .select('contact_id, brokerage_id, email, phone')
      .eq('contact_id', contactId)
      .maybeSingle()

    if (contactErr || !contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    await addSuppression({
      brokerageId: contact.brokerage_id,
      contactId:   contact.contact_id,
      email:       channel === 'email' ? contact.email : null,
      phone:       channel === 'sms'   ? contact.phone : null,
      channel,
      reason:      channel === 'email' ? 'Unsubscribed via email footer link' : 'Opted out via unsubscribe page',
      source:      'email_footer',
    })

    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('[v0] /api/unsubscribe error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
