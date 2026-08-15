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

/**
 * user_type values that mean "administers this brokerage".
 * Kept identical to public.is_brokerage_admin() — if that function changes, this
 * set is the thing to change with it.
 */
export const BROKERAGE_ADMIN_USER_TYPES = new Set(["admin", "broker", "broker_owner"])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type BrokerageAdminContext = {
  brokerageId: string
  userType: string
  /** NULL is a real answer, not a failure — see the fallback note below. */
  platformRole: string | null
}

/** BOTH identity columns. Neither alone answers the question. */
export function isPlatformSuperadmin(userType: string | null | undefined, platformRole: string | null | undefined): boolean {
  return userType === "superadmin" || platformRole === "superadmin"
}

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

    if (!BROKERAGE_ADMIN_USER_TYPES.has(userType) && !isPlatformSuperadmin(userType, platformRole)) {
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
