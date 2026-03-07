// ─── CALL EXECUTOR ────────────────────────────────────────────────────────────
export { initiateVoiceCall, completeVoiceCall } from './call-executor'
export type { CallMetadata, CallExecutionResult } from './call-executor'

// ─── TRANSCRIPT INGESTION ─────────────────────────────────────────────────────
export { ingestVoiceTranscript, emitVoiceHandoffSignal } from './transcript-ingestion'
export type {
  IngestTranscriptParams,
  IngestTranscriptResult,
} from './transcript-ingestion'

// ─── TRANSCRIPT NORMALIZER ────────────────────────────────────────────────────
export {
  normalizeVoiceTranscript,
  determinePrimarySpeaker,
  extractConversationTurns,
} from './transcript-normalizer'
export type {
  RawTranscriptSegment,
  RawTranscript,
  NormalizedTranscript,
} from './transcript-normalizer'

// ─── VOICE USAGE TRACKER ──────────────────────────────────────────────────────
export { trackVoiceCallUsage } from './voice-usage-tracker'
export type { VoiceUsageParams } from './voice-usage-tracker'
