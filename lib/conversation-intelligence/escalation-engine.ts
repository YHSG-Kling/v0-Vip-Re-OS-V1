/**
 * System 3.4 - Escalation Signal Generator
 * Multi-factor escalation detection and routing intelligence
 */

import { SentimentAnalysis, SentimentScore } from './sentiment-engine';
import { HealthScore } from './health-scorer';

export type EscalationLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';
export type EscalationReason = 
  | 'negative_sentiment'
  | 'sentiment_degradation'
  | 'high_urgency'
  | 'unresolved_issues'
  | 'conversation_stalled'
  | 'multiple_escalation_requests'
  | 'vip_contact'
  | 'legal_compliance_risk'
  | 'health_critical'
  | 'response_delay'
  | 'frustration_detected';

export interface EscalationSignal {
  level: EscalationLevel;
  confidence: number; // 0-100
  reasons: EscalationReason[];
  priority_score: number; // 0-100
  recommended_action: string;
  recommended_assignee: 'senior_agent' | 'manager' | 'specialist' | 'auto_resolve' | null;
  urgency_multiplier: number; // 1.0 - 3.0
  metadata: {
    sentiment_score: SentimentScore;
    health_score: number;
    time_to_escalate_minutes: number;
  };
}

export interface EscalationContext {
  sentiment: SentimentAnalysis;
  health: HealthScore;
  conversation_metrics: {
    duration_minutes: number;
    message_count: number;
    unresolved_questions: number;
    escalation_keywords_count: number;
    last_response_minutes_ago: number;
    customer_frustration_level: number; // 0-100
  };
  contact_context?: {
    is_vip: boolean;
    lifetime_value: number;
    previous_escalations: number;
    satisfaction_history: number; // 0-100
  };
}

// Escalation trigger keywords
const ESCALATION_KEYWORDS = [
  'manager', 'supervisor', 'speak to someone else', 'escalate', 'complaint',
  'lawyer', 'attorney', 'legal', 'sue', 'court', 'report',
  'cancel', 'refund', 'unsubscribe', 'close account', 'terminate',
  'unacceptable', 'ridiculous', 'incompetent', 'useless', 'waste of time'
];

const URGENCY_KEYWORDS = [
  'urgent', 'emergency', 'asap', 'immediately', 'critical', 'now',
  'cant wait', 'need help now', 'right now', 'time sensitive'
];

const FRUSTRATION_KEYWORDS = [
  'frustrated', 'annoyed', 'angry', 'upset', 'disappointed',
  'multiple times', 'keep telling', 'already said', 'not listening',
  'does not work', 'still broken', 'still waiting', 'hours ago', 'days ago'
];

/**
 * Generate escalation signal from conversation context
 */
export function generateEscalationSignal(context: EscalationContext): EscalationSignal {
  const reasons: EscalationReason[] = [];
  let confidence = 0;
  let urgency_multiplier = 1.0;
  
  // Check sentiment factors
  if (context.sentiment.score === 'negative') {
    reasons.push('negative_sentiment');
    confidence += 25;
    urgency_multiplier += 0.3;
  }
  
  // Check health score
  if (context.health.status === 'critical') {
    reasons.push('health_critical');
    confidence += 30;
    urgency_multiplier += 0.5;
  }
  
  // Check urgency level
  if (context.sentiment.urgency_level > 70) {
    reasons.push('high_urgency');
    confidence += 20;
    urgency_multiplier += 0.4;
  }
  
  // Check frustration
  if (context.conversation_metrics.customer_frustration_level > 70) {
    reasons.push('frustration_detected');
    confidence += 20;
    urgency_multiplier += 0.3;
  }
  
  // Check unresolved issues
  if (context.conversation_metrics.unresolved_questions > 2) {
    reasons.push('unresolved_issues');
    confidence += 15;
  }
  
  // Check conversation stalled
  if (context.conversation_metrics.last_response_minutes_ago > 30) {
    reasons.push('conversation_stalled');
    confidence += 10;
  }
  
  // Check escalation keywords
  if (context.conversation_metrics.escalation_keywords_count > 2) {
    reasons.push('multiple_escalation_requests');
    confidence += 25;
    urgency_multiplier += 0.5;
  }
  
  // Check response delays
  if (context.conversation_metrics.last_response_minutes_ago > 15 && 
      context.sentiment.urgency_level > 50) {
    reasons.push('response_delay');
    confidence += 15;
  }
  
  // VIP contact boost
  if (context.contact_context?.is_vip) {
    reasons.push('vip_contact');
    confidence += 20;
    urgency_multiplier += 0.5;
  }
  
  // Previous escalations pattern
  if (context.contact_context && context.contact_context.previous_escalations > 2) {
    confidence += 10;
    urgency_multiplier += 0.2;
  }
  
  // Calculate escalation level
  const level = determineEscalationLevel(confidence, reasons, context);
  
  // Calculate priority score (0-100)
  const base_priority = confidence;
  const health_penalty = (100 - context.health.overall_score) * 0.3;
  const urgency_boost = context.sentiment.urgency_level * 0.2;
  const vip_boost = context.contact_context?.is_vip ? 20 : 0;
  
  const priority_score = Math.min(100, Math.round(
    base_priority + health_penalty + urgency_boost + vip_boost
  ));
  
  // Determine recommended action and assignee
  const { action, assignee } = determineRecommendedAction(level, reasons, context);
  
  // Calculate time to escalate
  const time_to_escalate_minutes = calculateTimeToEscalate(level, urgency_multiplier);
  
  return {
    level,
    confidence: Math.min(100, confidence),
    reasons,
    priority_score,
    recommended_action: action,
    recommended_assignee: assignee,
    urgency_multiplier: Math.min(3.0, urgency_multiplier),
    metadata: {
      sentiment_score: context.sentiment.score,
      health_score: context.health.overall_score,
      time_to_escalate_minutes
    }
  };
}

function determineEscalationLevel(
  confidence: number,
  reasons: EscalationReason[],
  context: EscalationContext
): EscalationLevel {
  // Critical conditions
  if (
    confidence > 80 ||
    reasons.includes('legal_compliance_risk') ||
    (reasons.includes('multiple_escalation_requests') && context.sentiment.score === 'negative') ||
    (context.health.status === 'critical' && context.sentiment.urgency_level > 70)
  ) {
    return 'critical';
  }
  
  // High escalation
  if (
    confidence > 60 ||
    reasons.includes('health_critical') ||
    (reasons.includes('negative_sentiment') && reasons.includes('high_urgency')) ||
    reasons.includes('vip_contact')
  ) {
    return 'high';
  }
  
  // Medium escalation
  if (
    confidence > 40 ||
    reasons.includes('frustration_detected') ||
    reasons.includes('unresolved_issues')
  ) {
    return 'medium';
  }
  
  // Low escalation
  if (confidence > 20 || reasons.length > 0) {
    return 'low';
  }
  
  return 'none';
}

function determineRecommendedAction(
  level: EscalationLevel,
  reasons: EscalationReason[],
  context: EscalationContext
): { action: string; assignee: EscalationSignal['recommended_assignee'] } {
  switch (level) {
    case 'critical':
      return {
        action: 'Immediate escalation required - Manager intervention needed within 5 minutes',
        assignee: 'manager'
      };
    
    case 'high':
      if (reasons.includes('vip_contact')) {
        return {
          action: 'VIP escalation - Route to senior agent with VIP handling experience',
          assignee: 'senior_agent'
        };
      }
      if (reasons.includes('legal_compliance_risk')) {
        return {
          action: 'Legal concern detected - Route to compliance specialist immediately',
          assignee: 'specialist'
        };
      }
      return {
        action: 'High priority escalation - Senior agent review required within 15 minutes',
        assignee: 'senior_agent'
      };
    
    case 'medium':
      if (reasons.includes('unresolved_issues')) {
        return {
          action: 'Multiple unresolved issues - Senior agent to review and provide resolution plan',
          assignee: 'senior_agent'
        };
      }
      return {
        action: 'Escalation recommended - Route to available senior agent for review',
        assignee: 'senior_agent'
      };
    
    case 'low':
      return {
        action: 'Monitor conversation - Consider proactive follow-up to prevent escalation',
        assignee: null
      };
    
    default:
      return {
        action: 'No escalation needed - Continue normal conversation flow',
        assignee: 'auto_resolve'
      };
  }
}

function calculateTimeToEscalate(level: EscalationLevel, urgency_multiplier: number): number {
  const base_times: Record<EscalationLevel, number> = {
    critical: 5,
    high: 15,
    medium: 30,
    low: 60,
    none: 0
  };
  
  const base_time = base_times[level];
  return Math.round(base_time / urgency_multiplier);
}

/**
 * Count escalation keywords in messages
 */
export function countEscalationKeywords(messages: string[]): {
  escalation_count: number;
  urgency_count: number;
  frustration_count: number;
  total_count: number;
} {
  const combined_text = messages.join(' ').toLowerCase();
  
  const escalation_count = ESCALATION_KEYWORDS.filter(kw => 
    combined_text.includes(kw)
  ).length;
  
  const urgency_count = URGENCY_KEYWORDS.filter(kw => 
    combined_text.includes(kw)
  ).length;
  
  const frustration_count = FRUSTRATION_KEYWORDS.filter(kw => 
    combined_text.includes(kw)
  ).length;
  
  return {
    escalation_count,
    urgency_count,
    frustration_count,
    total_count: escalation_count + urgency_count + frustration_count
  };
}

/**
 * Check if message contains explicit escalation request
 */
export function containsEscalationRequest(message: string): boolean {
  const lower = message.toLowerCase();
  return ESCALATION_KEYWORDS.some(keyword => lower.includes(keyword));
}

/**
 * Calculate customer frustration level from conversation patterns
 */
export function calculateFrustrationLevel(
  sentiment_shifts: number,
  repeated_questions: number,
  caps_usage_percent: number,
  exclamation_count: number
): number {
  let frustration = 0;
  
  // Sentiment volatility
  frustration += Math.min(30, sentiment_shifts * 5);
  
  // Repeated questions (sign of not being heard)
  frustration += Math.min(25, repeated_questions * 8);
  
  // Excessive caps usage
  if (caps_usage_percent > 30) {
    frustration += 25;
  } else if (caps_usage_percent > 15) {
    frustration += 15;
  }
  
  // Excessive exclamation marks
  frustration += Math.min(20, exclamation_count * 3);
  
  return Math.min(100, frustration);
}
