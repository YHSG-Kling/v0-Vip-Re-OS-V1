/**
 * POST /api/did/generate-video
 * Generates a talking-head avatar video using D-ID.
 *
 * Supports two source modes for the agent's appearance:
 *   - Photo mode  (agent_photo_url): D-ID animates a still headshot.
 *                  Best for: social/UGC content, market updates.
 *   - Video mode  (agent_video_url): D-ID lip-syncs a short clip of the agent
 *                  speaking/neutral. Produces realistic, high-quality results.
 *                  Best for: formal brand, listing presentations, agent intro.
 *
 * In both cases the voice audio comes from ElevenLabs TTS via the cloned voice.
 *
 * Body: {
 *   video_project_id: string,
 *   script: string,
 *   elevenlabs_voice_id: string,
 *   agent_photo_url?: string,   // preferred for UGC / social content
 *   agent_video_url?: string,   // preferred for formal / brand videos
 * }
 * Provide at least one of agent_photo_url or agent_video_url.
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
    const {
      video_project_id,
      script,
      elevenlabs_voice_id,
      agent_photo_url,
      agent_video_url,
    } = body

    if (!video_project_id || !script || !elevenlabs_voice_id) {
      return NextResponse.json(
        { error: "Missing required fields: video_project_id, script, elevenlabs_voice_id" },
        { status: 400 }
      )
    }

    const sourceUrl: string | undefined = agent_video_url ?? agent_photo_url
    if (!sourceUrl) {
      return NextResponse.json(
        { error: "Provide agent_photo_url or agent_video_url" },
        { status: 400 }
      )
    }

    const isVideoSource = !!agent_video_url
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"

    // ─── STEP 1: Generate voice audio via ElevenLabs ─────────────────────────
    const ttsRes = await fetch(`${appUrl}/api/elevenlabs/tts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: request.headers.get("cookie") ?? "",
      },
      body: JSON.stringify({
        text: script,
        voice_id: elevenlabs_voice_id,
        upload_to_storage: true,
      }),
    })

    const ttsData = await ttsRes.json()
    if (!ttsRes.ok || !ttsData.audio_url) {
      console.error("[D-ID] TTS step failed:", ttsData)
      return NextResponse.json({ error: "Failed to generate voice audio" }, { status: 500 })
    }

    // ─── STEP 2: Submit to D-ID ───────────────────────────────────────────────
    // For video sources D-ID uses /clips (higher quality lip sync).
    // For photo sources D-ID uses /talks (photo animation).
    const endpoint = isVideoSource ? `${DID_API_BASE}/clips` : `${DID_API_BASE}/talks`

    const didPayload = isVideoSource
      ? {
          // /clips endpoint — lip-sync an existing agent video
          source_url: sourceUrl,
          script: {
            type: "audio",
            audio_url: ttsData.audio_url,
          },
          config: { stitch: true, result_format: "mp4" },
        }
      : {
          // /talks endpoint — animate a still photo
          source_url: sourceUrl,
          script: {
            type: "audio",
            audio_url: ttsData.audio_url,
          },
          config: { fluent: true, pad_audio: 0, stitch: true },
        }

    const didRes = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${didApiKey}:`).toString("base64")}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(didPayload),
    })

    const didData = await didRes.json()

    if (!didRes.ok) {
      console.error("[D-ID] API error:", didData)
      await supabase
        .from("ai_video_projects")
        .update({ status: "failed", error_message: didData.description ?? "D-ID error" })
        .eq("id", video_project_id)

      return NextResponse.json(
        { error: didData.description ?? "D-ID video generation failed" },
        { status: 500 }
      )
    }

    const did_talk_id: string = didData.id

    // ─── STEP 3: Update project record ────────────────────────────────────────
    await supabase
      .from("ai_video_projects")
      .update({
        status: "generating",
        provider_job_id: did_talk_id,
        provider_status: "processing",
        provider_metadata: {
          provider: "did",
          mode: isVideoSource ? "clip" : "talk",
          talk_id: did_talk_id,
          source_type: isVideoSource ? "video" : "photo",
        },
        error_message: null,
      })
      .eq("id", video_project_id)

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
      mode: isVideoSource ? "clip" : "talk",
      status: "generating",
      estimated_completion_minutes: isVideoSource ? 5 : 3,
    })
  } catch (error: any) {
    console.error("[D-ID] generate-video error:", error)
    return NextResponse.json({ error: error.message ?? "Internal server error" }, { status: 500 })
  }
}
