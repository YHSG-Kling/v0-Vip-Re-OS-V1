// lib/support/ticket-scope.ts
// ─────────────────────────────────────────────────────────────────────────────
// WHO READS WHICH SUPPORT QUEUE — ONE PURE DECISION (wave 142, lane 142A).
//
// Owner, 2026-10-18, verbatim: "tenant should not read ticket queue across
// brokerages, only their tenancy." A tenant seat — INCLUDING a users.user_type of
// 'support' — reads and writes ONLY its own brokerage's tickets, messages, counts
// and notifications. A global (cross-tenant) queue is PLATFORM STAFF ONLY, decided
// from users.platform_role through the roster predicates — never from a user_type.
//
// WHY THIS MODULE EXISTS. At fec8b6a95 app/actions/support.ts answered "who reads
// across brokerages?" with `ctx.userType === "support"` (:108). 'support' is a
// storable TENANT seat type (users_user_type_check) as well as the user_type the
// platform-staff CRUD writes beside platform_role='support'
// (app/actions/superadmin/platform-staff.ts roleColumns) — so that arm admitted a
// row typed 'support' with NO platform_role to every brokerage's queue through the
// service client, and no proof covered the path. The same file and
// app/dashboard/admin/support-tickets/page.tsx each RETYPED the office roster as a
// six-string literal (§6: two spellings of one idea). Both now import this module.
//
// THE PLATFORM HALF IS NOT RE-DERIVED HERE. The cross-tenant verdict is produced
// by the ONE platform capability gate the support console already uses —
// requirePlatformCapability("support") (lib/platform/require-capability.ts:
// platform_role → resolvePlatformRoleIdentity → platformStaffCan, plus the
// superadmin-edited overrides). app/actions/support.ts hands that verdict in as
// `platformSupport`; this module only refuses to let a user_type widen it.
//
// PURE: no client, no session — scripts/support-isolation-guard.ts proves it in
// memory against the very predicate the actions apply to their queries.

import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"

/**
 * Tenant seats that staff a brokerage's support desk: the OPERATIONAL admin roster
 * (spread from the survivor, never restated — CLAUDE.md §4) PLUS 'support', the
 * storable tenant seat type that answers the office queue. TENANT-SCOPED ONLY: being
 * on this set never reaches another brokerage's rows.
 */
export const SUPPORT_DESK_USER_TYPES: ReadonlySet<string> = new Set([...TENANT_ADMIN_USER_TYPES, "support"])

export type TicketQueueScope =
  /** Cross-tenant — ONLY a platform verdict (platform_role) produces it. */
  | { kind: "platform" }
  /** Pinned, unconditionally, to the caller's SESSION tenant. */
  | { kind: "tenant"; brokerageId: string }
  | { kind: "refused"; reason: string }

export type AdmittedTicketScope = Exclude<TicketQueueScope, { kind: "refused" }>

/**
 * PURE: the scope a caller may read the support queue in.
 *
 *   platformSupport  the verdict of requirePlatformCapability("support") — read from
 *                    platform_role (+ overrides) by that gate; NEVER a user_type.
 *   userType         the caller's users.user_type — decides only whether the seat
 *                    may staff ITS OWN brokerage's desk. It can never widen scope.
 *   brokerageId      the caller's SESSION tenant (never a request body).
 */
export function resolveTicketQueueScope(identity: {
  platformSupport: boolean
  userType: string | null | undefined
  brokerageId: string | null | undefined
}): TicketQueueScope {
  if (identity.platformSupport === true) return { kind: "platform" }
  const userType = String(identity.userType ?? "")
  if (!SUPPORT_DESK_USER_TYPES.has(userType)) return { kind: "refused", reason: "not a support-desk seat" }
  if (!identity.brokerageId) return { kind: "refused", reason: "no session tenant" }
  return { kind: "tenant", brokerageId: identity.brokerageId }
}

/**
 * Pin a support_tickets query to an admitted scope. A tenant scope is pinned to the
 * session tenant with no branch on the id itself; the platform scope is the only
 * unpinned read, and only a platform verdict produces that scope.
 */
export function scopeTicketQuery<Q>(query: Q, scope: AdmittedTicketScope): Q {
  if (scope.kind === "platform") return query
  // Structural, not generic over PostgREST's builder: constraining Q on `eq` makes tsc instantiate the
  // builder's own generics against the constraint (TS2589 at the call site). The pin is the same `.eq`.
  const q = query as unknown as { eq: (column: "brokerage_id", value: string) => unknown }
  return q.eq("brokerage_id", scope.brokerageId) as unknown as Q
}

/** PURE: may this scope touch that ticket (and, by m468's parent rule, its thread)? */
export function ticketWithinScope(ticket: { brokerage_id?: string | null }, scope: AdmittedTicketScope): boolean {
  if (scope.kind === "platform") return true
  return ticket.brokerage_id != null && ticket.brokerage_id === scope.brokerageId
}
