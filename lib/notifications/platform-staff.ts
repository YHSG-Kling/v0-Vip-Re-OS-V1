// lib/notifications/platform-staff.ts
// ─────────────────────────────────────────────────────────────────────────────
// Platform-staff notification — the single way a manager (or platform process) raises
// a PLATFORM-level alert to superadmin/support, who operate ABOVE any brokerage. Used
// for platform-owned concerns (scraper/connector health, raw-lead ingestion) where the
// owner is the platform, not a brokerage. Resolves recipients via the canonical
// PLATFORM_STAFF_ROLES set and writes to the same in-app notifications feed.

import type { SupabaseClient } from "@supabase/supabase-js"
import { PLATFORM_STAFF_ROLES } from "@/lib/auth/resolve-user-role"

/** notifications.type for internal staff announcements (posted from the staff
 *  command home, read back per-staffer on it). */
export const PLATFORM_ANNOUNCEMENT_TYPE = "platform_announcement"

export interface PlatformStaffNotification {
  type: string
  title: string
  body: string
  entityType?: string | null
  entityId?: string | null
  priority?: "low" | "medium" | "high"
}

/** Resolve platform-staff user ids: user_type='superadmin' (legacy gate) OR
 *  platform_role ∈ PLATFORM_STAFF_ROLES, deduped so a staffer isn't notified twice. */
export async function resolvePlatformStaffIds(supabase: SupabaseClient): Promise<string[]> {
  const platformRoles = (PLATFORM_STAFF_ROLES as readonly string[]).join(",")
  const { data: staff } = await supabase
    .from("users")
    .select("id")
    .or(`user_type.eq.superadmin,platform_role.in.(${platformRoles})`)
    .limit(500)
  return Array.from(new Set(((staff ?? []) as Array<{ id: string }>).map((u) => u.id).filter(Boolean)))
}

/** Notify every platform-staff user in the in-app feed. Returns the count notified. */
export async function notifyPlatformStaff(
  supabase: SupabaseClient,
  n: PlatformStaffNotification,
): Promise<number> {
  const ids = await resolvePlatformStaffIds(supabase)
  if (ids.length === 0) return 0
  const rows = ids.map((id) => ({
    user_id:     id,
    type:        n.type,
    title:       n.title.slice(0, 200),
    body:        n.body.slice(0, 480),
    entity_type: n.entityType ?? null,
    entity_id:   n.entityId ?? null,
    priority:    n.priority ?? "high",
    channel:     "in_app",
    is_read:     false,
  }))
  const { error } = await supabase.from("notifications").insert(rows)
  return error ? 0 : ids.length
}
