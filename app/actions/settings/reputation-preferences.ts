"use server"

import { createClient } from "@/lib/supabase/server"

export async function getReputationPreferences(agentId: string) {
  const supabase = await createClient()
  const { data } = await supabase
    .from("agents")
    .select("notification_preferences")
    .eq("id", agentId)
    .maybeSingle()

  const prefs = (data?.notification_preferences as Record<string, any>) ?? {}
  return {
    autoRespondMode: (prefs.review_auto_respond_mode as "off" | "review" | "auto") ?? "off",
    autoRespondApprovalHours: (prefs.review_auto_respond_approval_hours as number) ?? 24,
  }
}

export async function saveReputationPreferences(
  agentId: string,
  prefs: { autoRespondMode: "off" | "review" | "auto"; autoRespondApprovalHours: number }
) {
  const supabase = await createClient()
  const { data: existing } = await supabase
    .from("agents")
    .select("notification_preferences")
    .eq("id", agentId)
    .maybeSingle()

  const current = (existing?.notification_preferences as Record<string, any>) ?? {}
  const updated = {
    ...current,
    review_auto_respond_mode: prefs.autoRespondMode,
    review_auto_respond_approval_hours: prefs.autoRespondApprovalHours,
  }

  const { error } = await supabase
    .from("agents")
    .update({ notification_preferences: updated })
    .eq("id", agentId)

  if (error) return { success: false, error: error.message }
  return { success: true }
}
