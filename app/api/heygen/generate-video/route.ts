"use server"

import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

const HEYGEN_API_BASE = "https://api.heygen.com/v2"

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const body = await request.json()

    const { script, avatar_id, voice_id, video_project_id, background, user_id } = body

    if (!script || !avatar_id || !voice_id || !video_project_id) {
      return NextResponse.json({ error: "Missing required fields: script, avatar_id, voice_id, video_project_id" }, { status: 400 })
    }

    const heygenApiKey = process.env.HEYGEN_API_KEY
    if (!heygenApiKey) {
      // Mark as queued for later processing when API key is available
      await supabase
        .from("ai_video_projects")
        .update({
          heygen_status: "pending",
          error_message: "HeyGen API key not configured",
        })
        .eq("id", video_project_id)

      return NextResponse.json({
        success: false,
        error: "HeyGen API key not configured. Video queued for processing.",
        queued: true,
      })
    }

    // Submit to HeyGen API
    const heygenResponse = await fetch(`${HEYGEN_API_BASE}/video/generate`, {
      method: "POST",
      headers: {
        "X-Api-Key": heygenApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        video_inputs: [
          {
            character: {
              type: "avatar",
              avatar_id: avatar_id,
              avatar_style: "normal",
            },
            voice: {
              type: "text",
              input_text: script,
              voice_id: voice_id,
            },
            background: background || {
              type: "color",
              value: "#ffffff",
            },
          },
        ],
        dimension: {
          width: 1920,
          height: 1080,
        },
        aspect_ratio: "16:9",
      }),
    })

    const heygenData = await heygenResponse.json()

    if (!heygenResponse.ok) {
      console.error("[v0] HeyGen API error:", heygenData)
      await supabase
        .from("ai_video_projects")
        .update({
          heygen_status: "failed",
          error_message: heygenData.message || "HeyGen API error",
          retry_count: 1,
        })
        .eq("id", video_project_id)

      return NextResponse.json({ success: false, error: heygenData.message || "HeyGen API error" }, { status: 500 })
    }

    const heygenVideoId = heygenData.data?.video_id

    // Update video project with HeyGen video ID
    await supabase
      .from("ai_video_projects")
      .update({
        heygen_video_id: heygenVideoId,
        heygen_status: "generating",
        heygen_avatar_id: avatar_id,
        heygen_voice_id: voice_id,
        error_message: null,
      })
      .eq("id", video_project_id)

    // Add to generation queue
    await supabase.from("video_generation_queue").insert({
      video_project_id,
      priority: 5,
      status: "processing",
      heygen_job_id: heygenVideoId,
      started_processing_at: new Date().toISOString(),
      estimated_completion_minutes: 15,
    })

    return NextResponse.json({
      success: true,
      heygen_video_id: heygenVideoId,
      estimated_completion_minutes: 15,
      status: "generating",
    })
  } catch (error: any) {
    console.error("[v0] HeyGen generate video error:", error)
    return NextResponse.json({ error: "Failed to generate video", details: error.message }, { status: 500 })
  }
}
