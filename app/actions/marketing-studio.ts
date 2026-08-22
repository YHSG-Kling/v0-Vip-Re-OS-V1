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
} from "@/lib/kernel/0.1-feature-access"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { applyBrandVoice } from "@/lib/kernel/brand-voice"
import { checkBrandCompliance } from "@/lib/kernel/brand-compliance"
import { transitionLifecycle } from "@/lib/kernel/lifecycle"
import type { ActorRole, Persona, MessageType } from "@/lib/kernel/types"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { linkQrToAsset, unlinkQrFromAsset, getAssetQrLinks, getQrCodePerformance } from "@/lib/marketing/qr-asset-linker"
import { getCampaignRegistry, registerCampaignSource } from "@/lib/marketing/campaign-registry"
import { resolveWriteContext } from "@/lib/platform/acting-context"
import {
  mintTrackedQr,
  renderQrPng,
  isQrDestinationType,
  isQrPurpose,
  type QrDestinationType,
  type QrPurpose,
} from "@/lib/marketing/tracked-qr"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type CampaignStatus = "draft" | "pending_approval" | "approved" | "live" | "paused" | "ended"
export type AssetApprovalStatus = "pending" | "approved" | "rejected"
export type VisibilityScope = "agent" | "team" | "brokerage"

/**
 * THE CAMPAIGN'S AUDIENCE, in the spelling the resolver actually reads.
 *
 * `marketing_campaigns` carries the same idea TWICE and the two halves point in
 * opposite directions:
 *
 *   · `target_audience` (jsonb) — WRITTEN here and at app/crm/page.tsx:2130, and
 *     read by NOTHING that resolves an audience. A free-form blob.
 *   · `audience_personas` / `audience_generations` / `audience_age_segs` /
 *     `audience_lead_source_tags` / `audience_buyer_stages` /
 *     `audience_contact_ids` (scripts/1046-marketing-audience-and-customer-
 *     onboarding.sql:31-38, GIN-indexed at :55-57) — READ by the launch gate
 *     (lib/marketing/campaign-publisher.ts:47-67) and by the touchpoint recorder
 *     (lib/kernel/marketing.ts:1141), and written by NOBODY.
 *
 * The typed set is the SURVIVOR: it has the readers, the index and the resolver
 * (lib/marketing/audience-resolver.ts). `target_audience` is kept because it is
 * still a human-readable note on the row, but it is no longer the only thing a
 * campaign author's audience choice lands in.
 *
 * WHY THIS IS NOT COSMETIC. resolveCampaignAudience treats an EMPTY criteria
 * array as "no filter" (lib/marketing/audience-resolver.ts:64) — so with all six
 * columns writerless, every campaign resolved to EVERY CONTACT IN THE BROKERAGE,
 * capped only by that resolver's `.limit(5000)`. publishMarketingCampaignSafe
 * then measured deliverability against that whole book and flipped the campaign
 * to `live`, and distributeVideoAsset recorded a touchpoint against every one of
 * them. An audience filter nothing can write is not a dormant feature; it is a
 * blast radius.
 */
export interface CampaignAudienceParams {
  /** contacts.contact_persona */
  audiencePersonas?: string[]
  /** generational cohort, post-filtered from contacts.age_range */
  audienceGenerations?: string[]
  /** contacts.age_range */
  audienceAgeSegs?: string[]
  /** contacts.source_family */
  audienceLeadSourceTags?: string[]
  /** contacts.buyer_stage */
  audienceBuyerStages?: string[]
  /** Explicit pinned list — overrides every criterion above in the resolver. */
  audienceContactIds?: string[]
}

export interface CreateCampaignParams extends CampaignAudienceParams {
  campaignName: string
  campaignType: "listing" | "brand" | "recruitment" | "event" | "seasonal"
  listingId?: string
  targetAudience?: Record<string, unknown>
  budgetTotal?: number
  scheduledStartAt?: string
  scheduledEndAt?: string
  visibilityScope?: VisibilityScope
}

export interface UpdateCampaignParams extends CampaignAudienceParams {
  campaignId: string
  campaignName?: string
  targetAudience?: Record<string, unknown>
  budgetTotal?: number
  scheduledStartAt?: string
  scheduledEndAt?: string
}

/**
 * Map the audience params onto the six live columns.
 *
 * `"use server"` files export only async functions (CLAUDE.md §4), so this is a
 * module-local helper and deliberately NOT exported — an exported sync helper
 * here would be a public HTTP endpoint that cannot be one.
 *
 * `mode: "insert"` writes a floor for the five text[] columns, which are
 * `NOT NULL DEFAULT '{}'` — passing `undefined` would be fine, but writing `[]`
 * makes the row say plainly "no criterion", which is what the resolver reads.
 * `mode: "patch"` writes ONLY what the caller named, so an update that touches
 * the budget cannot silently clear the audience.
 */
function audienceColumns(
  params: CampaignAudienceParams,
  mode: "insert" | "patch",
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const put = (column: string, value: string[] | undefined, floor: unknown) => {
    if (value !== undefined) out[column] = value
    else if (mode === "insert") out[column] = floor
  }
  put("audience_personas", params.audiencePersonas, [])
  put("audience_generations", params.audienceGenerations, [])
  put("audience_age_segs", params.audienceAgeSegs, [])
  put("audience_lead_source_tags", params.audienceLeadSourceTags, [])
  put("audience_buyer_stages", params.audienceBuyerStages, [])
  // audience_contact_ids is NULLABLE uuid[] and the resolver reads
  // `?? undefined` — an empty array would read as "pinned to nobody", so the
  // floor for this one is NULL, not [].
  put("audience_contact_ids", params.audienceContactIds, null)
  return out
}

export interface CreateAssetParams {
  campaignId?: string
  assetType: "video" | "snippet" | "script" | "graphic" | "template" | "social_post" | "newsletter" | "blog" | "podcast" | "mailer" | "ad_creative" | "qr"
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
  /** campaign_calendar.event_type — exactly the column's CHECK. This used to
   *  include "meeting" and "go_live", which the column has never accepted, so
   *  the type vouched for an INSERT that could only fail. */
  eventType: "publish" | "send" | "launch" | "review" | "deadline" | "podcast_release" | "mail_drop"
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

async function assertMarketingStudioAccess(userId: string): Promise<{ allowed: boolean; reason?: string }> {
  const access = await canAccessFeature(userId, "marketing_studio")
  if (!access.allowed) {
    const reason = access.reason === "Feature does not exist"
      ? "Marketing Studio is not yet enabled for your account. Contact your administrator to enable it."
      : access.reason
    return { allowed: false, reason }
  }
  return { allowed: true }
}

// ─── CAMPAIGN ACTIONS ─────────────────────────────────────────────────────────

export async function createCampaign(params: CreateCampaignParams) {
  try {
    const { userId, agentId, brokerageId } = await getAgentContext()
    const access = await assertMarketingStudioAccess(userId)
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Access to Marketing Studio denied" }
    }

    const supabase = await createClient()

    const { data: campaign, error } = await supabase
      .from("marketing_campaigns")
      .insert({
        brokerage_id: brokerageId,
        agent_user_id: userId,
        created_by: userId,
        campaign_name: params.campaignName,
        campaign_type: params.campaignType,
        listing_id: params.listingId ?? null,
        target_audience: params.targetAudience ?? {},
        ...audienceColumns(params, "insert"),
        budget_total: params.budgetTotal ?? 0,
        budget_spent: 0,
        scheduled_start_at: params.scheduledStartAt || null,
        scheduled_end_at: params.scheduledEndAt || null,
        visibility_scope: params.visibilityScope ?? "agent",
        status: "draft",
      })
      .select("id, status")
      .maybeSingle()

    if (error) {
      console.error("[v0] Error creating campaign:", error)
      return { success: false, error: error.message }
    }

    // Emit kernel event
    await processKernelEvent({
      event: KernelEvent.MARKETING_CAMPAIGN_CREATED,
      brokerageId: brokerageId!,
      entityType: "marketing_campaign",
      entityId: campaign!.id,
    }).catch((err) => console.error("[MarketingStudio] Kernel event failed:", err))

    await incrementFeatureUsage(userId, "marketing_studio")

    return { success: true, campaign }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create campaign"
    console.error("[MarketingStudio] createCampaign error:", message)
    return { success: false, error: message }
  }
}

export async function getCampaigns(filters?: {
  status?: CampaignStatus
  campaignType?: string
  listingId?: string
}) {
  const { userId, brokerageId } = await getAgentContext()
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
  // Filter on agent_user_id (stores userId/auth-user-id, not agents.id)
  if (userId) {
    query = query.or(`agent_user_id.eq.${userId},visibility_scope.eq.brokerage`)
  } else {
    // If no userId, only show brokerage-wide campaigns
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
    .maybeSingle()

  if (error) {
    console.error("[v0] Error fetching campaign:", error)
    return { success: false, error: error.message }
  }

  return { success: true, campaign }
}

export async function updateCampaign(params: UpdateCampaignParams) {
  const { userId, brokerageId } = await getAgentContext()
  const access = await assertMarketingStudioAccess(userId)
  if (!access.allowed) {
    return { success: false, error: access.reason ?? "Access to Marketing Studio denied" }
  }

  const supabase = await createClient()

  const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (params.campaignName !== undefined) updateData.campaign_name = params.campaignName
  if (params.targetAudience !== undefined) updateData.target_audience = params.targetAudience
  if (params.budgetTotal !== undefined) updateData.budget_total = params.budgetTotal
  if (params.scheduledStartAt !== undefined) updateData.scheduled_start_at = params.scheduledStartAt || null
  if (params.scheduledEndAt !== undefined) updateData.scheduled_end_at = params.scheduledEndAt || null
  Object.assign(updateData, audienceColumns(params, "patch"))

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
  const access = await assertMarketingStudioAccess(userId)
  if (!access.allowed) {
    return { success: false, error: access.reason ?? "Access to Marketing Studio denied" }
  }

  const supabase = await createClient()

  // Get current status
  const { data: campaign, error: fetchError } = await supabase
    .from("marketing_campaigns")
    .select("id, status")
    .eq("id", campaignId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (fetchError || !campaign) {
    return { success: false, error: "Campaign not found" }
  }

  const fromStatus = campaign.status

  // ── DNC & COMPLIANCE CHECK BEFORE LAUNCH ────────────────────────────────────
  if (toStatus === "live") {
    // Get campaign details including content and channel
    const { data: fullCampaign } = await supabase
      .from("marketing_campaigns")
      .select("*, assets:marketing_assets(*)")
      .eq("id", campaignId)
      .single()

    if (fullCampaign) {
      // Extract actual copy text from campaign assets — never use URLs as compliance content
      const campaignContent = fullCampaign.assets
        ?.map((asset: any) =>
          asset.copy_text || asset.content_text || asset.preview_text || asset.description || asset.headline || asset.asset_name
        )
        .filter(Boolean)
        .join(" ") || fullCampaign.campaign_name

      // Determine channel and message type
      const campaignType = fullCampaign.campaign_type || "email"
      const channel = campaignType.includes("email") ? "email" : 
                     campaignType.includes("sms") ? "sms" :
                     campaignType.includes("social") ? "social_media" : "email"
      
      const messageType: MessageType = campaignType.includes("email") ? "email" :
                                       campaignType.includes("sms") ? "sms" :
                                       "social"

      // Fair-housing + misleading-claim compliance gate (broadcast — no specific contact)
      const complianceResult = await evaluateOutbound({
        actorContext: { brokerageId: brokerageId!, userId: userId!, role: "agent" as any },
        journeyType: "seller" as any,
        persona: "homeowner" as any,
        messageType,
        content: campaignContent,
        contact: undefined,
      })
      if (!complianceResult.allowed) {
        return {
          success: false,
          error: `Campaign failed compliance review: ${complianceResult.violations?.join(", ") ?? "Unknown violation"}`,
        }
      }

      // Apply brand voice to campaign content.
      // Brand voice violation checking is already performed inside evaluateOutbound (Gate 1)
      // above — do NOT call applyBrandVoice a second time for violation checking.
      // This single call transforms the content with the correct tone/style.
      const brandVoiceResult = await applyBrandVoice({
        brokerageId: brokerageId!,
        actorUserId: userId!,
        actorRole: "agent" as ActorRole,
        journeyType: "seller",
        persona: "homeowner" as Persona,
        messageType,
        content: campaignContent,
      })

      console.log("[v0] Campaign passed compliance and brand voice checks")
    }
  }

  // Use kernel lifecycle transition
  const result = await transitionLifecycle({
    brokerageId: brokerageId!,
    entityType: "marketing_campaign_machine" as any,
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
  try {
    const { userId, agentId, brokerageId } = await getAgentContext()
    const access = await assertMarketingStudioAccess(userId)
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Access to Marketing Studio denied" }
    }

    const supabase = await createClient()

    const { data: asset, error } = await supabase
      .from("marketing_assets")
      .insert({
        brokerage_id: brokerageId,
        agent_user_id: userId,
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
      .maybeSingle()

    if (error) {
      console.error("[v0] Error creating asset:", error)
      return { success: false, error: error.message }
    }

    return { success: true, asset }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create asset"
    console.error("[MarketingStudio] createAsset error:", message)
    return { success: false, error: message }
  }
}

export async function getAssets(filters?: {
  campaignId?: string
  assetType?: string
  approvalStatus?: AssetApprovalStatus
}) {
  const { userId, brokerageId } = await getAgentContext()
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

  // Filter on agent_user_id (stores userId/auth-user-id, not agents.id)
  if (userId) {
    query = query.or(`agent_user_id.eq.${userId},visibility_scope.eq.brokerage`)
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
  const access = await assertMarketingStudioAccess(userId)
  if (!access.allowed) {
    return { success: false, error: access.reason ?? "Access to Marketing Studio denied" }
  }

  const supabase = await createClient()

  // Run brand compliance check before approval
  const complianceResult = await checkBrandCompliance({
    contentType: "listing_media",
    contentId: assetId,
    brokerageId: brokerageId ?? "",
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
    .select("asset_type, preview_text")
    .eq("id", assetId)
    .maybeSingle()

  if (asset?.preview_text) {
    const contentType =
      asset.asset_type === "ad" ? "ad" : "social_post"
    const reGate = await runComplianceGate({
      content: asset.preview_text,
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
  const access = await assertMarketingStudioAccess(userId)
  if (!access.allowed) {
    return { success: false, error: access.reason ?? "Access to Marketing Studio denied" }
  }

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

// getQrCodePerformance was an ORPHAN EXPORT: the only reader of qr_scan_events' per-code detail
// (unique scans + the recent-scan list) with nothing calling it. Its capability is not
// represented anywhere else — listAvailableQrCodes returns only the rolled-up counters — so it
// was WIRED, not deleted. The studio's QR tab now opens it per code.
export { linkQrToAsset, unlinkQrFromAsset, getAssetQrLinks, getQrCodePerformance }

// ─── CALENDAR ACTIONS ─────────────────────────────────────────────────────────

export async function createCalendarEvent(params: CreateCalendarEventParams) {
  try {
    const { userId, agentId, brokerageId } = await getAgentContext()
    const access = await assertMarketingStudioAccess(userId)
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Access to Marketing Studio denied" }
    }

    const supabase = await createClient()

    const { data: event, error } = await supabase
      .from("campaign_calendar")
      .insert({
        brokerage_id: brokerageId,
        agent_user_id: userId,
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
      .maybeSingle()

    if (error) {
      console.error("[v0] Error creating calendar event:", error)
      return { success: false, error: error.message }
    }

    return { success: true, event }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create calendar event"
    console.error("[MarketingStudio] createCalendarEvent error:", message)
    return { success: false, error: message }
  }
}

export async function getCalendarEvents(filters?: {
  campaignId?: string
  startDate?: string
  endDate?: string
}) {
  const { userId, brokerageId } = await getAgentContext()
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

  // agent_user_id stores the auth user_id (users.id), not agents.id
  if (userId) {
    query = query.or(`agent_user_id.eq.${userId},agent_user_id.is.null`)
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
  const access = await assertMarketingStudioAccess(userId)
  if (!access.allowed) {
    return { success: false, error: access.reason ?? "Access to Marketing Studio denied" }
  }

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
  const access = await assertMarketingStudioAccess(userId)
  if (!access.allowed) {
    return { success: false, error: access.reason ?? "Access to Marketing Studio denied" }
  }

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
    .maybeSingle()

  if (error) {
    console.error("[v0] Error adding comment:", error)
    return { success: false, error: error.message }
  }

  return { success: true, comment }
}

// getCampaignComments REMOVED — TOMBSTONE.
// SURVIVOR: `getCampaignById` in this file, whose bundle already carries the
// campaign's comments, which is why the studio client reads them from there.
// This was a "use server" export, so it was a PUBLIC HTTP ENDPOINT with no
// caller — an unreferenced server action is reachable by anyone who knows its
// id, not dead code. Its last importer went in the dead-import tranche; the
// endpoint is going with it rather than being left addressable.

// ─── TASK ACTIONS ─────────────────────────────────────────────────────────────

export async function createCampaignTask(params: CreateTaskParams) {
  const { userId, brokerageId } = await getAgentContext()
  const access = await assertMarketingStudioAccess(userId)
  if (!access.allowed) {
    return { success: false, error: access.reason ?? "Access to Marketing Studio denied" }
  }

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
    .maybeSingle()

  if (error) {
    console.error("[v0] Error creating task:", error)
    return { success: false, error: error.message }
  }

  return { success: true, task }
}

// getCampaignTasks REMOVED — TOMBSTONE.
// SURVIVOR: `getCampaignById` in this file, whose bundle already carries the
// campaign's tasks. Same reasoning as getCampaignComments above: a "use server"
// export with no caller is still a live public endpoint.

export async function updateTaskStatus(
  taskId: string,
  status: "pending" | "in_progress" | "completed" | "cancelled"
) {
  const { userId, brokerageId } = await getAgentContext()
  const access = await assertMarketingStudioAccess(userId)
  if (!access.allowed) {
    return { success: false, error: access.reason ?? "Access to Marketing Studio denied" }
  }

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
  const access = await assertMarketingStudioAccess(userId)
  if (!access.allowed) {
    return { success: false, error: access.reason ?? "Access to Marketing Studio denied" }
  }

  const supabase = await createClient()

  // Get campaign context
  const { data: campaign } = await supabase
    .from("marketing_campaigns")
    .select("campaign_name, campaign_type, listing:listings(address, city)")
    .eq("id", params.campaignId)
    .maybeSingle()

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
    brokerageId: brokerageId ?? "",
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

// ─── QR CODE CREATION ────────────────────────────────────────────────────────

/**
 * createQrCodeAction — the SESSION-GATED browser door to the one QR minter.
 *
 * MERGED-THEN-DELETED: this function's own `qr_codes` insert is gone. It was one of nine rival
 * creation paths — NOT idempotent (every click of "Create QR Code" minted another row), and it
 * never set destination_type, so its codes were invisible to every destination-bucketed analytic.
 * The write now goes through lib/marketing/tracked-qr.ts:mintTrackedQr, which is idempotent per
 * label, stamps destination_type / listing_id / marketing_campaign_id / expires_at, and is the
 * single writer of the table. The slug recipe this function owned lives on in the survivor.
 *
 * GATE-THEN-SERVICE: mintTrackedQr writes with the SERVICE client, so this action's own gate is
 * the ONLY gate. `brokerageId` / `agentId` used to be taken from the caller's params and written
 * verbatim — and a "use server" export is reachable by any browser, so that let a caller mint
 * into ANY brokerage. The tenant now comes from the session; a supplied brokerageId is only ever
 * checked against it, never trusted.
 *
 * NOT CALLABLE WITHOUT A SESSION. Server-side/cron minters (workflow adapters, orchestrator
 * handlers, kernel commands) must call mintTrackedQr directly with their own resolved tenant —
 * see lib/workflow/qr-modifier.ts for the pattern.
 *
 * Output contract (unchanged for existing callers, plus the tracked fields):
 *   { success: true, qrCode: { id, slug, label, target_url, purpose, destination_type,
 *                             scan_url, image_url } }
 *   { success: false, error: string }
 */
export async function createQrCodeAction(params: {
  brokerageId?: string
  agentId?: string
  label: string
  /** SEMANTIC destination. Omit → the code's own public /qr/<slug> landing. */
  targetUrl?: string
  purpose: QrPurpose
  listingId?: string
  destinationType?: QrDestinationType
  /** ★ TRACKING LINKED TO CAMPAIGN ★ marketing_campaigns.id — stamps qr_codes.marketing_campaign_id. */
  campaignId?: string
  /** qr_codes.expires_at (ISO timestamptz). */
  expiresAt?: string
  /** Deterministic idempotency key. Defaults to `studio:<label>` so repeat clicks reuse one code. */
  idempotencyLabel?: string
}) {
  try {
    if (!params.label?.trim()) {
      return { success: false, error: "Label is required" }
    }
    if (params.purpose && !isQrPurpose(params.purpose)) {
      return { success: false, error: `Invalid purpose. Must be one of: ${["business_card","campaign","event","general","lead_capture","lead_magnet","listing","listing_inquiry","open_house"].join(", ")}` }
    }
    if (params.destinationType && !isQrDestinationType(params.destinationType)) {
      return { success: false, error: "Invalid destination type." }
    }

    const ctx = await resolveWriteContext()
    if (!ctx.ok) return { success: false, error: ctx.error }
    if (!ctx.brokerageId) return { success: false, error: "No brokerage on your account." }
    if (params.brokerageId && params.brokerageId !== ctx.brokerageId) {
      return { success: false, error: "That QR code belongs to another brokerage." }
    }

    // qr_codes.agent_id FKs agents(id). ctx.agentId IS that PK; a users id in this column is a
    // refused insert, so never fall back to userId.
    const agentId = params.agentId ?? ctx.agentId ?? null

    // The campaign must be one of OURS — an FK proves a campaign row exists, never that it is
    // ours to attribute scans to.
    let marketingCampaignId: string | null = null
    if (params.campaignId) {
      const gate = await createClient()
      const { data: campaign, error: campaignError } = await gate
        .from("marketing_campaigns")
        .select("id")
        .eq("id", params.campaignId)
        .eq("brokerage_id", ctx.brokerageId)
        .maybeSingle()
      if (campaignError) return { success: false, error: campaignError.message }
      if (!campaign) return { success: false, error: "That campaign is not on your brokerage." }
      marketingCampaignId = campaign.id as string
    }

    const label = params.label.trim()
    const minted = await mintTrackedQr({
      brokerageId: ctx.brokerageId,
      agentId,
      label: params.idempotencyLabel?.trim() || label,
      destinationType: params.destinationType ?? null,
      targetUrl: params.targetUrl?.trim() || null,
      listingId: params.listingId ?? null,
      marketingCampaignId,
      expiresAt: params.expiresAt ?? null,
      purpose: params.purpose,
    })

    if (!minted) {
      return { success: false, error: "The QR code was not created — the write was refused." }
    }

    return {
      success: true,
      qrCode: {
        id: minted.qrCodeId,
        slug: minted.slug,
        label,
        target_url: minted.targetUrl,
        purpose: params.purpose,
        destination_type: minted.destinationType,
        scan_url: minted.scanUrl,
        image_url: minted.qrCodeDataUrl,
      },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create QR code"
    return { success: false, error: message }
  }
}

/**
 * renderQrImageAction — server-side PNG for any URL, as a data: URI.
 *
 * Exists because the studio's asset-create dialog built its QR preview from api.qrserver.com,
 * which shipped the (lead-bearing) target URL to a third party and put an external host inside a
 * path that has to work offline/in print. The vendored `qrcode` package is the only QR image
 * source in the tree now.
 */
export async function renderQrImageAction(url: string, size = 300) {
  try {
    const trimmed = (url ?? "").trim()
    if (!trimmed) return { success: false as const, error: "A URL is required." }
    const ctx = await resolveWriteContext()
    if (!ctx.ok) return { success: false as const, error: ctx.error }
    return { success: true as const, dataUrl: await renderQrPng(trimmed, size) }
  } catch (err) {
    return { success: false as const, error: err instanceof Error ? err.message : "Failed to render QR image" }
  }
}

export async function getMarketingStudioDashboard() {
  try {
    // pass 12: marketing_campaigns/marketing_assets.agent_user_id stores the auth
    // users.id (that's how every insert in this file stamps it) — filter with
    // userId, not agents.id, or the "yours" buckets come back empty.
    const { userId, brokerageId } = await getAgentContext()
    const supabase = await createClient()

    // Run two separate campaign queries (agent-owned + brokerage-visible) to
    // avoid Supabase OR-filter ambiguity that can silently return 0 rows.
    const now = new Date().toISOString()
    const weekOut = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

    const [
      agentCampaignsResult,
      brokerageCampaignsResult,
      agentAssetsResult,
      brokerageAssetsResult,
      upcomingEventsResult,
      pendingTasksResult,
    ] = await Promise.all([
      // Campaigns owned by this agent
      supabase
        .from("marketing_campaigns")
        .select("status")
        .eq("brokerage_id", brokerageId)
        .eq("agent_user_id", userId),
      // Brokerage-scoped campaigns (visible to all agents in brokerage)
      supabase
        .from("marketing_campaigns")
        .select("status")
        .eq("brokerage_id", brokerageId)
        .eq("visibility_scope", "brokerage")
        .or(`agent_user_id.neq.${userId},agent_user_id.is.null`), // exclude agent's own brokerage campaigns; include null-owner brokerage assets
      // Assets owned by this agent
      supabase
        .from("marketing_assets")
        .select("approval_status")
        .eq("brokerage_id", brokerageId)
        .eq("agent_user_id", userId),
      // Brokerage-scoped assets
      supabase
        .from("marketing_assets")
        .select("approval_status")
        .eq("brokerage_id", brokerageId)
        .eq("visibility_scope", "brokerage")
        .or(`agent_user_id.neq.${userId},agent_user_id.is.null`),
      // Upcoming calendar events (next 7 days)
      supabase
        .from("campaign_calendar")
        .select("id, title, scheduled_at, event_type")
        .eq("brokerage_id", brokerageId)
        .eq("status", "scheduled")
        .gte("scheduled_at", now)
        .lte("scheduled_at", weekOut)
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

    // Campaign or asset query failures yield incomplete KPIs — surface as error
    const criticalError =
      agentCampaignsResult.error ??
      brokerageCampaignsResult.error ??
      agentAssetsResult.error ??
      brokerageAssetsResult.error
    if (criticalError) {
      console.error("[marketing-studio] critical query failure:", criticalError.message)
      return { success: false, error: criticalError.message }
    }

    if (upcomingEventsResult.error) {
      console.error("[marketing-studio] upcomingEventsResult error:", upcomingEventsResult.error.message)
    }
    if (pendingTasksResult.error) {
      console.error("[marketing-studio] pendingTasksResult error:", pendingTasksResult.error.message)
    }

    // Merge the two campaign sets
    const allCampaigns = [
      ...(agentCampaignsResult.data ?? []),
      ...(brokerageCampaignsResult.data ?? []),
    ]

    // Aggregate campaign status counts
    const campaignsByStatus: Record<string, number> = {}
    for (const c of allCampaigns) {
      const status = c.status ?? "unknown"
      campaignsByStatus[status] = (campaignsByStatus[status] ?? 0) + 1
    }

    // Merge the two asset sets
    const allAssets = [
      ...(agentAssetsResult.data ?? []),
      ...(brokerageAssetsResult.data ?? []),
    ]

    // Aggregate asset approval counts
    const assetsByApproval: Record<string, number> = {}
    for (const a of allAssets) {
      const status = a.approval_status ?? "unknown"
      assetsByApproval[status] = (assetsByApproval[status] ?? 0) + 1
    }

    return {
      success: true,
      dashboard: {
        campaignsByStatus,
        totalCampaigns: allCampaigns.length,
        assetsByApproval,
        totalAssets: allAssets.length,
        upcomingEvents: upcomingEventsResult.data ?? [],
        pendingTasks: pendingTasksResult.data ?? [],
      },
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to load dashboard"
    console.error("[marketing-studio] getMarketingStudioDashboard error:", message)
    return { success: false, error: message }
  }
}
