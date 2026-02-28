/**
 * AI ISA CONTACT - QUALIFICATION ENGINE
 * System 3.2 Component
 * 
 * Extracts qualification signals from contact conversations.
 * Persists structured data to activities table.
 */

import { createServiceClient } from '@/lib/supabase/service'

export interface QualificationSignals {
  buyerSeller: 'buyer' | 'seller' | 'both' | 'unknown'
  urgency: 'immediate' | 'within_month' | 'within_quarter' | 'exploring' | 'unknown'
  financingStatus: 'preapproved' | 'needs_preapproval' | 'cash' | 'unknown'
  priceRange?: { min?: number; max?: number }
  locations?: string[]
  motivations?: string[]
  readinessScore: number // 0-100
  confidence: number // 0-1
}

export interface ExtractSignalsParams {
  contactId: string
  messageContent: string
  conversationHistory: string[]
}

/**
 * Extract qualification signals from conversation
 */
export async function extractQualificationSignals(
  params: ExtractSignalsParams
): Promise<QualificationSignals> {
  // In production, this would use AI SDK to extract structured data
  // For now, using simple keyword detection
  
  const allText = [params.messageContent, ...params.conversationHistory].join(' ').toLowerCase()

  // Detect buyer/seller intent
  const buyerKeywords = ['buy', 'looking for', 'searching for', 'house hunt']
  const sellerKeywords = ['sell', 'list', 'selling my', 'market my home']
  
  const isBuyer = buyerKeywords.some(kw => allText.includes(kw))
  const isSeller = sellerKeywords.some(kw => allText.includes(kw))
  
  let buyerSeller: QualificationSignals['buyerSeller'] = 'unknown'
  if (isBuyer && isSeller) buyerSeller = 'both'
  else if (isBuyer) buyerSeller = 'buyer'
  else if (isSeller) buyerSeller = 'seller'

  // Detect urgency
  const urgencyKeywords = {
    immediate: ['asap', 'urgent', 'right away', 'immediately', 'this week'],
    within_month: ['within month', 'next month', 'soon', '30 days'],
    within_quarter: ['few months', 'this year', 'by summer', 'by fall'],
    exploring: ['just looking', 'exploring', 'researching', 'thinking about'],
  }

  let urgency: QualificationSignals['urgency'] = 'unknown'
  for (const [level, keywords] of Object.entries(urgencyKeywords)) {
    if (keywords.some(kw => allText.includes(kw))) {
      urgency = level as QualificationSignals['urgency']
      break
    }
  }

  // Calculate readiness score
  let readinessScore = 0
  if (buyerSeller !== 'unknown') readinessScore += 25
  if (urgency === 'immediate') readinessScore += 40
  else if (urgency === 'within_month') readinessScore += 30
  else if (urgency === 'within_quarter') readinessScore += 20
  
  return {
    buyerSeller,
    urgency,
    financingStatus: 'unknown',
    readinessScore,
    confidence: 0.7,
  }
}

/**
 * Persist qualification signals to activities
 */
export async function persistQualificationSignals(
  contactId: string,
  signals: QualificationSignals
): Promise<boolean> {
  const supabase = createServiceClient()

  // Agent task (correct location, no changes) — activity_type: ai_qualification_update
  const { error } = await supabase.from('activities').insert({
    activity_type: 'ai_qualification_update',
    title: 'AI ISA Qualification Update',
    description: `Qualification signals updated: ${signals.buyerSeller} | ${signals.urgency} | Readiness: ${signals.readinessScore}%`,
    status: 'completed',
    priority: 'normal',
    contact_id: contactId,
    notes: JSON.stringify(signals),
    created_at: new Date().toISOString(),
  })

  if (error) {
    console.error('[AI ISA Contact] Failed to persist qualification signals:', error)
    return false
  }

  return true
}
