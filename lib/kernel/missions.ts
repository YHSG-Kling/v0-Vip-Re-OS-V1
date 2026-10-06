/**
 * MISSIONS — the durable objective runtime (wave 104, lane 104D; owner scope 107). ONE kernel
 * service over `missions` + append-only `mission_events` (m710).
 *
 * SURVIVORS EVALUATED (none replaced — each is WIRED, see m710's header for the measurement):
 *   · agent_goals (app/actions/ai-agent-goals.ts) — a KPI row; a goal becomes a mission's
 *     objective (upsertAgentGoal → createMission, agent_goals.mission_id).
 *   · workflow_runs (lib/workflow-orchestrator/engine.ts) — a chain instance; a run started under
 *     a mission carries workflow_runs.mission_id and is attached as an action.
 *   · manager_signals / signal-registry — the coordination channel an escalation rides.
 *   · stale-run-reaper — THE reaper; it now also sweeps mission deadlines + stale blockers
 *     (sweepMissionDeadlines) — no second reaper.
 *   · MANAGERS (manager-registry) — owner_manager / participating_managers are registry keys.
 *   · action ledger + causation — every transition is an agent_action_ledger row
 *     (reason MISSION_LIFECYCLE, detail.mission_id) and a mission_events row carrying the
 *     causation / correlation of the scope it ran under (LAW 5).
 *   · autonomy gate / authority ladder — authority_ceiling = resolveAgentAuthorityLevel(owner).
 *   · mayUseAndAfford — entitlement at creation ("app.access": a lapsed tenant gets no mission).
 *
 * TENANT: every entry point takes the VERIFIED brokerageId (the session's — app/actions/missions.ts
 * resolves it through requireCallerTenant — or the event's / the cron's). Never a request body.
 * Every read and write is pinned to it; a mission id from another tenant matches nothing and the
 * caller is told (`not_found`), never silently succeeds.
 *
 * No `import "server-only"`: the proof (scripts/missions-guard.ts) drives the state machine through
 * an in-memory client, as the ledger and causation modules allow.
 *
 * WIRED (lane 104F — every door has its real caller):
 *   · escalateMission ← sweepMissionDeadlines (deadline passed / stale blocker) and the stale-run
 *     reaper (a stalled run under a mission); the engine (a non-workflow mission's run failed).
 *   · failMission ← sweepMissionDeadlines (ESCALATED, deadline passed, unanswered 72h) and the
 *     engine (a `workflow` mission's run failed).
 *   · completeMission ← recordMissionProgress (criteria met, deterministic) and the engine (a
 *     `workflow` mission's run completed).
 *   · recordMissionProgress ← the engine (steps_completed per run), app/actions/ai-agent-goals.ts
 *     (the goal's measured current_value) and syncMissionProgressFromTwin (twin-path criteria).
 *   · attachOutcome ← lib/intelligence/roi-ledger.ts recordMissionOutcomes (an attributed outcome
 *     whose last-touch action a mission owns), on the per-tenant learning cron.
 *   · decomposeObjective (twin) ← createMission, a brokerage_objective with no criteria.
 *   · registerTwinSeam("missions") at the bottom of this file, loaded by the Command Center build.
 */
import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"
import { currentCausation } from "@/lib/kernel/causation"
import { MIN_AUTHORITY_FOR_RISK, type AuthorityLevel, type ToolRiskClass } from "@/lib/ai-isa/persona-tool-policy"
import { KernelEvent } from "@/lib/kernel/events"
import { registerTwinSeam, decomposeObjective, readTwinMeasure, type BrokerageTwin } from "@/lib/kernel/brokerage-twin"

// ─── vocabularies (mirrors of the m710 CHECKs — one spelling, CLAUDE.md §6) ───────────────────
export const MISSION_STATES = ["PROPOSED", "PLANNING", "ACTIVE", "WAITING", "BLOCKED", "APPROVAL_REQUIRED", "ESCALATED", "COMPLETED", "FAILED", "CANCELLED"] as const
export type MissionState = (typeof MISSION_STATES)[number]
export const MISSION_TYPES = ["agent_goal", "brokerage_objective", "workflow", "campaign", "transaction", "recruiting", "compliance", "custom"] as const
export type MissionType = (typeof MISSION_TYPES)[number]
export const MISSION_PRIORITIES = ["low", "normal", "high", "critical"] as const
export type MissionPriority = (typeof MISSION_PRIORITIES)[number]
export const MISSION_TERMINAL_STATES: ReadonlySet<MissionState> = new Set(["COMPLETED", "FAILED", "CANCELLED"])
/** The states a human / manager must look at — the stand-up and the team-lead brief list these. */
export const MISSION_ATTENTION_STATES: ReadonlySet<MissionState> = new Set(["BLOCKED", "APPROVAL_REQUIRED", "ESCALATED"])
/** A BLOCKED mission nobody unblocked for this long is escalated by the reaper sweep; an ESCALATED
 *  mission whose deadline has passed and that nobody moved for this long is FAILED by the same
 *  sweep (the deadline hard-expired after escalation). ONE stale window, not two spellings. */
export const MISSION_BLOCKED_STALE_HOURS = 72
/** The ledger WHY of every transition (m710 widens agent_action_ledger_reason_code_check). */
export const MISSION_LIFECYCLE_REASON = "MISSION_LIFECYCLE"
/** The manager signal types an escalation publishes (catalogued in lib/kernel/signal-registry.ts). */
export const MISSION_ESCALATED_SIGNAL = "mission_escalated"
export const MISSION_APPROVAL_REQUIRED_SIGNAL = "mission_escalated_for_approval"

/**
 * THE STATE MACHINE. A transition not listed here is refused (recorded as a `refused`
 * mission_events row, never thrown). Terminal states have no exits.
 * @proofSeam the proof asserts every edge and every refusal directly
 */
export const MISSION_TRANSITIONS: Readonly<Record<MissionState, readonly MissionState[]>> = {
  PROPOSED:          ["PLANNING", "ACTIVE", "CANCELLED"],
  PLANNING:          ["ACTIVE", "BLOCKED", "APPROVAL_REQUIRED", "CANCELLED"],
  ACTIVE:            ["WAITING", "BLOCKED", "APPROVAL_REQUIRED", "ESCALATED", "COMPLETED", "FAILED", "CANCELLED"],
  WAITING:           ["ACTIVE", "BLOCKED", "APPROVAL_REQUIRED", "ESCALATED", "FAILED", "CANCELLED"],
  BLOCKED:           ["ACTIVE", "WAITING", "ESCALATED", "FAILED", "CANCELLED"],
  APPROVAL_REQUIRED: ["ACTIVE", "ESCALATED", "FAILED", "CANCELLED"],
  ESCALATED:         ["ACTIVE", "BLOCKED", "APPROVAL_REQUIRED", "COMPLETED", "FAILED", "CANCELLED"],
  COMPLETED:         [],
  FAILED:            [],
  CANCELLED:         [],
}

export function isMissionState(v: unknown): v is MissionState { return typeof v === "string" && (MISSION_STATES as readonly string[]).includes(v) }
export function canTransition(from: MissionState, to: MissionState): boolean { return MISSION_TRANSITIONS[from]?.includes(to) ?? false }

// ─── shapes ───────────────────────────────────────────────────────────────────────────────────
export interface SuccessCriterion { metric: string; op: ">=" | "<=" | "=="; target: number }
export interface MissionBudget { usd?: number | null; tokens?: number | null; on_exhausted?: "WAITING" | "APPROVAL_REQUIRED" }
export interface MissionBlocker { key: string; reason: string; added_at: string; cleared_at?: string | null }
export interface MissionActor { type: "manager" | "user" | "agent" | "system"; id?: string | null }

export interface MissionRow {
  id: string
  brokerage_id: string
  objective: string
  mission_type: MissionType
  owner_manager: ManagerKey
  participating_managers: ManagerKey[]
  subject_type: string | null
  subject_id: string | null
  state: MissionState
  priority: MissionPriority
  success_criteria: SuccessCriterion[]
  budget: MissionBudget
  spent_usd: number
  spent_tokens: number
  authority_ceiling: AuthorityLevel
  deadline: string | null
  dependencies: string[]
  blockers: MissionBlocker[]
  evidence: Array<Record<string, unknown>>
  progress: Record<string, number>
  actions: string[]
  outcomes: Array<Record<string, unknown>>
  created_by: string | null
  parent_mission: string | null
  state_changed_at: string
  completed_at: string | null
  created_at: string
  updated_at: string
}

export type MissionResult = { ok: true; mission: MissionRow } | { ok: false; reason: string; mission?: MissionRow }

type Client = { from: (table: string) => any }

/**
 * Test seams — every default is THE survivor (lazy imports keep this module off the proxy graph).
 * A proof swaps one to observe the evidence it writes; production never passes `deps`.
 */
export interface MissionDeps {
  now?: () => Date
  afford?: (brokerageId: string, client: Client) => Promise<{ allowed: boolean; reason: string }>
  authority?: (brokerageId: string, manager: ManagerKey, client: Client) => Promise<AuthorityLevel>
  ledger?: (ctx: LedgerCtx, client: Client) => Promise<string | null>
  emit?: (input: EmitCtx, client: Client) => Promise<void>
  signal?: (input: SignalCtx, client: Client) => Promise<void>
}
interface LedgerCtx { brokerageId: string; action: string; actor: MissionActor; missionId: string; from: MissionState | null; to: MissionState; reason: string; causationId: string | null; correlationId: string | null; costUsd?: number | null }
interface EmitCtx { brokerageId: string; event: string; missionId: string; metadata: Record<string, unknown>; actorUserId: string | null; causationId: string | null; correlationId: string | null }
interface SignalCtx { brokerageId: string; fromManager: ManagerKey; toManager: ManagerKey; signalType: string; message: string; missionId: string; payload: Record<string, unknown> }

const defaultDeps: Required<MissionDeps> = {
  now: () => new Date(),
  afford: async (brokerageId, client) => {
    const { mayUseAndAfford } = await import("@/lib/billing/billing-access")
    const d = await mayUseAndAfford({ brokerageId, capability: "app.access", client })
    return { allowed: d.allowed, reason: d.reason }
  },
  authority: async (brokerageId, manager, client) => {
    const { resolveAgentAuthorityLevel } = await import("@/lib/managers/autonomy-gate")
    return resolveAgentAuthorityLevel(brokerageId, manager, client as any)
  },
  ledger: async (ctx, client) => {
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    let id: string | null = null
    await withActionLedger(
      {
        brokerageId: ctx.brokerageId, action: ctx.action,
        actor: { type: ctx.actor.type, userId: ctx.actor.type === "user" ? ctx.actor.id ?? null : null, agentId: ctx.actor.type === "agent" ? ctx.actor.id ?? null : null, managerKey: ctx.actor.type === "manager" ? ctx.actor.id ?? null : null },
        subject: { type: "mission", id: ctx.missionId },
        reasonCode: MISSION_LIFECYCLE_REASON, reasonDetail: ctx.reason,
        causationId: ctx.causationId, correlationId: ctx.correlationId,
        riskClass: "LOW_RISK_WRITE", systemSource: "missions",
        detail: { mission_id: ctx.missionId, from_state: ctx.from, to_state: ctx.to },
      },
      async () => ({ status: "executed" as const, outcome: `${ctx.from ?? "∅"}→${ctx.to}` }),
      { settle: (r) => ({ status: r.status, outcome: r.outcome, costUsd: ctx.costUsd ?? null }), replay: () => ({ status: "executed" as const, outcome: "replay" }) },
      { client },
    )
    // The ledger row id is read back by the mission's subject (the claim does not return it here).
    const { data } = await client.from("agent_action_ledger").select("id").eq("subject_type", "mission").eq("subject_id", ctx.missionId).order("created_at", { ascending: false }).limit(1).maybeSingle()
    id = (data as { id?: string } | null)?.id ?? null
    return id
  },
  emit: async (input, client) => {
    const { emitKernelEvent } = await import("@/lib/kernel/emit")
    await emitKernelEvent({
      event: input.event, brokerageId: input.brokerageId, entityType: "mission", entityId: input.missionId,
      metadata: input.metadata, actorUserId: input.actorUserId, causationId: input.causationId, correlationId: input.correlationId,
      auditOnly: true, client,
    })
  },
  signal: async (input, client) => {
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    const r = await publishManagerSignal({
      brokerageId: input.brokerageId, fromManager: input.fromManager, toManager: input.toManager, signalType: input.signalType,
      message: input.message, entityType: "mission", entityId: input.missionId, payload: input.payload,
    }, client as any)
    if (!r.ok) console.error(`[missions] signal ${input.signalType} not published: ${r.reason}`)
  },
}

async function svcOf(client?: Client): Promise<Client> {
  if (client) return client
  const { createServiceClient } = await import("@/lib/supabase/service")
  return createServiceClient() as unknown as Client
}

function isManagerKey(v: unknown): v is ManagerKey { return typeof v === "string" && v in MANAGERS }

/** PURE, deterministic: every criterion met against the recorded progress. Unknown metric = unmet.
 *  @proofSeam the proof asserts the rule directly */
export function evaluateSuccess(criteria: SuccessCriterion[], progress: Record<string, number>): { met: boolean; unmet: string[] } {
  const unmet: string[] = []
  for (const c of criteria) {
    const v = progress[c.metric]
    const ok = typeof v === "number" && (c.op === ">=" ? v >= c.target : c.op === "<=" ? v <= c.target : v === c.target)
    if (!ok) unmet.push(`${c.metric} ${c.op} ${c.target} (is ${typeof v === "number" ? v : "unknown"})`)
  }
  return { met: unmet.length === 0, unmet }
}

/** PURE: is the budget exhausted after this spend? null budget = unmetered.
 *  @proofSeam the proof asserts the rule directly */
export function budgetExhausted(budget: MissionBudget, spentUsd: number, spentTokens: number): boolean {
  const usdCap = typeof budget.usd === "number" ? budget.usd : null
  const tokCap = typeof budget.tokens === "number" ? budget.tokens : null
  return (usdCap !== null && spentUsd >= usdCap) || (tokCap !== null && spentTokens >= tokCap)
}

/** PURE: may a mission at `ceiling` run an action of `riskClass`? (the ladder, persona-tool-policy)
 *  @proofSeam the proof asserts the rule directly */
export function withinAuthorityCeiling(ceiling: AuthorityLevel, riskClass: ToolRiskClass): boolean {
  const min = MIN_AUTHORITY_FOR_RISK[riskClass]
  if (min === null || min === undefined) return false // a class the ladder never grants autonomously
  return ceiling >= min
}

// ─── reads ────────────────────────────────────────────────────────────────────────────────────
export async function getMission(brokerageId: string, missionId: string, client?: Client): Promise<MissionRow | null> {
  const svc = await svcOf(client)
  const { data, error } = await svc.from("missions").select("*").eq("brokerage_id", brokerageId).eq("id", missionId).maybeSingle()
  if (error) { console.error(`[missions] read refused: ${error.message}`); return null }
  return (data as MissionRow | null) ?? null
}

export interface ActiveMissionsSummary {
  active: MissionRow[]
  attention: MissionRow[]
  counts: Record<MissionState, number>
  readRefused: string | null
}

/**
 * THE LAZY SEAM other layers read missions through (the digital twin — lane 104B — the morning
 * stand-up, the team-lead brief): every non-terminal mission of the tenant, optionally narrowed to
 * a subject or an agent (created_by), with the attention set (BLOCKED / APPROVAL_REQUIRED /
 * ESCALATED) pulled out. A refused read is PUBLISHED (readRefused), never an empty "all clear".
 */
export async function activeMissionsFor(
  brokerageId: string,
  opts: { subject?: { type: string; id: string } | null; createdBy?: string | null; ownerManager?: ManagerKey | null; limit?: number } = {},
  client?: Client,
): Promise<ActiveMissionsSummary> {
  const counts = Object.fromEntries(MISSION_STATES.map((s) => [s, 0])) as Record<MissionState, number>
  const out: ActiveMissionsSummary = { active: [], attention: [], counts, readRefused: null }
  if (!brokerageId) { out.readRefused = "no tenant"; return out }
  const svc = await svcOf(client)
  let q = svc.from("missions").select("*").eq("brokerage_id", brokerageId)
    .in("state", MISSION_STATES.filter((s) => !MISSION_TERMINAL_STATES.has(s)))
  if (opts.subject) q = q.eq("subject_type", opts.subject.type).eq("subject_id", opts.subject.id)
  if (opts.createdBy) q = q.eq("created_by", opts.createdBy)
  if (opts.ownerManager) q = q.eq("owner_manager", opts.ownerManager)
  const { data, error } = await q.order("priority", { ascending: false }).order("deadline", { ascending: true, nullsFirst: false }).limit(opts.limit ?? 200)
  if (error) { out.readRefused = error.message; return out }
  for (const m of (data ?? []) as MissionRow[]) {
    counts[m.state] = (counts[m.state] ?? 0) + 1
    out.active.push(m)
    if (MISSION_ATTENTION_STATES.has(m.state)) out.attention.push(m)
  }
  return out
}

// ─── evidence (append-only) ───────────────────────────────────────────────────────────────────
async function appendEvent(svc: Client, m: Pick<MissionRow, "id" | "brokerage_id">, e: {
  kind: "created" | "transition" | "refused" | "action_attached" | "outcome_attached" | "blocker_added" | "blocker_cleared" | "evidence" | "progress"
  from?: MissionState | null; to?: MissionState | null; reason?: string | null; reasonCode?: string | null
  actor: MissionActor; evidence?: Record<string, unknown>; ledgerEntryId?: string | null
}): Promise<void> {
  const c = currentCausation()
  const { error } = await svc.from("mission_events").insert({
    mission_id: m.id, brokerage_id: m.brokerage_id, event_kind: e.kind,
    from_state: e.from ?? null, to_state: e.to ?? null, reason_code: e.reasonCode ?? null, reason: e.reason ?? null,
    actor_type: e.actor.type, actor_id: e.actor.id ?? null, evidence: e.evidence ?? {},
    ledger_entry_id: e.ledgerEntryId ?? null, causation_id: c.causationId, correlation_id: c.correlationId,
  })
  if (error) console.error(`[missions] mission_events append refused (${e.kind}): ${error.message}`)
}

// ─── create ───────────────────────────────────────────────────────────────────────────────────
export interface CreateMissionInput {
  /** VERIFIED tenant (session / event / cron) — never a request body. */
  brokerageId: string
  objective: string
  missionType?: MissionType
  ownerManager: ManagerKey
  participatingManagers?: ManagerKey[]
  subject?: { type: string; id: string } | null
  priority?: MissionPriority
  successCriteria?: SuccessCriterion[]
  budget?: MissionBudget
  deadline?: string | null
  dependencies?: string[]
  createdBy?: string | null
  parentMission?: string | null
  actor?: MissionActor
  /** Start PROPOSED (default) or go straight to ACTIVE (a goal the agent already committed to). */
  initialState?: "PROPOSED" | "PLANNING" | "ACTIVE"
  /**
   * A brokerage_objective in the agent_goals vocabulary (goal type + target). When no successCriteria
   * are given, the criteria are DERIVED through the twin's decomposition (lib/kernel/brokerage-twin.ts
   * decomposeObjective): one criterion per supported sub-target, each keyed on the twin field that
   * measures it, so the Command Center's twin build measures the mission (syncMissionProgressFromTwin).
   * A twin handed in sharpens the sub-targets (closings needed at the brokerage's own average).
   */
  objectiveSpec?: { goalType: string; targetValue: number; currentValue?: number } | null
  twin?: BrokerageTwin | null
}

/** PURE: the success criteria a decomposed objective yields — the supported sub-targets, keyed on
 *  the twin field that measures each (metric = the dotted twin path; a mission criterion whose
 *  metric contains "." is a twin measure, written by syncMissionProgressFromTwin). */
export function criteriaFromDecomposition(d: ReturnType<typeof decomposeObjective>): SuccessCriterion[] {
  const out: SuccessCriterion[] = []
  const seen = new Set<string>()
  for (const s of d.subTargets) {
    if (s.status !== "ok" || s.measuredBy === null || typeof s.target !== "number" || seen.has(s.measuredBy)) continue
    seen.add(s.measuredBy)
    out.push({ metric: s.measuredBy, op: ">=", target: s.target })
  }
  return out
}

export async function createMission(input: CreateMissionInput, client?: Client, deps: MissionDeps = {}): Promise<MissionResult> {
  const d = { ...defaultDeps, ...deps }
  const svc = await svcOf(client)
  if (!input.brokerageId) return { ok: false, reason: "no_tenant" }
  if (!input.objective?.trim()) return { ok: false, reason: "objective_required" }
  if (!isManagerKey(input.ownerManager)) return { ok: false, reason: `unknown_owner_manager:${String(input.ownerManager)}` }
  const participants = [...new Set((input.participatingManagers ?? []).filter((k) => k !== input.ownerManager))]
  const bad = participants.find((k) => !isManagerKey(k))
  if (bad) return { ok: false, reason: `unknown_participating_manager:${String(bad)}` }
  if (input.missionType && !(MISSION_TYPES as readonly string[]).includes(input.missionType)) return { ok: false, reason: `unknown_mission_type:${input.missionType}` }
  if (input.priority && !(MISSION_PRIORITIES as readonly string[]).includes(input.priority)) return { ok: false, reason: `unknown_priority:${input.priority}` }

  // ENTITLEMENT (LAW: every build integrates mayUseAndAfford) — a tenant that may not use the OS
  // gets no mission. Fail closed: a refused answer is a refusal.
  const afford = await d.afford(input.brokerageId, svc)
  if (!afford.allowed) return { ok: false, reason: `entitlement:${afford.reason}` }

  // AUTHORITY CEILING from the ladder for the OWNER manager (managed_agents.config.authority_level).
  const ceiling = await d.authority(input.brokerageId, input.ownerManager, svc)
  const actor: MissionActor = input.actor ?? (input.createdBy ? { type: "user", id: input.createdBy } : { type: "manager", id: input.ownerManager })
  const state: MissionState = input.initialState ?? "PROPOSED"

  // A brokerage objective with no criteria of its own is DECOMPOSED through the twin (104B's
  // decomposeObjective): the criteria are the supported sub-targets, each keyed on the twin field
  // that measures it. An unsupported decomposition yields no criteria and is recorded as evidence —
  // the mission still exists; it completes only once a human gives it measurable criteria.
  let successCriteria = input.successCriteria ?? []
  let decomposition: ReturnType<typeof decomposeObjective> | null = null
  if ((input.missionType ?? "custom") === "brokerage_objective" && successCriteria.length === 0 && input.objectiveSpec) {
    decomposition = decomposeObjective(input.objectiveSpec, input.twin ?? null)
    successCriteria = criteriaFromDecomposition(decomposition)
  }

  const { data, error } = await svc.from("missions").insert({
    brokerage_id: input.brokerageId, objective: input.objective.trim(), mission_type: input.missionType ?? "custom",
    owner_manager: input.ownerManager, participating_managers: participants,
    subject_type: input.subject?.type ?? null, subject_id: input.subject?.id ?? null,
    state, priority: input.priority ?? "normal",
    success_criteria: successCriteria, budget: input.budget ?? {},
    authority_ceiling: ceiling, deadline: input.deadline ?? null, dependencies: input.dependencies ?? [],
    created_by: input.createdBy ?? null, parent_mission: input.parentMission ?? null,
  }).select("*").single()
  if (error || !data) return { ok: false, reason: `insert_refused:${error?.message ?? "no row"}` }
  const mission = data as MissionRow

  const c = currentCausation()
  const ledgerId = await d.ledger({ brokerageId: mission.brokerage_id, action: "mission.objective.create", actor, missionId: mission.id, from: null, to: state, reason: `created: ${mission.objective}`, causationId: c.causationId, correlationId: c.correlationId }, svc)
  await appendEvent(svc, mission, { kind: "created", to: state, reasonCode: MISSION_LIFECYCLE_REASON, reason: "created", actor, ledgerEntryId: ledgerId, evidence: { owner_manager: mission.owner_manager, participating_managers: participants, authority_ceiling: ceiling, entitlement: afford.reason, ...(decomposition ? { decomposition: { goal_type: decomposition.goalType, status: decomposition.status, remaining: decomposition.remaining, reason: decomposition.reason ?? null, sub_targets: decomposition.subTargets, criteria_derived: successCriteria.length } } : {}) } })
  await d.emit({ brokerageId: mission.brokerage_id, event: KernelEvent.MISSION_CREATED, missionId: mission.id, metadata: { mission_id: mission.id, state, owner_manager: mission.owner_manager, objective: mission.objective }, actorUserId: input.createdBy ?? null, causationId: c.causationId, correlationId: c.correlationId }, svc)
  return { ok: true, mission }
}

// ─── transition (the one writer of `state`) ───────────────────────────────────────────────────
export interface TransitionInput {
  brokerageId: string
  missionId: string
  to: MissionState
  reason: string
  actor?: MissionActor
  evidence?: Record<string, unknown>
}

export async function transitionMission(input: TransitionInput, client?: Client, deps: MissionDeps = {}): Promise<MissionResult> {
  const d = { ...defaultDeps, ...deps }
  const svc = await svcOf(client)
  const actor = input.actor ?? { type: "system" }
  const m = await getMission(input.brokerageId, input.missionId, svc)
  if (!m) return { ok: false, reason: "not_found" }
  // The pre-move state, captured BEFORE the update (a client that hands back live row objects
  // would otherwise show the evidence the post-move state).
  const from: MissionState = m.state
  if (!isMissionState(input.to)) return { ok: false, reason: `unknown_state:${String(input.to)}`, mission: m }
  if (!canTransition(m.state, input.to)) {
    await appendEvent(svc, m, { kind: "refused", from: m.state, to: input.to, reason: `refused: ${m.state} → ${input.to} is not a transition (${input.reason})`, reasonCode: MISSION_LIFECYCLE_REASON, actor, evidence: input.evidence })
    return { ok: false, reason: `invalid_transition:${m.state}->${input.to}`, mission: m }
  }
  // Completing is judged against the success criteria, deterministically — never by assertion.
  if (input.to === "COMPLETED") {
    const verdict = evaluateSuccess(m.success_criteria ?? [], m.progress ?? {})
    if (!verdict.met) {
      await appendEvent(svc, m, { kind: "refused", from: m.state, to: "COMPLETED", reason: `refused: success criteria unmet — ${verdict.unmet.join("; ")}`, reasonCode: MISSION_LIFECYCLE_REASON, actor, evidence: { unmet: verdict.unmet } })
      return { ok: false, reason: `criteria_unmet:${verdict.unmet.join("; ")}`, mission: m }
    }
  }
  const now = d.now().toISOString()
  const patch: Record<string, unknown> = { state: input.to, state_changed_at: now, updated_at: now }
  if (MISSION_TERMINAL_STATES.has(input.to)) patch.completed_at = now
  const { data: updated, error } = await svc.from("missions").update(patch).eq("brokerage_id", input.brokerageId).eq("id", m.id).eq("state", m.state).select("*")
  if (error) return { ok: false, reason: `update_refused:${error.message}`, mission: m }
  if (!Array.isArray(updated) || updated.length !== 1) return { ok: false, reason: "raced:state_moved_under_us", mission: m }
  const next = updated[0] as MissionRow

  const c = currentCausation()
  const ledgerId = await d.ledger({ brokerageId: m.brokerage_id, action: "mission.state.transition", actor, missionId: m.id, from, to: input.to, reason: input.reason, causationId: c.causationId, correlationId: c.correlationId }, svc)
  await appendEvent(svc, m, { kind: "transition", from, to: input.to, reason: input.reason, reasonCode: MISSION_LIFECYCLE_REASON, actor, ledgerEntryId: ledgerId, evidence: input.evidence })
  await d.emit({ brokerageId: m.brokerage_id, event: KernelEvent.MISSION_STATE_CHANGED, missionId: m.id, metadata: { mission_id: m.id, from_state: from, to_state: input.to, reason: input.reason, owner_manager: m.owner_manager }, actorUserId: actor.type === "user" ? actor.id ?? null : null, causationId: c.causationId, correlationId: c.correlationId }, svc)

  // COORDINATION: an escalation / approval need is told to the owner manager through the signal
  // bus (signal-registry catalogues both types) and, for APPROVAL_REQUIRED, to the human who owns it.
  if (input.to === "ESCALATED" || input.to === "APPROVAL_REQUIRED") {
    const fromMgr: ManagerKey = actor.type === "manager" && isManagerKey(actor.id) && actor.id !== m.owner_manager ? actor.id : "cron_manager"
    const toMgr: ManagerKey = m.owner_manager === fromMgr ? (m.participating_managers?.[0] ?? "data_steward") : m.owner_manager
    await d.signal({ brokerageId: m.brokerage_id, fromManager: fromMgr, toManager: toMgr, signalType: input.to === "ESCALATED" ? MISSION_ESCALATED_SIGNAL : MISSION_APPROVAL_REQUIRED_SIGNAL, message: `Mission "${m.objective}" is ${input.to}: ${input.reason}`, missionId: m.id, payload: { from_state: from, reason: input.reason, deadline: m.deadline, priority: m.priority } }, svc)
    if (input.to === "APPROVAL_REQUIRED" && m.created_by) {
      const { error: nErr } = await svc.from("notifications").insert({
        user_id: m.created_by, brokerage_id: m.brokerage_id, type: "mission_approval_required",
        title: "A mission needs your approval", body: `"${m.objective}" is waiting on you: ${input.reason}`,
        entity_type: "mission", entity_id: m.id, priority: m.priority === "critical" ? "high" : "medium", is_read: false,
      })
      if (nErr) console.error(`[missions] approval notification refused: ${nErr.message}`)
    }
  }
  return { ok: true, mission: next }
}

// ─── blockers / escalation / completion ───────────────────────────────────────────────────────
export async function blockMission(p: { brokerageId: string; missionId: string; key: string; reason: string; actor?: MissionActor }, client?: Client, deps: MissionDeps = {}): Promise<MissionResult> {
  const d = { ...defaultDeps, ...deps }
  const svc = await svcOf(client)
  const m = await getMission(p.brokerageId, p.missionId, svc)
  if (!m) return { ok: false, reason: "not_found" }
  const blockers = [...(m.blockers ?? []).filter((b) => b.key !== p.key || b.cleared_at), { key: p.key, reason: p.reason, added_at: d.now().toISOString(), cleared_at: null }]
  const { error } = await svc.from("missions").update({ blockers, updated_at: d.now().toISOString() }).eq("brokerage_id", p.brokerageId).eq("id", m.id).select("id")
  if (error) return { ok: false, reason: `update_refused:${error.message}`, mission: m }
  await appendEvent(svc, m, { kind: "blocker_added", reason: `${p.key}: ${p.reason}`, actor: p.actor ?? { type: "system" }, evidence: { key: p.key } })
  if (m.state === "BLOCKED") return { ok: true, mission: { ...m, blockers } }
  return transitionMission({ brokerageId: p.brokerageId, missionId: m.id, to: "BLOCKED", reason: `blocked: ${p.key} — ${p.reason}`, actor: p.actor }, svc, deps)
}

export async function unblockMission(p: { brokerageId: string; missionId: string; key: string; reason: string; actor?: MissionActor }, client?: Client, deps: MissionDeps = {}): Promise<MissionResult> {
  const d = { ...defaultDeps, ...deps }
  const svc = await svcOf(client)
  const m = await getMission(p.brokerageId, p.missionId, svc)
  if (!m) return { ok: false, reason: "not_found" }
  const now = d.now().toISOString()
  const blockers = (m.blockers ?? []).map((b) => (b.key === p.key && !b.cleared_at ? { ...b, cleared_at: now } : b))
  const { error } = await svc.from("missions").update({ blockers, updated_at: now }).eq("brokerage_id", p.brokerageId).eq("id", m.id).select("id")
  if (error) return { ok: false, reason: `update_refused:${error.message}`, mission: m }
  await appendEvent(svc, m, { kind: "blocker_cleared", reason: `${p.key}: ${p.reason}`, actor: p.actor ?? { type: "system" }, evidence: { key: p.key } })
  const open = blockers.some((b) => !b.cleared_at)
  if (open || m.state !== "BLOCKED") return { ok: true, mission: { ...m, blockers } }
  return transitionMission({ brokerageId: p.brokerageId, missionId: m.id, to: "ACTIVE", reason: `unblocked: ${p.key} — ${p.reason}`, actor: p.actor }, svc, deps)
}

export async function escalateMission(p: { brokerageId: string; missionId: string; reason: string; actor?: MissionActor; needsHuman?: boolean }, client?: Client, deps: MissionDeps = {}): Promise<MissionResult> {
  return transitionMission({ brokerageId: p.brokerageId, missionId: p.missionId, to: p.needsHuman ? "APPROVAL_REQUIRED" : "ESCALATED", reason: p.reason, actor: p.actor }, client, deps)
}

export async function completeMission(p: { brokerageId: string; missionId: string; reason: string; actor?: MissionActor }, client?: Client, deps: MissionDeps = {}): Promise<MissionResult> {
  return transitionMission({ brokerageId: p.brokerageId, missionId: p.missionId, to: "COMPLETED", reason: p.reason, actor: p.actor }, client, deps)
}

export async function failMission(p: { brokerageId: string; missionId: string; reason: string; actor?: MissionActor }, client?: Client, deps: MissionDeps = {}): Promise<MissionResult> {
  return transitionMission({ brokerageId: p.brokerageId, missionId: p.missionId, to: "FAILED", reason: p.reason, actor: p.actor }, client, deps)
}

/**
 * Record measured progress — the writers are the surveys that read the real tables: the goal sync
 * (app/actions/ai-agent-goals.ts syncGoalCurrentValues / updateGoalProgress → the goal's metric), the
 * workflow engine (steps_completed per run) and the twin build (syncMissionProgressFromTwin → the
 * twin-path metrics). COMPLETION IS DETERMINISTIC: when the recorded progress meets every success
 * criterion and the state admits it (ACTIVE / ESCALATED), the mission is COMPLETED here, through
 * completeMission — never asserted by a caller. A mission with NO criteria never completes on
 * progress alone (an empty criteria set is "nothing measurable yet", not "done").
 */
export async function recordMissionProgress(p: { brokerageId: string; missionId: string; progress: Record<string, number>; actor?: MissionActor }, client?: Client, deps: MissionDeps = {}): Promise<MissionResult & { completed?: boolean }> {
  const d = { ...defaultDeps, ...deps }
  const svc = await svcOf(client)
  const m = await getMission(p.brokerageId, p.missionId, svc)
  if (!m) return { ok: false, reason: "not_found" }
  if (MISSION_TERMINAL_STATES.has(m.state)) return { ok: false, reason: `terminal:${m.state}`, mission: m }
  const progress = { ...(m.progress ?? {}), ...p.progress }
  const { error } = await svc.from("missions").update({ progress, updated_at: d.now().toISOString() }).eq("brokerage_id", p.brokerageId).eq("id", m.id).select("id")
  if (error) return { ok: false, reason: `update_refused:${error.message}`, mission: m }
  const verdict = evaluateSuccess(m.success_criteria ?? [], progress)
  await appendEvent(svc, m, { kind: "progress", actor: p.actor ?? { type: "system" }, evidence: { progress: p.progress, verdict } })
  if (verdict.met && (m.success_criteria?.length ?? 0) > 0 && canTransition(m.state, "COMPLETED")) {
    const done = await completeMission({ brokerageId: p.brokerageId, missionId: m.id, reason: `success criteria met on progress: ${Object.entries(p.progress).map(([k, v]) => `${k}=${v}`).join(", ")}`, actor: p.actor }, svc, deps)
    return done.ok ? { ...done, completed: true } : { ok: true, mission: { ...m, progress }, completed: false }
  }
  return { ok: true, mission: { ...m, progress }, completed: false }
}

/**
 * THE TWIN MEASURES THE OBJECTIVE. For every non-terminal mission whose criteria name twin fields
 * (dotted paths — the criteria createMission derives for a brokerage_objective), read each field
 * from the twin the Command Center just built and record it as progress (which completes the
 * mission when every criterion is met). Called after buildBrokerageTwin (lib/kernel/command-center.ts).
 * A field the twin does not carry is skipped (unknown = unmet), never written as 0.
 */
export async function syncMissionProgressFromTwin(twin: BrokerageTwin, client?: Client, deps: MissionDeps = {}): Promise<{ scanned: number; measured: number; completed: number; readRefused: string | null }> {
  const out = { scanned: 0, measured: 0, completed: 0, readRefused: null as string | null }
  if (!twin?.brokerageId) return out
  const svc = await svcOf(client)
  const list = await activeMissionsFor(twin.brokerageId, { limit: 500 }, svc)
  if (list.readRefused) { out.readRefused = list.readRefused; return out }
  for (const m of list.active) {
    const twinMetrics = (m.success_criteria ?? []).filter((c) => c.metric.includes("."))
    if (twinMetrics.length === 0) continue
    out.scanned++
    const progress: Record<string, number> = {}
    for (const c of twinMetrics) { const v = readTwinMeasure(twin, c.metric); if (v !== null) progress[c.metric] = v }
    if (Object.keys(progress).length === 0) continue
    const r = await recordMissionProgress({ brokerageId: twin.brokerageId, missionId: m.id, progress, actor: { type: "system", id: "brokerage-twin" } }, svc, deps)
    if (r.ok) { out.measured++; if (r.completed) out.completed++ }
  }
  return out
}

// ─── actions + outcomes ───────────────────────────────────────────────────────────────────────
/**
 * Link an agent_action_ledger row (or a workflow run) to the mission, charge its cost against the
 * budget (the usage/cost vocabulary: cost_usd + tokens) and enforce the AUTHORITY CEILING: an
 * action whose risk class the ceiling does not admit is refused and the mission goes to
 * APPROVAL_REQUIRED; an exhausted budget moves it to budget.on_exhausted (default APPROVAL_REQUIRED).
 */
export async function attachAction(p: {
  brokerageId: string; missionId: string; ledgerEntryId: string; riskClass?: ToolRiskClass | null
  costUsd?: number | null; tokens?: number | null; actor?: MissionActor; detail?: Record<string, unknown>
}, client?: Client, deps: MissionDeps = {}): Promise<MissionResult & { refusedAction?: boolean }> {
  const d = { ...defaultDeps, ...deps }
  const svc = await svcOf(client)
  const m = await getMission(p.brokerageId, p.missionId, svc)
  if (!m) return { ok: false, reason: "not_found" }
  const actor = p.actor ?? { type: "system" }
  if (MISSION_TERMINAL_STATES.has(m.state)) return { ok: false, reason: `terminal:${m.state}`, mission: m }
  if (p.riskClass && !withinAuthorityCeiling(m.authority_ceiling, p.riskClass)) {
    await appendEvent(svc, m, { kind: "refused", reason: `action ${p.ledgerEntryId} refused: ${p.riskClass} exceeds authority ceiling ${m.authority_ceiling}`, reasonCode: MISSION_LIFECYCLE_REASON, actor, evidence: { ledger_entry_id: p.ledgerEntryId, risk_class: p.riskClass, ceiling: m.authority_ceiling } })
    const moved = m.state === "APPROVAL_REQUIRED" ? { ok: true as const, mission: m } : await transitionMission({ brokerageId: p.brokerageId, missionId: m.id, to: "APPROVAL_REQUIRED", reason: `authority ceiling ${m.authority_ceiling} does not admit a ${p.riskClass} action`, actor }, svc, deps)
    return { ...moved, ok: false, reason: `authority_ceiling:${p.riskClass}>${m.authority_ceiling}`, refusedAction: true }
  }
  const spentUsd = Number(m.spent_usd ?? 0) + Math.max(0, p.costUsd ?? 0)
  const spentTokens = Number(m.spent_tokens ?? 0) + Math.max(0, p.tokens ?? 0)
  const actions = m.actions?.includes(p.ledgerEntryId) ? m.actions : [...(m.actions ?? []), p.ledgerEntryId]
  const { error } = await svc.from("missions").update({ actions, spent_usd: spentUsd, spent_tokens: spentTokens, updated_at: d.now().toISOString() }).eq("brokerage_id", p.brokerageId).eq("id", m.id).select("id")
  if (error) return { ok: false, reason: `update_refused:${error.message}`, mission: m }
  await appendEvent(svc, m, { kind: "action_attached", actor, evidence: { ledger_entry_id: p.ledgerEntryId, risk_class: p.riskClass ?? null, cost_usd: p.costUsd ?? 0, tokens: p.tokens ?? 0, spent_usd: spentUsd, spent_tokens: spentTokens, ...(p.detail ?? {}) } })
  const next: MissionRow = { ...m, actions, spent_usd: spentUsd, spent_tokens: spentTokens }
  if (budgetExhausted(m.budget ?? {}, spentUsd, spentTokens) && !MISSION_ATTENTION_STATES.has(m.state) && m.state !== "WAITING") {
    const to = m.budget?.on_exhausted === "WAITING" ? "WAITING" : "APPROVAL_REQUIRED"
    return transitionMission({ brokerageId: p.brokerageId, missionId: m.id, to, reason: `budget exhausted: $${spentUsd.toFixed(2)} / ${spentTokens} tokens against ${JSON.stringify(m.budget)}`, actor }, svc, deps)
  }
  return { ok: true, mission: next }
}

/** Attribute an outcome (roi-ledger vocabulary: reply / appointment / contract / closed GCI …) to the mission. */
export async function attachOutcome(p: {
  brokerageId: string; missionId: string
  outcome: { kind: string; entityType: string; entityId: string; valueUsd?: number | null; occurredAt?: string | null; ledgerEntryId?: string | null }
  progressMetric?: string | null; actor?: MissionActor
}, client?: Client, deps: MissionDeps = {}): Promise<MissionResult & { duplicate?: boolean }> {
  const d = { ...defaultDeps, ...deps }
  const svc = await svcOf(client)
  const m = await getMission(p.brokerageId, p.missionId, svc)
  if (!m) return { ok: false, reason: "not_found" }
  // IDEMPOTENT on (kind, entityType, entityId): the attribution pass re-runs on every cron tick and
  // must never count one closing twice (a wrong number here is a wrong objective).
  const dup = (m.outcomes ?? []).some((o) => o.kind === p.outcome.kind && o.entityType === p.outcome.entityType && o.entityId === p.outcome.entityId)
  if (dup) return { ok: true, mission: m, duplicate: true }
  const row = { ...p.outcome, occurredAt: p.outcome.occurredAt ?? d.now().toISOString() }
  const outcomes = [...(m.outcomes ?? []), row]
  const progress = { ...(m.progress ?? {}) }
  if (p.progressMetric) progress[p.progressMetric] = (progress[p.progressMetric] ?? 0) + (typeof p.outcome.valueUsd === "number" && p.progressMetric.endsWith("_usd") ? p.outcome.valueUsd : 1)
  const { error } = await svc.from("missions").update({ outcomes, progress, updated_at: d.now().toISOString() }).eq("brokerage_id", p.brokerageId).eq("id", m.id).select("id")
  if (error) return { ok: false, reason: `update_refused:${error.message}`, mission: m }
  await appendEvent(svc, m, { kind: "outcome_attached", actor: p.actor ?? { type: "system" }, evidence: { ...row, progress_metric: p.progressMetric ?? null } })
  return { ok: true, mission: { ...m, outcomes, progress } }
}

// ─── the reaper pass (called from the ONE stale-run reaper) ───────────────────────────────────
export interface MissionSweepResult { scanned: number; escalated: number; failed: number; readRefused: string | null }

/**
 * Deadlines + stale blockers, swept on the existing reaper tick (lib/workflow-orchestrator/
 * stale-run-reaper.ts → reaper-net). A non-terminal mission past its deadline, or BLOCKED longer
 * than MISSION_BLOCKED_STALE_HOURS, is ESCALATED through escalateMission (the owner manager is
 * signalled). An ESCALATED mission whose deadline has passed and that nobody moved for another
 * MISSION_BLOCKED_STALE_HOURS is FAILED through failMission — the deadline hard-expired after the
 * escalation went unanswered. Idempotent: a freshly ESCALATED mission is left alone until the window.
 */
export async function sweepMissionDeadlines(brokerageId: string, client?: Client, opts: { now?: Date; limit?: number } = {}, deps: MissionDeps = {}): Promise<MissionSweepResult> {
  const now = opts.now ?? new Date()
  const result: MissionSweepResult = { scanned: 0, escalated: 0, failed: 0, readRefused: null }
  if (!brokerageId) return result
  const svc = await svcOf(client)
  const { data, error } = await svc.from("missions").select("id, state, deadline, state_changed_at, objective")
    .eq("brokerage_id", brokerageId)
    .in("state", MISSION_STATES.filter((s) => !MISSION_TERMINAL_STATES.has(s)))
    .limit(opts.limit ?? 200)
  if (error) { result.readRefused = error.message; return result }
  const sweepDeps = { ...deps, now: () => now }
  const cron: MissionActor = { type: "manager", id: "cron_manager" }
  for (const m of (data ?? []) as Array<Pick<MissionRow, "id" | "state" | "deadline" | "state_changed_at" | "objective">>) {
    const pastDeadline = !!m.deadline && new Date(m.deadline).getTime() < now.getTime()
    const hoursInState = m.state_changed_at ? (now.getTime() - new Date(m.state_changed_at).getTime()) / 3_600_000 : 0
    if (m.state === "ESCALATED") {
      // Hard expiry: escalated, deadline passed, and the escalation went unanswered for the window.
      if (!pastDeadline || hoursInState < MISSION_BLOCKED_STALE_HOURS) continue
      result.scanned++
      const r = await failMission({ brokerageId, missionId: m.id, reason: `deadline ${m.deadline} hard-expired: escalated ${Math.round(hoursInState)}h ago and nobody moved it (reaped)`, actor: cron }, svc, sweepDeps)
      if (r.ok) result.failed++
      continue
    }
    result.scanned++
    const staleBlock = m.state === "BLOCKED" && hoursInState >= MISSION_BLOCKED_STALE_HOURS
    if (!pastDeadline && !staleBlock) continue
    const reason = pastDeadline ? `deadline ${m.deadline} passed (reaped)` : `blocked for ${Math.round(hoursInState)}h with nobody unblocking it (reaped)`
    const r = await escalateMission({ brokerageId, missionId: m.id, reason, actor: cron }, svc, sweepDeps)
    if (r.ok) result.escalated++
  }
  return result
}

// ─── the twin seam (lib/kernel/brokerage-twin.ts registerTwinSeam) ───────────────────────────
// Registered AT MODULE LOAD: the Command Center's twin build lazy-imports this module before
// buildBrokerageTwin, so objectives.missions reads "present" with the live non-terminal count. The
// seam degrades on its own refusal (the twin names it in blindSpots) — never a fake 0.
registerTwinSeam("missions", async (svc, brokerageId, teamId) => {
  const r = await activeMissionsFor(brokerageId, { limit: 500 }, svc as Client)
  if (r.readRefused) throw new Error(`missions read refused: ${r.readRefused}`)
  // A team's board: the missions its own members created (created_by ∈ the team's users is resolved
  // by the caller's scope; the count here is the tenant's — the team sees its attention set through
  // the team-lead brief). Published as the source so the evidence names the narrowing.
  return { active: r.active.length, source: teamId ? `missions (brokerage-wide; team ${teamId} sees its attention set via the team-lead brief)` : "missions (lib/kernel/missions.ts activeMissionsFor)" }
})
