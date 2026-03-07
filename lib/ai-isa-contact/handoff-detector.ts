/**
 * AI ISA CONTACT - HANDOFF DETECTOR
 * System 3.2 Component
 * 
 * Detects when contact is ready for human agent handoff.
 * Emits structured signals but does NOT notify agents directly.
 */

import { createServiceClient } from '@/lib/supabase/service'

export interface HandoffSignal {
  shouldEscalate: boolean
  reason: string
  urgencyLevel: 'low' | 'medium' | 'high' | 'immediate'
  suggestedNextSteps: string[]
  readinessThresholdMet: boolean
}

export interface HandoffContext {
  contactId: string
  conversationMessages: number
  qualificationScore: number
  lastAgentResponseAt?: Date
  explicitAgentRequest: boolean
}

/**
 * Evaluate if contact is ready for agent handoff
 */
export async function evaluateHandoffReadiness(
  context: HandoffContext
): Promise<HandoffSignal> {
  const supabase = createServiceClient()

  // Fetch contact details
  const { data: contact } = await supabase
    .from('contacts')
    .select('intent_score, engagement_score, timeline')
    .eq('id', context.contactId)
    .single()

  let shouldEscalate = false
  let reason = ''
  let urgencyLevel: HandoffSignal['urgencyLevel'] = 'low'

  // RULE 1: Explicit agent request
  if (context.explicitAgentRequest) {
    shouldEscalate = true
    reason = 'Contact explicitly requested to speak with an agent'
    urgencyLevel = 'high'
  }

  // RULE 2: Qualification threshold met
  else if (context.qualificationScore >= 70) {
    shouldEscalate = true
    reason = 'Qualification score indicates high readiness'
    urgencyLevel = 'medium'
  }

  // RULE 3: High engagement but no agent assigned
  else if ((contact?.engagement_score || 0) >= 70 && context.conversationMessages >= 3) {
    shouldEscalate = true
    reason = 'High engagement across multiple messages'
    urgencyLevel = 'medium'
  }

  // RULE 4: Immediate timeline
  else if (contact?.timeline === 'immediate' || contact?.timeline === 'within_month') {
    shouldEscalate = true
    reason = 'Timeline indicates urgency'
    urgencyLevel = 'high'
  }

  return {
    shouldEscalate,
    reason,
    urgencyLevel,
    suggestedNextSteps: generateNextSteps(shouldEscalate),
    readinessThresholdMet: context.qualificationScore >= 60,
  }
}

/**
 * Log handoff signal (NOT a notification)
 */
export async function logHandoffSignal(
  contactId: string,
  signal: HandoffSignal
): Promise<boolean> {
  const supabase = createServiceClient()

  // Agent task (correct location, no changes) — activity_type: ai_handoff_signal
  const { error } = await supabase.from('activities').insert({
    activity_type: 'ai_handoff_signal',
    title: 'AI ISA Handoff Signal',
    description: `${signal.reason} | Urgency: ${signal.urgencyLevel}`,
    status: 'pending',
    priority: signal.urgencyLevel === 'immediate' ? 'urgent' : signal.urgencyLevel,
    contact_id: contactId,
    notes: JSON.stringify({
      shouldEscalate: signal.shouldEscalate,
      readinessThresholdMet: signal.readinessThresholdMet,
      suggestedNextSteps: signal.suggestedNextSteps,
    }),
    created_at: new Date().toISOString(),
  })

  if (error) {
    console.error('[v0] [AI ISA] Failed to log handoff signal:', error)
    return false
  }

  return true
}

/**
 * Generate suggested next steps
 */
function generateNextSteps(shouldEscalate: boolean): string[] {
  if (shouldEscalate) {
    return [
      'Agent should review conversation history',
      'Schedule discovery call within 24-48 hours',
      'Review qualification signals before outreach',
    ]
  }

  return [
    'AI ISA continues nurturing conversation',
    'Gather more qualification data',
    'Monitor for increased urgency signals',
  ]
}
