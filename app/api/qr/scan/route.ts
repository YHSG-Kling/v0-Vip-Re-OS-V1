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
      .select('id, brokerage_id, agent_id, scan_count, purpose, destination_type')
      .eq('slug', slug)
      .eq('is_active', true)
      .single()

    if (qrError || !qr) {
      return NextResponse.redirect(new URL('/', req.url))
    }

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
    const userAgent = req.headers.get('user-agent') ?? null
    const referrer = req.headers.get('referer') ?? null

    // ── Step 1b: Attribute scan to direct mail campaign if applicable ─────────
    let campaignId: string | null = null
    if (qr.purpose === 'campaign') {
      const { data: dm } = await supabase
        .from('direct_mail_campaigns')
        .select('id')
        .eq('qr_code_id', qr.id)
        .maybeSingle()
      campaignId = dm?.id ?? null
    }

    // ── Step 2: Insert qr_scan_events (audit row only) ────────────────────────
    await supabase.from('qr_scan_events').insert({
      qr_code_id: qr.id,
      brokerage_id: qr.brokerage_id,
      campaign_id: campaignId,
      ip_address: ip,
      user_agent: userAgent,
      referrer,
      is_first_scan: qr.scan_count === 0,
    })

    // ── Step 2b: Record the scan as a DIRECT MAIL RESPONSE ───────────────────
    // `direct_mail_responses` is what the mail dashboard's Responses tab reads and
    // what per-campaign response counts / cost-per-response are computed from. Its
    // only writer in the tree was app/actions/direct-mail.ts:logResponse, whose only
    // caller was app/actions/ai-direct-mail.ts:trackCampaignResponse, which had no
    // caller of its own — so the table had NO writer at all and the whole direct-mail
    // attribution loop terminated here, at the audit row, and never reached the
    // surface that reports it.
    //
    // This is the ANONYMOUS door, deliberately separate from the agent-facing action:
    // the person scanning a mailer is a prospect with no session, so routing it
    // through the session-gated `trackCampaignResponse` would either turn the real
    // event source away or require inventing an identity for it. The tenant is NOT
    // taken from anything the scanner controls — `qr.brokerage_id` was already
    // resolved from the qr_codes row above, and campaignId from the campaign that
    // owns that QR. Best-effort: an attribution write must never break the redirect
    // the prospect is waiting on.
    if (campaignId) {
      try {
        const responseRow = {
          brokerage_id: qr.brokerage_id,
          campaign_id: campaignId,
          response_type: 'qr_scan' as const, // in direct_mail_responses' CHECK set
          response_metadata: { slug, source: 'qr_scan_route', referrer, user_agent: userAgent },
        }
        // Both tables, matching logResponse: the first feeds the Responses tab, the
        // second feeds ROI aggregation.
        await supabase.from('direct_mail_responses').insert(responseRow)
        await supabase.from('mail_response_tracking').insert({
          brokerage_id: responseRow.brokerage_id,
          campaign_id: responseRow.campaign_id,
          response_type: responseRow.response_type,
          response_metadata: responseRow.response_metadata,
        })
      } catch (err) {
        console.error('[qr/scan] direct-mail response attribution failed (non-blocking):', err)
      }
    }

    // ── Step 3: Increment scan_count ──────────────────────────────────────────
    await supabase
      .from('qr_codes')
      .update({ scan_count: (qr.scan_count ?? 0) + 1 })
      .eq('id', qr.id)

    // ── Step 4: Emit lifecycle event + fan out ────────────────────────────────
    // fanOutKernelEvent fires processKernelEvent (staff alerts) + auto-enrolls
    // any campaign_sequence that listens on qr_scan_received. Scan is still
    // anonymous (no contact_id) so portal-update fan-out is a no-op here —
    // when the agent connects the scan to a contact via landing-page intake,
    // the contact-creation event will auto-enroll the right sequence.
    // Wave 36 — include destination_type in the event metadata so any
    // downstream listener (analytics aggregator, marketing-agent
    // snapshot) can bucket scans by their semantic destination without
    // joining back to qr_codes.
    const eventMeta = {
      slug,
      campaign_id:      campaignId,
      destination_type: qr.destination_type ?? null,
      purpose:          qr.purpose ?? null,
    }
    await supabase.from('lifecycle_events').insert({
      brokerage_id: qr.brokerage_id,
      entity_type: 'qr_scan',
      entity_id: qr.id,
      event_type: KernelEvent.QR_SCAN_RECEIVED,
      metadata: eventMeta,
    })
    try {
      const { fanOutKernelEvent } = await import('@/lib/kernel/event-fanout')
      await fanOutKernelEvent({
        event:       KernelEvent.QR_SCAN_RECEIVED,
        brokerageId: qr.brokerage_id,
        entityType:  'qr_scan',
        entityId:    qr.id,
        metadata:    eventMeta,
      })
    } catch { /* non-blocking */ }

    // ── Step 5: Redirect to landing page ─────────────────────────────────────
    // No contact created. No consent. Scan is audit trail only.
    const landingUrl = new URL(`/qr/${slug}`, req.url)
    return NextResponse.redirect(landingUrl)
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
