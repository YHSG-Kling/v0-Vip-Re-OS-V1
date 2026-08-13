"use server"

import { createClient } from "@/lib/supabase/server"
import { isPlatformStaffIdentity } from "@/lib/auth/resolve-user-role"
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
  /**
   * `users.team_id` — the TEAM tier of the connection ownership cascade
   * (agent → team → brokerage → platform), used by every scoped-credential
   * resolver: `lib/connections/resolve-scoped.ts:resolveScopedConnection` and
   * therefore `IDXBrokerClient.forBrokerage(brokerageId, { agentUserId, teamId })`.
   *
   * This row was ALREADY selected here and thrown away, so every caller that
   * needed the team tier either re-read `users` itself or silently skipped that
   * rung — which meant a team that connected its own IDX Broker account was
   * stepped over and the brokerage (or platform) feed answered instead. Exposing
   * it once is why three call sites could stop guessing (wave 17).
   *
   * NOT the same class as `agentId` (agents.id) or `userId` (users.id) — it is
   * teams.id, a third id space. Never substitute one for another.
   */
  teamId: string | null
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
  teamId: null,
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
        .select("id, brokerage_id, user_type, platform_role, team_id")
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
    const platformRole: string | null = (userData as any)?.platform_role ?? null
    if (isPlatformStaffIdentity(userType, platformRole)) {
      const imp = await resolveActiveImpersonation(user.id, platformRole ?? userType ?? "")
      if (imp) {
        return {
          userId: imp.userId,
          agentId: imp.agentId,
          brokerageId: imp.brokerageId,
          // The impersonation grant carries no team, and the STAFF actor's team
          // is not the impersonated tenant's — borrowing it would resolve a
          // credential from the wrong org. Null until the grant carries one.
          teamId: null,
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
      teamId: (userData?.team_id ?? null) as string | null,
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
