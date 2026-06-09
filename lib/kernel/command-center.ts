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
import { loadContentApprovalActions, type ContentQueue } from "./approval-sources"
import { evaluateApprovalSla, type ApprovalSlaLevel } from "./approval-sla"

// Re-export so existing importers (simulators, server actions) keep working.
export { evaluateApprovalSla }
export type { ApprovalSlaLevel }

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

export interface CommandCenterAction {
  id:         string
  queue:      "marketing" | "asset" | "ads" | "client_message" | ContentQueue
  brokerageId: string
  actionType: string
  rationale:  string | null
  actionInput: Record<string, unknown>
  status:     string
  proposedAt: string | null
  ageHours:   number
  slaLevel:   ApprovalSlaLevel
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

  // Ads Manager — paid-ad spend actions awaiting a human (launch/pause/budget/scale).
  const adsQuery = supabase
    .from("ad_manager_actions")
    .select("id, brokerage_id, action_type, rationale, action_input, status, proposed_at")
    .eq("status", "proposed")
    .order("proposed_at", { ascending: true })
    .limit(limit)
  if (params.brokerageId) adsQuery.eq("brokerage_id", params.brokerageId)

  // Customer-facing content awaiting human RELEASE — social posts (incl. avatar/
  // listing reels + GBP), email newsletters, direct-mail campaigns. Loaded via
  // the content-approval source REGISTRY so every public-facing approval lives in
  // the ONE Command Center, not a separate per-channel dashboard. Each channel's
  // send/publish cron only ships the 'approved' value, so a pending row cannot
  // reach a consumer.
  const now = new Date()
  const contentPromise = loadContentApprovalActions(supabase, { brokerageId: params.brokerageId, limit, now })

  // Deal-critical managers' proposed client messages (seller/buyer updates) awaiting
  // human approval — nothing reaches a client until released here.
  const clientMsgQuery = supabase
    .from("agent_client_messages")
    .select("id, brokerage_id, agent_kind, entity_type, audience, subject, body, rationale, recipient_contact_id, channel, proposed_at")
    .eq("status", "proposed")
    .order("proposed_at", { ascending: true })
    .limit(limit)
  if (params.brokerageId) clientMsgQuery.eq("brokerage_id", params.brokerageId)

  const [sessionsRes, marketingRes, assetRes, adsRes, clientMsgRes, contentActions] = await Promise.all([sessionsQuery, marketingQuery, assetQuery, adsQuery, clientMsgQuery, contentPromise])

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

  const mapAction = (queue: "marketing" | "asset" | "ads") => (a: any): CommandCenterAction => {
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

  // Map a proposed client message → the unified action contract (preview = the
  // actual seller/buyer message the human is releasing).
  const mapClientMsg = (m: any): CommandCenterAction => {
    const sla = evaluateApprovalSla(m.proposed_at ?? null, now)
    return {
      id: m.id, queue: "client_message", brokerageId: m.brokerage_id, actionType: "approve_client_message",
      rationale: `${(m.agent_kind ?? "agent").replace(/_/g, " ")} drafted a ${m.audience} update via ${m.channel ?? "portal"} — review/edit before it reaches the client.`,
      actionInput: { agent_kind: m.agent_kind, entity_type: m.entity_type, audience: m.audience, subject: m.subject, body: m.body, briefing: m.rationale, recipient_contact_id: m.recipient_contact_id, channel: m.channel ?? "portal" },
      status: "proposed", proposedAt: m.proposed_at ?? null, ageHours: sla.ageHours, slaLevel: sla.level,
    }
  }

  // SLA-breached approvals escalate to the top; then oldest-first.
  const slaRank: Record<ApprovalSlaLevel, number> = { breached: 0, due: 1, ok: 2 }
  const pendingActions: CommandCenterAction[] = [
    ...(marketingRes.data ?? []).map(mapAction("marketing")),
    ...(assetRes.data ?? []).map(mapAction("asset")),
    ...(adsRes.data ?? []).map(mapAction("ads")),
    ...(clientMsgRes.data ?? []).map(mapClientMsg),
    ...contentActions,
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
