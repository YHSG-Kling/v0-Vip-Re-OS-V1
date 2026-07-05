"use server"

import { createClient } from "@/lib/supabase/server"
import { isPlatformStaff } from "@/lib/auth/resolve-user-role"
import { resolveActiveImpersonation } from "@/lib/platform/impersonation"

export interface AgentContext {
  userId: string
  /**
   * agents.id — the row PK in the agents table.
   * contacts.agent_id → agents.id (FK corrected in migration 114).
   * Use agentId for all contacts, transactions, listings, showings, offers, tasks, etc.
   */
  agentId: string | null
  brokerageId: string | null
  /** Source priority: users.user_type > user_role_assignments.role > auth metadata > 'agent' */
  userType: string
  /** Alias for userType — backward compat for all callers that reference .role */
  role: string
  isAuthenticated: boolean
  /** True when a platform-staff member is acting AS this tenant (GHL "act as"). */
  isImpersonating?: boolean
  /** The REAL staff actor behind an impersonated context — always set when impersonating. */
  impersonatorUserId?: string | null
  /** 'read_only' | 'full' — the impersonation grant, for write-gating. */
  impersonationMode?: string | null
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

    // ── ACT-AS seam ──────────────────────────────────────────────────────────
    // If this authenticated user is platform staff AND holds an active impersonation
    // session, resolve the TARGET tenant's workspace context instead — while keeping
    // the real staff id as impersonatorUserId so every downstream write stays
    // attributable. Non-staff / expired sessions are ignored (defence in depth).
    if (isPlatformStaff(userType)) {
      const imp = await resolveActiveImpersonation(user.id, userType)
      if (imp) {
        return {
          userId: imp.userId,
          agentId: imp.agentId,
          brokerageId: imp.brokerageId,
          userType: imp.userType,
          role: imp.userType,
          isAuthenticated: true,
          isImpersonating: true,
          impersonatorUserId: imp.impersonatorUserId,
          impersonationMode: imp.mode,
        }
      }
    }

    return {
      userId: user.id,
      agentId,
      brokerageId,
      userType,
      role: userType, // alias — same value, different key name
      isAuthenticated: true,
      isImpersonating: false,
      impersonatorUserId: null,
      impersonationMode: null,
    }
  } catch {
    // Never propagate — return safe defaults so callers don't need try/catch
    return UNAUTHENTICATED_CONTEXT
  }
}
