// lib/campaigns/roi-calculator.ts
// LAYER 9.12 — Campaign ROI Calculator
// Aggregates performance data from existing tables, calculates ROI metrics,
// and writes to campaign_roi and channel_performance using UPSERT (ON CONFLICT).
// 
// CRITICAL: This module does NOT create a second analytics stack.
// It aggregates from existing performance tables only.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { canAccessFeature } from "@/lib/kernel/0.1-feature-access"

// Default avg commission if not available (for ROI calculation)
const DEFAULT_AVG_COMMISSION = 7500

// ONE spelling of the newsletter lead-rate ESTIMATE (§6). It was written 0.02
// inline in both the campaign arm and the channel rollup, which is how the two
// silently disagree the day one of them is tuned. It is an ESTIMATE, not a
// measurement: no newsletter ledger records leads, so this multiplies recipients.
const NEWSLETTER_LEAD_RATE = 0.02

// ═══════════════════════════════════════════════════════════════════════════════
// 1. recalculateCampaignROI — Single campaign ROI calculation
// ═══════════════════════════════════════════════════════════════════════════════

export async function recalculateCampaignROI(
  marketingCampaignId: string,
  brokerageId: string,
  useServiceClient = false
): Promise<{
  success: boolean
  error?: string
  roi?: {
    total_spend: number
    total_leads: number
    qualified_leads: number
    total_conversions: number
    total_revenue: number
    cost_per_lead: number | null
    cost_per_qualified_lead: number | null
    cost_per_conversion: number | null
    roi_percentage: number | null
  }
}> {
  try {
    const supabase = useServiceClient ? createServiceClient() : await createClient()

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 1: Get marketing campaign details
    // ══════════════════════════════════════════════════════════════════════════
    const { data: campaign, error: campaignError } = await supabase
      .from("marketing_campaigns")
      .select("id, campaign_name, campaign_type, budget_spent, budget_total, status")
      .eq("id", marketingCampaignId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()

    if (campaignError || !campaign) {
      return { success: false, error: "Campaign not found" }
    }

    const totalSpend = campaign.budget_spent ?? 0
    const campaignType = campaign.campaign_type

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 2: Aggregate performance data by campaign type
    // ══════════════════════════════════════════════════════════════════════════
    let totalLeads = 0
    let qualifiedLeads = 0
    let totalConversions = 0

    // === SOCIAL campaigns ===
    if (campaignType === "social") {
      // Get social posts linked to this campaign.
      //
      // §1 repoint (2026-09-01): this branch used to demand
      // social_posts.kernel_event_id non-null — a column NO writer stamps
      // (lib/ads/ad-creator.ts:610 writes a literal null on ad_campaigns
      // "will be set by kernel event", and no kernel event ever sets either
      // table's copy) — so every social campaign structurally reported 0.
      // It also never filtered by campaign at all: any stamped post in the
      // brokerage would have counted toward every social campaign. The join
      // key that EXISTS is marketing_campaign_id — written by the video
      // distributor (lib/kernel/video.ts:916) and already read by the
      // sibling ROI rollup (lib/marketing/campaign-measurer.ts:60) and the
      // ad branch below (ad_campaigns.marketing_campaign_id). kernel_event_id
      // is no longer an open item — it RETIRED (m597, 2026-09-01): no
      // kernel_events table ever existed, no FK, no reader anywhere after this
      // repoint, and the one writer wrote a literal null. The durable event
      // link that DOES exist is lifecycle_events, written beside every publish
      // (app/actions/social-media-automation.ts:431, lib/ads/ad-creator.ts:625)
      // — a per-row stamp would just be a second spelling of that (§6). See
      // supabase/migrations/m597-kernel-event-id-five-copies-of-a-link-to-a-
      // table-that-does-not-exist.sql.
      const { data: socialPosts, error: socialPostsError } = await supabase
        .from("social_posts")
        .select("id")
        .eq("brokerage_id", brokerageId)
        .eq("marketing_campaign_id", marketingCampaignId)
      if (socialPostsError) {
        console.error("[ROI Calculator] social_posts read failed:", socialPostsError.message)
      }

      if (socialPosts && socialPosts.length > 0) {
        const postIds = socialPosts.map((p) => p.id)

        // Sum engagement metrics
        const { data: engagement } = await supabase
          .from("social_engagement_tracking")
          .select("clicks_count, leads_generated")
          .in("social_post_id", postIds)
          .eq("brokerage_id", brokerageId)

        if (engagement) {
          for (const e of engagement) {
            totalLeads += e.leads_generated ?? 0
          }
        }
      }
    }

    // === AD campaigns ===
    if (campaignType === "ad") {
      // Get ad campaigns linked to this marketing campaign
      const { data: adCampaigns } = await supabase
        .from("ad_campaigns")
        .select("id")
        .eq("marketing_campaign_id", marketingCampaignId)
        .eq("brokerage_id", brokerageId)

      if (adCampaigns && adCampaigns.length > 0) {
        const adCampaignIds = adCampaigns.map((a) => a.id)

        // Sum ad performance
        const { data: adPerf } = await supabase
          .from("ad_performance")
          .select("spend, leads, conversions")
          .in("ad_campaign_id", adCampaignIds)
          .eq("brokerage_id", brokerageId)

        if (adPerf) {
          for (const p of adPerf) {
            totalLeads += p.leads ?? 0
            totalConversions += p.conversions ?? 0
          }
        }
      }
    }

    // === DIRECT_MAIL campaigns ===
    if (campaignType === "direct_mail") {
      // THE FABRICATED NUMBER (fixed 2026-09-01). Every other arm scopes to the
      // campaign it claims to measure — social on marketing_campaign_id, ad on
      // ad_campaign_id — but this one read mail_response_tracking with NOTHING
      // but `.eq("brokerage_id", …)`. No campaign predicate at all. So EVERY
      // direct-mail campaign in a brokerage reported the SAME lead and
      // conversion count, cost_per_lead was total_spend divided by a
      // brokerage-wide response count, and any spend decision made on it was
      // made on a number that could not vary between campaigns.
      //
      // The join path is real and confirmed against scripts/schema-fk-map.ts:
      //   mail_response_tracking.campaign_id      → direct_mail_campaigns.id
      //   direct_mail_campaigns.marketing_campaign_id → marketing_campaigns.id
      // Resolved in TWO reads, not a bare embed: the resolve is tenant-anchored
      // on its own row, and both errors are DESTRUCTURED AND READ (§3 —
      // supabase-js RESOLVES refusals, so a discarded error degrades silently).
      const { data: mailCampaigns, error: mailCampaignsError } = await supabase
        .from("direct_mail_campaigns")
        .select("id")
        .eq("marketing_campaign_id", marketingCampaignId)
        .eq("brokerage_id", brokerageId)

      if (mailCampaignsError) {
        // FAIL CLOSED (§4). A refused resolve must NEVER degrade back to the
        // brokerage-wide count — that is the exact defect this fix removes, and
        // "nobody checked" must not render as "checked and fine". Refusing here
        // also means the UPSERT below never lands a number nobody can stand
        // behind: the previous campaign_roi row survives, stale but honest.
        console.error(
          "[ROI Calculator] direct_mail campaign resolve refused:",
          mailCampaignsError.message
        )
        return {
          success: false,
          error: `direct_mail campaign resolve refused: ${mailCampaignsError.message}`,
        }
      }

      const mailCampaignIds = (mailCampaigns ?? []).map((c) => c.id)

      // No direct-mail children → an HONEST ZERO. Not a brokerage-wide total.
      // (Skipping the read also avoids `.in("campaign_id", [])`, whose PostgREST
      // rendering is not worth relying on.)
      if (mailCampaignIds.length > 0) {
        const { data: mailResponses, error: mailResponsesError } = await supabase
          .from("mail_response_tracking")
          .select("response_type")
          .eq("brokerage_id", brokerageId)
          .in("campaign_id", mailCampaignIds)

        if (mailResponsesError) {
          console.error(
            "[ROI Calculator] mail_response_tracking read refused:",
            mailResponsesError.message
          )
          return {
            success: false,
            error: `mail_response_tracking read refused: ${mailResponsesError.message}`,
          }
        }

        for (const r of mailResponses ?? []) {
          totalLeads++
          if (["call", "form_submit", "appointment"].includes(r.response_type)) {
            totalConversions++
          }
        }
      }
    }

    // === NEWSLETTER campaigns ===
    if (campaignType === "newsletter") {
      // SAME DEFECT AS DIRECT MAIL, one channel over (fixed 2026-09-01):
      // newsletter_campaigns was filtered on brokerage_id ONLY, so every
      // newsletter campaign in a brokerage reported the identical estimated
      // lead count. The join key exists and is the same shape as everywhere
      // else — newsletter_campaigns.marketing_campaign_id (schema-fk-map :518).
      //   newsletter_scheduled_sends.newsletter_id → newsletter_campaigns.id
      //   newsletter_campaigns.marketing_campaign_id → marketing_campaigns.id
      const { data: newsletters, error: newslettersError } = await supabase
        .from("newsletter_campaigns")
        .select("id")
        .eq("marketing_campaign_id", marketingCampaignId)
        .eq("brokerage_id", brokerageId)

      if (newslettersError) {
        // FAIL CLOSED — a refused resolve must not degrade back to the
        // every-newsletter count this fix removes.
        console.error(
          "[ROI Calculator] newsletter campaign resolve refused:",
          newslettersError.message
        )
        return {
          success: false,
          error: `newsletter campaign resolve refused: ${newslettersError.message}`,
        }
      }

      const newsletterIds = (newsletters ?? []).map((n) => n.id)

      // No newsletters under this campaign → an HONEST ZERO.
      if (newsletterIds.length > 0) {
        const { data: sends, error: sendsError } = await supabase
          .from("newsletter_scheduled_sends")
          .select("recipient_count")
          // The tenant predicate was MISSING here entirely — the column exists
          // (schema-snapshot :441) and went unused, so the read leaned wholly on
          // the id list for its scoping.
          .eq("brokerage_id", brokerageId)
          .in("newsletter_id", newsletterIds)

        if (sendsError) {
          console.error(
            "[ROI Calculator] newsletter_scheduled_sends read refused:",
            sendsError.message
          )
          return {
            success: false,
            error: `newsletter_scheduled_sends read refused: ${sendsError.message}`,
          }
        }

        for (const s of sends ?? []) {
          totalLeads += Math.floor((s.recipient_count ?? 0) * NEWSLETTER_LEAD_RATE)
        }
      }
    }

    // === PODCAST campaigns ===
    if (campaignType === "podcast") {
      // THE JOIN KEY DOES EXIST — an earlier pass of this lane reported "no
      // campaign column on podcast_analytics_events, so no path", having looked
      // only at that one table. The path is two hops, exactly like direct mail:
      //   podcast_analytics_events.episode_id → podcast_episodes.id  (fk-map :577)
      //   podcast_episodes.marketing_campaign_id → marketing_campaigns.id (:582)
      // Before this, every podcast campaign in a brokerage reported the same
      // brokerage-wide CTA-click count.
      const { data: episodes, error: episodesError } = await supabase
        .from("podcast_episodes")
        .select("id")
        .eq("marketing_campaign_id", marketingCampaignId)
        .eq("brokerage_id", brokerageId)

      if (episodesError) {
        console.error("[ROI Calculator] podcast episode resolve refused:", episodesError.message)
        return {
          success: false,
          error: `podcast episode resolve refused: ${episodesError.message}`,
        }
      }

      const episodeIds = (episodes ?? []).map((e) => e.id)

      // No episodes under this campaign → an HONEST ZERO.
      if (episodeIds.length > 0) {
        const { data: podcastClicks, error: podcastClicksError } = await supabase
          .from("podcast_analytics_events")
          .select("id")
          .eq("brokerage_id", brokerageId)
          .eq("event_type", "cta_click")
          .in("episode_id", episodeIds)

        if (podcastClicksError) {
          console.error(
            "[ROI Calculator] podcast_analytics_events read refused:",
            podcastClicksError.message
          )
          return {
            success: false,
            error: `podcast_analytics_events read refused: ${podcastClicksError.message}`,
          }
        }

        totalLeads += (podcastClicks ?? []).length
      }
    }

    // === VIDEO campaigns ===
    if (campaignType === "video") {
      // THE JOIN KEY DOES EXIST, and it is better than the one an earlier pass
      // of this lane guessed at. That pass proposed
      // marketing_campaigns.source_video_project_id and called it
      // one-project-per-campaign; the real key runs the other way and is
      // many-to-one, so a campaign with several videos is measured whole:
      //   video_performance_tracking.video_project_id → ai_video_projects.id (fk-map :788)
      //   ai_video_projects.marketing_campaign_id → marketing_campaigns.id   (:188)
      // Only reads, and only tables this file already owns the ROI meaning of —
      // nothing under lib/video/** or remotion/** is touched.
      const { data: videoProjects, error: videoProjectsError } = await supabase
        .from("ai_video_projects")
        .select("id")
        .eq("marketing_campaign_id", marketingCampaignId)
        .eq("brokerage_id", brokerageId)

      if (videoProjectsError) {
        console.error("[ROI Calculator] video project resolve refused:", videoProjectsError.message)
        return {
          success: false,
          error: `video project resolve refused: ${videoProjectsError.message}`,
        }
      }

      const videoProjectIds = (videoProjects ?? []).map((p) => p.id)

      // No video projects under this campaign → an HONEST ZERO.
      if (videoProjectIds.length > 0) {
        const { data: videoPerf, error: videoPerfError } = await supabase
          .from("video_performance_tracking")
          .select("lead_conversions, unique_views")
          .eq("brokerage_id", brokerageId)
          .in("video_project_id", videoProjectIds)

        if (videoPerfError) {
          console.error(
            "[ROI Calculator] video_performance_tracking read refused:",
            videoPerfError.message
          )
          return {
            success: false,
            error: `video_performance_tracking read refused: ${videoPerfError.message}`,
          }
        }

        for (const v of videoPerf ?? []) {
          totalLeads += v.lead_conversions ?? 0
        }
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 3: Calculate ROI metrics
    // ══════════════════════════════════════════════════════════════════════════
    qualifiedLeads = Math.floor(totalLeads * 0.3) // Estimate 30% qualification rate

    // Total revenue = conversions * avg commission
    const totalRevenue = totalConversions * DEFAULT_AVG_COMMISSION

    // Cost metrics (avoid division by zero)
    const costPerLead = totalLeads > 0 ? totalSpend / totalLeads : null
    const costPerQualifiedLead = qualifiedLeads > 0 ? totalSpend / qualifiedLeads : null
    const costPerConversion = totalConversions > 0 ? totalSpend / totalConversions : null

    // ROI percentage = ((revenue - spend) / spend) * 100
    const roiPercentage =
      totalSpend > 0 ? ((totalRevenue - totalSpend) / totalSpend) * 100 : null

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 4: UPSERT to campaign_roi (ON CONFLICT marketing_campaign_id)
    // ══════════════════════════════════════════════════════════════════════════
    const { error: upsertError } = await supabase.from("campaign_roi").upsert(
      {
        marketing_campaign_id: marketingCampaignId,
        brokerage_id: brokerageId,
        total_spend: totalSpend,
        total_leads: totalLeads,
        qualified_leads: qualifiedLeads,
        total_conversions: totalConversions,
        total_revenue: totalRevenue,
        cost_per_lead: costPerLead,
        cost_per_qualified_lead: costPerQualifiedLead,
        cost_per_conversion: costPerConversion,
        roi_percentage: roiPercentage,
        calculated_at: new Date().toISOString(),
      },
      {
        onConflict: "marketing_campaign_id",
      }
    )

    if (upsertError) {
      console.error("[ROI Calculator] Upsert error:", upsertError)
      return { success: false, error: upsertError.message }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 5: Fire kernel event
    // ══════════════════════════════════════════════════════════════════════════
    await processKernelEvent({
      event: KernelEvent.CAMPAIGN_ROI_UPDATED,
      brokerageId,
      entityType: "marketing_campaign",
      entityId: marketingCampaignId,
    }).catch((err) => {
      console.error("[ROI Calculator] Event processing failed (non-blocking):", err)
    })

    return {
      success: true,
      roi: {
        total_spend: totalSpend,
        total_leads: totalLeads,
        qualified_leads: qualifiedLeads,
        total_conversions: totalConversions,
        total_revenue: totalRevenue,
        cost_per_lead: costPerLead,
        cost_per_qualified_lead: costPerQualifiedLead,
        cost_per_conversion: costPerConversion,
        roi_percentage: roiPercentage,
      },
    }
  } catch (error: any) {
    console.error("[ROI Calculator] recalculateCampaignROI error:", error)
    return { success: false, error: error.message }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. recalculateChannelPerformance — Aggregate by channel for date window
// ═══════════════════════════════════════════════════════════════════════════════

export async function recalculateChannelPerformance(
  brokerageId: string,
  windowStart: string, // YYYY-MM-DD
  windowEnd: string,   // YYYY-MM-DD
  useServiceClient = false
): Promise<{
  success: boolean
  error?: string
  channels?: Array<{
    channel_type: string
    spend: number
    leads: number
    conversions: number
    revenue: number
    roi_percentage: number | null
  }>
}> {
  try {
    const supabase = useServiceClient ? createServiceClient() : await createClient()

    const channelTypes = ["social", "newsletter", "direct_mail", "video", "ad", "podcast"]
    const results: Array<{
      channel_type: string
      spend: number
      leads: number
      conversions: number
      revenue: number
      roi_percentage: number | null
    }> = []

    for (const channelType of channelTypes) {
      let spend = 0
      let leads = 0
      let conversions = 0

      // ════════════════════════════════════════════════════════════════════════
      // Aggregate by channel type
      // ════════════════════════════════════════════════════════════════════════

      if (channelType === "social") {
        // NO SPEND SOURCE EXISTS: social_posts and social_engagement_tracking
        // carry no cost/spend/budget column (paid social lives on the `ad`
        // channel via ad_performance.spend). spend stays 0 → roi_percentage
        // stays null.
        const { data: engagement, error: engagementError } = await supabase
          .from("social_engagement_tracking")
          .select("clicks_count, leads_generated")
          .eq("brokerage_id", brokerageId)
          .gte("captured_at", windowStart)
          .lte("captured_at", windowEnd)

        if (engagementError) {
          console.error("[ROI Calculator] social_engagement_tracking read refused:", engagementError.message)
          return { success: false, error: `social_engagement_tracking read refused: ${engagementError.message}` }
        }
        for (const e of engagement ?? []) {
          leads += e.leads_generated ?? 0
        }
      }

      if (channelType === "ad") {
        const { data: adPerf } = await supabase
          .from("ad_performance")
          .select("spend, leads, conversions")
          .eq("brokerage_id", brokerageId)
          .gte("captured_at", windowStart)
          .lte("captured_at", windowEnd)

        if (adPerf) {
          for (const p of adPerf) {
            spend += p.spend ?? 0
            leads += p.leads ?? 0
            conversions += p.conversions ?? 0
          }
        }
      }

      if (channelType === "direct_mail") {
        // Same unscoped SHAPE as the campaign arm above, at a different
        // altitude. Here brokerage-wide IS the right denominator — this is a
        // CHANNEL rollup, not a campaign one — so the fix is not a campaign
        // predicate. It is the other two halves the campaign arm was missing:
        //   (a) ANCHOR ACROSS THE JOIN. A response row is counted only when its
        //       campaign_id resolves to a direct_mail_campaigns row owned by
        //       THIS brokerage, so a mis-stamped or cross-tenant
        //       mail_response_tracking.brokerage_id cannot inflate the channel.
        //   (b) READ THE ERRORS. Both reads used to discard theirs, and a
        //       refused read is byte-identical to a real zero — the channel
        //       would have reported "0 direct-mail leads" as a fact.
        // Blind spot published beside the number (§2): responses whose
        // campaign_id names no campaign of this brokerage are EXCLUDED and
        // counted. Both live writers (app/actions/direct-mail.ts:652,
        // app/api/qr/scan/route.ts:170) always stamp a real campaign_id, so
        // this count is expected to be 0 — a non-zero one is a finding.
        //
        // THE MISSING SPEND HALF (built 2026-09-01). Only the `ad` channel ever
        // accumulated spend, so direct_mail — like four other channels — always
        // computed `roi_percentage: null`: an ROI dashboard that structurally
        // could not show ROI. Direct mail is the one channel whose cost IS
        // recorded today, on the campaign row itself:
        //     spend = Σ per_piece_cost × pieces_mailed
        // DERIVED, never stored a second time (§6) — channel_performance.spend
        // is a rollup of the campaign rows, not a rival ledger.
        // A NULL per_piece_cost or pieces_mailed is "SPEND NOT RECORDED", NOT
        // zero: a zero denominator would mint an infinite or fabricated ROI out
        // of a campaign nobody costed. Those campaigns are excluded from spend
        // and COUNTED, and the count is published beside the number — a spend
        // that covers only part of the channel overstates its ROI, and the
        // reader has to be told which case they are looking at.
        // Placed in the window by `mailing_date` (when the money was spent);
        // a campaign with no mailing_date cannot be placed and is counted too.
        const { data: mailCampaigns, error: mailCampaignsError } = await supabase
          .from("direct_mail_campaigns")
          .select("id, per_piece_cost, pieces_mailed, mailing_date")
          .eq("brokerage_id", brokerageId)

        if (mailCampaignsError) {
          // FAIL CLOSED (§4): refuse rather than upsert a channel row derived
          // from an unanchored count. Channels already written this pass are
          // independent rows and stay correct.
          console.error(
            "[ROI Calculator] direct_mail campaign resolve refused:",
            mailCampaignsError.message
          )
          return {
            success: false,
            error: `direct_mail campaign resolve refused: ${mailCampaignsError.message}`,
          }
        }

        const ownedMailCampaigns = mailCampaigns ?? []
        const ownedMailCampaignIds = new Set(ownedMailCampaigns.map((c) => c.id as string))

        // ── DERIVE THE SPEND ────────────────────────────────────────────────
        let costedCampaigns = 0
        let uncostedInWindow = 0
        let undatedCampaigns = 0
        for (const c of ownedMailCampaigns) {
          const mailingDate = c.mailing_date as string | null
          if (!mailingDate) { undatedCampaigns++; continue }
          if (mailingDate < windowStart || mailingDate > windowEnd) continue
          const perPiece = c.per_piece_cost == null ? null : Number(c.per_piece_cost)
          const pieces = c.pieces_mailed == null ? null : Number(c.pieces_mailed)
          if (perPiece == null || pieces == null || !Number.isFinite(perPiece) || !Number.isFinite(pieces)) {
            uncostedInWindow++ // spend NOT RECORDED — never counted as 0
            continue
          }
          spend += perPiece * pieces
          costedCampaigns++
        }
        if (uncostedInWindow > 0 || undatedCampaigns > 0) {
          console.warn(
            `[ROI Calculator] direct_mail channel spend ${windowStart}..${windowEnd}: derived from ${costedCampaigns} campaign(s); ` +
            `${uncostedInWindow} in-window campaign(s) record no per_piece_cost/pieces_mailed (spend NOT RECORDED, excluded — not counted as $0), ` +
            `${undatedCampaigns} campaign(s) carry no mailing_date and could not be placed in the window. ` +
            `roi_percentage below is therefore computed over PARTIAL spend and overstates ROI for this channel.`
          )
        }

        const { data: mailResponses, error: mailResponsesError } = await supabase
          .from("mail_response_tracking")
          .select("response_type, campaign_id")
          .eq("brokerage_id", brokerageId)
          .gte("created_at", windowStart)
          .lte("created_at", windowEnd)

        if (mailResponsesError) {
          console.error(
            "[ROI Calculator] mail_response_tracking read refused:",
            mailResponsesError.message
          )
          return {
            success: false,
            error: `mail_response_tracking read refused: ${mailResponsesError.message}`,
          }
        }

        const rows = mailResponses ?? []
        const owned = rows.filter(
          (r) => r.campaign_id != null && ownedMailCampaignIds.has(r.campaign_id as string)
        )
        const orphaned = rows.length - owned.length
        if (orphaned > 0) {
          console.warn(
            `[ROI Calculator] direct_mail channel: ${orphaned} of ${rows.length} response rows in ${windowStart}..${windowEnd} name no direct_mail_campaigns row of brokerage ${brokerageId} — EXCLUDED from the channel count.`
          )
        }

        leads += owned.length
        conversions += owned.filter((r) =>
          ["call", "form_submit", "appointment"].includes(r.response_type)
        ).length
      }

      if (channelType === "newsletter") {
        // THIS READ HAD NO TENANT PREDICATE AT ALL — not a campaign one, a
        // BROKERAGE one. Every other brokerage's scheduled sends were counted
        // into this brokerage's newsletter channel. The column exists
        // (schema-snapshot :441); it simply went unused. Fixed 2026-09-01.
        // NO SPEND SOURCE EXISTS for this channel: neither newsletter_campaigns
        // nor newsletter_scheduled_sends carries a cost/spend/budget column, so
        // spend stays 0 and roi_percentage stays null — honestly unknown, not
        // zero-cost. Building it needs a cost column, which is a migration.
        const { data: sends, error: sendsError } = await supabase
          .from("newsletter_scheduled_sends")
          .select("recipient_count")
          .eq("brokerage_id", brokerageId)
          .gte("scheduled_time", windowStart)
          .lte("scheduled_time", windowEnd)

        if (sendsError) {
          console.error("[ROI Calculator] newsletter_scheduled_sends read refused:", sendsError.message)
          return {
            success: false,
            error: `newsletter_scheduled_sends read refused: ${sendsError.message}`,
          }
        }

        for (const s of sends ?? []) {
          leads += Math.floor((s.recipient_count ?? 0) * NEWSLETTER_LEAD_RATE)
        }
      }

      if (channelType === "podcast") {
        // NO SPEND SOURCE EXISTS: podcast_analytics_events and podcast_episodes
        // carry no cost/spend/budget column. spend stays 0 → roi_percentage
        // stays null. Unknown, not free.
        const { data: events, error: eventsError } = await supabase
          .from("podcast_analytics_events")
          .select("id")
          .eq("brokerage_id", brokerageId)
          .eq("event_type", "cta_click")
          .gte("created_at", windowStart)
          .lte("created_at", windowEnd)

        if (eventsError) {
          console.error("[ROI Calculator] podcast_analytics_events read refused:", eventsError.message)
          return { success: false, error: `podcast_analytics_events read refused: ${eventsError.message}` }
        }
        leads += (events ?? []).length
      }

      if (channelType === "video") {
        // NO SPEND SOURCE EXISTS: video_performance_tracking and
        // ai_video_projects carry no cost/spend/budget column. Note that
        // video_performance_tracking DOES carry `estimated_roi` — a second,
        // unrelated spelling of this channel's ROI that no writer in this file
        // feeds and that nothing here reads (§6). Left alone deliberately:
        // reconciling the two belongs to whoever owns that column, and guessing
        // which one is authoritative would be the worse defect.
        const { data: videoPerf, error: videoPerfError } = await supabase
          .from("video_performance_tracking")
          .select("lead_conversions")
          .eq("brokerage_id", brokerageId)
          .gte("created_at", windowStart)
          .lte("created_at", windowEnd)

        if (videoPerfError) {
          console.error("[ROI Calculator] video_performance_tracking read refused:", videoPerfError.message)
          return { success: false, error: `video_performance_tracking read refused: ${videoPerfError.message}` }
        }
        for (const v of videoPerf ?? []) {
          leads += v.lead_conversions ?? 0
        }
      }

      // Calculate revenue and ROI.
      // `spend > 0 ? … : null` is the honest half that was already here: a
      // channel whose cost is not recorded reports roi_percentage NULL, never a
      // number. Of the six channels only `ad` (ad_performance.spend) and now
      // `direct_mail` (per_piece_cost × pieces_mailed) have a spend source in
      // the live schema at all — social, newsletter, podcast and video have no
      // cost column on any table this rollup reads, so their ROI stays null by
      // construction until one is added. That is a MISSING LEDGER, not a bug in
      // this file.
      const revenue = conversions * DEFAULT_AVG_COMMISSION
      const roiPercentage = spend > 0 ? ((revenue - spend) / spend) * 100 : null

      results.push({
        channel_type: channelType,
        spend,
        leads,
        conversions,
        revenue,
        roi_percentage: roiPercentage,
      })

      // ════════════════════════════════════════════════════════════════════════
      // UPSERT to channel_performance
      // (ON CONFLICT brokerage_id, channel_type, window_start, window_end)
      // ════════════════════════════════════════════════════════════════════════
      await supabase.from("channel_performance").upsert(
        {
          brokerage_id: brokerageId,
          channel_type: channelType,
          window_start: windowStart,
          window_end: windowEnd,
          spend,
          leads,
          conversions,
          revenue,
          roi_percentage: roiPercentage,
          calculated_at: new Date().toISOString(),
        },
        {
          onConflict: "brokerage_id,channel_type,window_start,window_end",
        }
      )
    }

    return { success: true, channels: results }
  } catch (error: any) {
    console.error("[ROI Calculator] recalculateChannelPerformance error:", error)
    return { success: false, error: error.message }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. getCampaignROIData — Read aggregated ROI data for dashboard
// ═══════════════════════════════════════════════════════════════════════════════

export async function getCampaignROIData(
  brokerageId: string,
  userId: string,
  filters?: {
    campaignType?: string
    status?: string
    agentUserId?: string
    dateFrom?: string
    dateTo?: string
  }
): Promise<{
  success: boolean
  error?: string
  campaigns?: any[]
  summary?: {
    total_spend: number
    total_leads: number
    total_conversions: number
    avg_roi_percentage: number | null
    best_channel: string | null
  }
}> {
  try {
    // ══════════════════════════════════════════════════════════════════════════
    // Kernel gate: canAccessFeature
    // ══════════════════════════════════════════════════════════════════════════
    const access = await canAccessFeature(userId, "campaign_roi_dashboard")
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Feature not available" }
    }

    const supabase = await createClient()

    // Build query for campaign_roi with marketing_campaigns join
    let query = supabase
      .from("campaign_roi")
      .select(`
        *,
        marketing_campaigns (
          id,
          campaign_name,
          campaign_type,
          status,
          agent_user_id,
          created_at
        )
      `)
      .eq("brokerage_id", brokerageId)
      .order("roi_percentage", { ascending: false, nullsFirst: false })

    // Apply filters via joined table
    if (filters?.campaignType) {
      query = query.eq("marketing_campaigns.campaign_type", filters.campaignType)
    }
    if (filters?.status) {
      query = query.eq("marketing_campaigns.status", filters.status)
    }
    if (filters?.agentUserId) {
      query = query.eq("marketing_campaigns.agent_user_id", filters.agentUserId)
    }

    const { data: campaigns, error: queryError } = await query

    if (queryError) {
      return { success: false, error: queryError.message }
    }

    // Calculate summary metrics
    let totalSpend = 0
    let totalLeads = 0
    let totalConversions = 0
    let roiSum = 0
    let roiCount = 0

    for (const c of campaigns || []) {
      totalSpend += c.total_spend ?? 0
      totalLeads += c.total_leads ?? 0
      totalConversions += c.total_conversions ?? 0
      if (c.roi_percentage !== null) {
        roiSum += c.roi_percentage
        roiCount++
      }
    }

    const avgRoiPercentage = roiCount > 0 ? roiSum / roiCount : null

    // Get best performing channel
    const { data: channelPerf } = await supabase
      .from("channel_performance")
      .select("channel_type, roi_percentage")
      .eq("brokerage_id", brokerageId)
      .order("roi_percentage", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle()

    const bestChannel = channelPerf?.channel_type ?? null

    return {
      success: true,
      campaigns: campaigns || [],
      summary: {
        total_spend: totalSpend,
        total_leads: totalLeads,
        total_conversions: totalConversions,
        avg_roi_percentage: avgRoiPercentage,
        best_channel: bestChannel,
      },
    }
  } catch (error: any) {
    console.error("[ROI Calculator] getCampaignROIData error:", error)
    return { success: false, error: error.message }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. getChannelPerformanceData — Get channel comparison data
// ═══════════════════════════════════════════════════════════════════════════════

export async function getChannelPerformanceData(
  brokerageId: string,
  userId: string,
  windowStart?: string,
  windowEnd?: string
): Promise<{
  success: boolean
  error?: string
  channels?: any[]
}> {
  try {
    // Kernel gate
    const access = await canAccessFeature(userId, "campaign_roi_dashboard")
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Feature not available" }
    }

    const supabase = await createClient()

    let query = supabase
      .from("channel_performance")
      .select("*")
      .eq("brokerage_id", brokerageId)
      .order("roi_percentage", { ascending: false, nullsFirst: false })

    if (windowStart) {
      query = query.gte("window_start", windowStart)
    }
    if (windowEnd) {
      query = query.lte("window_end", windowEnd)
    }

    const { data: channels, error: queryError } = await query

    if (queryError) {
      return { success: false, error: queryError.message }
    }

    return { success: true, channels: channels || [] }
  } catch (error: any) {
    console.error("[ROI Calculator] getChannelPerformanceData error:", error)
    return { success: false, error: error.message }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. getTopCampaigns — Get leaderboard of top 5 campaigns by ROI
// ═══════════════════════════════════════════════════════════════════════════════

export async function getTopCampaigns(
  brokerageId: string,
  userId: string,
  limit = 5
): Promise<{
  success: boolean
  error?: string
  campaigns?: any[]
}> {
  try {
    const access = await canAccessFeature(userId, "campaign_roi_dashboard")
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Feature not available" }
    }

    const supabase = await createClient()

    const { data: campaigns, error: queryError } = await supabase
      .from("campaign_roi")
      .select(`
        *,
        marketing_campaigns (
          campaign_name,
          campaign_type
        )
      `)
      .eq("brokerage_id", brokerageId)
      .not("roi_percentage", "is", null)
      .gt("roi_percentage", 0)
      .order("roi_percentage", { ascending: false })
      .limit(limit)

    if (queryError) {
      return { success: false, error: queryError.message }
    }

    return { success: true, campaigns: campaigns || [] }
  } catch (error: any) {
    console.error("[ROI Calculator] getTopCampaigns error:", error)
    return { success: false, error: error.message }
  }
}
