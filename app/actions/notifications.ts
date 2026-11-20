"use server"

// ★ ACT-AS WRITE SEAM ★ — resolveWriteContext now comes from the PLATFORM seam
// (lib/platform/acting-context). The kernel homonym in lib/kernel/identity is now
// DELETED (§1.1 tombstone at lib/platform/acting-context.ts:38); it never checked
// the impersonation MODE, so a read_only act-as grant could create notifications
// through the service client below.
// The seam refuses read_only outright (re-validated on the call) and hands the
// writers an acting db, so the mark-read updates — which rode the bare cookie
// client keyed on the EFFECTIVE userId and silently zero-rowed under act-as —
// now land, with row counts as the proof.
import { resolveActingContext, resolveWriteContext } from "@/lib/platform/acting-context"
// (The service client and the roster test were imported here only for createNotification, retired below — the two mark-read
// writers ride the acting db the seam hands them.)

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

// TOMBSTONE (CLAUDE.md §1 case 3 — wave 155, integrator). `createNotification` DELETED: a public "use server" endpoint that wrote
// a notification of any type for any agent of the caller's brokerage through the service client. Its last caller,
// app/actions/communications.ts sendNotificationToAgent, was itself retired this wave (lane 155B2 — an ungated door), which left
// this export reachable only as an endpoint nobody calls. Nothing to merge: in-app notices are written where the fact is known —
// SURVIVOR lib/kernel/notification-engine.ts:206 (processKernelEvent's rule-driven insert, now decided and receipted at the one
// fan-out) and the kernel modules that own a notice (os-health, referral-radar, document-compliance-audit …). The bell's readers
// and the two mark-read writers below are unchanged.
//
// TOMBSTONE (wave 155, lane 155R20; §1 case 1 — a DUPLICATE; moved here when the emptied file app/actions/notification-actions.ts
// was deleted). Its markAllRead and markOneRead re-implemented the two writers below on the cookie client WITHOUT the act-as
// write seam (a read_only impersonation grant was not refused) and read a zero-row mark as success. SURVIVORS: markNotificationRead
// and markAllRead in this file; the one caller, app/notifications/page.tsx, calls them. The kernel helpers the duplicate wrapped
// (lib/kernel/notification-center.ts markNotificationRead / markAllNotificationsRead) were retired with it.
