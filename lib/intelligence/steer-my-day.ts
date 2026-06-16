// lib/intelligence/steer-my-day.ts
//
// STEER MY DAY (pure) — the AGENT's one-glance morning surface (agent-scoped, never broker
// oversight): "here's who needs YOU first across your WHOLE funnel — a lead about to go cold AND a
// lifetime client slipping, on one ranked queue — here's what your AI team plans to send today, and
// here's what got held." Fuses the lead-warmth + lifetime-health work list (who) with the dry-run
// cockpit (what + gates). Leads and contacts score on the SAME band/priority scale, so the agent
// works the single most-urgent relationship next regardless of where it sits in the funnel — the
// "one team, whole journey" view a per-deal CRM can't show. The voice admin (start_marketing /
// voice_followup) already acts on it hands-free; the UI adds hold/swap/approve. Pure (no I/O).

import type { HealthBand, HealthRankedItem } from "./relationship-health"
import type { PlannedDaySummary } from "./dry-run-cockpit"

/** One unit of work on the agent's queue — a lead OR a contact, on the shared health scale. */
export interface WorkItem {
  kind: "contact" | "lead"
  id: string
  score: number
  band: HealthBand
  priority: number
  drivers: string[]
}

/** A ranked lead, as the lead-warmth runner returns it (leadId + the shared warmth shape). */
export interface RankedLeadLite {
  leadId: string
  score: number
  band: HealthBand
  priority: number
  drivers: string[]
}

export interface SteerMyDayInput {
  /** lifetime-relationship work list (contacts), already health-ranked. */
  healthRanked: HealthRankedItem[]
  /** lead work list (warmth-ranked) — merged onto the SAME queue. Optional (back-compat). */
  leadRanked?: RankedLeadLite[]
  plannedDay: PlannedDaySummary
  /** how many "work first" items to surface. */
  topN?: number
}

export interface SteerMyDay {
  /** the unified work-first queue — leads AND contacts, cooling-or-worse, most-at-risk leading. */
  workFirst: WorkItem[]
  planned: { total: number; willSend: number; blocked: number }
  headline: string
}

const NEEDS_ATTENTION = 2 // healthPriority for "cooling" and worse

/** Merge the contact + lead work lists into one queue on the shared scale (most-urgent first). Pure. */
export function mergeWorkQueue(healthRanked: HealthRankedItem[], leadRanked: RankedLeadLite[] = []): WorkItem[] {
  const contacts: WorkItem[] = (healthRanked ?? []).map((h) => ({
    kind: "contact", id: h.contactId, score: h.score, band: h.band, priority: h.priority, drivers: h.drivers,
  }))
  const leads: WorkItem[] = (leadRanked ?? []).map((l) => ({
    kind: "lead", id: l.leadId, score: l.score, band: l.band, priority: l.priority, drivers: l.drivers,
  }))
  // Higher priority first; within the same band, the lower score (more urgent) first.
  return [...contacts, ...leads].sort((a, b) => (b.priority - a.priority) || (a.score - b.score))
}

/** Assemble the agent's steer-my-day digest across the whole funnel. Pure. */
export function assembleSteerMyDay(input: SteerMyDayInput): SteerMyDay {
  const topN = input.topN ?? 5
  const workFirst = mergeWorkQueue(input.healthRanked ?? [], input.leadRanked ?? [])
    .filter((w) => w.priority >= NEEDS_ATTENTION)
    .slice(0, topN)
  const p = input.plannedDay ?? { total: 0, willSend: 0, blocked: 0, touches: [] }

  const slip = workFirst.length
  const leadCount = workFirst.filter((w) => w.kind === "lead").length
  const headlineParts: string[] = []
  if (slip > 0) {
    // Name the funnel mix so the agent knows it spans cold leads AND slipping clients.
    const mix = leadCount > 0 && leadCount < slip ? ` (${slip - leadCount} client${slip - leadCount === 1 ? "" : "s"}, ${leadCount} lead${leadCount === 1 ? "" : "s"})`
      : leadCount === slip ? ` (lead${slip === 1 ? "" : "s"})` : ""
    headlineParts.push(`${slip} slipping${mix} — work ${slip === 1 ? "it" : "them"} first`)
  } else {
    headlineParts.push("no one slipping — you're on top of it")
  }
  if (p.willSend > 0 || p.blocked > 0) {
    headlineParts.push(`your team plans ${p.willSend} send${p.willSend === 1 ? "" : "s"} today${p.blocked > 0 ? ` (${p.blocked} held by the gates)` : ""}`)
  }
  return {
    workFirst,
    planned: { total: p.total, willSend: p.willSend, blocked: p.blocked },
    headline: headlineParts.join(" · "),
  }
}
