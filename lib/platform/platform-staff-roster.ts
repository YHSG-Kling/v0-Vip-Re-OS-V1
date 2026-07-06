// lib/platform/platform-staff-roster.ts
// ─────────────────────────────────────────────────────────────────────────────
// Platform EMPLOYEES (not tenant users): the people who run the platform itself.
// Two recognized platform roles — superadmin (full control) and support (limited
// operator). These are the roles the platform gates already accept (requireStaff
// across ai-ops / os-sentinel / plan-catalog checks user_type|platform_role ∈
// {superadmin, support}). A platform employee has NO brokerage_id — they sit above
// every tenant. Pure validation so the superadmin CRUD can't create a malformed
// or wrongly-scoped staff account.

export const PLATFORM_STAFF_ROLES = ["superadmin", "admin", "marketing", "support"] as const
export type PlatformStaffRole = (typeof PLATFORM_STAFF_ROLES)[number]

export function isPlatformStaffRole(role: string | null | undefined): role is PlatformStaffRole {
  return !!role && (PLATFORM_STAFF_ROLES as readonly string[]).includes(role)
}

// ── Platform capability map (pure) ────────────────────────────────────────────
// What each platform role may do. superadmin = everything; admin = operate the
// platform but NOT manage other staff's roles; marketing = marketing surfaces +
// read-only dashboards; support = tenant support + read. The surface gates consult
// platformStaffCan(role, capability) so access is provable in one place.
export type PlatformCapability =
  | "plans" | "billing" | "staff" | "providers" | "marketing"
  | "support" | "tenants" | "ai_ops" | "sentinel" | "impersonate"

const CAPS: Record<PlatformStaffRole, PlatformCapability[] | "*"> = {
  superadmin: "*",
  admin: ["plans", "billing", "providers", "marketing", "support", "tenants", "ai_ops", "sentinel", "impersonate"],
  marketing: ["marketing", "tenants"],
  support: ["support", "tenants", "impersonate"],
}

export function platformStaffCan(role: string | null | undefined, capability: PlatformCapability): boolean {
  if (!isPlatformStaffRole(role)) return false
  const caps = CAPS[role]
  return caps === "*" || caps.includes(capability)
}

export interface StaffInput {
  email: string
  firstName: string
  lastName?: string
  role: string
}

export interface NormalizedStaff {
  email: string
  firstName: string
  lastName: string
  role: PlatformStaffRole
}

export type StaffValidation = { ok: true; value: NormalizedStaff } | { ok: false; error: string }

function isValidEmail(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)
}

/** PURE: validate + normalize a platform-staff create/update input. */
export function validateStaffInput(input: StaffInput): StaffValidation {
  const email = (input.email ?? "").trim().toLowerCase()
  if (!isValidEmail(email)) return { ok: false, error: "A valid email is required" }
  const firstName = (input.firstName ?? "").trim()
  if (!firstName) return { ok: false, error: "First name is required" }
  if (!isPlatformStaffRole(input.role)) {
    return { ok: false, error: `Role must be one of: ${PLATFORM_STAFF_ROLES.join(", ")}` }
  }
  return { ok: true, value: { email, firstName, lastName: (input.lastName ?? "").trim(), role: input.role } }
}
