"use server"

// Team-member management — the missing WRITE path for team_members. createTeam (multi-persona.ts)
// makes a team; getTeamDashboard + the Finance commission waterfall READ team_members; but nothing
// populated it. These actions let a broker/admin/team-lead build the roster (assign agent → split %
// → source-of-funds), so the Finance Manager's split actually splits. Gated + brokerage-scoped.

import { getAgentContext } from "@/lib/identity"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { validateTeamMember, agentFundedTotal, isSourceOfFunds, isTeamRole, type SourceOfFunds, type TeamRole } from "@/lib/teams/membership"
import { isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"
import { resolveLedTeamId } from "@/lib/teams/team-scope"


export interface TeamMemberRow {
  id: string
  agent_id: string
  role: string | null
  split_percent: number
  source_of_funds: string
  is_active: boolean
  agent_name: string | null
}

/** List a team's active members (with the agent's display name). Brokerage-scoped. */
export async function listTeamMembers(teamId: string): Promise<{ ok: true; rows: TeamMemberRow[] } | { ok: false; error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }
  const svc = createServiceClient()
  const { data: team } = await svc.from("teams").select("id").eq("id", teamId).eq("brokerage_id", ctx.brokerageId).maybeSingle()
  if (!team) return { ok: false, error: "Team not found" }
  const { data: members } = await svc.from("team_members")
    .select("id, agent_id, role, split_percent, source_of_funds, is_active")
    .eq("team_id", teamId).eq("brokerage_id", ctx.brokerageId).eq("is_active", true)
  const agentIds = (members ?? []).map((m) => m.agent_id)
  const nameByAgent = new Map<string, string>()
  if (agentIds.length > 0) {
    const { data: agents } = await svc.from("agents").select("id, users(first_name, last_name)").in("id", agentIds)
    for (const a of (agents ?? []) as Array<{ id: string; users?: Array<{ first_name?: string; last_name?: string }> | { first_name?: string; last_name?: string } | null }>) {
      const u = Array.isArray(a.users) ? a.users[0] : a.users
      nameByAgent.set(a.id, [u?.first_name, u?.last_name].filter(Boolean).join(" ") || a.id.slice(0, 8))
    }
  }
  return { ok: true, rows: (members ?? []).map((m) => ({ ...m, agent_name: nameByAgent.get(m.agent_id) ?? null })) as TeamMemberRow[] }
}

/** Add an agent to a team with a split. Broker/admin/team-lead only; brokerage-scoped; validated. */
export async function addTeamMember(input: {
  teamId: string
  agentId: string
  /** Tightened string → TeamRole (2026-08-31): the UI picker already renders from TEAM_ROLES,
   *  so only a hand-crafted request could send anything else — and this is a public endpoint,
   *  so the isTeamRole runtime check below is the real gate; the type is its compile-time echo. */
  role: TeamRole
  splitPercent: number
  sourceOfFunds: SourceOfFunds
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }
  if (!isSourceOfFunds(input.sourceOfFunds)) return { ok: false, error: "Invalid source of funds" }
  if (!isTeamRole(input.role)) return { ok: false, error: "Invalid team role" }

  const svc = createServiceClient()
  // ROSTER + MEMBER SPLIT are the team's terms (m473, owner ruling: the lead
  // "set[s] the caps and percentages of their agents"). Finance admins manage
  // any team; the LEAD manages exactly the team whose teams.team_lead_id is
  // them — the FACT, not a user_type, which also admits the live lead whose
  // user_type is 'agent'. The write below is service-client, so this gate is
  // the only gate; it mirrors m473's team_members RLS exactly.
  if (!isBrokerageFinanceAdmin({ user_type: ctx.userType })) {
    if (!ctx.userId) return { ok: false, error: "Unauthorized" }
    const led = await resolveLedTeamId(svc, ctx.userId)
    if (!led.ok) return { ok: false, error: led.error }
    if (!led.teamId || led.teamId !== input.teamId) {
      return { ok: false, error: "Forbidden — only a broker/admin or this team's lead can manage its members" }
    }
  }
  // Verify the team + agent both belong to the caller's brokerage (no cross-tenant assignment).
  const [{ data: team }, { data: agent }] = await Promise.all([
    svc.from("teams").select("id").eq("id", input.teamId).eq("brokerage_id", ctx.brokerageId).maybeSingle(),
    svc.from("agents").select("id").eq("id", input.agentId).eq("brokerage_id", ctx.brokerageId).maybeSingle(),
  ])
  if (!team) return { ok: false, error: "Team not found in your brokerage" }
  if (!agent) return { ok: false, error: "Agent not found in your brokerage" }

  // Already an active member? (idempotent — update instead)
  const { data: existing } = await svc.from("team_members").select("id")
    .eq("team_id", input.teamId).eq("agent_id", input.agentId).eq("is_active", true).maybeSingle()

  // Cap check against the team's existing agent-funded splits.
  const { data: current } = await svc.from("team_members").select("split_percent, source_of_funds, is_active, agent_id")
    .eq("team_id", input.teamId).eq("is_active", true)
  const existingFunded = agentFundedTotal((current ?? []).filter((m) => m.agent_id !== input.agentId))
  const v = validateTeamMember({ splitPercent: input.splitPercent, sourceOfFunds: input.sourceOfFunds, existingAgentFundedPct: existingFunded })
  if (!v.ok) return { ok: false, error: v.error ?? "Invalid team member" }

  if (existing) {
    const { error } = await svc.from("team_members")
      .update({ role: input.role, split_percent: input.splitPercent, source_of_funds: input.sourceOfFunds })
      .eq("id", existing.id)
    if (error) return { ok: false, error: error.message }
    revalidatePath("/dashboard/team")
    return { ok: true, id: existing.id }
  }

  const { data, error } = await svc.from("team_members").insert({
    team_id: input.teamId, agent_id: input.agentId, brokerage_id: ctx.brokerageId,
    role: input.role, split_percent: input.splitPercent, source_of_funds: input.sourceOfFunds,
    is_active: true, effective_from: new Date().toISOString().split("T")[0],
  }).select("id").single()
  if (error || !data) return { ok: false, error: error?.message ?? "insert failed" }
  revalidatePath("/dashboard/team")
  return { ok: true, id: (data as { id: string }).id }
}

/** Deactivate a team member (soft — preserves commission history). */
export async function removeTeamMember(memberId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }
  const svc = createServiceClient()
  // Same authority as adding: finance admin, or the lead of the team this
  // member row belongs to. The row is read FIRST so the refusal names the right
  // fact — and a refused read is an outage, not a denial.
  const { data: row, error: readErr } = await svc.from("team_members")
    .select("team_id").eq("id", memberId).eq("brokerage_id", ctx.brokerageId).maybeSingle()
  if (readErr) return { ok: false, error: `Could not read the member row: ${readErr.message}` }
  if (!row) return { ok: false, error: "Member not found in your brokerage" }
  if (!isBrokerageFinanceAdmin({ user_type: ctx.userType })) {
    if (!ctx.userId) return { ok: false, error: "Unauthorized" }
    const led = await resolveLedTeamId(svc, ctx.userId)
    if (!led.ok) return { ok: false, error: led.error }
    if (!led.teamId || led.teamId !== row.team_id) return { ok: false, error: "Forbidden" }
  }
  const { error } = await svc.from("team_members")
    .update({ is_active: false, effective_to: new Date().toISOString().split("T")[0] })
    .eq("id", memberId).eq("brokerage_id", ctx.brokerageId)
  if (error) return { ok: false, error: error.message }
  revalidatePath("/dashboard/team")
  return { ok: true }
}
