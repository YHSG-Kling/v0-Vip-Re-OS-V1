/**
 * VOICE ENGINE: TRANSCRIPT NORMALIZATION
 * 
 * Converts raw voice transcripts into message format for System 3.1.
 * 
 * CRITICAL: Voice is a CHANNEL, not intelligence.
 * - We normalize format, not meaning
 * - We preserve speakers, not sentiment
 * - We handle interruptions, not intent
 */

export interface RawTranscriptSegment {
  speaker: 'contact' | 'ai' | 'agent' | 'office'
  text: string
  startTime: number  // seconds from call start
  endTime: number
  confidence?: number
}

export interface RawTranscript {
  callId: string
  segments: RawTranscriptSegment[]
  totalDuration: number
  vendor: string
  wasInterrupted?: boolean
  errorMessage?: string
}

export interface NormalizedTranscript {
  fullText: string
  speakers: Array<{
    role: 'contact' | 'ai' | 'agent' | 'office'
    text: string
    timestamp: number
  }>
  metadata: {
    callId: string
    vendor: string
    duration: number
    wasComplete: boolean
    errorMessage?: string
  }
}

/**
 * NORMALIZE VOICE TRANSCRIPT
 * 
 * Converts vendor-specific transcript format into standard structure.
 * Handles partial/failed transcripts gracefully.
 */
export function normalizeVoiceTranscript(
  rawTranscript: RawTranscript
): NormalizedTranscript {
  // Build full text with speaker labels
  let fullText = ''
  const speakers: Array<{ role: string; text: string; timestamp: number }> = []

  for (const segment of rawTranscript.segments) {
    const speakerLabel = segment.speaker.toUpperCase()
    fullText += `[${speakerLabel}]: ${segment.text}\n\n`

    speakers.push({
      role: segment.speaker,
      text: segment.text,
      timestamp: segment.startTime,
    })
  }

  // Add metadata about transcript quality
  if (rawTranscript.wasInterrupted) {
    fullText += '\n[CALL INTERRUPTED - Partial transcript]'
  }

  if (rawTranscript.errorMessage) {
    fullText += `\n[TRANSCRIPTION ERROR: ${rawTranscript.errorMessage}]`
  }

  return {
    fullText: fullText.trim(),
    speakers,
    metadata: {
      callId: rawTranscript.callId,
      vendor: rawTranscript.vendor,
      duration: rawTranscript.totalDuration,
      wasComplete: !rawTranscript.wasInterrupted && !rawTranscript.errorMessage,
      errorMessage: rawTranscript.errorMessage,
    },
  }
}

/**
 * DETERMINE PRIMARY SPEAKER
 * 
 * Identifies who spoke most in the call.
 * Useful for attribution when creating conversation records.
 */
export function determinePrimarySpeaker(
  segments: RawTranscriptSegment[]
): 'contact' | 'ai' | 'agent' | 'office' {
  const wordCounts: Record<string, number> = {}

  for (const segment of segments) {
    const wordCount = segment.text.split(/\s+/).length
    wordCounts[segment.speaker] = (wordCounts[segment.speaker] || 0) + wordCount
  }

  // Find speaker with most words
  let maxWords = 0
  let primarySpeaker: 'contact' | 'ai' | 'agent' | 'office' = 'contact'

  for (const [speaker, count] of Object.entries(wordCounts)) {
    if (count > maxWords) {
      maxWords = count
      primarySpeaker = speaker as 'contact' | 'ai' | 'agent' | 'office'
    }
  }

  return primarySpeaker
}

/**
 * EXTRACT CONVERSATION TURNS
 * 
 * Groups consecutive segments by same speaker into turns.
 * Useful for understanding conversation flow.
 */
export function extractConversationTurns(
  segments: RawTranscriptSegment[]
): Array<{ speaker: string; text: string; turnNumber: number }> {
  const turns: Array<{ speaker: string; text: string; turnNumber: number }> = []
  let currentSpeaker: string | null = null
  let currentText = ''
  let turnNumber = 0

  for (const segment of segments) {
    if (segment.speaker !== currentSpeaker) {
      // Speaker changed - save previous turn
      if (currentSpeaker) {
        turns.push({
          speaker: currentSpeaker,
          text: currentText.trim(),
          turnNumber,
        })
        turnNumber++
      }

      currentSpeaker = segment.speaker
      currentText = segment.text
    } else {
      // Same speaker - append text
      currentText += ' ' + segment.text
    }
  }

  // Save final turn
  if (currentSpeaker) {
    turns.push({
      speaker: currentSpeaker,
      text: currentText.trim(),
      turnNumber,
    })
  }

  return turns
}
