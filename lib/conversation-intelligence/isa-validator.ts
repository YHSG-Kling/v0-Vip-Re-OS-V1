/**
 * System 3.4 - AI ISA Validation & Conversation Intelligence
 * Validates AI ISA performance, conversation quality, and outcome accuracy
 */

export type ISAOutcome = 
  | 'appointment_booked'
  | 'qualified_lead'
  | 'not_qualified'
  | 'callback_requested'
  | 'no_answer'
  | 'voicemail'
  | 'not_interested'
  | 'wrong_number'
  | 'do_not_call';

export type ISAConfidenceLevel = 'high' | 'medium' | 'low' | 'unverified';

export interface ISAValidationResult {
  is_valid: boolean;
  confidence_level: ISAConfidenceLevel;
  confidence_score: number; // 0-100
  outcome_accuracy: number; // 0-100
  conversation_quality_score: number; // 0-100
  issues_detected: ISAIssue[];
  recommendations: string[];
  should_human_review: boolean;
  validation_summary: string;
}

export interface ISAIssue {
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: 'outcome_mismatch' | 'poor_qualification' | 'incomplete_information' | 'tone_issue' | 'compliance_risk' | 'technical_error';
  description: string;
  detected_at_timestamp?: string;
}

export interface ISATranscript {
  transcript_text: string;
  duration_seconds: number;
  outcome: ISAOutcome;
  qualification_data?: {
    budget?: number;
    timeline?: string;
    qualified?: boolean;
    qualification_notes?: string;
  };
  appointment_data?: {
    scheduled_time?: string;
    appointment_type?: string;
  };
  sentiment_detected?: string;
}

export interface ISAConversationAnalysis {
  key_points_extracted: string[];
  questions_asked: string[];
  objections_handled: string[];
  commitment_secured: boolean;
  next_steps_defined: boolean;
  contact_info_verified: boolean;
}

/**
 * Validate AI ISA conversation outcome
 */
export function validateISAConversation(
  transcript: ISATranscript,
  declared_outcome: ISAOutcome
): ISAValidationResult {
  const issues: ISAIssue[] = [];
  const recommendations: string[] = [];
  
  // Analyze transcript content
  const analysis = analyzeISATranscript(transcript.transcript_text);
  
  // Validate outcome matches transcript
  const outcome_accuracy = validateOutcomeAccuracy(
    transcript,
    declared_outcome,
    analysis,
    issues,
    recommendations
  );
  
  // Validate conversation quality
  const conversation_quality_score = validateConversationQuality(
    transcript,
    analysis,
    issues,
    recommendations
  );
  
  // Validate qualification completeness (if qualified lead)
  if (declared_outcome === 'qualified_lead' || declared_outcome === 'appointment_booked') {
    validateQualificationData(
      transcript.qualification_data,
      analysis,
      issues,
      recommendations
    );
  }
  
  // Validate appointment data (if appointment booked)
  if (declared_outcome === 'appointment_booked') {
    validateAppointmentData(
      transcript.appointment_data,
      analysis,
      issues,
      recommendations
    );
  }
  
  // Check for compliance risks
  checkComplianceRisks(transcript.transcript_text, issues, recommendations);
  
  // Calculate confidence score
  const confidence_score = calculateConfidenceScore(
    outcome_accuracy,
    conversation_quality_score,
    issues
  );
  
  // Determine confidence level
  const confidence_level = determineConfidenceLevel(confidence_score, issues);
  
  // Determine if human review needed
  const should_human_review = shouldRequireHumanReview(
    confidence_score,
    issues,
    declared_outcome
  );
  
  // Check if validation passes
  const is_valid = confidence_score >= 60 && !issues.some(i => i.severity === 'critical');
  
  // Generate summary
  const validation_summary = generateValidationSummary(
    is_valid,
    confidence_score,
    outcome_accuracy,
    conversation_quality_score,
    issues.length
  );
  
  return {
    is_valid,
    confidence_level,
    confidence_score,
    outcome_accuracy,
    conversation_quality_score,
    issues_detected: issues,
    recommendations,
    should_human_review,
    validation_summary
  };
}

function analyzeISATranscript(transcript: string): ISAConversationAnalysis {
  const lower = transcript.toLowerCase();
  
  // Extract key conversation elements
  const questions_asked = extractQuestions(transcript);
  const objections_handled = detectObjections(lower);
  const commitment_secured = detectCommitment(lower);
  const next_steps_defined = detectNextSteps(lower);
  const contact_info_verified = detectContactVerification(lower);
  const key_points_extracted = extractKeyPoints(transcript);
  
  return {
    key_points_extracted,
    questions_asked,
    objections_handled,
    commitment_secured,
    next_steps_defined,
    contact_info_verified
  };
}

function extractQuestions(transcript: string): string[] {
  const sentences = transcript.split(/[.!?]+/);
  return sentences
    .filter(s => s.trim().includes('?') || /\b(what|when|where|why|how|can|do|does|would|could|should)\b/i.test(s))
    .map(s => s.trim())
    .slice(0, 10);
}

function detectObjections(transcript: string): string[] {
  const objectionPatterns = [
    'not interested', 'no thanks', 'too busy', 'not right now',
    'already working with', 'not looking', 'cant afford',
    'need to think', 'talk to my', 'maybe later'
  ];
  
  return objectionPatterns.filter(pattern => transcript.includes(pattern));
}

function detectCommitment(transcript: string): boolean {
  const commitmentPhrases = [
    'yes', 'sure', 'okay', 'sounds good', 'that works',
    'ill do that', 'count me in', 'lets do it', 'im interested',
    'schedule', 'book', 'appointment'
  ];
  
  return commitmentPhrases.some(phrase => transcript.includes(phrase));
}

function detectNextSteps(transcript: string): boolean {
  const nextStepsPhrases = [
    'next step', 'follow up', 'call you back', 'send you',
    'email you', 'schedule', 'meeting', 'appointment',
    'ill reach out', 'touch base', 'connect again'
  ];
  
  return nextStepsPhrases.some(phrase => transcript.includes(phrase));
}

function detectContactVerification(transcript: string): boolean {
  const verificationPhrases = [
    'confirm your', 'verify your', 'is this still', 'correct number',
    'best number', 'email address', 'how can i reach'
  ];
  
  return verificationPhrases.some(phrase => transcript.includes(phrase));
}

function extractKeyPoints(transcript: string): string[] {
  // Simple key phrase extraction (in production, use NLP)
  const sentences = transcript.split(/[.!?]+/).map(s => s.trim());
  
  // Filter for substantive sentences (length > 50 chars)
  const keyPoints = sentences
    .filter(s => s.length > 50 && s.length < 200)
    .slice(0, 5);
  
  return keyPoints;
}

function validateOutcomeAccuracy(
  transcript: ISATranscript,
  declared_outcome: ISAOutcome,
  analysis: ISAConversationAnalysis,
  issues: ISAIssue[],
  recommendations: string[]
): number {
  let accuracy = 100;
  
  // Check if outcome matches conversation content
  switch (declared_outcome) {
    case 'appointment_booked':
      if (!analysis.commitment_secured) {
        accuracy -= 40;
        issues.push({
          severity: 'high',
          category: 'outcome_mismatch',
          description: 'Appointment marked as booked but no clear commitment detected in transcript'
        });
        recommendations.push('Review transcript - appointment commitment may not be secure');
      }
      if (!analysis.next_steps_defined) {
        accuracy -= 20;
        issues.push({
          severity: 'medium',
          category: 'incomplete_information',
          description: 'Appointment booked but next steps not clearly defined'
        });
      }
      break;
      
    case 'qualified_lead':
      if (analysis.objections_handled.length > 2) {
        accuracy -= 15;
        issues.push({
          severity: 'medium',
          category: 'poor_qualification',
          description: 'Multiple objections detected - qualification may be weak'
        });
        recommendations.push('Lead may need additional nurturing before conversion');
      }
      break;
      
    case 'not_interested':
      if (analysis.commitment_secured) {
        accuracy -= 50;
        issues.push({
          severity: 'critical',
          category: 'outcome_mismatch',
          description: 'Marked as not interested but commitment language detected'
        });
        recommendations.push('Review transcript immediately - outcome may be incorrect');
      }
      break;
  }
  
  return Math.max(0, accuracy);
}

function validateConversationQuality(
  transcript: ISATranscript,
  analysis: ISAConversationAnalysis,
  issues: ISAIssue[],
  recommendations: string[]
): number {
  let quality_score = 70;
  
  // Check conversation duration
  if (transcript.duration_seconds < 30) {
    quality_score -= 20;
    issues.push({
      severity: 'medium',
      category: 'incomplete_information',
      description: 'Very short conversation - may not have been substantive'
    });
  } else if (transcript.duration_seconds > 600) {
    quality_score -= 10;
    issues.push({
      severity: 'low',
      category: 'tone_issue',
      description: 'Very long conversation - efficiency may be low'
    });
  } else if (transcript.duration_seconds >= 60 && transcript.duration_seconds <= 300) {
    quality_score += 10; // Ideal range
  }
  
  // Check if questions were asked
  if (analysis.questions_asked.length < 2) {
    quality_score -= 15;
    issues.push({
      severity: 'medium',
      category: 'poor_qualification',
      description: 'Few questions asked - qualification may be incomplete'
    });
    recommendations.push('Ensure AI asks qualifying questions about budget, timeline, and needs');
  } else if (analysis.questions_asked.length >= 3) {
    quality_score += 10;
  }
  
  // Check if contact info was verified
  if (!analysis.contact_info_verified) {
    quality_score -= 10;
    recommendations.push('Verify contact information in every call for better follow-up');
  }
  
  // Check if next steps were defined
  if (!analysis.next_steps_defined) {
    quality_score -= 15;
    issues.push({
      severity: 'medium',
      category: 'incomplete_information',
      description: 'No clear next steps defined'
    });
    recommendations.push('Always end calls with clear next steps');
  }
  
  return Math.max(0, Math.min(100, quality_score));
}

function validateQualificationData(
  qualification_data: ISATranscript['qualification_data'],
  analysis: ISAConversationAnalysis,
  issues: ISAIssue[],
  recommendations: string[]
): void {
  if (!qualification_data) {
    issues.push({
      severity: 'high',
      category: 'poor_qualification',
      description: 'Lead marked as qualified but no qualification data captured'
    });
    recommendations.push('Ensure budget, timeline, and needs are captured for all qualified leads');
    return;
  }
  
  // Check for required qualification fields
  if (!qualification_data.budget) {
    issues.push({
      severity: 'medium',
      category: 'incomplete_information',
      description: 'Budget information missing from qualification'
    });
  }
  
  if (!qualification_data.timeline) {
    issues.push({
      severity: 'medium',
      category: 'incomplete_information',
      description: 'Timeline information missing from qualification'
    });
  }
  
  if (!qualification_data.qualification_notes || qualification_data.qualification_notes.length < 20) {
    issues.push({
      severity: 'low',
      category: 'incomplete_information',
      description: 'Minimal or no qualification notes captured'
    });
    recommendations.push('Capture detailed qualification notes for better handoff');
  }
}

function validateAppointmentData(
  appointment_data: ISATranscript['appointment_data'],
  analysis: ISAConversationAnalysis,
  issues: ISAIssue[],
  recommendations: string[]
): void {
  if (!appointment_data || !appointment_data.scheduled_time) {
    issues.push({
      severity: 'critical',
      category: 'outcome_mismatch',
      description: 'Appointment marked as booked but no scheduled time captured'
    });
    recommendations.push('Critical: Verify appointment details and schedule manually if needed');
  }
}

function checkComplianceRisks(
  transcript: string,
  issues: ISAIssue[],
  recommendations: string[]
): void {
  const lower = transcript.toLowerCase();
  
  // Check for DNC violations
  if (lower.includes('do not call') || lower.includes('dont call') || lower.includes('remove me')) {
    issues.push({
      severity: 'critical',
      category: 'compliance_risk',
      description: 'Do Not Call request detected - immediate compliance action required'
    });
    recommendations.push('Add contact to DNC list immediately and cease all communication');
  }
  
  // Check for required disclosures
  if (transcript.length > 100 && !lower.includes('record')) {
    issues.push({
      severity: 'low',
      category: 'compliance_risk',
      description: 'Recording disclosure may not have been made'
    });
    recommendations.push('Ensure call recording disclosure is made on every call');
  }
}

function calculateConfidenceScore(
  outcome_accuracy: number,
  conversation_quality: number,
  issues: ISAIssue[]
): number {
  let base_score = (outcome_accuracy * 0.6) + (conversation_quality * 0.4);
  
  // Apply penalties for issues
  const critical_issues = issues.filter(i => i.severity === 'critical').length;
  const high_issues = issues.filter(i => i.severity === 'high').length;
  const medium_issues = issues.filter(i => i.severity === 'medium').length;
  
  base_score -= (critical_issues * 25);
  base_score -= (high_issues * 15);
  base_score -= (medium_issues * 5);
  
  return Math.max(0, Math.min(100, Math.round(base_score)));
}

function determineConfidenceLevel(
  confidence_score: number,
  issues: ISAIssue[]
): ISAConfidenceLevel {
  if (issues.some(i => i.severity === 'critical')) {
    return 'unverified';
  }
  
  if (confidence_score >= 85) {
    return 'high';
  } else if (confidence_score >= 70) {
    return 'medium';
  } else if (confidence_score >= 50) {
    return 'low';
  } else {
    return 'unverified';
  }
}

function shouldRequireHumanReview(
  confidence_score: number,
  issues: ISAIssue[],
  declared_outcome: ISAOutcome
): boolean {
  // Always review critical issues
  if (issues.some(i => i.severity === 'critical')) {
    return true;
  }
  
  // Review low confidence
  if (confidence_score < 60) {
    return true;
  }
  
  // Review appointments and qualified leads with medium confidence
  if ((declared_outcome === 'appointment_booked' || declared_outcome === 'qualified_lead') && 
      confidence_score < 75) {
    return true;
  }
  
  // Review if multiple high severity issues
  if (issues.filter(i => i.severity === 'high').length >= 2) {
    return true;
  }
  
  return false;
}

function generateValidationSummary(
  is_valid: boolean,
  confidence_score: number,
  outcome_accuracy: number,
  conversation_quality: number,
  issue_count: number
): string {
  if (!is_valid) {
    return `Validation FAILED (${confidence_score}% confidence). ${issue_count} issue(s) detected. Human review required.`;
  }
  
  if (confidence_score >= 85) {
    return `Validation PASSED with HIGH confidence (${confidence_score}%). Quality: ${conversation_quality}%, Outcome accuracy: ${outcome_accuracy}%.`;
  } else if (confidence_score >= 70) {
    return `Validation PASSED with MEDIUM confidence (${confidence_score}%). ${issue_count} minor issue(s) noted.`;
  } else {
    return `Validation PASSED with LOW confidence (${confidence_score}%). Consider human review.`;
  }
}
