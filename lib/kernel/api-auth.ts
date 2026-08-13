/**
 * lib/kernel/api-auth.ts
 *
 * Shared authentication guard for all API routes.
 *
 * INVARIANTS:
 *  - Never trusts agent_id or brokerage_id from request body or query params.
 *  - Always resolves brokerage_id from users table via server-side session.
 *  - Always resolves agentId from agents table (agents.id ≠ users.id).
 *  - Returns a typed AuthResult on success or a ready-to-return 401/403 NextResponse.
 */

import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { isPlatformStaffIdentity } from "@/lib/auth/resolve-user-role"
import { NextResponse } from "next/server"
import type { SupabaseClient, User } from "@supabase/supabase-js"

export interface AuthResult {
  ok: true
  user: User
  userId: string
  agentId: string | null  // agents.id — contacts.agent_id → agents.id (FK corrected migration 114)
  brokerageId: string
  userType: string
  /**
   * `users.platform_role` — the OTHER half of staff identity, and the half this
   * shape was missing. Staff identity is dual-column and the columns hold
   * different vocabularies: 'marketing' is a legal platform_role and is NOT a
   * legal user_type (users_user_type_check admits fifteen values, not that one),
   * while the live superadmin on this database is (user_type='admin',
   * platform_role='superadmin'). Callers that had only `userType` were therefore
   * judging staff against a column that could not hold the answer — see
   * isPlatformStaffIdentity in lib/auth/resolve-user-role.ts. Null for every
   * tenant user.
   */
  platformRole: string | null
}

export interface AuthFailure {
  ok: false
  response: NextResponse
}

/**
 * Standard auth guard for all API routes.
 *
 * Usage:
 *   const supabase = await createClient()
 *   const auth = await requireAuth(supabase)
 *   if (!auth.ok) return auth.response
 *   const { userId, agentId, brokerageId } = auth
 */
export async function requireAuth(
  supabase: SupabaseClient
): Promise<AuthResult | AuthFailure> {
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()

  if (error || !user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    }
  }

  // Resolve brokerage_id, user_type AND platform_role from the users table — never
  // from request body/params. platform_role is read here because staff identity is
  // dual-column; without it, every caller downstream had to guess staff-ness from
  // user_type alone, which cannot represent 'marketing' at all.
  const { data: userData } = await supabase
    .from("users")
    .select("brokerage_id, user_type, platform_role")
    .eq("id", user.id)
    .maybeSingle()

  if (!userData?.brokerage_id) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Brokerage not configured for this user" },
        { status: 403 }
      ),
    }
  }

  // Resolve agentId from agents table (agents.id ≠ users.id — critical distinction)
  const agentId = await resolveAgentId(supabase, user.id)

  return {
    ok: true,
    user,
    userId: user.id,
    agentId,
    brokerageId: userData.brokerage_id,
    userType: userData.user_type ?? "agent",
    platformRole: (userData as { platform_role?: string | null }).platform_role ?? null,
  }
}

/**
 * Superadmin-only auth guard — deliberately NOT the four-role staff roster. It
 * guards billing, entitlements and subscription routes; those stay with the one
 * role that owns platform configuration.
 *
 * BOTH COLUMNS, for the same reason as everywhere else in this file. It checked
 * `auth.userType !== "superadmin"` alone, and the platform's ONLY superadmin on this
 * database is (user_type='admin', platform_role='superadmin') — so every route behind
 * this guard was refusing the person it exists to admit. Adding the platform_role
 * marker only admits the genuine superadmin; it widens to nobody else, because
 * 'superadmin' in platform_role is written solely by the superadmin-gated staff CRUD.
 * This is exactly the shape public.is_platform_admin() uses in RLS.
 */
export async function requireSuperadminAuth(
  supabase: SupabaseClient
): Promise<AuthResult | AuthFailure> {
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth

  if (auth.userType !== "superadmin" && auth.platformRole !== "superadmin") {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Superadmin access required" },
        { status: 403 }
      ),
    }
  }
  return auth
}

/**
 * Platform-staff auth guard — the four roles the owner named (superadmin, admin,
 * marketing, support). Use for platform governance surfaces (vendor-spend ledger,
 * raw-lead ingestion, observability) that brokerage users must never see.
 *
 * THIS WAS A FOURTH HAND-ROLLED ROSTER AND IT WAS WRONG IN BOTH DIRECTIONS. It read
 * `auth.userType !== "superadmin" && auth.userType !== "support"` — a roster of
 * platform_role values tested against user_type. Consequences, measured live rather
 * than reasoned about:
 *
 *   • It ADMITTED any tenant user whose user_type happens to be 'support'. That is
 *     a legal tenant user_type, unconnected to platform employment.
 *   • It REFUSED the platform's only superadmin, whose row is
 *     (user_type='admin', platform_role='superadmin').
 *   • It could never admit a `marketing` staffer, because 'marketing' is not a legal
 *     user_type — users_user_type_check does not list it.
 *
 * It now delegates to the one identity gate, which reads both columns.
 */
export async function requirePlatformStaffAuth(
  supabase: SupabaseClient
): Promise<AuthResult | AuthFailure> {
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth

  if (!isPlatformStaffIdentity(auth.userType, auth.platformRole)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Platform staff access required" },
        { status: 403 }
      ),
    }
  }
  return auth
}

/**
 * Broker/Admin auth guard.
 * Allows broker, admin, and superadmin roles.
 */
export async function requireBrokerAuth(
  supabase: SupabaseClient
): Promise<AuthResult | AuthFailure> {
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth

  if (!["broker", "admin", "superadmin"].includes(auth.userType)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Broker or admin access required" },
        { status: 403 }
      ),
    }
  }
  return auth
}
