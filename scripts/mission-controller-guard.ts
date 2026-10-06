#!/usr/bin/env tsx
/**
 * scripts/mission-controller-guard.ts   (npm run test:mission-controller) — wave 105, lane 105B.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE EXECUTIVE MISSION CONTROLLER — in-memory client (scripts/in-memory-supabase.ts), the REAL
 * registry (MANAGERS / CAPABILITY_MANAGER / MANAGER_COLLABORATIONS / TABLE_MANAGER), no network.
 *   A. ownership — registry keys only, the owner's example on the real registry, a human's choice reported not overridden
 *   B. participation — from the decomposed sub-targets' measures, enlisted additively (never the owner, never removed)
 *   C. verdicts + transitions — budget / authority / disagreement / dependencies / stalled / resume / completion, one per tick
 *   D. human intervention — the mission service's signal + notification ride the controller's move
 *   E. idempotent re-run + acknowledgement (no ping-pong) + tenant isolation + the seam degrade
 *   F. wiring (stripped source, a tombstone is not a call site) + registration
 * Rules asserted, not waypoints: no migration pin, no count pin that a later lane would move.
 */
import { readFileSync } from "node:fs"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import {
  MEASURE_CAPABILITIES, MISSION_TYPE_DOMAIN, MISSION_CONTROL_BATCH, MISSION_CONTROLLER_ACTOR, NO_DELEGATIONS,
  capabilityRiskClass, measureOfMetric, resolveOwnership, planMissionControl, controlMissions, controlMission, missionVerdictLines,
  type DelegationSummary, type ControllerDeps,
} from "../lib/kernel/mission-controller"
import {
  MISSION_BLOCKED_STALE_HOURS, MISSION_CONTROL_REASON, MISSION_APPROVAL_REQUIRED_SIGNAL, MISSION_ESCALATED_SIGNAL,
  createMission, transitionMission, recordMissionProgress, enlistMissionParticipants, criteriaFromDecomposition,
  type MissionRow,
} from "../lib/kernel/missions"
import { decomposeObjective, OBJECTIVE_MEASURES } from "../lib/kernel/brokerage-twin"
import { MANAGERS, MAINTENANCE_DOMAINS, MANAGER_COLLABORATIONS, TABLE_MANAGER, canRefer } from "../lib/kernel/manager-registry"
import { CAPABILITY_MANAGER } from "../lib/agentic-os/capability-ownership"
import { APP_CAPABILITY_REGISTRY } from "../lib/agentic-os/app-capability-registry"
import { MIN_AUTHORITY_FOR_RISK } from "../lib/ai-isa/persona-tool-policy"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}${detail ? `\n      ${detail}` : ""}`) } }
const src = (p: string) => stripComments(readFileSync(p, "utf8"))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const T1 = "11111111-1111-4111-8111-111111111111"
const T2 = "22222222-2222-4222-8222-222222222222"
const HOUR = 3_600_000

/** Observing seams: every default is the survivor; the proof records what the service hands them. */
function seams(over: Partial<{ authority: number; delegations: Record<string, DelegationSummary> }> = {}) {
  const ledger: any[] = [], emits: any[] = [], signals: any[] = [], sweeps: any[] = []
  const fixture = over.delegations
  const deps: ControllerDeps = {
    afford: async () => ({ allowed: true, reason: "active" }),
    authority: async () => (over.authority ?? 6) as any,
    ledger: async (ctx) => { ledger.push(ctx); return `ledger-${ledger.length}` },
    emit: async (i) => { emits.push(i) },
    signal: async (s) => { signals.push(s) },
    sweepLedger: async (ctx) => { sweeps.push(ctx.summary) },
    // the 105A seam, when a case hands in delegations; otherwise the DEFAULT seam reads the table
    ...(fixture ? { delegations: async (_b: string, ids: string[]) => Object.fromEntries(ids.map((id) => [id, fixture[id] ?? NO_DELEGATIONS(null)])) } : {}),
  }
  return { deps, ledger, emits, signals, sweeps }
}
const mem = (seed: Record<string, any[]> = {}, opts: Parameters<typeof memSupabase>[1] = {}) => memSupabase(seed, { stampCreatedAt: true, ...opts })
const row = (c: ReturnType<typeof mem>, id: string): MissionRow => c.tables.missions.find((r) => r.id === id)! as MissionRow
const stamp = (c: ReturnType<typeof mem>, id: string, at: Date) => { const r = row(c, id) as any; r.updated_at = at.toISOString(); r.state_changed_at = r.state_changed_at ?? at.toISOString() }

const twin = { brokerageId: T1, now: { listings: { active: 12 } } } as any

async function main() {
  // ─── A. ownership ───────────────────────────────────────────────────────────────────────────
  console.log("\nA. ownership — registry keys, never a retyped seat")
  check("A1 every MEASURE_CAPABILITIES key is a twin measure the decomposition can name (OBJECTIVE_MEASURES or a sub-target path) and every capability it names is owned in CAPABILITY_MANAGER",
    Object.entries(MEASURE_CAPABILITIES).every(([k, v]) => k.includes(".") && [v.owner, ...v.needs].every((c) => c in CAPABILITY_MANAGER && c in APP_CAPABILITY_REGISTRY) && v.rides.every((r) => r in MANAGER_COLLABORATIONS))
      && Object.values(OBJECTIVE_MEASURES).filter((m): m is string => !!m).every((m) => m in MEASURE_CAPABILITIES),
    JSON.stringify(Object.values(OBJECTIVE_MEASURES).filter((m) => m && !(m in MEASURE_CAPABILITIES))))
  check("A2 every typed mission domain names a table TABLE_MANAGER stewards and collaboration domains that exist", Object.values(MISSION_TYPE_DOMAIN).every((d) => d === null || (typeof MANAGERS[TABLE_MANAGER[d.table]]?.key === "string" && d.rides.every((r) => r in MANAGER_COLLABORATIONS))))
  check("A3 measureOfMetric: a dotted path as-is, an agent_goals goal_type through OBJECTIVE_MEASURES, anything else null", measureOfMetric("now.listings.active") === "now.listings.active" && measureOfMetric("listings_taken") === "now.listings.active" && measureOfMetric("avg_days_to_close") === null && measureOfMetric("steps_completed") === null)
  // THE OWNER'S EXAMPLE on the real registry: "Increase listing appointments 15%" → listings_taken.
  const d = decomposeObjective({ goalType: "listings_taken", targetValue: 14, currentValue: 12 }, twin)
  const criteria = criteriaFromDecomposition(d)
  const own = resolveOwnership({ mission_type: "brokerage_objective", success_criteria: criteria, subject_type: null, owner_manager: "listing_concierge" })
  const bench = [...own.participants].sort()
  check("A4 'Increase listing appointments 15%' (listings_taken) → listing_concierge OWNS through listing_publish → CAPABILITY_MANAGER", own.expected === "listing_concierge" && /listing_publish → CAPABILITY_MANAGER/.test(own.basis), own.basis)
  check("A5 PARTICIPANTS by capability + licensed collaboration = {ai_isa, campaign_orchestrator, ads_manager, sphere_of_influence, asset_manager, data_steward} — the owner's set, on the REAL registry", bench.join(",") === "ads_manager,ai_isa,asset_manager,campaign_orchestrator,data_steward,sphere_of_influence", bench.join(","))
  check("A5 (control) ads_manager arrives ONLY through listing_launch_play (it owns no AppCapability): drop the ride and it leaves", !Object.values(CAPABILITY_MANAGER).includes("ads_manager") && /listing_launch_play∋ads_manager/.test(own.participantBasis.join(";")) && MANAGER_COLLABORATIONS.listing_launch_play.managers.includes("ads_manager"))
  check("A6 the owner is never on the bench; a human's different choice is REPORTED (mismatch), the bench still excludes the chosen owner", (() => { const o = resolveOwnership({ mission_type: "brokerage_objective", success_criteria: criteria, subject_type: null, owner_manager: "ai_isa" }); return o.expected === "listing_concierge" && !o.participants.has("ai_isa") && !o.participants.has("listing_concierge") })())
  check("A7 typed missions resolve through TABLE_MANAGER: transaction → deal_coordinator (+ closing_money_and_risk bench), recruiting → recruiting_manager, compliance → compliance_officer; custom → unresolved",
    resolveOwnership({ mission_type: "transaction", success_criteria: [], subject_type: null, owner_manager: "deal_coordinator" }).expected === "deal_coordinator"
    && resolveOwnership({ mission_type: "transaction", success_criteria: [], subject_type: null, owner_manager: "deal_coordinator" }).participants.has("finance_manager")
    && resolveOwnership({ mission_type: "recruiting", success_criteria: [], subject_type: null, owner_manager: "recruiting_manager" }).expected === "recruiting_manager"
    && resolveOwnership({ mission_type: "compliance", success_criteria: [], subject_type: null, owner_manager: "compliance_officer" }).expected === "compliance_officer"
    && resolveOwnership({ mission_type: "custom", success_criteria: [], subject_type: null, owner_manager: "ai_isa" }).expected === null)
  check("A8 a subject's table resolves when nothing else does (subject_type listing → listings → listing_concierge)", resolveOwnership({ mission_type: "custom", success_criteria: [], subject_type: "listing", owner_manager: "ai_isa" }).expected === "listing_concierge")
  check("A9 an agent_goal mission (metric = the goal type) resolves the same way: gross_commission → deal_coordinator, new_contacts → ai_isa", resolveOwnership({ mission_type: "agent_goal", success_criteria: [{ metric: "gross_commission", op: ">=", target: 1 }], subject_type: null, owner_manager: "deal_coordinator" }).expected === "deal_coordinator" && resolveOwnership({ mission_type: "agent_goal", success_criteria: [{ metric: "new_contacts", op: ">=", target: 1 }], subject_type: null, owner_manager: "ai_isa" }).expected === "ai_isa")
  check("A10 capabilityRiskClass follows the capability registry: a read → READ, a send/publish → COMMUNICATION, a write → LOW_RISK_WRITE, payment_transfer → FINANCIAL; the ladder rung comes from MIN_AUTHORITY_FOR_RISK", capabilityRiskClass("contact_get") === "READ" && capabilityRiskClass("newsletter_send") === "COMMUNICATION" && capabilityRiskClass("cma_generate") === "LOW_RISK_WRITE" && capabilityRiskClass("payment_transfer") === "FINANCIAL" && MIN_AUTHORITY_FOR_RISK.COMMUNICATION === 3)

  // ─── B. participation enlisted on the tick ──────────────────────────────────────────────────
  console.log("\nB. participation — enlisted additively on the tick")
  {
    const c = mem(); const s = seams()
    const now = new Date()
    const m = await createMission({ brokerageId: T1, objective: "Increase listing appointments 15%", missionType: "brokerage_objective", ownerManager: "listing_concierge", initialState: "ACTIVE", objectiveSpec: { goalType: "listings_taken", targetValue: 14, currentValue: 12 }, twin }, c as any, s.deps)
    if (!m.ok) throw new Error(m.reason)
    check("B0 the decomposition keyed the criterion on the twin measure (headline + sub-target both measure now.listings.active → ONE criterion, remaining 2)", m.mission.success_criteria.length === 1 && m.mission.success_criteria[0].metric === "now.listings.active" && m.mission.success_criteria[0].target === 2)
    await recordMissionProgress({ brokerageId: T1, missionId: m.mission.id, progress: { "now.listings.active": 1 } }, c as any, s.deps)
    stamp(c, m.mission.id, now)
    const r = await controlMissions(T1, c as any, { now }, s.deps)
    const after = row(c, m.mission.id)
    check("B1 the tick ENLISTS the six participants onto the row (additive), owner untouched, state untouched", r.enlisted === 6 && [...after.participating_managers].sort().join(",") === bench.join(",") && after.owner_manager === "listing_concierge" && after.state === "ACTIVE", JSON.stringify({ enlisted: r.enlisted, bench: after.participating_managers }))
    const verdictRows = () => c.tables.mission_events.filter((e) => e.reason_code === MISSION_CONTROL_REASON && typeof e.evidence.digest === "string")
    check("B2 the enlistment is EVIDENCE (mission_events evidence, reason_code MISSION_CONTROL, naming who) and the verdict row records the act (acted.enlisted) + a digest", c.tables.mission_events.some((e) => e.event_kind === "evidence" && e.reason_code === MISSION_CONTROL_REASON && /participants enlisted/.test(e.reason) && e.evidence.enlisted.length === 6) && verdictRows().length === 1 && verdictRows()[0].evidence.acted.enlisted.length === 6)
    const v = r.verdicts[0]
    check("B3 the verdict LINE (the tick's decision): owner · participants · 50% (1 of 2 remaining) · blockers · budget · delegations · next: enlist …; the RECORDED line (as it now stands) names the next unmet criterion for the owner", /^Listing Concierge owns · with .*AI ISA.* · 50% \(0\/1 criteria\) · blockers 0 · budget unmetered · delegations 0 open · next: enlist Ads Manager/.test(v.line) && / · next: Listing Concierge works the next unmet criterion: now\.listings\.active >= 2 \(is 1\)$/.test(verdictRows()[0].reason), `${v.line}\n      ${verdictRows()[0]?.reason}`)
    check("B4 a second tick enlists nobody and, with nothing changed, records NO second verdict (idempotent)", await (async () => { await sleep(3); const r2 = await controlMissions(T1, c as any, { now }, s.deps); return r2.enlisted === 0 && r2.transitions === 0 && r2.verdictsRecorded === 0 && r2.unchanged === 1 && verdictRows().length === 1 })())
    const again = await enlistMissionParticipants({ brokerageId: T1, missionId: m.mission.id, managers: ["listing_concierge", "ai_isa"], reason: "noop" }, c as any, s.deps)
    check("B5 enlistMissionParticipants never names the owner and never duplicates; an unknown key is refused", again.ok && again.enlisted?.length === 0 && !(await enlistMissionParticipants({ brokerageId: T1, missionId: m.mission.id, managers: ["nobody" as any], reason: "x" }, c as any, s.deps)).ok)
    check("B6 the tick that enlisted wrote ONE summary ledger row (mission.control.sweep); the unchanged tick wrote none", s.sweeps.length === 1 && s.sweeps[0].enlisted === 6)
  }

  // ─── C. verdicts → transitions ──────────────────────────────────────────────────────────────
  console.log("\nC. verdicts → transitions (one per tick, first applicable wins)")
  {
    // C1 budget exhausted without an attachAction (spent arrived another way) → on_exhausted
    const c = mem(); const s = seams()
    const now = new Date()
    const m = await createMission({ brokerageId: T1, objective: "budget", ownerManager: "ai_isa", initialState: "ACTIVE", budget: { usd: 10, on_exhausted: "WAITING" }, successCriteria: [{ metric: "new_contacts", op: ">=", target: 5 }] }, c as any, s.deps)
    if (!m.ok) throw new Error(m.reason)
    ;(row(c, m.mission.id) as any).spent_usd = 10; stamp(c, m.mission.id, now)
    const r = await controlMissions(T1, c as any, { now }, s.deps)
    check("C1 budget exhausted → budget.on_exhausted (WAITING) through transitionMission; the verdict names it", r.transitions === 1 && row(c, m.mission.id).state === "WAITING" && r.verdicts[0].flags.includes("budget_exhausted") && c.tables.mission_events.some((e) => e.event_kind === "transition" && e.to_state === "WAITING" && /budget exhausted/.test(e.reason) && e.actor_id === "cron_manager"))
    const m2 = await createMission({ brokerageId: T1, objective: "near", ownerManager: "ai_isa", initialState: "ACTIVE", budget: { usd: 10 }, successCriteria: [{ metric: "new_contacts", op: ">=", target: 5 }] }, c as any, s.deps)
    if (!m2.ok) throw new Error(m2.reason)
    ;(row(c, m2.mission.id) as any).spent_usd = 8.5; stamp(c, m2.mission.id, now)
    const r2 = await controlMissions(T1, c as any, { now, missionIds: [m2.mission.id] }, s.deps)
    check("C1 (control) 85% of budget → `budget_near` flag, NO transition", r2.transitions === 0 && r2.verdicts[0].flags.includes("budget_near") && row(c, m2.mission.id).state === "ACTIVE")
  }
  {
    // C2 authority: the plan needs COMMUNICATION (rung 3), the owner's ceiling is 2 → ESCALATED
    const c = mem(); const s = seams({ authority: 2 })
    const now = new Date()
    const m = await createMission({ brokerageId: T1, objective: "Increase listing appointments 15%", missionType: "brokerage_objective", ownerManager: "listing_concierge", initialState: "ACTIVE", objectiveSpec: { goalType: "listings_taken", targetValue: 14, currentValue: 12 }, twin }, c as any, s.deps)
    if (!m.ok) throw new Error(m.reason)
    stamp(c, m.mission.id, now)
    const r = await controlMissions(T1, c as any, { now }, s.deps)
    check("C2 required rung 3 (listing_publish is COMMUNICATION) > ceiling 2 → ESCALATED; the owner manager is signalled (mission_escalated)", r.transitions === 1 && row(c, m.mission.id).state === "ESCALATED" && r.verdicts[0].authority.required === 3 && r.verdicts[0].authority.insufficient && s.signals.some((x) => x.signalType === MISSION_ESCALATED_SIGNAL && x.toManager === "listing_concierge" && /authority insufficient/.test(x.message)), JSON.stringify(r.verdicts[0].authority))
    check("C2 (control) ceiling 6 on the same objective → no authority flag", (() => { const p = planMissionControl({ mission: { ...row(c, m.mission.id), authority_ceiling: 6, state: "ACTIVE" }, now, delegations: NO_DELEGATIONS(null), dependencyRows: [], children: [], lastVerdict: null }); return !p.authority.insufficient && p.transition === null })())
  }
  {
    // C3 disagreement: an open DISSENTED delegation (105A seam) → APPROVAL_REQUIRED (needsHuman)
    const c = mem()
    const now = new Date()
    const s0 = seams()
    const m = await createMission({ brokerageId: T1, objective: "dissent", ownerManager: "ai_isa", initialState: "ACTIVE", createdBy: "u-1", successCriteria: [{ metric: "new_contacts", op: ">=", target: 5 }] }, c as any, s0.deps)
    if (!m.ok) throw new Error(m.reason)
    stamp(c, m.mission.id, now)
    const s = seams({ delegations: { [m.mission.id]: { ...NO_DELEGATIONS(null), total: 2, open: 1, dissented: ["dlg-7"] } } })
    const r = await controlMissions(T1, c as any, { now }, s.deps)
    check("C3 a DISSENTED delegation → APPROVAL_REQUIRED through escalateMission(needsHuman): the owner is signalled (mission_escalated_for_approval) AND the creator is notified", r.transitions === 1 && row(c, m.mission.id).state === "APPROVAL_REQUIRED" && s.signals.some((x) => x.signalType === MISSION_APPROVAL_REQUIRED_SIGNAL && /DISSENTED/.test(x.message)) && (c.tables.notifications ?? []).some((n) => n.type === "mission_approval_required" && n.user_id === "u-1"))
    check("C3 the verdict says a human is needed and why", r.humanNeeded === 1 && r.verdicts[0].human.needed && /dlg-7/.test(r.verdicts[0].human.why ?? ""))
  }
  {
    // C4 dependencies: running → WAITING; done → resumed ACTIVE; failed → BLOCKED; foreign → BLOCKED
    const c = mem(); const s = seams()
    const now = new Date()
    const dep = await createMission({ brokerageId: T1, objective: "dep", ownerManager: "ai_isa", initialState: "ACTIVE", successCriteria: [{ metric: "x", op: ">=", target: 1 }] }, c as any, s.deps)
    const dep2 = await createMission({ brokerageId: T1, objective: "dep2", ownerManager: "ai_isa", initialState: "ACTIVE" }, c as any, s.deps)
    const foreign = await createMission({ brokerageId: T2, objective: "foreign", ownerManager: "ai_isa", initialState: "ACTIVE" }, c as any, s.deps)
    if (!dep.ok || !dep2.ok || !foreign.ok) throw new Error("setup C4")
    const m = await createMission({ brokerageId: T1, objective: "child", ownerManager: "ai_isa", initialState: "ACTIVE", dependencies: [dep.mission.id], parentMission: dep2.mission.id, successCriteria: [{ metric: "y", op: ">=", target: 1 }] }, c as any, s.deps)
    if (!m.ok) throw new Error(m.reason)
    for (const id of [dep.mission.id, dep2.mission.id, m.mission.id]) stamp(c, id, now)
    const r1 = await controlMissions(T1, c as any, { now, missionIds: [m.mission.id] }, s.deps)
    check("C4a a running dependency → WAITING (reason names it); the parent/child relation is read (children count on the parent's plan)", r1.transitions === 1 && row(c, m.mission.id).state === "WAITING" && r1.verdicts[0].dependencies.pending[0] === dep.mission.id && (await controlMissions(T1, c as any, { now, missionIds: [dep2.mission.id] }, s.deps)).verdicts[0].dependencies.children.total === 1)
    await sleep(3)
    const r1b = await controlMissions(T1, c as any, { now, missionIds: [m.mission.id] }, s.deps)
    check("C4b while it still runs: nothing moves, nothing is re-recorded", r1b.transitions === 0 && r1b.verdictsRecorded === 0)
    await recordMissionProgress({ brokerageId: T1, missionId: dep.mission.id, progress: { x: 1 } }, c as any, s.deps)
    await sleep(3)
    const r2 = await controlMissions(T1, c as any, { now: new Date(now.getTime() + HOUR), missionIds: [m.mission.id] }, s.deps)
    check("C4c the dependency COMPLETED (deterministic, on progress) → the controller RESUMES the mission it parked: WAITING → ACTIVE", row(c, dep.mission.id).state === "COMPLETED" && r2.transitions === 1 && row(c, m.mission.id).state === "ACTIVE" && /resumed/.test(r2.verdicts[0].transition?.reason ?? ""))
    const m3 = await createMission({ brokerageId: T1, objective: "on-failed", ownerManager: "ai_isa", initialState: "ACTIVE", dependencies: [dep2.mission.id] }, c as any, s.deps)
    if (!m3.ok) throw new Error(m3.reason)
    await transitionMission({ brokerageId: T1, missionId: dep2.mission.id, to: "CANCELLED", reason: "dropped" }, c as any, s.deps)
    stamp(c, m3.mission.id, now)
    const r3 = await controlMissions(T1, c as any, { now, missionIds: [m3.mission.id] }, s.deps)
    check("C4d a CANCELLED dependency → BLOCKED through blockMission with key dependency:<id>", r3.transitions === 1 && row(c, m3.mission.id).state === "BLOCKED" && row(c, m3.mission.id).blockers.some((b: any) => b.key === `dependency:${dep2.mission.id}` && !b.cleared_at))
    const m4 = await createMission({ brokerageId: T1, objective: "on-foreign", ownerManager: "ai_isa", initialState: "ACTIVE", dependencies: [foreign.mission.id] }, c as any, s.deps)
    if (!m4.ok) throw new Error(m4.reason)
    stamp(c, m4.mission.id, now)
    const r4 = await controlMissions(T1, c as any, { now, missionIds: [m4.mission.id] }, s.deps)
    check("C4e another tenant's mission as a dependency is MISSING here (tenant-pinned read) → BLOCKED, flagged dependency_missing", r4.transitions === 1 && row(c, m4.mission.id).state === "BLOCKED" && r4.verdicts[0].flags.includes("dependency_missing"))
  }
  {
    // C5 stalled: ACTIVE with no activity for the window → ESCALATED; an open delegation keeps it alive
    const c = mem(); const s = seams()
    const now = new Date()
    const stale = await createMission({ brokerageId: T1, objective: "stale", ownerManager: "ai_isa", initialState: "ACTIVE", successCriteria: [{ metric: "new_contacts", op: ">=", target: 5 }] }, c as any, s.deps)
    const busy = await createMission({ brokerageId: T1, objective: "busy", ownerManager: "ai_isa", initialState: "ACTIVE", successCriteria: [{ metric: "new_contacts", op: ">=", target: 5 }] }, c as any, s.deps)
    const fresh = await createMission({ brokerageId: T1, objective: "fresh", ownerManager: "ai_isa", initialState: "ACTIVE", successCriteria: [{ metric: "new_contacts", op: ">=", target: 5 }] }, c as any, s.deps)
    if (!stale.ok || !busy.ok || !fresh.ok) throw new Error("setup C5")
    stamp(c, stale.mission.id, new Date(now.getTime() - (MISSION_BLOCKED_STALE_HOURS + 1) * HOUR))
    stamp(c, busy.mission.id, new Date(now.getTime() - (MISSION_BLOCKED_STALE_HOURS + 1) * HOUR))
    stamp(c, fresh.mission.id, new Date(now.getTime() - HOUR))
    const sd = seams({ delegations: { [busy.mission.id]: { ...NO_DELEGATIONS(null), total: 1, open: 1, working: 1 } } })
    const r = await controlMissions(T1, c as any, { now }, sd.deps)
    const st = Object.fromEntries(c.tables.missions.map((x) => [x.objective, x.state]))
    check("C5 the stalled mission is ESCALATED (one stale window, MISSION_BLOCKED_STALE_HOURS); a WORKING delegation keeps `busy` ACTIVE; `fresh` is untouched", r.transitions === 1 && st.stale === "ESCALATED" && st.busy === "ACTIVE" && st.fresh === "ACTIVE", JSON.stringify(st))
    check("C5 (ordering) one transition per tick: a stalled mission whose budget is ALSO exhausted moves for the budget, the stall is still a flag", (() => { const p = planMissionControl({ mission: { ...row(c, fresh.mission.id), updated_at: new Date(now.getTime() - 100 * HOUR).toISOString(), budget: { usd: 1 }, spent_usd: 1 } as any, now, delegations: NO_DELEGATIONS(null), dependencyRows: [], children: [], lastVerdict: null }); return p.transition?.to === "APPROVAL_REQUIRED" && p.flags.includes("stalled") && p.flags.includes("budget_exhausted") })())
  }
  {
    // C6 completion: criteria met → COMPLETED through the service's own judgement (an ESCALATED mission included)
    const c = mem(); const s = seams()
    const now = new Date()
    const m = await createMission({ brokerageId: T1, objective: "met", ownerManager: "ai_isa", initialState: "ACTIVE", successCriteria: [{ metric: "new_contacts", op: ">=", target: 5 }] }, c as any, s.deps)
    if (!m.ok) throw new Error(m.reason)
    await transitionMission({ brokerageId: T1, missionId: m.mission.id, to: "ESCALATED", reason: "stalled earlier" }, c as any, s.deps)
    ;(row(c, m.mission.id) as any).progress = { new_contacts: 5 }; stamp(c, m.mission.id, now)
    const r = await controlMissions(T1, c as any, { now }, s.deps)
    check("C6 criteria met on an ESCALATED mission → COMPLETED (transitionMission re-judges evaluateSuccess)", r.transitions === 1 && row(c, m.mission.id).state === "COMPLETED" && !!row(c, m.mission.id).completed_at)
    check("C6 (control) a terminal mission is out of the loop: the next tick scans nothing", (await controlMissions(T1, c as any, { now }, s.deps)).scanned === 0)
  }

  // ─── D/E. acknowledgement, idempotency, isolation, the seam degrade ─────────────────────────
  console.log("\nD. a human's answer stands — no ping-pong; E. isolation + the seam")
  {
    const c = mem(); const s = seams({ authority: 2 })
    const t0 = new Date()
    const m = await createMission({ brokerageId: T1, objective: "Increase listing appointments 15%", missionType: "brokerage_objective", ownerManager: "listing_concierge", initialState: "ACTIVE", objectiveSpec: { goalType: "listings_taken", targetValue: 14, currentValue: 12 }, twin }, c as any, s.deps)
    if (!m.ok) throw new Error(m.reason)
    stamp(c, m.mission.id, t0)
    await controlMissions(T1, c as any, { now: t0 }, s.deps)
    check("D1 tick 1: authority insufficient → ESCALATED", row(c, m.mission.id).state === "ESCALATED")
    await sleep(3)
    const t1 = new Date(Date.now() + 60_000)
    const human = await transitionMission({ brokerageId: T1, missionId: m.mission.id, to: "ACTIVE", reason: "the broker will handle the sends herself" , actor: { type: "user", id: "u-1" } }, c as any, { ...s.deps, now: () => t1 })
    await sleep(3)
    const r2 = await controlMissions(T1, c as any, { now: new Date(t1.getTime() + HOUR) }, s.deps)
    check("D2 a human moved it back to ACTIVE AFTER the verdict → the same finding is ACKNOWLEDGED, not re-raised (no transition; the flag stays visible)", human.ok && r2.transitions === 0 && row(c, m.mission.id).state === "ACTIVE" && r2.verdicts[0].flags.includes("authority_insufficient") && r2.verdicts[0].acknowledged.authority_insufficient === row(c, m.mission.id).state_changed_at, JSON.stringify({ t: r2.transitions, ack: r2.verdicts[0].acknowledged }))
    await sleep(3)
    const r3 = await controlMissions(T1, c as any, { now: new Date(t1.getTime() + 2 * HOUR) }, s.deps)
    check("D3 the acknowledgement CARRIES while that decision stands: a third tick still does not re-escalate and records nothing new", r3.transitions === 0 && r3.verdictsRecorded === 0 && row(c, m.mission.id).state === "ACTIVE")
    const r4 = await controlMissions(T2, c as any, { now: t1 }, s.deps)
    const one = await controlMission(T2, m.mission.id, c as any, { now: t1 }, s.deps)
    check("E1 tenant isolation: another tenant's tick scans nothing; controlMission on a foreign id → not_found; the row untouched", r4.scanned === 0 && !one.ok && one.reason === "not_found" && row(c, m.mission.id).state === "ACTIVE")
    check("E2 no tenant → readRefused published, nothing judged", (await controlMissions("", c as any, {}, s.deps)).readRefused === "no tenant")
  }
  {
    // the delegation seam degrades: table absent (42P01, m712 not applied) → unreadable, published; never a fake 0
    const c = mem({}, { missingTables: ["manager_delegations"] }); const s = seams()
    const now = new Date()
    const m = await createMission({ brokerageId: T1, objective: "seam", ownerManager: "ai_isa", initialState: "ACTIVE", successCriteria: [{ metric: "new_contacts", op: ">=", target: 5 }] }, c as any, s.deps)
    if (!m.ok) throw new Error(m.reason)
    stamp(c, m.mission.id, now)
    const r = await controlMissions(T1, c as any, { now }, s.deps)
    check("E3 the DEFAULT delegation seam with manager_delegations absent → `delegations_unreadable` (the refusal published on the plan), no dissent invented, the loop still judged the mission", r.delegationsUnreadable === 1 && !!r.verdicts[0].delegations.readRefused?.includes("manager_delegations") && r.verdicts[0].flags.includes("delegations_unreadable") && !r.verdicts[0].flags.includes("dissent_open") && r.scanned === 1 && /delegations unreadable/.test(r.verdicts[0].line))
    const c2 = mem({ manager_delegations: [{ id: "d1", brokerage_id: T1, mission_id: "M", status: "DISSENTED" }, { id: "d2", brokerage_id: T1, mission_id: "M", status: "WORKING" }, { id: "d3", brokerage_id: T2, mission_id: "M", status: "DISSENTED" }] })
    const { defaultControllerDeps } = await import("../lib/kernel/mission-controller")
    const dg = await defaultControllerDeps.delegations(T1, ["M"], c2 as any)
    check("E3 (control) with the table present the default seam reads 105A's vocabulary tenant-pinned: 1 open/working, 1 dissented, the other tenant's row unseen", dg.M.total === 2 && dg.M.open === 1 && dg.M.working === 1 && dg.M.dissented.join() === "d1" && dg.M.readRefused === null)
    const lines = await missionVerdictLines(T1, [row(c, m.mission.id)], c as any, s.deps, now)
    check("E4 missionVerdictLines (the card's door) plans without writing: a line per mission, no new mission_events row", typeof lines[m.mission.id]?.line === "string" && c.tables.mission_events.filter((e) => e.reason_code === MISSION_CONTROL_REASON && e.evidence.digest).length === 1)
    check("E5 batch is BOUNDED: a limit above MISSION_CONTROL_BATCH is clamped (rule, not a count pin)", MISSION_CONTROL_BATCH > 0 && (await controlMissions(T1, c as any, { now, limit: MISSION_CONTROL_BATCH * 10 }, s.deps)).scanned <= MISSION_CONTROL_BATCH)
  }

  // ─── F. wiring + registration ───────────────────────────────────────────────────────────────
  console.log("\nF. wiring + registration (stripped source — a tombstone is not a call site)")
  {
    const ctl = src("lib/kernel/mission-controller.ts")
    check("F1 the controller moves state ONLY through the mission service: transitionMission / blockMission / escalateMission / enlistMissionParticipants / recordMissionEvidence; no .from(\"missions\").update(", ["transitionMission(", "blockMission(", "escalateMission(", "enlistMissionParticipants(", "recordMissionEvidence("].every((t) => ctl.includes(t)) && !/from\("missions"\)\s*\.update\(/.test(ctl) && !/from\("missions"\)\s*\.insert\(/.test(ctl))
    check("F2 no model call anywhere in the controller (deterministic): no generateText / generateObject / anthropic / openai import", !/generateText|generateObject|@anthropic|openai|ai-gateway/.test(ctl))
    check("F3 ownership resolves through the REGISTRY: CAPABILITY_MANAGER, MANAGER_COLLABORATIONS, TABLE_MANAGER imported and used; MIN_AUTHORITY_FOR_RISK is the one rung table", ["CAPABILITY_MANAGER[", "MANAGER_COLLABORATIONS[", "TABLE_MANAGER[", "MIN_AUTHORITY_FOR_RISK["].every((t) => ctl.includes(t)))
    const reaper = src("lib/workflow-orchestrator/stale-run-reaper.ts")
    check("F4 the ONE tick: stale-run-reaper runs sweepMissionDeadlines THEN controlMissions (same tenant pass); reaper-net still runs the one reaper", reaper.includes("sweepMissionDeadlines(") && reaper.includes("controlMissions(") && reaper.indexOf("sweepMissionDeadlines(") < reaper.indexOf("controlMissions(") && src("lib/intelligence/reaper-net.ts").includes("reapStaleWorkflowRuns"))
    const door = src("app/actions/missions.ts")
    check("F5 the human door stays \"use server\", tenant from requireCallerTenant(), and hands the card missionVerdictLines (plan only)", door.startsWith("\"use server\"") && door.includes("requireCallerTenant()") && door.includes("missionVerdictLines(") && !/export (const|type|interface)/.test(door))
    check("F6 the Missions card renders the verdict line per mission and the page passes it", src("app/dashboard/admin/command-center/missions-card.tsx").includes("verdict.line") && /verdicts=\{missions\.data\.verdicts\}/.test(src("app/dashboard/admin/command-center/page.tsx")))
    check("F7 the evidence reason code is ONE spelling: MISSION_CONTROL_REASON exported by missions.ts, used by the controller", src("lib/kernel/missions.ts").includes("MISSION_CONTROL_REASON = \"MISSION_CONTROL\"") && ctl.includes("MISSION_CONTROL_REASON") && MISSION_CONTROL_REASON === "MISSION_CONTROL")
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }
    check("F8 package.json test:mission-controller → this guard, on the chain", pkg.scripts["test:mission-controller"] === "tsx scripts/mission-controller-guard.ts" && /npm run test:mission-controller(\s|&|$)/.test(pkg.scripts.guard))
    const dom = MAINTENANCE_DOMAINS.executive_mission_controller
    check("F9 MAINTENANCE_DOMAINS owns it (cron_manager; co-owners campaign_orchestrator + data_steward named in prose, every pair canRefer-licensed)", !!dom && dom.manager === "cron_manager" && dom.proof === "test:mission-controller" && JSON.stringify(dom.coOwners) === JSON.stringify(["campaign_orchestrator", "data_steward"]) && /CROSS-COOPERATED/.test(dom.what) && dom.what.includes("campaign_orchestrator") && dom.what.includes("data_steward") && (dom.coOwners ?? []).every((co) => canRefer("cron_manager", co)))
    check("F10 the controller actor is the operations seat (cron_manager), a MANAGERS key", MISSION_CONTROLLER_ACTOR.type === "manager" && MISSION_CONTROLLER_ACTOR.id! in MANAGERS)
    const fixture = stripComments(`// TOMBSTONE: controlMissions( used to be called here\nconst x = 1\n/* transitionMission( */`)
    check("F11 (control) a tombstone naming a door is NOT read as a call site", !fixture.includes("controlMissions(") && !fixture.includes("transitionMission(") && fixture.includes("const x = 1"))
  }

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  console.log(" BLIND SPOTS: in-memory client (no RLS, no CHECK, no append-only trigger — m710 holds those live; manager_delegations' shape is 105A's m712 vocabulary asserted by name); the reaper / cron wire is asserted by stripped source (its runtime path needs a live tick); no listing_appointments goal type or twin measure exists (m373) — the owner's example rides listings_taken; capability → risk class is a naming rule, not a per-tool classification; the stale window reads missions.updated_at, which any row write moves.")
  if (fail > 0) { console.log(" ❌ MISSION_CONTROLLER_FAIL"); process.exit(1) }
  console.log(" ✅ MISSION_CONTROLLER_PASS — one deterministic supervisor above the managers: registry keys decide who, the service moves what, every verdict is evidence")
}
main().catch((e) => { console.error(e); process.exit(1) })
