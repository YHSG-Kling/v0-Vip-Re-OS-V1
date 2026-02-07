/**
 * System 3.4 - Voice-Aware Conversation Intelligence
 * Enriches text analysis with voice-specific signals (tone, pacing, interruptions)
 */

import { SentimentAnalysis } from './sentiment-engine';

export type VoiceTone = 'calm' | 'excited' | 'agitated' | 'monotone' | 'enthusiastic' | 'hesitant';
export type SpeechPace = 'very_slow' | 'slow' | 'normal' | 'fast' | 'very_fast';
export type VoiceQuality = 'clear' | 'muffled' | 'noisy' | 'distorted';

export interface VoiceMetrics {
  tone: VoiceTone;
  pace: SpeechPace;
  volume_level: number; // 0-100
  pitch_variance: number; // 0-100 (monotone = low, expressive = high)
  silence_duration_seconds: number;
  interruption_count: number;
  filler_word_count: number; // "um", "uh", "like", etc.
  speech_clarity: VoiceQuality;
  emotion_intensity: number; // 0-100
}

export interface VoiceEnrichedAnalysis {
  sentiment: SentimentAnalysis;
  voice_metrics: VoiceMetrics;
  voice_sentiment_alignment: number; // 0-100 (how well voice matches text sentiment)
  engagement_score: number; // 0-100
  stress_indicators: string[];
  confidence_indicators: string[];
  authenticity_score: number; // 0-100 (are they being genuine?)
  recommended_response_style: 'empathetic' | 'professional' | 'enthusiastic' | 'direct' | 'supportive';
}

export interface VoiceTranscript {
  text: string;
  speaker: 'customer' | 'agent';
  timestamp_seconds: number;
  duration_seconds: number;
  audio_metadata?: {
    tone?: string;
    energy?: string;
    pace?: string;
  };
}

/**
 * Enrich text sentiment with voice-specific signals
 */
export function enrichWithVoiceIntelligence(
  transcript: string,
  voice_metrics?: Partial<VoiceMetrics>,
  sentiment?: SentimentAnalysis
): VoiceEnrichedAnalysis {
  // Use default sentiment if not provided
  const text_sentiment = sentiment || {
    score: 'neutral' as const,
    confidence: 50,
    emotion: 'neutral' as const,
    tone: 'casual' as const,
    urgency_level: 30,
    key_phrases: [],
    sentiment_shifts: 0
  };
  
  // Extract voice metrics from transcript if not provided
  const extracted_metrics = voice_metrics || extractVoiceMetricsFromText(transcript);
  
  // Calculate voice-sentiment alignment
  const voice_sentiment_alignment = calculateVoiceSentimentAlignment(
    text_sentiment,
    extracted_metrics
  );
  
  // Calculate engagement score
  const engagement_score = calculateEngagementScore(
    transcript,
    extracted_metrics
  );
  
  // Detect stress indicators
  const stress_indicators = detectStressIndicators(
    transcript,
    extracted_metrics
  );
  
  // Detect confidence indicators
  const confidence_indicators = detectConfidenceIndicators(
    transcript,
    extracted_metrics
  );
  
  // Calculate authenticity score
  const authenticity_score = calculateAuthenticityScore(
    text_sentiment,
    extracted_metrics,
    voice_sentiment_alignment
  );
  
  // Recommend response style
  const recommended_response_style = recommendResponseStyle(
    text_sentiment,
    extracted_metrics,
    stress_indicators.length
  );
  
  return {
    sentiment: text_sentiment,
    voice_metrics: extracted_metrics,
    voice_sentiment_alignment,
    engagement_score,
    stress_indicators,
    confidence_indicators,
    authenticity_score,
    recommended_response_style
  };
}

/**
 * Extract voice metrics from transcript text patterns
 */
function extractVoiceMetricsFromText(transcript: string): VoiceMetrics {
  const lower = transcript.toLowerCase();
  const words = transcript.split(/\s+/);
  
  // Count filler words
  const filler_words = ['um', 'uh', 'like', 'you know', 'i mean', 'sort of', 'kind of', 'actually', 'basically'];
  const filler_word_count = filler_words.filter(fw => lower.includes(fw)).length;
  
  // Detect interruptions (dashes, ellipsis)
  const interruption_count = (transcript.match(/--|\.{3}|\[interrupt\]/gi) || []).length;
  
  // Estimate pace from word count and sentence structure
  const avg_words_per_sentence = words.length / (transcript.split(/[.!?]+/).length || 1);
  let pace: SpeechPace = 'normal';
  if (avg_words_per_sentence > 25) {
    pace = 'very_fast';
  } else if (avg_words_per_sentence > 18) {
    pace = 'fast';
  } else if (avg_words_per_sentence < 8) {
    pace = 'slow';
  } else if (avg_words_per_sentence < 5) {
    pace = 'very_slow';
  }
  
  // Estimate tone from language patterns
  let tone: VoiceTone = 'calm';
  const exclamation_count = (transcript.match(/!/g) || []).length;
  const question_count = (transcript.match(/\?/g) || []).length;
  const caps_words = words.filter(w => w === w.toUpperCase() && w.length > 2).length;
  
  if (exclamation_count > 3 || caps_words > 3) {
    tone = 'agitated';
  } else if (exclamation_count > 1) {
    tone = 'excited';
  } else if (filler_word_count > 5) {
    tone = 'hesitant';
  } else if (question_count > 5) {
    tone = 'hesitant';
  }
  
  // Estimate other metrics
  const volume_level = caps_words > 2 ? 80 : 50;
  const pitch_variance = exclamation_count > 2 ? 70 : 40;
  const emotion_intensity = Math.min(100, (exclamation_count * 15) + (caps_words * 10));
  
  return {
    tone,
    pace,
    volume_level,
    pitch_variance,
    silence_duration_seconds: 0, // Cannot detect from text
    interruption_count,
    filler_word_count,
    speech_clarity: 'clear',
    emotion_intensity
  };
}

/**
 * Calculate alignment between voice tone and text sentiment
 */
function calculateVoiceSentimentAlignment(
  sentiment: SentimentAnalysis,
  voice: VoiceMetrics
): number {
  let alignment = 70; // Start with neutral alignment
  
  // Check if voice tone matches sentiment
  if (sentiment.score === 'positive') {
    if (voice.tone === 'excited' || voice.tone === 'enthusiastic' || voice.tone === 'calm') {
      alignment = 90;
    } else if (voice.tone === 'agitated' || voice.tone === 'monotone') {
      alignment = 40; // Misalignment
    }
  } else if (sentiment.score === 'negative') {
    if (voice.tone === 'agitated' || voice.tone === 'monotone') {
      alignment = 85;
    } else if (voice.tone === 'excited' || voice.tone === 'enthusiastic') {
      alignment = 30; // Strong misalignment
    }
  }
  
  // Check emotion intensity alignment
  if (sentiment.urgency_level > 70 && voice.emotion_intensity < 40) {
    alignment -= 20; // High urgency but flat delivery
  }
  
  if (sentiment.urgency_level < 30 && voice.emotion_intensity > 70) {
    alignment -= 15; // Low urgency but intense delivery
  }
  
  return Math.max(0, Math.min(100, alignment));
}

/**
 * Calculate customer engagement score based on voice patterns
 */
function calculateEngagementScore(
  transcript: string,
  voice: VoiceMetrics
): number {
  let score = 60;
  
  // Active participation indicators
  const word_count = transcript.split(/\s+/).length;
  if (word_count > 100) {
    score += 20; // Engaged in conversation
  } else if (word_count < 20) {
    score -= 20; // Minimal engagement
  }
  
  // Pace indicators
  if (voice.pace === 'normal' || voice.pace === 'fast') {
    score += 10; // Active conversation
  } else if (voice.pace === 'very_slow') {
    score -= 15; // Disengaged or hesitant
  }
  
  // Emotion intensity
  if (voice.emotion_intensity > 50) {
    score += 10; // Emotionally engaged
  } else if (voice.emotion_intensity < 20) {
    score -= 10; // Flat/disengaged
  }
  
  // Filler words (moderate amount shows thinking/processing)
  if (voice.filler_word_count > 10) {
    score -= 15; // Too many fillers = uncertainty
  } else if (voice.filler_word_count >= 3 && voice.filler_word_count <= 6) {
    score += 5; // Natural thinking/processing
  }
  
  // Interruptions (can show engagement or frustration)
  if (voice.interruption_count > 5) {
    score -= 10; // Too many interruptions = frustration
  } else if (voice.interruption_count >= 2 && voice.interruption_count <= 4) {
    score += 5; // Active back-and-forth
  }
  
  return Math.max(0, Math.min(100, score));
}

/**
 * Detect stress indicators in voice patterns
 */
function detectStressIndicators(
  transcript: string,
  voice: VoiceMetrics
): string[] {
  const indicators: string[] = [];
  
  if (voice.pace === 'very_fast') {
    indicators.push('Rapid speech - may indicate stress or urgency');
  }
  
  if (voice.filler_word_count > 8) {
    indicators.push('Excessive filler words - may indicate uncertainty or stress');
  }
  
  if (voice.interruption_count > 5) {
    indicators.push('Frequent interruptions - may indicate frustration or impatience');
  }
  
  if (voice.tone === 'agitated') {
    indicators.push('Agitated tone detected - customer may be stressed or upset');
  }
  
  if (voice.volume_level > 70) {
    indicators.push('Elevated voice volume - may indicate frustration');
  }
  
  const stress_words = ['stressed', 'frustrated', 'confused', 'overwhelmed', 'anxious', 'worried'];
  if (stress_words.some(sw => transcript.toLowerCase().includes(sw))) {
    indicators.push('Explicit stress language detected in conversation');
  }
  
  return indicators;
}

/**
 * Detect confidence indicators in voice patterns
 */
function detectConfidenceIndicators(
  transcript: string,
  voice: VoiceMetrics
): string[] {
  const indicators: string[] = [];
  
  if (voice.tone === 'calm' || voice.tone === 'enthusiastic') {
    indicators.push('Confident tone detected');
  }
  
  if (voice.pace === 'normal' || voice.pace === 'fast') {
    indicators.push('Steady speech pace indicates confidence');
  }
  
  if (voice.filler_word_count < 3) {
    indicators.push('Minimal filler words - clear and confident communication');
  }
  
  if (voice.pitch_variance > 50) {
    indicators.push('Expressive speech - engaged and confident');
  }
  
  const confidence_words = ['definitely', 'absolutely', 'certain', 'sure', 'confident', 'ready', 'excited'];
  if (confidence_words.some(cw => transcript.toLowerCase().includes(cw))) {
    indicators.push('Explicit confidence language used');
  }
  
  return indicators;
}

/**
 * Calculate authenticity score (are they being genuine?)
 */
function calculateAuthenticityScore(
  sentiment: SentimentAnalysis,
  voice: VoiceMetrics,
  alignment: number
): number {
  let authenticity = alignment; // Start with voice-sentiment alignment
  
  // Monotone with positive words = potentially fake enthusiasm
  if (sentiment.score === 'positive' && voice.tone === 'monotone') {
    authenticity -= 30;
  }
  
  // Hesitant with strong commitment = uncertain
  if (voice.tone === 'hesitant' && voice.filler_word_count > 6) {
    authenticity -= 15;
  }
  
  // Natural emotion variance is authentic
  if (voice.pitch_variance > 40 && voice.pitch_variance < 80) {
    authenticity += 10;
  }
  
  return Math.max(0, Math.min(100, authenticity));
}

/**
 * Recommend response style based on voice analysis
 */
function recommendResponseStyle(
  sentiment: SentimentAnalysis,
  voice: VoiceMetrics,
  stress_indicator_count: number
): 'empathetic' | 'professional' | 'enthusiastic' | 'direct' | 'supportive' {
  // High stress = empathetic response
  if (stress_indicator_count > 2 || voice.tone === 'agitated') {
    return 'empathetic';
  }
  
  // Excited customer = match enthusiasm
  if (voice.tone === 'excited' || voice.tone === 'enthusiastic') {
    return 'enthusiastic';
  }
  
  // Hesitant = supportive
  if (voice.tone === 'hesitant' || voice.filler_word_count > 5) {
    return 'supportive';
  }
  
  // Fast-paced = direct and efficient
  if (voice.pace === 'very_fast' || voice.pace === 'fast') {
    return 'direct';
  }
  
  // Default = professional
  return 'professional';
}

/**
 * Analyze conversation from voice transcript array
 */
export function analyzeVoiceConversation(
  transcripts: VoiceTranscript[]
): {
  customer_voice_analysis: VoiceEnrichedAnalysis | null;
  agent_voice_analysis: VoiceEnrichedAnalysis | null;
  conversation_dynamics: {
    turn_taking_balance: number; // 0-100 (50 = balanced)
    interruption_rate: number;
    energy_matching: number; // 0-100 (agent matches customer energy)
    rapport_score: number; // 0-100
  };
} {
  const customer_transcripts = transcripts.filter(t => t.speaker === 'customer');
  const agent_transcripts = transcripts.filter(t => t.speaker === 'agent');
  
  const customer_text = customer_transcripts.map(t => t.text).join(' ');
  const agent_text = agent_transcripts.map(t => t.text).join(' ');
  
  const customer_voice_analysis = customer_text ? enrichWithVoiceIntelligence(customer_text) : null;
  const agent_voice_analysis = agent_text ? enrichWithVoiceIntelligence(agent_text) : null;
  
  // Calculate conversation dynamics
  const total_turns = transcripts.length;
  const customer_turns = customer_transcripts.length;
  const turn_taking_balance = total_turns > 0 ? (customer_turns / total_turns) * 100 : 50;
  
  const total_interruptions = (customer_voice_analysis?.voice_metrics.interruption_count || 0) +
                              (agent_voice_analysis?.voice_metrics.interruption_count || 0);
  const interruption_rate = total_interruptions / total_turns;
  
  // Energy matching (agent tone matches customer)
  let energy_matching = 50;
  if (customer_voice_analysis && agent_voice_analysis) {
    const customer_energy = customer_voice_analysis.voice_metrics.emotion_intensity;
    const agent_energy = agent_voice_analysis.voice_metrics.emotion_intensity;
    const energy_diff = Math.abs(customer_energy - agent_energy);
    energy_matching = Math.max(0, 100 - energy_diff);
  }
  
  // Rapport score
  const rapport_score = calculateRapportScore(
    turn_taking_balance,
    interruption_rate,
    energy_matching,
    customer_voice_analysis,
    agent_voice_analysis
  );
  
  return {
    customer_voice_analysis,
    agent_voice_analysis,
    conversation_dynamics: {
      turn_taking_balance,
      interruption_rate,
      energy_matching,
      rapport_score
    }
  };
}

function calculateRapportScore(
  turn_balance: number,
  interruption_rate: number,
  energy_matching: number,
  customer_analysis: VoiceEnrichedAnalysis | null,
  agent_analysis: VoiceEnrichedAnalysis | null
): number {
  let score = 60;
  
  // Balanced turn-taking
  if (turn_balance >= 40 && turn_balance <= 60) {
    score += 15;
  } else {
    score -= 10;
  }
  
  // Low interruption rate
  if (interruption_rate < 0.2) {
    score += 15;
  } else if (interruption_rate > 0.5) {
    score -= 20;
  }
  
  // Energy matching
  score += (energy_matching * 0.1);
  
  // Customer engagement
  if (customer_analysis && customer_analysis.engagement_score > 60) {
    score += 10;
  }
  
  return Math.max(0, Math.min(100, Math.round(score)));
}
