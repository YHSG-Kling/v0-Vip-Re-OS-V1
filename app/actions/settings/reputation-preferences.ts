"use server"

// ★ ACT-AS WRITE SEAM ★ — these read/write agents.notification_preferences
// keyed on a caller-supplied agentId. The tenant now comes from the acting
// context and every query pins `.eq("brokerage_id", ctx.brokerageId)` so an id
// from another tenant matches nothing (gate-then-db). Reads ride
// resolveActingContext (a read_only investigator may look); the save rides
// resolveWriteContext (read_only refused, grant re-validated on the call) and
// counts affected rows — a zero-row result is a refusal, not success.
import { resolveActingContext, resolveWriteContext } from "@/lib/platform/acting-context"

export async function getReputationPreferences(agentId: string) {
  const ctx = await resolveActingContext()
  if (!ctx.ok || !ctx.brokerageId) {
    return { autoRespondMode: "off" as const, autoRespondApprovalHours: 24 }
  }
  const { data } = await ctx.db
    .from("agents")
    .select("notification_preferences")
    .eq("id", agentId)
    .eq("brokerage_id", ctx.brokerageId)
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
  const ctx = await resolveWriteContext()
  if (!ctx.ok) return { success: false, error: ctx.error }
  if (!ctx.brokerageId) return { success: false, error: "No brokerage found" }

  const { data: existing, error: readError } = await ctx.db
    .from("agents")
    .select("notification_preferences")
    .eq("id", agentId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()
  if (readError) return { success: false, error: readError.message }
  if (!existing) return { success: false, error: "Agent not found in your brokerage" }

  const current = (existing?.notification_preferences as Record<string, any>) ?? {}
  const updated = {
    ...current,
    review_auto_respond_mode: prefs.autoRespondMode,
    review_auto_respond_approval_hours: prefs.autoRespondApprovalHours,
  }

  const { data: saved, error } = await ctx.db
    .from("agents")
    .update({ notification_preferences: updated })
    .eq("id", agentId)
    .eq("brokerage_id", ctx.brokerageId)
    .select("id")

  if (error) return { success: false, error: error.message }
  if (!saved || saved.length === 0) {
    return { success: false, error: "Nothing was saved — you may not have permission to change this agent's preferences." }
  }
  return { success: true }
}
