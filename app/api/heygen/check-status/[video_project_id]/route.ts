import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"

const HEYGEN_API_BASE = "https://api.heygen.com/v2"

// ─── WRITE LIFECYCLE EVENT ──────────────────────────────────────────────────
async function writeLifecycleEvent(
  supabase: any,
  entityId: string,
  brokerageId: string,
  eventType: KernelEvent,
  actorUserId: string | null,
  metadata: Record<string, any>
) {
  await supabase.from("lifecycle_events").insert({
    entity_type: "video_project",
    entity_id: entityId,
    brokerage_id: brokerageId,
    event_type: eventType,
    actor_user_id: actorUserId,
    metadata,
  })
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ video_project_id: string }> }
) {
  try {
    const { video_project_id } = await params
    const supabase = await createClient()

    // ─── GET VIDEO PROJECT ────────────────────────────────────────────────────
    const { data: project, error: projectError } = await supabase
      .from("ai_video_projects")
      .select("*, brokerage_id")
      .eq("id", video_project_id)
      .maybeSingle()

    if (projectError || !project) {
      return NextResponse.json({ error: "Video project not found" }, { status: 404 })
    }

    if (!project.heygen_video_id) {
      return NextResponse.json({
        status: project.heygen_status || "pending",
        progress_percentage: 0,
        message: "Video not yet submitted to HeyGen",
      })
    }

    const heygenApiKey = process.env.HEYGEN_API_KEY
    if (!heygenApiKey) {
      return NextResponse.json({
        status: project.heygen_status,
        progress_percentage: 0,
        message: "HeyGen API key not configured",
      })
    }

    // ─── CHECK STATUS WITH HEYGEN ─────────────────────────────────────────────
    const statusResponse = await fetch(
      `${HEYGEN_API_BASE}/video_status.get?video_id=${project.heygen_video_id}`,
      {
        headers: {
          "X-Api-Key": heygenApiKey,
        },
      }
    )

    const statusData = await statusResponse.json()

    if (!statusResponse.ok) {
      console.error("[HeyGen] status check error:", statusData)
      return NextResponse.json({
        status: "error",
        error: statusData.message,
      })
    }

    const heygenStatus = statusData.data?.status
    const videoUrl = statusData.data?.video_url
    const thumbnailUrl = statusData.data?.thumbnail_url
    const duration = statusData.data?.duration

    // ─── MAP HEYGEN STATUS TO OUR STATUS ──────────────────────────────────────
    let ourStatus = project.heygen_status
    let progressPercentage = 0
    let streamStatus = "pending"

    switch (heygenStatus) {
      case "pending":
        ourStatus = "generating"
        progressPercentage = 10
        streamStatus = "pending"
        break
      case "processing":
        ourStatus = "generating"
        progressPercentage = 50
        streamStatus = "processing"
        break
      case "completed":
        ourStatus = "completed"
        progressPercentage = 100
        streamStatus = "preview_ready"
        break
      case "failed":
        ourStatus = "failed"
        progressPercentage = 0
        streamStatus = "failed"
        break
    }

    // ─── UPDATE ON COMPLETION ─────────────────────────────────────────────────
    if (heygenStatus === "completed" && project.heygen_status !== "completed") {
      // Update ai_video_projects
      await supabase
        .from("ai_video_projects")
        .update({
          heygen_status: "completed",
          status: "preview_ready",
          video_url: videoUrl,
          duration_seconds: duration,
          completed_at: new Date().toISOString(),
          provider_status: "completed",
          video_metadata: {
            duration_seconds: duration,
            heygen_status: heygenStatus,
            resolution: project.provider_metadata?.dimensions || "1920x1080",
            thumbnail_url: thumbnailUrl,
          },
        })
        .eq("id", video_project_id)

      // Update video_generation_queue
      await supabase
        .from("video_generation_queue")
        .update({
          status: "completed",
          processed_at: new Date().toISOString(),
        })
        .eq("project_id", video_project_id)

      // Update video_streaming_status with preview URL
      await supabase
        .from("video_streaming_status")
        .update({
          stream_status: "preview_ready",
          preview_url: videoUrl,
          stream_url: videoUrl,
          last_polled_at: new Date().toISOString(),
          error_message: null,
        })
        .eq("video_project_id", video_project_id)

      // ─── WRITE LIFECYCLE EVENT: VIDEO_PREVIEW_READY ─────────────────────────
      await writeLifecycleEvent(
        supabase,
        video_project_id,
        project.brokerage_id,
        KernelEvent.VIDEO_PREVIEW_READY,
        null,
        {
          video_url: videoUrl,
          duration_seconds: duration,
          thumbnail_url: thumbnailUrl,
        }
      )

      // ─── FIRE KERNEL EVENT ──────────────────────────────────────────────────
      await processKernelEvent({
        event: KernelEvent.VIDEO_PREVIEW_READY,
        brokerageId: project.brokerage_id,
        entityType: "video_project",
        entityId: video_project_id,
      }).catch(err => console.error("[HeyGen] Kernel event failed:", err))

    } else if (heygenStatus === "failed" && project.heygen_status !== "failed") {
      // Update ai_video_projects on failure
      await supabase
        .from("ai_video_projects")
        .update({
          heygen_status: "failed",
          status: "failed",
          error_message: statusData.data?.error || "HeyGen generation failed",
          provider_status: "failed",
        })
        .eq("id", video_project_id)

      // Update video_generation_queue
      await supabase
        .from("video_generation_queue")
        .update({
          status: "failed",
          processed_at: new Date().toISOString(),
        })
        .eq("project_id", video_project_id)

      // Update video_streaming_status
      await supabase
        .from("video_streaming_status")
        .update({
          stream_status: "failed",
          error_message: statusData.data?.error || "HeyGen generation failed",
          last_polled_at: new Date().toISOString(),
        })
        .eq("video_project_id", video_project_id)

      // Write lifecycle event for failure
      await writeLifecycleEvent(
        supabase,
        video_project_id,
        project.brokerage_id,
        KernelEvent.VIDEO_GENERATION_FAILED,
        null,
        { error: statusData.data?.error || "HeyGen generation failed" }
      )
    } else {
      // Just update last_polled_at for in-progress videos
      await supabase
        .from("video_streaming_status")
        .update({
          stream_status: streamStatus,
          last_polled_at: new Date().toISOString(),
        })
        .eq("video_project_id", video_project_id)
    }

    return NextResponse.json({
      status: ourStatus,
      progress_percentage: progressPercentage,
      video_url: videoUrl,
      thumbnail_url: thumbnailUrl,
      duration: duration,
      heygen_status: heygenStatus,
      stream_status: streamStatus,
      preview_ready: heygenStatus === "completed",
    })
  } catch (error: any) {
    console.error("[HeyGen] status check error:", error)
    return NextResponse.json(
      { error: "Failed to check video status", details: error.message },
      { status: 500 }
    )
  }
}

// ─── PUBLISH VIDEO ENDPOINT ─────────────────────────────────────────────────
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ video_project_id: string }> }
) {
  try {
    const { video_project_id } = await params
    const supabase = await createClient()
    const body = await request.json()

    const { user_id, publish_metadata } = body

    // ─── GET VIDEO PROJECT ────────────────────────────────────────────────────
    const { data: project, error: projectError } = await supabase
      .from("ai_video_projects")
      .select("*")
      .eq("id", video_project_id)
      .maybeSingle()

    if (projectError || !project) {
      return NextResponse.json({ error: "Video project not found" }, { status: 404 })
    }

    // ─── KERNEL GOVERNANCE: COMPLIANCE CHECK BEFORE PUBLISH ───────────────────
    if (project.status !== "preview_ready" && project.heygen_status !== "completed") {
      return NextResponse.json(
        { error: "Video must be in preview_ready state before publishing" },
        { status: 400 }
      )
    }

    // Check for required brand compliance
    const { data: brandingPreset } = await supabase
      .from("video_branding_presets")
      .select("*")
      .eq("agent_id", project.agent_id)
      .eq("is_default", true)
      .maybeSingle()

    // In production, validate disclaimer/outro/contact overlays here
    // For now, allow publish if video is ready

    // ─── CREATE VIDEO ASSET RECORD ────────────────────────────────────────────
    const { data: videoAsset, error: assetError } = await supabase
      .from("video_assets")
      .insert({
        title: project.title || `Video ${video_project_id}`,
        description: project.script_content,
        video_url: project.video_url,
        thumbnail_url: project.video_metadata?.thumbnail_url,
        duration_seconds: project.duration_seconds,
        category: project.video_type,
        created_by: user_id || project.agent_id,
        tags: [project.video_type, "heygen", "ai-generated"],
      })
      .select()
      .maybeSingle()

    if (assetError) {
      console.error("[HeyGen] Error creating video asset:", assetError)
      return NextResponse.json(
        { error: "Failed to create video asset" },
        { status: 500 }
      )
    }

    // ─── UPDATE AI_VIDEO_PROJECTS STATUS ──────────────────────────────────────
    await supabase
      .from("ai_video_projects")
      .update({
        status: "published",
        video_metadata: {
          ...project.video_metadata,
          published_at: new Date().toISOString(),
          video_asset_id: videoAsset.id,
          publish_metadata,
        },
      })
      .eq("id", video_project_id)

    // ─── UPDATE VIDEO_STREAMING_STATUS ────────────────────────────────────────
    await supabase
      .from("video_streaming_status")
      .update({
        stream_status: "published",
      })
      .eq("video_project_id", video_project_id)

    // ─── WRITE LIFECYCLE EVENT: VIDEO_PUBLISHED ───────────────────────────────
    await writeLifecycleEvent(
      supabase,
      video_project_id,
      project.brokerage_id,
      KernelEvent.VIDEO_PUBLISHED,
      user_id,
      {
        video_asset_id: videoAsset.id,
        video_url: project.video_url,
        publish_metadata,
      }
    )

    // ─── FIRE KERNEL EVENT ────────────────────────────────────────────────────
    await processKernelEvent({
      event: KernelEvent.VIDEO_PUBLISHED,
      brokerageId: project.brokerage_id,
      entityType: "video_project",
      entityId: video_project_id,
    }).catch(err => console.error("[HeyGen] Kernel event failed:", err))

    return NextResponse.json({
      success: true,
      video_asset_id: videoAsset.id,
      status: "published",
    })
  } catch (error: any) {
    console.error("[HeyGen] publish error:", error)
    return NextResponse.json(
      { error: "Failed to publish video", details: error.message },
      { status: 500 }
    )
  }
}
