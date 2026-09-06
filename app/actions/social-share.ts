"use server"

// app/actions/social-share.ts
// Layer 9.2 Social Media Automation — Agent Social Share Actions
// Tables: social_posts, agent_social_shares

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { canAccessFeature } from "@/lib/kernel/0.1-feature-access"
import { getAgentContext } from "@/lib/identity/get-agent-context"

// ============================================
// AGENT SOCIAL SHARE
// ============================================

/**
 * Share a listing post as an agent
 * Guards: approval_status MUST be 'approved' AND brand_compliance_passed MUST be true
 */
export async function shareListingPost(params: {
  socialPostId: string
  agentUserId: string
  sharePlatform: string
  shareVariantText?: string
  brokerageId: string
}) {
  // Validate UUIDs
  if (!isValidUUID(params.socialPostId)) {
    return { success: false, error: "Invalid social post ID" }
  }
  if (!isValidUUID(params.agentUserId)) {
    return { success: false, error: "Invalid agent user ID" }
  }
  if (!isValidUUID(params.brokerageId)) {
    return { success: false, error: "Invalid brokerage ID" }
  }

  // Feature access check
  const canAccess = await canAccessFeature(params.agentUserId, "social_automation")

  if (!canAccess.allowed) {
    return { success: false, error: "Feature not available for your subscription tier" }
  }

  const supabase = await createClient()

  try {
    // Fetch the social post with guards
    const { data: post, error: postError } = await supabase
      .from("social_posts")
      .select("*")
      .eq("id", params.socialPostId)
      .eq("brokerage_id", params.brokerageId)
      .single()

    if (postError || !post) {
      return { success: false, error: "Social post not found" }
    }

    // Guard: Must be approved
    if (post.approval_status !== "approved") {
      return {
        success: false,
        error: "Cannot share: Post must be approved before sharing",
      }
    }

    // Guard: Must pass brand compliance
    if (post.brand_compliance_passed !== true) {
      return {
        success: false,
        error: "Cannot share: Post must pass brand compliance check",
      }
    }

    // Insert agent social share record
    const { data: share, error: shareError } = await supabase
      .from("agent_social_shares")
      .insert({
        social_post_id: params.socialPostId,
        agent_user_id: params.agentUserId,
        share_platform: params.sharePlatform,
        share_variant_text: params.shareVariantText || null,
        brokerage_id: params.brokerageId,
        shared_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (shareError) {
      console.error("[social-share] Error inserting agent share:", shareError)
      throw shareError
    }

    // Fire kernel event
    await supabase.from("lifecycle_events").insert({
      entity_type: "agent_social_share",
      entity_id: share.id,
      brokerage_id: params.brokerageId,
      event_type: KernelEvent.SOCIAL_POST_SHARED_BY_AGENT,
      metadata: {
        social_post_id: params.socialPostId,
        agent_user_id: params.agentUserId,
        share_platform: params.sharePlatform,
        original_platform: post.platform,
        listing_id: post.listing_id,
      },
    })

    await processKernelEvent({
      event: KernelEvent.SOCIAL_POST_SHARED_BY_AGENT,
      brokerageId: params.brokerageId,
      entityType: "agent_social_share",
      entityId: share.id,
    }).catch((err) =>
      console.error("[social-share] Kernel event failed:", err)
    )

    revalidatePath("/dashboard/social")
    return { success: true, data: share }
  } catch (error: any) {
    console.error("[social-share] shareListingPost error:", error)
    return { success: false, error: error.message || "Failed to share post" }
  }
}

/**
 * Get the calling agent's share history.
 *
 * GATED + SESSION-SCOPED (was neither). `"use server"` with **no session**, and
 * both scoping keys — `agentUserId` and `brokerageId` — supplied by the caller.
 * A pair of uuids read any agent's social publishing history in any brokerage.
 * The `isValidUUID` checks looked protective but only assert *shape*: a
 * well-formed uuid belonging to someone else passed them cleanly.
 *
 * Both keys now come from the session. `agent_social_shares.agent_user_id` is a
 * **users** id (not `agents.id`) — the column name says so and the join keys
 * confirm it — so `ctx.userId` is the correct value here. That distinction is not
 * cosmetic in this codebase: the two id spaces are disjoint, so substituting one
 * for the other yields a valid query that silently matches nothing.
 */
export async function getAgentShareHistory(params?: {
  /** Ignored — derived from the session. */
  agentUserId?: string
  /** Ignored — derived from the session. */
  brokerageId?: string
  limit?: number
}) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.userId || !ctx.brokerageId) return []

  const limit = Math.min(Math.max(Math.trunc(params?.limit ?? 50) || 50, 1), 200)

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("agent_social_shares")
    .select(
      `
      *,
      social_posts (
        id, platform, post_type, content, media_urls,
        published_at, status, listing_id
      )
    `
    )
    .eq("agent_user_id", ctx.userId)
    .eq("brokerage_id", ctx.brokerageId)
    .order("shared_at", { ascending: false })
    .limit(limit)

  if (error) {
    console.error("[social-share] getAgentShareHistory error:", error)
    return []
  }

  return data || []
}

/**
 * Check if the calling agent may share a specific post.
 *
 * GATED + SESSION-SCOPED (was neither). **This is a compliance gate**, so its
 * failure modes matter more than a read's: it is what decides whether a post that
 * has not passed brand compliance or broker approval may go out under the
 * brokerage's name.
 *
 * Two problems, both now closed:
 *  - `brokerageId` came from the caller, so the tenant a post was checked against
 *    was chosen by whoever asked.
 *  - There was no session at all, so an anonymous caller could enumerate posts.
 *
 * It already **fails closed** on a refused or empty read (`error || !post` →
 * `canShare: false`), which is the correct direction for a gate and is preserved
 * — this is the exact shape that went the wrong way in the wave-1
 * `checkSuppression` finding, so it is called out here rather than left implicit.
 * The refusal reason is now distinguished from "no such post" for the operator's
 * sake, without changing the verdict.
 */
export async function canAgentSharePost(params: {
  socialPostId: string
  /** Ignored — derived from the session. */
  brokerageId?: string
}): Promise<{ canShare: boolean; reason?: string }> {
  if (!isValidUUID(params.socialPostId)) {
    return { canShare: false, reason: "Invalid parameters" }
  }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { canShare: false, reason: "Not authenticated" }
  }

  const supabase = await createClient()

  const { data: post, error } = await supabase
    .from("social_posts")
    .select("approval_status, brand_compliance_passed, status")
    .eq("id", params.socialPostId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()

  // Fail CLOSED on either outcome, but do not report a refused read as a missing
  // post — an operator debugging a permissions problem needs to see the
  // difference.
  if (error) {
    return { canShare: false, reason: "Could not verify this post's approval state" }
  }
  if (!post) {
    return { canShare: false, reason: "Post not found" }
  }

  if (post.approval_status !== "approved") {
    return { canShare: false, reason: "Post not approved" }
  }

  if (post.brand_compliance_passed !== true) {
    return { canShare: false, reason: "Post failed brand compliance" }
  }

  return { canShare: true }
}
