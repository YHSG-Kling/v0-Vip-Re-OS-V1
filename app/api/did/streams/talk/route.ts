import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"

const DID_API_BASE = "https://api.d-id.com"

/** POST: make the avatar speak a given text via ElevenLabs TTS → D-ID stream */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  const didApiKey = process.env.DID_API_KEY
  if (!didApiKey) return NextResponse.json({ error: "DID_API_KEY not configured" }, { status: 503 })

  const { sessionId, text } = await request.json()
  if (!sessionId || !text) return NextResponse.json({ error: "sessionId and text required" }, { status: 400 })

  // Get agent's ElevenLabs voice_id from their voice profile
  const { data: voiceProfile } = await supabase
    .from("agent_voice_profiles")
    .select("elevenlabs_voice_id")
    .eq("user_id", auth.user!.id)
    .maybeSingle()

  // Generate audio via ElevenLabs TTS
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
  const ttsRes = await fetch(`${appUrl}/api/elevenlabs/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: request.headers.get("cookie") ?? "" },
    body: JSON.stringify({
      text,
      voice_id: voiceProfile?.elevenlabs_voice_id,
      upload_to_storage: true,
    }),
  })

  const ttsData = ttsRes.ok ? await ttsRes.json() : null
  if (!ttsData?.audio_url) return NextResponse.json({ error: "TTS generation failed" }, { status: 500 })

  // Send talk request to D-ID streaming session
  const res = await fetch(`${DID_API_BASE}/talks/streams/${sessionId}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${didApiKey}:`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      script: { type: "audio", audio_url: ttsData.audio_url },
      config: { fluent: true, pad_audio: 0.0 },
      session_id: sessionId,
    }),
  })

  const data = await res.json()
  return res.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: data.description ?? "D-ID talk failed" }, { status: 500 })
}
