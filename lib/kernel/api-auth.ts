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
import { NextResponse } from "next/server"
import type { SupabaseClient, User } from "@supabase/supabase-js"

export interface AuthResult {
  ok: true
  user: User
  userId: string
  agentId: string | null  // agents.id — contacts.agent_id → agents.id (FK corrected migration 114)
  brokerageId: string
  userType: string
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

  // Resolve brokerage_id and user_type from the users table — never from request body/params
  const { data: userData } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
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
  }
}

/**
 * Superadmin-only auth guard.
 * Checks users.user_type = 'superadmin' from the database — never from headers.
 */
export async function requireSuperadminAuth(
  supabase: SupabaseClient
): Promise<AuthResult | AuthFailure> {
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth

  if (auth.userType !== "superadmin") {
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
