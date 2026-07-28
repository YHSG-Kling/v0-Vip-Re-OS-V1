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
/**
 * ROUND-19 PARITY: dual-column staff identity. 'admin'/'marketing' are roster
 * roles carried ONLY in platform_role ('admin' is also a tenant user_type, so
 * user_type participates solely via the legacy 'superadmin' marker).
 */
export function isPlatformStaffIdentity(
  userType: string | null | undefined,
  platformRole: string | null | undefined,
): boolean {
  if (userType === "superadmin") return true
  // Lazy import avoided — the roster is pure; inline the roster check here to
  // keep this module dependency-light and the four roles in ONE place there.
  const ROSTER = ["superadmin", "admin", "marketing", "support"]
  return !!platformRole && ROSTER.includes(platformRole)
}

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
// provably dead: users_user_type_check admits fifteen values and broker_admin is
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
