"use server"

import { getAgentContext } from "@/lib/identity"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

// ── Types ─────────────────────────────────────────────────────────────────────

export type NotificationType =
  | "lead_alert"
  | "deal_update"
  | "task_due"
  | "message_received"
  | "system_alert"
  | "market_update"
  | "ai_insight"

export interface Notification {
  id: string
  title: string
  body: string | null
  type: string
  is_read: boolean
  read_at: string | null
  created_at: string
  action_url: string | null
  priority: string | null
}

// ── getNotifications ──────────────────────────────────────────────────────────

export async function getNotifications(
  limit = 20,
): Promise<{ success: boolean; notifications: Notification[] }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) {
    return { success: true, notifications: [] }
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("notifications")
    .select(
      "id, title, body, type, is_read, read_at, created_at, action_url, priority",
    )
    .eq("user_id", ctx.userId)
    .order("created_at", { ascending: false })
    .limit(limit)

  // If the table doesn't exist or another error occurs, return gracefully
  if (error) {
    // Table may not exist yet — don't crash
    console.warn("[notifications] getNotifications query failed:", error.message)
    return { success: true, notifications: [] }
  }

  const notifications: Notification[] = (data ?? []).map((row) => ({
    id: String(row.id),
    title: String(row.title ?? ""),
    body: row.body != null ? String(row.body) : null,
    type: String(row.type ?? "system_alert"),
    is_read: Boolean(row.is_read),
    read_at: row.read_at != null ? String(row.read_at) : null,
    created_at: String(row.created_at ?? new Date().toISOString()),
    action_url: row.action_url != null ? String(row.action_url) : null,
    priority: row.priority != null ? String(row.priority) : null,
  }))

  return { success: true, notifications }
}

// ── markNotificationRead ──────────────────────────────────────────────────────

export async function markNotificationRead(
  notificationId: string,
): Promise<{ success: boolean; error?: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) {
    return { success: false, error: "Unauthorized" }
  }

  const supabase = await createClient()

  const { error } = await supabase
    .from("notifications")
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq("id", notificationId)
    .eq("user_id", ctx.userId)

  if (error) {
    console.warn("[notifications] markNotificationRead failed:", error.message)
    return { success: false, error: error.message }
  }

  return { success: true }
}

// ── markAllRead ───────────────────────────────────────────────────────────────

export async function markAllRead(): Promise<{
  success: boolean
  error?: string
}> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) {
    return { success: false, error: "Unauthorized" }
  }

  const supabase = await createClient()

  const { error } = await supabase
    .from("notifications")
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq("user_id", ctx.userId)
    .eq("is_read", false)

  if (error) {
    console.warn("[notifications] markAllRead failed:", error.message)
    return { success: false, error: error.message }
  }

  return { success: true }
}

// ── createNotification ────────────────────────────────────────────────────────
// Used by other systems to fire notifications. Uses service client (bypasses RLS).

export async function createNotification(params: {
  title: string
  body: string
  type: NotificationType
  agentId: string
  brokerageId: string
  actionUrl?: string
  priority?: string
}): Promise<{ success: boolean; id?: string; error?: string }> {
  const { title, body, type, agentId, brokerageId, actionUrl, priority } =
    params

  const supabase = createServiceClient()

  // Resolve the user_id from the agents table
  const { data: agent, error: agentError } = await supabase
    .from("agents")
    .select("user_id")
    .eq("id", agentId)
    .maybeSingle()

  if (agentError || !agent?.user_id) {
    console.warn("[notifications] createNotification: agent lookup failed", agentError?.message)
    return { success: false, error: "Agent not found" }
  }

  const { data, error } = await supabase
    .from("notifications")
    .insert({
      user_id: agent.user_id,
      brokerage_id: brokerageId,
      title,
      body,
      type,
      is_read: false,
      action_url: actionUrl ?? null,
      priority: priority ?? null,
    })
    .select("id")
    .single()

  if (error) {
    console.warn("[notifications] createNotification insert failed:", error.message)
    return { success: false, error: error.message }
  }

  return { success: true, id: String(data.id) }
}
