// lib/kernel/notification-center.ts
// User-facing notification query/mutation layer.
// All operations are scoped to user_id — never returns cross-user data.
// No UI code. No default exports.

import { createClient } from "@/lib/supabase/server"

// ── Types ─────────────────────────────────────────────────────────────────────

interface NotificationRow {
  id: string
  title: string
  body: string | null
  type: string
  is_read: boolean
  created_at: string
  channel: string | null
  priority: string | null
  /** Optional — populated when the notification is tied to a specific entity
   *  (transaction, listing_presentation, document, contact, listing, offer).
   *  Used by the notifications page to deep-link to the related view. */
  entity_type: string | null
  entity_id:   string | null
}

// ── listNotifications ─────────────────────────────────────────────────────────

export async function listNotifications(params: {
  userId: string
  limit?: number
  offset?: number
  unreadOnly?: boolean
}): Promise<{ rows: NotificationRow[] }> {
  const { userId, limit = 50, offset = 0, unreadOnly = false } = params
  const supabase = await createClient()

  let query = supabase
    .from("notifications")
    .select("id, title, body, type, is_read, created_at, channel, priority, entity_type, entity_id")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1)

  if (unreadOnly) {
    query = query.eq("is_read", false)
  }

  const { data, error } = await query

  if (error) {
    console.error("[NotificationCenter] listNotifications failed:", error)
    throw new Error(`Failed to list notifications: ${error.message}`)
  }

  return { rows: (data ?? []) as NotificationRow[] }
}

// ── countUnreadNotifications ──────────────────────────────────────────────────

export async function countUnreadNotifications(params: {
  userId: string
}): Promise<number> {
  const { userId } = params
  const supabase = await createClient()

  const { count, error } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("is_read", false)

  if (error) {
    console.error("[NotificationCenter] countUnreadNotifications failed:", error)
    throw new Error(`Failed to count unread notifications: ${error.message}`)
  }

  return count ?? 0
}

// ── markNotificationRead / markAllNotificationsRead — RETIRED (wave 155, lane 155R20) ──────────
// TOMBSTONE. Both were duplicates of the survivor app/actions/notifications.ts:84 markNotificationRead and
// app/actions/notifications.ts:115 markAllRead, and their ONLY caller was the duplicate door app/actions/notification-actions.ts
// (also retired; app/notifications/page.tsx now calls the survivor). The survivor is stricter — the act-as write seam
// (resolveWriteContext: a read_only impersonation grant is refused) and a zero-row mark is a refusal, not a success — so there
// was nothing to merge onto it. The re-export in lib/kernel/index.ts is removed with them.
