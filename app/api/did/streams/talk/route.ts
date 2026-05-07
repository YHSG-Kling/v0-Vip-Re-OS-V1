import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"

const DID_API_BASE = "https://api.d-id.com"

/**
 * POST: drive the D-ID streaming avatar to speak `text`, using the assigned
 * agent's ElevenLabs cloned voice when available.
 *
 * Caller (portal) sends { sessionId, text, contactId, sourceType } so the
 * route can:
 *   1. Resolve the contact → assigned agent → agents.voice_id (canonical, set
 *      by syncAgentVoiceId after voice clone) for ElevenLabs TTS.
 *   2. Pick the correct D-ID streaming endpoint:
 *        presenter | video → /clips/streams/{id}
 *        photo            → /talks/streams/{id}
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  const didApiKey = process.env.DID_API_KEY
  if (!didApiKey) return NextResponse.json({ error: "DID_API_KEY not configured" }, { status: 503 })

  const { sessionId, text, contactId, sourceType } = await request.json()
  if (!sessionId || !text) return NextResponse.json({ error: "sessionId and text required" }, { status: 400 })

  // ── Resolve the agent's cloned voice via the contact's assigned agent ────
  // Canonical voice_id lives on agents.voice_id (synced from
  // agent_voice_profiles.elevenlabs_voice_id by syncAgentVoiceId).
  let voiceId: string | null = null
  if (contactId) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("agent_id")
      .eq("id", contactId)
      .maybeSingle()

    if (contact?.agent_id) {
      const { data: agent } = await supabase
        .from("agents")
        .select("voice_id")
        .eq("id", contact.agent_id)
        .maybeSingle()
      voiceId = agent?.voice_id ?? null
    }
  }

  // ── Generate audio via ElevenLabs TTS (uses agent's voice when set) ──────
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
  const ttsRes = await fetch(`${appUrl}/api/elevenlabs/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: request.headers.get("cookie") ?? "" },
    body: JSON.stringify({
      text,
      voice_id: voiceId,
      upload_to_storage: true,
    }),
  })

  const ttsData = ttsRes.ok ? await ttsRes.json() : null
  if (!ttsData?.audio_url) return NextResponse.json({ error: "TTS generation failed" }, { status: 500 })

  // ── Pick the correct D-ID streaming endpoint per source mode ─────────────
  // Sessions created with presenter_id or source_type=video live under
  // /clips/streams; photo sessions live under /talks/streams.
  const streamPath = sourceType === "presenter" || sourceType === "video"
    ? "clips/streams"
    : "talks/streams"

  const res = await fetch(`${DID_API_BASE}/${streamPath}/${sessionId}`, {
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

  const data = await res.json().catch(() => ({}))
  return res.ok
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: data.description ?? "D-ID talk failed" }, { status: 500 })
}
