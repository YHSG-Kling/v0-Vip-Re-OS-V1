export const CURRENT_ENGINE_VERSION = 1

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
  purchasePriceCents: number
  grossRateDecimal: number
  agentSplitPercent: number
  resolvedFrom: 'deal_override' | 'agent_profile' | 'brokerage_default'
  calculationMode: 'preview' | 'final'
  triggeredBy?: string | null
}
