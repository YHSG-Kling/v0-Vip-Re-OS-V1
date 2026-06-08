/**
 * lib/kernel/command-center.ts
 *
 * Kernel load command for the Agent Command Center — the single operator
 * surface over the multi-manager runtime. Returns, as one normalized contract:
 *   1. Live managed-agent sessions (which manager is running on which entity,
 *      status, last event) — the "what are my agents doing right now" view.
 *   2. The agent-action APPROVAL QUEUE — proposed marketing_agent_actions +
 *      asset_manager_actions awaiting a human approver (the governance gate:
 *      proposed → approved/executing requires approved_by).
 *   3. Summary counts for the header.
 *
 * Service-role read (admin surface, gated at the page). NOT server-only by
 * convention so the simulator can drive it end-to-end against real rows; never
 * import from a client component. Zero mock data.
 */
import { createServiceClient } from "@/lib/supabase/service"

export type ManagerSessionStatus = "running" | "idle" | "terminated" | "error"

export interface CommandCenterSession {
  id:          string
  agentKind:   string | null
  entityType:  string
  entityId:    string
  status:      string
  createdAt:   string
  lastEventAt: string | null
  endedAt:     string | null
}

export type ApprovalSlaLevel = "ok" | "due" | "breached"

export interface CommandCenterAction {
  id:         string
  queue:      "marketing" | "asset"
  brokerageId: string
  actionType: string
  rationale:  string | null
  actionInput: Record<string, unknown>
  status:     string
  proposedAt: string | null
  ageHours:   number
  slaLevel:   ApprovalSlaLevel
}

/**
 * Pure approval-SLA evaluation (eval-skill: stalled approvals must escalate).
 * A proposed agent action that sits unactioned past the breach window is
 * surfaced as 'breached' so a human escalates instead of it silently rotting.
 * Defaults: due at 12h, breached at 24h.
 */
export function evaluateApprovalSla(
  proposedAt: string | null,
  now: Date = new Date(),
  opts: { dueHours?: number; breachHours?: number; deadlineIso?: string | null; dueBeforeHours?: number; breachBeforeHours?: number } = {},
): { ageHours: number; level: ApprovalSlaLevel } {
  const dueHours = opts.dueHours ?? 12
  const breachHours = opts.breachHours ?? 24
  if (!proposedAt) return { ageHours: 0, level: "ok" }
  const ageMs = now.getTime() - new Date(proposedAt).getTime()
  const ageHours = Math.max(0, Math.round((ageMs / 3_600_000) * 10) / 10)
  let level: ApprovalSlaLevel = ageHours >= breachHours ? "breached" : ageHours >= dueHours ? "due" : "ok"

  // Deadline-aware escalation (gate-2 release vs the seller's appointment): as the
  // appointment nears, escalate LOUDER even if the proposal is young — but we still
  // only HOLD; nothing auto-releases. Takes the more urgent of age-based vs
  // deadline-based level.
  if (opts.deadlineIso) {
    const hoursToDeadline = (new Date(opts.deadlineIso).getTime() - now.getTime()) / 3_600_000
    const breachBefore = opts.breachBeforeHours ?? 24
    const dueBefore = opts.dueBeforeHours ?? 48
    const dl: ApprovalSlaLevel = hoursToDeadline <= breachBefore ? "breached" : hoursToDeadline <= dueBefore ? "due" : "ok"
    const rank: Record<ApprovalSlaLevel, number> = { breached: 0, due: 1, ok: 2 }
    if (rank[dl] < rank[level]) level = dl
  }
  return { ageHours, level }
}

export interface CommandCenterData {
  sessions:        CommandCenterSession[]
  pendingActions:  CommandCenterAction[]
  summary: {
    activeSessions:    number
    idleSessions:      number
    erroredSessions:   number
    pendingApprovals:  number
    breachedApprovals: number
  }
}

export interface CommandCenterParams {
  /** Scope to one brokerage; omit (superadmin) for platform-wide. */
  brokerageId?: string
  limit?:       number
}

export async function loadCommandCenter(params: CommandCenterParams = {}): Promise<CommandCenterData> {
  const supabase = createServiceClient()
  const limit = params.limit ?? 50

  const sessionsQuery = supabase
    .from("managed_agent_sessions")
    .select("id, entity_type, entity_id, status, created_at, last_event_at, ended_at, managed_agents!managed_agent_sessions_managed_agent_id_fkey(agent_kind)")
    .order("created_at", { ascending: false })
    .limit(limit)
  if (params.brokerageId) sessionsQuery.eq("brokerage_id", params.brokerageId)

  const marketingQuery = supabase
    .from("marketing_agent_actions")
    .select("id, brokerage_id, action_type, rationale, action_input, status, proposed_at")
    .eq("status", "proposed")
    .order("proposed_at", { ascending: true })
    .limit(limit)
  if (params.brokerageId) marketingQuery.eq("brokerage_id", params.brokerageId)

  const assetQuery = supabase
    .from("asset_manager_actions")
    .select("id, brokerage_id, action_type, rationale, action_input, status, proposed_at")
    .eq("status", "proposed")
    .order("proposed_at", { ascending: true })
    .limit(limit)
  if (params.brokerageId) assetQuery.eq("brokerage_id", params.brokerageId)

  const [sessionsRes, marketingRes, assetRes] = await Promise.all([sessionsQuery, marketingQuery, assetQuery])

  const sessions: CommandCenterSession[] = (sessionsRes.data ?? []).map((s: any) => ({
    id:          s.id,
    agentKind:   s.managed_agents?.agent_kind ?? null,
    entityType:  s.entity_type,
    entityId:    s.entity_id,
    status:      s.status,
    createdAt:   s.created_at,
    lastEventAt: s.last_event_at ?? null,
    endedAt:     s.ended_at ?? null,
  }))

  const now = new Date()
  const mapAction = (queue: "marketing" | "asset") => (a: any): CommandCenterAction => {
    // Release approvals escalate against the seller's appointment, not just age.
    const deadlineIso = a.action_type === "approve_prelisting_delivery"
      ? (a.action_input?.appointment_at as string | null) ?? null
      : null
    const sla = evaluateApprovalSla(a.proposed_at ?? null, now, { deadlineIso })
    return {
      id:          a.id,
      queue,
      brokerageId: a.brokerage_id,
      actionType:  a.action_type,
      rationale:   a.rationale ?? null,
      actionInput: (a.action_input ?? {}) as Record<string, unknown>,
      status:      a.status,
      proposedAt:  a.proposed_at ?? null,
      ageHours:    sla.ageHours,
      slaLevel:    sla.level,
    }
  }

  // SLA-breached approvals escalate to the top; then oldest-first.
  const slaRank: Record<ApprovalSlaLevel, number> = { breached: 0, due: 1, ok: 2 }
  const pendingActions: CommandCenterAction[] = [
    ...(marketingRes.data ?? []).map(mapAction("marketing")),
    ...(assetRes.data ?? []).map(mapAction("asset")),
  ].sort((a, b) => slaRank[a.slaLevel] - slaRank[b.slaLevel] || (a.proposedAt ?? "").localeCompare(b.proposedAt ?? ""))

  return {
    sessions,
    pendingActions,
    summary: {
      activeSessions:    sessions.filter((s) => s.status === "running").length,
      idleSessions:      sessions.filter((s) => s.status === "idle").length,
      erroredSessions:   sessions.filter((s) => s.status === "error").length,
      pendingApprovals:  pendingActions.length,
      breachedApprovals: pendingActions.filter((a) => a.slaLevel === "breached").length,
    },
  }
}
