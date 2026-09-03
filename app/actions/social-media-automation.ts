"use server"

// app/actions/social-media-automation.ts
// Layer 9.2 Social Media Automation — Server Actions
// Canonical Tables: social_posts, social_media_accounts, social_engagement_tracking, social_publish_log
// DO NOT use social_media_posts or social_accounts

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { generateAIResponse } from "@/lib/ai"
import { isValidUUID } from "@/lib/validations"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { applyBrandVoice } from "@/lib/kernel/brand-voice"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { getAgentContext } from "@/lib/identity/get-agent-context"
// The ONE way a notifications row gets its tenant — the recipient's
// users.brokerage_id, the exact value badge-counts compares against.
import { resolveRecipientBrokerageId } from "@/lib/notifications/recipient-tenant"

/**
 * Tenant guard — requires authenticated session with a brokerage.
 * Returns the session's brokerageId/userId/agentId so callers can stop
 * trusting caller-supplied IDs.
 */
async function requireBrokerage(): Promise<
  | { ok: true; brokerageId: string; userId: string; agentId: string | null; userType: string }
  | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { ok: false, error: "Unauthorized" }
  }
  return {
    ok: true,
    brokerageId: ctx.brokerageId,
    userId: ctx.userId,
    agentId: ctx.agentId,
    userType: ctx.userType ?? "agent",
  }
}

/**
 * Roles that see EVERY post in the brokerage. Everyone else (an ordinary agent)
 * sees only their own. Merged in from the retired
 * `app/actions/social-publishing.ts:getSocialAnalytics`, which was the only reader
 * that scoped social analytics per user — this file's reader was brokerage-wide, so
 * an individual agent could read the whole brokerage's social performance.
 * `social_posts.user_id` is a users.id and is reliably populated (both the manual
 * creator and the listing-promo cron resolve and set it), so the filter narrows
 * rather than blanking the view.
 */
const SOCIAL_ANALYTICS_ALL_POSTS_ROLES = [
  "ADMIN", "BROKER", "COMPLIANCE_OFFICER",
  "admin", "broker", "broker_owner", "broker_admin", "compliance_officer", "superadmin",
]
function seesAllBrokeragePosts(userType: string): boolean {
  return SOCIAL_ANALYTICS_ALL_POSTS_ROLES.includes(userType)
}

/** Verify a given agents.id row belongs to brokerageId. Uses service client. */
async function verifyAgentInBrokerage(agentId: string, brokerageId: string): Promise<boolean> {
  const svc = createServiceClient()
  const { data } = await svc
    .from("agents")
    .select("id, brokerage_id")
    .eq("id", agentId)
    .maybeSingle()
  return !!data && (data as any).brokerage_id === brokerageId
}

/** Verify a social_media_accounts row belongs to brokerageId. */
async function verifySocialAccountInBrokerage(
  socialAccountId: string,
  brokerageId: string
): Promise<boolean> {
  const svc = createServiceClient()
  const { data } = await svc
    .from("social_media_accounts")
    .select("id, brokerage_id")
    .eq("id", socialAccountId)
    .maybeSingle()
  return !!data && (data as any).brokerage_id === brokerageId
}

/** Verify a social_posts row belongs to brokerageId. */
async function verifySocialPostInBrokerage(
  postId: string,
  brokerageId: string
): Promise<{ ok: boolean; row?: { brokerage_id: string } }> {
  const svc = createServiceClient()
  const { data } = await svc
    .from("social_posts")
    .select("id, brokerage_id")
    .eq("id", postId)
    .maybeSingle()
  if (!data || (data as any).brokerage_id !== brokerageId) return { ok: false }
  return { ok: true, row: data as any }
}

function parseAIJsonResponse(text: string) {
  let cleanText = text.trim()
  if (cleanText.startsWith("```json")) {
    cleanText = cleanText.replace(/^```json\s*/, "").replace(/```\s*$/, "")
  } else if (cleanText.startsWith("```")) {
    cleanText = cleanText.replace(/^```\s*/, "").replace(/```\s*$/, "")
  }
  return JSON.parse(cleanText.trim())
}

// ============================================
// SOCIAL MEDIA ACCOUNT MANAGEMENT
// ============================================

export async function connectSocialAccount(params: {
  agentId?: string // optional — verified to belong to ctx.brokerageId
  userId?: string // ignored — derived from session
  platform: "facebook" | "instagram" | "linkedin" | "twitter" | "tiktok" | "youtube" | "pinterest"
  accountName: string
  accessToken: string
  refreshToken?: string
  expiresAt?: string
  accountId?: string
  brokerageId?: string // ignored — derived from session
  scope?: "brokerage" | "agent"
}) {
  // SECURITY: OAuth tokens are brokerage-bound. The caller cannot pick which
  // brokerage to attach the token to — we always use the authenticated
  // session's brokerageId. Failing this open would let any tenant attach
  // OAuth credentials to any other tenant's brokerage.
  const auth = await requireBrokerage()
  if (!auth.ok) return { success: false, error: auth.error }

  // If caller supplied an agentId, verify it belongs to the caller's brokerage.
  // Otherwise fall back to the session's agentId (if any).
  let effectiveAgentId: string | null = null
  if (params.agentId !== undefined) {
    if (!isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }
    const ok = await verifyAgentInBrokerage(params.agentId, auth.brokerageId)
    if (!ok) return { success: false, error: "Forbidden" }
    effectiveAgentId = params.agentId
  } else {
    effectiveAgentId = auth.agentId
  }

  const supabase = await createClient()

  try {
    const { data: account, error } = await supabase
      .from("social_media_accounts")
      .insert({
        agent_id: effectiveAgentId,
        user_id: auth.userId, // session-derived, NOT caller-supplied
        brokerage_id: auth.brokerageId, // session-derived, NOT caller-supplied
        platform: params.platform,
        account_name: params.accountName,
        account_id: params.accountId || null,
        access_token: params.accessToken,
        refresh_token: params.refreshToken ?? null,
        token_expires_at: params.expiresAt ?? null,
        scope: params.scope || "agent",
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .maybeSingle()

    if (error) throw error

    revalidatePath("/dashboard/social")
    return { success: true, data: account }
  } catch (error) {
    console.error("[social-media-automation] Connect social account error:", error)
    return { success: false, error: "Failed to connect account" }
  }
}

export async function getConnectedAccounts(agentId?: string, _brokerageId?: string) {
  // brokerageId is IGNORED — always derived from session to prevent
  // cross-tenant reads of OAuth metadata.
  const auth = await requireBrokerage()
  if (!auth.ok) return []

  const supabase = await createClient()

  let query = supabase
    .from("social_media_accounts")
    .select("*")
    .eq("brokerage_id", auth.brokerageId) // tenant-scoped at the source
    .eq("is_active", true)
    .order("platform")

  // Optional narrowing by agentId — but only after verifying that agent
  // belongs to the caller's brokerage.
  if (agentId) {
    if (!isValidUUID(agentId)) return []
    const ownsAgent = await verifyAgentInBrokerage(agentId, auth.brokerageId)
    if (!ownsAgent) return []
    query = query.eq("agent_id", agentId)
  }

  const { data, error } = await query

  if (error) {
    console.error("[social-media-automation] Get connected accounts error:", error)
    return []
  }

  return data || []
}

export async function disconnectSocialAccount(accountId: string) {
  if (!isValidUUID(accountId)) {
    return { success: false, error: "Invalid account ID" }
  }

  const supabase = await createClient()

  const { error } = await supabase
    .from("social_media_accounts")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", accountId)

  if (error) {
    console.error("[social-media-automation] Disconnect account error:", error)
    return { success: false, error: "Failed to disconnect account" }
  }

  revalidatePath("/dashboard/social")
  return { success: true }
}

// ============================================
// POST SCHEDULING — KERNEL INTEGRATED
// ============================================

/**
 * Schedule a social post with full kernel integration
 * - canAccessFeature('social_automation') check
 * - applyBrandVoice() on content
 * - evaluateOutbound() — blocks if compliance fails
 * - processKernelEvent(SOCIAL_POST_SCHEDULED)
 */
export async function scheduleSocialPost(params: {
  brokerageId?: string // ignored — derived from session
  agentId?: string // verified against session brokerage if provided
  userId?: string // ignored — derived from session
  platform: string
  postType: string
  content: string
  mediaUrls?: string[]
  hashtags?: string[]
  scheduledFor: string
  socialAccountId: string
  listingId?: string
  campaignId?: string
  /** Pass true when the brokerage requires broker approval — the post is
   *  created as a DRAFT with approval_status "pending" (two separate axes). */
  requiresBrokerApproval?: boolean
}) {
  // Auth gate — derive brokerage/user from session
  const auth = await requireBrokerage()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!isValidUUID(params.socialAccountId)) {
    return { success: false, error: "Invalid social account ID" }
  }

  // Verify the social account belongs to caller's brokerage
  const ownsAccount = await verifySocialAccountInBrokerage(params.socialAccountId, auth.brokerageId)
  if (!ownsAccount) return { success: false, error: "Forbidden" }

  // If caller passed an agentId, verify it belongs to caller's brokerage
  let effectiveAgentId: string | null = auth.agentId
  if (params.agentId !== undefined) {
    if (!isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }
    const ownsAgent = await verifyAgentInBrokerage(params.agentId, auth.brokerageId)
    if (!ownsAgent) return { success: false, error: "Forbidden" }
    effectiveAgentId = params.agentId
  }

  const brokerageId = auth.brokerageId
  const userId = auth.userId

  // Feature access check
  const canAccess = await canAccessFeature(userId, "social_automation")

  if (!canAccess.allowed) {
    return { success: false, error: "Feature not available for your subscription tier" }
  }

  const supabase = await createClient()

  try {
    // Apply brand voice — check for violations only; we never rewrite content automatically.
    // BrandVoiceResult.content is the original (unchanged); there is no transformedContent.
    let processedContent = params.content
    try {
      await applyBrandVoice({
        brokerageId,
        actorUserId: userId,
        actorRole: "agent",
        journeyType: "buyer",
        persona: "first_time",
        messageType: "social",
        content: params.content,
      })
      // Brand voice result is advisory only — we log but never block scheduling here.
    } catch (brandError) {
      console.warn("[social-media-automation] Brand voice check failed:", brandError)
      // Continue with original content — brand voice is advisory
    }

    // Evaluate outbound compliance — BLOCK if fails
    // Uses a broadcast stub contact so TCPA/Authority gates pass;
    // Fair Housing (Gate 4) and Them-First (Gate 5) still run on the content.
    try {
      const complianceResult = await evaluateOutbound({
        actorContext: {
          userId,
          role: "agent",
          brokerageId,
        },
        journeyType: "buyer",
        persona: "first_time",
        messageType: "social",
        content: processedContent,
        // Broadcast payload — see lib/video/script-compliance.ts for why the
        // stub contact is omitted rather than faked.
      })

      if (!complianceResult.allowed) {
        return {
          success: false,
          error: `Compliance blocked: ${complianceResult.violations?.[0] || "Content failed compliance check"}`,
          blocked: true,
        }
      }
    } catch (complianceError) {
      console.warn("[social-media-automation] Compliance evaluation failed:", complianceError)
      // Continue if compliance service is temporarily unavailable
    }

    // status and approval_status are two AXES, not one. status is the
    // publishing lifecycle (draft|scheduled|publishing|published|failed|
    // cancelled); approval_status is the broker gate (pending|approved|
    // rejected). This used to set status:"pending_approval", which the CHECK
    // has never accepted, so EVERY post from a brokerage that requires broker
    // approval failed to insert. A post awaiting approval is not scheduled —
    // it is a draft until the broker releases it.
    const initialStatus = params.requiresBrokerApproval ? "draft" : "scheduled"

    // INSERT social_posts — tenant fields are session-derived
    const { data: post, error: insertError } = await supabase
      .from("social_posts")
      .insert({
        brokerage_id: brokerageId,
        agent_id: effectiveAgentId,
        user_id: userId,
        platform: params.platform,
        post_type: params.postType,
        content: processedContent,
        media_urls: params.mediaUrls || [],
        hashtags: params.hashtags || [],
        scheduled_for: params.scheduledFor,
        social_account_id: params.socialAccountId,
        listing_id: params.listingId || null,
        status: initialStatus,
        approval_status: params.requiresBrokerApproval ? "pending" : "approved",
        brand_compliance_passed: null,
        ai_generated: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .maybeSingle()

    // If broker approval required, notify broker via notifications table
    if (params.requiresBrokerApproval && post) {
      const { data: brokerUsers } = await supabase
        .from("users")
        .select("id")
        .eq("brokerage_id", brokerageId)
        .in("user_type", ["broker", "admin"])
        .is("deleted_at", null)
        .limit(5)

      for (const broker of brokerUsers ?? []) {
        await supabase.from("notifications").insert({
          user_id: broker.id,
          brokerage_id: brokerageId,
          type: "social_post_pending_approval",
          title: "Social Post Awaiting Approval",
          body: `A new ${params.platform} post is pending your approval.`,
          entity_type: "social_post",
          entity_id: post.id,
          is_read: false,
          created_at: new Date().toISOString(),
        })
      }
    }

    if (insertError) {
      console.error("[social-media-automation] Insert error:", insertError)
      throw insertError
    }

    // Link to marketing campaign if provided
    if (params.campaignId && isValidUUID(params.campaignId)) {
      await supabase.from("marketing_assets").insert({
        brokerage_id: brokerageId,
        campaign_id: params.campaignId,
        asset_type: "social_post",
        asset_name: `${params.platform} - ${params.postType}`,
        source_table: "social_posts",
        source_id: post.id,
        approval_status: "pending",
        created_at: new Date().toISOString(),
      })
    }

    // Increment feature usage
    await incrementFeatureUsage(userId, "social_automation")
      .catch((err) => console.warn("[social-media-automation] Usage increment failed:", err))

    // Fire kernel event
    await supabase.from("lifecycle_events").insert({
      entity_type: "social_post",
      entity_id: post.id,
      brokerage_id: brokerageId,
      event_type: KernelEvent.SOCIAL_POST_SCHEDULED,
      metadata: {
        platform: params.platform,
        post_type: params.postType,
        scheduled_for: params.scheduledFor,
        listing_id: params.listingId,
        campaign_id: params.campaignId,
      },
    })

    await processKernelEvent({
      event: KernelEvent.SOCIAL_POST_SCHEDULED,
      brokerageId,
      entityType: "social_post",
      entityId: post.id,
    }).catch((err) => console.error("[social-media-automation] Kernel event failed:", err))

    revalidatePath("/dashboard/social")
    return { success: true, data: post }
  } catch (error: any) {
    console.error("[social-media-automation] Schedule post error:", error)
    return { success: false, error: error.message || "Failed to schedule post" }
  }
}

/**
 * Approve a social post
 */
export async function approveSocialPost(postId: string, _approverUserId?: string) {
  if (!isValidUUID(postId)) {
    return { success: false, error: "Invalid post ID" }
  }

  // approverUserId is IGNORED — always derived from session so callers can't
  // forge approvals on behalf of another user.
  const auth = await requireBrokerage()
  if (!auth.ok) return { success: false, error: auth.error }

  const ownsPost = await verifySocialPostInBrokerage(postId, auth.brokerageId)
  if (!ownsPost.ok) return { success: false, error: "Forbidden" }

  const supabase = await createClient()

  try {
    // Approval is the LAST HUMAN STOP — a draft/pending post must leave here
    // publishable, or the loop dead-ends: the publisher only picks up
    // status='scheduled' AND scheduled_for <= now, so approving without
    // scheduling silently strands the post forever.
    const { data: current, error: currentError } = await supabase
      .from("social_posts")
      .select("status, scheduled_for, user_id")
      .eq("id", postId)
      .eq("brokerage_id", auth.brokerageId)
      .maybeSingle()
    if (currentError) throw currentError
    // "pending_approval" was never a valid status, so this arm could never
    // match. Approval-pending posts are drafts; the gate is approval_status.
    const needsScheduling = current?.status === "draft"

    const { data: post, error } = await supabase
      .from("social_posts")
      .update({
        approval_status: "approved",
        approved_by: auth.userId,
        approved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...(needsScheduling && {
          status: "scheduled",
          scheduled_for: current?.scheduled_for ?? new Date().toISOString(),
        }),
      })
      .eq("id", postId)
      .eq("brokerage_id", auth.brokerageId)
      .select()
      .maybeSingle()

    if (error) throw error

    // TELL THE AUTHOR — ported 2026-09-03 from the deleted duplicate
    // app/actions/social-publishing.ts handleContentApproved (orphan doctrine
    // §1.1: the survivor gets what the duplicate had first). The recipient's
    // tenant is resolved from the RECIPIENT's users row, not copied from the
    // post: badge-counts computes the brokerage from the session user's row, so
    // a row stamped with any other value is filtered out as surely as an
    // unstamped one. Best-effort — the approval already landed.
    const recipientUserId = (current as { user_id?: string | null } | null)?.user_id ?? null
    if (recipientUserId) {
      const svc = createServiceClient()
      const approvalTenant = await resolveRecipientBrokerageId(svc, recipientUserId)
      if (!approvalTenant.ok) {
        console.error(`[social-media-automation] approveSocialPost: ${approvalTenant.reason} — approval notification NOT written`)
      } else if (!approvalTenant.brokerageId) {
        console.error(`[social-media-automation] approveSocialPost: post ${postId}'s author has no brokerage — approval notification NOT written rather than written where the bell cannot count it`)
      } else {
        const { error: approvalNotifyError } = await svc.from("notifications").insert({
          user_id: recipientUserId,
          brokerage_id: approvalTenant.brokerageId,
          type: "content_approved",
          title: "Content Approved",
          body: "Your social media content has been approved and is ready to publish.",
          entity_type: "social_post",
          entity_id: postId,
          created_at: new Date().toISOString(),
        })
        if (approvalNotifyError) {
          console.error("[social-media-automation] content_approved notification insert refused:", approvalNotifyError.message)
        }
      }
    }

    revalidatePath("/dashboard/social")
    return { success: true, data: post }
  } catch (error: any) {
    console.error("[social-media-automation] Approve post error:", error)
    return { success: false, error: error.message || "Failed to approve post" }
  }
}

/**
 * Reject a social post
 */
export async function rejectSocialPost(postId: string, _rejectorUserId?: string, reason?: string) {
  if (!isValidUUID(postId)) {
    return { success: false, error: "Invalid post ID" }
  }

  // rejectorUserId is IGNORED — always derived from session.
  const auth = await requireBrokerage()
  if (!auth.ok) return { success: false, error: auth.error }

  const ownsPost = await verifySocialPostInBrokerage(postId, auth.brokerageId)
  if (!ownsPost.ok) return { success: false, error: "Forbidden" }

  const supabase = await createClient()

  try {
    const { data: post, error } = await supabase
      .from("social_posts")
      .update({
        approval_status: "rejected",
        status: "cancelled",
        error_message: reason || "Rejected by approver",
        updated_at: new Date().toISOString(),
      })
      .eq("id", postId)
      .eq("brokerage_id", auth.brokerageId)
      .select()
      .maybeSingle()

    if (error) throw error

    revalidatePath("/dashboard/social")
    return { success: true, data: post }
  } catch (error: any) {
    console.error("[social-media-automation] Reject post error:", error)
    return { success: false, error: error.message || "Failed to reject post" }
  }
}

// ============================================
// QUEUE / DELIVERY READS
// ============================================
//
// LIVE VOCABULARIES (verified against project hrvaqgvukzxfskkcrwbt).
// These are the CHECK constraints on social_posts. A filter value outside them
// can never match a row, so a caller passing one used to get a silent empty
// list that reads as "you have no posts". They are rejected explicitly instead.
//   social_posts_status_check          → draft|scheduled|publishing|published|failed|cancelled
//   social_posts_approval_status_check → pending|approved|rejected
//   social_posts_platform_check        → facebook|instagram|linkedin|twitter|tiktok|
//                                        youtube|pinterest|google_business|all
// NOTE there is NO 'pending_approval' STATUS. Approval lives in its own column.
const SOCIAL_POST_STATUSES = [
  "draft", "scheduled", "publishing", "published", "failed", "cancelled",
] as const
const SOCIAL_APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const
const SOCIAL_PLATFORMS = [
  "facebook", "instagram", "linkedin", "twitter", "tiktok",
  "youtube", "pinterest", "google_business", "all",
] as const

/**
 * Get social queue with filters.
 *
 * The brokerage is resolved FROM THE SESSION. It used to be the first
 * positional argument, which made this a "use server" action that would read
 * whatever tenant the browser named.
 *
 * Returns a verdict, not a bare array: `[]` is indistinguishable from an RLS
 * denial, and rendering a refused read as "you have nothing scheduled" is the
 * failure mode this rail is most prone to.
 */
export async function getSocialQueue(filters?: {
  platform?: string
  status?: string
  agentId?: string
  approvalStatus?: string
  limit?: number
}): Promise<
  | { ok: true; posts: any[] }
  | { ok: false; error: string }
> {
  const ctx = await requireBrokerage()
  if (!ctx.ok) return { ok: false, error: ctx.error }

  if (filters?.platform && !(SOCIAL_PLATFORMS as readonly string[]).includes(filters.platform)) {
    return { ok: false, error: `Unsupported platform filter: ${filters.platform}` }
  }
  if (filters?.status && !(SOCIAL_POST_STATUSES as readonly string[]).includes(filters.status)) {
    return { ok: false, error: `Unsupported status filter: ${filters.status}` }
  }
  if (
    filters?.approvalStatus &&
    !(SOCIAL_APPROVAL_STATUSES as readonly string[]).includes(filters.approvalStatus)
  ) {
    return { ok: false, error: `Unsupported approval filter: ${filters.approvalStatus}` }
  }
  if (filters?.agentId) {
    if (!isValidUUID(filters.agentId)) return { ok: false, error: "Invalid agent id" }
    if (!(await verifyAgentInBrokerage(filters.agentId, ctx.brokerageId))) {
      return { ok: false, error: "That agent is not in this brokerage" }
    }
  }

  const supabase = await createClient()

  let query = supabase
    .from("social_posts")
    .select(
      `
      *,
      social_media_accounts (id, platform, account_name),
      social_engagement_tracking (*)
    `
    )
    .eq("brokerage_id", ctx.brokerageId)
    .order("scheduled_for", { ascending: true })
    .limit(Math.min(Math.max(filters?.limit ?? 200, 1), 500))

  if (filters?.platform) query = query.eq("platform", filters.platform)
  if (filters?.status) query = query.eq("status", filters.status)
  if (filters?.agentId) query = query.eq("agent_id", filters.agentId)
  if (filters?.approvalStatus) query = query.eq("approval_status", filters.approvalStatus)

  const { data, error } = await query

  if (error) {
    console.error("[social-media-automation] Get social queue error:", error)
    return { ok: false, error: error.message }
  }

  return { ok: true, posts: data ?? [] }
}

/**
 * Get the engagement measurement history for one post.
 * The post is confirmed to belong to the caller's brokerage first — a bare
 * postId over a user client leans on RLS, and social_engagement_tracking rows
 * are only reachable through their post.
 */
export async function getSocialEngagement(postId: string): Promise<
  | { ok: true; measurements: any[] }
  | { ok: false; error: string }
> {
  const ctx = await requireBrokerage()
  if (!ctx.ok) return { ok: false, error: ctx.error }
  if (!isValidUUID(postId)) return { ok: false, error: "Invalid post id" }

  const owned = await verifySocialPostInBrokerage(postId, ctx.brokerageId)
  if (!owned.ok) return { ok: false, error: "Post not found" }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("social_engagement_tracking")
    .select("*")
    .eq("social_post_id", postId)
    .eq("brokerage_id", ctx.brokerageId)
    .order("captured_at", { ascending: false })

  if (error) {
    console.error("[social-media-automation] Get engagement error:", error)
    return { ok: false, error: error.message }
  }

  return { ok: true, measurements: data ?? [] }
}

/**
 * Get the full publish-attempt log for one post.
 *
 * The dashboard page preloads logs for FAILED posts only; this is the
 * on-demand per-post history (every queue/publish/fail attempt, provider
 * response and error), for any post in the caller's brokerage.
 */
export async function getPublishLog(postId: string): Promise<
  | { ok: true; attempts: any[] }
  | { ok: false; error: string }
> {
  const ctx = await requireBrokerage()
  if (!ctx.ok) return { ok: false, error: ctx.error }
  if (!isValidUUID(postId)) return { ok: false, error: "Invalid post id" }

  const owned = await verifySocialPostInBrokerage(postId, ctx.brokerageId)
  if (!owned.ok) return { ok: false, error: "Post not found" }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("social_publish_log")
    .select("*")
    .eq("social_post_id", postId)
    .eq("brokerage_id", ctx.brokerageId)
    .order("created_at", { ascending: false })

  if (error) {
    console.error("[social-media-automation] Get publish log error:", error)
    return { ok: false, error: error.message }
  }

  return { ok: true, attempts: data ?? [] }
}

// ============================================
// AUTOMATED LISTING POSTS
// ============================================

export async function createListingPosts(params: {
  propertyId: string
  agentId: string
  brokerageId: string
  platforms: string[]
}) {
  if (!isValidUUID(params.agentId) || !isValidUUID(params.propertyId) || !isValidUUID(params.brokerageId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    // Fetch listing + first photo from listing_media for media_urls
    const { data: property } = await supabase
      .from("listings")
      .select("address, city, list_price, bedrooms, bathrooms, sqft")
      .eq("id", params.propertyId)
      .maybeSingle()

    // Get primary photo for the listing
    const { data: primaryMedia } = await supabase
      .from("listing_media")
      .select("file_url")
      .eq("listing_id", params.propertyId)
      .eq("is_primary", true)
      .eq("media_type", "photo")
      .maybeSingle()

    if (!property) {
      return { success: false, error: "Property not found" }
    }

    const results = []

    for (const platform of params.platforms) {
      // Get connected account for this platform
      const { data: account } = await supabase
        .from("social_media_accounts")
        .select("id")
        .eq("agent_id", params.agentId)
        .eq("platform", platform)
        .eq("is_active", true)
        .maybeSingle()

      if (!account) {
        results.push({ platform, success: false, error: `No connected ${platform} account` })
        continue
      }

      // Generate platform-optimized content
      const content = await generatePlatformContent({
        platform,
        property,
        agentId: params.agentId,
      })

      // Schedule post for optimal time
      const optimalTime = getOptimalPostingTime(platform)

      const result = await scheduleSocialPost({
        brokerageId: params.brokerageId,
        agentId: params.agentId,
        userId: params.agentId,
        platform,
        postType: "new_listing",
        content: content.text,
        mediaUrls: primaryMedia?.file_url ? [primaryMedia.file_url] : [],
        hashtags: content.hashtags,
        scheduledFor: optimalTime,
        socialAccountId: account.id,
        listingId: params.propertyId,
      })

      results.push({ platform, success: result.success, postId: result.data?.id })
    }

    return { success: true, data: results }
  } catch (error) {
    console.error("[social-media-automation] Create listing posts error:", error)
    return { success: false, error: "Failed to create listing posts" }
  }
}

async function generatePlatformContent(params: { platform: string; property: any; agentId: string }) {
  const platformSpecs: Record<string, any> = {
    facebook: { maxLength: 500, style: "conversational", hashtagCount: 3 },
    instagram: { maxLength: 2200, style: "visual-first", hashtagCount: 20 },
    linkedin: { maxLength: 1300, style: "professional", hashtagCount: 5 },
    twitter: { maxLength: 280, style: "concise", hashtagCount: 2 },
    tiktok: { maxLength: 150, style: "casual", hashtagCount: 5 },
    youtube: { maxLength: 5000, style: "detailed", hashtagCount: 10 },
    pinterest: { maxLength: 500, style: "descriptive", hashtagCount: 5 },
  }

  const spec = platformSpecs[params.platform] || platformSpecs.facebook

  const prompt = `Create ${params.platform} post for this property listing:

Address: ${params.property.address}
Price: $${params.property.list_price?.toLocaleString() || params.property.price?.toLocaleString()}
Beds: ${params.property.bedrooms} | Baths: ${params.property.bathrooms}
SqFt: ${params.property.sqft || params.property.square_feet}

PLATFORM: ${params.platform}
Max Length: ${spec.maxLength} characters
Style: ${spec.style}
Hashtags: ${spec.hashtagCount}

OUTPUT FORMAT (JSON):
{
  "text": "engaging post text",
  "hashtags": ["RealEstate", "HomesForSale"]
}`

  try {
    const response = await generateAIResponse({
      prompt,
      metadata: {
        userId: params.agentId,
        brokerageId: "system",
        agentId: params.agentId,
        feature: "social_post_generation",
      },
    })

    return parseAIJsonResponse(response.text)
  } catch (error) {
    // Fallback content
    return {
      text: `Just Listed! Beautiful ${params.property.bedrooms}BR/${params.property.bathrooms}BA home in ${params.property.city || "your area"}. Contact me for a showing!`,
      hashtags: ["RealEstate", "JustListed", "HomesForSale"],
    }
  }
}

function getOptimalPostingTime(platform: string): string {
  const optimalTimes: Record<string, { hour: number; day: string }> = {
    facebook: { hour: 13, day: "wednesday" },
    instagram: { hour: 11, day: "tuesday" },
    linkedin: { hour: 9, day: "tuesday" },
    twitter: { hour: 12, day: "wednesday" },
    tiktok: { hour: 19, day: "thursday" },
    youtube: { hour: 14, day: "friday" },
    pinterest: { hour: 20, day: "saturday" },
  }

  const time = optimalTimes[platform] || { hour: 14, day: "tuesday" }
  const today = new Date()
  const daysUntilOptimal = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(time.day)
  const daysToAdd = (daysUntilOptimal - today.getDay() + 7) % 7 || 7

  const scheduledDate = new Date(today)
  scheduledDate.setDate(today.getDate() + daysToAdd)
  scheduledDate.setHours(time.hour, 0, 0, 0)

  return scheduledDate.toISOString()
}

// ============================================
// PERFORMANCE ANALYTICS
// ============================================

/** A measured engagement snapshot. Every field is optional: an unsupplied
 *  metric is LEFT ALONE, never written as 0. Zeroing an unknown is how a
 *  platform that does not expose "saves" ends up asserting there were none. */
export interface PostEngagementMetrics {
  impressions?: number | null
  likes?: number | null
  comments?: number | null
  shares?: number | null
  saves?: number | null
  clicks?: number | null
  leads?: number | null
}

const METRIC_COLUMNS: Array<[keyof PostEngagementMetrics, string]> = [
  ["impressions", "impressions_count"],
  ["likes", "likes_count"],
  ["comments", "comments_count"],
  ["shares", "shares_count"],
  ["saves", "saves_count"],
  ["clicks", "clicks_count"],
  ["leads", "leads_generated"],
]

/**
 * Record a measured engagement snapshot for one post.
 *
 * THREE THINGS WERE WRONG HERE AND ARE FIXED:
 *  1. brokerageId came from the caller. social_engagement_tracking.brokerage_id
 *     is NOT NULL and its RLS policy is a strict equality, but a "use server"
 *     action must not take the tenant from the browser at all. Session now.
 *  2. `.upsert(...)` with no onConflict. social_engagement_tracking's only
 *     unique constraint is its PRIMARY KEY on `id` (verified live) and `id` is
 *     never supplied, so every "upsert" INSERTED A NEW ROW. The dashboard reads
 *     social_engagement_tracking[0] — an arbitrary one of those duplicates.
 *     There is one current-state row per (post, platform) now, kept by an
 *     explicit read-then-update-or-insert. No DDL required.
 *  3. The write result was discarded and `{ success: true }` returned
 *     unconditionally, so an RLS refusal reported as a save.
 */
export async function trackPostPerformance(
  postId: string,
  metrics: PostEngagementMetrics
): Promise<{ success: boolean; error?: string; measurement?: any }> {
  const ctx = await requireBrokerage()
  if (!ctx.ok) return { success: false, error: ctx.error }
  if (!isValidUUID(postId)) return { success: false, error: "Invalid post id" }

  const supabase = await createClient()

  // Resolve platform from the post, and confirm the post is this tenant's.
  const { data: post, error: postError } = await supabase
    .from("social_posts")
    .select("id, platform, brokerage_id")
    .eq("id", postId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()

  if (postError) {
    console.error("[social-media-automation] Track performance post read error:", postError)
    return { success: false, error: postError.message }
  }
  // platform is NOT NULL on both tables; there is no honest "unknown" fallback.
  if (!post?.platform) return { success: false, error: "Post not found" }

  const patch: Record<string, unknown> = { captured_at: new Date().toISOString() }
  for (const [key, column] of METRIC_COLUMNS) {
    const value = metrics[key]
    if (value === undefined || value === null) continue
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0) {
      return { success: false, error: `Invalid value for ${String(key)}` }
    }
    patch[column] = Math.round(n)
  }
  if (Object.keys(patch).length === 1) {
    return { success: false, error: "No metrics supplied" }
  }

  const { data: existing, error: existingError } = await supabase
    .from("social_engagement_tracking")
    .select("id")
    .eq("social_post_id", postId)
    .eq("brokerage_id", ctx.brokerageId)
    .eq("platform", post.platform)
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existingError) {
    console.error("[social-media-automation] Track performance read error:", existingError)
    return { success: false, error: existingError.message }
  }

  const written = existing
    ? await supabase
        .from("social_engagement_tracking")
        .update(patch)
        .eq("id", (existing as { id: string }).id)
        .eq("brokerage_id", ctx.brokerageId)
        .select()
        .maybeSingle()
    : await supabase
        .from("social_engagement_tracking")
        .insert({
          social_post_id: postId,
          brokerage_id: ctx.brokerageId,
          platform: post.platform,
          ...patch,
        })
        .select()
        .maybeSingle()

  if (written.error) {
    console.error("[social-media-automation] Track performance write error:", written.error)
    return { success: false, error: written.error.message }
  }
  // A filtered update that matched nothing is not an error to PostgREST.
  if (!written.data) return { success: false, error: "Measurement was not saved" }

  revalidatePath("/dashboard/social")
  return { success: true, measurement: written.data }
}

/**
 * Pull the latest REAL platform measurement for one post into the engagement
 * table the social dashboard renders.
 *
 * PROVENANCE: the numbers come from social_media_analytics, which is written
 * ONLY by lib/social/analytics-sync.ts:syncSocialAnalytics — the nightly cron
 * (/api/cron/social-analytics-sync, 07:45 UTC) that calls each platform's own
 * API with the tenant's stored token. Nothing here contacts a platform, invents
 * a number, or substitutes a zero for a metric a platform did not report.
 *
 * Why this exists: social_engagement_tracking is what the dashboard post cards
 * read, and its only other writer is the publish cron's initial all-zero row —
 * so those cards showed a permanent 0/0/0/0. This projects the measured row
 * across. `engagements` has no column of its own here and is returned for
 * display rather than being split into fabricated likes/comments/shares.
 */
export async function refreshPostEngagementFromSync(postId: string): Promise<{
  success: boolean
  error?: string
  reason?: "no_measurement"
  measuredAt?: string
  engagements?: number | null
  measurement?: any
}> {
  const ctx = await requireBrokerage()
  if (!ctx.ok) return { success: false, error: ctx.error }
  if (!isValidUUID(postId)) return { success: false, error: "Invalid post id" }

  const supabase = await createClient()

  const { data: synced, error: syncedError } = await supabase
    .from("social_media_analytics")
    .select("impressions, engagements, clicks, measured_at")
    .eq("post_id", postId)
    .eq("brokerage_id", ctx.brokerageId)
    .order("measured_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (syncedError) {
    console.error("[social-media-automation] Synced metric read error:", syncedError)
    return { success: false, error: syncedError.message }
  }
  if (!synced) {
    return {
      success: false,
      reason: "no_measurement",
      error:
        "No platform measurement recorded for this post yet. The analytics sync runs nightly and only covers posts published with a real platform post id.",
    }
  }

  const result = await trackPostPerformance(postId, {
    impressions: synced.impressions,
    clicks: synced.clicks,
  })
  if (!result.success) return { success: false, error: result.error }

  return {
    success: true,
    measuredAt: synced.measured_at as string,
    engagements: (synced.engagements as number | null) ?? null,
    measurement: result.measurement,
  }
}

export async function getSocialMediaAnalytics(
  _brokerageId?: string, // ignored — a "use server" action must not take its tenant from the browser
  dateRange?: { start: string; end: string }
) {
  const ctx = await requireBrokerage()
  if (!ctx.ok) return null
  const brokerageId = ctx.brokerageId

  const supabase = await createClient()

  try {
    let query = supabase
      .from("social_posts")
      .select("*, engagement:social_engagement_tracking(*)")
      .eq("brokerage_id", brokerageId)
      .eq("status", "published")

    // Per-user scoping merged in from the retired social-publishing reader: an
    // ordinary agent sees their own posts' performance, leadership sees the
    // brokerage's.
    if (!seesAllBrokeragePosts(ctx.userType)) {
      query = query.eq("user_id", ctx.userId)
    }

    if (dateRange?.start) {
      query = query.gte("published_at", dateRange.start)
    }
    if (dateRange?.end) {
      query = query.lte("published_at", dateRange.end)
    }

    const { data: posts } = await query

    const totalPosts = posts?.length || 0

    // REAL synced platform metrics (lib/social/analytics-sync.ts writes
    // social_media_analytics, keyed on post_id). The legacy
    // social_engagement_tracking rows are often empty — when a synced
    // measurement exists for a post it WINS for impressions/engagement/clicks,
    // so the tenant dashboard shows what the platforms actually reported.
    const syncedByPost = new Map<string, { impressions: number; engagements: number; clicks: number }>()
    if (totalPosts > 0) {
      const { data: syncedRows } = await supabase
        .from("social_media_analytics")
        .select("post_id, impressions, engagements, clicks")
        .eq("brokerage_id", brokerageId)
        .in("post_id", (posts ?? []).map((p) => p.id))
      for (const r of (syncedRows ?? []) as Array<{ post_id: string; impressions: number | null; engagements: number | null; clicks: number | null }>) {
        syncedByPost.set(r.post_id, {
          impressions: r.impressions ?? 0,
          engagements: r.engagements ?? 0,
          clicks: r.clicks ?? 0,
        })
      }
    }

    // Aggregate engagement metrics
    let totalImpressions = 0
    let totalLikes = 0
    let totalComments = 0
    let totalShares = 0
    let totalClicks = 0
    let totalLeads = 0
    let totalEngagement = 0

    const platformBreakdown: Record<string, { posts: number; impressions: number; engagement: number }> = {}

    posts?.forEach((post) => {
      const engagement = Array.isArray(post.engagement) ? post.engagement[0] : post.engagement
      const synced = syncedByPost.get(post.id)

      const trackedEngagement =
        (engagement?.likes_count || 0) +
        (engagement?.comments_count || 0) +
        (engagement?.shares_count || 0)
      const postImpressions = synced ? synced.impressions : engagement?.impressions_count || 0
      const postEngagement = synced && synced.engagements > 0 ? synced.engagements : trackedEngagement
      const postClicks = synced && synced.clicks > 0 ? synced.clicks : engagement?.clicks_count || 0

      totalImpressions += postImpressions
      totalLikes += engagement?.likes_count || 0
      totalComments += engagement?.comments_count || 0
      totalShares += engagement?.shares_count || 0
      totalClicks += postClicks
      totalLeads += engagement?.leads_generated || 0
      totalEngagement += postEngagement

      if (!platformBreakdown[post.platform]) {
        platformBreakdown[post.platform] = { posts: 0, impressions: 0, engagement: 0 }
      }
      platformBreakdown[post.platform].posts++
      platformBreakdown[post.platform].impressions += postImpressions
      platformBreakdown[post.platform].engagement += postEngagement
    })
    const avgEngagementRate = totalImpressions > 0 ? (totalEngagement / totalImpressions) * 100 : 0

    const topPosts =
      posts
        ?.sort((a, b) => {
          const aEng = Array.isArray(a.engagement) ? a.engagement[0] : a.engagement
          const bEng = Array.isArray(b.engagement) ? b.engagement[0] : b.engagement
          return ((bEng?.likes_count || 0) + (bEng?.comments_count || 0)) -
                 ((aEng?.likes_count || 0) + (aEng?.comments_count || 0))
        })
        .slice(0, 5) || []

    return {
      totalPosts,
      totalImpressions,
      totalEngagement,
      totalLikes,
      totalComments,
      totalShares,
      totalClicks,
      totalLeads,
      avgEngagementRate,
      topPosts,
      platformBreakdown,
    }
  } catch (error) {
    console.error("[social-media-automation] Get analytics error:", error)
    return null
  }
}

// ============================================
// POST LIFECYCLE — RETRY, DELETE, RESCHEDULE, EDIT
// ============================================

/**
 * Retry a failed post — resets status to 'scheduled' and clears error_message.
 * Increments an error_count column (added via migration) for circuit-breaker tracking.
 */
export async function retryFailedPost(postId: string, userId: string) {
  if (!isValidUUID(postId) || !isValidUUID(userId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    const { data: post, error } = await supabase
      .from("social_posts")
      .update({
        status: "scheduled",
        error_message: null,
        approval_status: "pending",
        updated_at: new Date().toISOString(),
      })
      .eq("id", postId)
      .eq("status", "failed") // only retry truly failed posts
      .select()
      .maybeSingle()

    if (error) throw error
    if (!post) return { success: false, error: "Post not found or not in failed state" }

    // Log the retry attempt
    await supabase.from("social_publish_log").insert({
      social_post_id: postId,
      brokerage_id: post.brokerage_id,
      platform: post.platform,
      account_id: post.social_account_id,
      publish_status: "queued",
      created_at: new Date().toISOString(),
    })

    await supabase.from("lifecycle_events").insert({
      entity_type: "social_post",
      entity_id: postId,
      brokerage_id: post.brokerage_id,
      event_type: "social_post_retry_queued",
      actor_user_id: userId,
      metadata: { retried_at: new Date().toISOString() },
    })

    revalidatePath("/dashboard/social")
    return { success: true, data: post }
  } catch (error: any) {
    console.error("[social-media-automation] Retry post error:", error)
    return { success: false, error: error.message || "Failed to retry post" }
  }
}

/**
 * Soft-delete a social post — sets status to 'cancelled' and records actor.
 * Does NOT hard-delete the row so publish logs are preserved.
 */
export async function deleteSocialPost(postId: string, userId: string) {
  if (!isValidUUID(postId) || !isValidUUID(userId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    const { data: post, error } = await supabase
      .from("social_posts")
      .update({
        status: "cancelled",
        updated_at: new Date().toISOString(),
      })
      .eq("id", postId)
      .in("status", ["draft", "scheduled", "failed", "cancelled"])
      .select("id, brokerage_id, platform, status")
      .maybeSingle()

    if (error) throw error
    if (!post) return { success: false, error: "Post not found or already published — cannot delete" }

    await supabase.from("lifecycle_events").insert({
      entity_type: "social_post",
      entity_id: postId,
      brokerage_id: post.brokerage_id,
      event_type: "social_post_deleted",
      actor_user_id: userId,
      metadata: { deleted_at: new Date().toISOString() },
    })

    revalidatePath("/dashboard/social")
    return { success: true }
  } catch (error: any) {
    console.error("[social-media-automation] Delete post error:", error)
    return { success: false, error: error.message || "Failed to delete post" }
  }
}

/**
 * Update an existing draft or scheduled post's content, hashtags, or platform.
 * Cannot edit published or failed posts.
 */
export async function updateSocialPost(params: {
  postId: string
  userId: string
  content?: string
  hashtags?: string[]
  mediaUrls?: string[]
  platform?: string
  postType?: string
  scheduledFor?: string
}) {
  if (!isValidUUID(params.postId) || !isValidUUID(params.userId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    const updatePayload: Record<string, any> = { updated_at: new Date().toISOString() }
    if (params.content    !== undefined) updatePayload.content      = params.content
    if (params.hashtags   !== undefined) updatePayload.hashtags     = params.hashtags
    if (params.mediaUrls  !== undefined) updatePayload.media_urls   = params.mediaUrls
    if (params.platform   !== undefined) updatePayload.platform     = params.platform
    if (params.postType   !== undefined) updatePayload.post_type    = params.postType
    if (params.scheduledFor !== undefined) updatePayload.scheduled_for = params.scheduledFor

    const { data: post, error } = await supabase
      .from("social_posts")
      .update(updatePayload)
      .eq("id", params.postId)
      .in("status", ["draft", "scheduled"]) // only editable statuses
      .select()
      .maybeSingle()

    if (error) throw error
    if (!post) return { success: false, error: "Post not found or not editable" }

    revalidatePath("/dashboard/social")
    return { success: true, data: post }
  } catch (error: any) {
    console.error("[social-media-automation] Update post error:", error)
    return { success: false, error: error.message || "Failed to update post" }
  }
}

/**
 * Reschedule an existing post to a new datetime.
 */
export async function rescheduleSocialPost(postId: string, userId: string, newScheduledFor: string) {
  return updateSocialPost({ postId, userId, scheduledFor: newScheduledFor })
}
