/**
 * lib/auth/require-brokerage-admin.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE "is this caller a brokerage admin, and of which tenant?" GATE.
 *
 * W47 found THREE independent copies of this function, all named
 * requireBrokerAdmin, all carrying the same two defects, and only one of them
 * fixed when the defect was found:
 *
 *   lib/kernel/global-settings.ts          gates the tenant's settings row
 *   lib/kernel/notification-rules.ts       gates notification-rule CRUD
 *   app/actions/settings/provider-settings-actions.ts  gates provider credentials
 *
 * That is the shape this workstream keeps paying for: an authorization rule
 * copied three times, corrected once, and silently divergent thereafter. The
 * copies were NOT identical, so this survivor is a MERGE, not a pick — every
 * capability below came off one of the three and none was dropped.
 *
 * ── THE TWO DEFECTS, FIXED HERE ONCE ────────────────────────────────────────
 *
 * (1) `broker_owner` WAS OMITTED. All three tested
 *     user_type ∈ {admin, broker, superadmin}. The database's
 *     public.is_brokerage_admin() admits {admin, broker, broker_owner}, and
 *     m457 gates global_settings writes on exactly that. So the OWNER of a
 *     brokerage was permitted by RLS and refused by app code — and because
 *     get-global-settings.ts swallows the refusal into DEFAULT_GLOBAL_SETTINGS,
 *     they were shown the PRODUCT's name as though it were their own brokerage's
 *     configured settings. The database was correctly broader than the app.
 *
 * (2) THE `superadmin` BRANCH WAS DEAD CODE. MEASURED on the live database:
 *     ZERO rows have user_type='superadmin'. The platform's only superadmin
 *     carries user_type='admin' WITH platform_role='superadmin'. A test on
 *     user_type alone can never fire for the account it exists to admit. "Is
 *     superadmin" is answerable only from BOTH columns — the same shape
 *     public.is_platform_admin() uses in RLS. Canonical explanation:
 *     app/actions/vendor-budget.ts:136-147.
 *
 * ── WHAT THIS GATE DELIBERATELY IS NOT ──────────────────────────────────────
 *
 * It is NOT the four-role platform-staff roster
 * (`lib/auth/resolve-user-role.ts:isPlatformStaffIdentity` — superadmin, admin,
 * marketing, support). Using that here would admit a platform_role='marketing'
 * account whose user_type is 'system', which is_brokerage_admin() does NOT
 * permit — pushing the app gate PAST the database. An app gate mirrors RLS or
 * sits inside it; it never exceeds it.
 *
 * ── THE CLIENT IS INJECTED, AND THAT MATTERS ────────────────────────────────
 *
 * Two callers pass a SERVICE client (bypassing RLS, because they then read rows
 * the caller cannot see directly) and one passes the SESSION client (so RLS
 * still applies underneath). Both are legitimate; hard-coding either would have
 * silently changed one caller's security posture, which is why this takes the
 * client rather than creating one.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
// The platform/OS discriminator is defined ONCE. That module is pure (it imports
// nothing), so this stays free of a server-only leak.
import { isPlatformSuperadminIdentity } from "@/lib/platform/platform-staff-roster"
// The tenant-admin roster is defined ONCE, by the module the owner's ruling
// names (see the tombstone below). resolve-user-role.ts is a pure helper (its
// only value import is the pure platform roster; role-grants and plan-tier are
// type-only), and it is already imported by four "use client" components, so
// the two client consumers of this file are not newly exposed to server code.
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"

// ═══════════════════════════════════════════════════════════════════════════
// TOMBSTONE — `BROKERAGE_ADMIN_USER_TYPES = new Set(["admin", "broker", "broker_owner"])`
// ═══════════════════════════════════════════════════════════════════════════
// DELETED as a LITERAL (§6, 2026-09-03, lane H4). The comment above it claimed
// "kept identical to public.is_brokerage_admin()". It was not. MEASURED on
// hrvaqgvukzxfskkcrwbt the same day — pg_get_functiondef('public.is_brokerage_admin'):
//
//     user_type in ('admin','broker','broker_admin','broker_owner','team_lead')
//     … ura.role in ('admin','broker','broker_admin','broker_owner','team_lead')
//
// FIVE roles on both branches (m530 applied), and the literal here held THREE.
// So this gate was NARROWER than the policy it claims to mirror, in the
// direction the header of lib/auth/resolve-user-role.ts calls "merely annoying"
// for RLS-bound callers — and NOT merely annoying for the two callers that hand
// this gate a SERVICE client (lib/kernel/notification-rules.ts:41,
// app/actions/settings/provider-settings-actions.ts:54): there the app gate is
// the ONLY gate, so a team_lead or broker_admin was refused outright at
// surfaces the owner's ruling admits them to ("team_lead joins the roster for
// operational admin gates … also add team_lead to is_brokerage_admin() so app
// and DB agree on the non-money gates").
//
// ── THE SURVIVOR, AT file:line ─────────────────────────────────────────────
//     lib/auth/resolve-user-role.ts:220  TENANT_ADMIN_USER_TYPES
// {admin, broker, broker_owner, team_lead, broker_admin} — the exact five the
// live function admits. The name below is kept as an ALIAS so the five import
// sites (scripts/brokerage-admin-grant-simulator.ts:39, app/actions/support.ts:39,
// app/crm/contacts/[contactId]/alerts/page.tsx:40,
// app/dashboard/team/create-team-dialog.tsx:11, and this file) keep compiling;
// it is the same Set object, not a second roster. Repoint them to the survivor
// and delete the alias when their lanes are open.
//
// BEHAVIOUR CHANGE, stated: requireBrokerageAdmin (and the three consumers
// that test this Set directly) now ADMIT `team_lead` and `broker_admin`, by
// user_type and by tenant role grant. That is the database's answer today;
// the app had lagged it since m530 was applied.
//
// This is NOT the finance roster: brokerage-wide money stays on
// BROKERAGE_FINANCE_ADMIN_USER_TYPES / isBrokerageFinanceAdmin (team_lead
// held out), and no caller of this file gates money — createTeam
// (app/actions/multi-persona.ts:786), notification rules, provider credentials,
// territory settings, support-queue admin, team creation, alert admin are all
// operational gates in the ruling's sense.
/** user_type values that mean "administers this brokerage" — the ONE roster. */
export const BROKERAGE_ADMIN_USER_TYPES = TENANT_ADMIN_USER_TYPES

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type BrokerageAdminContext = {
  brokerageId: string
  userType: string
  /** NULL is a real answer, not a failure — see the fallback note below. */
  platformRole: string | null
}

// ═══════════════════════════════════════════════════════════════════════════
// TOMBSTONE — isPlatformSuperadmin(userType, platformRole)
// ═══════════════════════════════════════════════════════════════════════════
// DELETED (owner ruling 1, 2026-08-24). Its body was
//     return userType === "superadmin" || platformRole === "superadmin"
// which is the SAME sentence lib/auth/platform-guard.ts:requireSuperadmin,
// lib/kernel/api-auth.ts:requireSuperadminAuth and lib/kernel/global-settings.ts
// each wrote out independently — four spellings of the single most consequential
// predicate in the product, since the owner's ruling is that this identity "has
// total control over the complete os system".
//
// ── THE SURVIVOR, AT file:line ─────────────────────────────────────────────
//     lib/platform/platform-staff-roster.ts:isPlatformSuperadminIdentity
// It is the same both-columns rule, in the module that already owns the platform
// roster, and it carries the one thing every local copy lacked: an EXPLICIT
// refusal of `ai_isa_system`, the platform_role that marks the two automated ISA
// service accounts. That role is not a human superadmin and must never inherit
// total control; refusing it by name (rather than by accident of `!== 'superadmin'`)
// is what makes the refusal mutation-testable.
//
// Nothing was lost in the merge: this copy carried no capability the survivor
// lacks. The one live caller below now imports it.

/**
 * Resolve the caller's tenant and assert they may administer it.
 * THROWS on refusal — callers translate that into their own surface's language.
 *
 * @param supabase an injected client; see the note above on service vs session.
 * @param userId   the SESSION user's id. Never a caller-supplied id from a
 *                 request body — resolve identity first, then authorise it.
 */
export async function requireBrokerageAdmin(
  supabase: SupabaseClient<any, any, any>,
  userId: string,
): Promise<BrokerageAdminContext> {
  // Came from notification-rules.ts, which was the only copy that validated the
  // input. A malformed id otherwise reaches PostgREST as a 22P02 and surfaces as
  // a generic failure rather than "invalid user id".
  if (!userId || typeof userId !== "string" || !UUID_RE.test(userId)) {
    throw new Error("Invalid user ID")
  }

  const { data: user, error } = await supabase
    .from("users")
    .select("brokerage_id, user_type, platform_role")
    .eq("id", userId)
    .maybeSingle()

  // supabase-js RESOLVES a failed query, so an unchecked read reports a
  // permission denial as "user not found" and this gate would refuse a
  // legitimate admin for the wrong reason. Say which it was.
  if (error) throw new Error(`Could not resolve the caller's brokerage: ${error.message}`)

  if (user?.brokerage_id) {
    const userType = String((user as { user_type?: string | null }).user_type ?? "admin")
    const platformRole = (user as { platform_role?: string | null }).platform_role ?? null

    if (!BROKERAGE_ADMIN_USER_TYPES.has(userType) && !isPlatformSuperadminIdentity(userType, platformRole)) {
      throw new Error("Forbidden: insufficient permissions")
    }
    return { brokerageId: user.brokerage_id as string, userType, platformRole }
  }

  // FALLBACK — came from notification-rules.ts and provider-settings-actions.ts;
  // global-settings.ts had no fallback and would refuse a user whose tenancy is
  // recorded only as a role GRANT. Merged forward rather than dropped.
  //
  // user_role_assignments carries NO platform_role: it is a TENANT role grant by
  // construction, so platformRole is null on this path and a caller reaching the
  // platform answer through it is, correctly, not platform staff.
  //
  // ── ONE USER CAN HOLD SEVERAL GRANTS, AND .maybeSingle() CANNOT ────────────
  //
  // Both source copies read this with `.maybeSingle()`, and I merged that
  // forward in W47 without checking whether it could hold. It cannot. The live
  // table has a UNIQUE on (user_id, role) — not on user_id — so a user may hold
  // MANY grants, and MEASURED on the live database one already holds three
  // (agent + admin + isa) and another holds two.
  //
  // `.maybeSingle()` over more than one row is an ERROR, not a pick. So this
  // path threw for exactly the users it exists to admit — and my own error
  // check, added in the same change, is what turned a silent null into a hard
  // refusal. Reading all the grants and CHOOSING is the only correct shape.
  const { data: roleAssignments, error: roleError } = await supabase
    .from("user_role_assignments")
    .select("brokerage_id, role")
    .eq("user_id", userId)

  if (roleError) throw new Error(`Could not resolve the caller's role assignments: ${roleError.message}`)

  const grants = (roleAssignments ?? []) as Array<{ brokerage_id?: string | null; role?: string | null }>

  // A grant with a NULL brokerage_id is not a tenant grant — `contact` and
  // `lender` rows carry no brokerage and must never be used as a tenant anchor.
  // Among the tenanted ones, the ADMINISTERING grant is the one that answers
  // this question; holding `agent` beside `admin` must not decide it.
  const adminGrant = grants.find(
    (g) => g.brokerage_id && BROKERAGE_ADMIN_USER_TYPES.has(String(g.role ?? "")),
  )
  if (adminGrant?.brokerage_id) {
    return { brokerageId: adminGrant.brokerage_id, userType: String(adminGrant.role), platformRole: null }
  }

  // Tenanted, but no grant that administers. Distinguish this from "no record at
  // all": one is a refusal, the other is a missing identity, and reporting them
  // identically is how a permissions bug reads as a data bug.
  if (grants.some((g) => g.brokerage_id)) {
    throw new Error("Forbidden: insufficient permissions")
  }

  throw new Error("User not found or not associated with a brokerage")
}
