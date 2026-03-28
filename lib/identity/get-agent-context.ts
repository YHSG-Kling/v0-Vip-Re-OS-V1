"use server"

import { createClient } from "@/lib/supabase/server"

export interface AgentContext {
  userId: string
  agentId: string | null
  brokerageId: string | null
  /** Source priority: users.user_type > user_role_assignments.role > auth metadata > 'agent' */
  userType: string
  /** Alias for userType — backward compat for all callers that reference .role */
  role: string
  isAuthenticated: boolean
}

/** Safe default returned when the user is not authenticated. Never throws. */
const UNAUTHENTICATED_CONTEXT: AgentContext = {
  userId: "",
  agentId: null,
  brokerageId: null,
  userType: "agent",
  role: "agent",
  isAuthenticated: false,
}

/**
 * Resolves authenticated user to a fully typed AgentContext.
 * Works for all user types (agent, broker, admin, tc, compliance_officer, vendor, etc.)
 * NEVER throws — returns safe defaults on any failure including unauthenticated.
 * Source priority: users.user_type > user_role_assignments.role > auth metadata > 'agent'
 */
export async function getAgentContext(): Promise<AgentContext> {
  try {
    const supabase = await createClient()

    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return UNAUTHENTICATED_CONTEXT
    }

    // Fetch users row + role assignments in parallel.
    // Both use maybeSingle() / array — never throw on missing rows.
    const [{ data: userData }, { data: rolesData }] = await Promise.all([
      supabase
        .from("users")
        .select("id, brokerage_id, user_type, team_id")
        .eq("id", user.id)
        .maybeSingle(),
      supabase
        .from("user_role_assignments")
        .select("brokerage_id, role, agent_id")
        .eq("user_id", user.id)
        .limit(1),
    ])

    const firstRole = rolesData?.[0]

    // Source priority: users.user_type > role_assignments.role > auth metadata > 'agent'
    const userType: string =
      userData?.user_type ??
      firstRole?.role ??
      (user.user_metadata?.user_type as string | undefined) ??
      "agent"

    // brokerageId: users table > role assignments > auth metadata > null
    const brokerageId: string | null =
      userData?.brokerage_id ??
      firstRole?.brokerage_id ??
      (user.user_metadata?.brokerage_id as string | undefined) ??
      null

    // agentId: role assignments > agents table lookup (only for agent-type users)
    let agentId: string | null = firstRole?.agent_id ?? null
    if (!agentId && userType === "agent") {
      const { data: agentRow } = await supabase
        .from("agents")
        .select("id")
        .eq("user_id", user.id)
        .maybeSingle()
      agentId = agentRow?.id ?? null
    }

    return {
      userId: user.id,
      agentId,
      brokerageId,
      userType,
      role: userType, // alias — same value, different key name
      isAuthenticated: true,
    }
  } catch {
    // Never propagate — return safe defaults so callers don't need try/catch
    return UNAUTHENTICATED_CONTEXT
  }
}
