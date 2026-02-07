/**
 * System 3.4 - Conversation Intelligence & Escalation Signal Engine
 * Export all conversation intelligence modules
 */

// Sentiment Analysis Engine
export {
  analyzeMessageSentiment,
  analyzeConversationSentiment,
  detectSentimentDegradation,
  type SentimentScore,
  type EmotionType,
  type ToneIndicator,
  type SentimentAnalysis
} from './sentiment-engine'

// Conversation Health Scoring
export {
  calculateHealthScore,
  getHealthStatusColor,
  requiresImmediateAttention,
  type HealthStatus,
  type HealthScore,
  type ConversationMetrics
} from './health-scorer'

// Escalation Signal Generator
export {
  generateEscalationSignal,
  countEscalationKeywords,
  containsEscalationRequest,
  calculateFrustrationLevel,
  type EscalationLevel,
  type EscalationReason,
  type EscalationSignal,
  type EscalationContext
} from './escalation-engine'

// AI ISA Validator
export {
  validateISAConversation,
  type ISAOutcome,
  type ISAConfidenceLevel,
  type ISAValidationResult,
  type ISAIssue,
  type ISATranscript,
  type ISAConversationAnalysis
} from './isa-validator'

// Voice Intelligence
export {
  enrichWithVoiceIntelligence,
  analyzeVoiceConversation,
  type VoiceTone,
  type SpeechPace,
  type VoiceQuality,
  type VoiceMetrics,
  type VoiceEnrichedAnalysis,
  type VoiceTranscript
} from './voice-intelligence'
