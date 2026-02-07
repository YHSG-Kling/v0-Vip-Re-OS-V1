/**
 * System 3.4 - Conversation Health Scoring System
 * Multi-factor health assessment for conversation quality and engagement
 */

import { SentimentScore } from './sentiment-engine';

export type HealthStatus = 'healthy' | 'at_risk' | 'critical' | 'excellent';

export interface HealthScore {
  overall_score: number; // 0-100
  status: HealthStatus;
  factors: {
    sentiment_health: number; // 0-100
    engagement_health: number; // 0-100
    resolution_health: number; // 0-100
    response_health: number; // 0-100
    momentum_health: number; // 0-100
  };
  warnings: string[];
  recommendations: string[];
}

export interface ConversationMetrics {
  total_messages: number;
  customer_messages: number;
  agent_messages: number;
  avg_response_time_seconds: number;
  sentiment: SentimentScore;
  sentiment_shifts: number;
  urgency_level: number;
  unresolved_questions: number;
  duration_minutes: number;
  last_message_age_minutes: number;
}

/**
 * Calculate conversation health score
 */
export function calculateHealthScore(metrics: ConversationMetrics): HealthScore {
  const warnings: string[] = [];
  const recommendations: string[] = [];
  
  // 1. Sentiment Health (25% weight)
  const sentiment_health = calculateSentimentHealth(
    metrics.sentiment,
    metrics.sentiment_shifts,
    warnings,
    recommendations
  );
  
  // 2. Engagement Health (20% weight)
  const engagement_health = calculateEngagementHealth(
    metrics.customer_messages,
    metrics.agent_messages,
    metrics.total_messages,
    warnings,
    recommendations
  );
  
  // 3. Resolution Health (25% weight)
  const resolution_health = calculateResolutionHealth(
    metrics.unresolved_questions,
    metrics.sentiment,
    metrics.duration_minutes,
    warnings,
    recommendations
  );
  
  // 4. Response Health (20% weight)
  const response_health = calculateResponseHealth(
    metrics.avg_response_time_seconds,
    metrics.urgency_level,
    metrics.last_message_age_minutes,
    warnings,
    recommendations
  );
  
  // 5. Momentum Health (10% weight)
  const momentum_health = calculateMomentumHealth(
    metrics.last_message_age_minutes,
    metrics.total_messages,
    metrics.duration_minutes,
    warnings,
    recommendations
  );
  
  // Calculate weighted overall score
  const overall_score = Math.round(
    sentiment_health * 0.25 +
    engagement_health * 0.20 +
    resolution_health * 0.25 +
    response_health * 0.20 +
    momentum_health * 0.10
  );
  
  // Determine status
  let status: HealthStatus;
  if (overall_score >= 85) {
    status = 'excellent';
  } else if (overall_score >= 70) {
    status = 'healthy';
  } else if (overall_score >= 50) {
    status = 'at_risk';
  } else {
    status = 'critical';
  }
  
  return {
    overall_score,
    status,
    factors: {
      sentiment_health,
      engagement_health,
      resolution_health,
      response_health,
      momentum_health
    },
    warnings,
    recommendations
  };
}

function calculateSentimentHealth(
  sentiment: SentimentScore,
  sentiment_shifts: number,
  warnings: string[],
  recommendations: string[]
): number {
  let score = 50;
  
  // Base sentiment score
  switch (sentiment) {
    case 'positive':
      score = 90;
      break;
    case 'neutral':
      score = 70;
      break;
    case 'mixed':
      score = 50;
      warnings.push('Mixed sentiment detected - conversation may need clarification');
      recommendations.push('Acknowledge concerns and provide clear next steps');
      break;
    case 'negative':
      score = 20;
      warnings.push('Negative sentiment detected - immediate attention required');
      recommendations.push('Escalate to senior agent or provide immediate resolution');
      break;
  }
  
  // Penalty for frequent sentiment shifts (volatility)
  if (sentiment_shifts > 5) {
    score -= 20;
    warnings.push('High sentiment volatility - customer may be confused or frustrated');
    recommendations.push('Provide consistent messaging and clear communication');
  } else if (sentiment_shifts > 3) {
    score -= 10;
  }
  
  return Math.max(0, Math.min(100, score));
}

function calculateEngagementHealth(
  customer_messages: number,
  agent_messages: number,
  total_messages: number,
  warnings: string[],
  recommendations: string[]
): number {
  if (total_messages === 0) return 50;
  
  const customer_ratio = customer_messages / total_messages;
  const agent_ratio = agent_messages / total_messages;
  
  let score = 70;
  
  // Ideal ratio: 40-60% customer messages
  if (customer_ratio >= 0.4 && customer_ratio <= 0.6) {
    score = 90;
  } else if (customer_ratio < 0.3) {
    // Customer not engaging enough
    score = 50;
    warnings.push('Low customer engagement - conversation may be one-sided');
    recommendations.push('Ask open-ended questions to encourage customer participation');
  } else if (customer_ratio > 0.7) {
    // Customer talking too much, possibly frustrated
    score = 40;
    warnings.push('Customer dominating conversation - may indicate frustration');
    recommendations.push('Actively listen and provide concise, actionable responses');
  }
  
  // Bonus for healthy back-and-forth
  if (total_messages >= 4 && total_messages <= 20) {
    score += 10;
  } else if (total_messages > 30) {
    score -= 10;
    warnings.push('Lengthy conversation - efficiency may be low');
    recommendations.push('Summarize discussion and work toward resolution');
  }
  
  return Math.max(0, Math.min(100, score));
}

function calculateResolutionHealth(
  unresolved_questions: number,
  sentiment: SentimentScore,
  duration_minutes: number,
  warnings: string[],
  recommendations: string[]
): number {
  let score = 80;
  
  // Penalty for unresolved questions
  if (unresolved_questions > 3) {
    score = 30;
    warnings.push(`${unresolved_questions} unresolved questions - customer needs may not be met`);
    recommendations.push('Address all outstanding questions before closing conversation');
  } else if (unresolved_questions > 1) {
    score = 60;
    recommendations.push('Follow up on pending questions to improve resolution');
  } else if (unresolved_questions === 0) {
    score = 95;
  }
  
  // Consider sentiment in resolution context
  if (unresolved_questions > 0 && sentiment === 'negative') {
    score -= 20;
    warnings.push('Unresolved issues with negative sentiment - high escalation risk');
  }
  
  // Duration factor
  if (duration_minutes > 60 && unresolved_questions > 0) {
    score -= 10;
    warnings.push('Long duration with unresolved questions - resolution efficiency is low');
  }
  
  return Math.max(0, Math.min(100, score));
}

function calculateResponseHealth(
  avg_response_time_seconds: number,
  urgency_level: number,
  last_message_age_minutes: number,
  warnings: string[],
  recommendations: string[]
): number {
  let score = 70;
  
  // Ideal response time: < 60 seconds
  if (avg_response_time_seconds <= 30) {
    score = 95;
  } else if (avg_response_time_seconds <= 60) {
    score = 85;
  } else if (avg_response_time_seconds <= 120) {
    score = 70;
  } else if (avg_response_time_seconds <= 300) {
    score = 50;
    recommendations.push('Improve response times to maintain engagement');
  } else {
    score = 30;
    warnings.push('Slow response times - customer may feel neglected');
    recommendations.push('Prioritize faster responses, especially for urgent issues');
  }
  
  // Adjust for urgency
  if (urgency_level > 70 && avg_response_time_seconds > 60) {
    score -= 20;
    warnings.push('High urgency with slow responses - immediate action needed');
  }
  
  // Check last message age
  if (last_message_age_minutes > 30) {
    score -= 20;
    warnings.push('Conversation stalled - customer may be waiting for response');
    recommendations.push('Re-engage immediately to prevent abandonment');
  } else if (last_message_age_minutes > 15) {
    score -= 10;
  }
  
  return Math.max(0, Math.min(100, score));
}

function calculateMomentumHealth(
  last_message_age_minutes: number,
  total_messages: number,
  duration_minutes: number,
  warnings: string[],
  recommendations: string[]
): number {
  let score = 70;
  
  // Check for stalled conversation
  if (last_message_age_minutes > 60) {
    score = 20;
    warnings.push('Conversation abandoned - follow-up required');
    recommendations.push('Send proactive follow-up message to re-engage');
  } else if (last_message_age_minutes > 30) {
    score = 40;
    warnings.push('Conversation losing momentum');
    recommendations.push('Re-engage to maintain conversation flow');
  } else if (last_message_age_minutes <= 5) {
    score = 90;
  }
  
  // Message frequency (messages per minute)
  if (duration_minutes > 0) {
    const messages_per_minute = total_messages / duration_minutes;
    
    // Ideal: 0.5-2 messages per minute
    if (messages_per_minute >= 0.5 && messages_per_minute <= 2) {
      score = Math.min(100, score + 10);
    } else if (messages_per_minute < 0.2) {
      score -= 10;
      recommendations.push('Maintain conversation pace to keep customer engaged');
    } else if (messages_per_minute > 3) {
      score -= 5;
      // Too fast might indicate confusion or frustration
    }
  }
  
  return Math.max(0, Math.min(100, score));
}

/**
 * Get health status color for UI
 */
export function getHealthStatusColor(status: HealthStatus): string {
  switch (status) {
    case 'excellent':
      return 'green';
    case 'healthy':
      return 'blue';
    case 'at_risk':
      return 'yellow';
    case 'critical':
      return 'red';
  }
}

/**
 * Determine if conversation requires immediate attention
 */
export function requiresImmediateAttention(health: HealthScore): boolean {
  return (
    health.status === 'critical' ||
    health.overall_score < 40 ||
    health.warnings.some(w => 
      w.includes('immediate') || 
      w.includes('abandoned') || 
      w.includes('negative sentiment')
    )
  );
}
