// lib/lead-pipeline/persona-drift.ts
//
// PERSONA-DRIFT detection (pure). Persona-grounded copy is only as honest as the enrichment behind
// it — a contact enriched 18 months ago shouldn't get a message implying CURRENT facts (job, home
// ownership, life stage may all have changed). This decides when a record's enrichment is stale
// enough to re-queue BEFORE the next persona-grounded touch. Recent behavior (a portal visit, a new
// saved search) accelerates the refresh: if they're active again, fresh facts matter more.
//
// HONEST: a never-enriched record is NOT "drifted" (it's a first-enrichment case the normal queue
// owns); only a previously-enriched record whose facts have aged is drift.

export interface PersonaDriftInput {
  /** contacts/leads.last_enriched_at — when we last refreshed the enrichment. */
  lastEnrichedAt: string | null | undefined
  now: string
  /** the record showed fresh engagement (portal visit / saved search) recently. */
  hasRecentActivity?: boolean
  /** hard staleness threshold (days) — refresh regardless of activity beyond this. */
  maxAgeDays?: number
  /** activity-accelerated threshold (days) — refresh sooner when they're active again. */
  activeAgeDays?: number
}

export interface PersonaDriftVerdict {
  needsRefresh: boolean
  ageDays: number | null
  reason: string
}

export const DEFAULT_MAX_AGE_DAYS = 180
export const DEFAULT_ACTIVE_AGE_DAYS = 90

/** Decide whether a record's enrichment should be re-queued before the next persona touch. Pure. */
export function enrichmentNeedsRefresh(input: PersonaDriftInput): PersonaDriftVerdict {
  const maxAge = input.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS
  const activeAge = input.activeAgeDays ?? DEFAULT_ACTIVE_AGE_DAYS

  if (!input.lastEnrichedAt) {
    return { needsRefresh: false, ageDays: null, reason: "never enriched — first-enrichment is the normal queue's job, not drift" }
  }
  const t = new Date(input.lastEnrichedAt).getTime()
  if (!Number.isFinite(t)) return { needsRefresh: false, ageDays: null, reason: "unparseable last_enriched_at" }
  const ageDays = Math.floor((new Date(input.now).getTime() - t) / 86_400_000)

  if (ageDays >= maxAge) {
    return { needsRefresh: true, ageDays, reason: `enrichment is ${ageDays}d old (≥ ${maxAge}d) — facts may be stale, refresh before the next persona touch` }
  }
  if (input.hasRecentActivity && ageDays >= activeAge) {
    return { needsRefresh: true, ageDays, reason: `enrichment is ${ageDays}d old and the contact re-engaged — refresh so the persona copy reflects current facts` }
  }
  return { needsRefresh: false, ageDays, reason: `enrichment is ${ageDays}d old — still fresh enough` }
}
