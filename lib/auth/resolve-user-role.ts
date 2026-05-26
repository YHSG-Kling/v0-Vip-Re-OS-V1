/**
 * Canonical role resolution helper — Kernel OS
 *
 * `user_type` is the single source of truth. The legacy `role` column is
 * being retired; new code MUST NOT read or write it. This helper accepts
 * the legacy field on the input shape only to absorb in-flight callers
 * — it is ignored.
 */

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

/**
 * Platform-staff roles operate ABOVE any brokerage. `superadmin` has full control
 * (config, billing, brokerage management); `support` is a platform support tier with
 * the same cross-brokerage visibility for triaging platform issues, intended for
 * assistance rather than destructive platform configuration.
 */
export const PLATFORM_STAFF_ROLES = ["superadmin", "support"] as const

/** True for platform-staff roles (superadmin OR support) — cross-brokerage visibility. */
export function isPlatformStaff(role: string | null | undefined): boolean {
  return !!role && (PLATFORM_STAFF_ROLES as readonly string[]).includes(role)
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

export function isAdminOrBroker(profile: {
  user_type?: string | null
  role?: string | null
}): boolean {
  return requireRole(profile, ["admin", "broker", "broker_owner", "superadmin"])
}
