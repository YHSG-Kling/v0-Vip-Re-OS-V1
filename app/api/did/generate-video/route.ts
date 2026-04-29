/**
 * POST /api/did/generate-video
 * Generates a talking-head avatar video using D-ID.
 * Agent photo is animated with an ElevenLabs TTS audio track.
 * ~80% cheaper than HeyGen for the same quality profile video.
 *
 * Body: {
 *   video_project_id: string,
 *   script: string,
 *   agent_photo_url: string,   // did_photo_url from agent_voice_profiles
 *   elevenlabs_voice_id: string,
 * }
 */

import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"

const DID_API_BASE = "https://api.d-id.com"

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const auth = await requireAuth(supabase)
    if (!auth.ok) return auth.response

    const didApiKey = process.env.DID_API_KEY
    const elApiKey = process.env.ELEVENLABS_API_KEY

    if (!didApiKey || !elApiKey) {
      return NextResponse.json(
        { error: "D-ID or ElevenLabs API key not configured" },
        { status: 503 }
      )
    }

    const body = await request.json()
    const { video_project_id, script, agent_photo_url, elevenlabs_voice_id } = body

    if (!video_project_id || !script || !agent_photo_url || !elevenlabs_voice_id) {
      return NextResponse.json(
        { error: "Missing required fields: video_project_id, script, agent_photo_url, elevenlabs_voice_id" },
        { status: 400 }
      )
    }

    // ─── STEP 1: Generate voice audio via ElevenLabs ─────────────────────────
    const ttsRes = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/elevenlabs/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: request.headers.get("cookie") ?? "" },
      body: JSON.stringify({
        text: script,
        voice_id: elevenlabs_voice_id,
        upload_to_storage: true,
      }),
    })

    const ttsData = await ttsRes.json()
    if (!ttsRes.ok || !ttsData.audio_url) {
      return NextResponse.json({ error: "Failed to generate voice audio" }, { status: 500 })
    }

    // ─── STEP 2: Submit to D-ID /talks ────────────────────────────────────────
    const didRes = await fetch(`${DID_API_BASE}/talks`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${didApiKey}:`).toString("base64")}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        source_url: agent_photo_url,
        script: {
          type: "audio",
          audio_url: ttsData.audio_url,
        },
        config: {
          fluent: true,
          pad_audio: 0,
          stitch: true,
        },
      }),
    })

    const didData = await didRes.json()

    if (!didRes.ok) {
      console.error("[D-ID] API error:", didData)
      await supabase
        .from("ai_video_projects")
        .update({ status: "failed", error_message: didData.description ?? "D-ID error" })
        .eq("id", video_project_id)

      return NextResponse.json({ error: didData.description ?? "D-ID video generation failed" }, { status: 500 })
    }

    const did_talk_id: string = didData.id

    // ─── STEP 3: Update project record ────────────────────────────────────────
    await supabase
      .from("ai_video_projects")
      .update({
        status: "generating",
        provider_job_id: did_talk_id,
        provider_status: "processing",
        provider_metadata: { provider: "did", talk_id: did_talk_id },
        error_message: null,
      })
      .eq("id", video_project_id)

    // ─── STEP 4: Log render cost ───────────────────────────────────────────────
    await supabase.from("video_render_log").insert({
      project_id: video_project_id,
      provider: "did",
      render_duration_seconds: null,
    })

    await processKernelEvent({
      event: KernelEvent.VIDEO_GENERATION_REQUESTED,
      brokerageId: auth.brokerageId!,
      entityType: "video_project",
      entityId: video_project_id,
    }).catch(err => console.error("[D-ID] Kernel event failed:", err))

    return NextResponse.json({
      success: true,
      did_talk_id,
      status: "generating",
      estimated_completion_minutes: 3,
    })
  } catch (error: any) {
    console.error("[D-ID] generate-video error:", error)
    return NextResponse.json({ error: error.message ?? "Internal server error" }, { status: 500 })
  }
}
