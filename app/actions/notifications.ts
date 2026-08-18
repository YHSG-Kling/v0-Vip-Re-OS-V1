"use server"

// ★ ACT-AS WRITE SEAM ★ — resolveWriteContext now comes from the PLATFORM seam
// (lib/platform/acting-context), not the kernel homonym in lib/kernel/identity:
// the kernel version never checked the impersonation MODE, so a read_only
// act-as grant could create notifications through the service client below.
// The seam refuses read_only outright (re-validated on the call) and hands the
// writers an acting db, so the mark-read updates — which rode the bare cookie
// client keyed on the EFFECTIVE userId and silently zero-rowed under act-as —
// now land, with row counts as the proof.
import { resolveActingContext, resolveWriteContext } from "@/lib/platform/acting-context"
import { createServiceClient } from "@/lib/supabase/service"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

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
  const ctx = await resolveActingContext()
  if (!ctx.ok) {
    return { success: false, notifications: [] }
  }

  const supabase = ctx.db

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

  const notifications: Notification[] = (data ?? []).map((row: Record<string, unknown>) => ({
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
  // ACT-AS WRITE SEAM — read_only refused; the update rides the acting db and
  // stays pinned to the EFFECTIVE user's own rows.
  const ctx = await resolveWriteContext()
  if (!ctx.ok) {
    return { success: false, error: ctx.error }
  }

  // Zero rows is a refusal (not this user's notification), not success.
  const { data: marked, error } = await ctx.db
    .from("notifications")
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq("id", notificationId)
    .eq("user_id", ctx.userId)
    .select("id")

  if (error) {
    console.warn("[notifications] markNotificationRead failed:", error.message)
    return { success: false, error: error.message }
  }
  if (!marked || marked.length === 0) {
    return { success: false, error: "Notification not found" }
  }

  return { success: true }
}

// ── markAllRead ───────────────────────────────────────────────────────────────

export async function markAllRead(): Promise<{
  success: boolean
  error?: string
}> {
  // ACT-AS WRITE SEAM — read_only refused. Zero rows here is legitimate
  // (nothing unread), so no row-count assertion.
  const ctx = await resolveWriteContext()
  if (!ctx.ok) {
    return { success: false, error: ctx.error }
  }

  const { error } = await ctx.db
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

  // Caller authorization: the PLATFORM act-as write seam. Refuses read_only
  // impersonation before this service-client write (the kernel homonym it
  // replaced never checked the mode, so a read_only grant could write here).
  // Under act-as, ctx.userId/agentId/brokerageId are the IMPERSONATED seat's —
  // the tenant checks below evaluate that seat's authority, never more.
  const ctx = await resolveWriteContext()
  if (!ctx.ok) {
    return { success: false, error: ctx.error }
  }

  // Deny authenticated callers who have no agent identity and are not a
  // broker/admin/superadmin — they cannot be authorized to create notifications.
  if (!ctx.agentId && !isAdminOrBroker({ user_type: ctx.userType })) {
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

  if (ctx.agentId && ctx.agentId !== agentId) {
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
    // No cross-agent auth needed (caller == target, or caller is broker/admin)
    const { data: ta, error: agentError } = await targetAgentQuery
    if (agentError || !ta?.user_id) {
      console.warn("[notifications] createNotification: agent lookup failed", agentError?.message)
      return { success: false, error: "Agent not found" }
    }
    targetAgent = ta
    // Broker/admin callers (no agentId) must stay within their own brokerage.
    // ctx.brokerageId may be null (untenanted staff seat): NULL matches no
    // tenant, so the mismatch branch fires and only a superadmin passes it.
    //
    // The superadmin exemption reads BOTH identity columns. WriteContext carries
    // only user_type, and `ctx.userType !== "superadmin"` was true for the
    // platform's only superadmin — whose row is (user_type='admin',
    // platform_role='superadmin') — so the platform owner was pinned to a single
    // tenant and could not notify an agent in any other brokerage. platform_role
    // is not on the context, so it is read here, and ONLY on the branch that would
    // otherwise refuse: the tenant-matching common case never pays for the query.
    // Same shape as public.is_platform_admin(); see app/actions/vendor-budget.ts:136-147.
    if (!ctx.agentId && targetAgent.brokerage_id !== ctx.brokerageId) {
      let isSuperadmin = ctx.userType === "superadmin"
      if (!isSuperadmin) {
        const { data: actorRow } = await supabase
          .from("users")
          .select("platform_role")
          .eq("id", ctx.userId)
          .maybeSingle()
        isSuperadmin = (actorRow as { platform_role?: string | null } | null)?.platform_role === "superadmin"
      }
      if (!isSuperadmin) return { success: false, error: "Unauthorized" }
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
