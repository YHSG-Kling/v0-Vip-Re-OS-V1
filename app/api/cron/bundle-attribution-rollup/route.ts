/**
 * app/api/cron/bundle-attribution-rollup/route.ts
 *
 * Wave 38 — daily cross-channel attribution rollup. Walks every
 * campaign_bundle_dispatches row in the last 28d and updates
 * scans_count + leads_count based on the channel-specific outcome
 * tables. The performance dashboard then answers "this bundle drove
 * N leads across M channels" in one query.
 *
 * Attribution model per channel:
 *
 *   POSTCARD / LETTER (direct_mail_campaigns.bundle_dispatch_id)
 *     scans = COUNT qr_scan_events WHERE qr_code_id ∈ campaign QR codes
 *     leads = COUNT contacts CREATED WHERE source='qr_scan' AND the
 *             originating qr_code_id was on a bundled mailer
 *
 *   EMAIL (channel_outcomes.email.message_id → email_sends.provider_message_id
 *          → email_tracking.email_send_id)
 *     scans = COUNT email_tracking WHERE event_type IN ('click','open')
 *             joined via email_sends. The provider_message_id is the
 *             Resend/Postmark id stamped at egress; email_tracking
 *             references the email_sends.id directly.
 *     leads = COUNT contacts CREATED via reply / form-submit tied to
 *             the email's tracking_id
 *
 *   SMS / VOICEDROP (messages from contact in window after dispatch)
 *     scans = COUNT messages WHERE contact_id=this.contact_id AND
 *             direction='inbound' AND created_at >= dispatched_at.
 *             ENGAGEMENT PROXY: we don't have a per-message reply
 *             threading id in our schema, so any inbound from the
 *             same contact in the window after dispatch is counted.
 *             Over-counts when a contact replies for unrelated reasons.
 *             `messages` carries NO lead_id (schema-snapshot :425), so a
 *             lead-only dispatch has no inbound-message proxy at all —
 *             see the LEAD block below for what it does have.
 *     leads = COUNT contacts CREATED via the reply path
 *
 *   LEAD RECIPIENT (campaign_bundle_dispatches.lead_id — wave 26 columns)
 *     orchestrate-bundle-send.ts writes lead_id OR contact_id (a bundle
 *     can be mailed / emailed / texted to a LEAD), but this rollup only
 *     ever selected contact_id, so every bundle sent to a lead counted
 *     its QR scans and nothing else: no engagement, and — worse — no
 *     conversion, even though the lead converting IS the outcome a
 *     lead-targeted bundle exists to drive. Now, for a lead dispatch:
 *     scans += COUNT mail_response_tracking WHERE lead_id = this.lead_id
 *              AND created_at >= dispatched_at AND response_type <>
 *              'qr_scan' (qr_scan rows are the same events already
 *              counted above via qr_scan_events — counting them here
 *              too would double them; call / form_submit / appointment
 *              are the hand-raises only this ledger records, m491)
 *     leads += 1 WHEN leads.converted_at >= dispatched_at (the lead
 *              became a contact after the bundle reached them — a
 *              sharper signal than the brokerage-wide source='qr_scan'
 *              count, and the only one that names THIS recipient)
 *     and the lead's contacts row (leads.contact_id), when it has one,
 *     stands in for contact_id in the SMS / VOICEDROP / PORTAL proxies
 *     so a converted lead's replies are not dropped on the floor.
 *     Blind spot: a lead that replied by SMS but has not converted is
 *     invisible here — messages has no lead_id to find it by.
 *
 *   SOCIAL_POST (social_media_analytics by post_id)
 *     scans = SUM clicks + engagements per platform row (engagements
 *             aggregates reactions/saves/shares server-side; the live
 *             schema does not expose them as separate columns)
 *     leads = ad_performance.conversions when the post drove an ad
 *
 *   PODCAST (podcast_analytics_events by episode_id, via
 *            podcast_distribution_log.podcast_episode_id)
 *     scans = COUNT cta_click events after dispatch (the listen-
 *             through event isn't yet emitted; cta_click is the
 *             canonical engagement signal the rest of the OS reads)
 *     leads = COUNT contacts CREATED via the podcast's QR/CTA
 *
 *   AD_RETARGET (ad_performance by ad_campaign_id from dispatch metadata)
 *     scans = SUM impressions (engagement-equivalent on the retarget
 *             channel — clicks are higher-signal but lower-volume)
 *     leads = SUM conversions
 *
 *   PORTAL_PUSH (portal_event_stream view tracking)
 *     scans = portal card views in the 14d after staging
 *     leads = no lead conversion path from portal (already a contact)
 *
 * Schedule: 0 9 * * * — daily 09:00 UTC, after the variant outcomes
 * aggregator (08:30) so per-channel signals are already updated.
 *
 * Auth: CRON_SECRET. No external API calls; pure JOIN + UPDATE work.
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"

export const dynamic = "force-dynamic"
export const maxDuration = 300

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

interface DispatchRow {
  id:                string
  brokerage_id:      string
  bundle_id:         string
  contact_id:        string | null
  lead_id:           string | null
  channel_outcomes:  Record<string, { message_id?: string | null; preset_id?: string | null }> | null
  dispatched_at:     string
}

export async function GET(req: NextRequest) {
  const auth     = req.headers.get("authorization")?.replace("Bearer ", "")
  const url      = new URL(req.url)
  const qs       = url.searchParams.get("secret")
  const expected = process.env.CRON_SECRET
  if (!expected) return NextResponse.json({ skipped: "CRON_SECRET not configured" })
  if (auth !== expected && qs !== expected) return unauthorized()

  const svc = createServiceClient()
  const since28d = new Date(Date.now() - 28 * 86_400_000).toISOString()

  // Pull every dispatch in the 28d window. Per-cycle cap so one
  // cron tick doesn't try to roll up an enormous backlog.
  const { data: dispatchRows } = await svc.from("campaign_bundle_dispatches")
    .select("id, brokerage_id, bundle_id, contact_id, lead_id, channel_outcomes, dispatched_at")
    .gte("dispatched_at", since28d)
    .order("dispatched_at", { ascending: false })
    .limit(5000)
  const dispatches = (dispatchRows ?? []) as DispatchRow[]
  if (dispatches.length === 0) {
    return NextResponse.json({ ran_at: new Date().toISOString(), dispatches_rolled_up: 0 })
  }

  let totalUpdated = 0
  let leadDispatches = 0
  let leadConversions = 0
  let leadLookupRefusals = 0
  const byBundle = new Map<string, { dispatches: number; scans: number; leads: number }>()

  for (const d of dispatches) {
    let scans = 0
    let leads = 0
    const outcomes = d.channel_outcomes ?? {}

    // ── LEAD recipient (see the header block) ───────────────────────────────
    // Resolved FIRST because the lead's contacts row, when it has one, is what
    // the SMS / VOICEDROP / PORTAL proxies below key on.
    let recipientContactId = d.contact_id
    if (d.lead_id) {
      leadDispatches++
      const { data: leadRow, error: leadErr } = await svc.from("leads")
        .select("id, contact_id, converted_at")
        .eq("id", d.lead_id)
        .eq("brokerage_id", d.brokerage_id)
        .maybeSingle()
      if (leadErr) {
        // §3: a refused read is not "no lead". Counted and logged, never
        // rendered as a zero.
        leadLookupRefusals++
        console.error("[bundle-attribution-rollup] leads read refused:", leadErr.message, { dispatch: d.id, lead_id: d.lead_id })
      } else if (leadRow) {
        const lead = leadRow as { id: string; contact_id: string | null; converted_at: string | null }
        if (!recipientContactId && lead.contact_id) recipientContactId = lead.contact_id
        if (lead.converted_at && lead.converted_at >= d.dispatched_at) {
          leads += 1
          leadConversions++
        }
      }
      const { count: leadResponses, error: leadRespErr } = await svc.from("mail_response_tracking")
        .select("id", { count: "exact", head: true })
        .eq("brokerage_id", d.brokerage_id)
        .eq("lead_id", d.lead_id)
        .neq("response_type", "qr_scan")
        .gte("created_at", d.dispatched_at)
      if (leadRespErr) {
        console.error("[bundle-attribution-rollup] mail_response_tracking read refused:", leadRespErr.message, { dispatch: d.id })
      } else {
        scans += leadResponses ?? 0
      }
    }

    // ── POSTCARD / LETTER channel ──────────────────────────────────────────
    // Join direct_mail_campaigns by bundle_dispatch_id → qr_code_id →
    // qr_scan_events count. lead conversion via contacts.qr_code_id.
    const { data: dmCampaigns } = await svc.from("direct_mail_campaigns")
      .select("id, qr_code_id")
      .eq("brokerage_id", d.brokerage_id)
      .eq("bundle_dispatch_id", d.id)
      .not("qr_code_id", "is", null)
    const qrIds = ((dmCampaigns ?? []) as Array<{ qr_code_id: string }>).map((r) => r.qr_code_id)
    if (qrIds.length > 0) {
      const { count: scanCount } = await svc.from("qr_scan_events")
        .select("id", { count: "exact", head: true })
        .in("qr_code_id", qrIds)
        .gte("scanned_at", d.dispatched_at)
      scans += scanCount ?? 0
      // Leads: contacts created from these QR scans in 28d.
      const { count: leadCount } = await svc.from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("brokerage_id", d.brokerage_id)
        .eq("source", "qr_scan")
        .gte("created_at", d.dispatched_at)
      // We don't perfectly attribute per-QR here; the rough count is
      // bounded by the contacts source filter. Refinement to per-QR
      // attribution lands in a follow-up.
      leads += leadCount ?? 0
    }

    // ── EMAIL channel — email_tracking events ──────────────────────────────
    // dispatchEmail stores the provider id on email_sends.provider_message_id;
    // email_tracking references email_sends.id, NOT provider_message_id.
    // Chain: outcomes.email.message_id → email_sends.id → email_tracking.email_send_id
    const emailMsgId = outcomes.email?.message_id
    if (emailMsgId) {
      const { data: sendRow } = await svc.from("email_sends")
        .select("id")
        .eq("brokerage_id", d.brokerage_id)
        .eq("provider_message_id", emailMsgId)
        .maybeSingle()
      const emailSendId = (sendRow?.id as string | undefined) ?? null
      if (emailSendId) {
        const { count: emailOpens } = await svc.from("email_tracking")
          .select("id", { count: "exact", head: true })
          .eq("email_send_id", emailSendId)
          .in("event_type", ["open", "click"])
        scans += emailOpens ?? 0
      }
    }

    // ── SMS — inbound message engagement proxy ─────────────────────────────
    // No per-message reply threading id; any inbound SMS from the same
    // contact after dispatch counts as engagement. See top docstring for
    // the over/under-count caveat.
    const smsMsgId = outcomes.sms?.message_id
    if (smsMsgId && recipientContactId) {
      const { count: replyCount } = await svc.from("messages")
        .select("id", { count: "exact", head: true })
        .eq("contact_id", recipientContactId)
        .eq("direction", "inbound")
        .eq("type", "sms")
        .gte("created_at", d.dispatched_at)
      scans += replyCount ?? 0
    }

    // ── VOICEDROP — inbound phone/SMS callback proxy ───────────────────────
    // Ringless voicemail has no callback API on Slybroadcast. We proxy
    // engagement via inbound messages of any type from the same contact
    // in the window after the drop — call-backs and SMS replies both
    // count. Same over/under-count caveat as SMS above.
    const voicedropJobId = outcomes.voicedrop?.message_id
    if (voicedropJobId && recipientContactId) {
      const { count: vmReplyCount } = await svc.from("messages")
        .select("id", { count: "exact", head: true })
        .eq("contact_id", recipientContactId)
        .eq("direction", "inbound")
        .gte("created_at", d.dispatched_at)
      scans += vmReplyCount ?? 0
    }

    // ── SOCIAL_POST — social_media_analytics ────────────────────────────────
    // Live schema: post_id (NOT social_post_id), and clicks + engagements +
    // impressions are the available counters — no separate shares/saves
    // (engagements aggregates those). Use clicks + engagements as the
    // "scan-equivalent" engagement signal.
    const socialMsgId = outcomes.social_post?.message_id
    if (socialMsgId) {
      const { data: analytics } = await svc.from("social_media_analytics")
        .select("clicks, engagements")
        .eq("post_id", socialMsgId)
      for (const a of (analytics ?? []) as Array<{ clicks: number | null; engagements: number | null }>) {
        scans += (a.clicks ?? 0) + (a.engagements ?? 0)
      }
    }

    // ── PODCAST — podcast_analytics_events ──────────────────────────────────
    // Live schema:
    //   podcast_distribution_log.podcast_episode_id (NOT episode_id)
    //   podcast_analytics_events.created_at  (no occurred_at column)
    //   event_type values written by the platform today include
    //   'cta_click' (lib/campaigns/roi-calculator.ts is the canonical
    //   reader). Listen-through events aren't yet tracked, so cta_click
    //   is the strongest engagement signal we can attribute to a bundle.
    const podcastLogId = outcomes.podcast_episode?.message_id
    if (podcastLogId) {
      const { data: distLog } = await svc.from("podcast_distribution_log")
        .select("podcast_episode_id")
        .eq("id", podcastLogId)
        .maybeSingle()
      const episodeId = (distLog?.podcast_episode_id as string | undefined) ?? null
      if (episodeId) {
        const { count: ctaCount } = await svc.from("podcast_analytics_events")
          .select("id", { count: "exact", head: true })
          .eq("episode_id", episodeId)
          .eq("event_type", "cta_click")
          .gte("created_at", d.dispatched_at)
        scans += ctaCount ?? 0
      }
    }

    // ── AD_RETARGET — ad_performance ───────────────────────────────────────
    const adCampaignId = outcomes.ad_retarget?.message_id
    if (adCampaignId) {
      const { data: adPerf } = await svc.from("ad_performance")
        .select("impressions, conversions")
        .eq("ad_campaign_id", adCampaignId)
      for (const p of (adPerf ?? []) as Array<{ impressions: number | null; conversions: number | null }>) {
        scans += p.impressions ?? 0
        leads += p.conversions ?? 0
      }
    }

    // ── PORTAL_PUSH — portal_event_stream view tracking ────────────────────
    const portalEventId = outcomes.portal_push?.message_id
    if (portalEventId) {
      // Portal cards don't have a built-in view counter; we use the
      // existence of any portal_access_logs entry for this contact
      // in the 14d after the push as a proxy. Conservative — under-
      // counts active engagement but never overstates.
      if (recipientContactId) {
        const fourteenDaysAfter = new Date(new Date(d.dispatched_at).getTime() + 14 * 86_400_000).toISOString()
        const { count: portalViews } = await svc.from("portal_access_logs")
          .select("id", { count: "exact", head: true })
          .eq("contact_id", recipientContactId)
          .gte("accessed_at", d.dispatched_at)
          .lt("accessed_at", fourteenDaysAfter)
        scans += portalViews ?? 0
      }
    }

    // Persist on the dispatch row.
    const { error } = await svc.from("campaign_bundle_dispatches")
      .update({
        scans_count: scans,
        leads_count: leads,
        updated_at:  new Date().toISOString(),
      })
      .eq("id", d.id)
    if (!error) totalUpdated++

    // Per-bundle aggregate for the response payload.
    const agg = byBundle.get(d.bundle_id) ?? { dispatches: 0, scans: 0, leads: 0 }
    agg.dispatches++; agg.scans += scans; agg.leads += leads
    byBundle.set(d.bundle_id, agg)
  }

  return NextResponse.json({
    ran_at:               new Date().toISOString(),
    dispatches_rolled_up: totalUpdated,
    // Lead-recipient attribution, published beside the number (§2): how many
    // dispatches named a lead, how many of those leads converted after the
    // bundle reached them, and how many lead reads were REFUSED (not zero).
    lead_dispatches:      leadDispatches,
    lead_conversions:     leadConversions,
    lead_lookup_refusals: leadLookupRefusals,
    bundle_summaries:     [...byBundle.entries()].map(([id, a]) => ({
      bundle_id:    id,
      dispatches:   a.dispatches,
      total_scans:  a.scans,
      total_leads:  a.leads,
    })),
  })
}
