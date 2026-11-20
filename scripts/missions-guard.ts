#!/usr/bin/env tsx
/**
 * scripts/missions-guard.ts   (npm run test:missions) — wave 104, lane 104D.
 * ─────────────────────────────────────────────────────────────────────────────
 * DURABLE MISSION RUNTIME — in-memory client, no network. Proves lib/kernel/missions.ts:
 *   A. the state machine — every admitted edge, every refused edge recorded as evidence, terminal states
 *   B. authority ceiling refusal → APPROVAL_REQUIRED; budget exhaustion → WAITING / APPROVAL_REQUIRED
 *   C. deadline / stale blocker → ESCALATED through the reaper seam (+ the owner manager signalled)
 *   D. evidence: a mission_events row + a ledger row (reason MISSION_LIFECYCLE, detail.mission_id,
 *      causation / correlation of the enclosing scope) per transition; the REAL ledger survivor writes
 *      an agent_action_ledger row through the same client
 *   E. tenant isolation; success-criteria determinism; entitlement refusal fails closed
 *   F. wiring (stripped source) + registration
 * Rules asserted, not waypoints: no migration pin, no "WRITTEN" header pin.
 */
import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { stripComments } from "./strip-comments"
import {
  MISSION_STATES, MISSION_TRANSITIONS, MISSION_TERMINAL_STATES, MISSION_LIFECYCLE_REASON, MISSION_BLOCKED_STALE_HOURS,
  MISSION_ESCALATED_SIGNAL, MISSION_APPROVAL_REQUIRED_SIGNAL,
  canTransition, evaluateSuccess, budgetExhausted, withinAuthorityCeiling,
  createMission, transitionMission, attachAction, attachOutcome, blockMission, unblockMission, escalateMission,
  completeMission, failMission, recordMissionProgress, activeMissionsFor, sweepMissionDeadlines,
  syncMissionProgressFromTwin, criteriaFromDecomposition,
  type MissionState, type MissionDeps,
} from "../lib/kernel/missions"
import { twinSeams, decomposeObjective, type BrokerageTwin } from "../lib/kernel/brokerage-twin"
import { missionOutcomeCredits, attributeOutcomesToLedger } from "../lib/intelligence/roi-ledger"
import { withCausationFrom } from "../lib/kernel/causation"
import { MAINTENANCE_DOMAINS, MANAGERS, TABLE_MANAGER } from "../lib/kernel/manager-registry"
import { SIGNAL_REGISTRY } from "../lib/kernel/signal-registry"
import { KernelEvent } from "../lib/kernel/events"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}${detail ? `\n      ${detail}` : ""}`) } }
const src = (p: string) => stripComments(readFileSync(p, "utf8"))

// ─── in-memory supabase-js shaped client ──────────────────────────────────────────────────────
type Row = Record<string, any>
function memClient(tables: Record<string, Row[]> = {}) {
  const t = (name: string) => (tables[name] ??= [])
  return {
    tables,
    from(table: string) {
      const preds: Array<(r: Row) => boolean> = []
      let op: "select" | "insert" | "update" | "delete" = "select"
      let payload: Row | Row[] | null = null
      let limitN: number | null = null
      const run = (): { data: any; error: any } => {
        if (op === "insert") {
          const rows = (Array.isArray(payload) ? payload : [payload!]).map((r) => ({ id: randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...r }))
          for (const r of rows) {
            // the m710 defaults the service relies on
            if (table === "missions") Object.assign(r, { spent_usd: r.spent_usd ?? 0, spent_tokens: r.spent_tokens ?? 0, blockers: r.blockers ?? [], evidence: r.evidence ?? [], progress: r.progress ?? {}, actions: r.actions ?? [], outcomes: r.outcomes ?? [], state_changed_at: r.state_changed_at ?? r.created_at })
            t(table).push(r)
          }
          return { data: rows, error: null }
        }
        const hits = t(table).filter((r) => preds.every((p) => p(r)))
        if (op === "update") { for (const r of hits) Object.assign(r, payload) ; return { data: hits.map((r) => structuredClone(r)), error: null } }
        if (op === "delete") { tables[table] = t(table).filter((r) => !hits.includes(r)); return { data: hits, error: null } }
        // the database hands back copies, never its own storage
        return { data: (limitN ? hits.slice(0, limitN) : hits).map((r) => structuredClone(r)), error: null }
      }
      const b: any = {
        select: () => b, order: () => b, not: () => b, is: () => b, or: () => b, gte: () => b, lte: () => b, lt: () => b, neq: () => b,
        limit: (n: number) => { limitN = n; return b },
        insert: (p: Row | Row[]) => { op = "insert"; payload = p; return b },
        update: (p: Row) => { op = "update"; payload = p; return b },
        delete: () => { op = "delete"; return b },
        eq: (c: string, v: unknown) => { preds.push((r) => r[c] === v); return b },
        in: (c: string, vs: unknown[]) => { preds.push((r) => vs.includes(r[c])); return b },
        contains: (c: string, v: Row) => { preds.push((r) => Object.entries(v).every(([k, x]) => r[c]?.[k] === x)); return b },
        single: () => { const r = run(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }) },
        maybeSingle: () => { const r = run(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }) },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
      }
      return b
    },
  }
}

/** Observing seams — every default stays the survivor; the proof records what the service hands them. */
function seams(over: Partial<{ authority: number; afford: boolean }> = {}) {
  const ledger: any[] = [], emits: any[] = [], signals: any[] = []
  const deps: MissionDeps = {
    afford: async () => ({ allowed: over.afford ?? true, reason: over.afford === false ? "past_due_not_served:app.access" : "active" }),
    authority: async () => (over.authority ?? 6) as any,
    ledger: async (ctx) => { ledger.push(ctx); return `ledger-${ledger.length}` },
    emit: async (i) => { emits.push(i) },
    signal: async (s) => { signals.push(s) },
  }
  return { deps, ledger, emits, signals }
}

const T1 = "11111111-1111-4111-8111-111111111111"
const T2 = "22222222-2222-4222-8222-222222222222"
const base = { brokerageId: T1, objective: "Close 24 sides in 2026", ownerManager: "recruiting_manager" as const, participatingManagers: ["ai_isa" as const, "campaign_orchestrator" as const] }

async function main() {
  // ─── A. state machine ───────────────────────────────────────────────────────────────────────
  console.log("\nA. the state machine (every edge, every refusal, terminal states)")
  check("A1 the ten owner states, one vocabulary, in the owner's order", MISSION_STATES.join(",") === "PROPOSED,PLANNING,ACTIVE,WAITING,BLOCKED,APPROVAL_REQUIRED,ESCALATED,COMPLETED,FAILED,CANCELLED")
  check("A2 every state has a transition row; terminal states have NO exits", MISSION_STATES.every((s) => Array.isArray(MISSION_TRANSITIONS[s])) && [...MISSION_TERMINAL_STATES].every((s) => MISSION_TRANSITIONS[s].length === 0))
  check("A3 no edge targets an unknown state, none is a self-loop", MISSION_STATES.every((s) => MISSION_TRANSITIONS[s].every((to) => MISSION_STATES.includes(to) && to !== s)))
  check("A4 COMPLETED is reachable only from ACTIVE / ESCALATED (an objective is met while being worked)", MISSION_STATES.filter((s) => canTransition(s, "COMPLETED")).join(",") === "ACTIVE,ESCALATED")
  check("A5 positive control: canTransition refuses an edge the table lacks (COMPLETED → ACTIVE)", !canTransition("COMPLETED", "ACTIVE") && !canTransition("PROPOSED", "COMPLETED"))

  {
    const c = memClient(); const s = seams()
    const created = await createMission(base, c as any, s.deps)
    check("A6 createMission → PROPOSED, owner + participants are registry keys, ceiling from the ladder", created.ok && created.mission.state === "PROPOSED" && created.mission.owner_manager in MANAGERS && created.mission.participating_managers.every((k) => k in MANAGERS) && created.mission.authority_ceiling === 6)
    if (!created.ok) throw new Error(created.reason)
    const id = created.mission.id
    const walk: MissionState[] = ["PLANNING", "ACTIVE", "WAITING", "ACTIVE", "BLOCKED", "ESCALATED", "APPROVAL_REQUIRED", "ACTIVE"]
    let okAll = true
    for (const to of walk) { const r = await transitionMission({ brokerageId: T1, missionId: id, to, reason: `walk → ${to}` }, c as any, s.deps); okAll &&= r.ok && r.mission.state === to }
    check("A7 an admitted walk PLANNING→ACTIVE→WAITING→ACTIVE→BLOCKED→ESCALATED→APPROVAL_REQUIRED→ACTIVE moves the row each time", okAll && c.tables.missions[0].state === "ACTIVE")
    const bad = await transitionMission({ brokerageId: T1, missionId: id, to: "PLANNING", reason: "backwards" }, c as any, s.deps)
    check("A8 a transition not in the table is REFUSED (ACTIVE → PLANNING), the row does not move", !bad.ok && bad.reason.startsWith("invalid_transition") && c.tables.missions[0].state === "ACTIVE")
    const refusedRows = c.tables.mission_events.filter((e) => e.event_kind === "refused")
    check("A9 the refusal is EVIDENCE — a `refused` mission_events row naming from/to", refusedRows.length === 1 && refusedRows[0].from_state === "ACTIVE" && refusedRows[0].to_state === "PLANNING")
    const unknown = await transitionMission({ brokerageId: T1, missionId: id, to: "DONE" as any, reason: "typo" }, c as any, s.deps)
    check("A10 an unknown state spelling is refused before the machine is consulted", !unknown.ok && unknown.reason.startsWith("unknown_state"))
    const cancelled = await transitionMission({ brokerageId: T1, missionId: id, to: "CANCELLED", reason: "owner cancelled" }, c as any, s.deps)
    const after = await transitionMission({ brokerageId: T1, missionId: id, to: "ACTIVE", reason: "resurrect" }, c as any, s.deps)
    check("A11 a terminal state is final: CANCELLED stamps completed_at and refuses every exit", cancelled.ok && !!c.tables.missions[0].completed_at && !after.ok && after.reason.startsWith("invalid_transition"))
    const transitions = c.tables.mission_events.filter((e) => e.event_kind === "transition")
    check("A12 one `transition` evidence row per admitted move (8 walk + 1 cancel), one `created` row", transitions.length === 9 && c.tables.mission_events.filter((e) => e.event_kind === "created").length === 1)
  }

  // ─── B. authority ceiling + budget ─────────────────────────────────────────────────────────
  console.log("\nB. authority ceiling + budget (the usage/cost vocabulary)")
  check("B1 withinAuthorityCeiling follows MIN_AUTHORITY_FOR_RISK: READ at 0 ok, COMMUNICATION needs 3, IRREVERSIBLE never autonomous", withinAuthorityCeiling(0, "READ") && !withinAuthorityCeiling(2, "COMMUNICATION") && withinAuthorityCeiling(3, "COMMUNICATION") && !withinAuthorityCeiling(6, "IRREVERSIBLE"))
  check("B2 budgetExhausted: usd OR tokens cap reached; an empty budget is unmetered", budgetExhausted({ usd: 10 }, 10, 0) && budgetExhausted({ tokens: 100 }, 0, 100) && !budgetExhausted({ usd: 10 }, 9.99, 0) && !budgetExhausted({}, 1e9, 1e9))
  {
    const c = memClient(); const s = seams({ authority: 2 })
    const m = await createMission({ ...base, initialState: "ACTIVE", budget: { usd: 5 } }, c as any, s.deps)
    if (!m.ok) throw new Error(m.reason)
    check("B3 the ceiling is the OWNER manager's ladder rung (2 here)", m.mission.authority_ceiling === 2)
    const refused = await attachAction({ brokerageId: T1, missionId: m.mission.id, ledgerEntryId: randomUUID(), riskClass: "COMMUNICATION", costUsd: 1 }, c as any, s.deps)
    check("B4 a COMMUNICATION action above ceiling 2 is REFUSED, not attached, and the mission goes APPROVAL_REQUIRED", !refused.ok && refused.refusedAction === true && c.tables.missions[0].state === "APPROVAL_REQUIRED" && c.tables.missions[0].actions.length === 0)
    check("B5 the refusal signalled the owner manager (mission_approval_required) and is a `refused` evidence row", s.signals.some((x) => x.signalType === MISSION_APPROVAL_REQUIRED_SIGNAL && x.toManager === "recruiting_manager") && c.tables.mission_events.some((e) => e.event_kind === "refused" && e.evidence.risk_class === "COMMUNICATION"))
    const ok1 = await attachAction({ brokerageId: T1, missionId: m.mission.id, ledgerEntryId: randomUUID(), riskClass: "READ", costUsd: 2, tokens: 500 }, c as any, s.deps)
    check("B6 a READ action within the ceiling attaches and charges cost_usd + tokens against the budget", ok1.ok && ok1.mission.actions.length === 1 && Number(c.tables.missions[0].spent_usd) === 2 && Number(c.tables.missions[0].spent_tokens) === 500)
  }
  {
    const c = memClient(); const s = seams()
    const m = await createMission({ ...base, initialState: "ACTIVE", budget: { usd: 5 } }, c as any, s.deps)
    if (!m.ok) throw new Error(m.reason)
    const r = await attachAction({ brokerageId: T1, missionId: m.mission.id, ledgerEntryId: randomUUID(), riskClass: "LOW_RISK_WRITE", costUsd: 5 }, c as any, s.deps)
    check("B7 budget exhausted ($5 of $5) → APPROVAL_REQUIRED by default, the action still recorded", r.ok && r.mission.state === "APPROVAL_REQUIRED" && c.tables.missions[0].actions.length === 1)
    const c2 = memClient(); const s2 = seams()
    const m2 = await createMission({ ...base, initialState: "ACTIVE", budget: { tokens: 1000, on_exhausted: "WAITING" } }, c2 as any, s2.deps)
    if (!m2.ok) throw new Error(m2.reason)
    const r2 = await attachAction({ brokerageId: T1, missionId: m2.mission.id, ledgerEntryId: randomUUID(), tokens: 1000 }, c2 as any, s2.deps)
    check("B8 budget.on_exhausted = WAITING → WAITING (a soft stop the next sweep can resume)", r2.ok && r2.mission.state === "WAITING" && c2.tables.missions[0].state === "WAITING")
  }

  // ─── C. reaper: deadline + stale blocker → ESCALATED ───────────────────────────────────────
  console.log("\nC. deadlines + blockers on the ONE reaper tick")
  {
    const c = memClient(); const s = seams()
    const now = new Date("2026-10-05T12:00:00Z")
    const due = await createMission({ ...base, initialState: "ACTIVE", deadline: "2026-10-01T00:00:00Z" }, c as any, s.deps)
    const fresh = await createMission({ ...base, objective: "fresh", initialState: "ACTIVE", deadline: "2026-12-31T00:00:00Z" }, c as any, s.deps)
    const blocked = await createMission({ ...base, objective: "blocked", initialState: "ACTIVE" }, c as any, s.deps)
    if (!due.ok || !fresh.ok || !blocked.ok) throw new Error("setup")
    await blockMission({ brokerageId: T1, missionId: blocked.mission.id, key: "lender_docs", reason: "waiting on lender" }, c as any, { ...s.deps, now: () => new Date(now.getTime() - (MISSION_BLOCKED_STALE_HOURS + 1) * 3_600_000) })
    const row = c.tables.missions.find((r) => r.id === blocked.mission.id)!
    row.state_changed_at = new Date(now.getTime() - (MISSION_BLOCKED_STALE_HOURS + 1) * 3_600_000).toISOString()
    const sweep = await sweepMissionDeadlines(T1, c as any, { now }, s.deps)
    const states = Object.fromEntries(c.tables.missions.map((r) => [r.objective, r.state]))
    check("C1 the sweep ESCALATES the past-deadline mission and the 72h-stale BLOCKED one, leaves the fresh one", sweep.scanned === 3 && sweep.escalated === 2 && states["Close 24 sides in 2026"] === "ESCALATED" && states.blocked === "ESCALATED" && states.fresh === "ACTIVE")
    check("C2 each escalation signalled the OWNER manager from cron_manager (mission_escalated) with the reason", s.signals.filter((x) => x.signalType === MISSION_ESCALATED_SIGNAL && x.fromManager === "cron_manager" && x.toManager === "recruiting_manager").length === 2 && s.signals.some((x) => /deadline/.test(x.message)) && s.signals.some((x) => /blocked for/.test(x.message)))
    const again = await sweepMissionDeadlines(T1, c as any, { now }, s.deps)
    check("C3 idempotent: a second sweep escalates nothing (ESCALATED rows are not re-scanned)", again.escalated === 0)
    const un = await unblockMission({ brokerageId: T1, missionId: blocked.mission.id, key: "lender_docs", reason: "docs arrived" }, c as any, s.deps)
    check("C4 unblock clears the blocker (cleared_at) — an ESCALATED mission stays for a human (only BLOCKED resumes to ACTIVE)", un.ok && un.mission.blockers.every((b: any) => b.cleared_at) && row.state === "ESCALATED")
    const c5 = memClient(); const s5 = seams()
    const m5 = await createMission({ ...base, initialState: "ACTIVE" }, c5 as any, s5.deps)
    if (!m5.ok) throw new Error(m5.reason)
    await blockMission({ brokerageId: T1, missionId: m5.mission.id, key: "k", reason: "r" }, c5 as any, s5.deps)
    const un5 = await unblockMission({ brokerageId: T1, missionId: m5.mission.id, key: "k", reason: "done" }, c5 as any, s5.deps)
    check("C5 block → BLOCKED, the last unblock → ACTIVE again", un5.ok && un5.mission.state === "ACTIVE" && c5.tables.mission_events.some((e) => e.event_kind === "blocker_added") && c5.tables.mission_events.some((e) => e.event_kind === "blocker_cleared"))
    const esc = await escalateMission({ brokerageId: T1, missionId: m5.mission.id, reason: "needs the broker", needsHuman: true, actor: { type: "manager", id: "ai_isa" } }, c5 as any, s5.deps)
    check("C6 escalate(needsHuman) → APPROVAL_REQUIRED; a participating manager raises it TO the owner", esc.ok && esc.mission.state === "APPROVAL_REQUIRED" && s5.signals.some((x) => x.fromManager === "ai_isa" && x.toManager === "recruiting_manager" && x.signalType === MISSION_APPROVAL_REQUIRED_SIGNAL))
    const c6 = memClient(); const s6 = seams()
    const m6 = await createMission({ ...base, initialState: "ACTIVE", createdBy: randomUUID() }, c6 as any, s6.deps)
    if (!m6.ok) throw new Error(m6.reason)
    await escalateMission({ brokerageId: T1, missionId: m6.mission.id, reason: "approve the spend", needsHuman: true }, c6 as any, s6.deps)
    check("C7 APPROVAL_REQUIRED notifies the HUMAN who created it (notifications type mission_approval_required)", (c6.tables.notifications ?? []).some((n) => n.type === "mission_approval_required" && n.user_id === m6.mission.created_by && n.entity_id === m6.mission.id))
  }

  // ─── D. evidence: ledger + causation per transition ─────────────────────────────────────────
  console.log("\nD. evidence — ledger row + causation per transition")
  {
    const c = memClient(); const s = seams()
    const m = await withCausationFrom("e0e0e0e0-0000-4000-8000-000000000001", () => createMission({ ...base, initialState: "ACTIVE" }, c as any, s.deps))
    if (!m.ok) throw new Error(m.reason)
    await withCausationFrom("e0e0e0e0-0000-4000-8000-000000000002", () => transitionMission({ brokerageId: T1, missionId: m.mission.id, to: "WAITING", reason: "cooldown" }, c as any, s.deps))
    check("D1 every transition hands the ledger reason MISSION_LIFECYCLE, action domain.entity.action, detail.mission_id", s.ledger.length === 2 && s.ledger.every((l) => l.missionId === m.mission.id && /^[a-z]+\.[a-z]+\.[a-z]+$/.test(l.action)) && s.ledger[1].from === "ACTIVE" && s.ledger[1].to === "WAITING", JSON.stringify(s.ledger.map((l) => [l.action, l.missionId === m.mission.id, l.from, l.to])))
    check("D2 the causation of the enclosing scope rides the ledger ctx AND the mission_events row (causation_id = the event, correlation = the root)", s.ledger[1].causationId === "e0e0e0e0-0000-4000-8000-000000000002" && c.tables.mission_events.filter((e) => e.event_kind === "transition").every((e) => e.causation_id === "e0e0e0e0-0000-4000-8000-000000000002" && e.correlation_id === "e0e0e0e0-0000-4000-8000-000000000002"))
    check("D3 the evidence row names the ledger row it rode (ledger_entry_id) and the reason", c.tables.mission_events.filter((e) => e.event_kind === "transition").every((e) => e.ledger_entry_id?.startsWith("ledger-") && e.reason_code === MISSION_LIFECYCLE_REASON && e.reason === "cooldown"))
    check("D4 MISSION_CREATED + MISSION_STATE_CHANGED emitted (auditOnly) with the mission as entity", s.emits.length === 2 && s.emits[0].event === KernelEvent.MISSION_CREATED && s.emits[1].event === KernelEvent.MISSION_STATE_CHANGED && s.emits[1].metadata.to_state === "WAITING")
    check("D5 outside any scope the evidence carries null causation — a human click has no cause but the human", (await (async () => { const cc = memClient(); const ss = seams(); const mm = await createMission(base, cc as any, ss.deps); return mm.ok && cc.tables.mission_events[0].causation_id === null && ss.ledger[0].causationId === null })()))
  }
  {
    // THE REAL LEDGER SURVIVOR through the in-memory client (default deps for ledger only).
    const c = memClient(); const s = seams()
    const { ledger: _drop, ...rest } = s.deps
    const m = await createMission({ ...base, initialState: "ACTIVE" }, c as any, rest)
    const t = m.ok ? await transitionMission({ brokerageId: T1, missionId: m.mission.id, to: "WAITING", reason: "real ledger" }, c as any, rest) : null
    const rows = c.tables.agent_action_ledger ?? []
    const mid = m.ok ? m.mission.id : null
    check("D6 the default ledger seam IS withActionLedger: agent_action_ledger rows land with subject mission, reason_code MISSION_LIFECYCLE, detail.mission_id, status executed", !!t?.ok && rows.length === 2 && rows.every((r) => r.subject_type === "mission" && r.subject_id === mid && r.reason_code === MISSION_LIFECYCLE_REASON && r.detail?.mission_id === mid && r.status === "executed"), JSON.stringify(rows.map((r) => [r.subject_type, r.subject_id === mid, r.reason_code, r.detail?.mission_id === mid, r.status])))
    check("D7 the mission_events row names the REAL ledger row id", c.tables.mission_events.filter((e) => e.event_kind === "transition").every((e) => rows.some((r) => r.id === e.ledger_entry_id)))
  }

  // ─── E. tenant isolation, success criteria, entitlement ─────────────────────────────────────
  console.log("\nE. tenant isolation · deterministic completion · entitlement")
  {
    const c = memClient(); const s = seams()
    const m = await createMission({ ...base, initialState: "ACTIVE", successCriteria: [{ metric: "transactions_closed", op: ">=", target: 2 }] }, c as any, s.deps)
    if (!m.ok) throw new Error(m.reason)
    const foreign = await transitionMission({ brokerageId: T2, missionId: m.mission.id, to: "CANCELLED", reason: "other tenant" }, c as any, s.deps)
    const foreignBlock = await blockMission({ brokerageId: T2, missionId: m.mission.id, key: "x", reason: "x" }, c as any, s.deps)
    const foreignList = await activeMissionsFor(T2, {}, c as any)
    check("E1 another tenant's id matches NOTHING: transition / block → not_found, the list is empty, the row untouched", !foreign.ok && foreign.reason === "not_found" && !foreignBlock.ok && foreignList.active.length === 0 && c.tables.missions[0].state === "ACTIVE")
    const early = await completeMission({ brokerageId: T1, missionId: m.mission.id, reason: "we feel done" }, c as any, s.deps)
    check("E2 COMPLETED is refused while success criteria are unmet (deterministic, never asserted) and recorded as evidence", !early.ok && early.reason.startsWith("criteria_unmet") && c.tables.mission_events.some((e) => e.event_kind === "refused" && /criteria/.test(e.reason)))
    await attachOutcome({ brokerageId: T1, missionId: m.mission.id, outcome: { kind: "closed", entityType: "transaction", entityId: randomUUID(), valueUsd: 9000 }, progressMetric: "transactions_closed" }, c as any, s.deps)
    const partial = await recordMissionProgress({ brokerageId: T1, missionId: m.mission.id, progress: { transactions_closed: 1 } }, c as any, s.deps)
    check("E3a outcomes attach (roi vocabulary) and move progress; progress short of the criteria leaves the mission ACTIVE", partial.ok && partial.completed === false && c.tables.missions[0].state === "ACTIVE" && c.tables.missions[0].outcomes.length === 1 && c.tables.mission_events.some((e) => e.event_kind === "outcome_attached"))
    // 104F: completion is DETERMINISTIC on the progress update itself — evaluateSuccess true → completeMission, no caller asserts it.
    const done = await recordMissionProgress({ brokerageId: T1, missionId: m.mission.id, progress: { transactions_closed: 2 } }, c as any, s.deps)
    const asserted = await completeMission({ brokerageId: T1, missionId: m.mission.id, reason: "we feel done" }, c as any, s.deps)
    check("E3 the progress update that MEETS the criteria completes the mission (completeMission wired to evaluateSuccess); a later assertion finds it terminal", done.ok && done.completed === true && done.mission.state === "COMPLETED" && c.tables.missions[0].state === "COMPLETED" && !asserted.ok && c.tables.mission_events.some((e) => e.event_kind === "transition" && e.to_state === "COMPLETED" && /criteria met on progress/.test(e.reason)))
    check("E4 evaluateSuccess: unknown metric = unmet; ops >= <= == are exact", !evaluateSuccess([{ metric: "x", op: ">=", target: 1 }], {}).met && evaluateSuccess([{ metric: "x", op: "<=", target: 1 }], { x: 1 }).met && !evaluateSuccess([{ metric: "x", op: "==", target: 1 }], { x: 2 }).met)
    const failed = await failMission({ brokerageId: T1, missionId: m.mission.id, reason: "late" }, c as any, s.deps)
    check("E5 a COMPLETED mission cannot FAIL (terminal)", !failed.ok)
    const list = await activeMissionsFor(T1, {}, c as any)
    check("E6 activeMissionsFor hides terminal rows and publishes a refused read instead of an empty all-clear", list.active.length === 0 && list.readRefused === null && (await activeMissionsFor("", {}, c as any)).readRefused === "no tenant")
  }
  {
    const c = memClient(); const s = seams({ afford: false })
    const r = await createMission(base, c as any, s.deps)
    check("E7 entitlement fails closed: mayUseAndAfford refuses → no mission row, no evidence, no event", !r.ok && r.reason.startsWith("entitlement:") && (c.tables.missions ?? []).length === 0 && s.emits.length === 0)
    const c2 = memClient(); const s2 = seams()
    const bad = await createMission({ ...base, ownerManager: "broker_ops" as any }, c2 as any, s2.deps)
    const bad2 = await createMission({ ...base, participatingManagers: ["nobody" as any] }, c2 as any, s2.deps)
    check("E8 owner / participating managers must be MANAGERS keys (registry coordination)", !bad.ok && bad.reason.startsWith("unknown_owner_manager") && !bad2.ok && bad2.reason.startsWith("unknown_participating_manager"))
  }

  // ─── F. wiring + registration (stripped source — a tombstone is not a call site) ───────────
  console.log("\nF. wiring + registration")
  {
    const svc = src("lib/kernel/missions.ts")
    check("F1 the service's DEFAULT seams are the survivors: withActionLedger, emitKernelEvent, publishManagerSignal, resolveAgentAuthorityLevel, mayUseAndAfford", ["withActionLedger(", "emitKernelEvent(", "publishManagerSignal(", "resolveAgentAuthorityLevel(", "mayUseAndAfford("].every((t) => svc.includes(t)))
    check("F2 the reaper EXTENDED, not duplicated: stale-run-reaper calls sweepMissionDeadlines; reaper-net still runs the one reaper", src("lib/workflow-orchestrator/stale-run-reaper.ts").includes("sweepMissionDeadlines(") && src("lib/intelligence/reaper-net.ts").includes("reapStaleWorkflowRuns"))
    check("F3 workflow engine: startRun carries missionId → workflow_runs.mission_id and attaches the run", /mission_id: input\.missionId/.test(src("lib/workflow-orchestrator/engine.ts")) && src("lib/workflow-orchestrator/engine.ts").includes("attachAction("))
    check("F4 agent_goals → mission: upsertAgentGoal creates the mission (objective = the goal) and links agent_goals.mission_id", src("app/actions/ai-agent-goals.ts").includes("createMission(") && /mission_id: m\.mission\.id/.test(src("app/actions/ai-agent-goals.ts")))
    check("F5 stand-up + team-lead brief read through the ONE lazy seam activeMissionsFor", src("lib/kernel/morning-standup.ts").includes("activeMissionsFor(") && src("lib/intelligence/user-type-briefs/team-lead.ts").includes("activeMissionsFor("))
    check("F6 flight recorder: a mission's chain pulls the ledger rows that served it (detail.mission_id)", /entityType === "mission"/.test(src("app/actions/flight-recorder.ts")) && src("app/actions/flight-recorder.ts").includes("mission_id: entityId"))
    const door = src("app/actions/missions.ts")
    check("F7 the human door is a \"use server\" file: tenant from requireCallerTenant() with NO claimed id, gate before the service client", door.startsWith("\"use server\"") && door.includes("requireCallerTenant()") && !/requireCallerTenant\(input/.test(door))
    check("F8 both escalation signal types are catalogued (signal-integrity) as escalations", SIGNAL_REGISTRY[MISSION_ESCALATED_SIGNAL]?.kind === "escalation" && SIGNAL_REGISTRY[MISSION_APPROVAL_REQUIRED_SIGNAL]?.kind === "escalation")
    const mig = readFileSync("supabase/migrations/m710-missions-durable-objective-runtime.sql", "utf8")
    const stateCheck = /missions_state_check\s*CHECK\s*\(state IN \(([^)]*)\)/.exec(mig)
    const dbStates = stateCheck ? [...stateCheck[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : []
    check("F9 the m710 state CHECK and MISSION_STATES are ONE vocabulary (rule, not a pin)", dbStates.join(",") === MISSION_STATES.join(","))
    check("F10 m710 makes mission_events append-only (a trigger refusing UPDATE OR DELETE) and widens the reason-code CHECK with MISSION_LIFECYCLE", /BEFORE UPDATE OR DELETE ON public\.mission_events/.test(mig) && /'MISSION_LIFECYCLE'/.test(mig) && src("lib/kernel/action-ledger.ts").includes("\"MISSION_LIFECYCLE\""))
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }
    check("F11 package.json test:missions → this guard, on the chain", pkg.scripts["test:missions"] === "tsx scripts/missions-guard.ts" && /npm run test:missions(\s|&|$)/.test(pkg.scripts.guard))
    const d = MAINTENANCE_DOMAINS.durable_mission_runtime
    check("F12 MAINTENANCE_DOMAINS owns it (campaign_orchestrator; co-owners cron_manager + data_steward, named in prose)", d?.manager === "campaign_orchestrator" && d.proof === "test:missions" && JSON.stringify(d.coOwners) === JSON.stringify(["cron_manager", "data_steward"]) && /CROSS-COOPERATED/.test(d.what) && d.what.includes("cron_manager") && d.what.includes("data_steward"))
    check("F13 TABLE_MANAGER: missions + mission_events → campaign_orchestrator", TABLE_MANAGER.missions === "campaign_orchestrator" && TABLE_MANAGER.mission_events === "campaign_orchestrator")
  }

  // ─── G. lane 104F — the seams WIRED to their real callers (each with a positive control) ────
  console.log("\nG. 104F wires — escalate / fail / complete / progress / outcome / decompose / twin seam")
  {
    // G1 hard expiry: ESCALATED + deadline passed + unanswered for the window → FAILED through failMission on the sweep.
    const c = memClient(); const s = seams()
    const now = new Date("2026-10-05T12:00:00Z")
    const stale = await createMission({ ...base, objective: "stale-escalation", initialState: "ACTIVE", deadline: "2026-09-20T00:00:00Z" }, c as any, s.deps)
    const fresh = await createMission({ ...base, objective: "fresh-escalation", initialState: "ACTIVE", deadline: "2026-09-20T00:00:00Z" }, c as any, s.deps)
    const noDeadline = await createMission({ ...base, objective: "escalated-no-deadline", initialState: "ACTIVE" }, c as any, s.deps)
    if (!stale.ok || !fresh.ok || !noDeadline.ok) throw new Error("setup G1")
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000)
    await escalateMission({ brokerageId: T1, missionId: stale.mission.id, reason: "deadline" }, c as any, { ...s.deps, now: () => hoursAgo(MISSION_BLOCKED_STALE_HOURS + 1) })
    await escalateMission({ brokerageId: T1, missionId: fresh.mission.id, reason: "deadline" }, c as any, { ...s.deps, now: () => hoursAgo(1) })
    await escalateMission({ brokerageId: T1, missionId: noDeadline.mission.id, reason: "needs a human" }, c as any, { ...s.deps, now: () => hoursAgo(MISSION_BLOCKED_STALE_HOURS + 10) })
    const sweep = await sweepMissionDeadlines(T1, c as any, { now }, s.deps)
    const st = Object.fromEntries(c.tables.missions.map((r) => [r.objective, r.state]))
    check("G1 the sweep FAILS the escalation nobody answered past its deadline (failMission), leaves the fresh one and the one without a deadline ESCALATED", sweep.failed === 1 && sweep.escalated === 0 && st["stale-escalation"] === "FAILED" && st["fresh-escalation"] === "ESCALATED" && st["escalated-no-deadline"] === "ESCALATED", JSON.stringify({ sweep, st }))
    check("G1 (control) the failure is evidence: a transition row ESCALATED → FAILED by cron_manager naming the hard expiry", c.tables.mission_events.some((e) => e.event_kind === "transition" && e.from_state === "ESCALATED" && e.to_state === "FAILED" && e.actor_id === "cron_manager" && /hard-expired/.test(e.reason)))
    const again = await sweepMissionDeadlines(T1, c as any, { now }, s.deps)
    check("G1 (idempotent) a second sweep fails nothing more", again.failed === 0 && again.escalated === 0)
  }
  {
    // G2 attachOutcome is idempotent on (kind, entity): the attribution cron re-runs weekly.
    const c = memClient(); const s = seams()
    const m = await createMission({ ...base, initialState: "ACTIVE" }, c as any, s.deps)
    if (!m.ok) throw new Error("setup G2")
    const tx = randomUUID()
    const first = await attachOutcome({ brokerageId: T1, missionId: m.mission.id, outcome: { kind: "closed", entityType: "transaction", entityId: tx, valueUsd: 9000 }, progressMetric: "attributed_closed_usd" }, c as any, s.deps)
    const second = await attachOutcome({ brokerageId: T1, missionId: m.mission.id, outcome: { kind: "closed", entityType: "transaction", entityId: tx, valueUsd: 9000 }, progressMetric: "attributed_closed_usd" }, c as any, s.deps)
    const other = await attachOutcome({ brokerageId: T1, missionId: m.mission.id, outcome: { kind: "reply", entityType: "communication", entityId: tx }, progressMetric: "attributed_reply" }, c as any, s.deps)
    check("G2 attachOutcome dedupes the same (kind, entity): one outcome row, progress counted once, the duplicate flagged; a different kind on the same entity still attaches", first.ok && !first.duplicate && second.ok && second.duplicate === true && other.ok && !other.duplicate && c.tables.missions[0].outcomes.length === 2 && c.tables.missions[0].progress.attributed_closed_usd === 9000 && c.tables.missions[0].progress.attributed_reply === 1)
  }
  {
    // G3 the pure credit → mission rule (lib/intelligence/roi-ledger.ts missionOutcomeCredits).
    const A1 = randomUUID(), A2 = randomUUID(), M1 = randomUUID()
    const attr = attributeOutcomesToLedger(
      [{ ref: "closed:tx-1", kind: "closed", brokerageId: T1, subjectIds: ["tx-1"], at: "2026-09-10T00:00:00Z", revenueCents: 900_000 }, { ref: "reply:isa:r-1", kind: "reply", brokerageId: T1, subjectIds: ["c-1"], at: "2026-09-10T00:00:00Z", revenueCents: 0 }] as any,
      [
        { id: A1, brokerage_id: T1, action: "isa.contact.send", status: "executed", reason_code: "X", actor_type: "manager", subject_type: "transaction", subject_id: "tx-1", created_at: "2026-09-01T00:00:00Z" },
        { id: A2, brokerage_id: T1, action: "isa.contact.send", status: "executed", reason_code: "X", actor_type: "manager", subject_type: "contact", subject_id: "c-1", created_at: "2026-09-02T00:00:00Z" },
      ] as any,
    )
    const credits = missionOutcomeCredits(attr, new Map([[A1, M1]]))
    check("G3 missionOutcomeCredits: the LAST-TOUCH credit whose action a mission owns becomes the mission's outcome (entity = the transaction, revenue in cents); an unowned action earns no mission credit", credits.length === 1 && credits[0].missionId === M1 && credits[0].outcomeKind === "closed" && credits[0].entityType === "transaction" && credits[0].entityId === "tx-1" && credits[0].revenueCents === 900_000, JSON.stringify(credits))
    check("G3 (control) with both actions owned, the isa reply resolves to its isa_outreach_log row and all-touch shares never double-credit", (() => { const cc = missionOutcomeCredits(attr, new Map([[A1, M1], [A2, M1]])); return cc.length === 2 && cc.some((x) => x.entityType === "isa_outreach_log" && x.entityId === "r-1") && attr.credits.filter((x) => x.model === "all_touch").length >= 2 })())
  }
  {
    // G4 a brokerage_objective with no criteria derives them through the twin's decomposition; the twin build then measures them.
    const c = memClient(); const s = seams()
    const twin = { brokerageId: T1, economic: { gciClosed90dCents: 800_000, closedCount90d: 1 }, now: { transactions: { inEscrow: 1, openCommissionCents: 1_300_000 } } } as unknown as BrokerageTwin
    const d = decomposeObjective({ goalType: "transactions_closed", targetValue: 3 }, twin)  // baseline = the twin reading (1) → remaining 2; criteria are LEVELS (1+2 = 3)
    const derived = criteriaFromDecomposition(d)
    check("G4 criteriaFromDecomposition: one criterion per supported sub-target, keyed on the twin field that measures it", derived.length === 3 && derived.every((x) => x.metric.includes(".") && x.op === ">=") && derived.some((x) => x.metric === "economic.closedCount90d" && x.target === 3), JSON.stringify(derived))
    const m = await createMission({ ...base, objective: "close 3 this quarter", missionType: "brokerage_objective", initialState: "ACTIVE", objectiveSpec: { goalType: "transactions_closed", targetValue: 3 }, twin }, c as any, s.deps)
    check("G4 createMission(brokerage_objective, no criteria) stores the derived criteria and records the decomposition as `created` evidence", m.ok && m.mission.success_criteria.length === 3 && c.tables.mission_events[0].evidence.decomposition?.goal_type === "transactions_closed" && c.tables.mission_events[0].evidence.decomposition?.criteria_derived === 3)
    const given = await createMission({ ...base, objective: "explicit", missionType: "brokerage_objective", successCriteria: [{ metric: "x", op: ">=", target: 1 }], objectiveSpec: { goalType: "transactions_closed", targetValue: 3 } }, c as any, s.deps)
    const unsupported = await createMission({ ...base, objective: "unsupported", missionType: "brokerage_objective", objectiveSpec: { goalType: "referrals_generated", targetValue: 3 } }, c as any, s.deps)
    check("G4 (controls) explicit criteria are kept as given; an unsupported goal type derives NO criteria (recorded, not invented)", given.ok && given.mission.success_criteria.length === 1 && given.mission.success_criteria[0].metric === "x" && unsupported.ok && unsupported.mission.success_criteria.length === 0 && c.tables.mission_events.find((e) => e.mission_id === unsupported.mission.id)?.evidence.decomposition?.status === "unsupported")
    const short = await syncMissionProgressFromTwin(twin, c as any, s.deps)
    const after1 = c.tables.missions.find((r) => r.objective === "close 3 this quarter")!
    check("G5 syncMissionProgressFromTwin reads each twin-path criterion into progress (closedCount90d=1, inEscrow=1, open=absent → not written) and does not complete a mission short of its criteria", short.scanned === 1 && short.measured === 1 && short.completed === 0 && after1.progress["economic.closedCount90d"] === 1 && after1.progress["now.transactions.inEscrow"] === 1 && !("now.transactions.open" in after1.progress) && after1.state === "ACTIVE", JSON.stringify({ short, progress: after1.progress }))
    const met = { ...twin, economic: { gciClosed90dCents: 2_400_000, closedCount90d: 3 }, now: { transactions: { inEscrow: 3, open: 3, openCommissionCents: 0 } } } as unknown as BrokerageTwin
    const done = await syncMissionProgressFromTwin(met, c as any, s.deps)
    check("G5 a twin whose readings meet every criterion COMPLETES the objective on the sync (completeMission, deterministic)", done.completed === 1 && c.tables.missions.find((r) => r.objective === "close 3 this quarter")!.state === "COMPLETED")
    check("G5 (tenant) a twin of another tenant touches nothing here", (await syncMissionProgressFromTwin({ ...met, brokerageId: T2 } as BrokerageTwin, c as any, s.deps)).scanned === 0)
    // G6 the twin seam registered at module load (this guard imported lib/kernel/missions.ts) reads the live count through activeMissionsFor.
    const seam = twinSeams().missions
    const read = seam ? await seam(c as any, T1, null) : null
    check("G6 registerTwinSeam('missions') ran at module load and answers the non-terminal count through activeMissionsFor (completed one excluded)", typeof seam === "function" && read?.active === 2 && /activeMissionsFor/.test(read.source), JSON.stringify(read))
    check("G6 (control) the seam THROWS on a refused read rather than answering 0", await (async () => { try { await seam!({ from: () => ({ select: () => ({ eq: () => ({ in: () => ({ order: () => ({ order: () => ({ limit: async () => ({ data: null, error: { message: "refused" } }) }) }) }) }) }) }) } as any, T1, null); return false } catch (e) { return /refused/.test(String(e)) } })())
  }
  {
    // G7 wiring — stripped source (a tombstone is not a call site), with a positive control.
    const reaper = src("lib/workflow-orchestrator/stale-run-reaper.ts")
    check("G7 stale-run reaper: a stalled run under a mission ESCALATES it (escalateMission) — mission_id read from the run", reaper.includes("escalateMission(") && /select\("[^"]*mission_id[^"]*"\)/.test(reaper))
    const engine = src("lib/workflow-orchestrator/engine.ts")
    check("G7 workflow engine: step done → recordMissionProgress(steps_completed); run failed → failMission (workflow mission) / escalateMission (others); run completed → completeMission (workflow mission)", engine.includes("recordMissionProgress(") && /steps_completed:/.test(engine) && engine.includes("failMission(") && engine.includes("escalateMission(") && engine.includes("completeMission(") && /missionType === "workflow"/.test(engine))
    const goals = src("app/actions/ai-agent-goals.ts")
    check("G7 agent_goals → mission progress: syncGoalCurrentValues + updateGoalProgress record the goal's current_value on its mission (recordMissionProgress keyed on goal_type)", goals.includes("recordMissionProgress(") && /\[g\.goal_type\]: Number\(g\.current_value\)/.test(goals) && (goals.match(/recordGoalMissionProgress\(/g) ?? []).length >= 3)
    const roi = src("lib/intelligence/roi-ledger.ts")
    check("G7 roi-ledger: recordMissionOutcomes attaches attributed outcomes (attachOutcome) and the learning cron runs it per tenant", roi.includes("attachOutcome(") && roi.includes("missionOutcomeCredits(") && src("app/api/cron/source-conversion-learning/route.ts").includes("recordMissionOutcomes("))
    const cc = src("lib/kernel/command-center.ts")
    check("G7 command center: loads economic-graph + missions (seam registration) BEFORE buildBrokerageTwin, then syncMissionProgressFromTwin", cc.indexOf('import("@/lib/kernel/missions")') < cc.indexOf("buildBrokerageTwin(brokerageId") && cc.includes("syncMissionProgressFromTwin("))
    check("G7 the Missions card: admin command center page lists through listMissionsAction gated by isAdminOrBroker; the card calls decide / block / create", /isAdminOrBroker\(\{ user_type: userType \}\)\s*\?\s*await listMissionsAction\(\)/.test(src("app/dashboard/admin/command-center/page.tsx")) && src("app/dashboard/admin/command-center/page.tsx").includes("<MissionsCard") && ["decideMissionAction(", "blockMissionAction(", "createMissionAction("].every((t) => src("app/dashboard/admin/command-center/missions-card.tsx").includes(t)))
    const fixture = stripComments(`// TOMBSTONE: escalateMission( used to be called here\nconst x = 1\n/* failMission( */`)
    check("G7 (control) a tombstone naming a door is NOT read as a call site", !fixture.includes("escalateMission(") && !fixture.includes("failMission(") && fixture.includes("const x = 1"))
  }

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  console.log(" BLIND SPOTS: in-memory client (no RLS, no CHECK, no append-only trigger — m710 holds those live); the real emit / signal / authority / entitlement seams are asserted by source, the real ledger by the in-memory client; the goal → mission wire runs only on a NEW goal and needs m710 applied; the engine / reaper / cron wires are asserted by stripped source (their runtime paths need a live run); the twin-path criteria are measured only when the Command Center builds the twin.")
  if (fail > 0) { console.log(" ❌ MISSIONS_FAIL"); process.exit(1) }
  console.log(" ✅ MISSIONS_PASS — one durable mission runtime: the machine refuses, every move is evidence, managers coordinate through the registry")
}
main().catch((e) => { console.error(e); process.exit(1) })
