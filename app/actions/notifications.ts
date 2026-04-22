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
  entity_type: string | null
  entity_id: string | null
  priority: string | null
}

// ── getNotifications ──────────────────────────────────────────────────────────

export async function getNotifications(
  limit = 20,
): Promise<{ success: boolean; notifications: Notification[] }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) {
    return { success: false, notifications: [] }
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("notifications")
    .select(
      "id, title, body, type, is_read, read_at, created_at, entity_type, entity_id, priority",
    )
    .eq("user_id", ctx.userId)
    .order("created_at", { ascending: false })
    .limit(Math.min(limit, 100))

  if (error) {
    console.warn("[notifications] getNotifications query failed:", error.message)
    return { success: false, notifications: [] }
  }

  const notifications: Notification[] = (data ?? []).map((row) => ({
    id: String(row.id),
    title: String(row.title ?? ""),
    body: row.body != null ? String(row.body) : null,
    type: String(row.type ?? "system_alert"),
    is_read: Boolean(row.is_read),
    read_at: row.read_at != null ? String(row.read_at) : null,
    created_at: String(row.created_at ?? new Date().toISOString()),
    entity_type: row.entity_type != null ? String(row.entity_type) : null,
    entity_id: row.entity_id != null ? String(row.entity_id) : null,
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
  entityType?: string
  entityId?: string
  priority?: string
}): Promise<{ success: boolean; id?: string; error?: string }> {
  const { title, body, type, agentId, brokerageId, entityType, entityId, priority } =
    params

  const supabase = createServiceClient()

  // Caller authorization: require an authenticated session. This server action
  // uses the service-role client (bypasses RLS) so every caller must be verified.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) {
    return { success: false, error: "Unauthorized" }
  }

  // Deny authenticated callers who have no agent identity and are not a
  // broker/admin/superadmin — they cannot be authorized to create notifications.
  if (!ctx.agentId && !["broker", "admin", "superadmin"].includes(ctx.userType)) {
    return { success: false, error: "Agent identity required" }
  }

  // Always fetch the target agent (user_id + brokerage_id) — needed both for
  // auth and for the insert below.
  const targetAgentQuery = supabase
    .from("agents")
    .select("user_id, brokerage_id")
    .eq("id", agentId)
    .maybeSingle()

  let targetAgent: { user_id: string | null; brokerage_id: string | null } | null = null

  if (ctx.isAuthenticated && ctx.agentId && ctx.agentId !== agentId) {
    // Fetch both agents in parallel so we can compare brokerage IDs from the DB.
    const [{ data: callerAgent }, { data: ta, error: agentError }] = await Promise.all([
      supabase.from("agents").select("brokerage_id").eq("id", ctx.agentId).maybeSingle(),
      targetAgentQuery,
    ])
    if (agentError || !ta?.user_id) {
      console.warn("[notifications] createNotification: agent lookup failed", agentError?.message)
      return { success: false, error: "Agent not found" }
    }
    targetAgent = ta
    if (!callerAgent || callerAgent.brokerage_id !== targetAgent.brokerage_id) {
      return { success: false, error: "Unauthorized" }
    }
  } else {
    // Guard: agent-role callers without a resolved agentId cannot be authorized
    if (ctx.isAuthenticated && !ctx.agentId && !["broker", "admin", "superadmin"].includes(ctx.userType ?? "")) {
      return { success: false, error: "Agent identity required" }
    }
    // No cross-agent auth needed (caller == target, or caller is broker/admin)
    const { data: ta, error: agentError } = await targetAgentQuery
    if (agentError || !ta?.user_id) {
      console.warn("[notifications] createNotification: agent lookup failed", agentError?.message)
      return { success: false, error: "Agent not found" }
    }
    targetAgent = ta
    // Broker/admin callers (no agentId) must stay within their own brokerage.
    // Missing brokerageId cannot be trusted — deny rather than allow through.
    if (ctx.isAuthenticated && !ctx.agentId && ctx.userType !== "superadmin") {
      if (!ctx.brokerageId || targetAgent.brokerage_id !== ctx.brokerageId) {
        return { success: false, error: "Unauthorized" }
      }
    }
  }

  if (!targetAgent.brokerage_id) {
    console.warn("[notifications] createNotification: agent has no brokerage_id, cannot create notification")
    return { success: false, error: "Agent has no brokerage context" }
  }
  if (targetAgent.brokerage_id !== brokerageId) {
    console.warn("[notifications] brokerageId mismatch — using agent's brokerage_id")
  }
  const resolvedBrokerageId = targetAgent.brokerage_id

  const { data, error } = await supabase
    .from("notifications")
    .insert({
      user_id: targetAgent.user_id,
      brokerage_id: resolvedBrokerageId,
      title,
      body,
      type,
      is_read: false,
      entity_type: entityType ?? null,
      entity_id: entityId ?? null,
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
