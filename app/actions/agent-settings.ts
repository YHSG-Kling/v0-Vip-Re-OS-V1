"use server"

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"

export async function getAgentSettings(userId: string) {
  try {
    console.log("[v0] getAgentSettings called for userId:", userId)

    if (!isValidUUID(userId)) {
      console.log("[v0] Invalid userId format, returning null settings")
      return {
        avatarId: null,
        voiceId: null,
        message: "Invalid user ID format",
      }
    }

    const supabase = await createClient()

    const { data: user, error } = await supabase
      .from("users")
      .select("heygen_avatar_id, heygen_voice_id, assistant_wake_name")
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

    if (!user) {
      return {
        avatarId: null,
        voiceId: null,
        message: "User not found",
      }
    }

    return {
      avatarId: user.heygen_avatar_id,
      voiceId: user.heygen_voice_id,
      assistantWakeName: (user.assistant_wake_name as string | null) ?? null,
      message: user.heygen_avatar_id && user.heygen_voice_id 
        ? "HeyGen video generation configured" 
        : "Configure your HeyGen avatar and voice in settings",
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

export async function updateAgentSettings(userId: string, settings: {
  avatarId?: string
  voiceId?: string
  assistantWakeName?: string
}) {
  try {
    if (!isValidUUID(userId)) {
      return { success: false, error: "Invalid user ID format" }
    }

    const supabase = await createClient()

    const updates: Record<string, string> = {}
    if (settings.avatarId) updates.heygen_avatar_id = settings.avatarId
    if (settings.voiceId) updates.heygen_voice_id = settings.voiceId
    if (settings.assistantWakeName !== undefined) {
      // Sanitize: letters, numbers, spaces only, max 20 chars
      const sanitized = settings.assistantWakeName.replace(/[^a-zA-Z0-9 ]/g, "").slice(0, 20).trim()
      updates.assistant_wake_name = sanitized || "VIP"
    }

    const { error } = await supabase
      .from("users")
      .update(updates)
      .eq("id", userId)

    if (error) {
      console.error("[v0] Error updating agent settings:", error)
      return { success: false, error: "Failed to update settings" }
    }

    return { success: true }
  } catch (error) {
    console.error("[v0] Failed to update agent settings:", error)
    return { success: false, error: "Unable to update video settings" }
  }
}
