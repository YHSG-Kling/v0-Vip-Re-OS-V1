// lib/intelligence/relationship-health.ts
//
// LIFETIME RELATIONSHIP HEALTH (pure) — one signal that says how alive each client relationship is,
// folding the four things a great agent feels intuitively: are they ENGAGING (replying), are WE
// nurturing (touch cadence), how long since they REACHED BACK (inbound recency), and do we still
// actually KNOW them (enrichment freshness). The band + priority let the team reprioritize WHO needs
// attention next across the whole lifecycle — the "knows the client for life" differentiator that a
// per-deal CRM can't express. Pure (no I/O), unit-tested directly.

export type HealthBand = "thriving" | "warm" | "cooling" | "at_risk" | "dormant"

export interface RelationshipHealthInput {
  /** days since the contact last reached BACK (inbound reply/call) — the strongest live-relationship signal. */
  daysSinceLastInbound: number | null
  /** reply rate to our outreach (0–1). */
  replyRate: number | null
  /** days since WE last touched them (are we nurturing or neglecting?). */
  daysSinceLastTouch: number | null
  /** age of the enrichment we're personalizing from (stale = we don't really know them anymore). */
  enrichmentAgeDays: number | null
}

export interface RelationshipHealth {
  score: number // 0–100
  band: HealthBand
  /** the factors that moved the score, for the agent's context. */
  drivers: string[]
}

function clamp(n: number, lo = 0, hi = 100): number { return Math.max(lo, Math.min(hi, n)) }

export function bandForScore(score: number): HealthBand {
  if (score >= 80) return "thriving"
  if (score >= 60) return "warm"
  if (score >= 40) return "cooling"
  if (score >= 20) return "at_risk"
  return "dormant"
}

/** Score the health of one relationship. Pure. Higher = more alive. */
export function scoreRelationshipHealth(input: RelationshipHealthInput): RelationshipHealth {
  let score = 100
  const drivers: string[] = []

  // 1. Inbound recency — the single strongest signal that the relationship is two-way.
  if (input.daysSinceLastInbound === null) {
    score -= 35; drivers.push("never reached back")
  } else {
    const pen = Math.min(45, Math.floor(input.daysSinceLastInbound / 7) * 4)
    if (pen > 0) { score -= pen; drivers.push(`${input.daysSinceLastInbound}d since they last replied`) }
  }

  // 2. Reply rate — engagement with our outreach.
  if (typeof input.replyRate === "number") {
    if (input.replyRate < 0.1) {
      const pen = Math.round(((0.1 - input.replyRate) / 0.1) * 15)
      score -= pen; if (pen > 5) drivers.push(`low reply rate (${(input.replyRate * 100).toFixed(0)}%)`)
    }
  }

  // 3. Touch cadence — neglect penalty (we've gone quiet on them).
  if (input.daysSinceLastTouch === null) { score -= 5; drivers.push("no outreach on record") }
  else if (input.daysSinceLastTouch > 60) { score -= 10; drivers.push(`we haven't reached out in ${input.daysSinceLastTouch}d`) }
  else if (input.daysSinceLastTouch > 30) { score -= 5 }

  // 4. Enrichment freshness — do we still know who they are?
  if (input.enrichmentAgeDays === null) { score -= 5 }
  else if (input.enrichmentAgeDays > 365) { score -= 10; drivers.push("enrichment is stale (>1y)") }
  else if (input.enrichmentAgeDays > 180) { score -= 5 }

  const final = clamp(Math.round(score))
  return { score: final, band: bandForScore(final), drivers }
}

/** Urgency rank for reprioritization — at-risk/dormant need attention FIRST (higher = sooner). Pure. */
export function healthPriority(band: HealthBand): number {
  switch (band) {
    case "dormant": return 4
    case "at_risk": return 3
    case "cooling": return 2
    case "warm": return 1
    case "thriving": return 0
  }
}
