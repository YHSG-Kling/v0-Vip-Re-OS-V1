"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { generateTextRouted } from "@/lib/ai/models"
import { getAgentContext } from "@/lib/identity/get-agent-context"

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MarketingCampaign {
  id: string
  campaign_name: string
  campaign_type: string
  status: string
  budget_total: number | null
  budget_spent: number | null
  scheduled_start_at: string | null
  scheduled_end_at: string | null
  launched_at: string | null
  completed_at: string | null
  target_audience: Record<string, unknown> | null
  agent_user_id: string | null
  brokerage_id: string
  listing_id: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  visibility_scope: string | null
}

export interface CampaignWithROI extends MarketingCampaign {
  roi?: {
    total_spend: number
    total_leads: number
    qualified_leads: number
    total_conversions: number
    total_revenue: number
    cost_per_lead: number | null
    roi_percentage: number | null
  }
  ad_campaigns_count?: number
  newsletter_campaigns_count?: number
  social_posts_count?: number
}

// ─── List Campaigns ───────────────────────────────────────────────────────────

export async function listMarketingCampaigns(params: {
  /** ignored — derived from session */
  brokerageId?: string | undefined
  agentUserId?: string
  status?: string
  campaignType?: string
  limit?: number
  offset?: number
}): Promise<{ success: boolean; campaigns: CampaignWithROI[]; total: number; error?: string }> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, campaigns: [], total: 0, error: "Unauthorized" }
    }
    const brokerageId = ctx.brokerageId

    const supabase = await createClient()

    let query = supabase
      .from("marketing_campaigns")
      .select("*", { count: "exact" })
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false })

    if (params.agentUserId) {
      query = query.eq("agent_user_id", params.agentUserId)
    }
    if (params.status && params.status !== "all") {
      query = query.eq("status", params.status)
    }
    if (params.campaignType && params.campaignType !== "all") {
      query = query.eq("campaign_type", params.campaignType)
    }
    if (params.limit) {
      query = query.limit(params.limit)
    }
    if (params.offset) {
      query = query.range(params.offset, params.offset + (params.limit ?? 20) - 1)
    }

    const { data: campaigns, count, error } = await query

    if (error) throw error

    // Fetch ROI data for campaigns
    const campaignIds = (campaigns ?? []).map((c) => c.id)
    const roiMap: Record<string, any> = {}

    if (campaignIds.length > 0) {
      const { data: roiRows } = await supabase
        .from("campaign_roi")
        .select("*")
        .in("marketing_campaign_id", campaignIds)
        .order("calculated_at", { ascending: false })

      for (const row of roiRows ?? []) {
        if (!roiMap[row.marketing_campaign_id]) {
          roiMap[row.marketing_campaign_id] = {
            total_spend: row.total_spend ?? 0,
            total_leads: row.total_leads ?? 0,
            qualified_leads: row.qualified_leads ?? 0,
            total_conversions: row.total_conversions ?? 0,
            total_revenue: row.total_revenue ?? 0,
            cost_per_lead: row.cost_per_lead ?? null,
            roi_percentage: row.roi_percentage ?? null,
          }
        }
      }
    }

    const result: CampaignWithROI[] = (campaigns ?? []).map((c) => ({
      ...c,
      roi: roiMap[c.id],
    }))

    return { success: true, campaigns: result, total: count ?? 0 }
  } catch (err) {
    console.error("[marketing-campaigns] listMarketingCampaigns:", err)
    return { success: false, campaigns: [], total: 0, error: "Failed to load campaigns" }
  }
}

// ─── Get Single Campaign ──────────────────────────────────────────────────────

export async function getMarketingCampaign(campaignId: string): Promise<{
  success: boolean
  campaign?: CampaignWithROI & {
    ad_campaigns: any[]
    newsletter_campaigns: any[]
    social_posts: any[]
    direct_mail_campaigns: any[]
    tasks: any[]
    calendar_events: any[]
  }
  error?: string
}> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    const brokerageId = ctx.brokerageId

    const supabase = await createClient()

    const { data: campaign, error } = await supabase
      .from("marketing_campaigns")
      .select("*")
      .eq("id", campaignId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()

    if (error || !campaign) return { success: false, error: "Campaign not found" }

    // Fetch all related channel data in parallel
    const [
      { data: adCampaigns },
      { data: newsletterCampaigns },
      { data: socialPosts },
      { data: directMailCampaigns },
      { data: tasks },
      { data: calendarEvents },
      { data: roi },
    ] = await Promise.all([
      supabase
        .from("ad_campaigns")
        .select("*")
        .eq("marketing_campaign_id", campaignId)
        .order("created_at", { ascending: false }),
      supabase
        .from("newsletter_campaigns")
        .select("id, campaign_name, status, subject_line, open_rate, click_rate, send_date, created_at")
        .eq("brokerage_id", campaign.brokerage_id)
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("social_posts")
        .select("id, content, platform, status, scheduled_for, published_at")
        .eq("brokerage_id", campaign.brokerage_id)
        .order("created_at", { ascending: false })
        .limit(10),
      supabase
        .from("direct_mail_campaigns")
        .select("id, campaign_name, status, quantity, mailing_date, created_at")
        .eq("brokerage_id", campaign.brokerage_id)
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("marketing_campaign_tasks")
        .select("*")
        .eq("campaign_id", campaignId)
        .order("due_at", { ascending: true }),
      supabase
        .from("campaign_calendar")
        .select("*")
        .eq("campaign_id", campaignId)
        .order("scheduled_at", { ascending: true }),
      supabase
        .from("campaign_roi")
        .select("*")
        .eq("marketing_campaign_id", campaignId)
        .order("calculated_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])

    return {
      success: true,
      campaign: {
        ...campaign,
        roi: roi
          ? {
              total_spend: roi.total_spend ?? 0,
              total_leads: roi.total_leads ?? 0,
              qualified_leads: roi.qualified_leads ?? 0,
              total_conversions: roi.total_conversions ?? 0,
              total_revenue: roi.total_revenue ?? 0,
              cost_per_lead: roi.cost_per_lead ?? null,
              roi_percentage: roi.roi_percentage ?? null,
            }
          : undefined,
        ad_campaigns: adCampaigns ?? [],
        newsletter_campaigns: newsletterCampaigns ?? [],
        social_posts: socialPosts ?? [],
        direct_mail_campaigns: directMailCampaigns ?? [],
        tasks: tasks ?? [],
        calendar_events: calendarEvents ?? [],
      },
    }
  } catch (err) {
    console.error("[marketing-campaigns] getMarketingCampaign:", err)
    return { success: false, error: "Failed to load campaign" }
  }
}

// ─── Create Campaign ──────────────────────────────────────────────────────────

export async function createMarketingCampaign(params: {
  /** ignored — derived from session */
  brokerageId?: string | undefined
  campaignName: string
  campaignType: string
  budgetTotal?: number
  targetAudience?: Record<string, unknown>
  scheduledStartAt?: string
  scheduledEndAt?: string
  listingId?: string
  visibilityScope?: string
}): Promise<{ success: boolean; campaignId?: string; error?: string }> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    const brokerageId = ctx.brokerageId

    const supabase = await createClient()

    const { data: campaign, error } = await supabase
      .from("marketing_campaigns")
      .insert({
        brokerage_id: brokerageId,
        campaign_name: params.campaignName,
        campaign_type: params.campaignType,
        status: "draft",
        budget_total: params.budgetTotal ?? null,
        budget_spent: 0,
        target_audience: params.targetAudience ?? null,
        scheduled_start_at: params.scheduledStartAt ?? null,
        scheduled_end_at: params.scheduledEndAt ?? null,
        listing_id: params.listingId ?? null,
        agent_user_id: ctx.userId,
        created_by: ctx.userId,
        visibility_scope: params.visibilityScope ?? "brokerage",
      })
      .select("id")
      .maybeSingle()

    if (error || !campaign) {
      console.error("[marketing-campaigns] createMarketingCampaign insert:", error)
      return { success: false, error: "Failed to create campaign" }
    }

    // Emit kernel event
    processKernelEvent({
      event: KernelEvent.MARKETING_CAMPAIGN_CREATED,
      brokerageId,
      entityType: "marketing_campaign",
      entityId: campaign.id,
    }).catch((e) => console.error("[kernel] MARKETING_CAMPAIGN_CREATED:", e))

    revalidatePath("/dashboard/campaigns")
    return { success: true, campaignId: campaign.id }
  } catch (err) {
    console.error("[marketing-campaigns] createMarketingCampaign:", err)
    return { success: false, error: "Failed to create campaign" }
  }
}

// ─── Update Campaign ──────────────────────────────────────────────────────────

export async function updateMarketingCampaign(
  campaignId: string,
  updates: {
    campaignName?: string
    campaignType?: string
    status?: string
    budgetTotal?: number
    budgetSpent?: number
    targetAudience?: Record<string, unknown>
    scheduledStartAt?: string | null
    scheduledEndAt?: string | null
    listingId?: string | null
  }
): Promise<{ success: boolean; error?: string }> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    const brokerageId = ctx.brokerageId

    const supabase = await createClient()

    // Verify ownership before mutating
    const { data: existing } = await supabase
      .from("marketing_campaigns")
      .select("id")
      .eq("id", campaignId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    if (!existing) return { success: false, error: "Campaign not found" }

    const updatePayload: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    }
    if (updates.campaignName !== undefined) updatePayload.campaign_name = updates.campaignName
    if (updates.campaignType !== undefined) updatePayload.campaign_type = updates.campaignType
    if (updates.status !== undefined) updatePayload.status = updates.status
    if (updates.budgetTotal !== undefined) updatePayload.budget_total = updates.budgetTotal
    if (updates.budgetSpent !== undefined) updatePayload.budget_spent = updates.budgetSpent
    if (updates.targetAudience !== undefined) updatePayload.target_audience = updates.targetAudience
    if (updates.scheduledStartAt !== undefined) updatePayload.scheduled_start_at = updates.scheduledStartAt
    if (updates.scheduledEndAt !== undefined) updatePayload.scheduled_end_at = updates.scheduledEndAt
    if (updates.listingId !== undefined) updatePayload.listing_id = updates.listingId

    const { error } = await supabase
      .from("marketing_campaigns")
      .update(updatePayload)
      .eq("id", campaignId)
      .eq("brokerage_id", brokerageId)

    if (error) throw error

    revalidatePath("/dashboard/campaigns")
    return { success: true }
  } catch (err) {
    console.error("[marketing-campaigns] updateMarketingCampaign:", err)
    return { success: false, error: "Failed to update campaign" }
  }
}

// ─── Launch Campaign ──────────────────────────────────────────────────────────

export async function launchMarketingCampaign(
  campaignId: string,
  /** ignored — derived from session */
  _brokerageId?: string | undefined
): Promise<{ success: boolean; error?: string }> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    const brokerageId = ctx.brokerageId

    const supabase = await createClient()

    // Verify campaign exists in this brokerage and is in a launchable state
    const { data: campaign, error: fetchError } = await supabase
      .from("marketing_campaigns")
      .select("id, status, brokerage_id")
      .eq("id", campaignId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()

    if (fetchError || !campaign) return { success: false, error: "Campaign not found" }
    if (campaign.status === "launched" || campaign.status === "active") {
      return { success: false, error: "Campaign is already launched" }
    }

    const { error } = await supabase
      .from("marketing_campaigns")
      .update({
        status: "active",
        launched_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", campaignId)
      .eq("brokerage_id", brokerageId)

    if (error) throw error

    processKernelEvent({
      event: KernelEvent.MARKETING_CAMPAIGN_LAUNCHED,
      brokerageId,
      entityType: "marketing_campaign",
      entityId: campaignId,
    }).catch((e) => console.error("[kernel] MARKETING_CAMPAIGN_LAUNCHED:", e))

    revalidatePath("/dashboard/campaigns")
    return { success: true }
  } catch (err) {
    console.error("[marketing-campaigns] launchMarketingCampaign:", err)
    return { success: false, error: "Failed to launch campaign" }
  }
}

// ─── Pause Campaign ───────────────────────────────────────────────────────────

export async function pauseMarketingCampaign(
  campaignId: string,
  /** ignored — derived from session */
  _brokerageId?: string | undefined
): Promise<{ success: boolean; error?: string }> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    const brokerageId = ctx.brokerageId

    const supabase = await createClient()

    // Verify campaign belongs to caller's brokerage before mutating
    const { data: existing } = await supabase
      .from("marketing_campaigns")
      .select("id")
      .eq("id", campaignId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    if (!existing) return { success: false, error: "Campaign not found" }

    const { error } = await supabase
      .from("marketing_campaigns")
      .update({ status: "paused", updated_at: new Date().toISOString() })
      .eq("id", campaignId)
      .eq("brokerage_id", brokerageId)

    if (error) throw error

    processKernelEvent({
      event: KernelEvent.MARKETING_CAMPAIGN_PAUSED,
      brokerageId,
      entityType: "marketing_campaign",
      entityId: campaignId,
    }).catch((e) => console.error("[kernel] MARKETING_CAMPAIGN_PAUSED:", e))

    revalidatePath("/dashboard/campaigns")
    return { success: true }
  } catch (err) {
    console.error("[marketing-campaigns] pauseMarketingCampaign:", err)
    return { success: false, error: "Failed to pause campaign" }
  }
}

// ─── Archive / End Campaign ───────────────────────────────────────────────────

export async function endMarketingCampaign(
  campaignId: string,
  /** ignored — derived from session */
  _brokerageId?: string | undefined
): Promise<{ success: boolean; error?: string }> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    const brokerageId = ctx.brokerageId

    const supabase = await createClient()

    // Verify campaign belongs to caller's brokerage before mutating
    const { data: existing } = await supabase
      .from("marketing_campaigns")
      .select("id")
      .eq("id", campaignId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    if (!existing) return { success: false, error: "Campaign not found" }

    const { error } = await supabase
      .from("marketing_campaigns")
      .update({
        status: "ended",
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", campaignId)
      .eq("brokerage_id", brokerageId)

    if (error) throw error

    processKernelEvent({
      event: KernelEvent.MARKETING_CAMPAIGN_ENDED,
      brokerageId,
      entityType: "marketing_campaign",
      entityId: campaignId,
    }).catch((e) => console.error("[kernel] MARKETING_CAMPAIGN_ENDED:", e))

    revalidatePath("/dashboard/campaigns")
    return { success: true }
  } catch (err) {
    console.error("[marketing-campaigns] endMarketingCampaign:", err)
    return { success: false, error: "Failed to end campaign" }
  }
}

// ─── Delete Campaign (draft only) ─────────────────────────────────────────────

export async function deleteMarketingCampaign(
  campaignId: string,
  /** ignored — derived from session */
  _brokerageId?: string | undefined
): Promise<{ success: boolean; error?: string }> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    const brokerageId = ctx.brokerageId

    const supabase = await createClient()

    const { data: existing } = await supabase
      .from("marketing_campaigns")
      .select("status")
      .eq("id", campaignId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()

    if (!existing) return { success: false, error: "Campaign not found" }

    if (existing.status === "active") {
      return { success: false, error: "Cannot delete an active campaign. Pause it first." }
    }

    const { error } = await supabase
      .from("marketing_campaigns")
      .delete()
      .eq("id", campaignId)
      .eq("brokerage_id", brokerageId)

    if (error) throw error

    revalidatePath("/dashboard/campaigns")
    return { success: true }
  } catch (err) {
    console.error("[marketing-campaigns] deleteMarketingCampaign:", err)
    return { success: false, error: "Failed to delete campaign" }
  }
}

// ─── AI Campaign Name & Audience Suggestions ─────────────────────────────────

export async function aiSuggestCampaign(params: {
  /** ignored — derived from session */
  brokerageId?: string | undefined
  campaignType: string
  context?: string
}): Promise<{
  success: boolean
  suggestions?: { name: string; audience: string; description: string }[]
  error?: string
}> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    const brokerageId = ctx.brokerageId

    const { text } = await generateTextRouted({
      feature: "campaign_naming",
      brokerageId,
      userId: ctx.userId,
      system: `You are a real estate marketing expert. Generate campaign name and audience suggestions.
Return a JSON array of 3 objects with keys: name, audience, description.
Campaign type: ${params.campaignType}
Context: ${params.context ?? "general real estate marketing"}
Return ONLY the JSON array, no markdown fences.`,
      prompt: `Generate 3 marketing campaign suggestions for a real estate brokerage. Campaign type: ${params.campaignType}`,
      temperature: 0.8,
    })

    let suggestions: { name: string; audience: string; description: string }[] = []
    try {
      const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim()
      suggestions = JSON.parse(cleaned)
    } catch {
      suggestions = [
        {
          name: `${params.campaignType.charAt(0).toUpperCase() + params.campaignType.slice(1)} Campaign ${new Date().getMonth() + 1}/${new Date().getFullYear()}`,
          audience: "Active home buyers and sellers in your market",
          description: "Targeted campaign to generate qualified leads",
        },
      ]
    }

    return { success: true, suggestions }
  } catch (err) {
    console.error("[marketing-campaigns] aiSuggestCampaign:", err)
    return { success: false, error: "Failed to generate suggestions" }
  }
}

// ─── AI Copy Generation ───────────────────────────────────────────────────────

export async function aiGenerateCampaignCopy(params: {
  /** ignored — derived from session */
  brokerageId?: string | undefined
  campaignName: string
  campaignType: string
  targetAudience?: string
  channel: "email" | "social" | "ads" | "direct_mail"
}): Promise<{ success: boolean; copy?: string; subject?: string; error?: string }> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    const brokerageId = ctx.brokerageId

    const featureMap: Record<string, string> = {
      email: "email_generation",
      social: "social_post_generation",
      ads: "ad_copy_generation",
      direct_mail: "direct_mail_copy",
    }

    const { text } = await generateTextRouted({
      feature: featureMap[params.channel] ?? "email_generation",
      brokerageId,
      userId: ctx.userId,
      system: `You are a real estate marketing copywriter. Write compelling, compliant marketing copy.
Campaign: "${params.campaignName}"
Type: ${params.campaignType}
Target: ${params.targetAudience ?? "active buyers and sellers"}
Channel: ${params.channel}
Return a JSON object with keys: "subject" (for email/mail) and "copy" (the body/content).
Return ONLY the JSON, no markdown fences.`,
      prompt: `Write ${params.channel} marketing copy for campaign "${params.campaignName}".`,
      temperature: 0.7,
    })

    let result = { subject: "", copy: "" }
    try {
      const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim()
      result = JSON.parse(cleaned)
    } catch {
      result = { subject: `${params.campaignName}`, copy: text }
    }

    return { success: true, copy: result.copy, subject: result.subject }
  } catch (err) {
    console.error("[marketing-campaigns] aiGenerateCampaignCopy:", err)
    return { success: false, error: "Failed to generate copy" }
  }
}

// ─── Add Task to Campaign ─────────────────────────────────────────────────────

export async function addCampaignTask(params: {
  /** ignored — derived from session */
  brokerageId?: string | undefined
  campaignId: string
  title: string
  description?: string
  assignedUserId?: string
  dueAt?: string
}): Promise<{ success: boolean; taskId?: string; error?: string }> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    const brokerageId = ctx.brokerageId

    const supabase = await createClient()

    // Verify campaign belongs to this brokerage before attaching a task
    const { data: parent } = await supabase
      .from("marketing_campaigns")
      .select("id")
      .eq("id", params.campaignId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    if (!parent) return { success: false, error: "Campaign not found" }

    const { data: task, error } = await supabase
      .from("marketing_campaign_tasks")
      .insert({
        brokerage_id: brokerageId,
        campaign_id: params.campaignId,
        title: params.title,
        description: params.description ?? null,
        assigned_user_id: params.assignedUserId ?? null,
        due_at: params.dueAt ?? null,
        status: "pending",
      })
      .select("id")
      .maybeSingle()

    if (error || !task) throw error ?? new Error("Insert failed")

    revalidatePath("/dashboard/campaigns")
    return { success: true, taskId: task.id }
  } catch (err) {
    console.error("[marketing-campaigns] addCampaignTask:", err)
    return { success: false, error: "Failed to add task" }
  }
}

// ─── Update Campaign Task Status ──────────────────────────────────────────────

export async function updateCampaignTaskStatus(
  taskId: string,
  status: "pending" | "in_progress" | "done"
): Promise<{ success: boolean; error?: string }> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    const brokerageId = ctx.brokerageId

    const supabase = await createClient()

    // Verify task belongs to caller's brokerage
    const { data: existing } = await supabase
      .from("marketing_campaign_tasks")
      .select("id")
      .eq("id", taskId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    if (!existing) return { success: false, error: "Task not found" }

    const { error } = await supabase
      .from("marketing_campaign_tasks")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", taskId)
      .eq("brokerage_id", brokerageId)

    if (error) throw error

    revalidatePath("/dashboard/campaigns")
    return { success: true }
  } catch (err) {
    console.error("[marketing-campaigns] updateCampaignTaskStatus:", err)
    return { success: false, error: "Failed to update task" }
  }
}

// ─── Get Campaign Performance Summary ────────────────────────────────────────

export async function getCampaignPerformanceSummary(
  /** ignored — derived from session */
  _brokerageId?: string | undefined
): Promise<{
  success: boolean
  summary?: {
    total_campaigns: number
    active_campaigns: number
    total_spend: number
    total_leads: number
    total_conversions: number
    avg_roi: number | null
    top_channel: string | null
  }
  error?: string
}> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    const brokerageId = ctx.brokerageId

    const supabase = await createClient()

    const [
      { count: totalCampaigns },
      { count: activeCampaigns },
      { data: roiRows },
      { data: channelRows },
    ] = await Promise.all([
      supabase
        .from("marketing_campaigns")
        .select("*", { count: "exact", head: true })
        .eq("brokerage_id", brokerageId),
      supabase
        .from("marketing_campaigns")
        .select("*", { count: "exact", head: true })
        .eq("brokerage_id", brokerageId)
        .eq("status", "active"),
      supabase
        .from("campaign_roi")
        .select("total_spend, total_leads, total_conversions, roi_percentage")
        .eq("brokerage_id", brokerageId),
      supabase
        .from("channel_performance")
        .select("channel_type, roi_percentage")
        .eq("brokerage_id", brokerageId)
        .order("roi_percentage", { ascending: false })
        .limit(1),
    ])

    const totalSpend = (roiRows ?? []).reduce((s, r) => s + (r.total_spend ?? 0), 0)
    const totalLeads = (roiRows ?? []).reduce((s, r) => s + (r.total_leads ?? 0), 0)
    const totalConversions = (roiRows ?? []).reduce((s, r) => s + (r.total_conversions ?? 0), 0)
    const rois = (roiRows ?? []).filter((r) => r.roi_percentage != null).map((r) => r.roi_percentage!)
    const avgRoi = rois.length > 0 ? rois.reduce((a, b) => a + b, 0) / rois.length : null
    const topChannel = channelRows?.[0]?.channel_type ?? null

    return {
      success: true,
      summary: {
        total_campaigns: totalCampaigns ?? 0,
        active_campaigns: activeCampaigns ?? 0,
        total_spend: totalSpend,
        total_leads: totalLeads,
        total_conversions: totalConversions,
        avg_roi: avgRoi,
        top_channel: topChannel,
      },
    }
  } catch (err) {
    console.error("[marketing-campaigns] getCampaignPerformanceSummary:", err)
    return { success: false, error: "Failed to load summary" }
  }
}
