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
