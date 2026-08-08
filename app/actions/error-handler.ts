"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"

export async function getErrorGroups(filters?: {
  severity?: string
  status?: string
  dateRange?: { from: string; to: string }
  limit?: number
}) {
  const supabase = await createClient()
  const { brokerageId, userId } = await getAgentContext()

  let query = supabase
    .from("automation_errors")
    .select("*")
    .eq("brokerage_id", brokerageId)

  if (filters?.severity) {
    query = query.eq("severity", filters.severity)
  }

  if (filters?.status) {
    query = query.eq("status", filters.status)
  }

  if (filters?.dateRange) {
    query = query
      .gte("created_at", filters.dateRange.from)
      .lte("created_at", filters.dateRange.to)
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(filters?.limit || 100)

  if (error) {
    console.error("Error fetching error groups:", error)
    throw new Error("Failed to fetch error groups")
  }

  return data
}

export async function getErrorGroupDetails(groupId: string) {
  const supabase = await createClient()
  const { brokerageId } = await getAgentContext()

  const { data, error } = await supabase
    .from("automation_errors")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .eq("id", groupId)
    .single()

  if (error) {
    console.error("Error fetching group details:", error)
    throw new Error("Failed to fetch group details")
  }

  return data
}

export async function dismissErrorGroup(groupId: string, reason: string) {
  const supabase = await createClient()
  const { brokerageId, userId } = await getAgentContext()

  // Update error group status
  const { error: updateError } = await supabase
    .from("automation_errors")
    .update({
      status: "dismissed",
      dismissed_at: new Date().toISOString(),
      dismissed_by: userId,
      dismiss_reason: reason,
    })
    .eq("id", groupId)
    .eq("brokerage_id", brokerageId)

  if (updateError) {
    console.error("Error dismissing group:", updateError)
    throw new Error("Failed to dismiss error group")
  }

  // Record activity (fire-and-forget)
  void supabase
    .from("activities")
    .insert({
      brokerage_id: brokerageId,
      agent_user_id: userId,
      activity_type: "error_group_dismissed",
      status: "completed",
      metadata: { error_group_id: groupId, reason },
    })

  return { success: true }
}

export async function resolveErrorGroup(groupId: string, solution: string) {
  const supabase = await createClient()
  const { brokerageId, userId } = await getAgentContext()

  const { error: updateError } = await supabase
    .from("automation_errors")
    .update({
      status: "resolved",
      resolved_at: new Date().toISOString(),
      resolved_by: userId,
      resolution_notes: solution,
    })
    .eq("id", groupId)
    .eq("brokerage_id", brokerageId)

  if (updateError) {
    console.error("Error resolving group:", updateError)
    throw new Error("Failed to resolve error group")
  }

  // Record activity (fire-and-forget)
  void supabase
    .from("activities")
    .insert({
      brokerage_id: brokerageId,
      agent_user_id: userId,
      activity_type: "error_group_resolved",
      status: "completed",
      metadata: { error_group_id: groupId, solution },
    })

  return { success: true }
}

/**
 * The people an error can be assigned TO — everyone in the caller's brokerage.
 *
 * Added (w4s1) because `assignErrorGroup` had no caller and no way to get one: the
 * error triage surface had Resolve and Dismiss but no Assign, and there was no
 * reader anywhere that returned brokerage USERS. `listBrokerageAgentsAction`
 * (app/actions/admin/locations.ts) is not a substitute — it returns `agents.id`,
 * while `automation_errors.assigned_to` FKs to `users(id)`. Those are disjoint id
 * spaces; feeding one where the other belongs is a 23503, not a mis-assignment.
 */
export async function listAssignableTeammates(): Promise<
  Array<{ id: string; name: string; email: string | null }>
> {
  const supabase = await createClient()
  const { brokerageId, isAuthenticated } = await getAgentContext()
  if (!isAuthenticated || !brokerageId) return []

  const { data, error } = await supabase
    .from("users")
    .select("id, first_name, last_name, email, user_type")
    .eq("brokerage_id", brokerageId)
    .limit(500)

  // A refused read returns an empty roster rather than a fabricated one.
  if (error) {
    console.error("[error-handler] assignable teammates read failed:", error.message)
    return []
  }

  // Staff only — a contact, a vendor or a lender portal user shares the brokerage_id
  // but is not someone an internal automation error can be handed to.
  const STAFF_TYPES = new Set([
    "agent", "broker", "broker_owner", "broker_admin", "admin",
    "superadmin", "team_lead", "tc", "compliance_officer", "isa",
  ])

  return (data ?? [])
    .filter((u: any) => STAFF_TYPES.has(String(u.user_type ?? "")))
    .map((u: any) => ({
      id: u.id as string,
      name: [u.first_name, u.last_name].filter(Boolean).join(" ") || (u.email as string) || String(u.id).slice(0, 8),
      email: (u.email as string | null) ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Assign an automation error to a teammate.
 *
 * `automation_errors.assigned_to` and `.assigned_by` both FK to `users(id)` —
 * verified live — so `assigneeId` is a users.id, NOT an agents.id.
 */
export async function assignErrorGroup(groupId: string, assigneeId: string) {
  const supabase = await createClient()
  const { brokerageId, userId, isAuthenticated } = await getAgentContext()

  // The gate was the tenant predicate alone, with the session never checked. An
  // unauthenticated call reached `.eq("brokerage_id", undefined)`, which is a
  // malformed predicate rather than a refusal — the wrong shape for an
  // authorization boundary on a `"use server"` endpoint.
  if (!isAuthenticated || !brokerageId) {
    throw new Error("Not authenticated")
  }
  if (!groupId || !assigneeId) {
    throw new Error("groupId and assigneeId are required")
  }

  // The assignee was taken entirely on trust. `assigned_to` FKs to users(id) with
  // no tenant constraint of its own, so any users.id was accepted — including a
  // user of a DIFFERENT brokerage, who would then own an error record they cannot
  // see and which no one in the owning brokerage is chasing. Confirm the assignee
  // is in the caller's brokerage first. `error` is destructured: supabase-js
  // resolves a refused read, and this gate must fail closed.
  const { data: assignee, error: assigneeErr } = await supabase
    .from("users")
    .select("id")
    .eq("id", assigneeId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (assigneeErr) throw new Error("Could not verify the assignee")
  if (!assignee) throw new Error("That person is not in your brokerage")

  // `.select("id")` so a zero-row update is observable. Without it a wrong id, or
  // an error belonging to another tenant, updated nothing and this still returned
  // { success: true } — the UI would show the error as assigned to someone who
  // was never given it.
  const { data: updated, error } = await supabase
    .from("automation_errors")
    .update({
      assigned_to: assigneeId,
      assigned_at: new Date().toISOString(),
      assigned_by: userId,
    })
    .eq("id", groupId)
    .eq("brokerage_id", brokerageId)
    .select("id")

  if (error) {
    console.error("Error assigning group:", error)
    throw new Error("Failed to assign error group")
  }
  if (!updated?.length) {
    throw new Error("That error was not found in your brokerage")
  }

  return { success: true }
}

export async function getErrorMetrics() {
  const supabase = await createClient()
  const { brokerageId } = await getAgentContext()

  // Get error counts by severity for last 24 hours
  const { data: severityCounts } = await supabase
    .from("automation_errors")
    .select("severity")
    .eq("brokerage_id", brokerageId)
    .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())

  // Top error types live on error_stack_traces.error_type (automation_errors has no
  // error_type/error_count). Aggregate in JS (PostgREST has no GROUP BY).
  const { data: stackRows } = await supabase
    .from("error_stack_traces")
    .select("error_type")
    .eq("brokerage_id", brokerageId)

  const typeCounts = new Map<string, number>()
  for (const row of stackRows || []) {
    const t = (row as any).error_type || "unknown"
    typeCounts.set(t, (typeCounts.get(t) || 0) + 1)
  }
  const topErrors = [...typeCounts.entries()]
    .map(([error_type, error_count]) => ({ error_type, error_count }))
    .sort((a, b) => b.error_count - a.error_count)
    .slice(0, 5)

  // Retry stats come from error_resolution_log (auto_retry rows), not automation_errors.
  const { data: retryRows } = await supabase
    .from("error_resolution_log")
    .select("retry_result")
    .eq("brokerage_id", brokerageId)
    .eq("action_type", "auto_retry")
    .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())

  const severity = {
    critical: severityCounts?.filter(e => e.severity === "critical").length || 0,
    high: severityCounts?.filter(e => e.severity === "high").length || 0,
    medium: severityCounts?.filter(e => e.severity === "medium").length || 0,
    low: severityCounts?.filter(e => e.severity === "low").length || 0,
  }

  const totalRetries = retryRows?.length || 0
  const successfulRetries = retryRows?.filter(r => (r as any).retry_result === "success").length || 0
  const retrySuccessRate = totalRetries > 0 ? (successfulRetries / totalRetries) * 100 : 0

  return {
    severityCounts: severity,
    topErrors,
    retrySuccessRate: Math.round(retrySuccessRate),
    totalErrors24h: severityCounts?.length || 0,
  }
}
