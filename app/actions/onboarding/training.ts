"use server"

// ============================================================
// SYSTEM: L11-S04 — Training Video Library Server Actions
// VIP Real Estate AI OS — Layer 11
// ============================================================

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { canAccessFeature, KernelEvent, processKernelEvent } from "@/lib/kernel"

// ─── Types ───────────────────────────────────────────────────────────────────

export type TrainingVideoCategory =
  | "platform_tour"
  | "lead_management"
  | "listing_workflow"
  | "transaction"
  | "portal"
  | "marketing"
  | "isa_engine"
  | "compliance"
  | "them_first"
  | "mobile_app"
  | "custom"

export interface TrainingVideo {
  id: string
  brokerage_id: string | null
  title: string
  description: string | null
  category: TrainingVideoCategory
  video_url: string
  thumbnail_url: string | null
  duration_seconds: number
  order_index: number
  is_required: boolean
  is_platform_default: boolean
  provider_project_id: string | null
  created_at: string
}

export interface VideoCompletion {
  id: string
  agent_id: string
  brokerage_id: string
  training_video_id: string
  percent_watched: number
  last_position_seconds: number
  completed: boolean
  completed_at: string | null
}

export interface VideoWithProgress extends TrainingVideo {
  completion: VideoCompletion | null
}

// ─── getTrainingVideos ───────────────────────────────────────────────────────
// Fetches all training videos visible to the agent (platform defaults + brokerage-specific)

export async function getTrainingVideos(): Promise<{
  success: boolean
  data?: {
    videos: VideoWithProgress[]
    requiredCount: number
    completedRequiredCount: number
    progressPercent: number
  }
  error?: string
}> {
  try {
    const { userId, agentId, brokerageId } = await getAgentContext()

    // Check feature access
    const access = await canAccessFeature(userId, "training_library")
    if (!access.allowed) {
      return { success: false, error: access.reason || "Access denied" }
    }

    const supabase = await createClient()

    // Fetch videos: platform defaults (brokerage_id IS NULL) OR brokerage-specific
    const { data: videos, error: videosError } = await supabase
      .from("training_videos")
      .select("*")
      .or(`brokerage_id.is.null,brokerage_id.eq.${brokerageId}`)
      .order("is_platform_default", { ascending: false })
      .order("order_index", { ascending: true })

    if (videosError) {
      console.error("[Training] Error fetching videos:", videosError)
      return { success: false, error: "Failed to fetch training videos" }
    }

    // Fetch completion records for this agent
    const { data: completions, error: completionsError } = await supabase
      .from("video_completion_tracking")
      .select("*")
      .eq("agent_id", agentId)

    if (completionsError) {
      console.error("[Training] Error fetching completions:", completionsError)
      return { success: false, error: "Failed to fetch completion data" }
    }

    // Map completions by video ID
    const completionMap = new Map(
      (completions || []).map((c) => [c.training_video_id, c])
    )

    // Merge videos with completion data
    const videosWithProgress: VideoWithProgress[] = (videos || []).map((v) => ({
      ...v,
      completion: completionMap.get(v.id) || null,
    }))

    // Calculate progress metrics
    const requiredVideos = videosWithProgress.filter((v) => v.is_required)
    const completedRequired = requiredVideos.filter(
      (v) => v.completion?.completed === true
    )

    return {
      success: true,
      data: {
        videos: videosWithProgress,
        requiredCount: requiredVideos.length,
        completedRequiredCount: completedRequired.length,
        progressPercent:
          requiredVideos.length > 0
            ? Math.round((completedRequired.length / requiredVideos.length) * 100)
            : 100,
      },
    }
  } catch (error) {
    console.error("[Training] getTrainingVideos error:", error)
    return { success: false, error: "An unexpected error occurred" }
  }
}

// ─── getVideoWithProgress ────────────────────────────────────────────────────
// Fetches a single video with its completion data

export async function getVideoWithProgress(videoId: string): Promise<{
  success: boolean
  data?: {
    video: TrainingVideo
    completion: VideoCompletion | null
    nextVideo: TrainingVideo | null
    prevVideo: TrainingVideo | null
    allRequiredComplete: boolean
  }
  error?: string
}> {
  try {
    const { userId, agentId, brokerageId } = await getAgentContext()

    // Check feature access
    const access = await canAccessFeature(userId, "training_library")
    if (!access.allowed) {
      return { success: false, error: access.reason || "Access denied" }
    }

    const supabase = await createClient()

    // Fetch the specific video
    const { data: video, error: videoError } = await supabase
      .from("training_videos")
      .select("*")
      .eq("id", videoId)
      .single()

    if (videoError || !video) {
      return { success: false, error: "Video not found" }
    }

    // Verify agent has access to this video
    if (video.brokerage_id && video.brokerage_id !== brokerageId) {
      return { success: false, error: "Access denied to this video" }
    }

    // Fetch completion record
    const { data: completion } = await supabase
      .from("video_completion_tracking")
      .select("*")
      .eq("agent_id", agentId)
      .eq("training_video_id", videoId)
      .maybeSingle()

    // Fetch all videos in the same category to find next/prev
    const { data: categoryVideos } = await supabase
      .from("training_videos")
      .select("*")
      .eq("category", video.category)
      .or(`brokerage_id.is.null,brokerage_id.eq.${brokerageId}`)
      .order("is_platform_default", { ascending: false })
      .order("order_index", { ascending: true })

    const currentIndex = categoryVideos?.findIndex((v) => v.id === videoId) ?? -1
    const nextVideo = categoryVideos?.[currentIndex + 1] || null
    const prevVideo = categoryVideos?.[currentIndex - 1] || null

    // Check if all required videos are complete
    const { data: allVideos } = await supabase
      .from("training_videos")
      .select("id, is_required")
      .or(`brokerage_id.is.null,brokerage_id.eq.${brokerageId}`)

    const requiredVideoIds = (allVideos || [])
      .filter((v) => v.is_required)
      .map((v) => v.id)

    const { data: completedVideos } = await supabase
      .from("video_completion_tracking")
      .select("training_video_id")
      .eq("agent_id", agentId)
      .eq("completed", true)
      .in("training_video_id", requiredVideoIds)

    const allRequiredComplete =
      requiredVideoIds.length > 0 &&
      (completedVideos?.length || 0) >= requiredVideoIds.length

    return {
      success: true,
      data: {
        video,
        completion,
        nextVideo,
        prevVideo,
        allRequiredComplete,
      },
    }
  } catch (error) {
    console.error("[Training] getVideoWithProgress error:", error)
    return { success: false, error: "An unexpected error occurred" }
  }
}

// ─── recordVideoProgress ─────────────────────────────────────────────────────
// TOMBSTONE (orphan tranche 3): recordVideoProgress deleted — a duplicate no
// surface called. The live survivor is
// app/api/onboarding/training/progress/route.ts (POST), which the training
// player (app/dashboard/onboarding/training/[id]/video-player-client.tsx)
// already polls every 10 seconds. The route does everything this action did —
// same video_completion_tracking upsert, same 90% completion rule, same
// TRAINING_VIDEO_COMPLETED / TRAINING_COURSE_COMPLETED kernel events, same
// allRequiredComplete answer — and adds the per-agent rate limiting this
// action lacked.

// ─── markVideoStarted ────────────────────────────────────────────────────────
// Records that the agent started watching a video (fires kernel event)

export async function markVideoStarted(videoId: string): Promise<{
  success: boolean
  error?: string
}> {
  try {
    const { agentId, brokerageId } = await getAgentContext()

    if (!agentId) return { success: false, error: "Missing agent context" }

    const supabase = await createClient()

    // Check if this is the first video they're watching (for TRAINING_COURSE_ENROLLED)
    const { count } = await supabase
      .from("video_completion_tracking")
      .select("*", { count: "exact", head: true })
      .eq("agent_id", agentId)

    const isFirstVideo = (count || 0) === 0

    // Ensure a completion tracking record exists
    const { data: existing } = await supabase
      .from("video_completion_tracking")
      .select("id")
      .eq("agent_id", agentId)
      .eq("training_video_id", videoId)
      .maybeSingle()

    if (!existing) {
      await supabase.from("video_completion_tracking").insert({
        agent_id: agentId,
        brokerage_id: brokerageId,
        training_video_id: videoId,
        percent_watched: 0,
        last_position_seconds: 0,
        completed: false,
      })
    }

    // Fire kernel events — only when brokerageId is available
    if (brokerageId) {
      await processKernelEvent({
        event: KernelEvent.TRAINING_VIDEO_STARTED,
        brokerageId,
        entityType: "training_video",
        entityId: videoId,
      })
    }

    // Check if this video is required, and if so, fire TRAINING_COURSE_ENROLLED
    const { data: video } = await supabase
      .from("training_videos")
      .select("is_required")
      .eq("id", videoId)
      .single()

    if (isFirstVideo && video?.is_required && brokerageId) {
      await processKernelEvent({
        event: KernelEvent.TRAINING_COURSE_ENROLLED,
        brokerageId,
        entityType: "agent",
        entityId: agentId!,
      })
    }

    return { success: true }
  } catch (error) {
    console.error("[Training] markVideoStarted error:", error)
    return { success: false, error: "An unexpected error occurred" }
  }
}

// ─── checkRequiredVideoGating ────────────────────────────────────────────────
// Checks if agent can access a required video (must complete previous required videos first)

export async function checkRequiredVideoGating(videoId: string): Promise<{
  allowed: boolean
  blockedBy?: {
    videoId: string
    title: string
  }
}> {
  try {
    const { agentId, brokerageId } = await getAgentContext()
    const supabase = await createClient()

    // Get the target video
    const { data: targetVideo } = await supabase
      .from("training_videos")
      .select("*")
      .eq("id", videoId)
      .single()

    if (!targetVideo || !targetVideo.is_required) {
      return { allowed: true }
    }

    // Get all required videos ordered by sequence
    const { data: requiredVideos } = await supabase
      .from("training_videos")
      .select("id, title, order_index, category")
      .eq("is_required", true)
      .or(`brokerage_id.is.null,brokerage_id.eq.${brokerageId}`)
      .order("category", { ascending: true })
      .order("order_index", { ascending: true })

    if (!requiredVideos || requiredVideos.length === 0) {
      return { allowed: true }
    }

    // Get all completed videos for this agent
    const { data: completedVideos } = await supabase
      .from("video_completion_tracking")
      .select("training_video_id")
      .eq("agent_id", agentId)
      .eq("completed", true)

    const completedIds = new Set(
      (completedVideos || []).map((c) => c.training_video_id)
    )

    // Find position of target video in required sequence
    const targetIndex = requiredVideos.findIndex((v) => v.id === videoId)

    if (targetIndex <= 0) {
      // First required video is always accessible
      return { allowed: true }
    }

    // Check if all previous required videos are completed
    for (let i = 0; i < targetIndex; i++) {
      const prevVideo = requiredVideos[i]
      if (!completedIds.has(prevVideo.id)) {
        return {
          allowed: false,
          blockedBy: {
            videoId: prevVideo.id,
            title: prevVideo.title,
          },
        }
      }
    }

    return { allowed: true }
  } catch (error) {
    console.error("[Training] checkRequiredVideoGating error:", error)
    return { allowed: true } // Fail open
  }
}
