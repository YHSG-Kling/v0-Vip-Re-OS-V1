import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

const HEYGEN_API_BASE = "https://api.heygen.com/v2"

export async function GET(request: NextRequest, { params }: { params: Promise<{ video_project_id: string }> }) {
  try {
    const { video_project_id } = await params
    const supabase = await createClient()

    // Get the video project
    const { data: project, error: projectError } = await supabase
      .from("ai_video_projects")
      .select("*")
      .eq("id", video_project_id)
      .single()

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

    // Check status with HeyGen
    const statusResponse = await fetch(`${HEYGEN_API_BASE}/video_status.get?video_id=${project.heygen_video_id}`, {
      headers: {
        "X-Api-Key": heygenApiKey,
      },
    })

    const statusData = await statusResponse.json()

    if (!statusResponse.ok) {
      console.error("[v0] HeyGen status check error:", statusData)
      return NextResponse.json({
        status: "error",
        error: statusData.message,
      })
    }

    const heygenStatus = statusData.data?.status
    const videoUrl = statusData.data?.video_url
    const thumbnailUrl = statusData.data?.thumbnail_url
    const duration = statusData.data?.duration

    // Map HeyGen status to our status
    let ourStatus = project.heygen_status
    let progressPercentage = 0

    switch (heygenStatus) {
      case "pending":
        ourStatus = "generating"
        progressPercentage = 10
        break
      case "processing":
        ourStatus = "generating"
        progressPercentage = 50
        break
      case "completed":
        ourStatus = "completed"
        progressPercentage = 100
        break
      case "failed":
        ourStatus = "failed"
        progressPercentage = 0
        break
    }

    // Update project if status changed
    if (heygenStatus === "completed" && project.heygen_status !== "completed") {
      await supabase
        .from("ai_video_projects")
        .update({
          heygen_status: "completed",
          video_url: videoUrl,
          thumbnail_url: thumbnailUrl,
          duration_seconds: duration,
          completed_at: new Date().toISOString(),
          video_metadata: {
            duration_seconds: duration,
            heygen_status: heygenStatus,
            resolution: "1920x1080",
          },
        })
        .eq("id", video_project_id)

      // Update queue record
      await supabase
        .from("video_generation_queue")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
        })
        .eq("video_project_id", video_project_id)
    } else if (heygenStatus === "failed" && project.heygen_status !== "failed") {
      await supabase
        .from("ai_video_projects")
        .update({
          heygen_status: "failed",
          error_message: statusData.data?.error || "HeyGen generation failed",
        })
        .eq("id", video_project_id)

      await supabase
        .from("video_generation_queue")
        .update({
          status: "failed",
          failed_at: new Date().toISOString(),
          error_message: statusData.data?.error,
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
    })
  } catch (error: any) {
    console.error("[v0] HeyGen status check error:", error)
    return NextResponse.json({ error: "Failed to check video status", details: error.message }, { status: 500 })
  }
}
