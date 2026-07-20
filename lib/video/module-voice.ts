// lib/video/module-voice.ts
//
// VOICE BY AUDIENCE for learning-module videos — a contact-facing explainer speaks in the AGENT's own
// cloned voice (it's their relationship); an agent-facing one in the brokerage's ASSISTANT voice. The
// module→video publish records the decision in video_metadata.voice (via voiceForAudience); the render
// worker calls resolveVideoVoiceId to turn that into the actual voice id. Kept out of the server-only
// presenter-media module so it stays unit-testable.

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

/** Platform STOCK ElevenLabs voice (Rachel) — the labeled last-resort fallback
 *  when neither the agent's clone nor the brokerage assistant voice exists.
 *  Same id as FALLBACK_VOICE_ID in lib/voice/elevenlabs-tts (duplicated here
 *  because that module is server-only and this one stays plain-tsx testable).
 *  Only used when ELEVENLABS_API_KEY is configured — otherwise the render
 *  honestly falls through to D-ID's default TTS (voice_source='did_default'). */
export const STOCK_VIDEO_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"

/** The brokerage's ASSISTANT voice — used for AGENT-facing videos. KEEP-ONE:
 *  the CANONICAL assistant identity is ai_identity_profiles (the same row the
 *  phone reception and report reels speak with; the settings page edits it);
 *  the legacy brokerages.default_isa_voice_id column stays as the fallback so
 *  tenants that only ever set the old field keep working. */
export async function resolveAssistantVoiceId(brokerageId: string, client?: Svc): Promise<string | null> {
  const svc = client ?? createServiceClient()
  if (!brokerageId) return null
  const { data: profile } = await svc.from("ai_identity_profiles")
    .select("elevenlabs_voice_id")
    .eq("scope_type", "brokerage").eq("scope_id", brokerageId).maybeSingle()
  if ((profile as any)?.elevenlabs_voice_id) return (profile as any).elevenlabs_voice_id
  const { data } = await svc.from("brokerages").select("default_isa_voice_id").eq("id", brokerageId).maybeSingle()
  return (data as { default_isa_voice_id?: string | null } | null)?.default_isa_voice_id ?? null
}

/**
 * Resolve which voice a learning-module / avatar-explainer video renders in.
 * assistant → the brokerage assistant voice (fallback to the presenter voice
 * when unset); anything else → the agent's own presenter voice, then the
 * brokerage assistant voice.
 *
 * LAST-RESORT (teammate-video lane honesty rule): when no tenant voice exists
 * at all but ELEVENLABS_API_KEY is configured, fall back to the platform STOCK
 * ElevenLabs voice instead of silently dropping to D-ID's default TTS. The
 * commission path labels this on video_metadata.voice_source
 * ('stock_elevenlabs') via lib/video/avatar-explainer, which mirrors this
 * exact cascade — keep the two in sync. No key → null (D-ID default TTS,
 * labeled 'did_default').
 */
export async function resolveVideoVoiceId(
  args: { voiceKind: "agent_own" | "assistant" | null | undefined; presenterVoiceId: string | null; brokerageId: string },
  client?: Svc,
): Promise<string | null> {
  const stockFallback = process.env.ELEVENLABS_API_KEY ? STOCK_VIDEO_VOICE_ID : null
  if (args.voiceKind === "assistant") {
    const assistant = await resolveAssistantVoiceId(args.brokerageId, client)
    return assistant ?? args.presenterVoiceId ?? stockFallback
  }
  if (args.presenterVoiceId) return args.presenterVoiceId
  const assistant = await resolveAssistantVoiceId(args.brokerageId, client)
  return assistant ?? stockFallback
}
