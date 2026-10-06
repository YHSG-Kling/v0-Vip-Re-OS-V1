// lib/kernel/capacity-guardian.ts
//
// THE CAPACITY GUARDIAN — the manager that protects the HUMAN, so the ball is NEVER dropped (the
// core promise to agents/teams/brokerages). Every other tool scores an agent's OUTPUT (GCI,
// closings) or frames a cold book as a performance leak ("you must re-engage these"). This is the
// inverse: it detects when an agent is OVERLOADED and proposes the team RE-BALANCE the work BEFORE
// any lead/contact/follow-up goes stale. Leads count as real load — a lead with no portal still
// needs the AI ISA to qualify it, and an overloaded agent drops it.
//
// PURE — no I/O (the proof pins down the deterministic core). The runner gathers live signals and
// proposes a GATED, persona-generated rebalance; nothing moves a client autonomously.

export interface WorkloadSignals {
  /** Active assigned contacts (not deleted). */
  activeContacts: number
  /** Active owned leads still needing qualification (real load even without a portal). */
  activeLeads: number
  /** Follow-up DEBT: contacts past the touch SLA (stale / never-contacted) — the dropped-ball risk. */
  staleContacts: number
  /** Tasks past due. */
  overdueTasks: number
  /** Active transactions (each demands attention). */
  activeDeals: number
  /** 0..1 — recent no-show rate (execution strain). */
  noShowRate?: number
  /** WAVE 103 (lane 103B): showings still ahead on the calendar — attention already spoken for. */
  pendingShowings?: number
  /** WAVE 103 (lane 103B): the agent's own fatigue band as the retention radar scored it
   *  (agent_retention_scores.tier — ONE vocabulary with lib/recruiting/retention-score.ts).
   *  null / undefined = no row (never read as "fine", never read as "fatigued"). */
  fatigueTier?: "engaged" | "healthy" | "watch" | "at_risk" | "critical" | null
}

export interface CapacityThresholds {
  /** Tier-based soft ceiling on working load (contacts + leads + deals). */
  maxLoad: number
}

/** Default soft ceilings by tier — a solo agent saturates far sooner than a brokerage pool. */
export const TIER_MAX_LOAD: Record<string, number> = { solo: 40, team: 75, brokerage: 150, multi_location: 250 }

/** PURE. Derive the per-agent tier ceiling from the brokerage's agent headcount — the SINGLE
 *  source of truth shared by the guardian runner AND the assignment capacity gate (no drift). */
export function tierMaxLoadForAgentCount(agentCount: number): number {
  if (agentCount <= 1) return TIER_MAX_LOAD.solo
  if (agentCount <= 15) return TIER_MAX_LOAD.team
  return TIER_MAX_LOAD.brokerage
}

export interface WorkloadIndex {
  /** Working load = contacts + leads + deals. */
  load: number
  /** 0..1 — load against the tier ceiling (capped). */
  capacityScore: number
  /** Follow-up debt = stale contacts + overdue tasks (the dropped-ball signal). */
  followUpDebt: number
  burnoutRisk: "low" | "medium" | "high"
  /** The REAL reasons (no fabrication). */
  drivers: string[]
}

export const HIGH_LOAD = 0.85
// TOMBSTONE (orphan doctrine §1.3) — this name is no longer exported: MED_LOAD.
// Nothing in the product imported it, and no simulator did either; the
// value is live and unchanged, reached through this module's own exported
// functions, which is where callers already get its effect. Same ruling and same
// reasoning as lib/vendors/appraiser-independence.ts (isAppraiserTrade,
// labelNamesAppraisal): an export with no importer is a public surface nobody
// asked for, and the wire to build is not a second copy of the module's door.
const MED_LOAD = 0.7
/** Follow-up debt that means balls are already being dropped, regardless of headcount. */
export const DEBT_ALARM = 8

/**
 * pickLeastLoadedWithHeadroom — PURE. The CAPACITY GATE the assignment cascade uses so a fresh
 * contact never piles onto an agent who is already at/over their ceiling (the guardian becomes
 * PREVENTIVE, not just reactive). Prefers the least-loaded agent who still has HEADROOM (under
 * HIGH_LOAD of the ceiling); if EVERY candidate is at/over the ceiling, falls back to the
 * least-loaded overall so a contact is never stranded — the guardian then surfaces the overload.
 * Deterministic: ties keep input order (callers pass a stable order, e.g. created_at asc).
 */
export function pickLeastLoadedWithHeadroom(
  candidates: Array<{ agentId: string; load: number; band?: CapacityBand }>,
  maxLoad: number,
): string | null {
  if (candidates.length === 0) return null
  const ceiling = Math.max(1, maxLoad)
  // WAVE 103 (lane 103B): a candidate that carries its capacity BAND is judged by the one kernel
  // answer (fatigue and follow-up debt included); a bare load keeps the original ceiling test.
  const withHeadroom = candidates.filter((c) => (c.band ? hasHeadroom(c.band) : c.load / ceiling < HIGH_LOAD))
  const pool = withHeadroom.length > 0 ? withHeadroom : candidates
  let best = pool[0]
  for (const c of pool) if (c.load < best.load) best = c
  return best.agentId
}

/** Pure: compute an agent's workload index. burnoutRisk is HIGH when the agent is at/over the tier
 *  ceiling OR carrying alarming follow-up debt (the ball is already dropping).
 *  Module-private since wave 103 (lane 103B): every reader — the runner, the pick, the simulators —
 *  reaches it as `computeCapacity(...).index`, the ONE kernel answer. */
function computeAgentWorkloadIndex(s: WorkloadSignals, t: CapacityThresholds): WorkloadIndex {
  const load = s.activeContacts + s.activeLeads + s.activeDeals
  const maxLoad = Math.max(1, t.maxLoad)
  const capacityScore = Math.min(1, load / maxLoad)
  const followUpDebt = s.staleContacts + s.overdueTasks

  const drivers: string[] = []
  if (capacityScore >= HIGH_LOAD) drivers.push(`load ${load}/${maxLoad} (${Math.round(capacityScore * 100)}% of capacity)`)
  if (followUpDebt >= DEBT_ALARM) drivers.push(`${followUpDebt} follow-ups overdue (${s.staleContacts} stale contacts, ${s.overdueTasks} overdue tasks)`)
  if ((s.noShowRate ?? 0) >= 0.25) drivers.push(`${Math.round((s.noShowRate ?? 0) * 100)}% no-show rate`)

  let burnoutRisk: WorkloadIndex["burnoutRisk"] = "low"
  if (capacityScore >= HIGH_LOAD || followUpDebt >= DEBT_ALARM) burnoutRisk = "high"
  else if (capacityScore >= MED_LOAD || followUpDebt >= DEBT_ALARM / 2) burnoutRisk = "medium"

  return { load, capacityScore, followUpDebt, burnoutRisk, drivers }
}

export interface OverloadDecision {
  overloaded: boolean
  /** How many contacts to rebalance to a teammate to bring the agent back under the ceiling
   *  (or to clear the worst of the follow-up debt). 0 when not overloaded. */
  rebalanceCount: number
  reason: string
}

/** Pure: decide whether to intervene and by how much. Never proposes moving more than is needed. */
export function detectOverload(idx: WorkloadIndex, t: CapacityThresholds): OverloadDecision {
  if (idx.burnoutRisk !== "high") {
    return { overloaded: false, rebalanceCount: 0, reason: `burnout risk ${idx.burnoutRisk} — no intervention` }
  }
  // Move enough to get under the ceiling, OR a chunk of the follow-up debt if load alone isn't it.
  const overCeiling = Math.max(0, idx.load - t.maxLoad)
  const debtRelief = idx.followUpDebt >= DEBT_ALARM ? Math.ceil(idx.followUpDebt / 3) : 0
  const rebalanceCount = Math.max(1, overCeiling, debtRelief)
  return { overloaded: true, rebalanceCount, reason: idx.drivers.join("; ") || "high burnout risk" }
}

// ─── WAVE 103 (lane 103B) — AGENT CAPACITY, ONE KERNEL ANSWER ─────────────────────────────────────
//
// Every consumer that used to ask its own question ("who has room?", "is this agent slammed?",
// "should the ISA keep touching this book?") now reads ONE answer: `AgentCapacity` — load,
// headroom, band, reasons. The pure half lives here next to the index it extends; the gatherer
// (`capacityFor`) lives on lib/lead-assignment/capacity-pick.ts, the one I/O survivor both the
// assignment cascade and the guardian runner already shared for the load definition.
//
// ONE VOCABULARY (§6) for the band: available · busy · at_capacity · over.

/** The manager-bus words the guardian publishes — ONE spelling each (runner writes, brief reads). */
export const AGENT_OVERLOADED_SIGNAL = "agent_overloaded"
export const AGENT_REASSIGNMENT_SUGGESTED_SIGNAL = "agent_reassignment_suggested"

/** @proofSeam exported so scripts/capacity-guard.ts can assert the band vocabulary is spelled once
 *  and that every live agent_retention_scores.tier maps into it; product code reads the type. */
export const CAPACITY_BANDS = ["available", "busy", "at_capacity", "over"] as const
export type CapacityBand = (typeof CAPACITY_BANDS)[number]

export interface AgentCapacity {
  /** Working load = contacts + leads + deals (the SAME definition computeAgentWorkloadIndex uses). */
  load: number
  /** Items the agent can still take before HIGH_LOAD of the tier ceiling; 0 when at/over. */
  headroom: number
  band: CapacityBand
  /** The REAL reasons the band is what it is (no fabrication; empty when available). */
  reasons: string[]
  /** The underlying index, for consumers that already read it (the guardian runner). */
  index: WorkloadIndex
  /** Wave 106 (106A): the retention tier the band was computed WITH (gatherWorkloadSignals already reads
   *  it) — carried through so a consumer scoring fatigue separately (the allocation recommender) needs no
   *  second read of agent_retention_scores. null = no row / not read. */
  fatigueTier: WorkloadSignals["fatigueTier"]
}

/** An agent may take fresh work only in these bands. */
export function hasHeadroom(band: CapacityBand): boolean {
  return band === "available" || band === "busy"
}

/** PURE. Derive the band from the index and the agent's own fatigue tier. Over ⇐ at/over the
 *  ceiling, alarming follow-up debt, or a CRITICAL fatigue tier (a burnt-out agent has no room
 *  whatever the count says). at_capacity ⇐ HIGH_LOAD or an at_risk tier. busy ⇐ MED_LOAD or half
 *  the debt alarm. A missing fatigue row changes nothing. Module-private: the proof drives it
 *  through computeCapacity. */
function capacityBandFor(idx: WorkloadIndex, fatigueTier?: WorkloadSignals["fatigueTier"]): CapacityBand {
  if (idx.capacityScore >= 1 || idx.followUpDebt >= DEBT_ALARM || fatigueTier === "critical") return "over"
  if (idx.capacityScore >= HIGH_LOAD || fatigueTier === "at_risk") return "at_capacity"
  if (idx.capacityScore >= MED_LOAD || idx.followUpDebt >= DEBT_ALARM / 2) return "busy"
  return "available"
}

/** PURE. The one capacity answer for an agent. */
export function computeCapacity(s: WorkloadSignals, t: CapacityThresholds): AgentCapacity {
  const index = computeAgentWorkloadIndex(s, t)
  const band = capacityBandFor(index, s.fatigueTier)
  const maxLoad = Math.max(1, t.maxLoad)
  const headroom = hasHeadroom(band) ? Math.max(0, Math.floor(maxLoad * HIGH_LOAD) - index.load) : 0
  const reasons = [...index.drivers]
  if ((s.pendingShowings ?? 0) > 0) reasons.push(`${s.pendingShowings} showings ahead`)
  if (s.fatigueTier === "critical" || s.fatigueTier === "at_risk") reasons.push(`agent fatigue ${s.fatigueTier}`)
  if (band === "busy" && reasons.length === 0) reasons.push(`load ${index.load}/${maxLoad} (${Math.round(index.capacityScore * 100)}% of capacity)`)
  return { load: index.load, headroom, band, reasons, index, fatigueTier: s.fatigueTier ?? null }
}

/** PURE. Share of an automated touch batch an agent's book may receive this run — FEWER touches
 *  when the agent is over capacity (every reply lands on that agent). 1 = the whole batch.
 *  Module-private: the proof drives it through throttleTouchBatch. */
function touchAllowanceFor(band: CapacityBand): number {
  switch (band) {
    case "over":        return 0.25
    case "at_capacity": return 0.5
    default:            return 1
  }
}

/** PURE. Cap a ranked touch batch per owning agent by that agent's band. Order is preserved;
 *  an item whose agent has no capacity answer (null) is kept — a missing read never throttles. */
export function throttleTouchBatch<T>(
  items: ReadonlyArray<T>,
  agentIdOf: (item: T) => string | null,
  bandOf: (agentId: string) => CapacityBand | null,
  batch: number,
): { kept: T[]; throttled: number } {
  const taken = new Map<string, number>()
  const kept: T[] = []
  let throttled = 0
  for (const item of items) {
    const agentId = agentIdOf(item)
    const band = agentId ? bandOf(agentId) : null
    if (!agentId || !band) { kept.push(item); continue }
    const allowance = Math.max(1, Math.floor(Math.max(1, batch) * touchAllowanceFor(band)))
    const n = taken.get(agentId) ?? 0
    if (n >= allowance) { throttled++; continue }
    taken.set(agentId, n + 1)
    kept.push(item)
  }
  return { kept, throttled }
}

/** Days an agent must stay OVER before the guardian suggests a temporary books reassignment. */
export const OVER_CAPACITY_ESCALATION_DAYS = 3
/** The temporary cover window the suggestion proposes (agent-books validates it). */
export const REASSIGNMENT_SUGGESTION_DAYS = 14

/** PURE. Count the DISTINCT days (UTC) inside the trailing window on which an overload signal was
 *  raised — the guardian signals once per agent per day, so this is "days over". */
export function overloadDaysIn(signalCreatedAts: ReadonlyArray<string>, now: Date, windowDays: number = OVER_CAPACITY_ESCALATION_DAYS): number {
  const since = now.getTime() - windowDays * 86_400_000
  const days = new Set<string>()
  for (const iso of signalCreatedAts) {
    const t = Date.parse(iso)
    if (!Number.isFinite(t) || t < since || t > now.getTime()) continue
    days.add(new Date(t).toISOString().slice(0, 10))
  }
  return days.size
}

/** PURE. Escalate to a reassignment suggestion once the agent has been over for N days (today
 *  included), and never when there is nobody with headroom to receive the book. */
export function shouldSuggestReassignment(daysOver: number, receiverId: string | null, n: number = OVER_CAPACITY_ESCALATION_DAYS): boolean {
  return daysOver >= n && receiverId !== null
}
