/**
 * POST /api/widget/avatar-talk
 * Public (no auth). Converts text to speech via ElevenLabs and sends it to a D-ID
 * streaming session so the agent avatar speaks in the website widget Live Agent mode.
 */
import { type NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"

const DID_API_BASE = "https://api.d-id.com"
const EL_API_BASE = "https://api.elevenlabs.io/v1"

export async function POST(request: NextRequest) {
  const { sessionId, text, agentId, brokerageId } = await request.json()
  if (!sessionId || !text || !agentId) {
    return NextResponse.json({ error: "sessionId, text, and agentId required" }, { status: 400 })
  }

  const didApiKey = process.env.DID_API_KEY
  const elApiKey = process.env.ELEVENLABS_API_KEY
  if (!didApiKey || !elApiKey) {
    return NextResponse.json({ error: "Live Agent avatar unavailable" }, { status: 503 })
  }

  const supabase = createServiceClient()

  // Get agent's ElevenLabs voice
  const { data: voiceProfile } = await supabase
    .from("agent_voice_profiles")
    .select("elevenlabs_voice_id")
    .eq("user_id", agentId)
    .maybeSingle()

  const voiceId = voiceProfile?.elevenlabs_voice_id
  if (!voiceId) return NextResponse.json({ error: "Agent has no voice configured" }, { status: 404 })

  // Call ElevenLabs TTS
  const elRes = await fetch(`${EL_API_BASE}/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": elApiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_turbo_v2_5",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  })

  if (!elRes.ok) return NextResponse.json({ error: "TTS failed" }, { status: 500 })

  const audioBuffer = await elRes.arrayBuffer()
  const bid = brokerageId ?? "shared"
  const uploadPath = `tts/widget/${bid}/${Date.now()}.mp3`

  const { error: uploadError } = await supabase.storage
    .from("video-assets")
    .upload(uploadPath, audioBuffer, { contentType: "audio/mpeg", upsert: false })

  if (uploadError) return NextResponse.json({ error: "Audio upload failed" }, { status: 500 })

  const { data: { publicUrl } } = supabase.storage.from("video-assets").getPublicUrl(uploadPath)

  // Send talk request to D-ID session
  const auth = `Basic ${Buffer.from(`${didApiKey}:`).toString("base64")}`
  const res = await fetch(`${DID_API_BASE}/talks/streams/${sessionId}`, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      script: { type: "audio", audio_url: publicUrl },
      config: { fluent: true, pad_audio: 0.0 },
      session_id: sessionId,
    }),
  })

  const data = await res.json()
  return res.ok
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: data.description ?? "D-ID talk failed" }, { status: 500 })
}
