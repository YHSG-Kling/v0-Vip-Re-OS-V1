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
  /** Company-books obligations recorded beside (not inside) the deal's
   *  distribution set — see CompanyObligationRecord. Optional so existing
   *  callers are unaffected; absent means none arose. */
  company_obligations?: CompanyObligationRecord[]
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

/**
 * A COMPANY-BOOKS OBLIGATION — money the brokerage OWES from its own books, not
 * from this deal's company dollar (owner ruling 2026-08-28: the cap ends the
 * brokerage TAKING from the agent; it does not end the brokerage PAYING its own
 * obligations). Produced when a brokerage-funded share (today: revenue share)
 * lands on a deal whose company dollar cannot fund it — post-cap the brokerage's
 * in-deal final is $0, so there is nothing in the deal to deduct from. The
 * obligation is recorded OUTSIDE the in-waterfall distribution set: it is NOT in
 * step 11's gross == distributed + finals identity (it is not this deal's money)
 * and it is persisted to company_books_obligations (m577), never to
 * commission_distributions — the deal's disbursement sweeps
 * (payment-tracker.markCommissionPaid, reconcile-tracking's orphan lock) mark
 * every distribution row paid when the DEAL pays, and a company-books payable is
 * not paid by the deal's disbursement.
 */
export interface CompanyObligationRecord {
  /** §6: the distributions vocabulary word for the share class — 'residual' for
   *  revenue share, 'team_member' for a brokerage-funded team split the deal's
   *  company dollar could not fund (the m577 sibling, closed by the same owner
   *  ruling: the cap ends the brokerage TAKING, not the brokerage PAYING). */
  obligation_type: 'residual' | 'team_member'
  /** Recipient — agents.id (the sponsor, or the team member being paid). */
  agent_id: string
  calculation_type: 'percent' | 'flat'
  calculation_value?: number
  /** Dollars, like DistributionRecord.calculated_amount. */
  calculated_amount: number
  /** Why this is on company books instead of in the deal. */
  reason: 'post_cap_company_books'
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

  // Revenue share (stage 09). OPTIONAL like the team-cap fields above — only
  // stage 09 sets it. Set when the step paid nothing because the brokerage
  // never opted in ('disabled') or opted in without describing the
  // distribution model ('model_unconfigured', m575 — the mark alone pays
  // nothing; the skip is recorded here and warned, never silent).
  revenueShareSkipped?: 'disabled' | 'model_unconfigured'

  // Company-books obligations (stage 09, owner ruling 2026-08-28). OPTIONAL like
  // the fields above — only stage 09 sets it. Brokerage-funded shares the deal's
  // company dollar could not fund (post-cap, or a straddling deal whose remaining
  // dollar is smaller than the share). Deliberately NOT a distribution collection:
  // stage 11 excludes these from the conservation identity and persists them to
  // company_books_obligations (m577), never silently dropping them.
  companyObligations?: CompanyObligationRecord[]

  // Distribution collections
  grossAdjustments: DistributionRecord[]
  agentAdjustments: DistributionRecord[]
  brokerageAdjustments: DistributionRecord[]
  teamDistributions: DistributionRecord[]
  revenueShareDistributions: DistributionRecord[]
  feeDistributions: DistributionRecord[]
}
