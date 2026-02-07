/**
 * MULTI-FACTOR LEAD SCORING ENGINE
 * 
 * This is the AUTHORITATIVE system for calculating lead scores.
 * It replaces simple/implicit scoring with deterministic, repeatable,
 * multi-dimensional scoring that considers:
 * 
 * - Intent strength (from enrichment signals)
 * - Urgency indicators (timeline, motivation)
 * - Engagement signals (pre-contact only)
 * - Data completeness (contact info quality)
 * - Source reliability (where the lead came from)
 * 
 * Scores are normalized 0-100 and must be explainable.
 */

export interface LeadScoringFactors {
  intentScore: number // 0-30 points
  urgencyScore: number // 0-25 points
  engagementScore: number // 0-20 points
  dataQualityScore: number // 0-15 points
  sourceReliabilityScore: number // 0-10 points
}

export interface ScoringResult {
  finalScore: number // 0-100
  factors: LeadScoringFactors
  explanation: string
  scoredAt: string
}

export function calculateLeadScore(lead: any): ScoringResult {
  const factors: LeadScoringFactors = {
    intentScore: calculateIntentScore(lead),
    urgencyScore: calculateUrgencyScore(lead),
    engagementScore: calculateEngagementScore(lead),
    dataQualityScore: calculateDataQualityScore(lead),
    sourceReliabilityScore: calculateSourceReliability(lead),
  }

  const finalScore = Math.min(
    100,
    factors.intentScore +
      factors.urgencyScore +
      factors.engagementScore +
      factors.dataQualityScore +
      factors.sourceReliabilityScore
  )

  const explanation = generateExplanation(finalScore, factors)

  return {
    finalScore,
    factors,
    explanation,
    scoredAt: new Date().toISOString(),
  }
}

/**
 * INTENT SCORE (0-30 points)
 * Based on enrichment confidence and motivation signals
 */
function calculateIntentScore(lead: any): number {
  let score = 0

  // Enrichment confidence (0-15 points)
  if (lead.enrichment_confidence) {
    score += Math.floor(lead.enrichment_confidence * 15)
  }

  // Motivation confidence (0-15 points)
  if (lead.motivation_confidence) {
    score += Math.floor(lead.motivation_confidence * 15)
  }

  return Math.min(30, score)
}

/**
 * URGENCY SCORE (0-25 points)
 * Based on timeline and motivation type
 */
function calculateUrgencyScore(lead: any): number {
  let score = 0

  // Timeline urgency (0-15 points)
  if (lead.timeline === 'immediate') score += 15
  else if (lead.timeline === '1-3 months') score += 12
  else if (lead.timeline === '3-6 months') score += 8
  else if (lead.timeline === '6-12 months') score += 4

  // Motivation type urgency (0-10 points)
  const highUrgencyMotivations = [
    'foreclosure',
    'divorce',
    'job_relocation',
    'financial_distress',
  ]
  
  if (lead.motivation_type && highUrgencyMotivations.includes(lead.motivation_type)) {
    score += 10
  } else if (lead.motivation_type) {
    score += 5
  }

  return Math.min(25, score)
}

/**
 * ENGAGEMENT SCORE (0-20 points)
 * Pre-contact engagement signals only
 */
function calculateEngagementScore(lead: any): number {
  let score = 0

  // Recent activity (0-10 points)
  if (lead.last_contacted_at) {
    const daysSinceContact = Math.floor(
      (Date.now() - new Date(lead.last_contacted_at).getTime()) / (1000 * 60 * 60 * 24)
    )
    
    if (daysSinceContact <= 1) score += 10
    else if (daysSinceContact <= 3) score += 7
    else if (daysSinceContact <= 7) score += 4
  }

  // Contact count (0-10 points)
  if (lead.contact_count) {
    score += Math.min(10, lead.contact_count * 2)
  }

  return Math.min(20, score)
}

/**
 * DATA QUALITY SCORE (0-15 points)
 * Completeness of contact information
 */
function calculateDataQualityScore(lead: any): number {
  let score = 0

  if (lead.email) score += 5
  if (lead.phone) score += 5
  if (lead.first_name && lead.last_name) score += 3
  if (lead.property_interest) score += 2

  return Math.min(15, score)
}

/**
 * SOURCE RELIABILITY SCORE (0-10 points)
 * Trust score based on lead source
 */
function calculateSourceReliability(lead: any): number {
  const sourceScores: Record<string, number> = {
    'batchdata': 10,
    'zenrows': 8,
    'apify': 7,
    'manual_entry': 10,
    'website_form': 9,
    'referral': 10,
    'craigslist': 5,
    'unknown': 2,
  }

  return sourceScores[lead.source] || 2
}

/**
 * GENERATE HUMAN-READABLE EXPLANATION
 */
function generateExplanation(finalScore: number, factors: LeadScoringFactors): string {
  const parts: string[] = []

  parts.push(`Final lead score: ${finalScore}/100.`)

  if (factors.intentScore >= 20) {
    parts.push('Strong intent signals detected.')
  } else if (factors.intentScore >= 10) {
    parts.push('Moderate intent signals.')
  } else {
    parts.push('Weak intent signals.')
  }

  if (factors.urgencyScore >= 15) {
    parts.push('High urgency timeline.')
  } else if (factors.urgencyScore >= 8) {
    parts.push('Moderate urgency.')
  } else {
    parts.push('Low urgency.')
  }

  if (factors.dataQualityScore >= 12) {
    parts.push('Complete contact data.')
  } else if (factors.dataQualityScore >= 8) {
    parts.push('Partial contact data.')
  } else {
    parts.push('Incomplete contact data.')
  }

  if (factors.sourceReliabilityScore >= 8) {
    parts.push('Highly reliable source.')
  } else if (factors.sourceReliabilityScore >= 5) {
    parts.push('Moderately reliable source.')
  } else {
    parts.push('Low-reliability source.')
  }

  return parts.join(' ')
}
