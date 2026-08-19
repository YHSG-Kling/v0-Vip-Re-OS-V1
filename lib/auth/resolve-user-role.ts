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

// TOMBSTONE (orphan burn-down, lane E): `resolveUserRole(profile)` DELETED.
//
// It was the last line of a migration that has finished. Its body had already
// been reduced to `(profile.user_type || "agent") as UserRole` — the legacy
// `role` column it existed to fall back to is "tolerated on input, intentionally
// unread" (module header), so the function no longer RESOLVED anything: it was
// an identity read with a default and an unchecked cast, and it had zero callers.
//
// WHERE THE JOB LIVES NOW — the question splits in two, and each half has a
// survivor that is more complete than the wrapper was:
//
//   · "what does this row store, with a default" — read `user_type` at the call
//     site. That is already the house idiom at ~40 live sites, e.g.
//     app/dashboard/operations/page.tsx:25, app/dashboard/marketing/review/page.tsx:48,
//     app/dashboard/campaigns/sequences/[id]/page.tsx:49. Inlining it is not
//     duplication: it is one expression, and routing it through a helper bought
//     nothing but a cast that could not fail loudly.
//
//   · "which CANONICAL role is this, whatever spelling arrived" — that is the
//     real resolution, and it is lib/security/types.ts:161 `toCanonicalRole` /
//     :174 `toCanonicalRoleOrDefault`, which map legacy aliases through
//     LEGACY_ROLE_MAP ('transaction_coordinator' → 'tc', 'TC' → 'tc') and return
//     null for an unrecognised value instead of casting it. The deleted function
//     mapped NOTHING, so a row holding a legacy spelling came back out unchanged
//     and typed as if it were canonical.
//
// The GATES in this file (isAdminOrBroker, isBrokerageFinanceAdmin,
// isTenantAdminOrPlatformStaff, resolveTenantAdmin, resolveBrokerageFinanceAdmin,
// isPlatformStaffIdentity) are untouched and remain the only sanctioned way to
// turn a role into permission — they are what its siblings' callers actually use.
//
// The `UserRole` TYPE above stays: it is the users.user_type column vocabulary
// and is imported by types/user.ts:1.

// TOMBSTONE (orphan tranche 3): requireRole deleted — a one-line membership
// wrapper with zero callers. The live survivors are the NAMED role predicates
// below (isAdminOrBroker, isTenantAdminGrantRole, isBrokerageFinanceAdmin,
// isTenantAdminOrPlatformStaff …), which are exactly the "one vocab per
// function" rosters the owner ruling in this file demands — an ad-hoc
// allowedRoles array at every call site is the vocabulary drift they exist to
// prevent.

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
/**
 * EXPORTED so that a surface needing a Set (rather than the predicate) DERIVES it
 * instead of restating it — see lib/vendors/vendor-scope.ts and
 * lib/auth/authorize-for-user.ts, which spread this and add their own explicit,
 * documented extras. Deriving keeps ONE definition; retyping the five is the
 * duplication the ruling forbids.
 */
export const TENANT_ADMIN_USER_TYPES = new Set([
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

// ─── BROKERAGE-WIDE MONEY — THE SAME ROSTER, ONE ROLE SHORTER ────────────────
//
// OWNER RULING, verbatim:
//
//   "Admin surfaces, but NOT brokerage-wide money. team_lead joins the roster for
//    operational admin gates (support, onboarding, assignment rules, roster,
//    marketing). Hold it OUT of the ~18 brokerage-wide financial gates —
//    financial-kernel, brokerage-fees, accounting-sync, income-engine, billing,
//    revenue-share, CDA storage, net-sheet overrides — which stay
//    broker/broker_owner/admin. Also add team_lead to is_brokerage_admin() so app
//    and DB agree on the non-money gates."
//
// ── WHY THIS IS DERIVED AND NOT RETYPED ──────────────────────────────────────
//
// The obvious way to write this is a second literal — `["admin","broker",
// "broker_owner"]` — and that is exactly the "more than one vocab over the same
// function" the earlier ruling forbids. Retyped, the two sets drift the first
// time a role is added to one of them: a new admin-class role would land in the
// tenant roster above and be silently ADMITTED to the brokerage's books here,
// because nobody would think to also subtract it.
//
// So the finance set is COMPUTED from TENANT_ADMIN_USER_TYPES by removing the
// one role the ruling removes. There is still ONE roster. This is the same
// roster asked a narrower question, and the subtraction is the whole of the
// difference — visible in one line instead of buried in a diff between two
// lists. Add a role above and it joins BOTH tiers unless it is named here too,
// which is the safe default for an operational role and a deliberate decision
// for a financial one.
export const BROKERAGE_FINANCE_ADMIN_USER_TYPES = new Set(
  [...TENANT_ADMIN_USER_TYPES].filter((t) => t !== "team_lead"),
)

/**
 * THE brokerage-wide money predicate. Pure and synchronous, like isAdminOrBroker.
 *
 * Mirrors public.is_brokerage_finance_admin() (m472), which governs the 49
 * FINANCE tables — commissions, splits, caps, fees, billing, invoices, payouts,
 * revenue share, accounting sync, P&L, CDA storage, net sheets, earnings — while
 * public.is_brokerage_admin() keeps the 64 operational ones and admits team_lead.
 *
 * ── THE DEFECT THIS EXISTS TO PREVENT ────────────────────────────────────────
 *
 * A gate that ADMITS in the app and REFUSES in RLS does not produce an error.
 * supabase-js RESOLVES a refused write: the statement matches zero rows, `error`
 * is null, and the surface reports SUCCESS over a change that never happened.
 * The moment team_lead joined isAdminOrBroker, every finance gate still spelled
 * `isAdminOrBroker` became exactly that defect — the app says yes, m472's RLS
 * says no. Repointing them here is what closes it.
 *
 * The inverse is worse and is the reason this is not simply "check RLS will
 * catch it": several of these gates write through the SERVICE client, which
 * bypasses RLS entirely. There the app predicate is the ONLY gate, and admitting
 * team_lead would not be a false success — it would be a real write to the
 * brokerage's books.
 *
 * broker_admin rides along from the roster above as an INPUT spelling only. It
 * is not a storable user_type (users_user_type_check admits fourteen values and
 * that is not one of them, and the constraint is VALIDATED), so it matches no
 * row on either side and cannot make the app wider than the database in
 * practice. It is not carried into any `.in("user_type", [...])` query.
 */
export function isBrokerageFinanceAdmin(profile: {
  user_type?: string | null
  role?: string | null // tolerated on input, intentionally unread — see the module header
}): boolean {
  return BROKERAGE_FINANCE_ADMIN_USER_TYPES.has(String(profile.user_type ?? "").toLowerCase())
}

/**
 * The same finance roster, asked of a `user_role_assignments.role` value.
 *
 * public.is_brokerage_finance_admin() carries the three-role list in BOTH
 * branches — user_type AND the grant — because m466 made a grant an
 * administering fact. A finance gate that honoured user_type but not the grant
 * would refuse the ruling's SECOND SEAT (the grant-only admin, live on this
 * database as agent1@yourbrokerage.com: user_type 'agent' holding an 'admin'
 * grant on their own brokerage) at exactly the tables m467 already taught the
 * database to let them READ.
 */
export function isBrokerageFinanceAdminGrantRole(role: string | null | undefined): boolean {
  return BROKERAGE_FINANCE_ADMIN_USER_TYPES.has(String(role ?? "").toLowerCase())
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

export type FinanceAdminResult =
  | { ok: true; isFinanceAdmin: boolean; via: "user_type" | "grant" | "none" }
  | { ok: false; error: string }

/**
 * The FULL brokerage-wide money rule: users.user_type OR a tenant role GRANT.
 *
 * The exact twin of resolveTenantAdmin, one role narrower, and it exists for the
 * same reason: public.is_brokerage_finance_admin() (m472) reads BOTH columns, so
 * an app gate reading only user_type is NARROWER than RLS and refuses the second
 * seat — the merely-annoying direction, but still a disagreement, and this whole
 * migration exists because the two answers drifted once already.
 *
 * A gate that guards a finance WRITE should prefer this over the pure predicate
 * when it has the ids to hand. The pure isBrokerageFinanceAdmin stays correct for
 * render paths and `.filter()` callbacks that cannot await.
 *
 * The tenant pin is not optional: a grant administering a DIFFERENT brokerage
 * authorises nothing, matching `ura.brokerage_id = current_user_brokerage_id()`
 * in the SQL. A NULL brokerage_id on either side is not a tenancy and can never
 * satisfy the pin — live, the `contact` and `lender` grants both carry NULL.
 *
 * Returns a RESULT, not a boolean: supabase-js resolves a refused query, so a
 * boolean would have to report "the grant read was denied" as "not an admin",
 * refusing a legitimate finance admin for the wrong reason, invisibly.
 *
 * @param userId the SESSION user's id — never an id from a request body.
 */
export async function resolveBrokerageFinanceAdmin(
  supabase: Parameters<typeof readRoleGrants>[0],
  userId: string,
  profile: { user_type?: string | null; brokerage_id?: string | null },
): Promise<FinanceAdminResult> {
  if (isBrokerageFinanceAdmin(profile)) return { ok: true, isFinanceAdmin: true, via: "user_type" }

  const brokerageId = profile.brokerage_id ?? null
  if (!brokerageId) return { ok: true, isFinanceAdmin: false, via: "none" }

  // NEVER .maybeSingle(): user_role_assignments is UNIQUE on (user_id, role),
  // not on user_id, and the account this exists to admit holds three grants.
  const res = await readRoleGrants(supabase, userId)
  if (!res.ok) return { ok: false, error: res.error }

  const pinned = res.grants.filter((g) => g.brokerage_id && g.brokerage_id === brokerageId)
  if (holdsAnyRole(pinned, [...BROKERAGE_FINANCE_ADMIN_USER_TYPES])) {
    return { ok: true, isFinanceAdmin: true, via: "grant" }
  }
  return { ok: true, isFinanceAdmin: false, via: "none" }
}
