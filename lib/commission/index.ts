// ─── TYPES ────────────────────────────────────────────────────────────────────
export type {
  CalculateCommissionParams,
  CommissionCalculationResult,
  DistributionRecord,
  WaterfallContext,
} from "./types"
export { CURRENT_ENGINE_VERSION } from "./types"

// ─── ENGINE (entry point) ─────────────────────────────────────────────────────
export { calculateCommission } from "./engine"

// ─── UTILITIES ────────────────────────────────────────────────────────────────
export { dollarsToCents, centsToDollars, calculatePercentAmount, validatePositive } from "./utils"

// ─── PAYMENT TRACKER ─────────────────────────────────────────────────────────
export type {
  MarkCommissionPaidParams,
  MarkDistributionPaidParams,
} from "./payment-tracker"
export { markCommissionPaid, markDistributionPaid, getCommissionPaymentStatus } from "./payment-tracker"

// ─── WATERFALL STEPS (internal pipeline — exported for testing / observability)
export { resolveGrossRate } from "./waterfall/01-resolve-rate"
export { calculateGrossCommission } from "./waterfall/02-calculate-gross"
export { applyGrossAdjustments } from "./waterfall/03-apply-gross-adjustments"
export { splitAgentBrokerage } from "./waterfall/04-split-agent-brokerage"
export { applyAgentAdjustments } from "./waterfall/05-apply-agent-adjustments"
export { applyBrokerageAdjustments } from "./waterfall/06-apply-brokerage-adjustments"
export { applyCap } from "./waterfall/07-apply-cap"
export { applyTeamSplit } from "./waterfall/08-team-split"
export { applyRevenueShare } from "./waterfall/09-revenue-share"
export { applyFees } from "./waterfall/10-fees"
export { validateAndPersist } from "./waterfall/11-validate-persist"
