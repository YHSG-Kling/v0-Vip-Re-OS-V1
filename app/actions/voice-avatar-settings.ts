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
import { resolveActingContext, resolveWriteContextForTenant } from "@/lib/platform/acting-context"

export interface AgentVoiceAvatarPrefs {
  voicePreference: "clone" | "generic"
  voiceId: string | null              // their cloned voice (read-only here; set via Voice Setup)
  assistantVoiceId: string | null     // generic voice ID when preference='generic'
  prospectVoiceId: string | null      // voice the AI uses when role-playing a prospect in objection training
  avatarId: string | null             // their cloned avatar (read-only)
  assistantAvatarId: string | null    // alt avatar choice for self-view
  cloneAvailable: boolean             // helps UI decide whether 'clone' option is usable
}

export async function getMyVoiceAvatarPrefs(): Promise<AgentVoiceAvatarPrefs | null> {
  const ctx = await resolveActingContext()
  if (!ctx.ok || !ctx.userId) return null

  const svc = createServiceClient()
  const { data: agent } = await svc
    .from("agents")
    .select("voice_id, assistant_voice_id, prospect_voice_id, voice_preference, avatar_id, assistant_avatar_id")
    .eq("user_id", ctx.userId)
    .maybeSingle()

  if (!agent) return null

  return {
    voicePreference: (agent.voice_preference ?? "clone") as "clone" | "generic",
    voiceId: agent.voice_id ?? null,
    assistantVoiceId: agent.assistant_voice_id ?? null,
    prospectVoiceId: agent.prospect_voice_id ?? null,
    avatarId: agent.avatar_id ?? null,
    assistantAvatarId: agent.assistant_avatar_id ?? null,
    cloneAvailable: !!agent.voice_id,
  }
}

export async function updateMyVoicePreference(params: {
  preference: "clone" | "generic"
  assistantVoiceId?: string | null
}): Promise<{ success: boolean; error?: string }> {
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok || !ctx.userId) {
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

/**
 * Set the voice the AI uses when role-playing a prospect during objection
 * training. Should differ from the agent's own cloned voice so practice
 * feels like a real call. Caller is responsible for that check; we only
 * persist whatever the user picked.
 */
export async function updateMyProspectVoice(params: {
  prospectVoiceId: string | null
}): Promise<{ success: boolean; error?: string }> {
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok || !ctx.userId) {
    return { success: false, error: "Unauthorized" }
  }

  const svc = createServiceClient()
  const { error } = await svc
    .from("agents")
    .update({ prospect_voice_id: params.prospectVoiceId })
    .eq("user_id", ctx.userId)

  return error ? { success: false, error: error.message } : { success: true }
}

/**
 * Choose which of the agent's OWN twins fronts their self-view (morning brief,
 * assistant chat, their own avatar call). Pass null to clear back to their
 * default clone.
 *
 * OWNERSHIP IS ENFORCED, not assumed. `assistant_avatar_id` is read by
 * `lib/voice/voice-resolver.ts:resolveSelfAvatar`, which returns it verbatim as
 * the D-ID avatar to render. Before this pass the value was a free string
 * written with the SERVICE client, so an agent could point it at ANOTHER
 * agent's `did_avatar_id` and have that person's face render as their
 * assistant — and spend D-ID budget doing it. That directly contradicts this
 * platform's own standing rule that nobody else's face is ever used as a
 * fallback or a substitute.
 *
 * (Contact-facing surfaces are unaffected either way — they resolve through
 * `lib/video/video-identity.ts:resolveVideoIdentity` with purpose
 * "contact_facing", which always uses the licensed human's own
 * agent_voice_profiles clone and never reads this column — but self-view is
 * still this agent's identity, and the twin it names still belongs to someone.)
 *
 * WIRED (w3): the "The face you see" picker in
 * app/dashboard/settings/assistant/listening-preferences-panel.tsx. The page
 * feeds it this agent's own ready + approved twins (from listMyTwins), so the
 * list and this gate agree — but the gate below is the boundary, not the list.
 */
export async function updateMyAssistantAvatar(params: {
  assistantAvatarId: string | null
}): Promise<{ success: boolean; error?: string }> {
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok || !ctx.userId) {
    return { success: false, error: "Unauthorized" }
  }

  const svc = createServiceClient()

  const requested = params.assistantAvatarId?.trim() || null

  if (requested) {
    if (!ctx.agentId) {
      return { success: false, error: "Only an agent can choose an assistant avatar" }
    }

    // The chosen avatar must be one of THIS agent's own twins, and one that is
    // actually usable — a pending or rejected twin would render nothing (or
    // render an unapproved likeness).
    const { data: owned, error: ownedError } = await svc
      .from("agent_avatar_assets")
      .select("id")
      .eq("agent_id", ctx.agentId)
      .eq("did_avatar_id", requested)
      .eq("status", "ready")
      .eq("approval_status", "approved")
      .limit(1)

    // Fail CLOSED — a refused read is not "you own it".
    if (ownedError) {
      return { success: false, error: "Could not verify that avatar — nothing was changed" }
    }
    if (!owned || owned.length === 0) {
      return { success: false, error: "Pick one of your own approved twins" }
    }
  }

  const { error } = await svc
    .from("agents")
    .update({ assistant_avatar_id: requested })
    .eq("user_id", ctx.userId)

  return error ? { success: false, error: error.message } : { success: true }
}
