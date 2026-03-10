"use server"

import { createServerClient } from "@/lib/supabase/server"
import { logVideoGenerated } from "@/lib/events"
import { generateText } from "ai"
import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { resolveProvider } from "@/lib/kernel/providers"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"

// =====================================================
// VIDEO CONTENT GENERATION SERVER ACTIONS
// AI-powered video script and content creation
// =====================================================

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

  // Resolve agent ID - never use user.id for agent_id column
  const agentId = await resolveAgentId(supabase, user.id)
  if (!agentId) throw new Error("Agent profile not found")

  // Generate script using AI
  const { text: script } = await generateText({
    model: "openai/gpt-4o-mini",
    prompt: `Generate a ${params.video_type} video script for ${params.audience_segment || "general audience"}.
    
Tone: ${params.tone || "professional and friendly"}
Key points to cover: ${params.key_points?.join(", ") || "none specified"}
Context: ${params.context_type}

Make it conversational, engaging, and authentic. Keep it under 90 seconds.`,
  })

  // Save video asset record
  const { data: video, error } = await supabase
    .from("video_assets")
    .insert({
      brokerage_id: profile.brokerage_id,
      agent_id: agentId,
      video_type: params.video_type,
      context_type: params.context_type,
      context_id: params.context_id,
      audience_segment: params.audience_segment,
      script,
      status: "draft",
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

  return { success: true, video, script }
}

// =====================================================
// EVENT HANDLERS - Called by orchestrator
// =====================================================

export async function handleVideoGenerated(payload: any) {
  const supabase = await createServerClient()
  const { video_id, video_type, listing_id, user_id } = payload

  // Create notification for agent to review
  if (user_id) {
    await supabase.from("notifications").insert({
      recipient_id: user_id,
      notification_type: "video_ready",
      title: "Video Ready for Review",
      message: `Your ${video_type} video is ready. Review and publish when ready.`,
      related_entity_type: "video",
      related_entity_id: video_id,
    })
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

  // Update video status to generating
  if (video_id) {
    await supabase
      .from("video_assets")
      .update({ status: "generating" })
      .eq("id", video_id)
  }

  return { success: true }
}

export async function handleVideoPublished(payload: any) {
  const supabase = await createServerClient()
  const { video_id, platforms, user_id } = payload

  // Update video status
  await supabase
    .from("video_assets")
    .update({
      status: "published",
      published_at: new Date().toISOString(),
      published_platforms: platforms,
    })
    .eq("id", video_id)

  // Create celebration notification
  if (user_id) {
    await supabase.from("notifications").insert({
      recipient_id: user_id,
      notification_type: "video_published",
      title: "Video Published!",
      message: `Your video has been published to ${platforms?.join(", ") || "your channels"}.`,
      related_entity_type: "video",
      related_entity_id: video_id,
    })
  }

  return { success: true }
}

export async function handleHighEngagement(payload: any) {
  const supabase = await createServerClient()
  const { video_id, engagement_type, engagement_count, user_id } = payload

  // Create notification for high engagement
  if (user_id) {
    await supabase.from("notifications").insert({
      recipient_id: user_id,
      notification_type: "video_engagement",
      title: "Video Performing Well!",
      message: `Your video has ${engagement_count} ${engagement_type}. Great job!`,
      related_entity_type: "video",
      related_entity_id: video_id,
    })
  }

  // Create task to engage with comments if applicable
  if (engagement_type === "comments" && engagement_count > 5) {
    await supabase.from("tasks").insert({
      assigned_to: user_id,
      title: "Respond to video comments",
      description: `Your video has ${engagement_count} comments. Engage with your audience!`,
      due_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      priority: "medium",
    })
  }

  return { success: true }
}

export async function createShortClip(params: {
  long_form_video_id: string
  clip_start_sec: number
  clip_end_sec: number
  caption_text?: string
  target_platform: string
}) {
  const supabase = await createServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  // Create short clip record
  const { data: clip, error } = await supabase
    .from("video_snippets")
    .insert({
      long_form_video_id: params.long_form_video_id,
      clip_start_sec: params.clip_start_sec,
      clip_end_sec: params.clip_end_sec,
      caption_text: params.caption_text,
      target_platform: params.target_platform,
      status: "queued",
    })
    .select()
    .single()

  if (error) throw error

  return { success: true, clip }
}
