/**
 * System 3.4 - Sentiment Analysis Engine
 * Multi-layered sentiment detection with tone, emotion, and urgency analysis
 */

export type SentimentScore = 'positive' | 'neutral' | 'negative' | 'mixed';
export type EmotionType = 'joy' | 'trust' | 'fear' | 'surprise' | 'sadness' | 'disgust' | 'anger' | 'anticipation' | 'neutral';
export type ToneIndicator = 'professional' | 'casual' | 'frustrated' | 'urgent' | 'friendly' | 'formal' | 'confused' | 'assertive';

export interface SentimentAnalysis {
  score: SentimentScore;
  confidence: number; // 0-100
  emotion: EmotionType;
  tone: ToneIndicator;
  urgency_level: number; // 0-100
  key_phrases: string[];
  sentiment_shifts: number; // Number of sentiment changes in conversation
}

// Sentiment word lists
const POSITIVE_WORDS = [
  'great', 'excellent', 'amazing', 'wonderful', 'fantastic', 'love', 'perfect', 
  'happy', 'satisfied', 'pleased', 'delighted', 'appreciate', 'thank', 'thanks',
  'awesome', 'brilliant', 'superb', 'outstanding', 'exceptional', 'impressed',
  'helpful', 'useful', 'effective', 'smooth', 'easy', 'convenient'
];

const NEGATIVE_WORDS = [
  'bad', 'terrible', 'awful', 'horrible', 'poor', 'disappointed', 'frustrated',
  'angry', 'upset', 'unhappy', 'dissatisfied', 'hate', 'worst', 'useless',
  'confusing', 'complicated', 'difficult', 'broken', 'failed', 'error',
  'problem', 'issue', 'concern', 'complaint', 'unacceptable', 'ridiculous'
];

const URGENCY_WORDS = [
  'urgent', 'asap', 'immediately', 'emergency', 'critical', 'now', 'today',
  'quickly', 'hurry', 'rush', 'priority', 'important', 'deadline', 'must',
  'need', 'required', 'necessary', 'waiting', 'delay', 'overdue'
];

const FRUSTRATION_WORDS = [
  'frustrated', 'annoyed', 'irritated', 'confused', 'lost', 'stuck',
  'keep', 'still', 'again', 'repeated', 'multiple times', 'several times',
  'why', 'how come', 'doesnt work', 'not working', 'broken'
];

const PROFESSIONAL_WORDS = [
  'please', 'kindly', 'appreciate', 'thank you', 'regards', 'sincerely',
  'respectfully', 'understand', 'clarify', 'confirm', 'review'
];

/**
 * Analyze sentiment of a message
 */
export function analyzeMessageSentiment(message: string): SentimentAnalysis {
  const lowerMessage = message.toLowerCase();
  const words = lowerMessage.split(/\s+/);
  
  // Count sentiment indicators
  let positiveCount = 0;
  let negativeCount = 0;
  let urgencyCount = 0;
  let frustrationCount = 0;
  let professionalCount = 0;
  
  const keyPhrases: string[] = [];
  
  // Analyze words and phrases
  words.forEach((word, index) => {
    if (POSITIVE_WORDS.some(pw => word.includes(pw))) {
      positiveCount++;
      if (!keyPhrases.includes(word)) keyPhrases.push(word);
    }
    if (NEGATIVE_WORDS.some(nw => word.includes(nw))) {
      negativeCount++;
      if (!keyPhrases.includes(word)) keyPhrases.push(word);
    }
    if (URGENCY_WORDS.some(uw => word.includes(uw))) {
      urgencyCount++;
      if (!keyPhrases.includes(word)) keyPhrases.push(word);
    }
    if (FRUSTRATION_WORDS.some(fw => word.includes(fw))) {
      frustrationCount++;
      if (!keyPhrases.includes(word)) keyPhrases.push(word);
    }
    if (PROFESSIONAL_WORDS.some(pw => word.includes(pw))) {
      professionalCount++;
    }
  });
  
  // Check for exclamation marks and question marks
  const exclamationCount = (message.match(/!/g) || []).length;
  const questionCount = (message.match(/\?/g) || []).length;
  const capsWords = message.split(/\s+/).filter(w => w === w.toUpperCase() && w.length > 2).length;
  
  // Determine sentiment score
  let score: SentimentScore;
  let confidence = 50;
  
  const totalSentiment = positiveCount + negativeCount;
  if (totalSentiment === 0) {
    score = 'neutral';
    confidence = 60;
  } else if (positiveCount > negativeCount * 1.5) {
    score = 'positive';
    confidence = Math.min(90, 50 + (positiveCount * 10));
  } else if (negativeCount > positiveCount * 1.5) {
    score = 'negative';
    confidence = Math.min(90, 50 + (negativeCount * 10));
  } else if (positiveCount > 0 && negativeCount > 0) {
    score = 'mixed';
    confidence = 70;
  } else {
    score = positiveCount > negativeCount ? 'positive' : 'negative';
    confidence = 65;
  }
  
  // Determine emotion
  let emotion: EmotionType = 'neutral';
  if (frustrationCount > 2 || (negativeCount > 2 && urgencyCount > 1)) {
    emotion = 'anger';
  } else if (negativeCount > positiveCount && frustrationCount > 0) {
    emotion = 'frustration' as any; // Using anger as closest match
    emotion = 'sadness';
  } else if (positiveCount > 2) {
    emotion = 'joy';
  } else if (urgencyCount > 2) {
    emotion = 'anticipation';
  } else if (questionCount > 2) {
    emotion = 'surprise';
  }
  
  // Determine tone
  let tone: ToneIndicator = 'casual';
  if (professionalCount > 2) {
    tone = 'professional';
  } else if (frustrationCount > 1 || capsWords > 2) {
    tone = 'frustrated';
  } else if (urgencyCount > 2) {
    tone = 'urgent';
  } else if (positiveCount > negativeCount) {
    tone = 'friendly';
  } else if (questionCount > 2) {
    tone = 'confused';
  }
  
  // Calculate urgency level
  const urgencyLevel = Math.min(100, 
    (urgencyCount * 20) + 
    (exclamationCount * 10) + 
    (capsWords * 15) +
    (frustrationCount * 10)
  );
  
  return {
    score,
    confidence,
    emotion,
    tone,
    urgency_level: urgencyLevel,
    key_phrases: keyPhrases.slice(0, 5),
    sentiment_shifts: 0 // Will be calculated at conversation level
  };
}

/**
 * Analyze sentiment across multiple messages
 */
export function analyzeConversationSentiment(messages: Array<{ content: string; direction: 'inbound' | 'outbound' }>): {
  overall_sentiment: SentimentScore;
  sentiment_trend: 'improving' | 'declining' | 'stable';
  sentiment_shifts: number;
  customer_satisfaction_score: number;
  message_analyses: SentimentAnalysis[];
} {
  const analyses = messages.map(msg => analyzeMessageSentiment(msg.content));
  
  // Calculate overall sentiment
  const sentimentCounts = {
    positive: analyses.filter(a => a.score === 'positive').length,
    negative: analyses.filter(a => a.score === 'negative').length,
    neutral: analyses.filter(a => a.score === 'neutral').length,
    mixed: analyses.filter(a => a.score === 'mixed').length
  };
  
  let overall_sentiment: SentimentScore;
  if (sentimentCounts.positive > sentimentCounts.negative * 1.5) {
    overall_sentiment = 'positive';
  } else if (sentimentCounts.negative > sentimentCounts.positive * 1.5) {
    overall_sentiment = 'negative';
  } else if (sentimentCounts.mixed > analyses.length * 0.3) {
    overall_sentiment = 'mixed';
  } else {
    overall_sentiment = 'neutral';
  }
  
  // Calculate sentiment shifts
  let sentiment_shifts = 0;
  for (let i = 1; i < analyses.length; i++) {
    if (analyses[i].score !== analyses[i - 1].score) {
      sentiment_shifts++;
    }
  }
  
  // Calculate sentiment trend (first half vs second half)
  const midpoint = Math.floor(analyses.length / 2);
  const firstHalfNegative = analyses.slice(0, midpoint).filter(a => a.score === 'negative').length;
  const secondHalfNegative = analyses.slice(midpoint).filter(a => a.score === 'negative').length;
  
  let sentiment_trend: 'improving' | 'declining' | 'stable';
  if (secondHalfNegative < firstHalfNegative - 1) {
    sentiment_trend = 'improving';
  } else if (secondHalfNegative > firstHalfNegative + 1) {
    sentiment_trend = 'declining';
  } else {
    sentiment_trend = 'stable';
  }
  
  // Calculate customer satisfaction score (0-100)
  const positiveWeight = sentimentCounts.positive * 100;
  const neutralWeight = sentimentCounts.neutral * 50;
  const negativeWeight = sentimentCounts.negative * 0;
  const totalMessages = analyses.length || 1;
  
  const customer_satisfaction_score = Math.round(
    (positiveWeight + neutralWeight + negativeWeight) / totalMessages
  );
  
  return {
    overall_sentiment,
    sentiment_trend,
    sentiment_shifts,
    customer_satisfaction_score,
    message_analyses: analyses
  };
}

/**
 * Detect if sentiment has degraded significantly
 */
export function detectSentimentDegradation(
  currentSentiment: SentimentScore,
  previousSentiment: SentimentScore,
  urgencyLevel: number
): boolean {
  const degradationMap: Record<SentimentScore, number> = {
    positive: 3,
    neutral: 2,
    mixed: 1,
    negative: 0
  };
  
  const currentScore = degradationMap[currentSentiment];
  const previousScore = degradationMap[previousSentiment];
  
  // Significant degradation: dropped by 2+ levels OR moved to negative with high urgency
  return (
    (previousScore - currentScore >= 2) ||
    (currentSentiment === 'negative' && urgencyLevel > 70)
  );
}
