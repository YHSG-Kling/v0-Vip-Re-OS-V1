// ─── COMPLIANCE GATE ──────────────────────────────────────────────────────────
export {
  checkCompliancePassed,
  emitCompliancePassed,
  validateAcceptanceEligibility,
} from './compliance-gate'
export type { ComplianceCheckResult } from './compliance-gate'

// ─── CREDENTIALS HELPER ───────────────────────────────────────────────────────
export {
  getAgentProviderCredentials,
  hasProviderCredentials,
} from './credentials-helper'
export type { ProviderCredentials } from './credentials-helper'

// ─── LIFECYCLE EVENT MAP ──────────────────────────────────────────────────────
export {
  OFFER_LIFECYCLE_EVENTS,
  deriveOfferState,
  detectConflictingOffers,
} from './lifecycle-event-map'
export type {
  OfferLifecycleEvent,
  OfferEventMetadata,
} from './lifecycle-event-map'

// ─── STATUS SYNC ──────────────────────────────────────────────────────────────
export {
  syncOfferStatus,
  getCurrentOfferStatus,
} from './status-sync'
