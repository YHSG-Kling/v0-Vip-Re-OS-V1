"use server"

import { createClient } from "@/lib/supabase/server"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { applyBrandVoice } from "@/lib/kernel/brand-voice"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { generateAvatarVideo, getAvatarVideoStatus } from "@/app/actions/external-services"

// ============================================
// VIDEO PROJECT CREATION — ai_video_projects
// Full lifecycle: script → generate → distribute
// ============================================

export interface CreateVideoProjectParams {
  brokerageId: string
  agentId: string
  title: string
  script: string
  videoType: string
  avatarId?: string
  voiceId?: string
  backgroundType: "solid" | "gradient" | "branded" | "custom" | "property"
  backgroundUrl?: string
  backgroundColorHex?: string
  format: "horizontal" | "square" | "vertical"
  durationSeconds: number
  captionsEnabled: boolean
  listingId?: string
}

export interface VideoProject {
  id: string
  title: string
  script_content: string
  video_type: string
  status: "draft" | "generating" | "ready" | "failed" | "distributed"
  provider_job_id: string | null
  provider_status: string | null
  video_url: string | null
  thumbnail_url: string | null
  error_message: string | null
  background_type: string
  background_url: string | null
  format: string
  duration_seconds: number
  captions_enabled: boolean
  retry_count: number
  created_at: string
  agent_id: string
  brokerage_id: string
  listing_id: string | null
}

// generateAIScript + improveScript were REMOVED (zero callers, and both were
// live "use server" endpoints). app/actions/video/generate-script.ts →
// generateVideoScript is the surviving script path and is the more advanced
// one by a wide margin: it loads the brokerage's brand_voice_profile from the
// database, injects the ThemFirst philosophy and the Fair Housing directive
// into the system prompt, and runs evaluateOutbound BOTH before generation
// (on the brief) and after (on the script). generateAIScript ran a single
// prompt with one post-hoc compliance check; improveScript ran a bare rewrite
// with NO compliance gate at all, which is the one thing a script path may
// not do. The video wizard (app/dashboard/videos/create) already calls the
// survivor.

// ─── CREATE VIDEO PROJECT ────────────────────────────────────────────────────

export async function createVideoProject(params: CreateVideoProjectParams): Promise<{
  success: boolean
  project?: VideoProject
  error?: string
}> {
  if (!isValidUUID(params.brokerageId) || !isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid brokerage or agent ID" }
  }
  if (!params.title?.trim()) {
    return { success: false, error: "Title is required" }
  }
  if (!params.script?.trim()) {
    return { success: false, error: "Script is required" }
  }

  const supabase = await createClient()

  // Migration 1052: provider resolved (D-ID default; agent + brokerage
  // overrides). Hard-coded 'heygen' before — wrong; @d-id/client-sdk is
  // the primary in package.json and agent_voice_profiles defaults to 'did'.
  const { resolveVideoProvider, initialProviderColumns } = await import("@/lib/marketing/video-provider-resolver")
  const provider = await resolveVideoProvider(supabase, {
    brokerageId: params.brokerageId,
    agentUserId: params.agentId,
  })
  const providerCols = initialProviderColumns(provider)

  const { data: project, error } = await supabase
    .from("ai_video_projects")
    .insert({
      brokerage_id: params.brokerageId,
      agent_id: params.agentId,
      title: params.title,
      script_content: params.script,
      video_type: params.videoType,
      provider_avatar_id: params.avatarId ?? null,
      provider_voice_id: params.voiceId ?? null,
      background_type: params.backgroundType,
      background_url: params.backgroundUrl ?? null,
      video_metadata: params.backgroundColorHex
        ? { background_color: params.backgroundColorHex }
        : null,
      format: params.format,
      duration_seconds: params.durationSeconds,
      captions_enabled: params.captionsEnabled,
      listing_id: params.listingId ?? null,
      status: "draft",
      retry_count: 0,
      video_provider: provider,
      ...providerCols,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select()
    .maybeSingle()

  if (error || !project) {
    console.error("[create-video-project] Insert error:", error)
    return { success: false, error: error?.message ?? "Failed to create video project" }
  }

  // Emit kernel event
  await supabase.from("lifecycle_events").insert({
    entity_type: "video_project",
    entity_id: project.id,
    brokerage_id: params.brokerageId,
    event_type: KernelEvent.VIDEO_GENERATION_REQUESTED,
    actor_user_id: params.agentId,
    metadata: { video_type: params.videoType, title: params.title },
  })

  await processKernelEvent({
    event: KernelEvent.VIDEO_GENERATION_REQUESTED,
    brokerageId: params.brokerageId,
    entityType: "video_project",
    entityId: project.id,
  }).catch(() => {})

  revalidatePath("/dashboard/videos")
  revalidatePath("/dashboard/videos/create")

  return { success: true, project: project as VideoProject }
}

// ─── SUBMIT AVATAR VIDEO RENDER (D-ID + ElevenLabs) ──────────────────────────
// Named submitToHeyGen until the l39 rename. There is no HeyGen path: this
// dispatches through the platform video provider, which resolveVideoProvider
// hard-locks to D-ID. The error strings below said "HeyGen" too — an agent
// whose render failed was told a vendor we do not use had failed them.

export async function submitAvatarVideoRender(
  projectId: string,
  brokerageId: string
): Promise<{ success: boolean; providerVideoId?: string; error?: string; requiresConfiguration?: boolean }> {
  if (!isValidUUID(projectId)) return { success: false, error: "Invalid project ID" }

  const supabase = await createClient()

  const { data: project, error: loadError } = await supabase
    .from("ai_video_projects")
    .select("*")
    .eq("id", projectId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (loadError || !project) {
    return { success: false, error: "Video project not found" }
  }

  if (!project.provider_avatar_id || !project.provider_voice_id) {
    return {
      success: false,
      error: "Avatar and voice must be configured before generating. Set them up in Settings.",
    }
  }

  // Mark as generating
  await supabase
    .from("ai_video_projects")
    .update({ status: "generating", provider_status: "pending", updated_at: new Date().toISOString() })
    .eq("id", projectId)

  // Submit to D-ID (platform-locked engine; canonical provider_* columns)
  const result = await generateAvatarVideo({
    avatarId: project.provider_avatar_id,
    voiceId: project.provider_voice_id,
    script: project.script_content,
    brokerageId,
  })

  if (!result.success) {
    // Mark as failed
    await supabase
      .from("ai_video_projects")
      .update({
        status: "failed",
        provider_status: "failed",
        error_message: result.error ?? "Avatar video submission failed (D-ID)",
        updated_at: new Date().toISOString(),
      })
      .eq("id", projectId)

    return {
      success: false,
      error: result.error,
      requiresConfiguration: (result as any).requiresConfiguration ?? false,
    }
  }

  // Store the D-ID job id
  await supabase
    .from("ai_video_projects")
    .update({
      provider_job_id: result.videoId,
      provider_status: "processing",
      updated_at: new Date().toISOString(),
    })
    .eq("id", projectId)

  revalidatePath("/dashboard/videos")

  return { success: true, providerVideoId: result.videoId }
}

// pollVideoStatus was REMOVED (zero callers). Render finalization is owned by
// the poll-did-videos cron, which walks provider_job_id / provider_status and
// writes video_url + the VIDEO_PREVIEW_READY lifecycle event; the board at
// /dashboard/videos/board then polls the ai_video_projects ROW, not the vendor.
// This inline per-request vendor poll was the drifted twin of that cron.

// getVideoProject (singular) was REMOVED (zero callers) — a plain single-row
// read of ai_video_projects that getVideoProjects below already covers.

// ─── GET VIDEO PROJECTS (LIBRARY) ─────────────────────────────────────────────

export async function getVideoProjects(brokerageId: string, agentId?: string): Promise<VideoProject[]> {
  if (!isValidUUID(brokerageId)) return []

  const supabase = await createClient()

  let query = supabase
    .from("ai_video_projects")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })
    .limit(50)

  if (agentId && isValidUUID(agentId)) {
    query = query.eq("agent_id", agentId)
  }

  const { data, error } = await query
  if (error) return []
  return (data ?? []) as VideoProject[]
}

// retryVideoGeneration was REMOVED (zero callers) — and it could not have
// worked for a video made by the live wizard. It routed through
// submitAvatarVideoRender, which refuses unless provider_avatar_id AND
// provider_voice_id are set on the project; app/dashboard/videos/create
// explicitly inserts BOTH as null, so every retry would have returned
// "Avatar and voice must be configured before generating". The surviving retry
// is handleRetry() in app/dashboard/videos/board/page.tsx, which resolves the
// agent's ElevenLabs voice clone and D-ID photo/video from agent_voice_profiles
// and re-submits to /api/did/generate-video.

// getUserAvatarConfig was REMOVED. It had zero callers while sitting in a
// "use server" module, so it was a live RPC endpoint nobody used — and it was
// wrong twice over: it looked up ai_identity_profiles.scope_id and
// agent_voice_profiles.agent_id (both agents.id) with the AUTH USER id, so it
// could only ever report isConfigured:false. lib/video/video-identity.ts is the
// canonical resolver — right id class, and the full agent → team → brokerage
// cascade with honest fallbacks.

// getSocialAccountsForDistribution was REMOVED (zero callers). The video board's
// distribution dialog (app/dashboard/videos/board/page.tsx) loads the same
// social_media_accounts rows itself, scoped by brokerage_id + is_active. This
// twin additionally narrowed by agent_id, which would have hidden every
// brokerage-owned account from the agent trying to post to it.
