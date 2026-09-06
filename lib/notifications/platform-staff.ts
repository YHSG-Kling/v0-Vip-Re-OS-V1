// lib/notifications/platform-staff.ts
// ─────────────────────────────────────────────────────────────────────────────
// Platform-staff notification — the single way a manager (or platform process) raises
// a PLATFORM-level alert to the platform staff, who operate ABOVE any brokerage. Used
// for platform-owned concerns (scraper/connector health, raw-lead ingestion) where the
// owner is the platform, not a brokerage. Resolves recipients via the canonical
// PLATFORM_STAFF_ROLES set and writes to the same in-app notifications feed.
//
// THE IMPORT ON THE NEXT LINE USED TO POINT SOMEWHERE ELSE, AND THAT WAS THE BUG.
// It read PLATFORM_STAFF_ROLES from lib/auth/resolve-user-role.ts, where a SECOND
// declaration of that same name held only ["superadmin","support"]. So every
// platform alert this module has ever raised — connector health, scraper failures,
// raw-lead ingestion — was addressed to two of the four staff roles, and `admin` and
// `marketing` staff were never told. Nothing failed loudly: the fan-out reported the
// count it did deliver. The duplicate is deleted; this now imports the one roster.

import type { SupabaseClient } from "@supabase/supabase-js"
import { PLATFORM_STAFF_ROLES } from "@/lib/platform/platform-staff-roster"
// The ONE way a notifications row gets its tenant — the recipient's
// users.brokerage_id, the exact value badge-counts compares against.
import { resolveRecipientBrokerageIds } from "@/lib/notifications/recipient-tenant"

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
 *  platform_role ∈ PLATFORM_STAFF_ROLES, deduped so a staffer isn't notified twice.
 *
 *  `error` is destructured: supabase-js RESOLVES a refused query, so `{ data }`
 *  alone turns "this read was refused" into "there is no platform staff", and a
 *  platform alert then silently reaches nobody while reporting 0 notified. */
export async function resolvePlatformStaffIds(supabase: SupabaseClient): Promise<string[]> {
  const platformRoles = (PLATFORM_STAFF_ROLES as readonly string[]).join(",")
  const { data: staff, error } = await supabase
    .from("users")
    .select("id")
    .or(`user_type.eq.superadmin,platform_role.in.(${platformRoles})`)
    .limit(500)
  if (error) {
    console.error("[platform-staff] resolvePlatformStaffIds: users read refused:", error.message)
    return []
  }
  return Array.from(new Set(((staff ?? []) as Array<{ id: string }>).map((u) => u.id).filter(Boolean)))
}

/**
 * Notify every platform-staff user in the in-app feed. Returns the count notified.
 *
 * TENANT — the RECIPIENT's `users.brokerage_id`, the same single resolver every
 * other `notifications` writer uses.
 *
 * THIS ONE LOOKED LIKE THE EXEMPTION AND IS NOT. Platform staff "operate ABOVE
 * any brokerage", so an untenanted row reads like the honest answer. Measured
 * live instead of assumed: every `users` row on this database carries a
 * `brokerage_id` — including the one `platform_role = 'superadmin'` account —
 * and platform staff read their bell through the SAME
 * app/api/dashboard/badge-counts/route.ts, which resolves `brokerage_id` from
 * their own users row and then ANDs `.eq("brokerage_id", …)`. So an untenanted
 * platform alert is not "correctly unowned", it is INVISIBLE TO THE STAFF IT IS
 * ADDRESSED TO. `brokerage_id` on a row addressed to a person is the delivery
 * key, not a claim about who owns the subject matter.
 */
export async function notifyPlatformStaff(
  supabase: SupabaseClient,
  n: PlatformStaffNotification,
): Promise<number> {
  const ids = await resolvePlatformStaffIds(supabase)
  if (ids.length === 0) return 0
  const tenants = await resolveRecipientBrokerageIds(supabase, ids)
  if (!tenants.ok) {
    console.error(`[platform-staff] notifyPlatformStaff: ${tenants.reason} — nothing written`)
    return 0
  }
  const deliverable = ids.filter((id) => !!tenants.brokerageIds.get(id))
  const undeliverable = ids.filter((id) => !tenants.brokerageIds.get(id))
  if (undeliverable.length > 0) {
    console.error(
      `[platform-staff] notifyPlatformStaff: ${undeliverable.length} staff user(s) have no brokerage — not notified rather than written where the bell cannot count it: ${undeliverable.join(", ")}`,
    )
  }
  if (deliverable.length === 0) return 0
  const rows = deliverable.map((id) => ({
    user_id:      id,
    brokerage_id: tenants.brokerageIds.get(id) as string,
    type:         n.type,
    title:        n.title.slice(0, 200),
    body:         n.body.slice(0, 480),
    entity_type:  n.entityType ?? null,
    entity_id:    n.entityId ?? null,
    priority:     n.priority ?? "high",
    channel:      "in_app",
    is_read:      false,
  }))
  const { error } = await supabase.from("notifications").insert(rows)
  if (error) {
    console.error("[platform-staff] notifyPlatformStaff: notifications insert refused:", error.message)
    return 0
  }
  return deliverable.length
}
