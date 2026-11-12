// SYSTEM: QR Scan Audit (Contact-first, Track B)
// Scan = audit event only. No contact created. No consent. Redirect to landing.

import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { KernelEvent } from '@/lib/kernel/events'
// THE INTENDED DESTINATION, ON AN ALLOW-LIST (wave 141F) — pure, tenant-free: the only
// scanner-controlled input it ever sees is the slug this route already resolved a row by.
// WAVE 152 (lane 152C): the ONE lifecycle classifier + the ONE unavailable-code wording (pure), and the scan's permitted
// context (coarse device, referring host, a per-code-per-day visitor key — never the raw IP or browser string).
import { resolveQrScanDestination, qrLifecycleState, qrUnavailableNotice, isAbsentColumnRefusal, type QrMintContext } from '@/lib/marketing/qr-contract'
import { classifyScanForCode, loadQrTenantHosts } from '@/lib/marketing/qr-governance'
import { qrScanEvidence } from '@/lib/marketing/tracked-qr'

export const dynamic = 'force-dynamic'

/**
 * The honest page a scanner sees when the code must not route — or cannot be found, or the
 * service failed. A printed QR outlives the campaign it was printed for. Before wave 141 the route
 * tested `is_active` INSIDE the lookup, so a paused code was indistinguishable from a slug that
 * never existed and both were bounced to the homepage — the person holding the postcard was told
 * nothing. WAVE 152 (152C): every non-routing answer is this page in the tenant-facing message
 * shape (qrUnavailableNotice: what happened · nothing about you was saved · who to contact · one
 * action) — including a missing code (404, was a silent bounce to `/`) and an internal failure
 * (503, was a raw JSON 500). The HTTP status is this route's; the words are the contract's.
 */
function refusalPage(status: number, notice: { heading: string; detail: string; action: string }): NextResponse {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(notice.heading)}</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background:#f8fafc; color:#0f172a; }
  main { max-width:26rem; padding:2rem 1rem; text-align:center; }
  h1 { font-size:1.25rem; margin:0 0 .5rem; }
  p { font-size:1rem; line-height:1.5; color:#475569; margin:0 0 .75rem; }
</style></head>
<body><main><h1>${esc(notice.heading)}</h1><p>${esc(notice.detail)}</p><p>${esc(notice.action)}</p></main></body></html>`
  return new NextResponse(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** HTTP status per unavailable state: paused is resumable (403, not Gone); expired / retired / revoked are Gone (410). */
const UNAVAILABLE_STATUS = { paused: 403, expired: 410, retired: 410, revoked: 410 } as const

/** The code row this door reads (the m945 columns are absent until it is applied). */
type ScanCodeRow = {
  // brokerage_id is null only for a PLATFORM code (m664); it is passed through exactly as before this type existed.
  id: string; brokerage_id: string; agent_id: string | null; scan_count: number | null; purpose: string | null
  destination_type: string | null; target_url: string | null; is_active: boolean | null; expires_at: string | null
  retired_at?: string | null; retired_reason?: string | null; mint_context?: Partial<QrMintContext> | null
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(req.url)
    const slug = searchParams.get('slug')

    if (!slug) {
      return refusalPage(400, qrUnavailableNotice('missing'))
    }

    const supabase = createServiceClient()

    // ── Step 1: Fetch QR code ──────────────────────────────────────────────────
    // `is_active` is NOT part of the lookup: a paused code and a slug that never
    // existed are different facts and get different answers. WAVE 152: the
    // retirement + mint-context columns (m945) are read when the table has them;
    // before m945 is applied the read degrades to the earlier columns so a printed
    // code keeps resolving (isAbsentColumnRefusal).
    // (The column list is passed as `string`: supabase-js cannot parse a UNION of two select
    // literals, and the row is typed explicitly below.)
    const readCode = (withProvenance: boolean) => supabase
      .from('qr_codes')
      .select((withProvenance
        ? 'id, brokerage_id, agent_id, scan_count, purpose, destination_type, target_url, is_active, expires_at, retired_at, retired_reason, mint_context'
        : 'id, brokerage_id, agent_id, scan_count, purpose, destination_type, target_url, is_active, expires_at') as string)
      .eq('slug', slug)
      .maybeSingle()
    let { data: qrRow, error: qrError } = await readCode(true)
    if (qrError && isAbsentColumnRefusal(qrError)) ({ data: qrRow, error: qrError } = await readCode(false))
    const qr = qrRow as unknown as ScanCodeRow | null

    if (qrError) {
      console.error('[qr/scan] code lookup refused:', qrError.message)
      return refusalPage(503, qrUnavailableNotice('error'))
    }
    if (!qr) {
      return refusalPage(404, qrUnavailableNotice('missing'))
    }

    // ── Step 1a: Refuse a paused / expired / retired / revoked code, out loud ─
    // Nothing about the scanner is recorded for any of these (the notice says so,
    // and it is true: we return before the scan row is written).
    const state = qrLifecycleState(qr)
    if (state !== 'active') {
      return refusalPage(UNAVAILABLE_STATUS[state], qrUnavailableNotice(state))
    }

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
    const userAgent = req.headers.get('user-agent') ?? null
    const referrer = req.headers.get('referer') ?? null
    // PERMITTED CONTEXT ONLY (wave 152): the raw IP and the full browser string are reduced
    // here and never stored; a code minted with tracking OFF records no per-scan row at all.
    const mintContext: Partial<QrMintContext> = qr.mint_context ?? {}
    const trackScan = mintContext.tracking !== 'disabled'
    const evidence = qrScanEvidence({ qrCodeId: qr.id, ip, userAgent, referrer })
    const trafficClass = trackScan ? await classifyScanForCode(supabase, { qrCodeId: qr.id, visitorKey: evidence.visitorKey, userAgent }) : null

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
    // A BOT (a link previewer, a crawler) is not a mail response: it is counted as a raw
    // scan and classified, and it never reaches the campaign's responses or a lead's timeline.
    if (qr.purpose === 'campaign' && trackScan && trafficClass !== 'bot') {
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
    // WAVE 152 (152C): the PERMITTED context — the referring HOST, a coarse device class,
    // the traffic class and the per-code-per-day visitor key (m946). `ip_address` and
    // `user_agent` are no longer written (TOMBSTONE: they held the raw IP and the full
    // browser string; SURVIVOR: qrScanEvidence in lib/marketing/tracked-qr.ts). Before
    // m946 is applied the classified columns are refused (PGRST204), and the row is written
    // once more without them — the scan still counts.
    if (trackScan) {
      const baseScan = { qr_code_id: qr.id, brokerage_id: qr.brokerage_id, campaign_id: campaignId, referrer: evidence.referrerHost, is_first_scan: qr.scan_count === 0 }
      const { error: scanError } = await supabase.from('qr_scan_events').insert({ ...baseScan, visitor_key: evidence.visitorKey, traffic_class: trafficClass, device_class: evidence.deviceClass })
      if (scanError && isAbsentColumnRefusal(scanError)) {
        await sentinelWrite(supabase, supabase.from('qr_scan_events').insert(baseScan), { table: "qr_scan_events", flow: "qr_scan_events_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })
      } else if (scanError) {
        await sentinelWrite(supabase, Promise.resolve({ error: scanError }), { table: "qr_scan_events", flow: "qr_scan_events_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })
      }
    }

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
          // Coarse only (wave 152): the referring host and device class, never the browser string.
          response_metadata: { slug, source: 'qr_scan_route', referrer_host: evidence.referrerHost, device_class: evidence.deviceClass, traffic_class: trafficClass },
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
        // `response_metadata` is deliberately NOT copied onto the ROI ledger —
        // tombstone and live nullability evidence at app/actions/direct-mail.ts
        // (logResponse's mail_response_tracking insert); the survivor is the
        // direct_mail_responses row written just above.
        const { error: roiError } = await supabase.from('mail_response_tracking').insert({
          brokerage_id: responseRow.brokerage_id,
          campaign_id: responseRow.campaign_id,
          contact_id: responseRow.contact_id,
          lead_id: responseRow.lead_id,
          response_type: responseRow.response_type,
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
    await sentinelWrite(supabase, supabase
      .from('qr_codes')
      .update({ scan_count: (qr.scan_count ?? 0) + 1 })
      .eq('id', qr.id), { table: "qr_codes", flow: "qr_codes_write", reason: "QR scan counter (reporting)" })

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
    // ── THE INTENDED ACTION (wave 141F) ───────────────────────────────────────
    // This route used to redirect EVERY scan to the generic /qr/<slug> capture form
    // and never read target_url — so a lead-magnet code never reached its magnet, an
    // open-house code never reached the sign-in kiosk, a listing code never reached
    // the listing, and the agent board's "updating the URL reroutes every printed
    // copy" was a promise the handler did not keep. The destination is now decided
    // by the one pure resolver: an allow-listed in-app public path (same host as the
    // app or the request — a tenant's custom domain — under a real public route) is
    // redirected to with `qr=<slug>` for attribution; an https destination on a host
    // we do not own is OFFERED by the landing page as a tap-through link, never
    // auto-followed; anything else lands on the landing. No open redirect: nothing
    // in the request chooses the target, only the row the slug resolved.
    // WAVE 152 (152C): the tenant's VERIFIED custom domains serve this app, so a destination on
    // one of them is an in-app page (still held to the allow-list) — read under the CODE's
    // tenant (the row the slug resolved), never anything the scanner sent.
    const tenantDomains = qr.brokerage_id ? (await loadQrTenantHosts(supabase, qr.brokerage_id)).customDomains.map((d) => `https://${d}`) : []
    const destination = resolveQrScanDestination({
      slug,
      targetUrl: qr.target_url ?? null,
      appOrigins: [process.env.NEXT_PUBLIC_APP_URL ?? null, new URL(req.url).origin, ...tenantDomains],
    })

    const eventMeta = {
      slug,
      campaign_id:      campaignId,
      destination_type: qr.destination_type ?? null,
      purpose:          qr.purpose ?? null,
      // Raw scan vs filtered visit (wave 152): downstream listeners never count a bot as a visit.
      traffic_class:    trafficClass,
      // Analytics: where this scan was actually sent (in_app = the intended action;
      // landing = the capture form, with the reason), so a board can tell a code
      // that routes from one whose destination is unreachable.
      routed:           destination.kind,
      routed_reason:    destination.reason,
    }
    await sentinelWrite(supabase, supabase.from('lifecycle_events').insert({
      brokerage_id: qr.brokerage_id,
      entity_type: 'qr_scan',
      entity_id: qr.id,
      event_type: KernelEvent.QR_SCAN_RECEIVED,
      metadata: eventMeta,
    }), { table: "lifecycle_events", flow: "lifecycle_events_echo", reason: "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped" })
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

    // ── Step 5: Redirect to the intended destination ──────────────────────────
    // No contact created. No consent. Scan is audit trail only. `destination.path`
    // is always a same-origin path (the resolver never returns a foreign host), so
    // resolving it against the request URL cannot leave this app.
    const redirectTo = new URL(destination.path, req.url)
    return NextResponse.redirect(redirectTo, { status: 302, headers: { 'cache-control': 'no-store' } })
  } catch (err) {
    // Never a raw 500 to a person holding a printed piece (wave 152): the helpful page, the
    // detail kept internal.
    console.error('[qr/scan] failed:', err instanceof Error ? err.message : err)
    return refusalPage(503, qrUnavailableNotice('error'))
  }
}
