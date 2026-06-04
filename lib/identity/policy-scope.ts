/**
 * lib/identity/policy-scope.ts
 *
 * Wave 32 — single source of truth for "which policy-scope tabs can THIS
 * user see?" Used by both the lifecycle-promo Settings page and the
 * blog-cadence Settings page to decide whether to render the Team and
 * Brokerage tabs.
 *
 * Wave 33 — user_role_assignments is deprecated. We resolve role
 * exclusively from users.user_type. Live values in production:
 *   agent | contact | admin | system | lender | vendor | broker |
 *   compliance_officer | tc
 *
 * Resolution rules:
 *   · Every authenticated user can see the AGENT tab (their own override)
 *   · user_type ∈ {broker, admin, compliance_officer} → BROKERAGE tab
 *     visible AND can pick any TEAM in the brokerage for the team tab
 *   · agents.id matches teams.team_lead_id on some row → TEAM tab
 *     visible (their own team only)
 *
 * Returns the resolved scopeIds so the calling server action can write
 * to the right (scope_type, scope_id) without re-resolving role.
 */
import "server-only"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { createServiceClient } from "@/lib/supabase/service"

export type PolicyScopeTier = "agent" | "team" | "brokerage"

export interface PolicyScopeAccess {
  canEditAgent:     boolean
  canEditTeam:      boolean
  canEditBrokerage: boolean
  /** agents.id of the caller (when canEditAgent). */
  agentScopeId:     string | null
  /** teams.id the caller can edit at team tier. Solo agents get null;
   *  team leads get their team_id; brokerage admins get a list of all
   *  teams in the brokerage (the UI picks one). */
  teamScopeIds:     string[]
  /** brokerages.id when canEditBrokerage. */
  brokerageScopeId: string | null
  /** Effective scope: "broker_admin" | "team_lead" | "solo_agent" */
  effectiveRole:    "broker_admin" | "team_lead" | "solo_agent"
}

const BROKER_ROLES = new Set(["broker", "admin", "compliance_officer", "owner"])

export async function resolvePolicyScopeAccess(): Promise<PolicyScopeAccess> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId || !ctx.userId) {
    return {
      canEditAgent: false, canEditTeam: false, canEditBrokerage: false,
      agentScopeId: null, teamScopeIds: [], brokerageScopeId: null,
      effectiveRole: "solo_agent",
    }
  }
  const svc = createServiceClient()

  // Pull this user's agent row + check whether they lead any team.
  const [agentRowR, teamsR] = await Promise.all([
    svc.from("agents")
      .select("id, team_id")
      .eq("user_id", ctx.userId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle(),
    // Brokerage-tier users get every team; team-lead users get just their team
    BROKER_ROLES.has(ctx.userType)
      ? svc.from("teams").select("id").eq("brokerage_id", ctx.brokerageId)
      : Promise.resolve({ data: null } as { data: null }),
  ])
  const agentRow = agentRowR.data as { id: string | null; team_id: string | null } | null
  const agentScopeId = agentRow?.id ?? null
  const agentTeamId  = agentRow?.team_id ?? null

  // Team-lead check — agents.id appears as teams.team_lead_id on at least
  // one row. Brokerage tier users always get team access.
  let isTeamLead = false
  if (!BROKER_ROLES.has(ctx.userType) && agentScopeId) {
    try {
      const { data: leadCheck } = await svc.from("teams")
        .select("id")
        .eq("team_lead_id", agentScopeId)
        .limit(1)
      isTeamLead = !!(leadCheck && leadCheck.length > 0)
    } catch { /* fail-closed */ }
  }

  const canEditBrokerage = BROKER_ROLES.has(ctx.userType)
  const canEditTeam      = canEditBrokerage || isTeamLead
  const canEditAgent     = !!agentScopeId

  const effectiveRole: PolicyScopeAccess["effectiveRole"] =
    canEditBrokerage ? "broker_admin"
    : isTeamLead      ? "team_lead"
    :                   "solo_agent"

  let teamScopeIds: string[] = []
  if (canEditBrokerage) {
    teamScopeIds = ((teamsR.data ?? []) as Array<{ id: string }>).map((r) => r.id)
  } else if (isTeamLead && agentTeamId) {
    teamScopeIds = [agentTeamId]
  }

  return {
    canEditAgent,
    canEditTeam,
    canEditBrokerage,
    agentScopeId,
    teamScopeIds,
    brokerageScopeId: canEditBrokerage ? ctx.brokerageId : null,
    effectiveRole,
  }
}
