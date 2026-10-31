"use server"

import { createClient } from "@/lib/supabase/server"

// Both exports previously trusted a caller-supplied userId, so any
// signed-in caller could read another user's HeyGen avatar/voice IDs
// (PII-ish — links a real person to their AI clone) and silently
// mutate another user's wake-name / avatar / voice settings.
// Resolve from session and ignore caller param.

export async function getAgentSettings(_userId?: string) {
  try {
    const supabase = await createClient()
    const { data: { user: authUser } } = await supabase.auth.getUser()
    if (!authUser) {
      return { avatarId: null, voiceId: null, message: "Not authenticated" }
    }
    const userId = authUser.id

    // Wake name lives on users; the avatar/voice IDs live on the canonical agent_voice_profiles
    // (D-ID did_avatar_id + ElevenLabs elevenlabs_voice_id — NOT the old phantom users.heygen_* cols).
    const { data: user, error } = await supabase
      .from("users")
      .select("assistant_wake_name")
      .eq("id", userId)
      .maybeSingle()

    if (error) {
      console.error("[v0] Error fetching agent settings:", error)
      return {
        avatarId: null,
        voiceId: null,
        message: "Unable to load video settings",
      }
    }

    const { data: agent } = await supabase
      .from("agents")
      .select("id")
      .eq("user_id", userId)
      .maybeSingle()

    let avatarId: string | null = null
    let voiceId: string | null = null
    if (agent?.id) {
      const { data: vp } = await supabase
        .from("agent_voice_profiles")
        .select("did_avatar_id, elevenlabs_voice_id")
        .eq("agent_id", agent.id)
        .order("is_default", { ascending: false })
        .limit(1)
        .maybeSingle()
      avatarId = (vp?.did_avatar_id as string | null) ?? null
      voiceId = (vp?.elevenlabs_voice_id as string | null) ?? null
    }

    return {
      avatarId,
      voiceId,
      assistantWakeName: (user?.assistant_wake_name as string | null) ?? null,
      message: avatarId && voiceId
        ? "Video generation configured (D-ID + ElevenLabs)"
        : "Configure your D-ID avatar and ElevenLabs voice in settings",
    }
  } catch (error) {
    console.error("[v0] Failed to load agent settings:", error)
    return {
      avatarId: null,
      voiceId: null,
      message: "Unable to load video settings",
    }
  }
}

export async function updateAgentSettings(_userId: string, settings: {
  avatarId?: string
  voiceId?: string
  assistantWakeName?: string
}) {
  try {
    const supabase = await createClient()
    const { data: { user: authUser } } = await supabase.auth.getUser()
    if (!authUser) return { success: false, error: "Not authenticated" }
    const userId = authUser.id

    // Wake name → users (real column). Avatar/voice → the canonical agent_voice_profiles
    // (D-ID + ElevenLabs), NOT phantom users.heygen_* columns.
    if (settings.assistantWakeName !== undefined) {
      // Sanitize: letters, numbers, spaces only, max 20 chars
      const sanitized = settings.assistantWakeName.replace(/[^a-zA-Z0-9 ]/g, "").slice(0, 20).trim()
      const { error: wakeErr } = await supabase
        .from("users")
        .update({ assistant_wake_name: sanitized || "VIP" })
        .eq("id", userId)
      if (wakeErr) {
        console.error("[v0] Error updating wake name:", wakeErr)
        return { success: false, error: "Failed to update settings" }
      }
    }

    if (settings.avatarId || settings.voiceId) {
      const { data: agent } = await supabase
        .from("agents")
        .select("id, brokerage_id")
        .eq("user_id", userId)
        .maybeSingle()
      if (!agent?.id) return { success: false, error: "No agent profile for this user" }

      const patch: Record<string, unknown> = {}
      if (settings.avatarId) patch.did_avatar_id = settings.avatarId
      if (settings.voiceId) patch.elevenlabs_voice_id = settings.voiceId

      const { data: existing } = await supabase
        .from("agent_voice_profiles")
        .select("id")
        .eq("agent_id", agent.id)
        .order("is_default", { ascending: false })
        .limit(1)
        .maybeSingle()

      const { error } = existing?.id
        ? await supabase.from("agent_voice_profiles").update(patch).eq("id", existing.id)
        : await supabase.from("agent_voice_profiles").insert({
            agent_id: agent.id,
            brokerage_id: agent.brokerage_id,
            is_default: true,
            preferred_avatar_provider: "did",
            ...patch,
          })
      if (error) {
        console.error("[v0] Error updating agent voice profile:", error)
        return { success: false, error: "Failed to update settings" }
      }
    }

    return { success: true }
  } catch (error) {
    console.error("[v0] Failed to update agent settings:", error)
    return { success: false, error: "Unable to update video settings" }
  }
}
