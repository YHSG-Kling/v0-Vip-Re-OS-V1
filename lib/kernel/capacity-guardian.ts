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
  candidates: Array<{ agentId: string; load: number }>,
  maxLoad: number,
): string | null {
  if (candidates.length === 0) return null
  const ceiling = Math.max(1, maxLoad)
  const withHeadroom = candidates.filter((c) => c.load / ceiling < HIGH_LOAD)
  const pool = withHeadroom.length > 0 ? withHeadroom : candidates
  let best = pool[0]
  for (const c of pool) if (c.load < best.load) best = c
  return best.agentId
}

/** Pure: compute an agent's workload index. burnoutRisk is HIGH when the agent is at/over the tier
 *  ceiling OR carrying alarming follow-up debt (the ball is already dropping). */
export function computeAgentWorkloadIndex(s: WorkloadSignals, t: CapacityThresholds): WorkloadIndex {
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
