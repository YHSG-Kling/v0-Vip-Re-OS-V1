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
// `ai_isa_system` is deliberately absent from THIS array. It is a legal
// users.platform_role value, but it marks the two automated ISA service accounts,
// not a member of staff. It IS a platform actor — see PLATFORM_ACTOR_ROLES and
// platformActorKind() below, added when the owner ruled that the ISA "works for
// 1 tenant at a time and works for the platform as well". Staff, actor and
// total-control are three different questions and this file answers all three
// separately rather than letting one stand in for another.

export const PLATFORM_STAFF_ROLES = ["superadmin", "admin", "marketing", "support"] as const
export type PlatformStaffRole = (typeof PLATFORM_STAFF_ROLES)[number]

export function isPlatformStaffRole(role: string | null | undefined): role is PlatformStaffRole {
  return !!role && (PLATFORM_STAFF_ROLES as readonly string[]).includes(role)
}

// ─── THE PLATFORM / OS DISCRIMINATOR — ONE DEFINITION ────────────────────────
//
// OWNER RULING (2026-08-24), verbatim:
//
//   "I beilieve when users are created in supabase, they tie directly into
//    public.users; we used superadmin origninally to discipher for a platform/os
//    level user but a global/platform/os user has total control over the
//    complete os system"
//
// So `superadmin` is the marker for the platform/OS-level user, and that user has
// TOTAL CONTROL of the whole OS. A test that decides that is therefore the highest-
// consequence predicate in the tree, and until now it was SPELLED PER SITE.
//
// ── WHAT THIS ENDS, MEASURED ────────────────────────────────────────────────
// scripts/platform-discriminator-guard.ts counted the re-spellings on stripped
// source. Every one of them was one of two questions, asked in one of two ways:
//
//     userType === "superadmin"                      ← half the answer
//     platformRole === "superadmin"                  ← the other half
//     userType === "superadmin" || platformRole === "superadmin"
//     platform_role ?? (user_type === "superadmin" ? "superadmin" : null)
//
// and the halves are NOT interchangeable. MEASURED on hrvaqgvukzxfskkcrwbt
// 2026-08-24, all 23 live `users` rows:
//
//     platform_role   user_type            n   rows with NULL brokerage_id
//     NULL            agent/contact/…     20   0
//     ai_isa_system   system               2   0
//     superadmin      admin                1   0
//
//   · ZERO rows carry user_type='superadmin'. A gate spelled on user_type alone
//     is DEAD CODE — it can never fire for the account it exists to admit.
//   · The platform's ONLY superadmin is (user_type='admin', platform_role='superadmin').
//   · 0 of 23 rows have a NULL brokerage_id, and the superadmin HAS one. So on
//     `public.users` the platform discriminator is `platform_role`, NOT an absent
//     brokerage_id. (The earlier ruling "platform only has no brokerageid" governs
//     DATA rows; lib/kernel/tenant-scope.ts is where that lives. This is identity.)
//
// This mirrors public.is_platform_admin() in RLS, which reads BOTH columns:
//     SELECT platform_role = 'superadmin' OR user_type IN ('superadmin','super_admin')
// (`super_admin` is not a legal users_user_type_check value, so that arm is inert.)
//
// ── `ai_isa_system` IS A PLATFORM ROLE AND IS NOT A HUMAN SUPERADMIN ─────────
// users_platform_role_check admits five values: the four staff roles above PLUS
// `ai_isa_system`, which marks the two automated ISA service accounts. It must
// never inherit "total control". The refusal below is EXPLICIT rather than an
// accident of `!== 'superadmin'`, so a mutation test can prove it is load-bearing
// and a future non-human marker inherits the refusal by being added to one array.
// The database agrees: users_isa_actor_shape_check forces user_type='system' for
// an ai_isa_system row, so it cannot reach the legacy user_type arm either.

/** Platform roles that are SERVICE ACCOUNTS, not members of staff. Never granted control. */
export const PLATFORM_NONHUMAN_ROLES = ["ai_isa_system"] as const
export type PlatformNonHumanRole = (typeof PLATFORM_NONHUMAN_ROLES)[number]

export function isNonHumanPlatformRole(role: string | null | undefined): role is PlatformNonHumanRole {
  return !!role && (PLATFORM_NONHUMAN_ROLES as readonly string[]).includes(role)
}

// ── "PLATFORM ACTOR" AND "TOTAL CONTROL" ARE TWO DIFFERENT QUESTIONS ─────────
//
// OWNER RULING (2026-08-24), verbatim:
//
//   "ai isa system works for 1 tenant at a time and works for the platform as well"
//
// This CORRECTS a reading the previous wave shipped. The refusal above is right
// and stays: `ai_isa_system` must never inherit "total control over the complete
// os system". But the wave's PROSE went further than the ruling and read as "the
// ISA is not a platform role at all", which the database contradicts —
// users_platform_role_check admits it, and the two live rows carry it.
//
// The two questions are now spelled apart, because collapsing them is how a
// service account either gets handed the whole OS (too permissive) or gets
// treated as a tenant user and loses the platform work it legitimately does
// (too restrictive):
//
//     isPlatformActorRole(role)             ← does this identity act ABOVE one tenant?
//     isPlatformSuperadminIdentity(…)       ← does it have TOTAL CONTROL?
//
// `ai_isa_system` answers YES to the first and NO to the second. Every human
// staff role answers YES to the first; only superadmin answers YES to the second.
// A tenant user answers NO to both.
//
// THE LOAD-BEARING HALF IS NOT THIS PREDICATE. "Works for one tenant at a time"
// is a property of a SESSION, not of a role string, and it cannot be answered
// here because nothing in an identity says which tenant it is currently acting
// for. That question is answered — and REFUSED when unset or plural — by
// lib/ai-isa/isa-acting-scope.ts::resolveIsaActingScope, which returns the
// TenantScope vocabulary from lib/kernel/tenant-scope.ts. This function exists so
// that resolver has ONE definition of "is this the ISA service actor" to gate on,
// rather than a 65th re-spelling of a platform_role comparison.

/** Every platform_role: the human staff roster AND the non-human service roles. */
export const PLATFORM_ACTOR_ROLES = [...PLATFORM_STAFF_ROLES, ...PLATFORM_NONHUMAN_ROLES] as const
export type PlatformActorRole = (typeof PLATFORM_ACTOR_ROLES)[number]

/**
 * Does this platform_role act ABOVE a single tenant — as staff OR as a service
 * account? Deliberately NOT the same test as `isPlatformSuperadminIdentity`:
 * being a platform actor grants no capability by itself.
 */
export function isPlatformActorRole(role: string | null | undefined): role is PlatformActorRole {
  return isPlatformStaffRole(role) || isNonHumanPlatformRole(role)
}

/**
 * WHICH KIND of platform actor an identity is, in one word.
 *
 *   "staff"    a human platform employee (capabilities via platformStaffCan)
 *   "service"  an automated platform account — the AI ISA today
 *   null       not a platform actor at all (an ordinary tenant user)
 *
 * Reads BOTH identity columns for the same reason every predicate in this file
 * does: neither alone answers it. The legacy `user_type='superadmin'` marker
 * still counts as staff, and the service refusal is checked FIRST so a row that
 * somehow carried both could not be promoted by the legacy arm. (The database
 * already forbids that combination — users_isa_actor_shape_check forces
 * user_type='system' for an ai_isa_system row — so this is defence in depth, not
 * a live hole.)
 */
export function platformActorKind(
  userType: string | null | undefined,
  platformRole: string | null | undefined,
): "staff" | "service" | null {
  if (isNonHumanPlatformRole(platformRole)) return "service"
  if (isPlatformStaffRole(platformRole)) return "staff"
  return userType === "superadmin" ? "staff" : null
}

/**
 * THE ONE TEST for "this identity is the AI ISA service actor".
 *
 * Both columns, both required: the DB CHECK pairs platform_role='ai_isa_system'
 * with user_type='system', so an identity that carries only one of them is not
 * an ISA actor — it is a malformed row, and the fail-closed answer to a malformed
 * row is NO. Written here rather than in the ISA module so the ISA scope resolver
 * and any future ISA gate share one definition (§6).
 */
export function isAiIsaSystemIdentity(
  userType: string | null | undefined,
  platformRole: string | null | undefined,
): boolean {
  return platformRole === "ai_isa_system" && userType === "system"
}

/**
 * THE ONE TEST for "this identity is the platform/OS user with total control".
 *
 * Takes BOTH identity columns because neither alone answers it (see above).
 * Pure — no client, no session — so it can gate a session guard, an API guard, a
 * server action and a page from the same definition.
 */
export function isPlatformSuperadminIdentity(
  userType: string | null | undefined,
  platformRole: string | null | undefined,
): boolean {
  // A service account is never the OS user, whatever else its row says.
  if (isNonHumanPlatformRole(platformRole)) return false
  return userType === "superadmin" || platformRole === "superadmin"
}

/**
 * THE ONE derivation of a caller's EFFECTIVE platform role: `platform_role` wins;
 * the legacy `user_type='superadmin'` marker still counts as superadmin.
 *
 * Returns NULL for a non-staff row AND for a service account — every caller of this
 * shape is a STAFF GATE, so answering `ai_isa_system` would hand a role string to a
 * capability check that only knows how to compare it against staff roles. Failing
 * closed here is the honest answer to "which staff role is this?": none.
 */
export function resolvePlatformRoleIdentity(
  userType: string | null | undefined,
  platformRole: string | null | undefined,
): PlatformStaffRole | null {
  if (isPlatformStaffRole(platformRole)) return platformRole
  if (isNonHumanPlatformRole(platformRole)) return null
  return userType === "superadmin" ? "superadmin" : null
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
