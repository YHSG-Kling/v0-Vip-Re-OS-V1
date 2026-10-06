/**
 * EXECUTIVE MISSION CONTROLLER (wave 105, lane 105B; owner: "an executive mission controller
 * runtime above the managers — who owns, who participates, progress, dependencies, disagreement,
 * budget, authority, human intervention — coordinates, never does the managers' jobs; not a giant
 * LLM manager"). A DETERMINISTIC supervisor loop: one pure plan per mission (planMissionControl),
 * one thin I/O pass per tenant tick (controlMissions), no model call anywhere.
 *
 * SURVIVORS EVALUATED (none replaced — this file is the LOOP only; every write goes through the one
 * mission service, lib/kernel/missions.ts):
 *   · missions.ts — the state machine (transitionMission), the reaper pass (sweepMissionDeadlines:
 *     deadlines + stale blockers + hard expiry), budgetExhausted / withinAuthorityCeiling, escalation
 *     signals + the creator's notification. The controller ADDS the verdicts the sweep does not
 *     judge (ownership, participation, stalled progress, dependencies, disagreement, a budget or
 *     authority gap that arrived without an attachAction) and moves state ONLY through that file.
 *   · brokerage-twin decomposeObjective — a brokerage_objective's criteria are its sub-targets,
 *     keyed on the twin field that measures each; participation is derived from those SAME keys.
 *   · lib/agentic-os/capability-ownership.ts CAPABILITY_MANAGER — THE registry map capability →
 *     accountable manager. Ownership and participation here are capability keys resolved through
 *     it (and TABLE_MANAGER for mission types whose domain is a table); never a retyped seat list.
 *   · MANAGER_COLLABORATIONS — the licensed co-work; a sub-target that rides a collaboration
 *     domain enlists that domain's managers (ads_manager has no AppCapability of its own; it joins a
 *     listing objective through listing_launch_play, exactly as the registry licenses).
 *   · autonomy gate / authority ladder — MIN_AUTHORITY_FOR_RISK is the one rung table; the
 *     mission's ceiling is the owner manager's rung (missions.ts createMission).
 *   · 105A manager_delegations — read through a LAZY SEAM (deps.delegations) that degrades to
 *     "no delegations, read refused: <why>" when the table is not there yet; never a fake 0.
 *   · stale-run-reaper → reaper-net cron — THE tick. The controller runs right after
 *     sweepMissionDeadlines on the same tenant pass (one loop), bounded batch, ledgered summary.
 *
 * VERDICT → ACTION (one transition per mission per tick, in this order; the first applicable wins,
 * every other finding is still recorded as a flag):
 *   disagreement  open DISSENTED delegation(s)            → APPROVAL_REQUIRED (escalateMission needsHuman)
 *   authority     required rung > authority_ceiling        → ESCALATED (the owner manager is signalled)
 *   budget        spent ≥ budget                           → budget.on_exhausted (WAITING / APPROVAL_REQUIRED)
 *   dependency    a dependency FAILED / CANCELLED / absent → BLOCKED (blockMission, key dependency:<id>)
 *   dependency    a dependency still running               → WAITING
 *   stalled       ACTIVE, no activity for the stale window → ESCALATED
 *   resume        WAITING on dependencies now all done     → ACTIVE
 * A mission a human is already looking at (BLOCKED / APPROVAL_REQUIRED / ESCALATED) is never
 * bounced. A finding a human has ANSWERED (they moved the mission after the controller raised it)
 * is carried as acknowledged and not re-raised while that decision stands — no ping-pong.
 *
 * EVIDENCE: every verdict is a mission_events `evidence` row (reason_code MISSION_CONTROL) carrying
 * the reasons and a digest; a re-run with nothing changed writes nothing (idempotent). Every
 * transition is the usual mission_events + agent_action_ledger pair; a tick that moved or judged
 * something writes ONE summary ledger row (mission.control.sweep).
 *
 * No `import "server-only"`: the proof (scripts/mission-controller-guard.ts) drives the loop
 * through an in-memory client with the REAL registry.
 */
import { MANAGERS, MANAGER_COLLABORATIONS, TABLE_MANAGER, type ManagerKey } from "@/lib/kernel/manager-registry"
import { CAPABILITY_MANAGER } from "@/lib/agentic-os/capability-ownership"
import { APP_CAPABILITY_REGISTRY, type AppCapability } from "@/lib/agentic-os/app-capability-registry"
import { MIN_AUTHORITY_FOR_RISK, type AuthorityLevel, type ToolRiskClass } from "@/lib/ai-isa/persona-tool-policy"
import { OBJECTIVE_MEASURES } from "@/lib/kernel/brokerage-twin"
import { isAgentGoalType } from "@/lib/goals/goal-types"
import { currentCausation } from "@/lib/kernel/causation"
import {
  MISSION_ATTENTION_STATES, MISSION_BLOCKED_STALE_HOURS, MISSION_CONTROL_REASON, MISSION_LIFECYCLE_REASON,
  MISSION_STATES, MISSION_TERMINAL_STATES,
  budgetExhausted, canTransition, evaluateSuccess, blockMission, enlistMissionParticipants, escalateMission,
  recordMissionEvidence, transitionMission,
  type MissionActor, type MissionDeps, type MissionRow, type MissionState, type MissionType,
} from "@/lib/kernel/missions"

type Client = { from: (table: string) => any }

/** The controller acts as the operations seat — the manager that keeps every other manager running. */
export const MISSION_CONTROLLER_ACTOR: MissionActor = { type: "manager", id: "cron_manager" }
/** Bounded batch per tenant tick. */
export const MISSION_CONTROL_BATCH = 50

// ─── the deterministic tables (registry keys, never seats) ───────────────────────────────────
/**
 * A twin MEASURE (the dotted field a sub-target / criterion names — OBJECTIVE_MEASURES vocabulary)
 * → the capability that OWNS moving it, the capabilities the work NEEDS, and the collaboration
 * domains it RIDES. Managers are resolved from these keys through CAPABILITY_MANAGER and
 * MANAGER_COLLABORATIONS at plan time — a seat renamed in the registry renames here for free.
 * @proofSeam the proof asserts every key resolves and the owner's example lands on the real registry
 */
export const MEASURE_CAPABILITIES: Readonly<Record<string, { owner: AppCapability; needs: readonly AppCapability[]; rides: readonly string[] }>> = {
  "economic.gciClosed90dCents":            { owner: "transaction_advance", needs: ["transaction_advance", "report_generate", "isa_qualify", "listing_publish", "appointment_schedule"], rides: ["closing_money_and_risk"] },
  "economic.closedCount90d":               { owner: "transaction_advance", needs: ["transaction_advance", "isa_qualify", "appointment_schedule", "listing_publish"], rides: ["buyer_tour_to_deal_story"] },
  "now.transactions.inEscrow":             { owner: "transaction_advance", needs: ["transaction_advance"], rides: [] },
  "now.transactions.open":                 { owner: "transaction_advance", needs: ["transaction_advance"], rides: [] },
  "now.transactions.openCommissionCents":  { owner: "transaction_advance", needs: ["transaction_advance", "report_generate"], rides: [] },
  // A listing objective ("Increase listing appointments 15%" → listings_taken): the concierge owns
  // it; the ISA qualifies seller leads into appointments, the orchestrator runs the seller
  // campaigns, the asset manager cuts the pre-listing media, the sphere manager works referral
  // listings, the steward keeps the owner data straight, and the ads manager joins through the
  // licensed listing_launch_play domain (paid seller-lead push).
  "now.listings.active":                   { owner: "listing_publish", needs: ["listing_publish", "cma_generate", "isa_qualify", "marketing_campaign_create", "content_repurpose", "handwritten_note_send", "contact_get"], rides: ["listing_launch_play"] },
  "now.pipeline.byLifecycle.representation": { owner: "appointment_schedule", needs: ["appointment_schedule", "isa_qualify", "lead_search"], rides: ["buyer_tour_to_deal_story"] },
  "now.pipeline.byLifecycle.isa_qualifying": { owner: "isa_qualify", needs: ["isa_qualify"], rides: [] },
  "now.pipeline.converted90d":             { owner: "isa_qualify", needs: ["isa_qualify", "lead_search", "contact_get"], rides: ["lead_quality_spend", "assignment_policy_outcomes"] },
  "now.pipeline.leads":                    { owner: "lead_create", needs: ["lead_create", "lead_search"], rides: ["lead_quality_spend"] },
  "now.contacts.active":                   { owner: "lead_create", needs: ["lead_create", "contact_get", "newsletter_send"], rides: ["long_horizon_nurture"] },
}

/**
 * Mission types whose domain is a TABLE the registry already stewards (TABLE_MANAGER) and the
 * collaboration domain the work rides; the objective-shaped types (agent_goal /
 * brokerage_objective) resolve through their criteria's measure instead; `custom` resolves to
 * nothing — the recorded owner stands and the verdict says "unresolved".
 * @proofSeam asserted directly
 */
export const MISSION_TYPE_DOMAIN: Readonly<Record<MissionType, { table: string; rides: readonly string[] } | null>> = {
  agent_goal: null,
  brokerage_objective: null,
  workflow:    { table: "workflow_runs", rides: [] },
  campaign:    { table: "marketing_campaigns", rides: ["creative_distribution"] },
  transaction: { table: "transactions", rides: ["closing_money_and_risk"] },
  recruiting:  { table: "recruits", rides: ["recruiting_offer_economics"] },
  compliance:  { table: "compliance_flags", rides: ["tenant_identity_controls"] },
  custom: null,
}

/** The risk class a capability's work carries (the ladder's vocabulary), derived from the
 *  capability registry's own `mutates` flag and the send/publish naming it uses — one rule, no
 *  per-capability retyping. @proofSeam asserted directly */
export function capabilityRiskClass(cap: AppCapability): ToolRiskClass {
  const def = APP_CAPABILITY_REGISTRY[cap]
  if (!def) return "LOW_RISK_WRITE"
  if (cap === "payment_transfer") return "FINANCIAL"
  if (!def.mutates) return "READ"
  if (/_(send|publish|distribute)$/.test(cap)) return "COMMUNICATION"
  return "LOW_RISK_WRITE"
}

/** The measure a criterion metric names: a dotted twin path as-is, an agent_goals goal_type through
 *  OBJECTIVE_MEASURES (the agent_goal → mission wire records the goal type itself as the metric). */
export function measureOfMetric(metric: string): string | null {
  if (metric.includes(".")) return metric
  if (isAgentGoalType(metric)) return OBJECTIVE_MEASURES[metric]
  return null
}

function isManagerKey(v: unknown): v is ManagerKey { return typeof v === "string" && v in MANAGERS }

// ─── shapes ───────────────────────────────────────────────────────────────────────────────────
export type ControlFlag =
  | "owner_unresolved" | "owner_mismatch" | "participants_enlisted" | "criteria_missing"
  | "dissent_open" | "authority_insufficient" | "budget_exhausted" | "budget_near"
  | "dependency_failed" | "dependency_missing" | "waiting_on_dependencies" | "stalled"
  | "delegations_unreadable" | "awaiting_human"

export interface DelegationSummary {
  total: number
  /** REQUESTED / ACCEPTED / WORKING — someone is on it. */
  open: number
  working: number
  dissented: string[]
  escalated: number
  returned: number
  /** The seam's refusal (table absent until m712 is applied, RLS, …) — published, never a 0. */
  readRefused: string | null
}
export const NO_DELEGATIONS = (why: string | null): DelegationSummary => ({ total: 0, open: 0, working: 0, dissented: [], escalated: 0, returned: 0, readRefused: why })

export interface LastVerdict { createdAt: string; digest: string; flags: ControlFlag[]; acknowledged: Partial<Record<ControlFlag, string>> }

export interface PlanInput {
  mission: MissionRow
  now: Date
  delegations: DelegationSummary
  /** The tenant's rows for mission.dependencies (id + state); an id absent here is MISSING. */
  dependencyRows: Array<Pick<MissionRow, "id" | "state">>
  children: Array<Pick<MissionRow, "id" | "state">>
  lastVerdict: LastVerdict | null
}

export interface MissionControlPlan {
  missionId: string
  state: MissionState
  owner: { recorded: ManagerKey; expected: ManagerKey | null; basis: string; mismatch: boolean }
  participants: { recorded: ManagerKey[]; expected: ManagerKey[]; missing: ManagerKey[]; basis: string }
  capabilities: AppCapability[]
  progress: { criteria: number; met: number; pct: number; unmet: string[]; lastActivityAt: string | null; hoursSinceActivity: number | null; progressing: boolean; stalled: boolean }
  dependencies: { ids: string[]; pending: string[]; failed: string[]; missing: string[]; done: string[]; children: { total: number; running: number } }
  budget: { usd: number | null; tokens: number | null; spentUsd: number; spentTokens: number; pctUsed: number | null; exhausted: boolean; near: boolean; onExhausted: "WAITING" | "APPROVAL_REQUIRED" }
  authority: { ceiling: AuthorityLevel; required: AuthorityLevel | null; requiredBy: AppCapability | null; insufficient: boolean }
  delegations: DelegationSummary
  flags: ControlFlag[]
  acknowledged: Partial<Record<ControlFlag, string>>
  human: { needed: boolean; why: string | null }
  enlist: ManagerKey[]
  transition: { to: MissionState; reason: string; via: "transition" | "escalate" | "block"; blockerKey?: string } | null
  nextAction: string
  line: string
  digest: string
}

// ─── the pure plan ────────────────────────────────────────────────────────────────────────────
function resolveMeasure(measure: string): { owner: ManagerKey | null; managers: Set<ManagerKey>; caps: Set<AppCapability>; basis: string[] } | null {
  const entry = MEASURE_CAPABILITIES[measure]
  if (!entry) return null
  const caps = new Set<AppCapability>([entry.owner, ...entry.needs])
  const managers = new Set<ManagerKey>()
  const basis: string[] = []
  for (const c of caps) { const m = CAPABILITY_MANAGER[c]; if (m) { managers.add(m); basis.push(`${c}→${m}`) } }
  for (const k of entry.rides) { for (const m of MANAGER_COLLABORATIONS[k]?.managers ?? []) { managers.add(m); basis.push(`${k}∋${m}`) } }
  return { owner: CAPABILITY_MANAGER[entry.owner] ?? null, managers, caps, basis }
}

/** PURE: who should own and who should participate, from the registry keys alone.
 *  @proofSeam the proof asserts the owner's example against the real registry */
export function resolveOwnership(m: Pick<MissionRow, "mission_type" | "success_criteria" | "subject_type" | "owner_manager">): { expected: ManagerKey | null; basis: string; participants: Set<ManagerKey>; capabilities: Set<AppCapability>; participantBasis: string[] } {
  const participants = new Set<ManagerKey>()
  const capabilities = new Set<AppCapability>()
  const participantBasis: string[] = []
  let expected: ManagerKey | null = null
  let basis = "unresolved"

  // 1. objective-shaped: the criteria's measures (headline first — the first criterion is the objective itself).
  for (const c of m.success_criteria ?? []) {
    const measure = measureOfMetric(c.metric)
    const r = measure ? resolveMeasure(measure) : null
    if (!r) continue
    if (!expected && r.owner) { expected = r.owner; basis = `criterion ${c.metric} → ${measure} → ${MEASURE_CAPABILITIES[measure!].owner} → CAPABILITY_MANAGER` }
    r.managers.forEach((k) => participants.add(k)); r.caps.forEach((k) => capabilities.add(k)); participantBasis.push(...r.basis)
  }
  // 2. a typed domain: the table the registry stewards.
  const dom = MISSION_TYPE_DOMAIN[m.mission_type]
  if (dom) {
    const t = TABLE_MANAGER[dom.table]
    if (!expected && t) { expected = t; basis = `mission_type ${m.mission_type} → TABLE_MANAGER.${dom.table}` }
    if (t) participants.add(t)
    for (const k of dom.rides) for (const mk of MANAGER_COLLABORATIONS[k]?.managers ?? []) { participants.add(mk); participantBasis.push(`${k}∋${mk}`) }
  }
  // 3. the subject's table, when the registry stewards it (subject_type "listing" → listings).
  if (!expected && m.subject_type) {
    const t = TABLE_MANAGER[m.subject_type] ?? TABLE_MANAGER[`${m.subject_type}s`]
    if (t) { expected = t; basis = `subject_type ${m.subject_type} → TABLE_MANAGER`; participants.add(t) }
  }
  // the bench never names the owner (the registry's expected one or the recorded one)
  if (expected) participants.delete(expected)
  participants.delete(m.owner_manager)
  return { expected, basis, participants, capabilities, participantBasis }
}

/** Hours from `iso` to `a`; null when absent or unparsable (unknown is never "stalled"). */
const hoursBetween = (a: Date, iso: string | null | undefined): number | null => {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? (a.getTime() - t) / 3_600_000 : null
}

export function planMissionControl(input: PlanInput): MissionControlPlan {
  const { mission: m, now, delegations, lastVerdict } = input
  const flags = new Set<ControlFlag>()
  const acknowledged: Partial<Record<ControlFlag, string>> = {}
  const terminal = MISSION_TERMINAL_STATES.has(m.state)
  const attention = MISSION_ATTENTION_STATES.has(m.state)

  // A finding the controller raised before and a human answered (they moved the mission after the
  // verdict) stays acknowledged while that move stands (state_changed_at unchanged since).
  const isAcked = (f: ControlFlag): boolean => {
    if (!lastVerdict) return false
    const movedAfter = !!m.state_changed_at && lastVerdict.flags.includes(f) && new Date(m.state_changed_at).getTime() > new Date(lastVerdict.createdAt).getTime()
    const carried = lastVerdict.acknowledged?.[f] === m.state_changed_at
    if (movedAfter || carried) { acknowledged[f] = m.state_changed_at; return true }
    return false
  }

  // ownership + participation
  const own = resolveOwnership(m)
  const recordedParticipants = (m.participating_managers ?? []).filter(isManagerKey)
  const expectedParticipants = [...own.participants].sort()
  const missing = expectedParticipants.filter((k) => !recordedParticipants.includes(k))
  if (!own.expected) flags.add("owner_unresolved")
  const mismatch = !!own.expected && own.expected !== m.owner_manager
  if (mismatch) flags.add("owner_mismatch")
  if (missing.length > 0 && !terminal) flags.add("participants_enlisted")

  // progress
  const criteria = m.success_criteria ?? []
  const verdict = evaluateSuccess(criteria, m.progress ?? {})
  const ratios = criteria.map((c) => { const v = m.progress?.[c.metric]; if (typeof v !== "number") return 0; if (c.op === ">=") return c.target <= 0 ? 1 : Math.min(1, v / c.target); return (c.op === "<=" ? v <= c.target : v === c.target) ? 1 : 0 })
  const pct = criteria.length === 0 ? 0 : Math.round((ratios.reduce((a, b) => a + b, 0) / criteria.length) * 100)
  if (criteria.length === 0 && !terminal) flags.add("criteria_missing")
  const lastActivityAt = m.updated_at ?? m.state_changed_at ?? m.created_at ?? null
  const hoursSinceActivity = hoursBetween(now, lastActivityAt)
  const progressing = hoursSinceActivity === null ? true : hoursSinceActivity < MISSION_BLOCKED_STALE_HOURS || delegations.open > 0
  const stalled = m.state === "ACTIVE" && !progressing
  if (stalled) flags.add("stalled")
  if (delegations.readRefused) flags.add("delegations_unreadable")

  // dependencies
  const depIds = [...new Set(m.dependencies ?? [])]
  const byId = new Map(input.dependencyRows.map((r) => [r.id, r.state]))
  const pending: string[] = [], failed: string[] = [], missingDeps: string[] = [], done: string[] = []
  for (const id of depIds) {
    const s = byId.get(id)
    if (!s) missingDeps.push(id)
    else if (s === "COMPLETED") done.push(id)
    else if (s === "FAILED" || s === "CANCELLED") failed.push(id)
    else pending.push(id)
  }
  if (failed.length) flags.add("dependency_failed")
  if (missingDeps.length) flags.add("dependency_missing")
  if (pending.length) flags.add("waiting_on_dependencies")
  const children = { total: input.children.length, running: input.children.filter((c) => !MISSION_TERMINAL_STATES.has(c.state)).length }

  // budget
  const usd = typeof m.budget?.usd === "number" ? m.budget.usd : null
  const tokens = typeof m.budget?.tokens === "number" ? m.budget.tokens : null
  const spentUsd = Number(m.spent_usd ?? 0), spentTokens = Number(m.spent_tokens ?? 0)
  const pctUsed = usd && usd > 0 ? Math.round((spentUsd / usd) * 100) : tokens && tokens > 0 ? Math.round((spentTokens / tokens) * 100) : null
  const exhausted = budgetExhausted(m.budget ?? {}, spentUsd, spentTokens)
  const near = !exhausted && pctUsed !== null && pctUsed >= 80
  if (exhausted) flags.add("budget_exhausted"); else if (near) flags.add("budget_near")
  const onExhausted = m.budget?.on_exhausted === "WAITING" ? "WAITING" : "APPROVAL_REQUIRED"

  // authority — the highest rung the plan's capabilities need vs the owner's ceiling
  let required: AuthorityLevel | null = null, requiredBy: AppCapability | null = null
  for (const cap of own.capabilities) {
    const min = MIN_AUTHORITY_FOR_RISK[capabilityRiskClass(cap)]
    if (min === null) continue // a class the ladder never grants autonomously — the action gate refuses it per action
    if (required === null || min > required) { required = min; requiredBy = cap }
  }
  const insufficient = required !== null && m.authority_ceiling < required
  if (insufficient) flags.add("authority_insufficient")

  // disagreement
  if (delegations.dissented.length > 0) flags.add("dissent_open")

  // ─── the one transition (first applicable wins; a human's answer is honoured) ───
  let transition: MissionControlPlan["transition"] = null
  const may = (to: MissionState) => !terminal && !attention && canTransition(m.state, to)
  if (!terminal) {
    if (verdict.met && criteria.length > 0 && canTransition(m.state, "COMPLETED")) {
      // Completion is the mission service's deterministic rule (transitionMission re-judges the
      // criteria); the controller only notices that nothing else matters once they are met.
      transition = { to: "COMPLETED", via: "transition", reason: `success criteria met: ${criteria.map((c) => `${c.metric}=${m.progress?.[c.metric]}`).join(", ")} (controller)` }
    } else if (delegations.dissented.length > 0 && may("APPROVAL_REQUIRED") && !isAcked("dissent_open")) {
      transition = { to: "APPROVAL_REQUIRED", via: "escalate", reason: `disagreement: delegation(s) ${delegations.dissented.join(", ")} DISSENTED — a human decides` }
    } else if (insufficient && may("ESCALATED") && !isAcked("authority_insufficient")) {
      transition = { to: "ESCALATED", via: "transition", reason: `authority insufficient: ${requiredBy} needs rung ${required}, the owner's ceiling is ${m.authority_ceiling}` }
    } else if (exhausted && m.state !== "WAITING" && may(onExhausted) && !isAcked("budget_exhausted")) {
      transition = { to: onExhausted, via: "transition", reason: `budget exhausted: $${spentUsd.toFixed(2)} / ${spentTokens} tokens against ${JSON.stringify(m.budget ?? {})}` }
    } else if ((failed.length || missingDeps.length) && m.state !== "BLOCKED" && !isAcked(failed.length ? "dependency_failed" : "dependency_missing")) {
      const id = failed[0] ?? missingDeps[0]
      const openKey = (m.blockers ?? []).some((b) => b.key === `dependency:${id}` && !b.cleared_at)
      if (!openKey && !attention && canTransition(m.state, "BLOCKED")) transition = { to: "BLOCKED", via: "block", blockerKey: `dependency:${id}`, reason: failed.length ? `dependency ${id} is ${byId.get(id)}` : `dependency ${id} is not a mission of this tenant` }
    } else if (pending.length && may("WAITING") && m.state !== "WAITING" && !isAcked("waiting_on_dependencies")) {
      transition = { to: "WAITING", via: "transition", reason: `waiting on ${pending.length} dependenc${pending.length === 1 ? "y" : "ies"}: ${pending.join(", ")}` }
    } else if (stalled && may("ESCALATED") && !isAcked("stalled")) {
      transition = { to: "ESCALATED", via: "transition", reason: `stalled: no progress, action or delegation for ${Math.round(hoursSinceActivity ?? 0)}h (window ${MISSION_BLOCKED_STALE_HOURS}h)` }
    } else if (m.state === "WAITING" && pending.length === 0 && depIds.length > 0 && !failed.length && !missingDeps.length && lastVerdict?.flags.includes("waiting_on_dependencies") && canTransition("WAITING", "ACTIVE")) {
      transition = { to: "ACTIVE", via: "transition", reason: `dependencies done: ${done.join(", ")} — resumed` }
    }
  }

  // human
  const afterState = transition?.to ?? m.state
  const humanNeeded = MISSION_ATTENTION_STATES.has(afterState)
  if (humanNeeded) flags.add("awaiting_human")
  const openBlockers = (m.blockers ?? []).filter((b) => !b.cleared_at)
  const why = !humanNeeded ? null
    : transition ? transition.reason
    : afterState === "BLOCKED" ? `blocked on ${openBlockers.map((b) => b.key).join(", ") || "a blocker"}`
    : afterState === "APPROVAL_REQUIRED" ? "approval required (see the last transition's reason)"
    : "escalated (see the last transition's reason)"

  const label = (k: ManagerKey | null) => (k ? MANAGERS[k]?.label ?? k : "nobody")
  const nextAction = terminal ? `done (${m.state})`
    : transition ? `${transition.via === "block" ? "block" : "move"} → ${transition.to}: ${transition.reason}`
    : humanNeeded ? `a human decides — ${why}`
    : missing.length ? `enlist ${missing.map(label).join(", ")}`
    : criteria.length === 0 ? "a human gives it measurable criteria"
    : verdict.met ? "criteria met — completion is recorded on the next progress write"
    : `${label(m.owner_manager)} works the next unmet criterion: ${verdict.unmet[0]}`
  const sortedFlags = [...flags].sort() as ControlFlag[]
  const line = `${label(m.owner_manager)} owns${mismatch ? ` (registry expects ${label(own.expected)})` : ""} · with ${[...new Set([...recordedParticipants, ...missing])].map(label).join(", ") || "nobody"} · ${pct}% (${verdict.met ? criteria.length : criteria.length - verdict.unmet.length}/${criteria.length} criteria)` +
    ` · blockers ${openBlockers.length}${pending.length ? ` · waiting on ${pending.length}` : ""}` +
    ` · budget ${usd !== null ? `$${spentUsd.toFixed(0)}/$${usd}` : tokens !== null ? `${spentTokens}/${tokens} tok` : "unmetered"}${exhausted ? " EXHAUSTED" : near ? " near" : ""}` +
    ` · delegations ${delegations.readRefused ? "unreadable" : `${delegations.open} open${delegations.dissented.length ? `, ${delegations.dissented.length} dissented` : ""}`}` +
    ` · next: ${nextAction}`
  const digest = JSON.stringify({ s: m.state, o: own.expected, p: expectedParticipants, miss: missing, pct, met: verdict.met, un: verdict.unmet.length, f: sortedFlags, dep: [pending.length, failed.length, missingDeps.length], b: [exhausted, near], a: insufficient, d: [delegations.open, delegations.dissented.length, !!delegations.readRefused], t: transition?.to ?? null, ack: Object.keys(acknowledged).sort() })

  return {
    missionId: m.id, state: m.state,
    owner: { recorded: m.owner_manager, expected: own.expected, basis: own.basis, mismatch },
    participants: { recorded: recordedParticipants, expected: expectedParticipants, missing, basis: [...new Set(own.participantBasis)].join("; ") },
    capabilities: [...own.capabilities].sort(),
    progress: { criteria: criteria.length, met: criteria.length - verdict.unmet.length, pct, unmet: verdict.unmet, lastActivityAt, hoursSinceActivity, progressing, stalled },
    dependencies: { ids: depIds, pending, failed, missing: missingDeps, done, children },
    budget: { usd, tokens, spentUsd, spentTokens, pctUsed, exhausted, near, onExhausted },
    authority: { ceiling: m.authority_ceiling, required, requiredBy, insufficient },
    delegations, flags: sortedFlags, acknowledged,
    human: { needed: humanNeeded, why },
    enlist: terminal ? [] : missing,
    transition, nextAction, line, digest,
  }
}

// ─── thin I/O ─────────────────────────────────────────────────────────────────────────────────
export interface ControllerDeps extends MissionDeps {
  /** 105A's manager_delegations through a lazy seam — degrades to "unreadable" (published), never 0. */
  delegations?: (brokerageId: string, missionIds: string[], client: Client) => Promise<Record<string, DelegationSummary>>
  sweepLedger?: (ctx: { brokerageId: string; summary: MissionControlResult }, client: Client) => Promise<void>
}

const DELEGATION_OPEN = new Set(["REQUESTED", "ACCEPTED", "WORKING"])

export const defaultControllerDeps: Required<Pick<ControllerDeps, "delegations" | "sweepLedger">> = {
  delegations: async (brokerageId, missionIds, client) => {
    const out: Record<string, DelegationSummary> = Object.fromEntries(missionIds.map((id) => [id, NO_DELEGATIONS(null)]))
    if (missionIds.length === 0) return out
    const { data, error } = await client.from("manager_delegations").select("id, mission_id, status").eq("brokerage_id", brokerageId).in("mission_id", missionIds).limit(2000)
    if (error) { for (const id of missionIds) out[id] = NO_DELEGATIONS(`manager_delegations read refused: ${error.message}`); return out }
    for (const r of (data ?? []) as Array<{ id: string; mission_id: string; status: string }>) {
      const s = out[r.mission_id]; if (!s) continue
      s.total++
      if (DELEGATION_OPEN.has(r.status)) s.open++
      if (r.status === "WORKING") s.working++
      if (r.status === "DISSENTED") s.dissented.push(r.id)
      if (r.status === "ESCALATED") s.escalated++
      if (r.status === "RETURNED") s.returned++
    }
    return out
  },
  sweepLedger: async ({ brokerageId, summary }, client) => {
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    const c = currentCausation()
    await withActionLedger(
      {
        brokerageId, action: "mission.control.sweep",
        actor: { type: "manager", managerKey: MISSION_CONTROLLER_ACTOR.id ?? "cron_manager" },
        subject: { type: "brokerage", id: brokerageId },
        reasonCode: MISSION_LIFECYCLE_REASON, reasonDetail: `mission controller tick: ${summary.transitions} moved, ${summary.enlisted} enlisted, ${summary.verdictsRecorded} verdicts recorded, ${summary.unchanged} unchanged`,
        causationId: c.causationId, correlationId: c.correlationId,
        riskClass: "LOW_RISK_WRITE", systemSource: "missions",
        detail: { scanned: summary.scanned, transitions: summary.transitions, enlisted: summary.enlisted, verdicts_recorded: summary.verdictsRecorded, unchanged: summary.unchanged, human_needed: summary.humanNeeded, delegations_unreadable: summary.delegationsUnreadable, read_refused: summary.readRefused },
      },
      async () => ({ status: "executed" as const, outcome: `${summary.transitions} moved` }),
      { settle: (r) => ({ status: r.status, outcome: r.outcome, costUsd: null }), replay: () => ({ status: "executed" as const, outcome: "replay" }) },
      { client },
    )
  },
}

async function svcOf(client?: Client): Promise<Client> {
  if (client) return client
  const { createServiceClient } = await import("@/lib/supabase/service")
  return createServiceClient() as unknown as Client
}

/** The latest controller verdict per mission — the acknowledgement memory and the idempotency digest. */
async function lastVerdictsFor(svc: Client, brokerageId: string, missionIds: string[]): Promise<Record<string, LastVerdict | null>> {
  const out: Record<string, LastVerdict | null> = {}
  for (const id of missionIds) {
    // The enlistment row shares the reason code but carries no digest — the newest row WITH a
    // digest is the verdict (a few rows back at most: one enlistment per tick).
    const { data, error } = await svc.from("mission_events").select("created_at, evidence").eq("brokerage_id", brokerageId).eq("mission_id", id).eq("reason_code", MISSION_CONTROL_REASON).eq("event_kind", "evidence").order("created_at", { ascending: false }).limit(8)
    if (error) { console.error(`[mission-controller] last verdict read refused for ${id}: ${error.message}`); out[id] = null; continue }
    const rows = ((data ?? []) as Array<{ created_at: string; evidence?: Record<string, unknown> }>)
    const ev = rows.find((r) => typeof r.evidence?.digest === "string") ?? null
    out[id] = ev ? { createdAt: ev.created_at, digest: ev.evidence!.digest as string, flags: Array.isArray(ev.evidence?.flags) ? (ev.evidence!.flags as ControlFlag[]) : [], acknowledged: (ev.evidence?.acknowledged as LastVerdict["acknowledged"]) ?? {} } : null
  }
  return out
}

export interface MissionControlResult {
  scanned: number
  transitions: number
  enlisted: number
  verdictsRecorded: number
  unchanged: number
  humanNeeded: number
  delegationsUnreadable: number
  readRefused: string | null
  verdicts: MissionControlPlan[]
}

/** ONE mission: plan + act + record. Tenant from the caller (the cron's / the session's). */
export async function controlMission(brokerageId: string, missionId: string, client?: Client, opts: { now?: Date } = {}, deps: ControllerDeps = {}): Promise<{ ok: true; plan: MissionControlPlan; moved: boolean; recorded: boolean } | { ok: false; reason: string }> {
  const r = await controlMissions(brokerageId, client, { ...opts, missionIds: [missionId] }, deps)
  if (r.readRefused) return { ok: false, reason: r.readRefused }
  const plan = r.verdicts[0]
  if (!plan) return { ok: false, reason: "not_found" }
  return { ok: true, plan, moved: r.transitions > 0, recorded: r.verdictsRecorded > 0 }
}

/**
 * THE LOOP — every non-terminal mission of the tenant (bounded batch), on the reaper tick right
 * after sweepMissionDeadlines (lib/workflow-orchestrator/stale-run-reaper.ts). Reads are pinned to
 * the tenant; a refused read is PUBLISHED and nothing is judged.
 */
export async function controlMissions(brokerageId: string, client?: Client, opts: { now?: Date; limit?: number; missionIds?: string[] } = {}, deps: ControllerDeps = {}): Promise<MissionControlResult> {
  const now = opts.now ?? new Date()
  const d = { ...defaultControllerDeps, ...deps }
  const result: MissionControlResult = { scanned: 0, transitions: 0, enlisted: 0, verdictsRecorded: 0, unchanged: 0, humanNeeded: 0, delegationsUnreadable: 0, readRefused: null, verdicts: [] }
  if (!brokerageId) { result.readRefused = "no tenant"; return result }
  const svc = await svcOf(client)
  let q = svc.from("missions").select("*").eq("brokerage_id", brokerageId).in("state", MISSION_STATES.filter((s) => !MISSION_TERMINAL_STATES.has(s)))
  if (opts.missionIds?.length) q = q.in("id", opts.missionIds)
  const { data, error } = await q.limit(Math.min(opts.limit ?? MISSION_CONTROL_BATCH, MISSION_CONTROL_BATCH))
  if (error) { result.readRefused = error.message; return result }
  const missions = (data ?? []) as MissionRow[]
  if (missions.length === 0) return result
  const ids = missions.map((m) => m.id)

  // dependencies + children, one tenant-pinned read each
  const depIds = [...new Set(missions.flatMap((m) => m.dependencies ?? []))]
  const depRows: Array<Pick<MissionRow, "id" | "state">> = []
  if (depIds.length) {
    const { data: dr, error: de } = await svc.from("missions").select("id, state").eq("brokerage_id", brokerageId).in("id", depIds).limit(500)
    if (de) console.error(`[mission-controller] dependency read refused: ${de.message}`); else depRows.push(...((dr ?? []) as Array<Pick<MissionRow, "id" | "state">>))
  }
  const { data: ch, error: ce } = await svc.from("missions").select("id, state, parent_mission").eq("brokerage_id", brokerageId).in("parent_mission", ids).limit(500)
  if (ce) console.error(`[mission-controller] children read refused: ${ce.message}`)
  const childrenOf = new Map<string, Array<Pick<MissionRow, "id" | "state">>>()
  for (const c of (ch ?? []) as Array<{ id: string; state: MissionState; parent_mission: string }>) { const l = childrenOf.get(c.parent_mission) ?? []; l.push(c); childrenOf.set(c.parent_mission, l) }

  const delegations = await d.delegations(brokerageId, ids, svc)
  const lastVerdicts = await lastVerdictsFor(svc, brokerageId, ids)
  const missionDeps: MissionDeps = { ...deps, now: () => now }

  for (const m of missions) {
    result.scanned++
    const dg = delegations[m.id] ?? NO_DELEGATIONS("no answer from the delegation seam")
    if (dg.readRefused) result.delegationsUnreadable++
    const plan = planMissionControl({ mission: m, now, delegations: dg, dependencyRows: depRows.filter((r) => (m.dependencies ?? []).includes(r.id)), children: childrenOf.get(m.id) ?? [], lastVerdict: lastVerdicts[m.id] ?? null })
    let moved = false
    let enlistedNow = 0
    // coordinate: widen the bench first (a transition's signal should reach everyone on it)
    if (plan.enlist.length) {
      const e = await enlistMissionParticipants({ brokerageId, missionId: m.id, managers: plan.enlist, reason: `the registry's capability keys for this objective (${plan.participants.basis || plan.owner.basis})`, actor: MISSION_CONTROLLER_ACTOR }, svc, missionDeps)
      if (e.ok) { enlistedNow = e.enlisted?.length ?? 0; result.enlisted += enlistedNow }
      else console.error(`[mission-controller] enlist refused on ${m.id}: ${e.reason}`)
    }
    if (plan.transition) {
      const t = plan.transition
      const r = t.via === "block"
        ? await blockMission({ brokerageId, missionId: m.id, key: t.blockerKey ?? "dependency", reason: t.reason, actor: MISSION_CONTROLLER_ACTOR }, svc, missionDeps)
        : t.via === "escalate"
          ? await escalateMission({ brokerageId, missionId: m.id, reason: t.reason, actor: MISSION_CONTROLLER_ACTOR, needsHuman: true }, svc, missionDeps)
          : await transitionMission({ brokerageId, missionId: m.id, to: t.to, reason: t.reason, actor: MISSION_CONTROLLER_ACTOR, evidence: { controller: true, flags: plan.flags } }, svc, missionDeps)
      moved = r.ok
      if (r.ok) result.transitions++
      else console.error(`[mission-controller] ${t.via} → ${t.to} refused on ${m.id}: ${r.reason}`)
    }
    if (plan.human.needed) result.humanNeeded++
    // The RECORDED verdict describes the mission as it now stands (after this tick's act), so the
    // next tick with nothing changed finds the same digest and writes nothing (idempotent). The act
    // itself rides the row as `acted`.
    let settled = plan
    if (moved || enlistedNow > 0) {
      const { data: fresh, error: fe } = await svc.from("missions").select("*").eq("brokerage_id", brokerageId).eq("id", m.id).maybeSingle()
      if (fe) console.error(`[mission-controller] re-read refused on ${m.id}: ${fe.message}`)
      else if (fresh) settled = planMissionControl({ mission: fresh as MissionRow, now, delegations: dg, dependencyRows: depRows.filter((r) => (m.dependencies ?? []).includes(r.id)), children: childrenOf.get(m.id) ?? [], lastVerdict: lastVerdicts[m.id] ?? null })
    }
    const last = lastVerdicts[m.id]
    if (moved || enlistedNow > 0 || !last || last.digest !== settled.digest) {
      const rec = await recordMissionEvidence({ brokerageId, missionId: m.id, kind: "evidence", reason: settled.line, reasonCode: MISSION_CONTROL_REASON, actor: MISSION_CONTROLLER_ACTOR, evidence: {
        digest: settled.digest, flags: settled.flags, acknowledged: settled.acknowledged, owner: settled.owner, participants: settled.participants, capabilities: settled.capabilities,
        progress: settled.progress, dependencies: settled.dependencies, budget: settled.budget, authority: settled.authority, delegations: settled.delegations,
        human: settled.human, next_action: settled.nextAction,
        acted: { enlisted: plan.enlist.slice(0, enlistedNow), transition: plan.transition ? { ...plan.transition, applied: moved } : null },
      } }, svc)
      if (rec.ok) result.verdictsRecorded++
    } else result.unchanged++
    result.verdicts.push(plan)
  }
  if (result.transitions + result.enlisted + result.verdictsRecorded > 0) {
    try { await d.sweepLedger({ brokerageId, summary: result }, svc) } catch (e) { console.error(`[mission-controller] sweep ledger refused: ${e instanceof Error ? e.message : String(e)}`) }
  }
  return result
}

/** The verdict a SURFACE carries per mission (the Missions card; serialisable, no registry objects). */
export type MissionVerdictLine = { line: string; nextAction: string; flags: ControlFlag[]; progressPct: number; humanNeeded: boolean; ownerExpected: ManagerKey | null; participantsMissing: ManagerKey[] }

/** The verdict LINES for a surface (the Missions card): plan only, no transition, no write —
 *  delegations through the seam, dependencies from the rows handed in. */
export async function missionVerdictLines(brokerageId: string, missions: MissionRow[], client?: Client, deps: ControllerDeps = {}, now = new Date()): Promise<Record<string, Pick<MissionControlPlan, "line" | "nextAction" | "flags" | "owner" | "participants" | "progress" | "budget" | "human">>> {
  const out: Record<string, Pick<MissionControlPlan, "line" | "nextAction" | "flags" | "owner" | "participants" | "progress" | "budget" | "human">> = {}
  if (!brokerageId || missions.length === 0) return out
  const svc = await svcOf(client)
  const d = { ...defaultControllerDeps, ...deps }
  const delegations = await d.delegations(brokerageId, missions.map((m) => m.id), svc)
  // Dependencies may be COMPLETED (absent from a non-terminal list): read their states, tenant-pinned.
  const states = new Map(missions.map((m) => [m.id, m.state]))
  const depIds = [...new Set(missions.flatMap((m) => m.dependencies ?? []))].filter((id) => !states.has(id))
  if (depIds.length) {
    const { data, error } = await svc.from("missions").select("id, state").eq("brokerage_id", brokerageId).in("id", depIds).limit(500)
    if (error) console.error(`[mission-controller] dependency read refused: ${error.message}`)
    for (const r of (data ?? []) as Array<Pick<MissionRow, "id" | "state">>) states.set(r.id, r.state)
  }
  for (const m of missions) {
    const plan = planMissionControl({ mission: m, now, delegations: delegations[m.id] ?? NO_DELEGATIONS("no answer from the delegation seam"), dependencyRows: (m.dependencies ?? []).filter((id) => states.has(id)).map((id) => ({ id, state: states.get(id)! })), children: missions.filter((c) => c.parent_mission === m.id), lastVerdict: null })
    out[m.id] = { line: plan.line, nextAction: plan.nextAction, flags: plan.flags, owner: plan.owner, participants: plan.participants, progress: plan.progress, budget: plan.budget, human: plan.human }
  }
  return out
}
