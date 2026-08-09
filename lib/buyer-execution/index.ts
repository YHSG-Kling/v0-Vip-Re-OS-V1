// ─── BUYER EXECUTION ENGINE ───────────────────────────────────────────────────
export type { BuyerExecutionContext, BuyerJourneyStatus } from "./buyer-execution-engine"
export {
  getBuyerJourneyStatus,
  enforceFinancialGate,
  getBuyerFriendlyMessage,
  logBuyerExecutionEvent,
} from "./buyer-execution-engine"

// ─── GOVERNANCE GUARDS ────────────────────────────────────────────────────────
export type { GovernanceCheckResult } from "./governance-guards"
export {
  checkBuyerGovernance,
  emitGovernanceBlockEvent,
  emitEligibilityCheckEvent,
  checkAdminOverride,
  getDiagnosticGovernanceStatus,
} from "./governance-guards"

// ─── MULTI-PARTY UPDATES ──────────────────────────────────────────────────────
export type { ActorRole, MultiPartyUpdateContext } from "./multi-party-updates"
export {
  lenderConfirmFinancialVerification,
  agentAssistSearchConfiguration,
  adminOverrideFinancialGate,
  // The ONE definition of who may override a financing gate. Exported so the server
  // action enforces the same rule as the lib function instead of keeping its own copy.
  resolveFinancialGateOverrideAuthority,
  agentAdvanceBuyerStage,
  getMultiPartyUpdateHistory,
} from "./multi-party-updates"

// ─── ROLLBACK HANDLER ─────────────────────────────────────────────────────────
export type { RollbackTrigger } from "./rollback-handler"
export {
  emitRollbackEvent,
  handleOfferRejection,
  handleOfferWithdrawal,
  handleContractTermination,
  handleFinancingFailure,
  handleVerificationExpiration,
  handleBuyerDisengagement,
  getRollbackHistory,
  hasRecentRollbacks,
} from "./rollback-handler"

// ─── VOICE ASSISTANT INTEGRATION ─────────────────────────────────────────────
export type { VoiceAssistantRequest, VoiceAssistantResponse } from "./voice-assistant-integration"
export { handleBuyerVoiceRequest } from "./voice-assistant-integration"
