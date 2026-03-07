// ─── READINESS EVALUATOR ──────────────────────────────────────────────────────
export {
  evaluateCampaignReadiness,
  batchEvaluateCampaignReadiness,
  quickReadinessCheck,
  checkChannelReadiness,
  formatReadinessOutput,
} from './readiness-evaluator'
export type {
  ExecutionChannel,
  ContentType,
  AudienceScope,
  ReadinessInput,
  ReadinessStatus,
  ReadinessOutput,
} from './readiness-evaluator'

// ─── READINESS LOGGER ─────────────────────────────────────────────────────────
export {
  logReadinessEvaluation,
  batchLogReadinessEvaluations,
  getReadinessHistory,
  getReadinessStatistics,
  logChannelReadinessCheck,
  getReadinessTrends,
} from './readiness-logger'
