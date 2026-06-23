// lib/kernel/reporting-scope.ts
//
// REPORTING SCOPE — threads the egress-scope tiers into the reporting kernel so a report shows the
// slice the actor actually oversees. Before this, every kernel report filtered ONLY by brokerage_id
// (plus an optional explicit agentId), so a multi-location brokerage's LOCATION ADMIN saw the entire
// brokerage's pipeline / source ROI / financials — both wrong roll-ups and a cross-office data leak.
//
// The org structure lives on agents: agents.location_id + agents.team_id. Transactions, commissions,
// contacts, listings, reviews all key off agent_id → agents.id. So a location/team report = "the set
// of agents in that location/team" → filter the agent-keyed report data by those agent ids.

import { resolveEgressScope, type EgressScopeKind } from "./egress-scope"

export interface ReportScopeCtx {
  userType: string
  userId: string
  /** agents.id for this actor (the column report data keys off). */
  agentId: string
  brokerageId: string
  locationId?: string | null
  teamId?: string | null
}

export interface ResolvedReportScope {
  kind: EgressScopeKind
  /**
   * The agent ids (agents.id) a report may include:
   *   • null  → no agent-level narrowing — the whole brokerage (broker / single-office admin).
   *   • [...] → exactly these agents (own work, or a location's / team's members).
   * An empty array means "a real scope that currently has zero agents" → the report is legitimately
   * empty (NOT brokerage-wide). Callers must treat null and [] differently.
   */
  agentIds: string[] | null
  locationId: string | null
  teamId: string | null
}

/**
 * PURE: given the resolved egress kind, the actor's own agent id, and the member agents found for a
 * location/team scope, decide the final agentIds filter. Unit-tested without any I/O.
 */
export function narrowReportAgentIds(
  kind: EgressScopeKind,
  ownAgentId: string,
  memberAgentIds: string[],
): string[] | null {
  if (kind === "brokerage") return null          // no narrowing — whole brokerage
  if (kind === "agent") return [ownAgentId]       // own work only
  return memberAgentIds                            // location / team → its members (may be empty)
}

type Sb = { from: (t: string) => any }

/**
 * Resolve the reporting scope for an actor. Looks up the member agents of a location/team scope.
 * brokerage/agent scopes need no lookup (pure decision). Best-effort: on any lookup failure it
 * returns an empty member set rather than silently widening to the brokerage.
 */
export async function resolveReportScope(supabase: Sb, ctx: ReportScopeCtx): Promise<ResolvedReportScope> {
  const scope = resolveEgressScope({
    userType: ctx.userType,
    userId: ctx.userId,
    brokerageId: ctx.brokerageId,
    locationId: ctx.locationId,
    teamId: ctx.teamId,
  })

  let memberAgentIds: string[] = []
  if (scope.kind === "location" || scope.kind === "team") {
    let q = supabase.from("agents").select("id").eq("brokerage_id", ctx.brokerageId)
    if (scope.kind === "location" && scope.locationId) q = q.eq("location_id", scope.locationId)
    if (scope.kind === "team" && scope.teamId) q = q.eq("team_id", scope.teamId)
    const { data } = await q
    memberAgentIds = (data ?? []).map((a: { id: string }) => a.id)
  }

  return {
    kind: scope.kind,
    agentIds: narrowReportAgentIds(scope.kind, ctx.agentId, memberAgentIds),
    locationId: scope.locationId,
    teamId: scope.teamId,
  }
}
