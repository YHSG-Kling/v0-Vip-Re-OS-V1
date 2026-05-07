/**
 * POST /api/elevenlabs/voice-clone
 * Clones an agent's voice via ElevenLabs Instant Voice Clone API.
 * Much cheaper than HeyGen voice cloning for high-volume TTS.
 *
 * Body: { name: string, sample_audio_urls: string[], profile_id: string }
 * Returns: { elevenlabs_voice_id: string }
 */

import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"

const EL_API_BASE = "https://api.elevenlabs.io/v1"

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const auth = await requireAuth(supabase)
    if (!auth.ok) return auth.response

    const apiKey = process.env.ELEVENLABS_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: "ElevenLabs API key not configured" }, { status: 503 })
    }

    const body = await request.json()
    const { name, sample_audio_urls, profile_id } = body

    if (!name || !Array.isArray(sample_audio_urls) || sample_audio_urls.length < 1 || !profile_id) {
      return NextResponse.json(
        { error: "Missing required fields: name, sample_audio_urls (min 1), profile_id" },
        { status: 400 }
      )
    }

    // Download and attach audio samples as multipart/form-data
    const formData = new FormData()
    formData.append("name", name)
    formData.append("description", `Agent voice clone for ${auth.user.email}`)

    for (const url of sample_audio_urls) {
      const audioRes = await fetch(url)
      if (!audioRes.ok) {
        return NextResponse.json({ error: `Failed to fetch audio sample: ${url}` }, { status: 400 })
      }
      const blob = await audioRes.blob()
      formData.append("files", blob, "sample.mp3")
    }

    const elRes = await fetch(`${EL_API_BASE}/voices/add`, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: formData,
    })

    const elData = await elRes.json()

    if (!elRes.ok) {
      console.error("[ElevenLabs] voice clone error:", elData)
      return NextResponse.json(
        { error: elData.detail?.message ?? "ElevenLabs voice clone failed" },
        { status: 500 }
      )
    }

    const elevenlabs_voice_id: string = elData.voice_id

    // Store the new clone id on the rich training profile.
    await supabase
      .from("agent_voice_profiles")
      .update({ elevenlabs_voice_id })
      .eq("id", profile_id)

    // Promote to the canonical agents.voice_id slot — the AI ISA call
    // resolver reads from there. Without this sync the agent could
    // complete a voice clone here and ISA calls would still fall back
    // to the brokerage default. Look up agent_id from the profile, then
    // delegate to syncAgentVoiceId.
    try {
      const { data: profile } = await supabase
        .from("agent_voice_profiles")
        .select("agent_id")
        .eq("id", profile_id)
        .maybeSingle()
      if (profile?.agent_id) {
        const { syncAgentVoiceId } = await import("@/lib/voice/sync-voice-id")
        await syncAgentVoiceId({ agentId: profile.agent_id, elevenlabsVoiceId: elevenlabs_voice_id })
      }
    } catch (err) {
      console.warn("[elevenlabs/voice-clone] sync to agents.voice_id failed:", err)
    }

    return NextResponse.json({ success: true, elevenlabs_voice_id })
  } catch (error: any) {
    console.error("[ElevenLabs] voice-clone error:", error)
    return NextResponse.json({ error: error.message ?? "Internal server error" }, { status: 500 })
  }
}
