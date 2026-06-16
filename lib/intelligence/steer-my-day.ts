// lib/intelligence/steer-my-day.ts
//
// STEER MY DAY (pure) — the AGENT's one-glance morning surface (agent-scoped, never broker
// oversight): "here's who's slipping and needs YOU first, here's what your AI team plans to send
// today, and here's what got held." Fuses the lifetime health-ranked work list (who) with the
// dry-run cockpit (what + gates). The voice admin (start_marketing / voice_followup) already exists
// to act on it hands-free; the UI adds hold/swap/approve. Pure (no I/O), unit-tested directly.

import type { HealthRankedItem } from "./relationship-health"
import type { PlannedDaySummary } from "./dry-run-cockpit"

export interface SteerMyDayInput {
  healthRanked: HealthRankedItem[]
  plannedDay: PlannedDaySummary
  /** how many "work first" clients to surface. */
  topN?: number
}

export interface SteerMyDay {
  /** the clients to work FIRST — cooling or worse, most-at-risk leading. */
  workFirst: HealthRankedItem[]
  planned: { total: number; willSend: number; blocked: number }
  headline: string
}

const NEEDS_ATTENTION = 2 // healthPriority for "cooling" and worse

/** Assemble the agent's steer-my-day digest. Pure. */
export function assembleSteerMyDay(input: SteerMyDayInput): SteerMyDay {
  const topN = input.topN ?? 5
  const workFirst = (input.healthRanked ?? [])
    .filter((h) => h.priority >= NEEDS_ATTENTION)
    .slice(0, topN)
  const p = input.plannedDay ?? { total: 0, willSend: 0, blocked: 0, touches: [] }

  const slip = workFirst.length
  const headlineParts: string[] = []
  headlineParts.push(slip > 0 ? `${slip} client${slip === 1 ? "" : "s"} slipping — work ${slip === 1 ? "it" : "them"} first` : "no clients slipping — you're on top of it")
  if (p.willSend > 0 || p.blocked > 0) {
    headlineParts.push(`your team plans ${p.willSend} send${p.willSend === 1 ? "" : "s"} today${p.blocked > 0 ? ` (${p.blocked} held by the gates)` : ""}`)
  }
  return {
    workFirst,
    planned: { total: p.total, willSend: p.willSend, blocked: p.blocked },
    headline: headlineParts.join(" · "),
  }
}
