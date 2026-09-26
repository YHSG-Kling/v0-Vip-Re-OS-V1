'use server'

import { createClient } from '@/lib/supabase/server'
import { computeSeoScore } from '@/lib/newsletter/seo-score'

export interface SEOScoreInput {
  scheduledSendId: string
  subjectLine: string
  previewText: string
  htmlContent: string
  primaryKeyword: string
}

/**
 * Score a scheduled newsletter send and persist the breakdown to
 * newsletter_seo_scores (keyed by scheduledSendId).
 *
 * The scoring math is the PURE `computeSeoScore` in lib/newsletter/seo-score.ts
 * (also used for live draft-time scoring in the editor). This action is the thin
 * I/O wrapper: auth → compute → persist.
 */
export async function getSEOScore(input: SEOScoreInput) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const breakdown = computeSeoScore({
    subjectLine: input.subjectLine,
    htmlContent: input.htmlContent,
    primaryKeyword: input.primaryKeyword,
  })

  const { error } = await supabase.from('newsletter_seo_scores').insert({
    scheduled_send_id: input.scheduledSendId,
    h1_present: breakdown.hasH1,
    keyword_density: breakdown.keywordDensity,
    primary_keyword: input.primaryKeyword,
    keyword_count: breakdown.keywordCount,
    readability_score: breakdown.readabilityScore,
    word_count: breakdown.wordCount,
    overall_seo_score: breakdown.overallScore,
    analyzed_at: new Date().toISOString(),
  })

  if (error) throw new Error(`Failed to save SEO score: ${error.message}`)

  return breakdown
}

export interface StoredSEOScore {
  scheduledSendId: string
  overallScore: number
  readabilityScore: number
  keywordDensity: number
  primaryKeyword: string | null
  hasH1: boolean
  wordCount: number
  keywordCount: number
  analyzedAt: string | null
}

/**
 * READER (orphan doctrine §1.2) for newsletter_seo_scores — the persisted
 * breakdown getSEOScore() writes above. Until now nothing read the 8 columns
 * back out: the editor only ever showed the LIVE draft-time recompute
 * (computeSeoScore, useMemo'd in app/newsletters/newsletters-client.tsx), and
 * the row written the moment a send was scheduled sat write-only forever.
 *
 * Tenant-scoped from the SESSION (§4): newsletter_seo_scores itself carries no
 * brokerage_id (schema-snapshot.ts:444), so the scope is proven by joining
 * through newsletter_scheduled_sends.brokerage_id — the same table
 * scheduled_send_id FKs (get-seo-score.ts:36-46, schedule-newsletter.ts:154-185)
 * — and matching it against the caller's own brokerage. A scheduled_send_id
 * from another tenant, or one with no score yet, returns null rather than
 * throwing: "not scored yet" is a normal state for a draft still being edited.
 */
export async function getStoredSEOScore(scheduledSendId: string): Promise<StoredSEOScore | null> {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: userData } = await supabase
    .from('users')
    .select('brokerage_id')
    .eq('id', user.id)
    .maybeSingle()
  if (!userData?.brokerage_id) throw new Error('User has no brokerage assigned')

  // Prove the scheduled send belongs to the caller's own brokerage BEFORE
  // trusting the id as a lookup key — the RLS client already scopes this read
  // to rows visible under the caller's session, but the explicit predicate
  // keeps the tenant check legible here rather than only implicit in policy.
  const { data: send, error: sendError } = await supabase
    .from('newsletter_scheduled_sends')
    .select('id')
    .eq('id', scheduledSendId)
    .eq('brokerage_id', userData.brokerage_id)
    .maybeSingle()
  if (sendError) throw new Error(`Could not verify that scheduled send: ${sendError.message}`)
  if (!send) return null

  const { data, error } = await supabase
    .from('newsletter_seo_scores')
    .select('scheduled_send_id, overall_seo_score, readability_score, keyword_density, primary_keyword, h1_present, word_count, keyword_count, analyzed_at')
    .eq('scheduled_send_id', scheduledSendId)
    .maybeSingle()
  if (error) throw new Error(`Could not read the SEO score: ${error.message}`)
  if (!data) return null

  return {
    scheduledSendId: data.scheduled_send_id,
    overallScore: data.overall_seo_score,
    readabilityScore: data.readability_score,
    keywordDensity: data.keyword_density,
    primaryKeyword: data.primary_keyword,
    hasH1: data.h1_present,
    wordCount: data.word_count,
    keywordCount: data.keyword_count,
    analyzedAt: data.analyzed_at,
  }
}
