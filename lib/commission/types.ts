export const CURRENT_ENGINE_VERSION = 1

export interface CommissionCalculationParams {
  transactionId: string
  brokerageId: string
  calculationMode?: 'preview' | 'final'
  triggeredBy?: string
}

export interface CommissionCalculationResult {
  success: boolean
  transactionId: string
  grossCommissionCents: number
  adjustedGrossCents: number
  agentNetCents: number
  brokerageFinalCents: number
  agentFinalNetCents: number
  totalFeesCents: number
  distributions: CommissionDistribution[]
  metadata: {
    resolvedFrom: 'deal_override' | 'agent_profile' | 'brokerage_default'
    grossRateDecimal: number
    capApplied: boolean
    capStatus?: 'pre_cap' | 'hit_cap' | 'post_cap'
    calculationVersion: number
  }
}

export interface CommissionDistribution {
  distribution_type: 'agent' | 'brokerage' | 'team_member' | 'residual' | 'fee' | 'adjustment'
  agent_id?: string
  calculatedCents: number
  source_of_funds: 'agent' | 'brokerage' | 'gross'
  description?: string
  adjustment_id?: string
}

export interface WaterfallContext {
  transactionId: string
  brokerageId: string
  agentId: string
  purchasePriceCents: number
  
  // Step 1
  grossRateDecimal: number
  resolvedFrom: 'deal_override' | 'agent_profile' | 'brokerage_default'
  agentSplitPercent: number
  
  // Step 2
  grossCommissionCents: number
  
  // Step 3
  adjustedGrossCents: number
  grossAdjustments: CommissionDistribution[]
  
  // Step 4
  agentPortionCents: number
  brokeragePortionCents: number
  
  // Step 5
  agentAdjustments: CommissionDistribution[]
  
  // Step 6
  brokerageAdjustments: CommissionDistribution[]
  
  // Step 7
  agentNetCents: number
  brokerageFinalCents: number
  agentBonusCents: number
  capApplied: boolean
  capStatus?: 'pre_cap' | 'hit_cap' | 'post_cap'
  amountTowardsCap: number
  
  // Step 8
  teamDistributions: CommissionDistribution[]
  agentFinalCents: number
  
  // Step 9
  revenueShareDistributions: CommissionDistribution[]
  
  // Step 10
  feeDistributions: CommissionDistribution[]
  agentFinalNetCents: number
  totalFeesCents: number
  
  // All distributions
  allDistributions: CommissionDistribution[]
}
