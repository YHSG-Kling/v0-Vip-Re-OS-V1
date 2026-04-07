/**
 * Canonical role resolution helper — Kernel OS
 *
 * Rule: ALWAYS read user_type first; fall back to role for backward compat.
 * Both columns exist on the `users` table (confirmed in Supabase schema).
 * Never check role alone — use resolveUserRole() or requireRole() everywhere.
 */

export type UserRole =
  | "agent"
  | "broker"
  | "admin"
  | "tc"
  | "vendor"
  | "lender"
  | "isa"
  | "team_lead"
  | "compliance_officer"
  | "superadmin"

/**
 * Resolves the canonical role from a user profile row.
 * Prefers user_type; falls back to role; defaults to "agent".
 */
export function resolveUserRole(profile: {
  user_type?: string | null
  role?: string | null
}): UserRole {
  return ((profile.user_type ?? profile.role) || "agent") as UserRole
}

/**
 * Returns true if the resolved role is included in allowedRoles.
 */
export function requireRole(
  profile: { user_type?: string | null; role?: string | null },
  allowedRoles: UserRole[]
): boolean {
  return allowedRoles.includes(resolveUserRole(profile))
}

/**
 * Convenience: true if the user is an admin, broker, or superadmin.
 */
export function isAdminOrBroker(profile: {
  user_type?: string | null
  role?: string | null
}): boolean {
  return requireRole(profile, ["admin", "broker", "superadmin"])
}
