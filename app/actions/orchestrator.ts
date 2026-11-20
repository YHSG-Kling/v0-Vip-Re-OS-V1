"use server"

/**
 * Client-callable orchestrator actions.
 *
 * Internal handlers + dispatch logic live in lib/orchestrator/internal.ts
 * so they are NOT registered as Next.js server actions (RPC endpoints).
 *
 * The one function exported here is called from the browser and passes an
 * explicit auth gate first (emitEvent was retired in wave 155 — see the
 * tombstone below):
 *
 *   - orchestrateEventById: admin-only replay UI; requires admin / superadmin
 *     role and verifies the event belongs to the caller's brokerage.
 */

import { bestEffort } from "@/lib/db/best-effort"
import { createClient } from "@/lib/supabase/server"
import type { Event } from "@/lib/orchestrator"
import { orchestrateEvent } from "@/lib/orchestrator/internal"

// TOMBSTONE (wave 155, lane 155R29; CLAUDE.md §1 case 2 — the functionality lives elsewhere): emitEvent DELETED. Survivor:
// lib/orchestrator/internal.ts:359 emitEventFromCron — the server-side insert-AND-dispatch every real emitter uses
// (app/actions/listing-media.ts:165 import, :167 call; the cron and render pipelines), tenant from its trusted caller. Nothing
// imported this door. As a "use server" export it let any signed-in seat — a portal client included — write ANY event_type under
// its tenant and, with processImmediately, run the orchestrator's handlers on a payload it chose; and it answered success: true
// when the insert was refused. Nothing to merge: a client-chosen event type is the defect.

// =====================================================
// ORCHESTRATE BY EVENT ID — admin-only replay
// =====================================================

// TRUE ADMIN GATE that also named the platform ('superadmin'/'super_admin' —
// both dead as users.user_type, 0 live rows) — repointed to
// isTenantAdminOrPlatformStaff: tenant admins via the ONE roster, platform
// staff via the dual-column identity the row's platform_role (selected below)
// actually carries.
import { isTenantAdminOrPlatformStaff } from "@/lib/auth/resolve-user-role"
import { isPlatformSuperadminIdentity } from "@/lib/platform/platform-staff-roster"

export async function orchestrateEventById(eventId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const { data: u } = await supabase
    .from("users")
    .select("brokerage_id, user_type, platform_role")
    .eq("id", user.id)
    .maybeSingle()
  if (!u?.brokerage_id) return { success: false, error: "Unauthorized" }
  if (!isTenantAdminOrPlatformStaff({ user_type: u.user_type, platform_role: (u as any).platform_role })) {
    return { success: false, error: "Forbidden" }
  }

  // "Is superadmin" is not answerable from user_type. The platform's only
  // superadmin is (user_type='admin', platform_role='superadmin'), so BOTH
  // columns are read — the same shape as public.is_platform_admin() in RLS and
  // requireSuperadmin() in lib/auth/platform-guard.ts. See
  // app/actions/vendor-budget.ts:136-147.
  // ONE DEFINITION (ruling 1, 2026-08-24) — survivor:
  // lib/platform/platform-staff-roster.ts:isPlatformSuperadminIdentity.
  // The dropped `user_type === "super_admin"` arm was INERT: users_user_type_check
  // admits fourteen values and \super_admin is not one of them, so no live row
  // could ever match it. Removing it changes no answer.
  const isSuperadmin = isPlatformSuperadminIdentity(u.user_type, (u as any).platform_role)

  try {
    const { data: event, error: fetchError } = await supabase
      .from("lifecycle_events")
      .select("id, brokerage_id, actor_user_id, event_type, metadata, processed")
      .eq("id", eventId)
      .maybeSingle()

    if (fetchError || !event) {
      return { success: false, error: "Event not found" }
    }

    // Superadmins can replay across brokerages; everyone else must be in the
    // same brokerage as the event.
    //
    // This is a NEGATIVE test ANDed into a DENIAL, so the dead literal failed
    // CLOSED, not open: `u.user_type !== "superadmin"` was always true for the
    // real superadmin, which collapsed the condition to the plain tenant check
    // and denied the one account the exemption exists for. The gate it guards is
    // the cross-tenant replay of a lifecycle_event — nothing was ever let through
    // that should not have been; the platform owner was locked out of replaying
    // any event outside their own brokerage_id.
    if (!isSuperadmin && event.brokerage_id !== u.brokerage_id) {
      return { success: false, error: "Forbidden" }
    }

    if (event.processed) {
      return { success: true, skipped: true }
    }

    // Reconstruct Event shape and dispatch
    const eventAsEvent: Event = {
      id:           event.id,
      brokerage_id: event.brokerage_id,
      user_id:      event.actor_user_id ?? undefined,
      event_type:   event.event_type,
      payload:      (event.metadata as Record<string, any>) ?? {},
      source:       "system",
      created_at:   new Date().toISOString(),
    }

    await orchestrateEvent(eventAsEvent)

    return { success: true }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    await bestEffort(supabase
      .from("lifecycle_events")
      .update({ processed: true, processed_at: new Date().toISOString(), error: errorMessage })
      .eq("id", eventId), "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped")
    return { success: false, error: errorMessage }
  }
}
