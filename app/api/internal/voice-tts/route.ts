import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { synthesizeSpeechStream, FALLBACK_VOICE_ID } from "@/lib/voice/elevenlabs-tts"
import { resolveSelfVoice, type ResolvedVoice } from "@/lib/voice/voice-resolver"
import { resolveVideoIdentity } from "@/lib/video/video-identity"
import { resolveOpenSimliSession } from "@/lib/did/live-session-metering"
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
 * TWO AUTH BRANCHES (lane 63B — anonymous embed/site visitors 401'd on the
 * Simli fail-over leg before this landed, because the route was gated on a
 * Supabase session with no other door in):
 *
 *   · `liveSessionId` present — the Simli face-render leg, portal contact OR
 *     anonymous embed/site visitor alike. Tenant/agent are resolved OFF THE
 *     `live_agent_sessions` ROW via resolveOpenSimliSession (CLAUDE.md §4:
 *     never from the body) — same open+fresh+provider==='simli' proof
 *     app/api/live-agent/simli-turn/route.ts requires for the brain relay,
 *     shared from lib/did/live-session-metering.ts rather than copied here.
 *     The voice is the assigned agent's — resolveVideoIdentity(purpose:
 *     "contact_facing"), the SAME resolver every other client-facing surface
 *     uses (lib/voice/voice-resolver.ts's own header names it the survivor);
 *     never resolveSelfVoice, which is SELF-listening only and would resolve
 *     to nothing for a contact/anonymous caller who is not an agent.
 *   · No `liveSessionId` — BYTE-IDENTICAL to the pre-existing path: Supabase
 *     session required, resolveSelfVoice(user.id) for the signed-in agent
 *     talking to their OWN InternalAIAssistant.
 *
 * POST /api/internal/voice-tts
 *   body: { text: string, format?: "pcm_16000", liveSessionId?: string }
 *   returns: audio/mpeg (default) or audio/pcm stream OR 401/404/409/500 with reason
 */
export async function POST(req: NextRequest) {
  let body: { text?: string; format?: string; liveSessionId?: string } = {}
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
  const liveSessionId = (body.liveSessionId ?? "").trim() || null

  let resolved: ResolvedVoice
  if (liveSessionId) {
    // ── Simli fail-over leg: session-scoped, no Supabase session required ──
    const svc = createServiceClient()
    const openSession = await resolveOpenSimliSession(svc, liveSessionId)
    if (!openSession.ok) {
      return NextResponse.json({ error: openSession.error }, { status: openSession.status })
    }
    const { agentId, brokerageId } = openSession.session
    if (!agentId) {
      return NextResponse.json({ error: "session has no agent assigned" }, { status: 409 })
    }
    const { data: agentRow, error: agentErr } = await svc
      .from("agents")
      .select("user_id")
      .eq("id", agentId)
      .maybeSingle()
    if (agentErr || !agentRow?.user_id) {
      return NextResponse.json({ error: "assigned agent not found" }, { status: 404 })
    }
    const identity = await resolveVideoIdentity(svc, {
      brokerageId,
      agentUserId: agentRow.user_id,
      purpose: "contact_facing",
    })
    resolved = identity.voiceId
      ? { voiceId: identity.voiceId, source: "agent_clone" }
      : { voiceId: FALLBACK_VOICE_ID, source: "platform_fallback" }
  } else {
    // ── Existing signed-in path — BYTE-IDENTICAL to pre-lane-63B behavior ──
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    // Resolve self-voice (honors voice_preference: clone vs generic choice) —
    // the SAME resolver for both formats; a Simli turn speaks in the same
    // cloned voice the browser-TTS path already uses, never a second identity.
    resolved = await resolveSelfVoice(user.id)
  }

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
