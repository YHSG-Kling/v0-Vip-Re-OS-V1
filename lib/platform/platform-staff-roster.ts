// lib/platform/platform-staff-roster.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ROSTER. One definition of who platform staff are, for the whole codebase.
//
// Platform EMPLOYEES (not tenant users): the people who run the platform itself.
// The owner's ruling is verbatim:
//
//   "the platform roles are the staff including superadmin, admin, support,
//    marketing."
//
// Four roles, and this array is the only place they are written down in
// TypeScript. It is the same four the database enforces — users_platform_role_check
// admits exactly {superadmin, admin, marketing, support} plus the non-human
// ai_isa_system marker — and the same four the RLS helper public.is_platform_staff()
// carries (migration m408). A platform employee has NO brokerage_id: they sit above
// every tenant.
//
// WHY THE HEADER USED TO SAY "TWO". It said "Two recognized platform roles —
// superadmin and support" directly above a four-element array, because the array
// was widened and the prose was not. That drift was not cosmetic: a SECOND
// PLATFORM_STAFF_ROLES lived in lib/auth/resolve-user-role.ts still holding
// ["superadmin","support"], and it was the one the notification fan-out and every
// isPlatformStaff() caller actually imported — so `admin` and `marketing` staff were
// invisible to half the platform. That duplicate is deleted; this is the survivor.
// If the roster changes, it changes HERE, and the DB CHECK plus is_platform_staff()
// change with it.
//
// `ai_isa_system` is deliberately absent. It is a legal users.platform_role value,
// but it marks the two automated ISA service accounts, not a member of staff.

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
export const PLATFORM_CAPABILITIES = [
  "plans", "billing", "staff", "providers", "marketing",
  "support", "tenants", "ai_ops", "sentinel", "impersonate",
  "announcements", // post internal staff announcements (admin+); every staff role reads them
] as const
export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[number]

// Roles whose capabilities MAY be overridden per-role in platform_role_capability_overrides.
// superadmin is deliberately absent — '*' is a HARD RULE, enforced here, in the gate,
// in setCapabilityOverrideAction, AND by the table's role CHECK.
export const OVERRIDABLE_PLATFORM_ROLES = ["admin", "marketing", "support"] as const
export type OverridablePlatformRole = (typeof OVERRIDABLE_PLATFORM_ROLES)[number]

const CAPS: Record<PlatformStaffRole, PlatformCapability[] | "*"> = {
  superadmin: "*",
  admin: ["plans", "billing", "providers", "marketing", "support", "tenants", "ai_ops", "sentinel", "impersonate", "announcements"],
  marketing: ["marketing", "tenants"],
  support: ["support", "tenants", "impersonate"],
}
export function platformStaffCan(role: string | null | undefined, capability: PlatformCapability): boolean {
  if (!isPlatformStaffRole(role)) return false
  const caps = CAPS[role]
  return caps === "*" || caps.includes(capability)
}

/** A superadmin-set override row (platform_role_capability_overrides). Shared
 *  DTO for the server loader AND the client matrix editor. The MERGE semantics
 *  live in ONE place: mergeCapability (lib/platform/capability-overrides.ts). */
export interface CapabilityOverride {
  role: string
  capability: string
  allowed: boolean
  access: "read" | "write"
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
