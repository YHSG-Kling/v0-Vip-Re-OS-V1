import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { synthesizeSpeechStream } from "@/lib/voice/elevenlabs-tts"
import { resolveSelfVoice } from "@/lib/voice/voice-resolver"
import { elevenLabsModelForLane, ELEVENLABS_REALISM_VOICE_SETTINGS } from "@/lib/video/realism-profile"

/**
 * Voice TTS endpoint — streams ElevenLabs audio in the agent's cloned voice.
 * Defaults to mp3; `format: "pcm_16000"` returns raw PCM16 mono 16kHz
 * instead (wave 62 — the Simli live-agent fail-over leg feeds this straight
 * to simli-client's sendAudioData, which requires exactly that format; no
 * other caller sets it, so every existing caller is byte-for-byte
 * unaffected).
 *
 * Used by the InternalAIAssistant to speak responses in the agent's own
 * voice (instead of the browser's generic SpeechSynthesis voice), and by
 * SimliFaceSession for the Simli fail-over leg. Falls back gracefully —
 * caller checks status and uses browser TTS / same-brain text chat on
 * failure.
 *
 * POST /api/internal/voice-tts
 *   body: { text: string, format?: "pcm_16000" }
 *   returns: audio/mpeg (default) or audio/pcm stream OR 404/500 with reason
 */
export async function POST(req: NextRequest) {
  // Auth
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: { text?: string; format?: string } = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const text = (body.text ?? "").trim()
  if (!text) {
    return NextResponse.json({ error: "Missing text" }, { status: 400 })
  }
  if (text.length > 2000) {
    return NextResponse.json({ error: "Text too long (max 2000 chars)" }, { status: 400 })
  }
  // WHITELISTED, not passed through raw — an unrecognized format falls back
  // to mp3 rather than forwarding an arbitrary string to ElevenLabs.
  const outputFormat = body.format === "pcm_16000" ? ("pcm_16000" as const) : undefined

  // Resolve self-voice (honors voice_preference: clone vs generic choice) —
  // the SAME resolver for both formats; a Simli turn speaks in the same
  // cloned voice the browser-TTS path already uses, never a second identity.
  const resolved = await resolveSelfVoice(user.id)

  // WAVE 58: model + voice_settings resolved via the ONE selectors (§6) —
  // elevenLabsModelForLane("phone_realtime") (this is real-time, interactive
  // TTS: the agent is waiting for the assistant to start talking, same
  // register as the phone receptionist's live turn) and
  // ELEVENLABS_REALISM_VOICE_SETTINGS (lib/video/realism-profile.ts) — instead
  // of a hand-rolled literal that SILENTLY OVERRODE the tuned realism default
  // synthesizeSpeechStream already falls back to (its own DEFAULT_VOICE_SETTINGS
  // IS ELEVENLABS_REALISM_VOICE_SETTINGS) with the untuned, pre-wave-55 numbers.
  const result = await synthesizeSpeechStream({
    text,
    voiceId: resolved.voiceId,
    modelId: elevenLabsModelForLane("phone_realtime"),
    voiceSettings: ELEVENLABS_REALISM_VOICE_SETTINGS,
    outputFormat,
  })

  if (!result.success || !result.response) {
    return NextResponse.json(
      { error: result.error ?? "TTS failed", code: result.errorCode },
      { status: 502 }
    )
  }

  // Pipe ElevenLabs response straight to client
  return new Response(result.response.body, {
    status: 200,
    headers: {
      "Content-Type": outputFormat ? "audio/pcm" : "audio/mpeg",
      "Cache-Control": "no-store",
      "X-Voice-Source": resolved.source,
    },
  })
}
