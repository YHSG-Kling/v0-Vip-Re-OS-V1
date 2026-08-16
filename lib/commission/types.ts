import type { TeamCapStatus } from './team-lead-split'

export const CURRENT_ENGINE_VERSION = 1

export interface CommissionStructureResolved {
  transactionFeeType: 'flat' | 'percent'
  transactionFeeValue: number
  deskFeeType: 'flat' | 'percent'
  deskFeeValue: number
  technologyFeeType: 'flat' | 'percent'
  technologyFeeValue: number
  eoFeeType: 'flat' | 'percent'
  eoFeeValue: number
}

export interface CalculateCommissionParams {
  transactionId: string
  brokerageId: string
  calculationMode?: 'preview' | 'final'
  triggeredBy?: string | null
}

export interface CommissionCalculationResult {
  success: boolean
  preview?: boolean
  commissionId?: string
  gross_commission: number
  net_to_agent: number
  net_to_brokerage: number
  cap_applied: boolean
  cap_status?: 'pre_cap' | 'hit_cap' | 'post_cap' | 'n/a'
  /** The TEAM cap outcome (m461) — the ceiling on what a team collects from this
   *  agent per anniversary year. Optional so existing callers are unaffected;
   *  'unavailable' means the ledger could not be read and the team was failed
   *  CLOSED (collected nothing), which is not the same as uncapped. */
  team_cap_status?: TeamCapStatus
  total_fees: number
  distributions?: DistributionRecord[]
  error?: string
}

export interface DistributionRecord {
  distribution_type: 'agent' | 'brokerage' | 'team_member' | 'referral' | 'residual' | 'royalty' | 'fee'
  agent_id?: string
  team_id?: string
  calculation_type: 'percent' | 'flat'
  calculation_value?: number
  calculated_amount: number
  source_of_funds: 'brokerage' | 'agent' | 'buyer' | 'seller_concession'
  cap_applied?: boolean
  cap_status?: string
  rule_id?: string
  recipient_type?: string
  notes?: string
}

export interface WaterfallContext {
  transactionId: string
  brokerageId: string
  agentId: string

  // Core values
  purchasePriceCents: number
  grossRateDecimal: number
  agentSplitPercent: number
  resolvedFrom: 'deal_override' | 'agent_profile' | 'brokerage_default'

  // Running totals (ALL CENTS)
  grossCommissionCents: number
  adjustedGrossCents: number
  agentPortionCents: number
  brokeragePortionCents: number
  agentNetCents: number
  brokerageFinalCents: number
  agentFinalNetCents: number
  totalFeesCents: number

  // Cap (BROKERAGE — stage 07 → persisted to agent_cap_tracking by stage 11)
  capApplied: boolean
  capStatus: 'pre_cap' | 'hit_cap' | 'post_cap' | 'n/a'
  amountTowardsCap: number

  // Cap (TEAM, m461 — stage 08 → persisted to team_cap_tracking by stage 11).
  // OPTIONAL because only stage 08 sets them: every step before it hands on a
  // context without them, and making them required would force a meaningless
  // initial value through the whole pipeline. Stage 11 treats absent as "no team
  // cap activity", which is the correct reading for an agent with no team.
  /** Cents to add to team_cap_tracking.cap_paid_to_date. */
  teamAmountTowardsCap?: number
  teamCapStatus?: TeamCapStatus
  /** teams.id whose ledger stage 11 must write back (null when no override applied). */
  teamCapTeamId?: string | null

  // Distribution collections
  grossAdjustments: DistributionRecord[]
  agentAdjustments: DistributionRecord[]
  brokerageAdjustments: DistributionRecord[]
  teamDistributions: DistributionRecord[]
  revenueShareDistributions: DistributionRecord[]
  feeDistributions: DistributionRecord[]
}
