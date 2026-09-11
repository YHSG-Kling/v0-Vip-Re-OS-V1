"use server"

import { createServerClient } from "@/lib/supabase/server"
// The ONE way a notifications row gets its tenant — the recipient's
// users.brokerage_id, the exact value badge-counts compares against.
import { resolveRecipientBrokerageId } from "@/lib/notifications/recipient-tenant"

// =====================================================
// VIDEO CONTENT GENERATION SERVER ACTIONS
// AI-powered video script and content creation
// =====================================================

// ── DELETED: generateVideoScript (wave 57, Task B duplicates round 2) ──────
//
// SURVIVOR: app/actions/video/generate-script.ts:141 generateVideoScript —
// the canonical Video Studio generator (behind /dashboard/videos/create),
// documented by lib/kernel/manager-registry.ts video_script_compliance /
// video_repurpose_render_writers as the most complete of the FIVE audited
// generateVideoScript implementations: compliance gate before AND after
// generation (lib/video/script-compliance.ts — brand voice, ThemFirst, Fair
// Housing), saveToLibrary, nine video types mapped through
// toLibraryScriptType against the live five-value CHECK. This was a SIXTH,
// unaudited copy — scripts/video-script-compliance-guard.ts's enumerated
// five never named it, so it carried NO compliance gate at all on
// agent-facing marketing copy, the exact hole §5's "compliance-first" ruling
// exists to close.
//
// Zero live callers: reachable only through lib/orchestrator/internal.ts's
// dynamic import of this module, and that import names
// handleVideoGenerated / approveAndGenerateVideo / handleVideoPublished /
// handleHighEngagement (all four kept below — real event-reactor handlers) —
// never generateVideoScript. No page, component, or route named it.
//
// NOT BLINDLY MERGED: this copy carried a feature-tier gate
// (canAccessFeature/incrementFeatureUsage on the "video_generation" key,
// verified live as enabled/unlimited on all four tiers today — a no-op
// currently) that the survivor does not have of its own; the survivor's
// AI call instead routes through generateAIResponse -> resolveAIModel,
// which the survivor's own comment says "applies brokerage tier caps
// automatically" — whether that is an equivalent control or a real gap is
// UNRESOLVED (needs a follow-up read of resolveAIModel's tier-cap logic
// against feature_flags before touching the most-used video action in the
// tree without the full guard chain to verify against).

// =====================================================
// EVENT HANDLERS - Called by orchestrator
// =====================================================

export async function handleVideoGenerated(payload: any) {
  const supabase = await createServerClient()
  const { video_id, video_type, listing_id, user_id } = payload

  // Create notification for agent to review.
  //
  // TENANT — the RECIPIENT's `users.brokerage_id`, the one resolver (see
  // lib/notifications/recipient-tenant.ts). `user_id` here is a users.id; the
  // `agents.id` this file resolves elsewhere via requireAgentId is a DISJOINT
  // space and is never substituted for it.
  if (user_id) {
    const readyTenant = await resolveRecipientBrokerageId(supabase, user_id)
    if (!readyTenant.ok) {
      console.error(`[video-content] handleVideoGenerated: ${readyTenant.reason} — video_ready notification NOT written`)
    } else if (!readyTenant.brokerageId) {
      console.error(
        `[video-content] handleVideoGenerated: recipient ${user_id} has no brokerage — video_ready notification NOT written rather than written where the bell cannot count it`,
      )
    } else {
      const { error: readyNotifyError } = await supabase.from("notifications").insert({
        user_id: user_id,
        brokerage_id: readyTenant.brokerageId,
        type: "video_ready",
        title: "Video Ready for Review",
        body: `Your ${video_type} video is ready. Review and publish when ready.`,
        entity_type: "video",
        entity_id: video_id,
      })
      if (readyNotifyError) {
        console.error("[video-content] video_ready notification insert refused:", readyNotifyError.message)
      }
    }
  }

  return { success: true }
}

export async function approveAndGenerateVideo(payload: any) {
  const supabase = await createServerClient()
  const { script_id, video_id, user_id } = payload

  // Update script status
  await supabase
    .from("video_scripts_library")
    .update({
      approval_status: "approved",
      approved_by: user_id,
      approved_at: new Date().toISOString(),
    })
    .eq("id", script_id)

  // Update render lifecycle on the project (ai_video_projects), not the stock library.
  if (video_id) {
    await supabase
      .from("ai_video_projects")
      .update({ status: "generating" })
      .eq("id", video_id)
  }

  return { success: true }
}

export async function handleVideoPublished(payload: any) {
  const supabase = await createServerClient()
  const { video_id, platforms, user_id } = payload

  // Update publish state on the project (ai_video_projects). published_platforms
  // has no canonical column; the platforms list is carried in the payload/notification.
  await supabase
    .from("ai_video_projects")
    .update({
      status: "published",
      is_published: true,
      published_at: new Date().toISOString(),
    })
    .eq("id", video_id)

  // Create celebration notification. TENANT: the RECIPIENT's
  // `users.brokerage_id` — the one resolver.
  if (user_id) {
    const publishedTenant = await resolveRecipientBrokerageId(supabase, user_id)
    if (!publishedTenant.ok) {
      console.error(`[video-content] handleVideoPublished: ${publishedTenant.reason} — video_published notification NOT written`)
    } else if (!publishedTenant.brokerageId) {
      console.error(
        `[video-content] handleVideoPublished: recipient ${user_id} has no brokerage — video_published notification NOT written rather than written where the bell cannot count it`,
      )
    } else {
      const { error: publishedNotifyError } = await supabase.from("notifications").insert({
        user_id: user_id,
        brokerage_id: publishedTenant.brokerageId,
        type: "video_published",
        title: "Video Published!",
        body: `Your video has been published to ${platforms?.join(", ") || "your channels"}.`,
        entity_type: "video",
        entity_id: video_id,
      })
      if (publishedNotifyError) {
        console.error("[video-content] video_published notification insert refused:", publishedNotifyError.message)
      }
    }
  }

  return { success: true }
}

export async function handleHighEngagement(payload: any) {
  const supabase = await createServerClient()
  const { video_id, engagement_type, engagement_count, user_id } = payload

  // Create notification for high engagement. TENANT: the RECIPIENT's
  // `users.brokerage_id` — the one resolver. Note the `agents` read further down
  // in this same function yields an `agents.brokerage_id`; it is deliberately NOT
  // reused here, because the badge reader compares against the users row.
  if (user_id) {
    const engagementTenant = await resolveRecipientBrokerageId(supabase, user_id)
    if (!engagementTenant.ok) {
      console.error(`[video-content] handleHighEngagement: ${engagementTenant.reason} — video_engagement notification NOT written`)
    } else if (!engagementTenant.brokerageId) {
      console.error(
        `[video-content] handleHighEngagement: recipient ${user_id} has no brokerage — video_engagement notification NOT written rather than written where the bell cannot count it`,
      )
    } else {
      const { error: engagementNotifyError } = await supabase.from("notifications").insert({
        user_id: user_id,
        brokerage_id: engagementTenant.brokerageId,
        type: "video_engagement",
        title: "Video Performing Well!",
        body: `Your video has ${engagement_count} ${engagement_type}. Great job!`,
        entity_type: "video",
        entity_id: video_id,
      })
      if (engagementNotifyError) {
        console.error("[video-content] video_engagement notification insert refused:", engagementNotifyError.message)
      }
    }
  }

  // Create task to engage with comments if applicable
  if (engagement_type === "comments" && engagement_count > 5) {
    // tasks.brokerage_id is NOT NULL (pass 5) — resolve it with the assignee.
    const { data: agentRow } = await supabase
      .from("agents").select("id, brokerage_id").eq("user_id", user_id).maybeSingle()
    if (agentRow?.id && agentRow?.brokerage_id) {
      await supabase.from("tasks").insert({
        brokerage_id: agentRow.brokerage_id,
        assigned_to_agent_id: agentRow.id,
        title: "Respond to video comments",
        description: `Your video has ${engagement_count} comments. Engage with your audience!`,
        due_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        priority: "medium",
      })
    }
  }

  return { success: true }
}

// TOMBSTONE (orphan tranche 3): createShortClip deleted — a video_snippets
// writer no surface called. The live survivor is
// app/actions/video-repurposing.ts:createVideoSnippet, wired from the snippet
// wizard and repurpose dashboard, and strictly more complete: it stamps the
// caller's brokerage after verifying the source project/asset belongs to it
// (this one wrote no tenant at all), validates platform_target against
// PLATFORM_CONFIGS, enforces end > start and per-platform duration limits,
// and auto-derives the aspect ratio.
