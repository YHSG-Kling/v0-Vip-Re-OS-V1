'use server'

import { createClient } from '@/lib/supabase/server'

export interface SEOScoreInput {
  scheduledSendId: string
  subjectLine: string
  previewText: string
  htmlContent: string
  primaryKeyword: string
}

export async function getSEOScore(input: SEOScoreInput) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  // Calculate SEO metrics (placeholder implementation)
  const htmlContent = input.htmlContent
  const wordCount = htmlContent.split(/\s+/).length
  const hasH1 = htmlContent.includes('<h1')
  const keywordCount = (htmlContent.match(new RegExp(input.primaryKeyword, 'gi')) || []).length
  const keywordDensity = (keywordCount / wordCount) * 100

  // Simple readability score (0-100)
  let readabilityScore = 75
  if (wordCount < 300) readabilityScore -= 15
  if (wordCount > 1000) readabilityScore -= 10
  if (!hasH1) readabilityScore -= 10

  // Calculate overall SEO score
  let seoScore = 70
  if (hasH1) seoScore += 10
  if (keywordDensity >= 1 && keywordDensity <= 3) seoScore += 15
  if (wordCount >= 300 && wordCount <= 800) seoScore += 10
  if (input.subjectLine.length >= 40 && input.subjectLine.length <= 60) seoScore += 10
  seoScore = Math.min(100, seoScore)

  // Store SEO score
  const { error } = await supabase
    .from('newsletter_seo_scores')
    .insert({
      scheduled_send_id: input.scheduledSendId,
      h1_present: hasH1,
      keyword_density: keywordDensity,
      primary_keyword: input.primaryKeyword,
      keyword_count: keywordCount,
      readability_score: readabilityScore,
      word_count: wordCount,
      overall_seo_score: seoScore,
      analyzed_at: new Date().toISOString(),
    })

  if (error) throw new Error(`Failed to save SEO score: ${error.message}`)

  return {
    overallScore: seoScore,
    readabilityScore,
    keywordDensity,
    wordCount,
    hasH1,
    recommendations: generateSEORecommendations(seoScore, readabilityScore, hasH1),
  }
}

function generateSEORecommendations(seoScore: number, readabilityScore: number, hasH1: boolean) {
  const recommendations: string[] = []

  if (!hasH1) recommendations.push('Add an H1 heading to your newsletter')
  if (readabilityScore < 70) recommendations.push('Simplify your language for better readability')
  if (seoScore < 70) recommendations.push('Optimize keywords and content structure')

  return recommendations
}
