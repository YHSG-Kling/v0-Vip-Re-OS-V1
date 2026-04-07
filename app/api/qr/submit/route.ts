// SYSTEM: QR Form Submit → Contact creation (Contact-first, Track B)
// Form submission = TCPA consent. Creates contact via captureContact().

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { captureContact } from '@/lib/contact-pipeline/contact-capture'
import { KernelEvent } from '@/lib/kernel/events'

export const dynamic = 'force-dynamic'

interface QRSubmitBody {
  slug: string
  qrCodeId: string
  first_name: string
  last_name: string
  email?: string
  phone?: string
  tcpa_checked: boolean
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = (await req.json()) as QRSubmitBody
    const { slug, qrCodeId, first_name, last_name, email, phone, tcpa_checked } = body

    // ── Step 1: TCPA channel check — do not block lead creation ─────────────
    // Per TCPA corrected rule: create contact regardless of consent.
    // Suppress phone/SMS when tcpa_checked is false.
    const consentGiven = tcpa_checked === true

    if (!slug || !qrCodeId) {
      return NextResponse.json(
        { success: false, error: 'Missing slug or qrCodeId' },
        { status: 400 },
      )
    }

    const supabase = createServiceClient()

    // ── Step 2: Fetch QR code ─────────────────────────────────────────────────
    const { data: qr, error: qrError } = await supabase
      .from('qr_codes')
      .select('id, brokerage_id, agent_user_id, lead_count')
      .eq('id', qrCodeId)
      .eq('is_active', true)
      .single()

    if (qrError || !qr) {
      return NextResponse.json(
        { success: false, error: 'QR code not found or inactive' },
        { status: 404 },
      )
    }

    // ── Step 3: captureContact (dedup → merge/create → enrich queue → score) ─
    const now = new Date().toISOString()
    const { contactId, action } = await captureContact({
      brokerageId: qr.brokerage_id,
      agentUserId: qr.agent_user_id ?? null,
      source: 'qr_scan',
      first_name: first_name || null,
      last_name: last_name || null,
      email: email || null,
      // Only store phone when TCPA consent given; omit to prevent calling
      phone: consentGiven ? (phone || null) : null,
      preferred_channel: consentGiven ? 'phone' : 'email',
      tcpa_consent: consentGiven,
      tcpa_consent_date: consentGiven ? now : null,
      rawPayload: { slug, qrCodeId, first_name, last_name, email, phone },
    })

    // ── Step 4: Increment lead_count only on new contact creation ─────────────
    if (action === 'created') {
      await supabase
        .from('qr_codes')
        .update({ lead_count: (qr.lead_count ?? 0) + 1 })
        .eq('id', qr.id)
    }

    // ── Step 5: Link most recent unlinked scan event to contact ───────────────
    const { data: scanEvent } = await supabase
      .from('qr_scan_events')
      .select('id')
      .eq('qr_code_id', qr.id)
      .is('contact_id', null)
      .order('scanned_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (scanEvent) {
      await supabase
        .from('qr_scan_events')
        .update({ contact_id: contactId })
        .eq('id', scanEvent.id)
    }

    // ── Step 6: Emit lifecycle event ──────────────────────────────────────────
    await supabase.from('lifecycle_events').insert({
      brokerage_id: qr.brokerage_id,
      entity_type: 'contact',
      entity_id: contactId,
      event_type: KernelEvent.CONTACT_CAPTURED,
      metadata: { source: 'qr_scan', slug, qrCodeId, action },
    })

    return NextResponse.json({ success: true, contactId, action })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
