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
 *   background?: { type: "color" | "image"; value: string },
 * }
 * Provide at least one of agent_photo_url or agent_video_url.
 */

import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { checkBrandCompliance } from "@/lib/kernel/brand-compliance"

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
      // did_avatar_id: caller may pass a specific avatar from the library
      did_avatar_id: callerAvatarId,
      background,
      ugc_mode,
    } = body

    if (!video_project_id || !script || !elevenlabs_voice_id) {
      return NextResponse.json(
        { error: "Voice clone not set up. Configure your voice in Settings → Voice & Avatar before generating videos." },
        { status: 400 }
      )
    }

    // ─── Resolve D-ID avatar: prefer persistent avatar_id over raw source_url ──
    // Persistent avatars (created via /api/did/create-avatar) render faster and
    // more consistently because D-ID has already processed the source video.
    // Fall back to source_url for photo mode and legacy profiles without an avatar_id.
    let resolvedAvatarId: string | null = callerAvatarId ?? null
    if (!resolvedAvatarId && auth.userId) {
      // Check if agent has a ready default avatar in their library
      const { data: agentRow } = await supabase
        .from("agents")
        .select("id")
        .eq("user_id", auth.userId)
        .maybeSingle()

      if (agentRow?.id) {
        const { data: defaultAsset } = await supabase
          .from("agent_avatar_assets")
          .select("did_avatar_id")
          .eq("agent_id", agentRow.id)
          .eq("status", "ready")
          .eq("is_default", true)
          .maybeSingle()
        resolvedAvatarId = defaultAsset?.did_avatar_id ?? null
      }
    }

    const sourceUrl: string | undefined = agent_video_url ?? agent_photo_url
    // Need at least one of: a ready avatar_id OR a source URL
    if (!resolvedAvatarId && !sourceUrl) {
      return NextResponse.json(
        { error: "Avatar not set up. Upload your headshot or video clip in Settings → Voice & Avatar before generating videos." },
        { status: 400 }
      )
    }

    // When using a persistent avatar_id it's always a video-quality /clips render
    const isVideoSource = !!resolvedAvatarId || !!agent_video_url
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"

    // ─── Brand compliance gate ────────────────────────────────────────────────
    if (auth.brokerageId) {
      const compliance = await checkBrandCompliance({
        contentType: "video",
        contentId: video_project_id,
        brokerageId: auth.brokerageId,
      })
      if (!compliance.passed) {
        await supabase
          .from("ai_video_projects")
          .update({ status: "failed", error_message: `Compliance: ${compliance.violations.join("; ")}` })
          .eq("id", video_project_id)
        return NextResponse.json(
          { error: "Brand compliance check failed", violations: compliance.violations },
          { status: 422 }
        )
      }
    }

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

    const expression = ugc_mode ? "happy" : "neutral"

    // Background handling — D-ID supports `background` on /talks (color hex or image URL).
    // For /clips, background gets baked in via the source clip itself.
    const bgValue: string | { type: string; url?: string; color?: string } | undefined =
      background?.type === "image" && background?.value
        ? { type: "image", url: background.value }
        : background?.type === "color" && background?.value
        ? { type: "color", color: background.value }
        : undefined

    const didPayload = isVideoSource
      ? {
          // /clips endpoint — use persistent avatar_id if available, else raw source_url
          // avatar_id gives faster + more consistent renders; source_url is the fallback
          ...(resolvedAvatarId
            ? { avatar_id: resolvedAvatarId }
            : { source_url: sourceUrl }),
          script: {
            type: "audio",
            audio_url: ttsData.audio_url,
          },
          ...(bgValue ? { background: bgValue } : {}),
          config: { stitch: true, result_format: "mp4" },
        }
      : {
          // /talks endpoint — animate a still photo with natural movement
          source_url: sourceUrl,
          script: {
            type: "audio",
            audio_url: ttsData.audio_url,
          },
          driver_url: "bank://natural",
          expression,
          ...(bgValue ? { background: bgValue } : {}),
          config: { stitch: true, result_format: "mp4", fluent: true, pad_audio: 0.0 },
          face: { size: 1, top_x: 0, top_y: 0, overlap: "NO" },
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
          used_avatar_id: resolvedAvatarId ?? null,
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
