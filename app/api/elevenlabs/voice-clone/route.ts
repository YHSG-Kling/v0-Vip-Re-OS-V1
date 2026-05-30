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
import { checkUsageCap } from "@/lib/usage/check-cap"
import { logMediaUsage } from "@/lib/usage/log-media-usage"

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
    const { name, sample_audio_urls, profile_id, twin_id } = body as {
      name: string
      sample_audio_urls: string[]
      /** Legacy: writes the clone to agent_voice_profiles (per-agent default). */
      profile_id?: string
      /** Twin Studio: writes the clone to a specific agent_avatar_assets row. */
      twin_id?: string
    }

    if (!name || !Array.isArray(sample_audio_urls) || sample_audio_urls.length < 1) {
      return NextResponse.json(
        { error: "Missing required fields: name, sample_audio_urls (min 1)" },
        { status: 400 }
      )
    }
    if (!profile_id && !twin_id) {
      return NextResponse.json(
        { error: "Either profile_id (legacy) or twin_id (Twin Studio) is required" },
        { status: 400 }
      )
    }

    // ─── Usage cap on voice clone creation ──────────────────────────────────
    const cap = await checkUsageCap({
      brokerageId: auth.brokerageId,
      metric: "voice_clones_created",
      addQuantity: 1,
    })
    if (!cap.allowed) {
      return NextResponse.json({ error: cap.message, capExceeded: true }, { status: 429 })
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
    const sample_url = sample_audio_urls[0] ?? null

    // Twin Studio path: bind the clone to a specific twin row.
    // The twin's voice is promoted to agents.voice_id only when the user
    // sets the twin as default (handled in app/actions/twin-studio.ts).
    if (twin_id) {
      const { data: twin } = await supabase
        .from("agent_avatar_assets")
        .select("id, agent_id")
        .eq("id", twin_id)
        .maybeSingle()
      if (!twin) {
        return NextResponse.json({ error: "Twin not found" }, { status: 404 })
      }
      await supabase
        .from("agent_avatar_assets")
        .update({
          voice_id: elevenlabs_voice_id,
          voice_sample_url: sample_url,
          updated_at: new Date().toISOString(),
        })
        .eq("id", twin_id)

      logMediaUsage({
        brokerageId: auth.brokerageId,
        metric: "voice_clones_created",
        quantity: 1,
        agentId: auth.agentId,
        userId: auth.userId,
        sessionRef: elevenlabs_voice_id,
        feature: "twin_studio",
        metadata: { twin_id },
      }).catch(() => {})

      return NextResponse.json({ success: true, elevenlabs_voice_id })
    }

    // Legacy path: per-agent default profile (kept for callers not yet on Twin Studio).
    await supabase
      .from("agent_voice_profiles")
      .update({ elevenlabs_voice_id })
      .eq("id", profile_id!)

    try {
      const { data: profile } = await supabase
        .from("agent_voice_profiles")
        .select("agent_id")
        .eq("id", profile_id!)
        .maybeSingle()
      if (profile?.agent_id) {
        const { syncAgentVoiceId } = await import("@/lib/voice/sync-voice-id")
        await syncAgentVoiceId({ agentId: profile.agent_id, elevenlabsVoiceId: elevenlabs_voice_id })
      }
    } catch (err) {
      console.warn("[elevenlabs/voice-clone] sync to agents.voice_id failed:", err)
    }

    logMediaUsage({
      brokerageId: auth.brokerageId,
      metric: "voice_clones_created",
      quantity: 1,
      agentId: auth.agentId,
      userId: auth.userId,
      sessionRef: elevenlabs_voice_id,
      feature: "voice_avatar_legacy",
      metadata: { profile_id },
    }).catch(() => {})

    return NextResponse.json({ success: true, elevenlabs_voice_id })
  } catch (error: any) {
    console.error("[ElevenLabs] voice-clone error:", error)
    return NextResponse.json({ error: error.message ?? "Internal server error" }, { status: 500 })
  }
}
