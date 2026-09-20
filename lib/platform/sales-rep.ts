// lib/platform/sales-rep.ts
// ─────────────────────────────────────────────────────────────────────────────
// WHO TAKES THE DEMO / THE HUMAN HANDOFF — the platform's sales rep (lane 76B).
//
// Platform staff live in users.platform_role (CLAUDE.md §4 — NEVER
// user_type='superadmin', which no live row carries). The roster is
// lib/platform/platform-staff-roster.ts::PLATFORM_STAFF_ROLES; this module
// derives the SALES bench from it by named subtraction — `support` handles
// existing tenants, not prospects — and ranks the rest: marketing owns the
// growth funnel (the same capability that gates the growth board), then
// admin, then superadmin as the last resort.
//
// A rep is only bookable when they have a CONNECTED personal calendar
// (lib/providers/calendar/personal-calendar.ts::hasPersonalCalendar — the SAME
// Google/Microsoft adapter the listing appointment books through). With no
// connected calendar on the whole bench the demo exit FAILS CLOSED to the
// human handoff (a callback task), never an invented slot.
//
// calendar_events.brokerage_id is NOT NULL (verified live 2026-09-18) and the
// platform has no brokerage of its own; the rep's users.brokerage_id — which
// every live users row carries, including the superadmin — is the delivery
// key the demo row and its emails are scoped to, exactly the reasoning
// lib/notifications/platform-staff.ts documents for the staff bell. A rep
// with no brokerage_id is reported as not bookable rather than guessed.

import { PLATFORM_STAFF_ROLES, type PlatformStaffRole } from "@/lib/platform/platform-staff-roster"

/** The sales bench, in preference order — PLATFORM_STAFF_ROLES minus `support`. */
export const SALES_REP_ROLE_ORDER: readonly PlatformStaffRole[] = ["marketing", "admin", "superadmin"]

/** PURE guard used by the proof: the bench is a strict subset of the roster,
 *  and `support` is the ONLY role left out. */
export function salesBenchDerivesFromRoster(): boolean {
  const roster = new Set<string>(PLATFORM_STAFF_ROLES)
  const bench = new Set<string>(SALES_REP_ROLE_ORDER)
  if (!SALES_REP_ROLE_ORDER.every((r) => roster.has(r))) return false
  const leftOut = [...roster].filter((r) => !bench.has(r))
  return leftOut.length === 1 && leftOut[0] === "support"
}

export interface PlatformSalesRep {
  /** users.id — a USERS id (calendar_events.agent_user_id, dispatch userId). Never an agents.id. */
  userId: string
  /** The rep's users.brokerage_id — the tenant key calendar_events/dispatch require. */
  brokerageId: string
  email: string | null
  name: string
  platformRole: PlatformStaffRole
  /** True only when hasPersonalCalendar() confirmed a live Google/Microsoft token. */
  calendarConnected: boolean
}

/** PURE: rank candidates by the bench order, then by a connected calendar. */
export function rankSalesRepCandidates<T extends { platformRole: string; calendarConnected: boolean }>(rows: T[]): T[] {
  const rank = (r: string) => { const i = (SALES_REP_ROLE_ORDER as readonly string[]).indexOf(r); return i < 0 ? 99 : i }
  return [...rows].sort((a, b) => {
    if (a.calendarConnected !== b.calendarConnected) return a.calendarConnected ? -1 : 1
    return rank(a.platformRole) - rank(b.platformRole)
  })
}

/**
 * Resolve the platform sales rep. Returns the best-ranked staffer (calendar-
 * connected first); `calendarConnected:false` on the result means "a human
 * exists but nothing is bookable" — the caller offers the handoff instead.
 * Null = no platform staff with a brokerage_id at all (fail closed).
 */
export async function resolvePlatformSalesRep(svc: any): Promise<PlatformSalesRep | null> {
  const { data, error } = await svc.from("users")
    .select("id, brokerage_id, email, first_name, last_name, platform_role")
    .in("platform_role", SALES_REP_ROLE_ORDER as unknown as string[])
    .limit(50)
  if (error) { console.error("[sales-rep] users read refused:", error.message); return null }
  const rows = ((data ?? []) as Array<{ id: string; brokerage_id: string | null; email: string | null; first_name: string | null; last_name: string | null; platform_role: string }>)
    .filter((u) => !!u.brokerage_id)
  if (rows.length === 0) return null

  const { hasPersonalCalendar } = await import("@/lib/providers/calendar/personal-calendar")
  const candidates: PlatformSalesRep[] = []
  for (const u of rows) {
    const calendarConnected = await hasPersonalCalendar(u.id).catch(() => false)
    candidates.push({
      userId: u.id, brokerageId: u.brokerage_id as string, email: u.email,
      name: [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || "the team",
      platformRole: u.platform_role as PlatformStaffRole, calendarConnected,
    })
  }
  return rankSalesRepCandidates(candidates)[0] ?? null
}
