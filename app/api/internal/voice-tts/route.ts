import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { synthesizeSpeechStream, FALLBACK_VOICE_ID } from "@/lib/voice/elevenlabs-tts"

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

  // Resolve voice — prefer the agent's cloned voice
  const svc = createServiceClient()
  const { data: agent } = await svc
    .from("agents")
    .select("voice_id")
    .eq("user_id", user.id)
    .maybeSingle()

  const voiceId = agent?.voice_id || FALLBACK_VOICE_ID

  const result = await synthesizeSpeechStream({
    text,
    voiceId,
    voiceSettings: { stability: 0.5, similarity_boost: 0.78, style: 0.1 },
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
      "X-Voice-Source": agent?.voice_id ? "agent_clone" : "fallback",
    },
  })
}
