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
import { synthesizeSpeech } from "@/lib/voice/elevenlabs-tts"

const DEFAULT_MODEL = "eleven_turbo_v2_5"

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const auth = await requireAuth(supabase)
    if (!auth.ok) return auth.response

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

    // ONE SYNTHESIS PATH. This route used to re-implement the same buffered
    // POST /text-to-speech/{voice} that lib/voice/elevenlabs-tts.ts already
    // makes through the connector gateway — same endpoint, same headers, and a
    // hardcoded { stability: 0.5, similarity_boost: 0.75 } that was a copy of
    // that module's DEFAULT_VOICE_SETTINGS. Two callers of one provider, and
    // the copy was the one missing everything the module does around the call:
    // the connector gateway (self-healing + credential resolution), the vendor
    // BUDGET GATE, the per-character vendor-spend ledger, and a structured
    // errorCode instead of a flat 500.
    const tts = await synthesizeSpeech({
      text,
      voiceId: voice_id,
      modelId: model_id,
      brokerageId: auth.brokerageId ?? undefined,
    })

    if (!tts.success || !tts.audioBuffer) {
      console.error("[ElevenLabs] TTS error:", tts.error)
      // The module's own error classes reach the caller: a quota pause and a
      // bad voice id are different problems and were both a 500 before.
      const status = tts.errorCode === "quota" || tts.errorCode === "rate_limit" ? 429
        : tts.errorCode === "no_api_key" ? 503
        : tts.errorCode === "voice_not_found" ? 422
        : 500
      return NextResponse.json(
        { error: tts.error ?? "ElevenLabs TTS failed", errorCode: tts.errorCode ?? "unknown" },
        { status },
      )
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

    const audioBuffer = tts.audioBuffer

    if (!upload_to_storage) {
      // Hand the bytes straight back to the caller.
      return new NextResponse(new Uint8Array(audioBuffer), {
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Disposition": 'attachment; filename="voiceover.mp3"',
        },
      })
    }

    // Upload to Supabase Storage for use in D-ID / listing voiceover pipeline
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
