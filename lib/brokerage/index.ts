// ─── BROKERAGE SETTINGS (canonical source) ────────────────────────────────────
export type {
  TransactionProvider,
  TransactionMode,
  AuthorityMode,
  AccountingProvider,
  ClosingEntityType,
  ComplianceLevels,
  PipelineSettings,
  FinancialDefaults,
  BrokerageSettings,
} from "./get-brokerage-settings"
export {
  getBrokerageSettings,
  getTransactionProvider,
  getTransactionMode,
  getAccountingProvider,
  getPrimaryState,
  getRequiredPrimaryState,
  getClosingEntityType,
  getComplianceLevels,
  getPipelineSettings,
  getFinancialDefaults,
  getComplianceAuthority,
  getCommissionAuthority,
  getAccountingAuthority,
  getOfferExpirationHours,
  getStaleLeadWarningDays,
  getFinancialVerificationSLAHours,
} from "./get-brokerage-settings"

// ─── COMMISSION STRUCTURE ─────────────────────────────────────────────────────
export type { CommissionStructureResolved } from "./get-default-commission-structure"
export { getDefaultCommissionStructure } from "./get-default-commission-structure"

// ─── REQUIRED PROVIDERS ───────────────────────────────────────────────────────
export {
  getRequiredTransactionProvider,
  getAccountingProvider as getRequiredAccountingProvider,
  getClosingEntityType as getRequiredClosingEntityType,
} from "./get-required-providers"

// ─── REQUIRED STATE ───────────────────────────────────────────────────────────
export { getRequiredPrimaryState as getRequiredState, getPrimaryState as getState } from "./get-required-state"
