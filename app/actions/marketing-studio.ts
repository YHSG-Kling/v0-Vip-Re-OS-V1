"use server"

/**
 * app/actions/marketing-studio.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * LAYER 9.1 — Marketing Studio Dashboard Server Actions
 *
 * Provides CRUD operations for marketing campaigns, assets, calendar,
 * comments, and tasks. All actions enforce kernel compliance:
 * - canAccessFeature('marketing_studio') gate
 * - applyBrandVoice + evaluateOutbound for AI-generated content
 * - checkBrandCompliance for outbound assets
 * - transitionLifecycle for campaign status changes
 * - processKernelEvent for all creates and status transitions
 *
 * Tables accessed:
 * - Write: marketing_campaigns, marketing_assets, campaign_calendar,
 *          marketing_campaign_comments, marketing_campaign_tasks,
 *          marketing_asset_qr_links
 * - Read:  newsletter_campaigns, direct_mail_campaigns, social_posts,
 *          video_snippets, ai_video_projects, video_scripts_library,
 *          repurposed_content_log, qr_codes
 */

import { generateAIResponse } from "@/lib/ai/models"
import { runComplianceGate } from "@/lib/kernel/marketing/real-estate-compliance-gate"
import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import {
  canAccessFeature,
  incrementFeatureUsage,
  transitionLifecycle,
  processKernelEvent,
  KernelEvent,
  applyBrandVoice,
  evaluateOutbound,
  checkBrandCompliance,
} from "@/lib/kernel"
import type { ActorRole, Persona, MessageType } from "@/lib/kernel/types"
import { linkQrToAsset, unlinkQrFromAsset, getAssetQrLinks } from "@/lib/marketing/qr-asset-linker"
import { getCampaignRegistry, registerCampaignSource } from "@/lib/marketing/campaign-registry"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type CampaignStatus = "draft" | "pending_approval" | "approved" | "live" | "paused" | "ended"
export type AssetApprovalStatus = "pending" | "approved" | "rejected"
export type VisibilityScope = "agent" | "team" | "brokerage"

export interface CreateCampaignParams {
  campaignName: string
  campaignType: "listing" | "brand" | "recruitment" | "event" | "seasonal"
  listingId?: string
  targetAudience?: Record<string, unknown>
  budgetTotal?: number
  scheduledStartAt?: string
  scheduledEndAt?: string
  visibilityScope?: VisibilityScope
}

export interface UpdateCampaignParams {
  campaignId: string
  campaignName?: string
  targetAudience?: Record<string, unknown>
  budgetTotal?: number
  scheduledStartAt?: string
  scheduledEndAt?: string
}

export interface CreateAssetParams {
  campaignId?: string
  assetType: "video" | "image" | "document" | "social_post" | "email" | "direct_mail"
  assetName: string
  sourceTable?: string
  sourceId?: string
  assetUrl?: string
  thumbnailUrl?: string
  previewText?: string
  tags?: string[]
  visibilityScope?: VisibilityScope
}

export interface CreateCalendarEventParams {
  campaignId?: string
  eventType: "publish" | "review" | "deadline" | "meeting" | "go_live"
  channel?: string
  title: string
  scheduledAt: string
  relatedTable?: string
  relatedId?: string
  notes?: string
}

export interface CreateCommentParams {
  campaignId: string
  commentBody: string
}

export interface CreateTaskParams {
  campaignId: string
  title: string
  description?: string
  assignedUserId?: string
  dueAt?: string
}

// ─── FEATURE GATE HELPER ──────────────────────────────────────────────────────

async function assertMarketingStudioAccess(userId: string): Promise<void> {
  const access = await canAccessFeature(userId, "marketing_studio")
  if (!access.allowed) {
    throw new Error(access.reason ?? "Access to Marketing Studio denied")
  }
}

// ─── CAMPAIGN ACTIONS ─────────────────────────────────────────────────────────

export async function createCampaign(params: CreateCampaignParams) {
  const { userId, agentId, brokerageId } = await getAgentContext()
  await assertMarketingStudioAccess(userId)

  const supabase = await createClient()

  const { data: campaign, error } = await supabase
    .from("marketing_campaigns")
    .insert({
      brokerage_id: brokerageId,
      agent_user_id: agentId,
      created_by: userId,
      campaign_name: params.campaignName,
      campaign_type: params.campaignType,
      listing_id: params.listingId ?? null,
      target_audience: params.targetAudience ?? {},
      budget_total: params.budgetTotal ?? 0,
      budget_spent: 0,
      scheduled_start_at: params.scheduledStartAt ?? null,
      scheduled_end_at: params.scheduledEndAt ?? null,
      visibility_scope: params.visibilityScope ?? "agent",
      status: "draft",
    })
    .select("id, status")
    .single()

  if (error) {
    console.error("[v0] Error creating campaign:", error)
    return { success: false, error: error.message }
  }

  // Emit kernel event
  await processKernelEvent({
    event: KernelEvent.MARKETING_CAMPAIGN_CREATED,
    brokerageId,
    entityType: "marketing_campaign",
    entityId: campaign.id,
  }).catch((err) => console.error("[MarketingStudio] Kernel event failed:", err))

  await incrementFeatureUsage(userId, "marketing_studio")

  return { success: true, campaign }
}

export async function getCampaigns(filters?: {
  status?: CampaignStatus
  campaignType?: string
  listingId?: string
}) {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  // If no brokerageId, return empty campaigns
  if (!brokerageId) {
    return { success: true, campaigns: [] }
  }

  let query = supabase
    .from("marketing_campaigns")
    .select(`
      *,
      listing:listings(id, address, city, state, list_price),
      assets:marketing_assets(count),
      tasks:marketing_campaign_tasks(count)
    `)
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })

  // Visibility filter — agent sees own + team + brokerage level
  // Only apply agent filter if agentId is a valid UUID
  if (agentId) {
    query = query.or(`agent_user_id.eq.${agentId},visibility_scope.eq.brokerage`)
  } else {
    // If no agentId, only show brokerage-wide campaigns
    query = query.eq("visibility_scope", "brokerage")
  }

  if (filters?.status) {
    query = query.eq("status", filters.status)
  }
  if (filters?.campaignType) {
    query = query.eq("campaign_type", filters.campaignType)
  }
  if (filters?.listingId) {
    query = query.eq("listing_id", filters.listingId)
  }

  const { data: campaigns, error } = await query

  if (error) {
    console.error("[v0] Error fetching campaigns:", error)
    return { success: false, error: error.message, campaigns: [] }
  }

  return { success: true, campaigns: campaigns ?? [] }
}

export async function getCampaignById(campaignId: string) {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  const { data: campaign, error } = await supabase
    .from("marketing_campaigns")
    .select(`
      *,
      listing:listings(id, address, city, state, list_price, mls_number),
      assets:marketing_assets(*),
      tasks:marketing_campaign_tasks(*),
      comments:marketing_campaign_comments(*, author:users(id, first_name, last_name)),
      calendar_events:campaign_calendar(*)
    `)
    .eq("id", campaignId)
    .eq("brokerage_id", brokerageId)
    .single()

  if (error) {
    console.error("[v0] Error fetching campaign:", error)
    return { success: false, error: error.message }
  }

  return { success: true, campaign }
}

export async function updateCampaign(params: UpdateCampaignParams) {
  const { userId, brokerageId } = await getAgentContext()
  await assertMarketingStudioAccess(userId)

  const supabase = await createClient()

  const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (params.campaignName !== undefined) updateData.campaign_name = params.campaignName
  if (params.targetAudience !== undefined) updateData.target_audience = params.targetAudience
  if (params.budgetTotal !== undefined) updateData.budget_total = params.budgetTotal
  if (params.scheduledStartAt !== undefined) updateData.scheduled_start_at = params.scheduledStartAt
  if (params.scheduledEndAt !== undefined) updateData.scheduled_end_at = params.scheduledEndAt

  const { error } = await supabase
    .from("marketing_campaigns")
    .update(updateData)
    .eq("id", params.campaignId)
    .eq("brokerage_id", brokerageId)

  if (error) {
    console.error("[v0] Error updating campaign:", error)
    return { success: false, error: error.message }
  }

  return { success: true }
}

export async function transitionCampaignStatus(
  campaignId: string,
  toStatus: CampaignStatus
) {
  const { userId, brokerageId } = await getAgentContext()
  await assertMarketingStudioAccess(userId)

  const supabase = await createClient()

  // Get current status
  const { data: campaign, error: fetchError } = await supabase
    .from("marketing_campaigns")
    .select("id, status")
    .eq("id", campaignId)
    .eq("brokerage_id", brokerageId)
    .single()

  if (fetchError || !campaign) {
    return { success: false, error: "Campaign not found" }
  }

  const fromStatus = campaign.status

  // Use kernel lifecycle transition
  const result = await transitionLifecycle({
    brokerageId,
    entityType: "marketing_campaign_machine",
    entityId: campaignId,
    fromState: fromStatus,
    toState: toStatus,
    actorUserId: userId,
    eventType: `marketing_campaign_${toStatus}`,
    metadata: { from: fromStatus, to: toStatus },
  })

  if (!result.ok) {
    return { success: false, error: result.error }
  }

  // Update launched_at / completed_at timestamps
  const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (toStatus === "live") updateData.launched_at = new Date().toISOString()
  if (toStatus === "ended") updateData.completed_at = new Date().toISOString()

  await supabase
    .from("marketing_campaigns")
    .update(updateData)
    .eq("id", campaignId)

  return { success: true, activityId: result.activityId }
}

// ─── ASSET ACTIONS ────────────────────────────────────────────────────────────

export async function createAsset(params: CreateAssetParams) {
  const { userId, agentId, brokerageId } = await getAgentContext()
  await assertMarketingStudioAccess(userId)

  const supabase = await createClient()

  const { data: asset, error } = await supabase
    .from("marketing_assets")
    .insert({
      brokerage_id: brokerageId,
      agent_user_id: agentId,
      created_by: userId,
      campaign_id: params.campaignId ?? null,
      asset_type: params.assetType,
      asset_name: params.assetName,
      source_table: params.sourceTable ?? null,
      source_id: params.sourceId ?? null,
      asset_url: params.assetUrl ?? null,
      thumbnail_url: params.thumbnailUrl ?? null,
      preview_text: params.previewText ?? null,
      tags: params.tags ?? [],
      visibility_scope: params.visibilityScope ?? "agent",
      approval_status: "pending",
    })
    .select("id")
    .single()

  if (error) {
    console.error("[v0] Error creating asset:", error)
    return { success: false, error: error.message }
  }

  return { success: true, asset }
}

export async function getAssets(filters?: {
  campaignId?: string
  assetType?: string
  approvalStatus?: AssetApprovalStatus
}) {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  // If no brokerageId, return empty assets
  if (!brokerageId) {
    return { success: true, assets: [] }
  }

  let query = supabase
    .from("marketing_assets")
    .select("*, qr_links:marketing_asset_qr_links(id, qr_code_id, placement_type)")
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })

  // Only apply agent filter if agentId is a valid UUID
  if (agentId) {
    query = query.or(`agent_user_id.eq.${agentId},visibility_scope.eq.brokerage`)
  } else {
    query = query.eq("visibility_scope", "brokerage")
  }

  if (filters?.campaignId) {
    query = query.eq("campaign_id", filters.campaignId)
  }
  if (filters?.assetType) {
    query = query.eq("asset_type", filters.assetType)
  }
  if (filters?.approvalStatus) {
    query = query.eq("approval_status", filters.approvalStatus)
  }

  const { data: assets, error } = await query

  if (error) {
    console.error("[v0] Error fetching assets:", error)
    return { success: false, error: error.message, assets: [] }
  }

  return { success: true, assets: assets ?? [] }
}

export async function approveAsset(assetId: string) {
  const { userId, brokerageId } = await getAgentContext()
  await assertMarketingStudioAccess(userId)

  const supabase = await createClient()

  // Run brand compliance check before approval
  const complianceResult = await checkBrandCompliance({
    contentType: "listing_media",
    contentId: assetId,
    brokerageId,
  })

  if (!complianceResult.passed) {
    return {
      success: false,
      error: `Brand compliance failed: ${complianceResult.violations.join(", ")}`,
      violations: complianceResult.violations,
    }
  }

  // Also run real-estate compliance gate for ad/social assets
  const { data: asset } = await supabase
    .from("marketing_assets")
    .select("asset_type, content_text")
    .eq("id", assetId)
    .maybeSingle()

  if (asset?.content_text) {
    const contentType =
      asset.asset_type === "ad" ? "ad" : "social_post"
    const reGate = await runComplianceGate({
      content: asset.content_text,
      brokerageId,
      authorUserId: userId,
      contentType,
    })
    if (!reGate.passed) {
      const blockers = reGate.violations
        .filter((v) => v.severity === "blocker")
        .map((v) => v.detail)
      return {
        success: false,
        error: `Real-estate compliance failed: ${blockers.join("; ")}`,
        violations: blockers,
      }
    }
  }

  const { error } = await supabase
    .from("marketing_assets")
    .update({
      approval_status: "approved",
      updated_at: new Date().toISOString(),
    })
    .eq("id", assetId)
    .eq("brokerage_id", brokerageId)

  if (error) {
    console.error("[v0] Error approving asset:", error)
    return { success: false, error: error.message }
  }

  return { success: true }
}

export async function rejectAsset(assetId: string, reason?: string) {
  const { userId, brokerageId } = await getAgentContext()
  await assertMarketingStudioAccess(userId)

  const supabase = await createClient()

  const { error } = await supabase
    .from("marketing_assets")
    .update({
      approval_status: "rejected",
      metadata: { rejection_reason: reason ?? "Not specified" },
      updated_at: new Date().toISOString(),
    })
    .eq("id", assetId)
    .eq("brokerage_id", brokerageId)

  if (error) {
    console.error("[v0] Error rejecting asset:", error)
    return { success: false, error: error.message }
  }

  return { success: true }
}

// ─── QR LINKING (delegated to qr-asset-linker) ────────────────────────────────

export { linkQrToAsset, unlinkQrFromAsset, getAssetQrLinks }

// ─── CALENDAR ACTIONS ─────────────────────────────────────────────────────────

export async function createCalendarEvent(params: CreateCalendarEventParams) {
  const { userId, agentId, brokerageId } = await getAgentContext()
  await assertMarketingStudioAccess(userId)

  const supabase = await createClient()

  const { data: event, error } = await supabase
    .from("campaign_calendar")
    .insert({
      brokerage_id: brokerageId,
      agent_user_id: agentId,
      campaign_id: params.campaignId ?? null,
      event_type: params.eventType,
      channel: params.channel ?? null,
      title: params.title,
      scheduled_at: params.scheduledAt,
      related_table: params.relatedTable ?? null,
      related_id: params.relatedId ?? null,
      notes: params.notes ?? null,
      status: "scheduled",
    })
    .select("id")
    .single()

  if (error) {
    console.error("[v0] Error creating calendar event:", error)
    return { success: false, error: error.message }
  }

  return { success: true, event }
}

export async function getCalendarEvents(filters?: {
  campaignId?: string
  startDate?: string
  endDate?: string
}) {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  // If no brokerageId, return empty events
  if (!brokerageId) {
    return { success: true, events: [] }
  }

  let query = supabase
    .from("campaign_calendar")
    .select("*, campaign:marketing_campaigns(id, campaign_name)")
    .eq("brokerage_id", brokerageId)
    .order("scheduled_at", { ascending: true })

  // Only apply agent filter if agentId is a valid UUID
  if (agentId) {
    query = query.or(`agent_user_id.eq.${agentId},campaign_id.is.null`)
  }

  if (filters?.campaignId) {
    query = query.eq("campaign_id", filters.campaignId)
  }
  if (filters?.startDate) {
    query = query.gte("scheduled_at", filters.startDate)
  }
  if (filters?.endDate) {
    query = query.lte("scheduled_at", filters.endDate)
  }

  const { data: events, error } = await query

  if (error) {
    console.error("[v0] Error fetching calendar events:", error)
    return { success: false, error: error.message, events: [] }
  }

  return { success: true, events: events ?? [] }
}

export async function updateCalendarEventStatus(
  eventId: string,
  status: "scheduled" | "completed" | "cancelled"
) {
  const { userId, brokerageId } = await getAgentContext()
  await assertMarketingStudioAccess(userId)

  const supabase = await createClient()

  const { error } = await supabase
    .from("campaign_calendar")
    .update({ status })
    .eq("id", eventId)
    .eq("brokerage_id", brokerageId)

  if (error) {
    console.error("[v0] Error updating calendar event:", error)
    return { success: false, error: error.message }
  }

  return { success: true }
}

// ─── COMMENT ACTIONS ──────────────────────────────────────────────────────────

export async function addCampaignComment(params: CreateCommentParams) {
  const { userId, brokerageId } = await getAgentContext()
  await assertMarketingStudioAccess(userId)

  const supabase = await createClient()

  const { data: comment, error } = await supabase
    .from("marketing_campaign_comments")
    .insert({
      brokerage_id: brokerageId,
      campaign_id: params.campaignId,
      author_user_id: userId,
      comment_body: params.commentBody,
    })
    .select("id")
    .single()

  if (error) {
    console.error("[v0] Error adding comment:", error)
    return { success: false, error: error.message }
  }

  return { success: true, comment }
}

export async function getCampaignComments(campaignId: string) {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  const { data: comments, error } = await supabase
    .from("marketing_campaign_comments")
    .select("*, author:users(id, first_name, last_name)")
    .eq("campaign_id", campaignId)
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: true })

  if (error) {
    console.error("[v0] Error fetching comments:", error)
    return { success: false, error: error.message, comments: [] }
  }

  return { success: true, comments: comments ?? [] }
}

// ─── TASK ACTIONS ─────────────────────────────────────────────────────────────

export async function createCampaignTask(params: CreateTaskParams) {
  const { userId, brokerageId } = await getAgentContext()
  await assertMarketingStudioAccess(userId)

  const supabase = await createClient()

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
    .single()

  if (error) {
    console.error("[v0] Error creating task:", error)
    return { success: false, error: error.message }
  }

  return { success: true, task }
}

export async function getCampaignTasks(campaignId: string) {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  const { data: tasks, error } = await supabase
    .from("marketing_campaign_tasks")
    .select("*, assignee:users(id, first_name, last_name)")
    .eq("campaign_id", campaignId)
    .eq("brokerage_id", brokerageId)
    .order("due_at", { ascending: true, nullsFirst: false })

  if (error) {
    console.error("[v0] Error fetching tasks:", error)
    return { success: false, error: error.message, tasks: [] }
  }

  return { success: true, tasks: tasks ?? [] }
}

export async function updateTaskStatus(
  taskId: string,
  status: "pending" | "in_progress" | "completed" | "cancelled"
) {
  const { userId, brokerageId } = await getAgentContext()
  await assertMarketingStudioAccess(userId)

  const supabase = await createClient()

  const { error } = await supabase
    .from("marketing_campaign_tasks")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", taskId)
    .eq("brokerage_id", brokerageId)

  if (error) {
    console.error("[v0] Error updating task:", error)
    return { success: false, error: error.message }
  }

  return { success: true }
}

// ─── CONTENT REGISTRY (delegated to campaign-registry) ───────────────────────

export { getCampaignRegistry, registerCampaignSource }

// ─── AI CONTENT GENERATION WITH BRAND VOICE ──────────────────────────────────

export async function generateCampaignContent(params: {
  campaignId: string
  contentType: "social_caption" | "email_subject" | "email_body" | "ad_copy"
  prompt: string
  persona?: Persona
}) {
  const { userId, agentId, brokerageId } = await getAgentContext()
  await assertMarketingStudioAccess(userId)

  const supabase = await createClient()

  // Get campaign context
  const { data: campaign } = await supabase
    .from("marketing_campaigns")
    .select("campaign_name, campaign_type, listing:listings(address, city)")
    .eq("id", params.campaignId)
    .single()

  // Load brand voice profile for this brokerage
  const { data: aiIdentity } = await supabase
    .from("brand_voice_profile")
    .select("tone, formality_level, key_brand_messages, prohibited_words, preferred_words, mission_statement, custom_instructions")
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  const systemPrompt = [
    `You are ${aiIdentity?.tone ? `a ${aiIdentity.tone}` : "a professional"} real estate marketing AI.`,
    aiIdentity?.formality_level === "formal"
      ? "Use formal, professional language."
      : aiIdentity?.formality_level === "casual"
      ? "Use approachable, conversational language."
      : "Use semi-formal, warm language.",
    aiIdentity?.key_brand_messages?.length
      ? `Brand pillars: ${aiIdentity.key_brand_messages.join(", ")}.`
      : "",
    aiIdentity?.prohibited_words?.length
      ? `Never use these words or phrases: ${aiIdentity.prohibited_words.join(", ")}.`
      : "",
    aiIdentity?.preferred_words?.length
      ? `Prefer these words and phrases: ${aiIdentity.preferred_words.join(", ")}.`
      : "",
    aiIdentity?.mission_statement
      ? `Brand mission: ${aiIdentity.mission_statement}`
      : "",
    aiIdentity?.custom_instructions ?? "",
  ]
    .filter(Boolean)
    .join(" ")

  const listing = (campaign as any)?.listing
  const contentPrompt = [
    `Campaign: ${campaign?.campaign_name ?? "real estate campaign"}`,
    `Type: ${params.contentType.replace(/_/g, " ")} (${campaign?.campaign_type ?? "general"})`,
    listing ? `Property: ${listing.address}, ${listing.city}` : "",
    `Task: ${params.prompt}`,
    `Requirements: Write compelling ${params.contentType.replace(/_/g, " ")} content. Be specific, local, and emotionally resonant. Include a clear call to action.`,
  ]
    .filter(Boolean)
    .join("\n")

  // Map contentType to AI_TASK_ROUTING feature key so governance cascade
  // (resolveAIModel → tier caps → brokerage overrides) picks the right model.
  // Per routing table: all content generation tasks resolve to claude-sonnet
  // (Anthropic) with gpt-4o as fallback — no hardcoding required.
  const featureMap: Record<typeof params.contentType, string> = {
    social_caption: "social_post_generation",
    email_subject:  "email_generation",
    email_body:     "email_generation",
    ad_copy:        "direct_mail_copy",
  }
  const feature = featureMap[params.contentType] ?? "social_post_generation"

  const aiResponse = await generateAIResponse({
    system: systemPrompt,
    prompt: contentPrompt,
    maxTokens: 800,
    metadata: {
      userId,
      brokerageId,
      agentId: agentId ?? null,
      feature,
    },
    compliance: {
      requiresFairHousingCheck: true,
      requiresThemFirstCheck: true,
      requiresTCPACheck: false,
      userId,
      brokerageId,
      contentType:
        params.contentType === "email_body" || params.contentType === "email_subject"
          ? "email"
          : "social",
    },
  })
  const generatedContent = aiResponse.text

  // Apply brand voice check
  const brandVoiceResult = await applyBrandVoice({
    brokerageId,
    actorUserId: userId,
    actorRole: "agent" as ActorRole,
    journeyType: campaign?.campaign_type === "listing" ? "seller" : "buyer",
    persona: params.persona ?? "other",
    messageType: params.contentType === "email_body" ? "email" : "social",
    content: generatedContent,
  })

  return {
    success: true,
    content: generatedContent,
    brandVoiceViolations: brandVoiceResult.violations,
    brandVoiceNotes: brandVoiceResult.notes,
  }
}

// ─── DASHBOARD AGGREGATIONS ───────────────────────────────────────────────────

export async function getMarketingStudioDashboard() {
  const { agentId, brokerageId } = await getAgentContext()
  const supabase = await createClient()

  // Parallel queries for dashboard data
  const [
    campaignsResult,
    assetsResult,
    upcomingEventsResult,
    pendingTasksResult,
  ] = await Promise.all([
    // Campaign counts by status
    supabase
      .from("marketing_campaigns")
      .select("status")
      .eq("brokerage_id", brokerageId)
      .or(`agent_user_id.eq.${agentId},visibility_scope.eq.brokerage`),
    // Asset counts by approval status
    supabase
      .from("marketing_assets")
      .select("approval_status")
      .eq("brokerage_id", brokerageId)
      .or(`agent_user_id.eq.${agentId},visibility_scope.eq.brokerage`),
    // Upcoming calendar events (next 7 days)
    supabase
      .from("campaign_calendar")
      .select("id, title, scheduled_at, event_type")
      .eq("brokerage_id", brokerageId)
      .eq("status", "scheduled")
      .gte("scheduled_at", new Date().toISOString())
      .lte("scheduled_at", new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString())
      .order("scheduled_at", { ascending: true })
      .limit(10),
    // Pending tasks
    supabase
      .from("marketing_campaign_tasks")
      .select("id, title, due_at, campaign:marketing_campaigns(campaign_name)")
      .eq("brokerage_id", brokerageId)
      .eq("status", "pending")
      .order("due_at", { ascending: true, nullsFirst: false })
      .limit(10),
  ])

  // Aggregate campaign status counts
  const campaignsByStatus: Record<string, number> = {}
  for (const c of campaignsResult.data ?? []) {
    const status = c.status ?? "unknown"
    campaignsByStatus[status] = (campaignsByStatus[status] ?? 0) + 1
  }

  // Aggregate asset approval counts
  const assetsByApproval: Record<string, number> = {}
  for (const a of assetsResult.data ?? []) {
    const status = a.approval_status ?? "unknown"
    assetsByApproval[status] = (assetsByApproval[status] ?? 0) + 1
  }

  return {
    success: true,
    dashboard: {
      campaignsByStatus,
      totalCampaigns: campaignsResult.data?.length ?? 0,
      assetsByApproval,
      totalAssets: assetsResult.data?.length ?? 0,
      upcomingEvents: upcomingEventsResult.data ?? [],
      pendingTasks: pendingTasksResult.data ?? [],
    },
  }
}
