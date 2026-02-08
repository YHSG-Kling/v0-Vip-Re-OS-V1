/**
 * System 3.5 - Action Orchestration Engine
 * 
 * Core orchestrator that decides WHAT actions to take based on conversation insights.
 * Does NOT perform actions directly - returns action plans for execution engine.
 */

export type ActionType = 
  | 'SEND_MESSAGE'
  | 'SEND_EMAIL'
  | 'SEND_SMS'
  | 'INITIATE_CALL'
  | 'ASSIGN_AGENT'
  | 'CREATE_TASK'
  | 'SCHEDULE_FOLLOWUP'

export type ActionPriority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'

export interface ActionPlan {
  action_type: ActionType
  priority: ActionPriority
  target_contact_id: string
  scheduled_for: string // ISO timestamp
  metadata: {
    reason: string
    conversation_id?: string
    message_template?: string
    channel?: string
    agent_id?: string
    [key: string]: any
  }
}

export interface OrchestratorDecision {
  should_act: boolean
  actions: ActionPlan[]
  reasoning: string
  confidence: number
}

/**
 * Analyzes conversation insights and determines if action is needed
 */
export function analyzeInsightsForAction(insight: any): OrchestratorDecision {
  const actions: ActionPlan[] = []
  let reasoning = ''
  let confidence = 0

  // Parse escalation signals
  const { 
    escalation_signals = [],
    escalation_priority,
    should_escalate,
    health_score,
    sentiment_label,
    sentiment_score,
    conversation_id,
    metadata
  } = insight

  // CRITICAL ESCALATION: Immediate action required
  if (should_escalate && escalation_priority === 'CRITICAL') {
    // Plan: Notify agent immediately via multiple channels
    actions.push({
      action_type: 'SEND_MESSAGE',
      priority: 'CRITICAL',
      target_contact_id: metadata?.contact_id,
      scheduled_for: new Date().toISOString(),
      metadata: {
        reason: 'Critical escalation detected',
        conversation_id,
        message_template: 'critical_escalation_alert',
        channel: 'internal',
        signals: escalation_signals
      }
    })

    actions.push({
      action_type: 'ASSIGN_AGENT',
      priority: 'CRITICAL',
      target_contact_id: metadata?.contact_id,
      scheduled_for: new Date().toISOString(),
      metadata: {
        reason: 'Critical conversation requires human intervention',
        conversation_id,
        required_skill_level: 'senior',
        escalation_context: escalation_signals
      }
    })

    reasoning = `CRITICAL escalation detected with signals: ${escalation_signals.join(', ')}. Immediate agent assignment and notification required.`
    confidence = 95
  }

  // HIGH PRIORITY: Sentiment deterioration
  else if (sentiment_label === 'NEGATIVE' && sentiment_score < -0.6) {
    actions.push({
      action_type: 'SEND_MESSAGE',
      priority: 'HIGH',
      target_contact_id: metadata?.contact_id,
      scheduled_for: new Date(Date.now() + 5 * 60 * 1000).toISOString(), // 5 min
      metadata: {
        reason: 'Negative sentiment detected',
        conversation_id,
        message_template: 'empathy_followup',
        channel: metadata?.preferred_channel || 'sms'
      }
    })

    reasoning = `Negative sentiment (${sentiment_score}) detected. Proactive empathy follow-up recommended within 5 minutes.`
    confidence = 80
  }

  // MEDIUM PRIORITY: Health score declining
  else if (health_score < 40) {
    actions.push({
      action_type: 'SCHEDULE_FOLLOWUP',
      priority: 'MEDIUM',
      target_contact_id: metadata?.contact_id,
      scheduled_for: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours
      metadata: {
        reason: 'Low conversation health score',
        conversation_id,
        followup_type: 'check_in',
        message_template: 'health_check_followup'
      }
    })

    reasoning = `Low health score (${health_score}/100). Schedule follow-up check-in within 24 hours.`
    confidence = 70
  }

  // ISA VALIDATION FAILURE: Follow up on failed qualification
  else if (insight.isa_compliance_score < 60) {
    actions.push({
      action_type: 'SEND_EMAIL',
      priority: 'MEDIUM',
      target_contact_id: metadata?.contact_id,
      scheduled_for: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), // 2 hours
      metadata: {
        reason: 'ISA qualification incomplete or failed',
        conversation_id,
        message_template: 'isa_followup',
        isa_validation_details: insight.isa_validation_details
      }
    })

    reasoning = `ISA compliance score (${insight.isa_compliance_score}) below threshold. Follow-up email to complete qualification.`
    confidence = 75
  }

  // POSITIVE OUTCOME: Send thank you / next steps
  else if (sentiment_label === 'POSITIVE' && health_score > 80) {
    actions.push({
      action_type: 'SEND_MESSAGE',
      priority: 'LOW',
      target_contact_id: metadata?.contact_id,
      scheduled_for: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour
      metadata: {
        reason: 'Positive conversation outcome',
        conversation_id,
        message_template: 'positive_outcome_followup',
        channel: metadata?.preferred_channel || 'sms'
      }
    })

    reasoning = `Positive conversation (health: ${health_score}, sentiment: ${sentiment_label}). Send reinforcement message.`
    confidence = 85
  }

  return {
    should_act: actions.length > 0,
    actions,
    reasoning,
    confidence
  }
}

/**
 * Prioritize actions based on urgency and business rules
 */
export function prioritizeActions(actions: ActionPlan[]): ActionPlan[] {
  const priorityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }
  
  return actions.sort((a, b) => {
    // First by priority
    const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority]
    if (priorityDiff !== 0) return priorityDiff
    
    // Then by scheduled time (earlier first)
    return new Date(a.scheduled_for).getTime() - new Date(b.scheduled_for).getTime()
  })
}

/**
 * Check if action is due for execution
 */
export function isActionDue(action: ActionPlan): boolean {
  const scheduledTime = new Date(action.scheduled_for).getTime()
  const now = Date.now()
  
  return scheduledTime <= now
}

/**
 * Batch orchestrate multiple insights
 */
export function batchOrchestrate(insights: any[]): Map<string, OrchestratorDecision> {
  const decisions = new Map<string, OrchestratorDecision>()
  
  for (const insight of insights) {
    const decision = analyzeInsightsForAction(insight)
    if (decision.should_act) {
      decisions.set(insight.conversation_id, decision)
    }
  }
  
  return decisions
}

/**
 * Determine optimal communication channel based on context
 */
export function selectOptimalChannel(
  contact: any,
  actionType: ActionType,
  priority: ActionPriority
): string {
  // CRITICAL priority: Use fastest available channel
  if (priority === 'CRITICAL') {
    if (contact.phone) return 'sms'
    if (contact.email) return 'email'
    return 'internal_notification'
  }
  
  // Respect contact preferences
  const preferredChannel = contact.preferences?.communication_channel
  if (preferredChannel && actionType === 'SEND_MESSAGE') {
    return preferredChannel
  }
  
  // Default channel selection based on action type
  const channelMap: Record<ActionType, string> = {
    SEND_MESSAGE: contact.phone ? 'sms' : 'email',
    SEND_EMAIL: 'email',
    SEND_SMS: 'sms',
    INITIATE_CALL: 'voice',
    ASSIGN_AGENT: 'internal',
    CREATE_TASK: 'internal',
    SCHEDULE_FOLLOWUP: contact.phone ? 'sms' : 'email'
  }
  
  return channelMap[actionType] || 'email'
}

/**
 * Validate action plan before execution
 */
export function validateActionPlan(action: ActionPlan, contact: any): {
  valid: boolean
  errors: string[]
} {
  const errors: string[] = []
  
  // Check contact has required contact info
  if (action.action_type === 'SEND_EMAIL' && !contact.email) {
    errors.push('Contact has no email address')
  }
  
  if ((action.action_type === 'SEND_SMS' || action.action_type === 'INITIATE_CALL') && !contact.phone) {
    errors.push('Contact has no phone number')
  }
  
  // Check scheduled time is valid
  const scheduledTime = new Date(action.scheduled_for).getTime()
  if (isNaN(scheduledTime)) {
    errors.push('Invalid scheduled_for timestamp')
  }
  
  // Check required metadata
  if (!action.metadata.reason) {
    errors.push('Missing action reason in metadata')
  }
  
  return {
    valid: errors.length === 0,
    errors
  }
}
