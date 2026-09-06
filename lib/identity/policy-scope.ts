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
 *   · users.id matches teams.team_lead_id on some row → TEAM tab
 *     visible (their own team only). team_lead_id is a users.id
 *     (FK auth.users(id)) — never compare it to agents.id.
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

/**
 * BROKERAGE-TIER policy editors. DELIBERATELY NOT the canonical tenant-admin
 * roster (lib/auth/resolve-user-role.ts#isAdminOrBroker), in BOTH directions:
 *
 *   WIDER  by `compliance_officer` — policy is a compliance surface, and the
 *          compliance officer edits it at brokerage tier without being an admin.
 *   NARROWER by omitting `team_lead` — and that omission is the whole design of
 *          this module. Leading a team is a FACT here, not a role: the team tier
 *          is resolved from teams.team_lead_id (a users.id) at line ~86, not from
 *          user_type. Adding team_lead to this set would make canEditBrokerage
 *          true for every team lead and short-circuit the team-tier branch that
 *          exists to scope them to their OWN team.
 *
 * `owner` REMOVED — it was in no vocabulary. users_user_type_check admits
 * fourteen values and `owner` is not one of them; MEASURED on the live database,
 * zero rows carry it in users.user_type, users.role or user_role_assignments.role.
 * It matched nothing, so removing it changes no behaviour. `broker_owner` is the
 * real spelling of what it was reaching for, and it is added here — the person who
 * OWNS the brokerage was being refused brokerage-tier policy editing.
 */
const BROKER_ROLES = new Set(["broker", "broker_owner", "broker_admin", "admin", "compliance_officer"])

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

  // Team-lead check — teams.team_lead_id is users.id (FK auth.users(id), same
  // id-class the kernel writes in lib/kernel/users.ts). The prior code compared
  // it against the caller's agents.id, which never equals a users.id — so team
  // leads never saw their Team tab. Brokerage tier users always get team access.
  let isTeamLead = false
  let leadTeamIds: string[] = []
  if (!BROKER_ROLES.has(ctx.userType)) {
    try {
      const { data: leadCheck } = await svc.from("teams")
        .select("id")
        .eq("team_lead_id", ctx.userId)
        .eq("brokerage_id", ctx.brokerageId)
        .is("deleted_at", null)
      leadTeamIds = ((leadCheck ?? []) as Array<{ id: string }>).map((r) => r.id)
      isTeamLead = leadTeamIds.length > 0
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
  } else if (isTeamLead) {
    // The teams they LEAD (team_lead_id match) — plus their own membership
    // team if it isn't already in the list (a lead's agents.team_id may point
    // at the same team, or they may lead a team they aren't a member row of).
    teamScopeIds = agentTeamId && !leadTeamIds.includes(agentTeamId)
      ? [...leadTeamIds, agentTeamId]
      : leadTeamIds
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
