// lib/intelligence/lead-warmth.ts
//
// LEAD WARMTH (pure) — the leads-side counterpart to relationship health. A lead isn't a lifetime
// relationship yet, so the "never replied" penalty that defines a slipping CLIENT would tank every
// lead; warmth is instead about how actively we're working them and how well we know them: touch
// cadence (are we nurturing or letting them go cold?), enrichment freshness (do we even know who
// they are?), the AI ISA's temperature read, and any inbound spark (rare, so it counts double).
// Reuses the health band/priority so leads and contacts reprioritize on one scale. Pure (no I/O).

import { bandForScore, healthPriority, type HealthBand } from "./relationship-health"

export interface LeadWarmthInput {
  daysSinceLastTouch: number | null
  enrichmentAgeDays: number | null
  /** AI ISA temperature read: "hot" | "warm" | "cold" | null. */
  leadTemperature: string | null
  /** the lead has ever replied/engaged inbound (rare for a lead → strong positive signal). */
  hasReplied?: boolean
}

export interface LeadWarmth {
  score: number
  band: HealthBand
  priority: number
  drivers: string[]
}

function clamp(n: number, lo = 0, hi = 100): number { return Math.max(lo, Math.min(hi, n)) }

/** Score a lead's warmth (0–100) on the shared band scale. Pure. */
export function scoreLeadWarmth(input: LeadWarmthInput): LeadWarmth {
  let score = 100
  const drivers: string[] = []

  // Touch cadence — are we actively working this lead? Scales with neglect (deep neglect → at-risk).
  if (input.daysSinceLastTouch === null) { score -= 8; drivers.push("never worked") }
  else {
    const pen = Math.min(35, Math.floor(input.daysSinceLastTouch / 7) * 4)
    if (pen > 0) { score -= pen; if (pen > 10) drivers.push(`untouched ${input.daysSinceLastTouch}d`) }
  }

  // Enrichment freshness — do we know who they are?
  if (input.enrichmentAgeDays === null) { score -= 12; drivers.push("not enriched") }
  else if (input.enrichmentAgeDays > 180) { score -= 6; drivers.push("enrichment stale") }

  // AI ISA temperature read.
  const temp = (input.leadTemperature ?? "").toLowerCase()
  if (temp === "hot") { /* no penalty — keep them hot */ }
  else if (temp === "warm") score -= 6
  else { score -= 16; if (temp !== "cold") drivers.push("no temperature read") }

  // Inbound spark — rare for a lead, so it's a strong signal of a live one.
  if (input.hasReplied) { score += 12; drivers.push("has engaged inbound") }

  const final = clamp(Math.round(score))
  return { score: final, band: bandForScore(final), priority: healthPriority(bandForScore(final)), drivers }
}
