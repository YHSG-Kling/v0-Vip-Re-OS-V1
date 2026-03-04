// SYSTEM: QR Scan Audit (Contact-first, Track B)
// Scan = audit event only. No contact created. No consent. Redirect to landing.

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { KernelEvent } from '@/lib/kernel/events'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(req.url)
    const slug = searchParams.get('slug')

    if (!slug) {
      return NextResponse.json({ error: 'Missing slug' }, { status: 400 })
    }

    const supabase = createServiceClient()

    // ── Step 1: Fetch QR code ──────────────────────────────────────────────────
    const { data: qr, error: qrError } = await supabase
      .from('qr_codes')
      .select('id, brokerage_id, agent_user_id, scan_count')
      .eq('slug', slug)
      .eq('is_active', true)
      .single()

    if (qrError || !qr) {
      return NextResponse.redirect(new URL('/', req.url))
    }

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
    const userAgent = req.headers.get('user-agent') ?? null
    const referrer = req.headers.get('referer') ?? null

    // ── Step 2: Insert qr_scan_events (audit row only) ────────────────────────
    await supabase.from('qr_scan_events').insert({
      qr_code_id: qr.id,
      brokerage_id: qr.brokerage_id,
      ip_address: ip,
      user_agent: userAgent,
      referrer,
      is_first_scan: qr.scan_count === 0,
    })

    // ── Step 3: Increment scan_count ──────────────────────────────────────────
    await supabase
      .from('qr_codes')
      .update({ scan_count: (qr.scan_count ?? 0) + 1 })
      .eq('id', qr.id)

    // ── Step 4: Emit lifecycle event ──────────────────────────────────────────
    await supabase.from('lifecycle_events').insert({
      brokerage_id: qr.brokerage_id,
      entity_type: 'qr_scan',
      entity_id: qr.id,
      event_type: KernelEvent.QR_SCAN_RECEIVED,
      metadata: { slug },
    })

    // ── Step 5: Redirect to landing page ─────────────────────────────────────
    // No contact created. No consent. Scan is audit trail only.
    const landingUrl = new URL(`/qr/${slug}`, req.url)
    return NextResponse.redirect(landingUrl)
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
