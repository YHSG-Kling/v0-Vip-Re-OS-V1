/**
 * lib/newsletter/seo-score.ts — PURE newsletter SEO/readability scoring.
 *
 * The scoring math (word count, H1 presence, keyword density, readability,
 * overall score, recommendations) is deterministic and has NO I/O. It is
 * extracted here so it can power BOTH:
 *   1. live draft-time scoring in the rendered newsletter editor, and
 *   2. the `getSEOScore` server action that persists a score keyed by a
 *      scheduledSendId (app/actions/newsletter/get-seo-score.ts).
 *
 * A "use server" file may only export async functions, so the pure fn,
 * its input/output types, and the band constants live in this plain module.
 */

export interface SeoScoreContentInput {
  /** Email subject line — scored for the 40-60 char open-rate sweet spot. */
  subjectLine: string
  /** Raw HTML body of the newsletter. */
  htmlContent: string
  /** Primary keyword the issue is meant to rank/resonate for. */
  primaryKeyword: string
}

export interface SeoScoreBreakdown {
  overallScore: number
  readabilityScore: number
  keywordDensity: number
  keywordCount: number
  wordCount: number
  hasH1: boolean
  recommendations: string[]
}

// ── Scoring bands (single source of truth, shared by lib + action + sim) ──────
export const SEO_BASE_SCORE = 70
export const READABILITY_BASE_SCORE = 75

/** Ideal keyword density window, as a percentage of total words. */
const KEYWORD_DENSITY_MIN = 1
const KEYWORD_DENSITY_MAX = 3

/** Word-count window that earns the overall-score length bonus. */
const OVERALL_WORDCOUNT_MIN = 300
const OVERALL_WORDCOUNT_MAX = 800

/** Subject-line length window that earns the overall-score bonus. */
const SUBJECT_MIN_LEN = 40
const SUBJECT_MAX_LEN = 60

/** Readability length penalties. */
const READABILITY_SHORT_THRESHOLD = 300
const READABILITY_LONG_THRESHOLD = 1000

/** Recommendation trigger thresholds. */
export const READABILITY_RECOMMEND_BELOW = 70
export const SEO_RECOMMEND_BELOW = 70

/**
 * Escape a user-supplied keyword so it is matched literally inside the
 * keyword-density RegExp (a keyword containing regex metacharacters would
 * otherwise throw or mis-count). Pure helper, exported for the simulator.
 */
export function escapeKeyword(keyword: string): string {
  return keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Compute the SEO/readability breakdown for a newsletter draft. Pure and
 * deterministic — same input always yields the same breakdown, no I/O.
 */
export function computeSeoScore(input: SeoScoreContentInput): SeoScoreBreakdown {
  const htmlContent = input.htmlContent ?? ''
  const primaryKeyword = input.primaryKeyword ?? ''
  const subjectLine = input.subjectLine ?? ''

  const wordCount = htmlContent.trim() === '' ? 0 : htmlContent.split(/\s+/).filter(Boolean).length
  const hasH1 = htmlContent.includes('<h1')

  const keywordCount =
    primaryKeyword.trim() === ''
      ? 0
      : (htmlContent.match(new RegExp(escapeKeyword(primaryKeyword), 'gi')) || []).length
  const keywordDensity = wordCount > 0 ? (keywordCount / wordCount) * 100 : 0

  // Readability score (0-100)
  let readabilityScore = READABILITY_BASE_SCORE
  if (wordCount < READABILITY_SHORT_THRESHOLD) readabilityScore -= 15
  if (wordCount > READABILITY_LONG_THRESHOLD) readabilityScore -= 10
  if (!hasH1) readabilityScore -= 10

  // Overall SEO score
  let overallScore = SEO_BASE_SCORE
  if (hasH1) overallScore += 10
  if (keywordDensity >= KEYWORD_DENSITY_MIN && keywordDensity <= KEYWORD_DENSITY_MAX) overallScore += 15
  if (wordCount >= OVERALL_WORDCOUNT_MIN && wordCount <= OVERALL_WORDCOUNT_MAX) overallScore += 10
  if (subjectLine.length >= SUBJECT_MIN_LEN && subjectLine.length <= SUBJECT_MAX_LEN) overallScore += 10
  overallScore = Math.min(100, overallScore)

  return {
    overallScore,
    readabilityScore,
    keywordDensity,
    keywordCount,
    wordCount,
    hasH1,
    recommendations: generateSeoRecommendations(overallScore, readabilityScore, hasH1),
  }
}

export function generateSeoRecommendations(
  seoScore: number,
  readabilityScore: number,
  hasH1: boolean,
): string[] {
  const recommendations: string[] = []

  if (!hasH1) recommendations.push('Add an H1 heading to your newsletter')
  if (readabilityScore < READABILITY_RECOMMEND_BELOW)
    recommendations.push('Simplify your language for better readability')
  if (seoScore < SEO_RECOMMEND_BELOW)
    recommendations.push('Optimize keywords and content structure')

  return recommendations
}
