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

    // Upload to Supabase Storage for use in D-ID / listing voiceover pipeline.
    //
    // ONE MEDIA HOST. This was a bare `.storage.from("video-assets").upload(...)`
    // followed by a bare `.getPublicUrl(...)` — the only TTS byte in the tree
    // that did not ride lib/remotion/media-host.ts#hostRenderedMedia, while
    // lib/direct-mail/render-letter-audio.ts, lib/video/reel-voiceover.ts,
    // lib/podcast/auto-producer.ts and lib/voicedrop/orchestrate-voicedrop-send.ts
    // all do. Two things it therefore skipped: lib/storage/file-limits.ts
    // #checkUpload, so an oversized clip failed as an opaque storage refusal
    // instead of a readable ceiling; and lib/storage/document-buckets.ts
    // #issueBucketObjectUrl, so this call site decided a URL's class by itself.
    // `video-assets` is public-media, so the URL is unchanged — the point is
    // that nothing was checking, and a reclassification would have moved every
    // other TTS call site and silently missed this one.
    //
    // hostRenderedMedia THROWS on refusal (the Vercel Blob fallback that used to
    // swallow it is retired), so the failure is caught here and answered with
    // the same 500 the previous shape returned.
    const fileName = `tts/${auth.brokerageId}/${Date.now()}.mp3`
    let audioUrl: string
    try {
      const { hostRenderedMedia } = await import("@/lib/remotion/media-host")
      audioUrl = await hostRenderedMedia(supabase, fileName, audioBuffer, "audio/mpeg", "video-assets")
    } catch (uploadError: any) {
      console.error("[ElevenLabs] storage upload error:", uploadError?.message ?? uploadError)
      return NextResponse.json({ error: "Failed to upload audio to storage" }, { status: 500 })
    }

    return NextResponse.json({ success: true, audio_url: audioUrl })
  } catch (error: any) {
    console.error("[ElevenLabs] tts error:", error)
    return NextResponse.json({ error: error.message ?? "Internal server error" }, { status: 500 })
  }
}
