"use server"

import { createServerClient } from "@/lib/supabase/server"
// TOMBSTONE (dead-import tranche): `agentIdForUser` (lib/agents/agent-for-user.ts:13)
// was imported here and never called. Survivor: `resolveAgentId`
// (lib/kernel/agent-identity.ts:43), which runs the identical query and is the
// safer one (`.order().limit(1)` rather than `.maybeSingle()`, which ERRORS when
// a user has more than one agents row).
// UPDATE (wave 26): this file no longer calls `resolveAgentId` directly either —
// its one site needed the agent profile to EXIST, so it now uses
// `requireAgentId` (lib/kernel/agent-identity.ts:113), the throwing wrapper over
// that same resolver, instead of re-implementing the throw inline (§6).
import { toLibraryScriptType } from "@/app/types/video-generation"
import { logVideoGenerated } from "@/lib/events"
import { generateAIResponse } from "@/lib/ai"
import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
// TOMBSTONE (dead-import tranche): `resolveProvider` (lib/kernel/providers.ts:85)
// was imported and never called — this file dispatches no provider itself. The
// VIDEO provider is resolved by `resolveVideoProvider`
// (lib/marketing/video-provider-resolver.ts, called from
// app/actions/video/create-video-project.ts:669) and the AI provider is chosen
// inside `generateAIResponse` (lib/ai). Nothing was lost.
import { requireAgentId } from "@/lib/kernel/agent-identity"
// TOMBSTONE (dead-import tranche): `KernelEvent` / `processKernelEvent` were
// imported and never called. This file's lifecycle emission goes through
// `logVideoGenerated` (lib/events/event-helpers.ts:145 → logEventAndTrigger:29,
// which inserts lifecycle_events and fires the registered orchestrator
// dispatcher, lib/orchestrator/internal.ts:1109), and its notifications are
// written directly by handleVideoGenerated / handleVideoPublished /
// handleHighEngagement below. Both halves already exist; a second rail here
// would have double-notified.
// The ONE way a notifications row gets its tenant — the recipient's
// users.brokerage_id, the exact value badge-counts compares against.
import { resolveRecipientBrokerageId } from "@/lib/notifications/recipient-tenant"

// =====================================================
// VIDEO CONTENT GENERATION SERVER ACTIONS
// AI-powered video script and content creation
// =====================================================

// Map a free-form video_type onto the video_scripts_library.script_type CHECK
// (property_tour|buyer_education|market_update|agent_intro|listing_presentation).
// KEEP-ONE: mapScriptType moved to @/app/types/video-generation (toLibraryScriptType)
// so every video_scripts_library writer shares ONE vocabulary map.

export async function generateVideoScript(params: {
  video_type: string
  context_type: string
  context_id?: string
  audience_segment?: string
  tone?: string
  key_points?: string[]
}) {
  const supabase = await createServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { data: profile } = await supabase.from("users").select("brokerage_id").eq("id", user.id).single()
  if (!profile?.brokerage_id) throw new Error("No brokerage found")

  // Resolve agent ID - never use user.id for agent_id column.
  // ONE VOCABULARY (§6): this was `resolveAgentId` + a hand-rolled throw, which
  // is exactly what requireAgentId (lib/kernel/agent-identity.ts:113) IS. Two
  // spellings of "the agent profile is required here" existed and neither could
  // be found from the other; merged onto the survivor.
  const agentId = await requireAgentId(supabase, user.id)

  // ── THE TIER GATE ──────────────────────────────────────────────────────────
  //
  // BUILT, not tidied. `canAccessFeature` / `incrementFeatureUsage` were
  // imported by this file and called by NOTHING, so the only AI-spending entry
  // in it ran with no entitlement check and left no usage row — the counter the
  // per-tier overage projection reads. Every sibling AI action in this tree is
  // gated this way (app/actions/ai-newsletter.ts:122,
  // app/actions/podcast-generation.ts:72, app/actions/direct-mail.ts:118).
  //
  // The key is `video_generation`, the spelling already in force at
  // app/dashboard/video/page.tsx:13 and lib/kernel/marketing.ts:904 — NOT the
  // second `ai_video_generation` row that also exists in feature_flags, which no
  // code names (§6: one vocabulary per function; that row is a separate finding).
  // Verified against the live database: feature_flags.video_generation is
  // enabled with access true and limit NULL on all four tiers, so this gate
  // refuses nobody today and is in place for the day a tier limit is set.
  const access = await canAccessFeature(user.id, "video_generation")
  if (!access.allowed) {
    throw new Error(access.reason ?? "Video generation is not available on your plan")
  }

  // Generate script using AI
  const scriptResponse = await generateAIResponse({
    prompt: `Generate a ${params.video_type} video script for ${params.audience_segment || "general audience"}.
    
Tone: ${params.tone || "professional and friendly"}
Key points to cover: ${params.key_points?.join(", ") || "none specified"}
Context: ${params.context_type}

Make it conversational, engaging, and authentic. Keep it under 90 seconds.`,
    metadata: {
      userId: user.id,
      brokerageId: profile.brokerage_id,
      agentId: agentId,
      feature: "video_script_generation",
    },
  })

  const script = scriptResponse.text

  // Persist the AI script in video_scripts_library (the canonical AI-script home).
  // video_assets is the brokerage stock-clip library — a different concept.
  const { data: video, error } = await supabase
    .from("video_scripts_library")
    .insert({
      brokerage_id: profile.brokerage_id,
      agent_id: agentId,
      script_type: toLibraryScriptType(params.video_type),
      title: `${params.video_type} script${params.context_type ? ` (${params.context_type})` : ""}`,
      script_content: script,
      listing_id: params.context_type === "listing" ? params.context_id : null,
      contact_id: params.context_type === "contact" ? params.context_id : null,
      brand_voice_tone: params.tone ?? null,
      approval_status: "draft",
      created_by: user.id,
    })
    .select()
    .single()

  if (error) throw error

  await logVideoGenerated({
    brokerage_id: profile.brokerage_id,
    user_id: user.id,
    video_id: video.id,
    video_type: params.video_type,
    listing_id: params.context_type === "listing" ? params.context_id : undefined,
  })

  // Counted AFTER the work succeeded, never before — the same order every other
  // gated action in this tree uses (incrementFeatureUsage's own header says so).
  // Destructured: a refused counter write must not read as a counted use, or the
  // per-tier overage projection under-reports.
  const counted = await incrementFeatureUsage(user.id, "video_generation")
  if (!counted.success) {
    console.error("[video-content] feature_usage_tracking increment failed:", counted.error)
  }

  return { success: true, video, script }
}

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
