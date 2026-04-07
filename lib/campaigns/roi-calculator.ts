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
      // Get social posts linked to this campaign
      const { data: socialPosts } = await supabase
        .from("social_posts")
        .select("id")
        .eq("brokerage_id", brokerageId)
        .not("kernel_event_id", "is", null)

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
      // Count responses that indicate conversion
      const { data: mailResponses } = await supabase
        .from("mail_response_tracking")
        .select("response_type")
        .eq("brokerage_id", brokerageId)

      if (mailResponses) {
        for (const r of mailResponses) {
          totalLeads++
          if (["call", "form_submit", "appointment"].includes(r.response_type)) {
            totalConversions++
          }
        }
      }
    }

    // === NEWSLETTER campaigns ===
    if (campaignType === "newsletter") {
      // Get newsletter sends for this campaign
      const { data: newsletters } = await supabase
        .from("newsletter_campaigns")
        .select("id")
        .eq("brokerage_id", brokerageId)

      if (newsletters && newsletters.length > 0) {
        const newsletterIds = newsletters.map((n) => n.id)

        const { data: sends } = await supabase
          .from("newsletter_scheduled_sends")
          .select("recipient_count")
          .in("newsletter_id", newsletterIds)

        if (sends) {
          for (const s of sends) {
            totalLeads += Math.floor((s.recipient_count ?? 0) * 0.02) // Estimate 2% lead rate
          }
        }
      }
    }

    // === PODCAST campaigns ===
    if (campaignType === "podcast") {
      // Count CTA clicks from podcast analytics
      const { data: podcastClicks } = await supabase
        .from("podcast_analytics_events")
        .select("id")
        .eq("brokerage_id", brokerageId)
        .eq("event_type", "cta_click")

      if (podcastClicks) {
        totalLeads += podcastClicks.length
      }
    }

    // === VIDEO campaigns ===
    if (campaignType === "video") {
      const { data: videoPerf } = await supabase
        .from("video_performance_tracking")
        .select("lead_conversions, unique_views")
        .eq("brokerage_id", brokerageId)

      if (videoPerf) {
        for (const v of videoPerf) {
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
        const { data: engagement } = await supabase
          .from("social_engagement_tracking")
          .select("clicks_count, leads_generated")
          .eq("brokerage_id", brokerageId)
          .gte("captured_at", windowStart)
          .lte("captured_at", windowEnd)

        if (engagement) {
          for (const e of engagement) {
            leads += e.leads_generated ?? 0
          }
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
        const { data: mailResponses } = await supabase
          .from("mail_response_tracking")
          .select("response_type")
          .eq("brokerage_id", brokerageId)
          .gte("created_at", windowStart)
          .lte("created_at", windowEnd)

        if (mailResponses) {
          leads += mailResponses.length
          conversions += mailResponses.filter((r) =>
            ["call", "form_submit", "appointment"].includes(r.response_type)
          ).length
        }
      }

      if (channelType === "newsletter") {
        const { data: sends } = await supabase
          .from("newsletter_scheduled_sends")
          .select("recipient_count")
          .gte("scheduled_time", windowStart)
          .lte("scheduled_time", windowEnd)

        if (sends) {
          for (const s of sends) {
            leads += Math.floor((s.recipient_count ?? 0) * 0.02)
          }
        }
      }

      if (channelType === "podcast") {
        const { data: events } = await supabase
          .from("podcast_analytics_events")
          .select("id")
          .eq("brokerage_id", brokerageId)
          .eq("event_type", "cta_click")
          .gte("created_at", windowStart)
          .lte("created_at", windowEnd)

        if (events) {
          leads += events.length
        }
      }

      if (channelType === "video") {
        const { data: videoPerf } = await supabase
          .from("video_performance_tracking")
          .select("lead_conversions")
          .eq("brokerage_id", brokerageId)
          .gte("created_at", windowStart)
          .lte("created_at", windowEnd)

        if (videoPerf) {
          for (const v of videoPerf) {
            leads += v.lead_conversions ?? 0
          }
        }
      }

      // Calculate revenue and ROI
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
