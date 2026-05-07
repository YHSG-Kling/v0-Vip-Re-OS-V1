"use server"

/**
 * Voice & Avatar Settings — agent-side preferences for SELF listening.
 *
 * Outbound voice/avatar (what contacts experience) is always the agent's
 * clone (agents.voice_id / agents.avatar_id). These settings control what
 * the AGENT THEMSELVES hears in their morning brief and assistant chat,
 * and what they see in their own avatar call.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { resolveWriteContext } from "@/lib/kernel/identity"

export interface AgentVoiceAvatarPrefs {
  voicePreference: "clone" | "generic"
  voiceId: string | null              // their cloned voice (read-only here; set via Voice Setup)
  assistantVoiceId: string | null     // generic voice ID when preference='generic'
  avatarId: string | null             // their cloned avatar (read-only)
  assistantAvatarId: string | null    // alt avatar choice for self-view
  cloneAvailable: boolean             // helps UI decide whether 'clone' option is usable
}

export async function getMyVoiceAvatarPrefs(): Promise<AgentVoiceAvatarPrefs | null> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.userId) return null

  const svc = createServiceClient()
  const { data: agent } = await svc
    .from("agents")
    .select("voice_id, assistant_voice_id, voice_preference, avatar_id, assistant_avatar_id")
    .eq("user_id", ctx.userId)
    .maybeSingle()

  if (!agent) return null

  return {
    voicePreference: (agent.voice_preference ?? "clone") as "clone" | "generic",
    voiceId: agent.voice_id ?? null,
    assistantVoiceId: agent.assistant_voice_id ?? null,
    avatarId: agent.avatar_id ?? null,
    assistantAvatarId: agent.assistant_avatar_id ?? null,
    cloneAvailable: !!agent.voice_id,
  }
}

export async function updateMyVoicePreference(params: {
  preference: "clone" | "generic"
  assistantVoiceId?: string | null
}): Promise<{ success: boolean; error?: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.userId) {
    return { success: false, error: "Unauthorized" }
  }

  const svc = createServiceClient()
  const { error } = await svc
    .from("agents")
    .update({
      voice_preference: params.preference,
      assistant_voice_id: params.preference === "generic" ? params.assistantVoiceId ?? null : null,
    })
    .eq("user_id", ctx.userId)

  return error ? { success: false, error: error.message } : { success: true }
}

export async function updateMyAssistantAvatar(params: {
  assistantAvatarId: string | null
}): Promise<{ success: boolean; error?: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.userId) {
    return { success: false, error: "Unauthorized" }
  }

  const svc = createServiceClient()
  const { error } = await svc
    .from("agents")
    .update({ assistant_avatar_id: params.assistantAvatarId })
    .eq("user_id", ctx.userId)

  return error ? { success: false, error: error.message } : { success: true }
}
