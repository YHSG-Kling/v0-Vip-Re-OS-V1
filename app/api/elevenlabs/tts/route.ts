/**
 * POST /api/elevenlabs/tts
 * Converts text to speech using ElevenLabs TTS.
 * Used as the voice input for D-ID avatar videos and listing voiceovers.
 *
 * Body: { text: string, voice_id: string, model_id?: string }
 * Returns: audio/mpeg stream OR { audio_url: string } if uploaded to storage
 */

import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { checkUsageCap } from "@/lib/usage/check-cap"
import { logMediaUsage } from "@/lib/usage/log-media-usage"

const EL_API_BASE = "https://api.elevenlabs.io/v1"
const DEFAULT_MODEL = "eleven_turbo_v2_5"

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
    const { text, voice_id, model_id = DEFAULT_MODEL, upload_to_storage = false } = body

    if (!text || !voice_id) {
      return NextResponse.json({ error: "Missing required fields: text, voice_id" }, { status: 400 })
    }

    // ─── Usage cap on TTS characters ────────────────────────────────────────
    const charCount = text.length
    const cap = await checkUsageCap({
      brokerageId: auth.brokerageId,
      metric: "tts_characters",
      addQuantity: charCount,
    })
    if (!cap.allowed) {
      return NextResponse.json({ error: cap.message, capExceeded: true }, { status: 429 })
    }

    const elRes = await fetch(`${EL_API_BASE}/text-to-speech/${voice_id}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    })

    if (!elRes.ok) {
      const errText = await elRes.text()
      console.error("[ElevenLabs] TTS error:", errText)
      return NextResponse.json({ error: "ElevenLabs TTS failed" }, { status: 500 })
    }

    // ─── Log TTS character usage on success ─────────────────────────────────
    logMediaUsage({
      brokerageId: auth.brokerageId,
      metric: "tts_characters",
      quantity: charCount,
      agentId: auth.agentId,
      userId: auth.userId,
      sessionRef: voice_id,
      feature: "elevenlabs_tts",
    }).catch(() => {})

    if (!upload_to_storage) {
      // Stream audio directly back to client
      const audioBuffer = await elRes.arrayBuffer()
      return new NextResponse(audioBuffer, {
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Disposition": 'attachment; filename="voiceover.mp3"',
        },
      })
    }

    // Upload to Supabase Storage for use in D-ID / listing voiceover pipeline
    const audioBuffer = await elRes.arrayBuffer()
    const fileName = `tts/${auth.brokerageId}/${Date.now()}.mp3`
    const { error: uploadError } = await supabase.storage
      .from("video-assets")
      .upload(fileName, audioBuffer, { contentType: "audio/mpeg", upsert: false })

    if (uploadError) {
      console.error("[ElevenLabs] storage upload error:", uploadError)
      return NextResponse.json({ error: "Failed to upload audio to storage" }, { status: 500 })
    }

    const { data: { publicUrl } } = supabase.storage.from("video-assets").getPublicUrl(fileName)

    return NextResponse.json({ success: true, audio_url: publicUrl })
  } catch (error: any) {
    console.error("[ElevenLabs] tts error:", error)
    return NextResponse.json({ error: error.message ?? "Internal server error" }, { status: 500 })
  }
}
