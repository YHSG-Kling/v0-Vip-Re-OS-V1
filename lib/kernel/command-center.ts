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
import { resolveActionManager, type ManagerKey } from "./manager-registry"
import { compliancePreflight } from "./manager-dissent"
import type { EgressScope } from "./egress-scope"

// Re-export so existing importers (simulators, server actions) keep working.
export { evaluateApprovalSla }
export type { ApprovalSlaLevel }

export type ManagerSessionStatus = "running" | "idle" | "terminated" | "error"

/** Outbound CLIENT-FACING copy queues — broadcast/message content the Compliance Officer
 *  pre-flights for Fair Housing (no single-recipient consent to block on, so advisory-only).
 *  client_message is handled separately (it carries per-recipient consent → can hard-block). */
export const OUTBOUND_COPY_QUEUES = new Set<string>([
  "social", "newsletter", "direct_mail", "ad_creative", "predictive_listing", "blog", "podcast",
])
/** The human-readable copy keys across every content source's actionInput (lib/kernel/approval-sources).
 *  Whitelisted so the Fair Housing scan reads real copy, never URLs/ids/config. */
const COPY_KEYS = [
  "content", "content_preview", "subject", "subject_line", "body", "copy_text",
  "headline", "primary_text", "description", "call_to_action", "title", "excerpt",
] as const
/** Pure: pull the outbound copy out of an action's input for the Fair Housing scan. */
export function extractProposalCopy(input: Record<string, unknown>): string {
  return COPY_KEYS.map((k) => (typeof input[k] === "string" ? (input[k] as string) : "")).filter(Boolean).join("  ")
}

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
  /** The Claude manager accountable for this activity on the egress (zero orphans). */
  managerKey:   ManagerKey
  managerLabel: string
  /** Compliance Officer PRE-FLIGHT verdict (client_message proposals only) — the consent +
   *  Fair Housing sign-off the human sees BEFORE approving. Absent for non-outbound queues. */
  compliance?: { status: "clear" | "advisory" | "blocked"; manager: ManagerKey; findings: string[] }
}

export interface ManagerBreakdownEntry {
  key:      ManagerKey
  label:    string
  /** Pending activities this manager is accountable for on the egress. */
  count:    number
  /** Of which, SLA-breached. */
  breached: number
}

export interface CommandCenterData {
  sessions:        CommandCenterSession[]
  pendingActions:  CommandCenterAction[]
  /** Per-manager pending load — proves every activity has an accountable owner. */
  managerBreakdown: ManagerBreakdownEntry[]
  /** Manager Daily Standup — each manager's 24h activity + what needs a human.
   *  The morning roll-call that heads the Command Center. */
  standup:         import("@/lib/intelligence/manager-standup").ManagerStandupLine[]
  /** Manager Weekly P&L — each manager's trailing-7d production vs the prior week.
   *  The outcome layer beneath the standup (did the AI workforce produce?). */
  weeklyPnl:       import("@/lib/intelligence/manager-weekly-pnl").ManagerWeeklyScorecard[]
  /** Unified governed-deliverables rail — every loop's gate proposals rolled up
   *  (how many AI deliverables this week, how many human-approved, by manager + loop). */
  deliverables:    import("@/lib/intelligence/deliverables-summary").DeliverablesSummary | null
  /** Recruiting Manager's retention board — the daily flight-risk scores made visible
   *  (who's trending down, how many at-risk, why). Brokerage-wide; null when unavailable. */
  retentionBoard:  import("@/lib/intelligence/retention-board").RetentionBoard | null
  /** Did the save-plays WORK — retained / lost / pending + win rate (the retention loop closed,
   *  the AI team's interventions made accountable). Brokerage-wide; null when unavailable. */
  retentionOutcomes: import("@/lib/intelligence/retention-outcomes").RetentionOutcomeBoard | null
  /** Education loop — per-agent skill freshness rolled up (how many agents have a stale
   *  skill, who's rustiest, in what). Brokerage-wide; null when unavailable. */
  skillBoard:      import("@/lib/intelligence/skill-freshness-board").SkillFreshnessBoard | null
  /** Agent-to-agent recruiting growth engine — revenue share paid across the network +
   *  the top-earning sponsors and their downline size. Brokerage-wide; null when unavailable. */
  revenueShareBoard: import("@/lib/intelligence/revenue-share-board").RevenueShareBoard | null
  /** AI-authored curriculum awaiting a human publish — the OS teaching itself to teach.
   *  Brokerage-wide; null when unavailable. */
  curriculumBoard: import("@/lib/intelligence/curriculum-board").CurriculumBoard | null
  /** THE AI EXECUTIVE STANDUP — the weekly ROI-ranked org plan synthesized ACROSS every manager's output
   *  (retention flight-risk, WoW GCI swings, SLA-breached approval backlog, recruiting flywheel, enablement)
   *  and the single human ask. The executive layer above the per-manager P&L. Brokerage-wide; null when
   *  unavailable. */
  weeklyExecPlan: import("@/lib/intelligence/manager-weekly-exec-plan").WeeklyExecPlan | null
  /** Proposed AI ISA voice dial batches awaiting approval (AI ISA — "call my hottest N"). */
  dialBatches:     Array<{ id: string; proposedCount: number; proposedAt: string | null }>
  /** Managers talking — recent inter-manager signals (who told whom what, and what the
   *  addressed manager did about it). The bus made visible. */
  managerTalk:     import("@/lib/kernel/manager-signals").ManagerTalkLine[]
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
  /**
   * EGRESS SCOPE — restrict every actionable surface to what THIS user oversees,
   * so a team lead sees only their team's work and a solo agent sees only their own
   * (the multi-tier egress made real on the Command Center). When set, scope.brokerageId
   * is authoritative (overrides brokerageId).
   *
   *  · brokerage → brokerage-wide (broker / broker_admin / superadmin / single-office admin).
   *  · location  → only the sessions/actions/messages on entities (contacts/listings) at that office
   *    (multi-location brokerages — a location admin never sees a sibling office's work).
   *  · team  → only the entities owned by that team.
   *  · agent → narrowed to the one agent's own book of business.
   *  For location/team/agent, brokerage-wide aggregates (standup, P&L, manager talk, content queue)
   *  are withheld so a narrower scope never sees the whole house.
   *
   * Omit entirely for the platform-wide superadmin view.
   */
  scope?: EgressScope
}

/** UUID that matches no row — used so an empty scoped-id list filters to nothing
 *  (an agent who owns no entities sees an empty queue, never the whole brokerage). */
const NO_MATCH_UUID = "00000000-0000-0000-0000-000000000000"

/**
 * Resolve the entity ids a team/agent scope is allowed to see, THROUGH the entity
 * the work runs on (the egress tables carry only brokerage_id — agent/team ownership
 * lives on the contact/listing). Pure read; never throws upstream.
 */
async function resolveScopedEntities(
  supabase: ReturnType<typeof createServiceClient>,
  scope: EgressScope,
  brokerageId: string,
): Promise<{ contactIds: string[]; listingIds: string[] }> {
  if (scope.kind === "location" && scope.locationId) {
    const [cs, ls] = await Promise.all([
      supabase.from("contacts").select("id").eq("brokerage_id", brokerageId).eq("location_id", scope.locationId),
      supabase.from("listings").select("id").eq("brokerage_id", brokerageId).eq("location_id", scope.locationId),
    ])
    return { contactIds: (cs.data ?? []).map((r: any) => r.id), listingIds: (ls.data ?? []).map((r: any) => r.id) }
  }
  if (scope.kind === "team" && scope.teamId) {
    const [cs, ls] = await Promise.all([
      supabase.from("contacts").select("id").eq("brokerage_id", brokerageId).eq("team_id", scope.teamId),
      supabase.from("listings").select("id").eq("brokerage_id", brokerageId).eq("team_id", scope.teamId),
    ])
    return { contactIds: (cs.data ?? []).map((r: any) => r.id), listingIds: (ls.data ?? []).map((r: any) => r.id) }
  }
  if (scope.kind === "agent" && scope.agentUserId) {
    // scope.agentUserId is a USER id; map it to this brokerage's agent row(s), then
    // to the contacts/listings that agent owns.
    const { data: agentRows } = await supabase
      .from("agents").select("id").eq("brokerage_id", brokerageId).eq("user_id", scope.agentUserId)
    const agentIds = (agentRows ?? []).map((r: any) => r.id)
    if (agentIds.length === 0) return { contactIds: [], listingIds: [] }
    const [cs, ls] = await Promise.all([
      supabase.from("contacts").select("id").eq("brokerage_id", brokerageId).in("agent_id", agentIds),
      supabase.from("listings").select("id").eq("brokerage_id", brokerageId).in("agent_id", agentIds),
    ])
    return { contactIds: (cs.data ?? []).map((r: any) => r.id), listingIds: (ls.data ?? []).map((r: any) => r.id) }
  }
  return { contactIds: [], listingIds: [] }
}

export async function loadCommandCenter(params: CommandCenterParams = {}): Promise<CommandCenterData> {
  const supabase = createServiceClient()
  const limit = params.limit ?? 50
  const scope = params.scope
  // scope.brokerageId is authoritative when a scope is supplied.
  const brokerageId = scope?.brokerageId ?? params.brokerageId

  // location / team / agent scope restrict to the entities (contacts/listings) owned by that
  // location / team / agent (resolved through the entity — the egress tables carry only brokerage_id).
  const entityScoped = !!scope && (scope.kind === "location" || scope.kind === "team" || scope.kind === "agent")
  // brokerage-wide aggregates (standup, P&L, manager talk, dial batches, content queue) are only shown
  // to a brokerage-wide viewer — withheld from a narrower scope (incl. a single-location admin, whose
  // aggregates aren't location-segmented yet).
  const brokerageWide = !scope || scope.kind === "brokerage"

  // For team/agent scope, resolve which sessions (and client contacts) are in view,
  // THROUGH the owned entities — the egress tables carry only brokerage_id.
  let sessionIdFilter: string[] | null = null
  let contactIdFilter: string[] | null = null
  if (entityScoped && brokerageId) {
    const { contactIds, listingIds } = await resolveScopedEntities(supabase, scope!, brokerageId)
    contactIdFilter = contactIds.length ? contactIds : [NO_MATCH_UUID]
    const entityIds = [...contactIds, ...listingIds]
    if (entityIds.length === 0) {
      sessionIdFilter = [NO_MATCH_UUID]
    } else {
      const { data: scopedSessions } = await supabase
        .from("managed_agent_sessions").select("id").eq("brokerage_id", brokerageId).in("entity_id", entityIds)
      const ids = (scopedSessions ?? []).map((r: any) => r.id)
      sessionIdFilter = ids.length ? ids : [NO_MATCH_UUID]
    }
  }

  const sessionsQuery = supabase
    .from("managed_agent_sessions")
    .select("id, entity_type, entity_id, status, created_at, last_event_at, ended_at, managed_agents!managed_agent_sessions_managed_agent_id_fkey(agent_kind)")
    .order("created_at", { ascending: false })
    .limit(limit)
  if (brokerageId) sessionsQuery.eq("brokerage_id", brokerageId)
  if (sessionIdFilter) sessionsQuery.in("id", sessionIdFilter)

  const marketingQuery = supabase
    .from("marketing_agent_actions")
    .select("id, brokerage_id, action_type, rationale, action_input, status, proposed_at")
    .eq("status", "proposed")
    .order("proposed_at", { ascending: true })
    .limit(limit)
  if (brokerageId) marketingQuery.eq("brokerage_id", brokerageId)
  if (sessionIdFilter) marketingQuery.in("managed_agent_session_id", sessionIdFilter)

  const assetQuery = supabase
    .from("asset_manager_actions")
    .select("id, brokerage_id, action_type, rationale, action_input, status, proposed_at")
    .eq("status", "proposed")
    .order("proposed_at", { ascending: true })
    .limit(limit)
  if (brokerageId) assetQuery.eq("brokerage_id", brokerageId)
  if (sessionIdFilter) assetQuery.in("managed_agent_session_id", sessionIdFilter)

  // Ads Manager — paid-ad spend actions awaiting a human (launch/pause/budget/scale).
  const adsQuery = supabase
    .from("ad_manager_actions")
    .select("id, brokerage_id, action_type, rationale, action_input, status, proposed_at")
    .eq("status", "proposed")
    .order("proposed_at", { ascending: true })
    .limit(limit)
  if (brokerageId) adsQuery.eq("brokerage_id", brokerageId)
  if (sessionIdFilter) adsQuery.in("managed_agent_session_id", sessionIdFilter)

  // Customer-facing content awaiting human RELEASE — social posts (incl. avatar/
  // listing reels + GBP), email newsletters, direct-mail campaigns. Loaded via
  // the content-approval source REGISTRY so every public-facing approval lives in
  // the ONE Command Center, not a separate per-channel dashboard. Each channel's
  // send/publish cron only ships the 'approved' value, so a pending row cannot
  // reach a consumer.
  const now = new Date()
  // Content approvals (social / email / direct-mail) are brokerage-level marketing,
  // not tied to one agent's book — withheld from a team/agent scope.
  const contentPromise = brokerageWide
    ? loadContentApprovalActions(supabase, { brokerageId, limit, now })
    : Promise.resolve([] as Awaited<ReturnType<typeof loadContentApprovalActions>>)

  // Deal-critical managers' proposed client messages (seller/buyer updates) awaiting
  // human approval — nothing reaches a client until released here.
  const clientMsgQuery = supabase
    .from("agent_client_messages")
    .select("id, brokerage_id, agent_kind, entity_type, audience, subject, body, rationale, recipient_contact_id, channel, proposed_at")
    .eq("status", "proposed")
    .order("proposed_at", { ascending: true })
    .limit(limit)
  if (brokerageId) clientMsgQuery.eq("brokerage_id", brokerageId)
  // A team/agent scope sees only messages to its own clients.
  if (contactIdFilter) clientMsgQuery.in("recipient_contact_id", contactIdFilter)

  const [sessionsRes, marketingRes, assetRes, adsRes, clientMsgRes, contentActions] = await Promise.all([sessionsQuery, marketingQuery, assetQuery, adsQuery, clientMsgQuery, contentPromise])

  // Compliance Officer pre-flight needs each recipient's consent state (withdrawn / revoked
  // channel) — batch it in ONE query keyed by contact id; Fair Housing is pure on the body.
  const recipientIds = Array.from(new Set(
    ((clientMsgRes.data ?? []) as any[]).map((m) => m.recipient_contact_id).filter(Boolean),
  )) as string[]
  const consentMap = new Map<string, { withdrawn: boolean; emailRevoked: boolean; smsRevoked: boolean }>()
  if (recipientIds.length > 0) {
    const { data: contactRows } = await supabase
      .from("contacts")
      .select("id, nurture_status, email_opt_out, email_unsubscribed, sms_opt_out")
      .in("id", recipientIds)
    for (const c of (contactRows ?? []) as any[]) {
      consentMap.set(c.id, {
        withdrawn: c.nurture_status === "withdrawn",
        emailRevoked: !!c.email_opt_out || !!c.email_unsubscribed,
        smsRevoked: !!c.sms_opt_out,
      })
    }
  }

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

  // Built without the manager fields; resolveActionManager attaches them in one pass below.
  type RawAction = Omit<CommandCenterAction, "managerKey" | "managerLabel">
  const mapAction = (queue: "marketing" | "asset" | "ads") => (a: any): RawAction => {
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
  const mapClientMsg = (m: any): RawAction => {
    const sla = evaluateApprovalSla(m.proposed_at ?? null, now)
    const consent = consentMap.get(m.recipient_contact_id) ?? { withdrawn: false, emailRevoked: false, smsRevoked: false }
    const compliance = compliancePreflight(
      { proposer: m.agent_kind ?? "agent", channel: m.channel ?? "portal", subject: m.subject ?? null, body: m.body ?? "" },
      { recipientWithdrawn: consent.withdrawn, emailRevoked: consent.emailRevoked, smsRevoked: consent.smsRevoked, hoursSinceLastSend: null, openFireDrill: false },
    )
    return {
      id: m.id, queue: "client_message", brokerageId: m.brokerage_id, actionType: "approve_client_message",
      rationale: `${(m.agent_kind ?? "agent").replace(/_/g, " ")} drafted a ${m.audience} update via ${m.channel ?? "portal"} — review/edit before it reaches the client.`,
      actionInput: { agent_kind: m.agent_kind, entity_type: m.entity_type, audience: m.audience, subject: m.subject, body: m.body, briefing: m.rationale, recipient_contact_id: m.recipient_contact_id, channel: m.channel ?? "portal" },
      status: "proposed", proposedAt: m.proposed_at ?? null, ageHours: sla.ageHours, slaLevel: sla.level, compliance,
    }
  }

  // SLA-breached approvals escalate to the top; then oldest-first. Every action is
  // stamped with its owning manager (zero orphans) — client_message resolves per-row
  // from agent_kind; every other queue from the static QUEUE_MANAGER map.
  const slaRank: Record<ApprovalSlaLevel, number> = { breached: 0, due: 1, ok: 2 }
  const rawActions: RawAction[] = [
    ...(marketingRes.data ?? []).map(mapAction("marketing")),
    ...(assetRes.data ?? []).map(mapAction("asset")),
    ...(adsRes.data ?? []).map(mapAction("ads")),
    ...(clientMsgRes.data ?? []).map(mapClientMsg),
    ...contentActions,
  ]
  const pendingActions: CommandCenterAction[] = rawActions
    .map((a): CommandCenterAction => {
      const mgr = resolveActionManager(a.queue, (a.actionInput?.agent_kind as string | null) ?? null)
      // Extend the Compliance Officer pre-flight to ALL outbound copy (client_message already
      // carries its consent-aware verdict); broadcast content is Fair-Housing-advisory only.
      let compliance = a.compliance
      if (!compliance && OUTBOUND_COPY_QUEUES.has(a.queue)) {
        const copy = extractProposalCopy(a.actionInput)
        if (copy) {
          compliance = compliancePreflight(
            { proposer: mgr.key, channel: "content", subject: null, body: copy },
            { recipientWithdrawn: false, emailRevoked: false, smsRevoked: false, hoursSinceLastSend: null, openFireDrill: false },
          )
        }
      }
      return { ...a, managerKey: mgr.key, managerLabel: mgr.label, compliance }
    })
    .sort((a, b) => slaRank[a.slaLevel] - slaRank[b.slaLevel] || (a.proposedAt ?? "").localeCompare(b.proposedAt ?? ""))

  // Per-manager pending load (preserves MANAGERS order; only managers with work appear).
  const breakdownMap = new Map<ManagerKey, ManagerBreakdownEntry>()
  for (const a of pendingActions) {
    const e = breakdownMap.get(a.managerKey) ?? { key: a.managerKey, label: a.managerLabel, count: 0, breached: 0 }
    e.count += 1
    if (a.slaLevel === "breached") e.breached += 1
    breakdownMap.set(a.managerKey, e)
  }
  const managerBreakdown = Array.from(breakdownMap.values()).sort((a, b) => b.count - a.count)

  // Manager Daily Standup — the morning roll-call (24h activity + needs-human per
  // manager). Brokerage-scoped only (platform-wide superadmin view aggregates many
  // tenants, so the standup is omitted there). Best-effort: never blocks the queue.
  let standup: import("@/lib/intelligence/manager-standup").ManagerStandupLine[] = []
  let weeklyPnl: import("@/lib/intelligence/manager-weekly-pnl").ManagerWeeklyScorecard[] = []
  let deliverables: import("@/lib/intelligence/deliverables-summary").DeliverablesSummary | null = null
  let retentionBoard: import("@/lib/intelligence/retention-board").RetentionBoard | null = null
  let retentionOutcomes: import("@/lib/intelligence/retention-outcomes").RetentionOutcomeBoard | null = null
  let skillBoard: import("@/lib/intelligence/skill-freshness-board").SkillFreshnessBoard | null = null
  let revenueShareBoard: import("@/lib/intelligence/revenue-share-board").RevenueShareBoard | null = null
  let curriculumBoard: import("@/lib/intelligence/curriculum-board").CurriculumBoard | null = null
  if (brokerageWide && brokerageId) {
    const [standupRes, pnlRes, delivRes, retentionRes, outcomesRes, skillRes, revShareRes, curriculumRes] = await Promise.allSettled([
      import("@/lib/intelligence/manager-standup").then((m) => m.generateManagerStandup(brokerageId)),
      import("@/lib/intelligence/manager-weekly-pnl").then((m) => m.generateManagerWeeklyPnl(brokerageId)),
      import("@/lib/intelligence/deliverables-summary").then((m) => m.generateDeliverablesSummary({ brokerageId })),
      import("@/lib/intelligence/retention-board").then((m) => m.generateRetentionBoard(brokerageId)),
      import("@/lib/intelligence/retention-outcomes").then((m) => m.generateRetentionOutcomeBoard(brokerageId)),
      import("@/lib/intelligence/skill-freshness-board").then((m) => m.generateSkillFreshnessBoard(brokerageId)),
      import("@/lib/intelligence/revenue-share-board").then((m) => m.generateRevenueShareBoard(brokerageId)),
      import("@/lib/intelligence/curriculum-board").then((m) => m.generateCurriculumBoard(brokerageId)),
    ])
    if (standupRes.status === "fulfilled") standup = standupRes.value
    else console.error("[command-center] manager standup failed:", standupRes.reason)
    if (pnlRes.status === "fulfilled") weeklyPnl = pnlRes.value
    else console.error("[command-center] manager weekly P&L failed:", pnlRes.reason)
    if (delivRes.status === "fulfilled") deliverables = delivRes.value
    else console.error("[command-center] deliverables summary failed:", delivRes.reason)
    if (retentionRes.status === "fulfilled") retentionBoard = retentionRes.value
    else console.error("[command-center] retention board failed:", retentionRes.reason)
    if (outcomesRes.status === "fulfilled") retentionOutcomes = outcomesRes.value
    else console.error("[command-center] retention outcomes failed:", outcomesRes.reason)
    if (skillRes.status === "fulfilled") skillBoard = skillRes.value
    else console.error("[command-center] skill board failed:", skillRes.reason)
    if (revShareRes.status === "fulfilled") revenueShareBoard = revShareRes.value
    else console.error("[command-center] revenue share board failed:", revShareRes.reason)
    if (curriculumRes.status === "fulfilled") curriculumBoard = curriculumRes.value
    else console.error("[command-center] curriculum board failed:", curriculumRes.reason)
  }

  // Proposed AI ISA dial batches awaiting approval — surfaced as a one-tap callout.
  let dialBatches: CommandCenterData["dialBatches"] = []
  let managerTalk: import("@/lib/kernel/manager-signals").ManagerTalkLine[] = []
  if (brokerageWide && brokerageId) {
    try {
      const { loadRecentManagerTalk } = await import("@/lib/kernel/manager-signals")
      managerTalk = await loadRecentManagerTalk(brokerageId, 12, supabase)
    } catch (err) {
      console.error("[command-center] manager talk failed:", err)
    }
    const { data: db } = await supabase
      .from("ai_isa_call_batches")
      .select("id, proposed_count, proposed_at")
      .eq("brokerage_id", brokerageId).eq("status", "proposed")
      .order("proposed_at", { ascending: true }).limit(50)
    dialBatches = ((db ?? []) as Array<{ id: string; proposed_count: number; proposed_at: string | null }>)
      .map((b) => ({ id: b.id, proposedCount: b.proposed_count ?? 0, proposedAt: b.proposed_at }))
  }

  // THE AI EXECUTIVE STANDUP — synthesize the weekly ROI-ranked plan over the already-computed boards +
  // the live approval backlog (managerBreakdown carries the real SLA-breached counts). Best-effort; reuses
  // the boards above so there are no double queries.
  let weeklyExecPlan: import("@/lib/intelligence/manager-weekly-exec-plan").WeeklyExecPlan | null = null
  if (brokerageWide && brokerageId) {
    try {
      const { loadWeeklyExecPlan } = await import("@/lib/intelligence/manager-weekly-exec-plan")
      weeklyExecPlan = await loadWeeklyExecPlan(brokerageId, {
        supabase, weeklyPnl, retentionBoard, curriculumBoard,
        managerBacklog: managerBreakdown.map((m) => ({ manager: m.key, breached: m.breached, pending: m.count })),
      })
    } catch (err) {
      console.error("[command-center] weekly exec plan failed:", err)
    }
  }

  return {
    sessions,
    pendingActions,
    managerBreakdown,
    standup,
    weeklyPnl,
    deliverables,
    retentionBoard,
    retentionOutcomes,
    skillBoard,
    revenueShareBoard,
    curriculumBoard,
    weeklyExecPlan,
    dialBatches,
    managerTalk,
    summary: {
      activeSessions:    sessions.filter((s) => s.status === "running").length,
      idleSessions:      sessions.filter((s) => s.status === "idle").length,
      erroredSessions:   sessions.filter((s) => s.status === "error").length,
      pendingApprovals:  pendingActions.length,
      breachedApprovals: pendingActions.filter((a) => a.slaLevel === "breached").length,
    },
  }
}
