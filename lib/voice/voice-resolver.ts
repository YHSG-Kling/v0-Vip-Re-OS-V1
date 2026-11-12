/**
 * lib/voice/voice-resolver.ts
 *
 * SELF ONLY. Resolves the ElevenLabs voice ID + D-ID avatar ID for what the
 * AGENT hears/sees in their OWN surfaces — the morning brief, the standup
 * audio, the assistant chat, the internal TTS endpoint. It honors
 * agents.voice_preference: 'clone' → voice_id, 'generic' → assistant_voice_id
 * (or the platform fallback), and the same shape for the avatar
 * (assistant_avatar_id, the self-view twin, before the clone).
 *
 * Those self-view preferences are exactly why this module MUST NOT be used for
 * anything a CONTACT hears or sees.
 *
 * ── WHO FRONTS A CONTACT-FACING SURFACE (w8) ─────────────────────────────────
 * `resolveContactFacing` used to live here as the contact-facing half of a
 * pair. It was DELETED as a duplicate; the survivor is
 * `lib/video/video-identity.ts:resolveVideoIdentity` called with
 * `purpose: "contact_facing"`, which already fronts the listing pitch reel and
 * the Deal Room reel and is proof-locked by scripts/no-brokerage-face-guard.ts.
 * The survivor does the same job more completely:
 *
 *   · it reads agent_voice_profiles (elevenlabs_voice_id + did_photo_url) —
 *     the twin pipeline's own source of truth, honoring the profile the agent
 *     SELECTED in voice_assistant_config before their default one. This module
 *     read agents.voice_id, which lib/voice/sync-voice-id.ts documents as a
 *     PROMOTED COPY of that same column, and agents.avatar_id, which has ZERO
 *     writers anywhere in the tree — so the deleted function's avatar half
 *     could only ever return null.
 *   · it returns voiceId/avatarPhotoUrl as NULL when the agent has no twin, so
 *     the caller refuses honestly. The deleted function substituted
 *     FALLBACK_VOICE_ID — a stranger's voice under the agent's name, the same
 *     defect class the no-brokerage-face rule forbids. That behaviour was
 *     deliberately NOT ported.
 *
 * The self resolvers below keep the fallback: a stock voice reading YOUR OWN
 * brief to you is a convenience, not a misrepresentation.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { FALLBACK_VOICE_ID } from "./elevenlabs-tts"
import { ASSISTANT_VOICE_OPTIONS } from "@/lib/video/assistant-options"

export interface ResolvedVoice {
  voiceId: string                        // always populated (falls back to FALLBACK_VOICE_ID)
  source: "agent_clone" | "agent_generic_choice" | "platform_fallback"
}

export interface ResolvedAvatar {
  avatarId: string | null                // null when no avatar configured
  source: "agent_clone" | "agent_alt_choice" | "none"
}

// ---------------------------------------------------------------------------
// SELF — agent hearing their own assistant or daily brief
// ---------------------------------------------------------------------------

/**
 * Resolve voice for the agent's OWN listening (brief, assistant TTS).
 * Agent picks 'clone' (default) or 'generic' (uses assistant_voice_id).
 */
export async function resolveSelfVoice(agentUserId: string): Promise<ResolvedVoice> {
  const svc = createServiceClient()
  const { data: agent } = await svc
    .from("agents")
    .select("voice_id, assistant_voice_id, voice_preference")
    .eq("user_id", agentUserId)
    .maybeSingle()

  if (!agent) {
    return { voiceId: FALLBACK_VOICE_ID, source: "platform_fallback" }
  }

  if (agent.voice_preference === "generic") {
    if (agent.assistant_voice_id) {
      return { voiceId: agent.assistant_voice_id, source: "agent_generic_choice" }
    }
    return { voiceId: FALLBACK_VOICE_ID, source: "platform_fallback" }
  }

  // Default: 'clone' preference → use agent's own voice
  if (agent.voice_id) {
    return { voiceId: agent.voice_id, source: "agent_clone" }
  }
  // Clone preferred but no clone recorded yet → fall back
  return { voiceId: FALLBACK_VOICE_ID, source: "platform_fallback" }
}

export async function resolveSelfAvatar(agentUserId: string): Promise<ResolvedAvatar> {
  const svc = createServiceClient()
  const { data: agent } = await svc
    .from("agents")
    .select("avatar_id, assistant_avatar_id")
    .eq("user_id", agentUserId)
    .maybeSingle()

  if (!agent) return { avatarId: null, source: "none" }

  // Self-avatar: prefer assistant_avatar_id if set (agent's choice for own
  // self-view), otherwise their clone, otherwise none.
  if (agent.assistant_avatar_id) {
    return { avatarId: agent.assistant_avatar_id, source: "agent_alt_choice" }
  }
  if (agent.avatar_id) {
    return { avatarId: agent.avatar_id, source: "agent_clone" }
  }
  return { avatarId: null, source: "none" }
}

// ---------------------------------------------------------------------------
// Curated generic voice options for the settings UI
// ---------------------------------------------------------------------------

export interface GenericVoiceOption {
  id: string
  name: string
  description: string
  gender: "male" | "female"
  accent: string
}

/**
 * Curated ElevenLabs stock voices the agent can pick from in settings.
 *
 * DERIVED, NOT DUPLICATED. This used to be a second hand-maintained array of
 * the same eight-ish ids that lib/video/assistant-options.ts already curated —
 * two lists for one job, so a voice offered on the Assistant settings page
 * could be missing from the AI Identity picker, and one of them still called
 * EXAVITQu4vr4xnSDxMaL "Bella" years after ElevenLabs renamed it Sarah.
 * ASSISTANT_VOICE_OPTIONS is the survivor (it is the client-safe module; this
 * one is `server-only`), and this is a shape adapter over it so every existing
 * caller — the Assistant listening panel and the phone ISA voice card — keeps
 * the exact `GenericVoiceOption` shape it renders.
 */
export const GENERIC_VOICES: GenericVoiceOption[] = ASSISTANT_VOICE_OPTIONS.map((v) => ({
  id: v.voiceId,
  name: v.label,
  // The picker cards render this on one clamped line, so take the short half of
  // the style sentence rather than the full "…— great for client updates" tail.
  description: v.style.split("—")[0]!.trim(),
  gender: v.gender,
  accent: v.accent,
}))
