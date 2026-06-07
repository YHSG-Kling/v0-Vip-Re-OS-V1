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
 *   background?: { type: "color" | "image" | "video"; value: string },
 *   intro_video_url?: string,     // brokerage-curated clip prepended to the
 *                                 // branded main video
 *   outro_video_url?: string,     // brokerage-curated clip appended to the
 *                                 // branded main video
 *   b_roll_urls?: string[],       // splice candidates stored on the row for
 *                                 // the audit trail; segment splicing wired
 *                                 // in a follow-up
 * }
 * Provide at least one of agent_photo_url or agent_video_url.
 *
 * Background types:
 *   color  → static color behind the avatar (D-ID composites it pre-render)
 *   image  → static image behind the avatar (D-ID composites it pre-render)
 *   video  → EXPLAINER MODE. D-ID still renders just the talking head; the
 *            poll cron post-composites it as a bottom-right PIP over the
 *            background video (typical: property walkthrough, drone footage,
 *            screen recording). Logo moves to top-left, attribution band
 *            spans the bottom edge. The value is the public video URL.
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
      intro_video_url,
      outro_video_url,
      b_roll_urls,
      // Optional: request the full avatar→Remotion chain. When target_composition_id
      // is set, the poll-did-videos cron hands the finished D-ID video off to that
      // Remotion composition (avatar URL wired into input_props) on completion.
      target_composition_id,
      composition_voiceover_url,
      composition_input_props,
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

    // ─── Resolve usage_intent + bake real-estate ad-law disclosure ────────────
    // ai_video_projects.usage_intent (migration 1085) decides whether the
    // rendered video needs the legally-required brokerage disclosure:
    //   public_marketing / both → verbal disclosure appended to script
    //   mls                     → render is left clean (MLS forbids
    //                             agent / brokerage attribution)
    // ffmpeg-based visual overlay is deferred (per lib/did/index.ts notes),
    // so the disclosure goes into the script the avatar speaks.
    let renderScript: string = script
    let injectedDisclosure = false
    let captionsEnabled = false
    {
      const { data: videoRow } = await supabase
        .from("ai_video_projects")
        .select("usage_intent, captions_enabled")
        .eq("id", video_project_id)
        .maybeSingle()
      const usageIntent: string = videoRow?.usage_intent ?? "public_marketing"
      captionsEnabled = videoRow?.captions_enabled ?? false

      if (usageIntent !== "mls" && auth.brokerageId) {
        const { data: brokerage } = await supabase
          .from("brokerages")
          .select("name, dba, license_number, license_state")
          .eq("id", auth.brokerageId)
          .maybeSingle()
        const tradeName = brokerage?.dba ?? brokerage?.name
        if (tradeName) {
          const licenseSuffix = brokerage?.license_number
            ? `, License ${brokerage.license_number}${brokerage?.license_state ? ` ${brokerage.license_state}` : ""}`
            : ""
          // Concise verbal disclosure — kept short so it doesn't disrupt the
          // narrative. Equal Housing Opportunity is included because most
          // listing-related videos count as housing-related advertising
          // under the federal Fair Housing Act.
          const disclosure = `. Brought to you by ${tradeName}${licenseSuffix}. Equal Housing Opportunity.`
          renderScript = `${script.replace(/[.!?\s]+$/, "")}${disclosure}`
          injectedDisclosure = true
        }
      }

      await supabase
        .from("ai_video_projects")
        .update({ has_verbal_disclosure: injectedDisclosure })
        .eq("id", video_project_id)
    }

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
        text: renderScript,
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
    // type='video' is the EXPLAINER mode: D-ID still renders only the talking
    // head; we persist the video URL on the row so the poll cron can post-
    // composite the head as a PIP over it.
    const bgValue: string | { type: string; url?: string; color?: string } | undefined =
      background?.type === "image" && background?.value
        ? { type: "image", url: background.value }
        : background?.type === "color" && background?.value
        ? { type: "color", color: background.value }
        : undefined

    // Persist the cinematic-touch selections on the row so the cron knows what
    // to composite after D-ID returns. background_type/background_url drive
    // the standard-vs-explainer decision; intro/outro/b-roll are layered on
    // top of whichever rendering mode the agent picked.
    const cinematicUpdates: Record<string, unknown> = {}
    if (background?.type && background?.value) {
      cinematicUpdates.background_type = background.type
      cinematicUpdates.background_url  = background.value
    }
    if (typeof intro_video_url === "string" && intro_video_url.length > 0) {
      cinematicUpdates.intro_video_url = intro_video_url
    }
    if (typeof outro_video_url === "string" && outro_video_url.length > 0) {
      cinematicUpdates.outro_video_url = outro_video_url
    }
    if (Array.isArray(b_roll_urls) && b_roll_urls.length > 0) {
      // Filter to valid URL strings; the column is jsonb.
      cinematicUpdates.b_roll_urls = b_roll_urls.filter(
        (u): u is string => typeof u === "string" && u.length > 0
      )
    }
    if (Object.keys(cinematicUpdates).length > 0) {
      await supabase
        .from("ai_video_projects")
        .update(cinematicUpdates)
        .eq("id", video_project_id)
    }

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
          // D-ID natively burns captions into the mp4 when subtitles=true.
          ...(captionsEnabled ? { subtitles: true } : {}),
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
          ...(captionsEnabled ? { subtitles: true } : {}),
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
          // Avatar→Remotion chain request (consumed by poll-did-videos handoff).
          ...(target_composition_id ? {
            target_composition_id,
            voiceover_url: composition_voiceover_url ?? null,
            input_props: composition_input_props ?? {},
          } : {}),
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
