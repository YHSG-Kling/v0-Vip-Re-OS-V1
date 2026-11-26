// lib/voice/render-voice-drop.ts
// ─────────────────────────────────────────────────────────────────────────────
// renderVoiceDrop — THE ONE "synthesize a short personalized voicemail and
// host it" primitive (§6). Built for wave 58's owner ruling: an outbound
// AI-ISA call that hits AMD (Twilio detects an answering machine) should not
// have Twilio's <Say> read a robotic line over the beep — it should PLAY a
// pre-rendered clip in the agent's own cloned voice, same as every other
// avatar/narration surface this repo already upgraded for realism (wave 57:
// "the video product...must not think it was made with ai" — the same bar
// applies to a voicemail).
//
// MODEL + PACING: elevenLabsModelForLane("voice_drop") (lib/video/
// realism-profile.ts) resolves to eleven_v3 — the narration-quality model, not
// the phone_realtime one — because a voice drop is scripted and never
// interrupted (see that lane's own header note for the full reasoning).
// withNaturalPauses paces sentence/paragraph boundaries with v3's audio tags
// before synthesis; ELEVENLABS_REALISM_VOICE_SETTINGS is the ONE voice_settings
// tuning every realism-tuned caller in this repo shares.
//
// STORAGE: hostRenderedMedia (lib/remotion/media-host.ts) — the SAME public,
// unauthenticated-fetchable media path already used for D-ID/Remotion renders
// and for the ringless-voicedrop rail (see the tombstone in
// lib/voicedrop/orchestrate-voicedrop-send.ts below) — a Twilio <Play> verb
// fetches this URL directly, with no session or bearer token, so it must be
// the public-hosted URL, never the tenant-scoped recording-playback proxy.
//
// ORPHAN DOCTRINE (§1 — DUPLICATE): lib/voicedrop/orchestrate-voicedrop-send.ts
// already had a private, unexported `synthVoicemail` doing the exact same
// "ElevenLabs → mp3 buffer → hostRenderedMedia" work for the ringless-drop
// rail — but hardcoded NO modelId (silently defaulting to the oldest
// `eleven_monolingual_v1`, never touched by the wave 55/57 realism upgrades)
// and no natural-pause pacing. This function is the SURVIVOR: that file's
// `synthVoicemail` now calls this one for the synthesize+host step (merged
// onto the survivor, tombstoned there) instead of repeating it — so the
// ringless-drop rail gets the SAME v3 upgrade for free, not a second one.
import "server-only"

export interface RenderVoiceDropInput {
  /** The words to speak — plain text; natural-pause markup is inserted here,
   *  the caller does not pre-tag it. */
  script: string
  /** The agent's/brokerage's ElevenLabs voice id. Omit/null to fall back to
   *  ElevenLabs' own stock voice (lib/voice/elevenlabs-tts.ts FALLBACK_VOICE_ID) —
   *  never a second hardcoded voice id here. */
  voiceId?: string | null
  /** Tenant — required for the vendor-spend ledger and the budget gate
   *  synthesizeSpeech already enforces. */
  brokerageId: string
  /** Namespacing hint for the storage key (a CallSid, a preset id, …) — pure
   *  cosmetics, collision-avoidance only. Falls back to a timestamp. */
  storageKeyHint?: string | null
}

export type RenderVoiceDropResult =
  | { ok: true; audioUrl: string }
  | { ok: false; error: string }

/**
 * Synthesize a short personalized voicemail in a cloned (or stock) ElevenLabs
 * voice and host it at a public, Twilio-<Play>-fetchable URL. Never throws —
 * every failure (no API key, budget exceeded, synthesis error, storage
 * refusal) degrades to `{ ok: false }` so a caller can fall back to a plain
 * `<Say>` of the same script rather than breaking the call.
 */
export async function renderVoiceDrop(input: RenderVoiceDropInput): Promise<RenderVoiceDropResult> {
  const script = (input.script ?? "").trim()
  if (!script) return { ok: false, error: "renderVoiceDrop: empty script" }

  const { elevenLabsModelForLane, withNaturalPauses } = await import("@/lib/video/realism-profile")
  const modelId = elevenLabsModelForLane("voice_drop")
  const paced = withNaturalPauses(script, modelId)

  const { synthesizeSpeech, FALLBACK_VOICE_ID } = await import("@/lib/voice/elevenlabs-tts")
  const result = await synthesizeSpeech({
    text: paced,
    voiceId: (input.voiceId ?? "").trim() || FALLBACK_VOICE_ID,
    modelId,
    brokerageId: input.brokerageId,
  })
  if (!result.success || !result.audioBuffer) {
    return { ok: false, error: result.error ?? `renderVoiceDrop synthesis failed (${result.errorCode ?? "unknown"})` }
  }

  try {
    const { hostRenderedMedia } = await import("@/lib/remotion/media-host")
    const { createServiceClient } = await import("@/lib/supabase/service")
    const key = `voice-drops/${input.brokerageId}/${(input.storageKeyHint ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60) || Date.now()}.mp3`
    const audioUrl = await hostRenderedMedia(createServiceClient(), key, result.audioBuffer, "audio/mpeg", "media")
    return { ok: true, audioUrl }
  } catch (e: any) {
    return { ok: false, error: `renderVoiceDrop storage upload failed: ${e?.message ?? "unknown"}` }
  }
}
