#!/usr/bin/env tsx
/**
 * scripts/manager-delegation-guard.ts   (npm run test:manager-delegation) — wave 105, lane 105A.
 * ─────────────────────────────────────────────────────────────────────────────
 * STRUCTURED MANAGER-TO-MANAGER DELEGATION — in-memory client, no network. Proves
 * lib/kernel/manager-delegation.ts (+ the manager-dissent survivor's reviewDelegation):
 *   A. the state machine — every admitted edge, every refused edge recorded as evidence, terminal statuses
 *   B. request-time refusals — capability not owned by the assignee, unknown capability, self-delegation,
 *      authority above the mission ceiling / the assignee's ladder rung, budget above the mission's
 *      remaining, entitlement refused (fails closed), mission not found / terminal
 *   C. budget exhaustion on return → ESCALATED (mission escalated to its owner + human); a return within
 *      budget → RETURNED, charged to the mission (attachAction) and on its evidence
 *   D. the dissent path records WHY through the dissent survivor (review row, REVIEW_MARK, verdict)
 *   E. tenant isolation — a foreign tenant's id matches nothing on every door
 *   F. evidence — an event row + a ledger row (reason MISSION_LIFECYCLE, detail.delegation_id, causation of
 *      the scope) per transition; the REAL ledger survivor writes agent_action_ledger rows through the client
 *   G. the reaper seam (deadline → ESCALATED, idempotent) and the workflow seam (run completed → RETURNED
 *      with the outputs; run failed / stalled → ESCALATED)
 *   H. wiring (stripped source — a tombstone is not a call site) + registration + one vocabulary
 * Rules asserted, not waypoints: the capability CHECK is compared to the registry's keys, the status CHECK
 * to DELEGATION_STATUSES; no migration-state pin.
 */
import { readFileSync, readdirSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { stripComments } from "./strip-comments"
import {
  DELEGATION_STATUSES, DELEGATION_TRANSITIONS, DELEGATION_TERMINAL_STATUSES, DELEGATION_ATTENTION_STATUSES,
  DELEGATION_REQUESTED_SIGNAL, DELEGATION_ESCALATED_SIGNAL, PREPARE_SELLER_APPOINTMENT_CAPABILITY,
  canDelegationTransition, paidCapabilitiesFor, missionRemaining,
  requestDelegation, acceptDelegation, startDelegationWork, returnDelegationResult, rejectDelegation, dissentDelegation,
  escalateDelegation, cancelDelegation, pendingDelegationsFor, sweepDelegationDeadlines, settleDelegationForRun, getDelegation,
  type DelegationStatus, type DelegationDeps,
} from "../lib/kernel/manager-delegation"
import { reviewDelegation, REVIEW_MARK } from "../lib/kernel/manager-dissent"
import { createMission, MISSION_LIFECYCLE_REASON, MISSION_APPROVAL_REQUIRED_SIGNAL, type MissionDeps } from "../lib/kernel/missions"
import { withCausationFrom } from "../lib/kernel/causation"
import { MAINTENANCE_DOMAINS, MANAGERS, TABLE_MANAGER } from "../lib/kernel/manager-registry"
import { SIGNAL_REGISTRY } from "../lib/kernel/signal-registry"
import { classifyCoordination } from "../lib/kernel/coordination-kind"
import { KernelEvent } from "../lib/kernel/events"
import { APP_CAPABILITY_REGISTRY } from "../lib/agentic-os/app-capability-registry"
import { CAPABILITY_MANAGER } from "../lib/agentic-os/capability-ownership"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}${detail ? `\n      ${detail}` : ""}`) } }
const src = (p: string) => stripComments(readFileSync(p, "utf8"))

// ─── in-memory supabase-js shaped client (missions-guard's, + the `col->>key` path the service filters on) ──
type Row = Record<string, any>
function val(row: Row, col: string): any {
  const i = col.indexOf("->>")
  if (i < 0) return row[col]
  const obj = row[col.slice(0, i)]
  return obj && typeof obj === "object" ? (obj as Row)[col.slice(i + 3)] : undefined
}
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
            if (table === "missions") Object.assign(r, { spent_usd: r.spent_usd ?? 0, spent_tokens: r.spent_tokens ?? 0, blockers: r.blockers ?? [], evidence: r.evidence ?? [], progress: r.progress ?? {}, actions: r.actions ?? [], outcomes: r.outcomes ?? [], state_changed_at: r.state_changed_at ?? r.created_at })
            if (table === "manager_delegations") Object.assign(r, { spent_usd: r.spent_usd ?? 0, spent_tokens: r.spent_tokens ?? 0, evidence: r.evidence ?? [], result: r.result ?? null, state_changed_at: r.state_changed_at ?? r.created_at, completed_at: r.completed_at ?? null })
            t(table).push(r)
          }
          return { data: rows, error: null }
        }
        const hits = t(table).filter((r) => preds.every((p) => p(r)))
        if (op === "update") { for (const r of hits) Object.assign(r, payload); return { data: hits.map((r) => structuredClone(r)), error: null } }
        if (op === "delete") { tables[table] = t(table).filter((r) => !hits.includes(r)); return { data: hits, error: null } }
        return { data: (limitN ? hits.slice(0, limitN) : hits).map((r) => structuredClone(r)), error: null }
      }
      const b: any = {
        select: () => b, order: () => b, not: () => b, is: () => b, or: () => b, gte: () => b, lte: () => b, lt: () => b, neq: () => b,
        limit: (n: number) => { limitN = n; return b },
        insert: (p: Row | Row[]) => { op = "insert"; payload = p; return b },
        update: (p: Row) => { op = "update"; payload = p; return b },
        delete: () => { op = "delete"; return b },
        eq: (c: string, v: unknown) => { preds.push((r) => val(r, c) === v); return b },
        in: (c: string, vs: unknown[]) => { preds.push((r) => vs.includes(val(r, c))); return b },
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
function seams(over: Partial<{ authority: Partial<Record<string, number>>; afford: boolean | ((cap: string) => boolean) }> = {}) {
  const ledger: any[] = [], emits: any[] = [], signals: any[] = [], affords: any[] = []
  const mLedger: any[] = [], mEmits: any[] = [], mSignals: any[] = []
  const mission: MissionDeps = {
    afford: async () => ({ allowed: true, reason: "active" }),
    authority: async () => 6 as any,
    ledger: async (ctx) => { mLedger.push(ctx); return `mledger-${mLedger.length}` },
    emit: async (i) => { mEmits.push(i) },
    signal: async (s) => { mSignals.push(s) },
  }
  const deps: DelegationDeps = {
    afford: async (_b, cap, est) => { affords.push({ cap, est }); const ok = typeof over.afford === "function" ? over.afford(cap) : over.afford ?? true; return { allowed: ok, reason: ok ? "active" : `past_due_not_served:${cap}` } },
    authority: async (_b, manager) => (over.authority?.[manager] ?? 6) as any,
    ledger: async (ctx) => { ledger.push(ctx); return `dl-${ledger.length}` },
    emit: async (i) => { emits.push(i) },
    signal: async (s) => { signals.push(s) },
    mission,
  }
  return { deps, mission, ledger, emits, signals, affords, mLedger, mEmits, mSignals }
}

const T1 = "11111111-1111-4111-8111-111111111111"
const T2 = "22222222-2222-4222-8222-222222222222"
const CAP = PREPARE_SELLER_APPOINTMENT_CAPABILITY
const ask = (over: Record<string, unknown> = {}) => ({ brokerageId: T1, requestingManager: "ai_isa" as const, assignedManager: "listing_concierge" as const, capability: CAP, objective: "Prepare the listing appointment for contact c-1", inputEntities: { calendar_event_id: "ce-1", contact_id: "c-1" }, deadline: "2026-12-31T00:00:00Z", ...over })

async function missionFor(c: ReturnType<typeof memClient>, s: ReturnType<typeof seams>, over: Record<string, unknown> = {}) {
  const m = await createMission({ brokerageId: T1, objective: "List 12 homes this quarter", ownerManager: "listing_concierge", participatingManagers: ["ai_isa"], initialState: "ACTIVE", ...over }, c as any, s.mission)
  if (!m.ok) throw new Error(m.reason)
  return m.mission
}

async function main() {
  // ─── A. state machine ───────────────────────────────────────────────────────────────────────
  console.log("\nA. the state machine (every edge, every refusal, terminal statuses)")
  check("A1 the eight owner statuses, one vocabulary, in the owner's order", DELEGATION_STATUSES.join(",") === "REQUESTED,ACCEPTED,WORKING,RETURNED,REJECTED,DISSENTED,ESCALATED,CANCELLED")
  check("A2 every status has a transition row; terminal statuses have NO exits; attention = DISSENTED + ESCALATED", DELEGATION_STATUSES.every((s) => Array.isArray(DELEGATION_TRANSITIONS[s])) && [...DELEGATION_TERMINAL_STATUSES].every((s) => DELEGATION_TRANSITIONS[s].length === 0) && [...DELEGATION_ATTENTION_STATUSES].sort().join(",") === "DISSENTED,ESCALATED")
  check("A3 no edge targets an unknown status, none is a self-loop; RETURNED only from WORKING", DELEGATION_STATUSES.every((s) => DELEGATION_TRANSITIONS[s].every((to) => DELEGATION_STATUSES.includes(to) && to !== s)) && DELEGATION_STATUSES.filter((s) => canDelegationTransition(s, "RETURNED")).join(",") === "WORKING")
  check("A4 positive control: canDelegationTransition refuses an edge the table lacks (RETURNED → WORKING, REQUESTED → RETURNED)", !canDelegationTransition("RETURNED", "WORKING") && !canDelegationTransition("REQUESTED", "RETURNED"))
  {
    const c = memClient(); const s = seams()
    const m = await missionFor(c, s)
    const r = await requestDelegation(ask({ missionId: m.id, authority: 1, budget: { usd: 10 } }), c as any, s.deps)
    check("A5 requestDelegation → REQUESTED: managers are registry keys, the capability a catalogue key owned by the assignee, mission linked", r.ok && r.delegation.status === "REQUESTED" && r.delegation.requesting_manager in MANAGERS && r.delegation.assigned_manager in MANAGERS && CAPABILITY_MANAGER[r.delegation.requested_capability] === r.delegation.assigned_manager && r.delegation.mission_id === m.id, !r.ok ? r.reason : undefined)
    if (!r.ok) throw new Error(r.reason)
    const id = r.delegation.id
    const early = await returnDelegationResult({ brokerageId: T1, delegationId: id, result: { cma: true } }, c as any, s.deps)
    check("A6 a return before the work started is REFUSED (REQUESTED → RETURNED is not a transition) and recorded as a `refused` event row", !early.ok && early.reason.startsWith("invalid_transition") && c.tables.manager_delegation_events.some((e) => e.event_kind === "refused" && e.from_status === "REQUESTED" && e.to_status === "RETURNED") && c.tables.manager_delegations[0].status === "REQUESTED")
    const a = await acceptDelegation({ brokerageId: T1, delegationId: id, actor: { type: "manager", id: "listing_concierge" } }, c as any, s.deps)
    const w = await startDelegationWork({ brokerageId: T1, delegationId: id, actor: { type: "manager", id: "listing_concierge" } }, c as any, s.deps)
    const ret = await returnDelegationResult({ brokerageId: T1, delegationId: id, result: { cma: true, presentation: true }, costUsd: 2.5, tokens: 1200, actor: { type: "manager", id: "listing_concierge" } }, c as any, s.deps)
    check("A7 the admitted walk REQUESTED → ACCEPTED → WORKING → RETURNED moves the row each time; the result and the spend land on the row", a.ok && a.delegation.status === "ACCEPTED" && w.ok && w.delegation.status === "WORKING" && ret.ok && ret.delegation.status === "RETURNED" && !ret.escalated && c.tables.manager_delegations[0].result?.cma === true && Number(c.tables.manager_delegations[0].spent_usd) === 2.5 && Number(c.tables.manager_delegations[0].spent_tokens) === 1200 && !!c.tables.manager_delegations[0].completed_at)
    const after = await cancelDelegation({ brokerageId: T1, delegationId: id, reason: "too late" }, c as any, s.deps)
    check("A8 a terminal status is final: RETURNED refuses every exit", !after.ok && after.reason.startsWith("invalid_transition"))
    const transitions = c.tables.manager_delegation_events.filter((e) => e.event_kind === "transition")
    check("A9 one `requested` row, one `transition` row per admitted move (3), the refusals as `refused` rows (2)", c.tables.manager_delegation_events.filter((e) => e.event_kind === "requested").length === 1 && transitions.length === 3 && c.tables.manager_delegation_events.filter((e) => e.event_kind === "refused").length === 2)
    const dup = await requestDelegation(ask({ missionId: m.id, inputEntities: { workflow_run_id: "run-1" } }), c as any, s.deps)
    const dup2 = await requestDelegation(ask({ missionId: m.id, inputEntities: { workflow_run_id: "run-1" } }), c as any, s.deps)
    check("A10 idempotent per (capability, workflow run): the second request for the same run returns the first row as a duplicate", dup.ok && dup2.ok && dup2.duplicate === true && dup2.delegation.id === dup.delegation.id && c.tables.manager_delegations.length === 2)
  }

  // ─── B. request-time refusals ───────────────────────────────────────────────────────────────
  console.log("\nB. request-time refusals — capability ownership, authority, budget, entitlement, tenant")
  {
    const c = memClient(); const s = seams({ authority: { listing_concierge: 4, ai_isa: 2 } })
    const m = await missionFor(c, s, { budget: { usd: 20, tokens: 5000 } })
    c.tables.missions[0].authority_ceiling = 3
    const notOwned = await requestDelegation(ask({ missionId: m.id, capability: "isa_qualify" }), c as any, s.deps)
    check("B1 a capability the assignee does NOT own (isa_qualify is the AI ISA's) is refused — capability_not_owned names the real owner", !notOwned.ok && notOwned.reason.startsWith("capability_not_owned:isa_qualify:ai_isa"))
    const unknown = await requestDelegation(ask({ missionId: m.id, capability: "PREPARE_SELLER_APPOINTMENT" as any }), c as any, s.deps)
    check("B2 the owner's UPPERCASE spelling is not a catalogue key — refused (unknown_capability); the ONE spelling is the constant", !unknown.ok && unknown.reason.startsWith("unknown_capability") && CAP === "listing_appointment_prep")
    const self = await requestDelegation(ask({ assignedManager: "ai_isa" as const, capability: "isa_qualify" }), c as any, s.deps)
    check("B3 a manager cannot delegate to itself (self_delegation)", !self.ok && self.reason === "self_delegation")
    const above = await requestDelegation(ask({ missionId: m.id, authority: 4 }), c as any, s.deps)
    check("B4 authority 4 above the mission ceiling 3 is refused (authority_above_ceiling)", !above.ok && above.reason.startsWith("authority_above_ceiling"))
    const c2 = memClient(); const s2 = seams({ authority: { listing_concierge: 1 } })
    const m2 = await missionFor(c2, s2)
    const aboveRung = await requestDelegation(ask({ missionId: m2.id, authority: 2 }), c2 as any, s2.deps)
    check("B5 the ceiling is ALSO the assignee's ladder rung: authority 2 above the Concierge's rung 1 is refused even under a mission ceiling of 6", !aboveRung.ok && aboveRung.reason.startsWith("authority_above_ceiling") && m2.authority_ceiling === 6)
    const overUsd = await requestDelegation(ask({ missionId: m.id, authority: 1, budget: { usd: 25 } }), c as any, s.deps)
    check("B6 a budget above the mission's remaining ($25 of $20) is refused (budget_exceeds_remaining)", !overUsd.ok && overUsd.reason.startsWith("budget_exceeds_remaining"))
    c.tables.missions[0].spent_tokens = 4500
    const overTok = await requestDelegation(ask({ missionId: m.id, authority: 1, budget: { tokens: 1000 } }), c as any, s.deps)
    check("B7 remaining = budget − spent: 1000 tokens against 500 remaining is refused; missionRemaining derives it", !overTok.ok && overTok.reason.startsWith("budget_exceeds_remaining") && missionRemaining(c.tables.missions[0] as any).tokens === 500 && missionRemaining(null).usd === null)
    const past = await requestDelegation(ask({ missionId: m.id, authority: 1, deadline: "2020-01-01T00:00:00Z" }), c as any, s.deps)
    check("B8 a deadline already passed is refused at request (deadline_passed)", !past.ok && past.reason.startsWith("deadline_passed"))
    const ok = await requestDelegation(ask({ missionId: m.id, authority: 3, budget: { usd: 20, tokens: 500 } }), c as any, s.deps)
    check("B9 (control) authority AT the ceiling and budget AT the remaining are admitted", ok.ok)
    check("B10 no row, no evidence, no event, no signal was written for any refusal", c.tables.manager_delegations.length === 1 && c.tables.manager_delegation_events.length === 1 && s.emits.length === 1 && s.signals.length === 1)
    const gone = await requestDelegation(ask({ missionId: randomUUID() }), c as any, s.deps)
    c.tables.missions[0].state = "COMPLETED"
    const terminal = await requestDelegation(ask({ missionId: m.id, authority: 1 }), c as any, s.deps)
    check("B11 a mission that does not exist in the tenant → mission_not_found; a terminal mission → mission_terminal", !gone.ok && gone.reason === "mission_not_found" && !terminal.ok && terminal.reason.startsWith("mission_terminal:COMPLETED"))
  }
  {
    const c = memClient(); const s = seams({ afford: (cap) => cap !== "ai.generate" })
    const r = await requestDelegation(ask({ authority: 1, budget: { tokens: 300 } }), c as any, s.deps)
    check("B12 entitlement fails closed: mayUseAndAfford refuses the capability's paid lane (ai.generate) → no row, the lane named", !r.ok && r.reason.startsWith("entitlement:ai.generate:") && (c.tables.manager_delegations ?? []).length === 0 && s.affords.some((a) => a.cap === "ai.generate" && a.est.estTokens === 300))
    check("B13 paidCapabilitiesFor: app.access always; ai.generate when tokens are budgeted; comms.send only for a USD-budgeted SEND", paidCapabilitiesFor(CAP, {}).map((x) => x.capability).join(",") === "app.access" && paidCapabilitiesFor(CAP, { tokens: 10 }).map((x) => x.capability).join(",") === "app.access,ai.generate" && paidCapabilitiesFor("direct_mail_send", { usd: 5 }).map((x) => x.capability).join(",") === "app.access,comms.send" && paidCapabilitiesFor(CAP, { usd: 5 }).map((x) => x.capability).join(",") === "app.access")
    const c2 = memClient(); const s2 = seams()
    const pre = await requestDelegation(ask({ authority: 1 }), c2 as any, s2.deps)
    check("B14 a PRE-MISSION request (no mission) is admitted with mission_id null; the ceiling is the assignee's rung alone", pre.ok && pre.delegation.mission_id === null && s2.mLedger.length === 0)
  }

  // ─── C. budget exhaustion → ESCALATED; a return charges the mission ─────────────────────────
  console.log("\nC. budget exhaustion → ESCALATED · a return is charged to the mission")
  {
    const c = memClient(); const s = seams()
    const m = await missionFor(c, s, { budget: { usd: 100 }, createdBy: randomUUID() })
    const r = await requestDelegation(ask({ missionId: m.id, authority: 1, budget: { usd: 5 } }), c as any, s.deps)
    if (!r.ok) throw new Error(r.reason)
    await acceptDelegation({ brokerageId: T1, delegationId: r.delegation.id }, c as any, s.deps)
    await startDelegationWork({ brokerageId: T1, delegationId: r.delegation.id }, c as any, s.deps)
    const ret = await returnDelegationResult({ brokerageId: T1, delegationId: r.delegation.id, result: { cma: true }, costUsd: 5, actor: { type: "manager", id: "listing_concierge" } }, c as any, s.deps)
    check("C1 a return that EXHAUSTS the delegation's budget ($5 of $5) lands ESCALATED, not RETURNED — the result kept, the spend recorded", ret.ok && ret.escalated === true && ret.delegation.status === "ESCALATED" && c.tables.manager_delegations[0].result?.cma === true && Number(c.tables.manager_delegations[0].spent_usd) === 5)
    // The mission's owner IS the assignee that overspent, so the bus signal goes to the REQUESTER (a
    // manager never signals itself — validSignalRoute); the mission still reaches its owner + the human.
    check("C2 the escalation is signalled (delegation_escalated) from the overspending assignee to the requester, and the MISSION went APPROVAL_REQUIRED through escalateMission (owner manager + the human notified)", s.signals.some((x) => x.signalType === DELEGATION_ESCALATED_SIGNAL && x.fromManager === "listing_concierge" && x.toManager === "ai_isa") && c.tables.missions[0].state === "APPROVAL_REQUIRED" && s.mSignals.some((x) => x.signalType === MISSION_APPROVAL_REQUIRED_SIGNAL) && (c.tables.notifications ?? []).some((n) => n.type === "mission_approval_required"), JSON.stringify({ signals: s.signals.map((x) => [x.signalType, x.fromManager, x.toManager]), state: c.tables.missions[0].state, mSignals: s.mSignals.map((x) => x.signalType) }))
    check("C3 the mission was CHARGED through attachAction (the delegation's ledger row in missions.actions, $5 on spent_usd) and its evidence names the delegation", c.tables.missions[0].actions.length === 1 && Number(c.tables.missions[0].spent_usd) === 5 && c.tables.missions[0].evidence.some((e: any) => e.kind === "delegation_escalated" && e.ref === r.delegation.id) && c.tables.missions[0].evidence.some((e: any) => e.kind === "delegation_requested"))
    const c2 = memClient(); const s2 = seams()
    const m2 = await missionFor(c2, s2, { budget: { usd: 100 } })
    const r2 = await requestDelegation(ask({ missionId: m2.id, authority: 1, budget: { usd: 10 } }), c2 as any, s2.deps)
    if (!r2.ok) throw new Error(r2.reason)
    await acceptDelegation({ brokerageId: T1, delegationId: r2.delegation.id }, c2 as any, s2.deps)
    await startDelegationWork({ brokerageId: T1, delegationId: r2.delegation.id }, c2 as any, s2.deps)
    const ret2 = await returnDelegationResult({ brokerageId: T1, delegationId: r2.delegation.id, result: { cma: true }, costUsd: 4, tokens: 900 }, c2 as any, s2.deps)
    check("C4 a return WITHIN budget → RETURNED; the mission stays ACTIVE, charged $4 / 900 tokens, evidence delegation_returned", ret2.ok && ret2.delegation.status === "RETURNED" && c2.tables.missions[0].state === "ACTIVE" && Number(c2.tables.missions[0].spent_usd) === 4 && Number(c2.tables.missions[0].spent_tokens) === 900 && c2.tables.missions[0].evidence.some((e: any) => e.kind === "delegation_returned"))
    check("C5 the mission's evidence is idempotent per (kind, ref): the same ref appended twice lands once", c2.tables.missions[0].evidence.filter((e: any) => e.ref === r2.delegation.id && e.kind === "delegation_returned").length === 1)
  }

  // ─── D. dissent — through the dissent survivor ───────────────────────────────────────────────
  console.log("\nD. the dissent path records WHY (manager-dissent reviewDelegation)")
  {
    const base = { requestingManager: "ai_isa", assignedManager: "listing_concierge", capability: CAP, objective: "prep", authority: 1, budget: {}, deadline: null }
    const ctx = { capabilityOwner: "listing_concierge", authorityCeiling: 3, remainingUsd: 10, remainingTokens: null, now: new Date("2026-10-06T00:00:00Z") }
    check("D1 reviewDelegation: pass when nothing objects; VETO with codes for not-owned / unknown / above-ceiling / no objective", reviewDelegation(base, ctx).verdict === "pass" && reviewDelegation({ ...base, assignedManager: "ai_isa" }, ctx).codes[0] === "capability_not_owned" && reviewDelegation(base, { ...ctx, capabilityOwner: null }).codes[0] === "unknown_capability" && reviewDelegation({ ...base, authority: 4 }, ctx).codes[0] === "authority_above_ceiling" && reviewDelegation({ ...base, objective: " " }, ctx).verdict === "veto")
    check("D2 reviewDelegation: DISSENT (annotated) for budget over remaining, a passed deadline, and the assignee's own objections", reviewDelegation({ ...base, budget: { usd: 11 } }, ctx).codes[0] === "budget_exceeds_remaining" && reviewDelegation({ ...base, deadline: "2026-10-01T00:00:00Z" }, ctx).codes[0] === "deadline_passed" && (() => { const v = reviewDelegation(base, { ...ctx, objections: ["the comps are stale"] }); return v.verdict === "dissent" && v.codes[0] === "assignee_objection" && v.objections[0] === "the comps are stale" })())
    const c = memClient(); const s = seams()
    const m = await missionFor(c, s)
    const r = await requestDelegation(ask({ missionId: m.id, authority: 1 }), c as any, s.deps)
    if (!r.ok) throw new Error(r.reason)
    const nothing = await dissentDelegation({ brokerageId: T1, delegationId: r.delegation.id, objections: [] }, c as any, s.deps)
    check("D3 a dissent with nothing to object to is REFUSED (nothing_to_dissent) — the row does not move", !nothing.ok && nothing.reason === "nothing_to_dissent" && c.tables.manager_delegations[0].status === "REQUESTED")
    const d = await dissentDelegation({ brokerageId: T1, delegationId: r.delegation.id, objections: ["the seller has no property on file yet"] }, c as any, s.deps)
    const review = c.tables.manager_delegation_events.find((e) => e.event_kind === "review")
    check("D4 dissent → DISSENTED: a `review` event row carries the REVIEW_MARK, the reviewer (the assignee), the verdict and the objection; the row's evidence keeps it", d.ok && d.delegation.status === "DISSENTED" && d.review?.verdict === "dissent" && !!review && review.evidence.mark === REVIEW_MARK && review.evidence.reviewer === "listing_concierge" && review.reason.includes(REVIEW_MARK) && c.tables.manager_delegations[0].evidence.some((e: any) => e.kind === "review" && e.objections[0] === "the seller has no property on file yet"))
    check("D5 the mission's evidence records the dissent with its objections", c.tables.missions[0].evidence.some((e: any) => e.kind === "delegation_dissented" && e.objections?.[0] === "the seller has no property on file yet"))
    const re = await acceptDelegation({ brokerageId: T1, delegationId: r.delegation.id, reason: "property attached, go", actor: { type: "user", id: randomUUID() } }, c as any, s.deps)
    check("D6 a human re-accepts a DISSENTED delegation (DISSENTED → ACCEPTED) — the requester / human decides, the machine never loops", re.ok && re.delegation.status === "ACCEPTED")
    const rej = await rejectDelegation({ brokerageId: T1, delegationId: r.delegation.id, reason: "" }, c as any, s.deps)
    const rej2 = await rejectDelegation({ brokerageId: T1, delegationId: r.delegation.id, reason: "not a seller" }, c as any, s.deps)
    check("D7 a rejection REQUIRES a reason; with one it is terminal (REJECTED) and on the mission's evidence", !rej.ok && rej.reason === "reason_required" && rej2.ok && rej2.delegation.status === "REJECTED" && c.tables.missions[0].evidence.some((e: any) => e.kind === "delegation_rejected" && e.reason === "not a seller"))
  }

  // ─── E. tenant isolation ────────────────────────────────────────────────────────────────────
  console.log("\nE. tenant isolation")
  {
    const c = memClient(); const s = seams()
    const m = await missionFor(c, s)
    const r = await requestDelegation(ask({ missionId: m.id, authority: 1 }), c as any, s.deps)
    if (!r.ok) throw new Error(r.reason)
    const id = r.delegation.id
    const foreign = await Promise.all([
      acceptDelegation({ brokerageId: T2, delegationId: id }, c as any, s.deps),
      startDelegationWork({ brokerageId: T2, delegationId: id }, c as any, s.deps),
      returnDelegationResult({ brokerageId: T2, delegationId: id, result: {} }, c as any, s.deps),
      rejectDelegation({ brokerageId: T2, delegationId: id, reason: "x" }, c as any, s.deps),
      dissentDelegation({ brokerageId: T2, delegationId: id, objections: ["x"] }, c as any, s.deps),
      escalateDelegation({ brokerageId: T2, delegationId: id, reason: "x" }, c as any, s.deps),
      cancelDelegation({ brokerageId: T2, delegationId: id, reason: "x" }, c as any, s.deps),
    ])
    check("E1 another tenant's id matches NOTHING on every door (not_found ×7), the row untouched, no evidence written", foreign.every((f) => !f.ok && f.reason === "not_found") && c.tables.manager_delegations[0].status === "REQUESTED" && c.tables.manager_delegation_events.length === 1)
    const list = await pendingDelegationsFor(T2, {}, c as any)
    const own = await pendingDelegationsFor(T1, { missionId: m.id }, c as any)
    check("E2 pendingDelegationsFor: the other tenant sees an empty list; the owner sees it grouped per mission; no tenant → readRefused", list.pending.length === 0 && own.pending.length === 1 && own.byMission[m.id]?.length === 1 && (await pendingDelegationsFor("", {}, c as any)).readRefused === "no tenant")
    const crossMission = await requestDelegation(ask({ brokerageId: T2, missionId: m.id, authority: 1 }), c as any, s.deps)
    check("E3 a request naming another tenant's mission is refused (mission_not_found)", !crossMission.ok && crossMission.reason === "mission_not_found")
    check("E4 getDelegation pinned to the tenant", (await getDelegation(T2, id, c as any)) === null && (await getDelegation(T1, id, c as any))?.id === id)
  }

  // ─── F. evidence per transition ─────────────────────────────────────────────────────────────
  console.log("\nF. evidence — ledger row + event row + causation per transition")
  {
    const c = memClient(); const s = seams()
    const r = await withCausationFrom("e0e0e0e0-0000-4000-8000-000000000001", () => requestDelegation(ask({ authority: 1 }), c as any, s.deps))
    if (!r.ok) throw new Error(r.reason)
    await withCausationFrom("e0e0e0e0-0000-4000-8000-000000000002", () => acceptDelegation({ brokerageId: T1, delegationId: r.delegation.id, actor: { type: "manager", id: "listing_concierge" } }, c as any, s.deps))
    check("F1 every transition hands the ledger the delegation (id, capability, both managers), action domain.entity.action, from/to", s.ledger.length === 2 && s.ledger.every((l) => l.delegation.id === r.delegation.id && l.delegation.requested_capability === CAP && /^[a-z]+\.[a-z]+\.[a-z]+$/.test(l.action)) && s.ledger[1].from === "REQUESTED" && s.ledger[1].to === "ACCEPTED" && s.ledger[1].actor.id === "listing_concierge")
    const tr = c.tables.manager_delegation_events.filter((e) => e.event_kind === "transition")
    check("F2 the causation of the enclosing scope rides the ledger ctx AND the event row; the event row names the ledger row and the reason code", s.ledger[1].causationId === "e0e0e0e0-0000-4000-8000-000000000002" && tr.length === 1 && tr[0].causation_id === "e0e0e0e0-0000-4000-8000-000000000002" && tr[0].ledger_entry_id === "dl-2" && tr[0].reason_code === MISSION_LIFECYCLE_REASON)
    check("F3 MANAGER_DELEGATION_REQUESTED + MANAGER_DELEGATION_STATE_CHANGED emitted (auditOnly) with the delegation as entity", s.emits.length === 2 && s.emits[0].event === KernelEvent.MANAGER_DELEGATION_REQUESTED && s.emits[1].event === KernelEvent.MANAGER_DELEGATION_STATE_CHANGED && s.emits[1].metadata.to_status === "ACCEPTED")
    check("F4 the request is announced on the bus from the REQUESTING manager to the ASSIGNED manager (delegation_handoff_requested)", s.signals.length === 1 && s.signals[0].signalType === DELEGATION_REQUESTED_SIGNAL && s.signals[0].fromManager === "ai_isa" && s.signals[0].toManager === "listing_concierge")
  }
  {
    // THE REAL LEDGER SURVIVOR through the in-memory client (default deps for ledger only).
    const c = memClient(); const s = seams()
    const { ledger: _drop, ...rest } = s.deps
    const r = await requestDelegation(ask({ authority: 1 }), c as any, rest)
    const a = r.ok ? await acceptDelegation({ brokerageId: T1, delegationId: r.delegation.id }, c as any, rest) : null
    const rows = c.tables.agent_action_ledger ?? []
    const id = r.ok ? r.delegation.id : null
    check("F5 the default ledger seam IS withActionLedger: agent_action_ledger rows land with subject manager_delegation, reason_code MISSION_LIFECYCLE, detail.delegation_id, status executed", !!a?.ok && rows.length === 2 && rows.every((x) => x.subject_type === "manager_delegation" && x.subject_id === id && x.reason_code === MISSION_LIFECYCLE_REASON && x.detail?.delegation_id === id && x.status === "executed"), JSON.stringify(rows.map((x) => [x.subject_type, x.subject_id === id, x.reason_code, x.detail?.delegation_id === id, x.status])))
    check("F6 the event rows name the REAL ledger row ids", c.tables.manager_delegation_events.filter((e) => e.event_kind !== "refused").every((e) => rows.some((x) => x.id === e.ledger_entry_id)))
  }

  // ─── G. reaper seam + workflow seam ─────────────────────────────────────────────────────────
  console.log("\nG. the ONE reaper tick · the workflow run seam")
  {
    const c = memClient(); const s = seams()
    const m = await missionFor(c, s)
    const now = new Date("2026-10-06T12:00:00Z")
    const due = await requestDelegation(ask({ missionId: m.id, authority: 1, deadline: "2026-10-05T00:00:00Z" }), c as any, { ...s.deps, now: () => new Date("2026-10-01T00:00:00Z") })
    const fresh = await requestDelegation(ask({ missionId: m.id, authority: 1, deadline: "2026-12-01T00:00:00Z", inputEntities: { k: 2 } }), c as any, s.deps)
    const none = await requestDelegation(ask({ missionId: m.id, authority: 1, deadline: null, inputEntities: { k: 3 } }), c as any, s.deps)
    if (!due.ok || !fresh.ok || !none.ok) throw new Error("setup G")
    await acceptDelegation({ brokerageId: T1, delegationId: due.delegation.id }, c as any, s.deps)
    await startDelegationWork({ brokerageId: T1, delegationId: due.delegation.id }, c as any, s.deps)
    const sweep = await sweepDelegationDeadlines(T1, c as any, { now }, s.deps)
    const st = Object.fromEntries(c.tables.manager_delegations.map((r) => [r.id, r.status]))
    check("G1 the sweep ESCALATES the WORKING delegation past its deadline, leaves the fresh one and the one without a deadline", sweep.scanned === 3 && sweep.escalated === 1 && st[due.delegation.id] === "ESCALATED" && st[fresh.delegation.id] === "REQUESTED" && st[none.delegation.id] === "REQUESTED", JSON.stringify({ sweep, st }))
    check("G2 the escalation came from cron_manager to the mission's owner with the reason, and the mission went to the human", s.signals.some((x) => x.signalType === DELEGATION_ESCALATED_SIGNAL && x.fromManager === "cron_manager" && x.toManager === "listing_concierge" && /deadline .* passed/.test(x.message)) && c.tables.missions[0].state === "APPROVAL_REQUIRED")
    const again = await sweepDelegationDeadlines(T1, c as any, { now }, s.deps)
    check("G3 idempotent: a second sweep escalates nothing (ESCALATED rows are not re-scanned)", again.escalated === 0 && again.scanned === 2)
    check("G4 (tenant) the other tenant's sweep scans nothing", (await sweepDelegationDeadlines(T2, c as any, { now }, s.deps)).scanned === 0)
  }
  {
    const c = memClient({ workflow_runs: [{ id: "run-ok", brokerage_id: T1, chain_key: "listing-appt-prep", step_outputs: { generate_cma: { cmaId: "cma-1" }, generate_presentation: { presentationId: "p-1" } } }, { id: "run-bad", brokerage_id: T1, chain_key: "listing-appt-prep", step_outputs: {} }, { id: "run-none", brokerage_id: T1, chain_key: "x", step_outputs: {} }] })
    const s = seams()
    const m = await missionFor(c, s)
    const ok = await requestDelegation(ask({ missionId: m.id, authority: 1, inputEntities: { workflow_run_id: "run-ok", calendar_event_id: "ce-1" } }), c as any, s.deps)
    const bad = await requestDelegation(ask({ missionId: m.id, authority: 1, inputEntities: { workflow_run_id: "run-bad" } }), c as any, s.deps)
    if (!ok.ok || !bad.ok) throw new Error("setup G5")
    await acceptDelegation({ brokerageId: T1, delegationId: ok.delegation.id }, c as any, s.deps)
    await startDelegationWork({ brokerageId: T1, delegationId: ok.delegation.id }, c as any, s.deps)
    const settled = await settleDelegationForRun({ runId: "run-ok", outcome: "completed" }, c as any, s.deps)
    check("G5 a completed run RETURNS the delegation it served with the step outputs as the result (tenant from the run row)", !!settled?.ok && settled.delegation.status === "RETURNED" && settled.delegation.result?.workflow_run_id === "run-ok" && (settled.delegation.result?.steps as string[]).join(",") === "generate_cma,generate_presentation", JSON.stringify(settled))
    const failed = await settleDelegationForRun({ runId: "run-bad", outcome: "failed", detail: "step generate_cma threw" }, c as any, s.deps)
    check("G6 a failed run ESCALATES the delegation it served (REQUESTED → ESCALATED) with the run's failure as the reason", !!failed?.ok && failed.delegation.status === "ESCALATED" && c.tables.manager_delegation_events.some((e) => e.event_kind === "transition" && e.to_status === "ESCALATED" && /run-bad .* failed: step generate_cma threw/.test(e.reason)))
    check("G7 a run no delegation rode is a no-op (null); an unknown run is a no-op (null)", (await settleDelegationForRun({ runId: "run-none", outcome: "completed" }, c as any, s.deps)) === null && (await settleDelegationForRun({ runId: "nope", outcome: "completed" }, c as any, s.deps)) === null)
    const twice = await settleDelegationForRun({ runId: "run-ok", outcome: "completed" }, c as any, s.deps)
    check("G8 settling a run twice is a no-op (the delegation is terminal, not re-matched)", twice === null)
  }

  // ─── H. wiring + registration + one vocabulary (stripped source) ───────────────────────────
  console.log("\nH. wiring + registration + one vocabulary")
  {
    const svc = src("lib/kernel/manager-delegation.ts")
    check("H1 the service's DEFAULT seams are the survivors: withActionLedger, emitKernelEvent, publishManagerSignal, resolveAgentAuthorityLevel, mayUseAndAfford; dissent through reviewDelegation; the mission through attachAction / attachEvidence / escalateMission", ["withActionLedger(", "emitKernelEvent(", "publishManagerSignal(", "resolveAgentAuthorityLevel(", "mayUseAndAfford(", "reviewDelegation(", "attachAction(", "attachEvidence(", "escalateMission("].every((t) => svc.includes(t)))
    check("H2 the status column has ONE writer (transitionDelegation): exactly one `.update(` on manager_delegations in the service, one `.insert(`, and the chain / engine / reaper / actions / recorder never write the table", (svc.match(/from\("manager_delegations"\)\.update\(/g) ?? []).length === 1 && (svc.match(/from\("manager_delegations"\)\.insert\(/g) ?? []).length === 1 && ["lib/workflow-orchestrator/chains/listing-appt-prep.ts", "lib/workflow-orchestrator/engine.ts", "lib/workflow-orchestrator/stale-run-reaper.ts", "app/actions/missions.ts", "app/actions/flight-recorder.ts"].every((f) => !/from\("manager_delegations"\)[\s\S]{0,80}\.(update|insert|delete)\(/.test(src(f))))
    const chain = src("lib/workflow-orchestrator/chains/listing-appt-prep.ts")
    check("H3 THE EXAMPLE: the listing-appt-prep trigger REQUESTS the Concierge's listing_appointment_prep for a `delegate` (requestDelegation → accept → startDelegationWork), deadline = the appointment", chain.includes("requestDelegation(") && chain.includes("acceptDelegation(") && chain.includes("startDelegationWork(") && chain.includes("settleDelegationForRun(") && /assignedManager: "listing_concierge"/.test(chain) && /capability: PREPARE_SELLER_APPOINTMENT_CAPABILITY/.test(chain) && /deadline: ctx\.startAt/.test(chain) && /workflow_run_id: r\.runId/.test(chain))
    check("H4 the AI ISA's two booking paths pass delegate ai_isa — the ISA asks, it never runs the Concierge's prep", /delegate: \{ requestingManager: "ai_isa" \}/.test(src("lib/ai-isa/book-seller-appointment.ts")) && /delegate: \{ requestingManager: "ai_isa" \}/.test(src("lib/ai-isa/listing-appointment.ts")))
    const engine = src("lib/workflow-orchestrator/engine.ts")
    check("H5 the workflow engine returns a completed run through settleDelegationForRun and escalates a failed one", engine.includes("settleDelegationForRun(") && /settleRunDelegation\(svc, runId, "completed"/.test(engine) && /settleRunDelegation\(svc, runId, "failed"/.test(engine))
    const reaper = src("lib/workflow-orchestrator/stale-run-reaper.ts")
    check("H6 the reaper EXTENDED, not duplicated: the ONE stale-run reaper sweeps delegation deadlines and escalates a stalled run's delegation; reaper-net still runs it", reaper.includes("sweepDelegationDeadlines(") && /outcome: "stalled"/.test(reaper) && src("lib/intelligence/reaper-net.ts").includes("reapStaleWorkflowRuns"))
    const fr = src("app/actions/flight-recorder.ts")
    check("H7 the flight recorder folds a mission's delegations (manager_delegations + manager_delegation_events + their ledger rows) into the chain", fr.includes('from("manager_delegations")') && fr.includes('from("manager_delegation_events")') && /subject_type", "manager_delegation"/.test(fr))
    const act = src("app/actions/missions.ts")
    check("H8 the Missions card lists pending delegations per mission (listMissionsAction → pendingDelegationsFor) and the human door decideDelegationAction is admin-gated with the five decisions", act.includes("pendingDelegationsFor(") && act.includes("decideDelegationAction") && /if \(!g\.admin\) return/.test(act) && ["acceptDelegation(", "rejectDelegation(", "dissentDelegation(", "escalateDelegation(", "cancelDelegation("].every((t) => act.includes(t)))
    const card = src("app/dashboard/admin/command-center/missions-card.tsx")
    check("H9 the card renders the delegations per mission (DelegationLine) and calls decideDelegationAction; the page hands them in", card.includes("decideDelegationAction(") && card.includes("DelegationLine") && /delegations=\{missions\.data\.delegations\}/.test(src("app/dashboard/admin/command-center/page.tsx")))
    check("H10 both signal types are catalogued (signal-integrity) and classify as the kind the registry declares", SIGNAL_REGISTRY[DELEGATION_REQUESTED_SIGNAL]?.kind === "handoff" && classifyCoordination(DELEGATION_REQUESTED_SIGNAL) === "handoff" && SIGNAL_REGISTRY[DELEGATION_ESCALATED_SIGNAL]?.kind === "escalation" && classifyCoordination(DELEGATION_ESCALATED_SIGNAL) === "escalation")
    check("H11 ONE capability vocabulary: listing_appointment_prep is a catalogue key owned by listing_concierge; every catalogue key has an owner", CAP in APP_CAPABILITY_REGISTRY && CAPABILITY_MANAGER[CAP] === "listing_concierge" && Object.keys(APP_CAPABILITY_REGISTRY).every((k) => (CAPABILITY_MANAGER as Record<string, string>)[k] in MANAGERS))
    const mig = readFileSync("supabase/migrations/m712-manager-delegations.sql", "utf8")
    const statusCheck = /manager_delegations_status_check\s*CHECK\s*\(status IN \(([^)]*)\)/.exec(mig)
    const dbStatuses = statusCheck ? [...statusCheck[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : []
    check("H12 the migration's status CHECK and DELEGATION_STATUSES are ONE vocabulary (rule, not a pin)", dbStatuses.join(",") === DELEGATION_STATUSES.join(","))
    // The capability CHECK is read from the LATEST migration that defines it (wave 108E widened it in a
    // later file — reading m712 by name would pin the assertion to a waypoint, CLAUDE.md §2).
    const capRe = /manager_delegations_requested_capability_check\s*CHECK\s*\(requested_capability IN \(([^)]*)\)/
    const capDefiner = readdirSync("supabase/migrations").filter((f) => /^m\d+.*\.sql$/.test(f))
      .map((f) => ({ f, n: Number(/^m(\d+)/.exec(f)![1]), body: stripComments(readFileSync(`supabase/migrations/${f}`, "utf8")) }))
      .filter((x) => capRe.test(x.body)).sort((a, b) => b.n - a.n)[0]
    const capCheck = capDefiner ? capRe.exec(capDefiner.body) : null
    const dbCaps = capCheck ? [...capCheck[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort() : []
    check("H13 the latest defining migration's capability CHECK equals the catalogue's keys (derived — a new key widens it through the latest defining migration)", dbCaps.join(",") === Object.keys(APP_CAPABILITY_REGISTRY).sort().join(","), `definer=${capDefiner?.f ?? "none"} db=${dbCaps.length} registry=${Object.keys(APP_CAPABILITY_REGISTRY).length}`)
    check("H14 the migration makes manager_delegation_events append-only, revokes session writes, keeps RLS by brokerage, and never widens the reason-code CHECK (MISSION_LIFECYCLE reused)", /BEFORE UPDATE OR DELETE ON public\.manager_delegation_events/.test(mig) && /REVOKE INSERT, UPDATE, DELETE ON public\.manager_delegations\s+FROM anon, authenticated/.test(mig) && /has_brokerage_access\(brokerage_id\)/.test(mig) && !/agent_action_ledger_reason_code_check/.test(mig) && /requesting_manager <> assigned_manager/.test(mig))
    check("H15 the two kernel events exist on the enum", KernelEvent.MANAGER_DELEGATION_REQUESTED === "manager_delegation_requested" && KernelEvent.MANAGER_DELEGATION_STATE_CHANGED === "manager_delegation_state_changed")
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }
    check("H16 package.json test:manager-delegation → this guard, on the chain", pkg.scripts["test:manager-delegation"] === "tsx scripts/manager-delegation-guard.ts" && /npm run test:manager-delegation(\s|&|$)/.test(pkg.scripts.guard))
    const d = MAINTENANCE_DOMAINS.manager_delegation
    check("H17 MAINTENANCE_DOMAINS owns it (campaign_orchestrator; co-owners compliance_officer + cron_manager, named in prose)", d?.manager === "campaign_orchestrator" && d.proof === "test:manager-delegation" && JSON.stringify(d.coOwners) === JSON.stringify(["compliance_officer", "cron_manager"]) && /CROSS-COOPERATED/.test(d.what) && d.what.includes("compliance_officer") && d.what.includes("cron_manager"))
    check("H18 TABLE_MANAGER: manager_delegations + manager_delegation_events → campaign_orchestrator", TABLE_MANAGER.manager_delegations === "campaign_orchestrator" && TABLE_MANAGER.manager_delegation_events === "campaign_orchestrator")
    const fixture = stripComments(`// TOMBSTONE: requestDelegation( used to be called here\nconst x = 1\n/* settleDelegationForRun( */`)
    check("H19 (control) a tombstone naming a door is NOT read as a call site", !fixture.includes("requestDelegation(") && !fixture.includes("settleDelegationForRun(") && fixture.includes("const x = 1"))
  }

  // ─── W. wave 108 — capability WORKERS + the mission owner's WORK ORDER ──────────────────────
  console.log("\nW. wave 108 — the approved capabilities are WORKED on their survivors; a work order only for them")
  {
    const { DELEGATION_WORKERS, workDelegation } = await import("../lib/kernel/manager-delegation")
    check("W1 the three approved capabilities are catalogue keys with their owners AND a worker each", ([["recruit_outreach", "recruiting_manager"], ["ad_campaign_launch", "ads_manager"], ["lender_preapproval_handoff", "shopping_agent"]] as const).every(([k, m]) => k in APP_CAPABILITY_REGISTRY && CAPABILITY_MANAGER[k] === m && typeof DELEGATION_WORKERS[k] === "function"))
    const mk = async (tables: Record<string, Row[]> = {}) => {
      const c = memClient(tables); const s = seams()
      const m = await createMission({ brokerageId: T1, objective: "First-time buyer path for c-buyer", ownerManager: "shopping_agent", participatingManagers: ["ai_isa"], initialState: "ACTIVE" }, c as any, s.mission)
      if (!m.ok) throw new Error(m.reason)
      return { c, s, m: m.mission }
    }
    const wo = (missionId: string | undefined, capability: string, over: Record<string, unknown> = {}) => ({ brokerageId: T1, missionId, requestingManager: "shopping_agent" as const, assignedManager: "shopping_agent" as const, capability: capability as any, objective: "hand the buyer to a lender", inputEntities: { contactId: "c-buyer" }, authority: 1 as any, ownerWorkOrder: true, ...over })
    const a = await mk()
    const ok = await requestDelegation(wo(a.m.id, "lender_preapproval_handoff"), a.c as any, a.s.deps)
    check("W2 the mission OWNER's work order for a worker capability is admitted (requesting = assigned = shopping_agent)", ok.ok && ok.delegation.requesting_manager === "shopping_agent" && ok.delegation.assigned_manager === "shopping_agent", ok.ok ? "" : ok.reason)
    const noWorker = await requestDelegation(wo(a.m.id, "appointment_schedule"), a.c as any, a.s.deps)
    const noMission = await requestDelegation(wo(undefined, "lender_preapproval_handoff"), a.c as any, a.s.deps)
    const noFlag = await requestDelegation(wo(a.m.id, "lender_preapproval_handoff", { ownerWorkOrder: false }), a.c as any, a.s.deps)
    check("W3 (controls) still self_delegation: a capability with NO worker, no mission, or no work-order flag", [noWorker, noMission, noFlag].every((r) => !r.ok && r.reason === "self_delegation"), [noWorker, noMission, noFlag].map((r) => (r.ok ? "ok" : r.reason)).join(","))
    const other = await missionFor(a.c, a.s)
    const notOwner = await requestDelegation(wo(other.id, "lender_preapproval_handoff"), a.c as any, a.s.deps)
    check("W4 (control) a work order on a mission the manager does NOT own is refused (self_delegation)", !notOwner.ok && notOwner.reason === "self_delegation")

    // THE LENDER HANDOFF, end to end through the survivor (in memory): a BUYER contact, one bench lender.
    const world = (contactType: string, lenders: number, tenant = T1) => ({
      contacts: [{ id: "c-buyer", brokerage_id: tenant, first_name: "Pat", last_name: "Buyer", contact_type: contactType, deleted_at: null }],
      vendors: Array.from({ length: lenders }, (_, i) => ({ id: `v-l${i}`, brokerage_id: T1, name: `Bench Lender ${i}`, category: "lender" })).concat([{ id: "v-x", brokerage_id: T2, name: "Foreign Lender", category: "lender" }]),
    })
    const run = async (contactType: string, lenders: number, tenant = T1) => {
      const w = await mk(world(contactType, lenders, tenant) as any)
      const d = await requestDelegation(wo(w.m.id, "lender_preapproval_handoff"), w.c as any, w.s.deps)
      if (!d.ok) throw new Error(d.reason)
      await acceptDelegation({ brokerageId: T1, delegationId: d.delegation.id, reason: "accepted by a human", actor: { type: "user", id: "u-1" } }, w.c as any, w.s.deps)
      const out = await workDelegation({ brokerageId: T1, delegationId: d.delegation.id, userId: null, actor: { type: "user", id: "u-1" } }, w.c as any, w.s.deps)
      return { w, out, row: await getDelegation(T1, d.delegation.id, w.c as any) }
    }
    const good = await run("buyer", 1)
    const prof = (good.w.c.tables.buyer_financial_profiles ?? [])[0]
    check("W5 ACCEPTED → WORKING → RETURNED through lenderPreapprovalHandoff: the profile names the BENCH lender vendor (m605 column), status referred, the referral row is written, tenant-stamped", good.out.worked && good.row?.status === "RETURNED" && good.row.result?.lenderVendorId === "v-l0" && prof?.lender_referred_vendor_id === "v-l0" && prof?.lender_referral_status === "referred" && prof?.brokerage_id === T1 && (good.w.c.tables.credit_partner_referrals ?? []).length === 1, JSON.stringify({ out: good.out.reason, status: good.row?.status, prof }))
    check("W6 every worked transition left a ledger row (WORKING + RETURNED, LAW 5)", good.w.s.ledger.length >= 3)
    const seller = await run("seller", 1)
    check("W7 (control) a SELLER contact is not handed to a lender — ESCALATED with the reason, nothing written", !seller.out.worked && seller.row?.status === "ESCALATED" && /not a buyer/.test(seller.out.reason ?? "") && !(seller.w.c.tables.buyer_financial_profiles ?? []).length)
    const two = await run("both", 2)
    check("W8 two bench lenders and none named → nothing written, ESCALATED for a human to choose, the bench named (never a guessed lender)", !two.out.worked && two.row?.status === "ESCALATED" && /human chooses/.test(two.out.reason ?? "") && /Bench Lender 0/.test(two.out.reason ?? "") && !(two.w.c.tables.buyer_financial_profiles ?? []).length)
    const foreign = await run("buyer", 1, T2)
    check("W9 tenant isolation: another brokerage's contact reads not found (a lead must convert to a contact first) — the foreign lender never appears", !foreign.out.worked && /not found/.test(foreign.out.reason ?? "") && !JSON.stringify(good.w.c.tables.buyer_financial_profiles ?? []).includes("v-x"))
    const notAccepted = await mk(world("buyer", 1) as any)
    const nd = await requestDelegation(wo(notAccepted.m.id, "lender_preapproval_handoff"), notAccepted.c as any, notAccepted.s.deps)
    const early = nd.ok ? await workDelegation({ brokerageId: T1, delegationId: nd.delegation.id, userId: null }, notAccepted.c as any, notAccepted.s.deps) : null
    check("W10 (control) a REQUESTED (not yet accepted) delegation is never worked", !!early && !early.worked && /only an ACCEPTED/.test(early.reason ?? ""))
    const missionsSrc = src("app/actions/missions.ts"), engineSrc = src("lib/kernel/strategy-engine.ts"), fin = src("app/actions/buyer-financial.ts")
    check("W11 wired: the Missions card's accept door works the delegation (workDelegation) as the accepting human; the strategy engine files owner work orders; the agent's lender door and the capability share recordLenderReferral (one path)", /workDelegation\(/.test(missionsSrc) && /userId: g\.userId/.test(missionsSrc) && /ownerWorkOrder: ownStep/.test(engineSrc) && /recordLenderReferral\(/.test(fin) && !/from\("credit_partner_referrals"\)/.test(fin))
  }

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  console.log(" BLIND SPOTS: in-memory client (no RLS, no CHECK, no append-only trigger — the migration holds those live, once applied); the real emit / signal / authority / entitlement seams are asserted by source, the real ledger by the in-memory client; the chain / engine / reaper wires are asserted by stripped source (their runtime paths need a live run); a delegation budget on the listing-prep example is unmetered ({}) — the chain's own cost ledgers apply; the voice ISA's booking path reaches the trigger only through listing-appointment.ts confirm.")
  if (fail > 0) { console.log(" ❌ MANAGER_DELEGATION_FAIL"); process.exit(1) }
  console.log(" ✅ MANAGER_DELEGATION_PASS — one delegation service: a manager asks for a capability it does not own, the owner accepts / works / returns or says why not, every move is evidence")
}
main().catch((e) => { console.error(e); process.exit(1) })
