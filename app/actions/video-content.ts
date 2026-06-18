"use server"

import { createServerClient } from "@/lib/supabase/server"
import { agentIdForUser } from "@/lib/agents/agent-for-user"
import { logVideoGenerated } from "@/lib/events"
import { generateAIResponse } from "@/lib/ai"
import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { resolveProvider } from "@/lib/kernel/providers"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"

// =====================================================
// VIDEO CONTENT GENERATION SERVER ACTIONS
// AI-powered video script and content creation
// =====================================================

// Map a free-form video_type onto the video_scripts_library.script_type CHECK
// (property_tour|buyer_education|market_update|agent_intro|listing_presentation).
function mapScriptType(videoType: string): string {
  const map: Record<string, string> = {
    full_tour: "property_tour",
    listing_tour: "property_tour",
    just_listed: "property_tour",
    listing_promo: "property_tour",
    open_house_promo: "property_tour",
    social_snippet: "property_tour",
    instagram_story: "property_tour",
    reel: "property_tour",
    buyer_education: "buyer_education",
    education: "buyer_education",
    market_update: "market_update",
    agent_intro: "agent_intro",
    welcome: "agent_intro",
    testimonial: "agent_intro",
    presentation: "listing_presentation",
    listing_presentation: "listing_presentation",
    presentation_chapter: "listing_presentation",
  }
  return map[videoType] || "property_tour"
}

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
      script_type: mapScriptType(params.video_type),
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
      user_id: user_id,
      type: "video_ready",
      title: "Video Ready for Review",
      body: `Your ${video_type} video is ready. Review and publish when ready.`,
      entity_type: "video",
      entity_id: video_id,
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

  // Create celebration notification
  if (user_id) {
    await supabase.from("notifications").insert({
      user_id: user_id,
      type: "video_published",
      title: "Video Published!",
      body: `Your video has been published to ${platforms?.join(", ") || "your channels"}.`,
      entity_type: "video",
      entity_id: video_id,
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
      user_id: user_id,
      type: "video_engagement",
      title: "Video Performing Well!",
      body: `Your video has ${engagement_count} ${engagement_type}. Great job!`,
      entity_type: "video",
      entity_id: video_id,
    })
  }

  // Create task to engage with comments if applicable
  if (engagement_type === "comments" && engagement_count > 5) {
    await supabase.from("tasks").insert({
      assigned_to_agent_id: await agentIdForUser(supabase, user_id),
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
  // Canonical video_snippets columns (matches video-repurposing.ts):
  // long_form_video_id→video_project_id, clip_*_sec→*_seconds, target_platform→
  // platform_target, status→approval_status ('draft'), snippet_title is NOT NULL.
  const { data: clip, error } = await supabase
    .from("video_snippets")
    .insert({
      video_project_id: params.long_form_video_id,
      start_seconds: params.clip_start_sec,
      end_seconds: params.clip_end_sec,
      snippet_title: params.caption_text?.slice(0, 80) || `Clip ${params.clip_start_sec}-${params.clip_end_sec}s`,
      caption_text: params.caption_text,
      platform_target: params.target_platform,
      approval_status: "draft",
    })
    .select()
    .single()

  if (error) throw error

  return { success: true, clip }
}
