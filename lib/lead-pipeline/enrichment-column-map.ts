// lib/lead-pipeline/enrichment-column-map.ts
//
// Pure mapping: PeopleData enrichment profile (the JSONB blob we persist on
// leads.enrichment_profile / contacts.enrichment_profile) -> the FIRST-CLASS
// demographic / financial / social columns the contacts table already has.
//
// Why this exists: the orchestrator conserved the full PDL payload in the
// enrichment_profile jsonb, but nothing promoted it to the dedicated columns
// (age_range, household_income, home_owner_status, linkedin_url, life_events, …),
// so every scorer / segmenter / AI-ISA script / dashboard that reads those
// columns saw NULL even though we had the data. This makes the enrichment
// genuinely conserved AND usable, on both the enrich path and lead->contact
// promotion. No gateway/server imports — unit-testable under plain tsx.

/** The shape of the enrichment_profile JSONB blob (see enrichment-orchestrator). */
export interface EnrichmentProfileLike {
  provider?: string | null
  peopledata_id?: string | null
  age_range?: string | null
  gender?: string | null
  marital_status?: string | null
  household_income?: string | null
  employer?: string | null
  job_title?: string | null
  education?: Array<{ school?: string | null; degree?: string | null; major?: string | null }> | null
  home_owner_status?: string | null
  home_value?: number | null
  linkedin_url?: string | null
  facebook_url?: string | null
  twitter_url?: string | null
  github_url?: string | null
  life_events?: Array<{ type: string; date?: string; description?: string }> | null
  [k: string]: unknown
}

// Highest-first so the first regex that matches a degree string wins the rank.
const DEGREE_RANK: Array<[RegExp, string]> = [
  [/doctor|ph\.?\s?d|\bmd\b|\bjd\b|doctorate/i, 'Doctorate'],
  [/master|\bmba\b|m\.?\s?s\b|m\.?\s?a\b|msc/i, 'Master'],
  [/bachelor|b\.?\s?s\b|b\.?\s?a\b|bsc|undergrad/i, 'Bachelor'],
  [/associate|a\.?\s?a\b|a\.?\s?s\b/i, 'Associate'],
  [/high\s?school|ged|diploma/i, 'High School'],
]

/** Reduce a PDL education[] to a single normalized level string (most advanced degree found). */
export function deriveEducationLevel(
  education?: Array<{ degree?: string | null }> | null,
): string | null {
  if (!Array.isArray(education) || education.length === 0) return null
  let best: string | null = null
  let bestRank = -1
  for (const e of education) {
    const degree = (e?.degree ?? '').toString()
    if (!degree) continue
    for (let i = 0; i < DEGREE_RANK.length; i++) {
      const rank = DEGREE_RANK.length - i // higher = more advanced
      if (DEGREE_RANK[i][0].test(degree) && rank > bestRank) {
        bestRank = rank
        best = DEGREE_RANK[i][1]
      }
    }
  }
  return best
}

/**
 * Map an enrichment profile blob to the contacts first-class columns. Only emits a key
 * when the source value is genuinely present (no overwriting good data with null), so the
 * result can be spread straight into a contacts update/insert.
 */
export function peopleDataProfileToContactColumns(
  profile: EnrichmentProfileLike | null | undefined,
  opts?: { enrichedAt?: string },
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!profile || typeof profile !== 'object') return out

  const set = (key: string, value: unknown) => {
    if (value === undefined || value === null) return
    if (typeof value === 'string' && value.trim() === '') return
    out[key] = value
  }

  set('age_range', profile.age_range)
  set('gender', profile.gender)
  set('marital_status', profile.marital_status)
  set('household_income', profile.household_income)
  set('occupation', profile.job_title ?? profile.employer)
  set('education_level', deriveEducationLevel(profile.education))
  set('home_owner_status', profile.home_owner_status)
  set('home_value_estimate', typeof profile.home_value === 'number' ? profile.home_value : undefined)
  set('linkedin_url', profile.linkedin_url)
  set('facebook_url', profile.facebook_url)
  set('twitter_url', profile.twitter_url)
  set('peopledata_id', profile.peopledata_id)

  // social_handles jsonb — compact platform->url map built from whatever URLs we have.
  const social: Record<string, string> = {}
  if (profile.linkedin_url) social.linkedin = profile.linkedin_url
  if (profile.facebook_url) social.facebook = profile.facebook_url
  if (profile.twitter_url) social.twitter = profile.twitter_url
  if (profile.github_url) social.github = profile.github_url
  if (Object.keys(social).length > 0) out.social_handles = social

  if (Array.isArray(profile.life_events) && profile.life_events.length > 0) {
    out.life_events = profile.life_events
  }

  out.enrichment_source = (profile.provider as string | undefined) ?? 'peopledata'
  if (opts?.enrichedAt) out.enriched_at = opts.enrichedAt

  return out
}

/**
 * Map an enrichment profile blob to the LEADS first-class columns (m233). Leads carry a SUBSET of
 * the contact columns — only home_owner_status + life_events are promoted here (the rest stay in
 * enrichment_profile jsonb and are extracted at lead→contact promotion). Only emits a key when the
 * source value is genuinely present, so it spreads straight into a leads update.
 */
export function peopleDataProfileToLeadColumns(
  profile: EnrichmentProfileLike | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!profile || typeof profile !== 'object') return out
  if (typeof profile.home_owner_status === 'string' && profile.home_owner_status.trim() !== '') {
    out.home_owner_status = profile.home_owner_status
  }
  if (Array.isArray(profile.life_events) && profile.life_events.length > 0) {
    out.life_events = profile.life_events
  }
  return out
}
