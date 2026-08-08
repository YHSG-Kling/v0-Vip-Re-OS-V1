/**
 * lib/voice/voice-resolver.ts
 *
 * Resolves the right ElevenLabs voice ID + DID avatar ID for any speaking
 * surface. Two contexts:
 *
 *   1. SELF — what the agent hears/sees in their own assistant + brief.
 *      Honors agents.voice_preference: 'clone' → voice_id, 'generic' →
 *      assistant_voice_id (or platform fallback). Same pattern for avatar.
 *
 *   2. CONTACT_FACING — what a contact (buyer/seller/lifetime customer)
 *      hears/sees when interacting with their agent's portal AI chat or
 *      avatar call. ALWAYS uses the agent's clone — that's the whole point:
 *      the contact feels they're talking to their actual agent.
 *
 * All resolution returns the FALLBACK_VOICE_ID / null avatar gracefully so
 * callers never crash on missing data.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { FALLBACK_VOICE_ID } from "./elevenlabs-tts"
import { ASSISTANT_VOICE_OPTIONS } from "@/lib/video/assistant-options"

export type VoiceContext = "self" | "contact_facing"

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
// CONTACT-FACING — contact hearing/seeing their agent
// ---------------------------------------------------------------------------

/**
 * Resolve the voice + avatar a CONTACT should hear/see when interacting
 * with their assigned agent's AI surface (portal AI chat, video call, etc.).
 *
 * Always uses the agent's clone — voice_preference is irrelevant here.
 */
export async function resolveContactFacing(contactId: string): Promise<{
  voice: ResolvedVoice
  avatar: ResolvedAvatar
  agentName: string | null
}> {
  const svc = createServiceClient()

  // Find the contact's assigned agent
  const { data: contact } = await svc
    .from("contacts")
    .select("agent_id")
    .eq("id", contactId)
    .maybeSingle()

  if (!contact?.agent_id) {
    return {
      voice: { voiceId: FALLBACK_VOICE_ID, source: "platform_fallback" },
      avatar: { avatarId: null, source: "none" },
      agentName: null,
    }
  }

  const { data: agent } = await svc
    .from("agents")
    .select("voice_id, avatar_id, user_id")
    .eq("id", contact.agent_id)
    .maybeSingle()

  if (!agent) {
    return {
      voice: { voiceId: FALLBACK_VOICE_ID, source: "platform_fallback" },
      avatar: { avatarId: null, source: "none" },
      agentName: null,
    }
  }

  let agentName: string | null = null
  if (agent.user_id) {
    const { data: u } = await svc
      .from("users")
      .select("first_name, last_name")
      .eq("id", agent.user_id)
      .maybeSingle()
    agentName = [u?.first_name, u?.last_name].filter(Boolean).join(" ") || null
  }

  return {
    voice: agent.voice_id
      ? { voiceId: agent.voice_id, source: "agent_clone" }
      : { voiceId: FALLBACK_VOICE_ID, source: "platform_fallback" },
    avatar: agent.avatar_id
      ? { avatarId: agent.avatar_id, source: "agent_clone" }
      : { avatarId: null, source: "none" },
    agentName,
  }
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
