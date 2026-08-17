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
  // m469. This union models users.user_type, and the database now admits
  // 'member' — the bare seat for a user carrying NO business role, who sees only
  // their own work until a role is granted to them.
  //
  // THIS IS A SECOND, SEPARATE `UserRole`. lib/security/types.ts exports one too,
  // and it is a DIFFERENT set: that one is the CANONICAL ROLE vocabulary (what a
  // user may BE after mapping), this one is the raw user_type COLUMN vocabulary
  // (what the row may literally store — hence 'system' and 'support', which are
  // not canonical roles). Adding the seat to one and not the other is what left
  // three assignments in lib/auth/useAuth.ts unassignable: `User.role` in
  // types/user.ts resolves to THIS union, while the value being assigned had
  // already been canonicalised through the other.
  | "member"

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

// Broker-level access gate. Checks the RAW user_type against every broker/admin
// variant, INCLUDING legacy spellings (broker_admin canonicalizes to broker,
// super_admin to superadmin — see lib/security/types.ts). resolveUserRole does
// not canonicalize, so the legacy variants are listed explicitly here; this keeps
// the gate consistent with app/actions/brokerage-fees.ts#isBrokerRole and the
// create/update settings actions that admit broker_admin.
//
// The legacy spellings stay HERE and only here. This function judges a value a
// CALLER hands in, which can be anything; it is not a query. They were also
// sitting in 24 `.in("user_type", [...])` RECIPIENT lookups, where they were
// provably dead: users_user_type_check admits fourteen values and broker_admin is
// not one of them, and the constraint is VALIDATED, so no row was grandfathered
// either. Those were harmless — every list also carried broker/admin, so the
// lookups still found their recipients — but they read as though broker_admin
// were a thing you could be. Removed there, kept here.
const BROKER_LEVEL_TYPES = new Set([
  "admin",
  "broker",
  "broker_owner",
  "broker_admin",
  "superadmin",
  "super_admin",
])
export function isAdminOrBroker(profile: {
  user_type?: string | null
  role?: string | null
}): boolean {
  return BROKER_LEVEL_TYPES.has(profile.user_type ?? "")
}
