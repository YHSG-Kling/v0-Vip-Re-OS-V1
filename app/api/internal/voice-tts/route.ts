import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { synthesizeSpeechStream } from "@/lib/voice/elevenlabs-tts"
import { resolveSelfVoice } from "@/lib/voice/voice-resolver"
import { elevenLabsModelForLane, ELEVENLABS_REALISM_VOICE_SETTINGS } from "@/lib/video/realism-profile"

/**
 * Voice TTS endpoint — streams ElevenLabs mp3 in the agent's cloned voice.
 *
 * Used by the InternalAIAssistant to speak responses in the agent's own
 * voice (instead of the browser's generic SpeechSynthesis voice). Falls
 * back gracefully — caller checks status and uses browser TTS on failure.
 *
 * POST /api/internal/voice-tts
 *   body: { text: string }
 *   returns: audio/mpeg stream OR 404/500 with reason
 */
export async function POST(req: NextRequest) {
  // Auth
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: { text?: string } = {}
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

  // Resolve self-voice (honors voice_preference: clone vs generic choice)
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
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
      "X-Voice-Source": resolved.source,
    },
  })
}
