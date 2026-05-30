// lib/lead-pipeline/enrichment-merge.ts
// Pure enrichment merge logic — separated from perplexity-enrichment.ts so it
// carries NO gateway/server-only imports and is unit-testable in any runtime
// (the scraper simulator runs under plain tsx).

export interface BaseEnrichment {
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  enrichmentConfidence: number
  employer?: string | null
  currentBrokerage?: string | null
}

export interface PerplexityFindings {
  email?: string | null
  phone?: string | null
  employer?: string | null
  currentBrokerage?: string | null
}

/**
 * PeopleData (structured, trusted) takes precedence; Perplexity only fills
 * genuinely missing fields. Confidence is nudged up when a gap is filled, never
 * above the structured-source ceiling.
 */
export function mergeEnrichment(base: BaseEnrichment, extra: PerplexityFindings | null): BaseEnrichment {
  if (!extra) return base
  let filled = false
  const next: BaseEnrichment = { ...base }
  if (!next.email && extra.email) { next.email = extra.email; filled = true }
  if (!next.phone && extra.phone) { next.phone = extra.phone; filled = true }
  if (!next.employer && extra.employer) { next.employer = extra.employer; filled = true }
  if (!next.currentBrokerage && extra.currentBrokerage) { next.currentBrokerage = extra.currentBrokerage; filled = true }
  if (filled) {
    next.enrichmentConfidence = Math.min(0.75, base.enrichmentConfidence + 0.15)
  }
  return next
}

/** Should we spend a Perplexity call? Only for high-value, identity-promising gaps. */
export function shouldGapFill(base: BaseEnrichment): boolean {
  const hasFullName = !!(base.first_name && base.last_name)
  return hasFullName && !base.email
}
