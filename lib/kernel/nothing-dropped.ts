// lib/kernel/nothing-dropped.ts
//
// THE NOTHING-DROPPED SWEEP — the live-data proof of the core promise: nothing falls through the
// cracks. The system already has per-entity safety nets (stale-contact monitor, lead ghost
// detection, deadline watcher, approval office-hours). What NONE of them provide is ONE unified,
// ranked, cross-entity view — "here is everything that will drop today if untouched, worst first."
// That single card is what lets an agent/team/broker TRUST the AI team with their book (the anxiety
// this kills: "what am I forgetting / about to lose?"). This composes the awaiting states; it does
// not replace the monitors that work each lane.
//
// PURE — no I/O (the proof pins the detection + ranking). The runner gathers live awaiting rows.

export type DropEntity =
  | "lead" | "lead_followup" | "contact" | "showing_request" | "offer" | "approval" | "manager_signal" | "task"

/** Hours an entity may sit in an "awaiting / no-next-action" state before it's DROPPING. */
export const DEFAULT_SLA_HOURS: Record<DropEntity, number> = {
  lead:            1,        // not first-touched within the speed-to-lead window
  lead_followup:   72,       // first-touched, but the next email/direct-mail push is overdue
  showing_request: 4,        // a pending showing not confirmed
  offer:           2,        // an untouched offer — the most time-critical
  approval:        4,        // a proposed action past the office-hours SLA
  manager_signal:  24,       // an unconsumed inter-manager signal
  task:            0,        // any time past its due date
  contact:         14 * 24,  // not touched in 14 days
}

/** Relative cost of dropping THIS kind of ball — an untouched offer hurts far more than a stale contact. */
export const CRITICALITY: Record<DropEntity, number> = {
  offer: 3, showing_request: 2.5, approval: 2, lead: 1.8, lead_followup: 1.6, task: 1.5, manager_signal: 1, contact: 1,
}

export interface DropCandidate {
  entityType: DropEntity
  entityId: string
  /** How long it's been sitting in the awaiting state. */
  ageHours: number
  /** True when a next action IS scheduled/owned (a sequence step, a confirmed time, etc.) — then it isn't dropping. */
  hasNextAction: boolean
  /** Optional human label for the card. */
  label?: string
}

export interface DroppingBall {
  entityType: DropEntity
  entityId: string
  ageHours: number
  slaHours: number
  overdueHours: number
  /** Ranking score — how badly this is dropping, weighted by what it costs to lose. */
  severity: number
  reason: string
  label?: string
}

/** Pure: from a cross-entity candidate list, return the balls that are DROPPING (past SLA, no next
 *  action), ranked worst-first by severity = overdue × criticality. Within-SLA or owned → excluded. */
export function findDroppingBalls(
  candidates: DropCandidate[],
  slaHours: Record<DropEntity, number> = DEFAULT_SLA_HOURS,
): DroppingBall[] {
  const dropping: DroppingBall[] = []
  for (const c of candidates) {
    if (c.hasNextAction) continue
    const sla = slaHours[c.entityType]
    const overdueHours = c.ageHours - sla
    if (overdueHours <= 0) continue
    dropping.push({
      entityType: c.entityType,
      entityId: c.entityId,
      ageHours: c.ageHours,
      slaHours: sla,
      overdueHours,
      severity: overdueHours * (CRITICALITY[c.entityType] ?? 1),
      reason: `${c.entityType.replace("_", " ")} sat ${Math.round(c.ageHours)}h with no next action (SLA ${sla}h) — ${Math.round(overdueHours)}h overdue`,
      label: c.label,
    })
  }
  return dropping.sort((a, b) => b.severity - a.severity)
}

export interface SweepSummary {
  total: number
  byEntity: Partial<Record<DropEntity, number>>
  /** The worst N, ready for the ranked "about to drop" card. */
  top: DroppingBall[]
}

/** Pure: roll a dropping list into a card summary (top N worst). */
export function summarizeSweep(dropping: DroppingBall[], topN = 10): SweepSummary {
  const byEntity: Partial<Record<DropEntity, number>> = {}
  for (const d of dropping) byEntity[d.entityType] = (byEntity[d.entityType] ?? 0) + 1
  return { total: dropping.length, byEntity, top: dropping.slice(0, topN) }
}
