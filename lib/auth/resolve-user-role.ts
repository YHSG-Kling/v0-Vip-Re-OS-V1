/**
 * Canonical role resolution helper — Kernel OS
 *
 * `user_type` is the single source of truth. The legacy `role` column is
 * being retired; new code MUST NOT read or write it. This helper accepts
 * the legacy field on the input shape only to absorb in-flight callers
 * — it is ignored.
 */

// The roster is defined ONCE, in lib/platform/platform-staff-roster.ts. This module
// consumes it; it does not restate it. (That module is pure and imports nothing, so
// there is no cycle and no server-only leak into this pure helper.)
import { isPlatformStaffRole } from "@/lib/platform/platform-staff-roster"
// The grant reader is SHARED, never re-implemented here: user_role_assignments is
// UNIQUE on (user_id, role), so "read one grant" is the wrong shape and this module
// must not invent a second way to get it wrong. role-grants.ts is pure (its only
// import is a TYPE), so this stays a pure helper with no server-only leak.
import { readRoleGrants, holdsAnyRole } from "@/lib/auth/role-grants"

export type UserRole =
  | "agent"
  | "broker"
  | "broker_owner"
  | "admin"
  | "tc"
  | "vendor"
  | "lender"
  | "isa"
  | "team_lead"
  | "compliance_officer"
  | "title_agent"
  | "contact"
  | "system"
  | "superadmin"
  | "support"
  //
  // NOTE — this is a SECOND, SEPARATE `UserRole`. lib/security/types.ts exports
  // one too, and it is a DIFFERENT set: that one is the CANONICAL ROLE
  // vocabulary (what a user may BE after mapping), this one is the raw
  // users.user_type COLUMN vocabulary (what the row may literally store — hence
  // 'system' and 'support', which are not canonical roles). A value added to
  // one and not the other leaves assignments unassignable, so they move
  // together or not at all.
  //
  // A `member` value briefly lived in both and was removed from both (m470),
  // on the owner's ruling that the user_type IS the seat and a role grant only
  // adds capability on top of it — there is no rung below the seat.

/**
 * PLATFORM-STAFF IDENTITY — the ONE gate, and it takes BOTH columns.
 *
 * This file used to carry two answers to "who is platform staff", six lines apart:
 * a `PLATFORM_STAFF_ROLES = ["superadmin","support"]` const with an `isPlatformStaff`
 * that consulted it, and this function with a four-role array inlined — under a
 * comment claiming it kept the four roles "in ONE place". Both are gone. The roster
 * lives in lib/platform/platform-staff-roster.ts, which is what this now imports,
 * and which is the same four roles as users_platform_role_check and the RLS helper
 * public.is_platform_staff() (m408).
 *
 * WHY BOTH COLUMNS, AND WHY THE SINGLE-COLUMN VERSION WAS A BUG NOT A SHORTHAND.
 * `users` carries the staff answer across TWO columns and they do not hold the same
 * vocabulary. Measured on the live database, the mapping the staff CRUD writes
 * (app/actions/superadmin/platform-staff.ts#roleColumns) is:
 *
 *     platform_role   user_type
 *     superadmin      superadmin
 *     admin           admin
 *     support         support
 *     marketing       system      ← 'marketing' is not a legal user_type at all
 *
 * users_user_type_check admits fourteen values and 'marketing' is not one of them.
 * So a roster of platform_role values matched against user_type silently graded
 * `marketing` as not-staff, and `admin` as not-staff, no matter what the roster
 * said. Worse, the ONE live superadmin on this database is
 * (user_type='admin', platform_role='superadmin') — so the user_type-only gate
 * refused the platform's only administrator. Every caller now passes both columns.
 *
 * user_type participates ONLY through the legacy 'superadmin' marker, which is how
 * public.is_platform_admin() and public.is_platform_staff() read it too — an account
 * predating the platform_role column is not demoted by this.
 */
export function isPlatformStaffIdentity(
  userType: string | null | undefined,
  platformRole: string | null | undefined,
): boolean {
  if (userType === "superadmin") return true
  return isPlatformStaffRole(platformRole)
}

export function resolveUserRole(profile: {
  user_type?: string | null
  role?: string | null // tolerated on input, intentionally unread
}): UserRole {
  return (profile.user_type || "agent") as UserRole
}

export function requireRole(
  profile: { user_type?: string | null; role?: string | null },
  allowedRoles: UserRole[]
): boolean {
  return allowedRoles.includes(resolveUserRole(profile))
}

// ─── TENANT ADMIN — THE ONE ANSWER ───────────────────────────────────────────
//
// OWNER RULING, verbatim:
//
//   "3 is broker, broker admin, broker owner, team lead, admin then the platform
//    superadmin, platform admin. i think having more than one vocab over the same
//    function or feature is dangerous."
//
// Two rosters, not one, and the sentence separates them with "then":
//
//   TENANT admin-class : broker, broker_admin, broker_owner, team_lead, admin
//   PLATFORM identity  : superadmin, platform admin  → isPlatformStaffIdentity
//
// This set is the TENANT half. The platform half is answered ONE floor up in this
// same file by isPlatformStaffIdentity(userType, platformRole), backed by
// lib/platform/platform-staff-roster.ts. Neither restates the other.
//
// ── WHAT THIS SET NO LONGER CONTAINS, AND WHY THAT IS NOT A NARROWING ────────
//
// It used to carry `superadmin` and `super_admin`, mixing a PLATFORM identity
// into a TENANT test. Both are removed, and removing them is provably a no-op
// rather than a revocation:
//
//   · `superadmin` was tested against users.user_type. MEASURED on the live
//     database: ZERO rows have user_type='superadmin'. The platform's ONE
//     superadmin is (user_type='admin', platform_role='superadmin') — so the
//     branch could never fire for the account it existed to admit, while
//     `user_type='admin'` admitted them anyway through the tenant roster. Same
//     measurement, same conclusion as lib/auth/require-brokerage-admin.ts:30.
//   · `super_admin` is not a storable user_type at all: users_user_type_check
//     admits fourteen values and that is not one of them, and the constraint is
//     VALIDATED, so no row was grandfathered either.
//
// A call site that genuinely means "tenant admin OR platform staff" says so, with
// isTenantAdminOrPlatformStaff below. It is an explicit OR of the two single
// definitions, not a third roster.
//
// ── WHY THE LEGACY SPELLINGS STAY ────────────────────────────────────────────
//
// `broker_admin` canonicalizes to `broker` and `broker_owner` likewise groups with
// broker at brokerage-wide scope (lib/security/types.ts#LEGACY_ROLE_MAP). Neither
// broker_admin nor super_admin is STORABLE — accepted on INPUT, never written.
// They stay HERE and only here, because this function judges a value a CALLER
// hands in, which can be anything; it is not a query. A `.in("user_type", [...])`
// RECIPIENT lookup must NOT carry them: there they match nothing, forever.
const TENANT_ADMIN_USER_TYPES = new Set([
  "admin",
  "broker",
  "broker_owner",
  "team_lead",
  // LEGACY INPUT SPELLING — canonicalizes to `broker`, never stored.
  "broker_admin",
])

/**
 * THE tenant-admin predicate. PURE and SYNCHRONOUS, deliberately.
 *
 * ── WHY THIS STAYS SYNC WHEN THE RULE IT MIRRORS READS A TABLE ───────────────
 *
 * public.is_brokerage_admin() (m466) admits a user EITHER by users.user_type OR
 * by a role GRANT in user_role_assignments. The grant half needs I/O. Making this
 * function async to cover it would turn every one of its call sites into an await
 * — inside render paths and inside `.filter()` callbacks that cannot take one —
 * for a fact most of them already hold in memory.
 *
 * So the rule is split by WHAT THE CALLER ALREADY KNOWS, not by convenience:
 *
 *   isAdminOrBroker(profile)          — the user_type half. Pure. No I/O.
 *   resolveTenantAdmin(supabase, …)   — BOTH halves, mirroring RLS exactly. Async.
 *
 * They share ONE roster (the set above), so they cannot drift into two answers.
 * A gate that guards a WRITE should prefer resolveTenantAdmin: the write is going
 * to meet is_brokerage_admin() in RLS regardless, and a gate that admits less than
 * RLS refuses the second seat while a gate that admits more reports success over a
 * write that returned zero rows.
 *
 * Case-insensitive: users.user_type is CHECK-constrained to lowercase so this
 * changes nothing for it, but callers pass `userType ?? role` and users.role is
 * legacy free-form — MEASURED live, it holds 'Admin' and 'Lender'. Matches
 * holdsAnyRole in lib/auth/role-grants.ts, which is case-insensitive for the same
 * reason.
 */
export function isAdminOrBroker(profile: {
  user_type?: string | null
  // Tolerated on input, intentionally unread — see the module header. The legacy
  // `role` column is being retired; a caller that still has only that value passes
  // it as `user_type` explicitly rather than having this function read it silently.
  role?: string | null
}): boolean {
  return TENANT_ADMIN_USER_TYPES.has(String(profile.user_type ?? "").toLowerCase())
}

/**
 * The same ONE roster, asked of a `user_role_assignments.role` value.
 *
 * A grant is an ADMINISTERING FACT, not a decorative label (owner ruling, executed
 * in RLS by m466). This is the predicate half of that rule; resolveTenantAdmin
 * below is the part that also pins the grant to the caller's own tenant.
 */
export function isTenantAdminGrantRole(role: string | null | undefined): boolean {
  return TENANT_ADMIN_USER_TYPES.has(String(role ?? "").toLowerCase())
}

/**
 * "Tenant admin OR platform staff" — for the sites that genuinely mean BOTH.
 *
 * Not a third vocabulary: it is literally the OR of the two single definitions in
 * this file. It exists so that a site meaning both says BOTH out loud, instead of
 * smuggling `superadmin` into a tenant roster where it silently changed what
 * "tenant admin" means for every other caller of that roster.
 *
 * Takes platform_role because user_type alone cannot answer the platform question
 * — see isPlatformStaffIdentity's header for the measurement.
 */
export function isTenantAdminOrPlatformStaff(profile: {
  user_type?: string | null
  platform_role?: string | null
}): boolean {
  return isAdminOrBroker(profile) || isPlatformStaffIdentity(profile.user_type, profile.platform_role)
}

// ─── THE GRANT HALF — WHERE THE APP AND THE DATABASE STOPPED AGREEING ────────

export type TenantAdminResult =
  | { ok: true; isTenantAdmin: boolean; via: "user_type" | "grant" | "none" }
  | { ok: false; error: string }

/**
 * The FULL tenant-admin rule: users.user_type OR a tenant role GRANT.
 *
 * ── THE DISAGREEMENT THIS CLOSES, MEASURED LIVE ─────────────────────────────
 *
 * m466 taught public.is_brokerage_admin() to honour a role grant, on the owner's
 * ruling that a grant is an administering fact. The app never learned it. So on
 * the live database TODAY:
 *
 *   agent1@yourbrokerage.com  (users.id 779eb048-7356-43bf-87a0-7fc9370f12f1)
 *     users.user_type   = 'agent'
 *     users.brokerage_id= 231f4e64-5022-4752-8047-696886551c35
 *     grants            = agent + admin + isa, ALL on 231f4e64…
 *
 *   is_brokerage_admin()  → TRUE   (the admin grant, on their own brokerage)
 *   isAdminOrBroker()     → FALSE  (user_type is 'agent')
 *
 * That is the ruling's SECOND SEAT — the person who carries transactions,
 * compliance, support and admin for a solo-agent tenant — and the app refused
 * them at every gate while RLS let them through. The app was the NARROWER of the
 * two, which is the merely-annoying direction; this function removes the gap.
 *
 * ── THE TENANT PIN IS NOT OPTIONAL ──────────────────────────────────────────
 *
 * A grant administering a DIFFERENT brokerage authorises NOTHING. The SQL pins
 * with `ura.brokerage_id = current_user_brokerage_id()`; this pins with the
 * caller's own `brokerage_id`, passed in. A NULL brokerage_id on either side is
 * not a tenancy — MEASURED, the live `contact` and `lender` grants both carry
 * NULL — and it can never satisfy the pin, matching `NULL = x` in SQL.
 *
 * ── WHY A RESULT AND NOT A BOOLEAN ──────────────────────────────────────────
 *
 * supabase-js RESOLVES a refused query. A boolean return would have to report
 * "the grant read was denied" as `false`, i.e. as "not an admin" — refusing a
 * legitimate admin for the wrong reason, invisibly. The caller is told which it
 * was, exactly as readRoleGrants does.
 *
 * @param userId the SESSION user's id — never an id from a request body.
 */
export async function resolveTenantAdmin(
  supabase: Parameters<typeof readRoleGrants>[0],
  userId: string,
  profile: { user_type?: string | null; brokerage_id?: string | null },
): Promise<TenantAdminResult> {
  // The pure half first: no I/O for the users this already answers.
  if (isAdminOrBroker(profile)) return { ok: true, isTenantAdmin: true, via: "user_type" }

  // No tenant of their own → no grant can be pinned to it. Same as SQL.
  const brokerageId = profile.brokerage_id ?? null
  if (!brokerageId) return { ok: true, isTenantAdmin: false, via: "none" }

  // NEVER .maybeSingle() here: user_role_assignments is UNIQUE on (user_id, role),
  // not on user_id, and the very account this function exists to admit holds
  // three grants. readRoleGrants is the shared reader for exactly that reason.
  const res = await readRoleGrants(supabase, userId)
  if (!res.ok) return { ok: false, error: res.error }

  const pinned = res.grants.filter((g) => g.brokerage_id && g.brokerage_id === brokerageId)
  if (holdsAnyRole(pinned, [...TENANT_ADMIN_USER_TYPES])) {
    return { ok: true, isTenantAdmin: true, via: "grant" }
  }
  return { ok: true, isTenantAdmin: false, via: "none" }
}
