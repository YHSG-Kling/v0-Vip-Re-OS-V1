/**
 * Canonical role resolution helper — Kernel OS
 *
 * `user_type` is the single source of truth. The legacy `role` column is
 * being retired; new code MUST NOT read or write it. This helper accepts
 * the legacy field on the input shape only to absorb in-flight callers
 * — it is ignored.
 *
 * TOMBSTONE (§1.3, 2026-08-31, lane M4): types/user.ts (interface `UserRow`)
 * deleted — a documented "canonical users-row shape" that no file ever
 * imported. Every rule its doc-comment carried already lives at the enforcing
 * site: user_type-not-role is stated above and in lib/security/types.ts
 * (toCanonicalRole/toCanonicalRoleOrDefault); permission checks go through the
 * named predicates in THIS module, never string comparison. Live code selects
 * the users columns it reads rather than casting rows to a struct nothing
 * checked — a row type asserted by nobody was documentation wearing a type.
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
// m526 — the tier half of "who may read the books". readPlanTier (NOT
// resolvePlanTier) is the one that keeps the refusal visible; resolvePlanTier
// floors an unreadable tier to 'solo_agent', which is a GRANTING tier here and
// would make this gate fail OPEN. See resolveTenantPrincipalTeamLead's header.
import { readPlanTier, type PlanTier } from "@/lib/billing/plan-tier"

export type UserRole =
  | "agent"
  | "broker"
  | "broker_owner"
  | "admin"
  | "tc"
  | "vendor"
  | "isa"
  | "team_lead"
  | "compliance_officer"
  | "contact"
  | "system"
  | "superadmin"
  | "support"
  //
  // NOTE — this is a SECOND, SEPARATE `UserRole`. lib/security/types.ts exports
  // one too, and it is a DIFFERENT set: that one is the CANONICAL ROLE
  // vocabulary (what a user may BE after mapping), this one is the raw
  // users.user_type COLUMN vocabulary (what the row may literally store — hence
  // 'system' and 'support', which are not canonical roles).
  //
  // THE TWO DO NOT MOVE TOGETHER, AND THAT IS THE POINT. An earlier note here
  // said a value must be added to both "or not at all". That is exactly wrong in
  // the subtraction direction, and the tree already proves it: 'title_agent' is a
  // CANONICAL ROLE (lib/security/types.ts:23, with a full ROLE_PERMISSIONS entry)
  // and has NOT been a storable user_type since m307 — a title company is a
  // VENDOR (vendors.category='title'). scripts/role-vocabulary-guard.ts:66-72
  // states the same asymmetry from the other side.
  //
  // ── 'lender' and 'title_agent' REMOVED FROM THIS UNION ──────────────────────
  // OWNER RULING, 2026-09-04: "lender is not a user type, it is a vendor
  // category." The survivor for BOTH is the vendor record — vendors.category
  // carries 'lender' and 'title' in its live CHECK — and lender-ness is resolved
  // from it by lib/kernel/lender-linkage.ts (isLenderVendorCategory /
  // lenderVendorForUser) and gated by lib/kernel/portal-auth.ts
  // (requireLenderVendorActor / requireTitleActor). This union claims to be the
  // COLUMN's vocabulary, so carrying a value the CHECK refuses is not
  // conservative, it is a false statement a compiler will happily enforce:
  // `user_type === 'lender'` type-checks, matches zero rows, and reads as
  // "there is nobody in that role". 'title_agent' had been stale here since m307;
  // 'lender' goes with the migration in scripts/lender-is-not-a-user-type.sql.
  // Both remain CANONICAL ROLES in lib/security/types.ts — untouched.
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
// ── broker_admin: FROM "INPUT SPELLING" TO A REAL USER TYPE ──────────────────
//
// This roster has carried `broker_admin` for a long time as an INPUT SPELLING
// ONLY — accepted from a caller, canonicalizing to `broker`
// (lib/security/types.ts#LEGACY_ROLE_MAP), and never written, because
// users_user_type_check did not admit it. That is why m308/m441/m518 stripped it
// out of the RLS predicates: it matched nobody.
//
// OWNER RULING 2026-08-22 makes it a REAL user type — "a broker admin is a user
// type with differnt permission roles" — which is also what CLAUDE.md §4's tenant
// roster has said all along. supabase/migrations/m530 adds it to the CHECK and
// restores it to the five predicates that dropped it (WRITTEN, NOT APPLIED).
//
// NOTHING IN THIS FILE HAS TO CHANGE FOR THAT, and that is the point of it having
// been kept here: this roster judges a value a CALLER hands in, so it was already
// correct for a broker_admin who could not exist, and it is already correct for
// one who can. What DOES change is the caveat below.
//
// `super_admin` is still not storable and never will be — it is not in the
// fourteen (nor the fifteen), and it is a PLATFORM spelling in a TENANT roster.
//
// ── THE `.in("user_type", […])` CAVEAT, NARROWED ─────────────────────────────
//
// The old rule was blanket: a RECIPIENT lookup must not carry these, because they
// match nothing forever. That stays true for `super_admin`. For `broker_admin` it
// is true only UNTIL m530 is applied — and after it, a recipient lookup that
// OMITS broker_admin is the defect, because it will silently skip real rows. Any
// such query should be derived from TENANT_ADMIN_USER_TYPES rather than
// hand-typed, so it follows the roster instead of a snapshot of it.
// ── compliance_officer: THE SIXTH SEAT (owner ruling 2026-09-04) ─────────────
//
// OWNER RULING, verbatim:
//
//   "there is a compliance officer for tenant staff which was not included."
//
// The omission was the OUTLIER, not the rule, and three independent facts in
// this tree already said so before the ruling arrived:
//
//   · IT IS A STORABLE user_type. The live users_user_type_check admits fifteen
//     values and `compliance_officer` is one of them — read from the generated
//     cache, not asserted: scripts/check-vocabularies.ts, `users.user_type`.
//     Unlike `broker_admin` before m530, this roster entry matches real rows the
//     day it lands.
//   · THE REPO'S OWN AUTHORITY ORDERING ALREADY RANKS IT ABOVE A MEMBER.
//     lib/auth/role-grants.ts#ROLE_AUTHORITY_RANK reads
//     superadmin > broker_owner > broker > admin > compliance_officer >
//     team_lead > tc > agent … — so the one ordering this codebase has for
//     "several grants, one answer" placed the compliance officer ABOVE
//     `team_lead`, which has been in this roster all along.
//   · THE DATABASE ALREADY GAVE IT THE BOOKS-READ. m467's
//     public.can_read_brokerage_books() admits exactly
//     ('admin','broker','broker_owner','broker_admin','compliance_officer') in
//     BOTH branches, under the sentence "a compliance officer reads them and
//     does not administer". The half of that sentence this ruling changes is the
//     second half; the first half is why the finance-WRITE subtraction below
//     exists rather than a blanket widening.
//
// WHAT THIS COSTS, STATED PLAINLY: this is an AUTHORITY WIDENING over every
// gate that spreads this Set or calls isAdminOrBroker / isTenantAdminGrantRole /
// resolveTenantAdmin — the ~170 operational admin surfaces (support, onboarding,
// assignment rules, roster, marketing, settings, approvals). Each derived tier
// that must NOT widen names its own subtraction below or at its own site, and
// each such subtraction carries the ruling that justifies it. Nothing is held
// back silently.
//
// APP AND DATABASE AGREE — the SQL half is APPLIED, not merely written.
// Before it, public.is_brokerage_admin() (m530's step 2a) admitted five roles
// and not this one, leaving the app roster WIDER than the predicate: the
// false-success direction for RLS-bound callers (a refused SELECT resolves as
// zero rows) and a REAL widening for the gates that run on the SERVICE client.
// scripts/1109-a-compliance-officer-administers-the-brokerage.sql closed it,
// applied live to hrvaqgvukzxfskkcrwbt on 2026-09-04 by the integrator, with its
// own verification block passing against the applied definition. It widens
// is_brokerage_admin() ONLY, and deliberately not is_brokerage_finance_admin()
// nor is_lead_visible_role(), matching the two subtractions below — both of
// which were re-read from the LIVE function bodies rather than from a migration
// file, since a `.sql` in this tree is not evidence that anything ran (§3).
/**
 * EXPORTED so that a surface needing a Set (rather than the predicate) DERIVES it
 * instead of restating it — see lib/vendors/vendor-scope.ts, which spreads this
 * and adds its own explicit, documented extras. Deriving keeps ONE definition;
 * retyping the six is the duplication the ruling forbids. (lib/auth/
 * authorize-for-user.ts used to derive a set here too; that set was never
 * consulted and is deleted — see its tombstone.)
 */
export const TENANT_ADMIN_USER_TYPES = new Set([
  "admin",
  "broker",
  "broker_owner",
  "team_lead",
  // A REAL USER TYPE as of the owner's 2026-08-22 ruling; storable once m530 is
  // applied. Until then it is still only reachable as an input spelling — which
  // is why this entry did not have to move. See the section header above.
  "broker_admin",
  // Owner ruling 2026-09-04 — see the section header immediately above. A
  // STORABLE user_type today (the live CHECK lists it), so unlike broker_admin
  // this entry admits real rows from the moment it lands.
  "compliance_officer",
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
// roles the rulings remove. There is still ONE roster. This is the same roster
// asked a narrower question, and the subtraction is the whole of the difference
// — visible in one line instead of buried in a diff between two lists. Add a
// role above and it joins BOTH tiers unless it is named here too, which is the
// safe default for an operational role and a deliberate decision for a
// financial one.
//
// ── THE SECOND SUBTRACTION: compliance_officer (owner ruling 2026-09-04) ─────
//
// The 2026-09-04 ruling seats the compliance officer as tenant staff ADMIN. It
// does not hand them the brokerage's books, and the database has already drawn
// that exact line in the opposite direction, in writing:
//
//   m467 public.can_read_brokerage_books() admits compliance_officer, under the
//   comment "Reading the books is a wider circle than administering the
//   brokerage: a compliance officer reads them and does not administer."
//
//   m472/m530 public.is_brokerage_finance_admin() admits
//   ('admin','broker','broker_owner') — plus is_tenant_principal_team_lead() as
//   a third disjunct — and NOT compliance_officer.
//
//   MEASURED LIVE 2026-09-04 on hrvaqgvukzxfskkcrwbt, CORRECTING THIS LANE'S
//   OWN DRAFT, which had written `broker_admin` into that list. It is not there.
//   That is a PRE-EXISTING app/DB drift, and it is recorded here rather than
//   repaired in either direction on an integrator's judgement: the set BELOW
//   has admitted `broker_admin` to the brokerage's books since m530 made it a
//   storable user_type, while the SQL predicate still refuses it. So an
//   RLS-bound finance read by a broker admin comes back as zero rows with
//   `error` null, and a service-client finance write by one is real. Widening a
//   MONEY predicate is an owner ruling, not a tidy-up — UNRESOLVED, and now
//   written where the next reader is already looking instead of being restated
//   wrongly. It does not affect the compliance_officer subtraction below, which
//   the live definition confirms exactly.
//
// So the live database ALREADY gives this seat the finance READ and refuses it
// the finance WRITE. Letting the role ride along into this set would have made
// the APP admit a write that RLS refuses — and supabase-js RESOLVES a refused
// write, so the surface reports SUCCESS over a statement that touched zero rows.
// Worse, several of these gates write through the SERVICE client, which bypasses
// RLS entirely: there the app predicate is the ONLY gate and the write to the
// brokerage's books would be REAL. Holding the role out here is what keeps app
// and database saying the same thing, and it is the ruling read as written —
// "compliance officer for tenant staff", not "for the brokerage's money".
//
// NAMED, WITH THE RULING THAT NAMES EACH, rather than a bare `!== "team_lead"`:
// a subtraction whose reason is not written down is the one a later lane undoes.
export const ROLES_HELD_OUT_OF_BROKERAGE_MONEY: ReadonlySet<string> = new Set([
  // m472, owner verbatim: "Admin surfaces, but NOT brokerage-wide money."
  "team_lead",
  // Owner ruling 2026-09-04 + m467's own sentence: reads the books, does not
  // keep them. See the paragraph above.
  "compliance_officer",
])

export const BROKERAGE_FINANCE_ADMIN_USER_TYPES = new Set(
  [...TENANT_ADMIN_USER_TYPES].filter((t) => !ROLES_HELD_OUT_OF_BROKERAGE_MONEY.has(t)),
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
 * broker_admin rides along from the roster above. It was an INPUT spelling only
 * — not a storable user_type — so it matched no row on either side and could not
 * make the app wider than the database in practice.
 *
 * THAT SAFETY MARGIN ENDS WITH m530, WHICH IS WHY m530 CARRIES THE SQL HALF.
 * Once broker_admin is storable, this app-side set admits it while
 * public.is_brokerage_finance_admin() — live today as
 * ('admin','broker','broker_owner') — would still refuse. App wider than RLS is
 * the false-success direction: supabase-js RESOLVES a refused write, so the
 * surface would report success over a statement that touched zero rows, and
 * several of these gates run on the SERVICE client where the app predicate is
 * the ONLY gate and the write would be REAL. m530 step 2b adds broker_admin to
 * that function (and to is_brokerage_admin, is_lead_visible_role,
 * can_write_service_area, is_tenant_staff_seat) in the same migration that makes
 * the value storable. Applying the CHECK change without step 2 creates the gap.
 *
 * ── m526: `is_tenant_principal_team_lead` — THE SECOND, TIER-CONDITIONED HALF ─
 *
 * OWNER RULING: "yes to the team lead and agents", and — the sentence that makes
 * it conditional — "brokerages can have teams and agents but that is the
 * brokerage tier. when we have the team and solo agent subscription tiers, those
 * subscriptions get the same level of features as brokerages."
 *
 * On a TEAM- or SOLO-tier tenant the lead is that tenant's PRINCIPAL: its money
 * IS their team's money, and if they cannot keep the books nobody can, because
 * such a tenant seats no broker or broker_owner (m473 — a team is a mini
 * brokerage). On a BROKERAGE-tier tenant the same person is one of several leads
 * inside a larger office, and m472/m473 stand: their own team's money, never the
 * office's. So this is a FACT ABOUT ONE PERSON AND ONE TENANT, resolved against
 * the database, NOT a fourth role — `BROKERAGE_FINANCE_ADMIN_USER_TYPES` above
 * is unchanged, and `team_lead` is still not in it.
 *
 * IT IS A PARAMETER, NOT A LOOKUP, because this function is pure and sync and
 * ~40 render paths and `.filter()` callbacks depend on that. The fact is
 * resolved ONCE, asynchronously, by `resolveTenantPrincipalTeamLead` below (or
 * carried on `FinancialActorContext.isTenantPrincipal`) and handed in — the same
 * shape `isTenantAdminOrPlatformStaff` uses for `platform_role`.
 *
 * FAIL CLOSED (CLAUDE.md §4): ONLY an explicit `true` grants. `undefined` means
 * "nobody resolved this" and `null` means "resolved, and no" — both fall through
 * to the roster, so every one of the ~40 existing callers that passes neither
 * keeps byte-identical behaviour, and a caller that could not run the resolution
 * cannot accidentally widen anybody.
 */
export function isBrokerageFinanceAdmin(profile: {
  user_type?: string | null
  role?: string | null // tolerated on input, intentionally unread — see the module header
  /** m526 — the RESOLVED fact from `resolveTenantPrincipalTeamLead`. Only `true`
   *  grants; `undefined` (unresolved) and `null` (resolved-negative) do not. */
  is_tenant_principal?: boolean | null
}): boolean {
  if (profile.is_tenant_principal === true) return true
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

// ─── COMMITTING THE TENANT TO A CHARGE — THE SAME ROSTER, ONE ROLE SHORTER ───
//
// A THIRD tier, and the burden is on it to justify existing (§6). It does,
// because it is NOT either of the two above and the four sites that need it were
// already outside both:
//
//   · It is not BROKERAGE_FINANCE_ADMIN_USER_TYPES. All four sites below admit
//     `team_lead` today — a team lead may buy their team a seat and charge their
//     team's vendors — and the m472 ruling that holds team_lead out of the
//     brokerage's BOOKS never touched them. Repointing them at the finance tier
//     would REVOKE a live seat, which is not this lane's ruling to make.
//   · It is not TENANT_ADMIN_USER_TYPES either, and that is the whole point:
//     these four gates OBLIGATE THE BROKERAGE TO PAY SOMEBODY. Signing the
//     platform subscription agreement, buying a billed seat, charging a vendor,
//     and selling premium placement (which issues an invoice and marks it paid)
//     each create money owed. The 2026-09-04 ruling seats a compliance officer
//     as tenant staff admin; it does not give them the tenant's chequebook, and
//     m467 already says in so many words that this seat "reads [the books] and
//     does not administer" them.
//
// DERIVED, so there is still ONE roster and adding a seventh role tomorrow lands
// it in BOTH tiers unless someone names it here on purpose.
export const TENANT_COMMERCE_ADMIN_USER_TYPES: ReadonlySet<string> = new Set(
  [...TENANT_ADMIN_USER_TYPES].filter((t) => t !== "compliance_officer"),
)

/**
 * "May this seat obligate the brokerage to pay somebody?" — the predicate over
 * {@link TENANT_COMMERCE_ADMIN_USER_TYPES}.
 *
 * Pure, sync and fail-closed on an absent value, exactly like its two siblings:
 * a seat whose role could not be resolved is never graded as a granted one (§4).
 * Case-folded for the same reason isAdminOrBroker is — callers pass legacy
 * free-form `users.role` values, which MEASURED live hold 'Admin' and 'Lender'.
 */
export function isTenantCommerceAdmin(profile: {
  user_type?: string | null
  role?: string | null // tolerated on input, intentionally unread — see the module header
}): boolean {
  return TENANT_COMMERCE_ADMIN_USER_TYPES.has(String(profile.user_type ?? "").toLowerCase())
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
  // `tenant_principal` (m526) — admitted not by a role but by BEING the principal
  // of a team-scale tenant. Reported distinctly because it is the one branch whose
  // answer depends on the SUBSCRIPTION, so a surface debugging "why can this
  // person see the books" is told the real reason.
  | { ok: true; isFinanceAdmin: boolean; via: "user_type" | "grant" | "tenant_principal" | "none" }
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

  // m526 — the THIRD disjunct, matching public.is_brokerage_finance_admin()'s
  // third disjunct exactly. Asked LAST because it is the only branch that costs
  // two more queries, and the two above already answer for every broker/admin.
  const principal = await resolveTenantPrincipalTeamLead(supabase, userId, brokerageId)
  if (!principal.ok) return { ok: false, error: principal.reason }
  if (principal.isPrincipal) return { ok: true, isFinanceAdmin: true, via: "tenant_principal" }

  return { ok: true, isFinanceAdmin: false, via: "none" }
}

export type TenantPrincipalResult =
  | { ok: true; isPrincipal: boolean; tier: PlanTier | null; teamId: string | null }
  | { ok: false; reason: string }

/**
 * THE APP-SIDE TWIN OF public.is_tenant_principal_team_lead() (m526).
 *
 * "Is this person the PRINCIPAL of this tenant — the lead of the one team of a
 * TEAM- or SOLO-tier subscription, whose money IS the tenant's money?"
 *
 * ── WHY THE APP HALF IS NOT OPTIONAL (finding #202, the shape that bit) ──────
 *
 * #202 was an RLS defect whose APP-SIDE TWIN was left stale, and the same trap
 * is live here in its worse direction: `lib/kernel/financial.ts` runs its eight
 * money gates on the SERVICE client, which BYPASSES RLS ENTIRELY. Fixing only
 * the SQL would leave the team-tier principal admitted by the database and
 * refused by the kernel — the ruling delivered nowhere the user can see it. So
 * this ships in the same wave, and it is written to give the SAME ANSWER as the
 * SQL for the same inputs.
 *
 * ── THE ONE PLACE THE TWO COULD HAVE DRIFTED, AND HOW IT IS CLOSED ──────────
 *
 * `resolvePlanTier` FLOORS an unreadable or unset tier to 'solo_agent' — the
 * right fail-safe for a lead ROUTER (a solo tenant's leads all go to one person,
 * never a leak) and the exactly WRONG one here, because 'solo_agent' is a
 * GRANTING tier under this rule. A twin built on it would fail OPEN while the
 * SQL fails CLOSED, and CLAUDE.md §4 forbids "nobody checked" rendering as
 * "checked and fine".
 *
 * So this consumes `readPlanTier` — the same read with the refusal still visible
 * (§3: supabase-js RESOLVES refusals) — and demands `fromCache: true`, i.e. the
 * value came from the `plan_tier` COLUMN. That is precisely what
 * `b.plan_tier in ('team','solo_agent')` expresses in SQL, where a NULL yields
 * NULL and coalesces to false. Same inputs, same answer, on both sides.
 *
 * ── FAIL CLOSED, BRANCH BY BRANCH ───────────────────────────────────────────
 *
 *   teams read refused      → { ok: false } — the caller REFUSES, never passes.
 *   plan_tier read refused  → { ok: false } — same.
 *   tier not from the column→ isPrincipal false (an inferred tier grants nothing).
 *   tier is brokerage /
 *     multi_location        → isPrincipal false. m472/m473 stand.
 *   more than one live team → isPrincipal false. The ruling's premise ("the
 *                             team's money is the tenant's money") does not hold,
 *                             most plausibly a downgraded brokerage; refusing is
 *                             the safe reading. Mirrors the SQL's count = 1.
 *   leads no team           → isPrincipal false.
 *
 * ── THE ANCHOR IS `teams.team_lead_id`, NOT `users.user_type` (m473) ────────
 *
 * Live: buyer@yourbrokerage.com is user_type 'team_lead' and leads NO team;
 * teamlead@vip.demo is user_type 'agent' and leads the only one. A user_type
 * check would admit the first and refuse the second — wrong in both directions.
 * `team_lead_id` is a `users.id`, so this compares userId to userId; it never
 * touches `agents.id`, which is a DISJOINT id space (CLAUDE.md §3, 23503).
 *
 * The tenant pin is not optional and mirrors the SQL's
 * `t.brokerage_id = current_user_brokerage_id()`: leading a team in some OTHER
 * brokerage authorises nothing here.
 *
 * @param userId      the SESSION user's id — never an id from a request body.
 * @param brokerageId the SESSION's brokerage — never one from a request body (§4).
 */
export async function resolveTenantPrincipalTeamLead(
  supabase: Parameters<typeof readRoleGrants>[0],
  userId: string,
  brokerageId: string | null | undefined,
): Promise<TenantPrincipalResult> {
  if (!userId || !brokerageId) {
    // No identity or no tenancy is not a refusal to read — it is a definite "no".
    return { ok: true, isPrincipal: false, tier: null, teamId: null }
  }

  // Every LIVE team of this tenant, in one read: it answers both "does this
  // person lead one" and "is there exactly one", which is what the SQL's
  // `count(*) = 1` needs. `deleted_at is null` matches current_user_led_team_id().
  const { data: teams, error: teamsError } = await supabase
    .from("teams")
    .select("id, team_lead_id")
    .eq("brokerage_id", brokerageId)
    .is("deleted_at", null)

  // §3 — supabase-js RESOLVES a refused query. Reading that as "this tenant has
  // no teams" would refuse the principal for the wrong reason, invisibly; and a
  // gate that cannot run must REFUSE, not pass (§4).
  if (teamsError) {
    return { ok: false, reason: "Your team could not be read — finance access is held until it can." }
  }

  const live = (teams ?? []) as Array<{ id: string; team_lead_id: string | null }>
  if (live.length !== 1) return { ok: true, isPrincipal: false, tier: null, teamId: null }
  if (live[0].team_lead_id !== userId) return { ok: true, isPrincipal: false, tier: null, teamId: null }

  const read = await readPlanTier(supabase as unknown as { from: (t: string) => any }, brokerageId)
  if (!read.ok) return { ok: false, reason: read.reason }

  // `fromCache` is the whole guard — see the header. An inferred or floored tier
  // is not a stored tier, and only a stored team-scale tier grants.
  const isPrincipal = read.fromCache && (read.tier === "team" || read.tier === "solo_agent")
  return { ok: true, isPrincipal, tier: read.tier, teamId: isPrincipal ? live[0].id : null }
}
