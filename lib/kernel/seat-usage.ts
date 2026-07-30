// lib/kernel/seat-usage.ts
// ─────────────────────────────────────────────────────────────────────────────
// HOW MANY SEATS IS THIS TENANT USING? One answer, and it counts USERS.
//
// A seat is a PERSON, not a role. The OS assigns roles two ways and both are
// real:
//
//   users.user_type          the user's primary type — what most surfaces read
//   user_role_assignments    the RBAC table: a user may hold SEVERAL roles
//                            (live today: 2 users hold more than one, and 3
//                            assignments disagree with that user's user_type)
//
// Counting only `user_type` therefore under-counts by construction: a user whose
// primary type is not a seat role but who has been ASSIGNED one — an admin also
// carrying agent, a contact granted isa — held a seat the meter could not see. It
// happens to agree on today's data, which is exactly why it would have gone
// unnoticed until a tenant slipped past their limit.
//
// So: a user consumes ONE seat if they are not suspended and ANY of their roles
// (primary or assigned) is seat-consuming. Distinct users, never role rows —
// giving a user a second role must never charge them twice.

import type { SupabaseClient } from "@supabase/supabase-js"
import { SEAT_ROLES } from "./tier-role-matrix"

type Svc = SupabaseClient<any, any, any>

export interface SeatUsage {
  /** Distinct non-suspended users holding at least one seat-consuming role. */
  seatCount: number
  /** Their user ids — so a surface can show WHO, not just how many. */
  seatHolderIds: string[]
  /** Everyone in the workspace, seat-holding or not (partners, contacts, system). */
  peopleCount: number
  /**
   * Every DISTINCT role in use by a non-suspended seat holder, from BOTH sources.
   *
   * Exists for the owner's agent-role advisory: "they can use those seats anyway
   * they want but if they don't use atleast 1 agent role, then they won't get much
   * out of the system." Answering that needs the roles, not just the count — and it
   * must consider assigned roles too, or an admin who also carries agent would read
   * as a workspace with no agent.
   */
  rolesInUse: string[]
}

/**
 * Resolve a brokerage's seat usage. Never throws — a read failure returns zeroes
 * rather than a misleading number, and the caller renders an honest empty state.
 */
export async function resolveSeatUsage(svc: Svc, brokerageId: string): Promise<SeatUsage> {
  const seatRoles = new Set<string>(SEAT_ROLES as readonly string[])

  const [usersRes, rolesRes] = await Promise.all([
    svc.from("users").select("id, user_type, status").eq("brokerage_id", brokerageId),
    svc.from("user_role_assignments").select("user_id, role").eq("brokerage_id", brokerageId),
  ])

  const users = (usersRes.data ?? []) as Array<{ id: string; user_type: string | null; status: string | null }>
  const assignments = (rolesRes.data ?? []) as Array<{ user_id: string | null; role: string | null }>

  // user_id → every seat-consuming role they hold by ASSIGNMENT
  const assignedSeatRole = new Set<string>()
  for (const a of assignments) {
    if (a.user_id && a.role && seatRoles.has(a.role)) assignedSeatRole.add(a.user_id)
  }

  const holders = users.filter(
    (u) =>
      u.status !== "suspended" &&
      (seatRoles.has(u.user_type ?? "") || assignedSeatRole.has(u.id)),
  )

  // Roles actually in use across both sources, restricted to seat holders — a
  // suspended user's role is not "in use", and a partner's never was.
  const holderIds = new Set(holders.map((u) => u.id))
  const rolesInUse = new Set<string>()
  for (const u of holders) {
    if (u.user_type && seatRoles.has(u.user_type)) rolesInUse.add(u.user_type)
  }
  for (const a of assignments) {
    if (a.user_id && a.role && seatRoles.has(a.role) && holderIds.has(a.user_id)) {
      rolesInUse.add(a.role)
    }
  }

  return {
    seatCount: holders.length,
    seatHolderIds: holders.map((u) => u.id),
    peopleCount: users.length,
    rolesInUse: [...rolesInUse].sort(),
  }
}
