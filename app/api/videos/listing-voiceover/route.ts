/**
 * POST /api/videos/listing-voiceover
 * Cheapest video type: no avatar needed.
 * Generates ElevenLabs TTS voiceover over property images.
 * The client stitches images + audio into a slideshow video.
 *
 * Body: {
 *   video_project_id: string,
 *   script: string,
 *   elevenlabs_voice_id: string,
 *   property_image_urls: string[],  // in display order
 * }
 * Returns: { audio_url: string, property_image_urls: string[], video_project_id: string }
 */

import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const auth = await requireAuth(supabase)
    if (!auth.ok) return auth.response

    const body = await request.json()
    const { video_project_id, script, elevenlabs_voice_id, property_image_urls } = body

    if (!video_project_id || !script || !elevenlabs_voice_id || !Array.isArray(property_image_urls)) {
      return NextResponse.json(
        { error: "Missing required fields: video_project_id, script, elevenlabs_voice_id, property_image_urls" },
        { status: 400 }
      )
    }

    // Generate ElevenLabs TTS and upload to storage
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
      return NextResponse.json({ error: "Failed to generate voiceover audio" }, { status: 500 })
    }

    // Update project with audio URL — client handles slideshow rendering
    await supabase
      .from("ai_video_projects")
      .update({
        status: "audio_ready",
        provider_status: "audio_ready",
        provider_metadata: {
          provider: "slideshow",
          audio_url: ttsData.audio_url,
          property_image_urls,
        },
        error_message: null,
      })
      .eq("id", video_project_id)

    await supabase.from("video_render_log").insert({
      project_id: video_project_id,
      provider: "elevenlabs_slideshow",
    })

    return NextResponse.json({
      success: true,
      audio_url: ttsData.audio_url,
      property_image_urls,
      video_project_id,
    })
  } catch (error: any) {
    console.error("[ListingVoiceover] error:", error)
    return NextResponse.json({ error: error.message ?? "Internal server error" }, { status: 500 })
  }
}
