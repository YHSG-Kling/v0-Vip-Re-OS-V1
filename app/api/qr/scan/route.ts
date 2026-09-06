// SYSTEM: QR Scan Audit (Contact-first, Track B)
// Scan = audit event only. No contact created. No consent. Redirect to landing.

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { KernelEvent } from '@/lib/kernel/events'

export const dynamic = 'force-dynamic'

/**
 * The honest refusal a scanner sees when the code resolves but must not route.
 *
 * A printed QR outlives the campaign it was printed for. Before this, the route
 * tested `is_active` INSIDE the lookup, so a paused code was indistinguishable
 * from a slug that never existed and both were bounced to the homepage — the
 * person holding the postcard was told nothing, and `expires_at` (a real column,
 * written by marketing surfaces) was never read at all, so an expired code
 * resolved forever. A scan that is deliberately not honoured says so.
 */
function refusalPage(status: number, heading: string, detail: string): NextResponse {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${heading}</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background:#f8fafc; color:#0f172a; }
  main { max-width:26rem; padding:2rem; text-align:center; }
  h1 { font-size:1.25rem; margin:0 0 .5rem; }
  p { font-size:.9rem; line-height:1.5; color:#475569; margin:0; }
</style></head>
<body><main><h1>${heading}</h1><p>${detail}</p></main></body></html>`
  return new NextResponse(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(req.url)
    const slug = searchParams.get('slug')

    if (!slug) {
      return NextResponse.json({ error: 'Missing slug' }, { status: 400 })
    }

    const supabase = createServiceClient()

    // ── Step 1: Fetch QR code ──────────────────────────────────────────────────
    // `is_active` is NOT part of the lookup: a paused code and a slug that never
    // existed are different facts and get different answers.
    const { data: qr, error: qrError } = await supabase
      .from('qr_codes')
      .select('id, brokerage_id, agent_id, scan_count, purpose, destination_type, is_active, expires_at')
      .eq('slug', slug)
      .maybeSingle()

    if (qrError || !qr) {
      return NextResponse.redirect(new URL('/', req.url))
    }

    // ── Step 1a: Refuse a paused or expired code, out loud ────────────────────
    // 403 for paused (the owner can resume it from the QR manager, so it is not
    // Gone); 410 for expired (the code named its own end date and reached it).
    if (!qr.is_active) {
      return refusalPage(
        403,
        'This code is paused',
        'The agent who created this QR code has paused it, so it is not routing scans right now. Please contact them directly.',
      )
    }
    if (qr.expires_at && new Date(qr.expires_at).getTime() <= Date.now()) {
      return refusalPage(
        410,
        'This code has expired',
        'This QR code was set to expire and that date has passed, so it no longer routes anywhere. Please contact the agent who shared it for a current link.',
      )
    }

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
    const userAgent = req.headers.get('user-agent') ?? null
    const referrer = req.headers.get('referer') ?? null

    // ── Step 1b: Attribute scan to direct mail campaign if applicable ─────────
    // m491 — the campaign's OWN recipient anchor comes back with it. A QR code is
    // minted PER CAMPAIGN (qr_codes.slug → direct_mail_campaigns.qr_code_id), so a
    // scan can never identify an individual recipient row — which is exactly why
    // `direct_mail_responses.lead_id` had to be a real column rather than a join
    // through `recipient_id`. For a 1:1 lead mailing (the shape
    // lib/direct-mail/campaign-drain.ts dispatches) `lead_id` on the campaign IS
    // the person holding the postcard.
    let campaignId: string | null = null
    let campaignLeadId: string | null = null
    let campaignContactId: string | null = null
    if (qr.purpose === 'campaign') {
      const { data: dm, error: dmError } = await supabase
        .from('direct_mail_campaigns')
        .select('id, lead_id, contact_id')
        .eq('qr_code_id', qr.id)
        .maybeSingle()
      // A refused read is not "this QR belongs to no campaign". Log it — the
      // scanner still gets their redirect, but attribution silently vanishing is
      // how a campaign's response count stays at zero while people are scanning.
      if (dmError) {
        console.error('[qr/scan] campaign attribution read refused:', dmError.message)
      }
      campaignId = (dm as { id?: string } | null)?.id ?? null
      campaignLeadId = (dm as { lead_id?: string | null } | null)?.lead_id ?? null
      campaignContactId = (dm as { contact_id?: string | null } | null)?.contact_id ?? null
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
    //
    // m491 — AND THE SCAN NOW REACHES THE LEAD IT CAME FROM. Before m491 the two
    // rows below could name a contact and nothing else, so a LEAD scanning the QR
    // on a postcard the product had deliberately mailed them (dispatchDirectMail
    // permits mailing a lead row) was recorded as nobody: contact_id NULL,
    // recipient_id NULL, and no third column that could hold an identity. The
    // scan is still not a sentence and still does not convert anyone — see the
    // ingest call below — but it now lands on the right person's timeline instead
    // of on no one's.
    if (campaignId) {
      try {
        const responseRow = {
          brokerage_id: qr.brokerage_id,
          campaign_id: campaignId,
          contact_id: campaignContactId,
          lead_id: campaignLeadId,
          response_type: 'qr_scan' as const, // in direct_mail_responses' CHECK set
          response_metadata: { slug, source: 'qr_scan_route', referrer, user_agent: userAgent },
        }
        // Both tables, matching logResponse: the first feeds the Responses tab, the
        // second feeds ROI aggregation. Both refusals are now destructured — an
        // insert whose error is discarded is indistinguishable from one that landed.
        const { data: inserted, error: responseError } = await supabase
          .from('direct_mail_responses')
          .insert(responseRow)
          .select('id')
          .maybeSingle()
        if (responseError) {
          console.error('[qr/scan] direct_mail_responses insert refused:', responseError.message)
        }
        const { error: roiError } = await supabase.from('mail_response_tracking').insert({
          brokerage_id: responseRow.brokerage_id,
          campaign_id: responseRow.campaign_id,
          contact_id: responseRow.contact_id,
          lead_id: responseRow.lead_id,
          response_type: responseRow.response_type,
          response_metadata: responseRow.response_metadata,
        })
        if (roiError) {
          console.error('[qr/scan] mail_response_tracking insert refused:', roiError.message)
        }

        // ── THE EVALUATION DOOR ───────────────────────────────────────────────
        // One evaluator for every inbound lead signal:
        // app/actions/lead-signal-ingest.ts ingestDirectMailResponseSignalAction.
        // It records the touch on the lead, and — for a `qr_scan` — deliberately
        // does NOT classify it or convert anyone: a page load is not a hand-raise,
        // and inventing an intent from one is exactly the ambiguity the owner's
        // ruling says must not convert. Passing through it anyway is what keeps
        // the mail lane on ONE path instead of growing a second, quieter one.
        //
        // internalSecret: the scanner is an anonymous prospect with no session, so
        // the door's session-based tenant proof cannot apply. The tenant is not
        // taken from anything the scanner controls — qr.brokerage_id came off the
        // qr_codes row and lead_id off the campaign that owns that QR.
        // providerRef: the response row's own id — the natural idempotency key.
        const responseId = (inserted as { id?: string } | null)?.id ?? null
        if (campaignLeadId && responseId) {
          const { ingestDirectMailResponseSignalAction } = await import(
            '@/app/actions/lead-signal-ingest'
          )
          const outcome = await ingestDirectMailResponseSignalAction({
            brokerageId: qr.brokerage_id,
            leadId: campaignLeadId,
            responseType: 'qr_scan',
            campaignId,
            providerRef: responseId,
            internalSecret: process.env.CRON_SECRET,
          })
          if (outcome.error) {
            console.error('[qr/scan] lead signal evaluation reported an error:', outcome.error)
          }
          // A scanner has no session, so an 'unauthorized' skip means CRON_SECRET
          // is unset and the door fell back to the session path. That is a
          // MISCONFIGURATION, not a quiet no-op: every lead's mail response would
          // be silently dropped at the door while the response row still lands.
          if (outcome.outcome === 'skipped' && outcome.reason === 'unauthorized') {
            console.error(
              '[qr/scan] lead signal REFUSED as unauthorized — CRON_SECRET is unset, so anonymous mail responses cannot reach the evaluation door.',
            )
          }
        }
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
      // Row already written above → skipInsert (fan-out only).
      const { emitKernelEvent } = await import('@/lib/kernel/emit')
      await emitKernelEvent({
        event:       KernelEvent.QR_SCAN_RECEIVED,
        brokerageId: qr.brokerage_id,
        entityType:  'qr_scan',
        entityId:    qr.id,
        metadata:    eventMeta,
        skipInsert:  true,
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
