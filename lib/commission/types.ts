import type { TeamCapStatus } from './team-lead-split'
// Type-only (erased by the compiler): an inline `import('./x').T` reads as a VALUE edge to the module-graph
// walker (test:proxy-graph-budget), so these are declared as `import type` where the walker can see it.
import type { ResidualEvaluation } from './revenue-share-model'
import type { AgentTermsResolution } from './agreement-terms'
import type { ConcessionSettlementTreatment } from './agent-concession'

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
  /** WAVE 144 (lane 144D, owner ruling 7): the agreement's royalty term (agent_commission_profiles.royalty_type /
   *  royalty_value) — a brokerage fee of its own, never an ordinary fee, referral, residual or concession. Optional so a
   *  structure that predates it reads as "no royalty". */
  royaltyType?: 'flat' | 'percent'
  royaltyValue?: number
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
  /** Gross-level concessions (listing-agreement credits / surcharges) that moved the gross before the split. They are
   *  INPUTS that change the gross, not payouts — never distributions (wave 143, lane 143C). */
  gross_adjustments?: DistributionRecord[]
  error?: string
}

export interface DistributionRecord {
  distribution_type: 'agent' | 'brokerage' | 'team_member' | 'referral' | 'residual' | 'royalty' | 'fee'
  agent_id?: string
  team_id?: string
  /** WAVE 144 (lane 144D, owner ruling 5): the OUTSIDE referral payee — a referral_partners row (the canonical PARTNER
   *  bucket), never an agents row. Set only on a 'referral' row whose agent_id is empty (m850 CHECK partner_payee). */
  referral_partner_id?: string
  calculation_type: 'percent' | 'flat'
  calculation_value?: number
  calculated_amount: number
  /** WAVE 144 (lane 144D, owner ruling 4): 'seller_concession' is no longer a source of commission funds. A seller
   *  concession is the SELLER's money to the BUYER out of the seller's net — it never funds a commission line
   *  (m850 narrows the live CHECK to these three). */
  source_of_funds: 'brokerage' | 'agent' | 'buyer'
  cap_applied?: boolean
  cap_status?: string
  rule_id?: string
  recipient_type?: string
  notes?: string
  /** IN-MEMORY ONLY (wave 107, 107A): the agent_relationships.id a 'residual' share was evaluated from —
   *  the "rule" half of the residual idempotency key. Step 11 maps columns explicitly, so it is never
   *  written (rule_id FKs commission_rules, not agent_relationships). */
  relationship_id?: string
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
  /** IN-MEMORY ONLY (wave 107, 107A) — the agent_relationships.id a residual obligation was evaluated from. */
  relationship_id?: string
}

/** One gross-level adjustment as stage 03 judged it (wave 144, lane 144D). Cents are POSITIVE magnitudes; `signedCents`
 *  is what moved the gross (a credit is negative). */
export interface ConcessionEvidence {
  adjustmentId: string
  /** 'agent_concession' = a credit the agent gives the buyer / seller off that agent's gross commission (ruling 4);
   *  'surcharge' = an increase of the gross (direction surcharge) — not a concession. */
  kind: 'agent_concession' | 'surcharge'
  verdict: 'applied' | 'skipped' | 'held'
  concessionAgentId: string | null
  beneficiary: string | null
  beneficiaryName: string | null
  reason: string | null
  approvalStatus: string
  /** One vocabulary (§6): lib/commission/agent-concession.ts CONCESSION_SETTLEMENT_TREATMENTS (m850 CHECK). */
  settlementTreatment: ConcessionSettlementTreatment | null
  signedCents: number
  /** What the money did — 'reduces_gross_before_split' for an applied credit. */
  ledgerEffect: 'reduces_gross_before_split' | 'increases_gross_before_split' | 'none'
  finding: string | null
}

/** The cap cycle a deal is judged in (wave 144, lane 144D). Cents throughout. */
export interface CapCycleContext {
  /** agent_cap_tracking.id when a ledger window covers the deal's date; null = a NEW cycle stage 11 materialises. */
  trackingId: string | null
  start: string
  end: string
  capAmountCents: number
  paidToDateCents: number
  /** The cap_paid_to_date value exactly as read — stage 11's compare-and-swap predicate. */
  paidToDateRaw: number | string | null
  capSource: 'agreement' | 'ledger' | 'brokerage_default'
  eligible: string[]
  asOf: string
  /** The agreement's own cap anniversary when it states one — stage 11 opens a new cycle's window on it. */
  agreementAnniversaryDate: string | null
  findings: string[]
  /** Cents of cap room left after the split (stage 07) — stage 10 spends it on cap-eligible fees / royalty. */
  remainingAfterSplitCents: number
  /** Cents contributed toward the cap, by contribution type (brokerage_split | <fee kind> | royalty). */
  contributedByType: Record<string, number>
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

  // Residual evaluation (stage 09, wave 107 lane 107A). OPTIONAL like the fields
  // above. The deterministic rule evaluation's evidence — rule keys, the close date
  // the effective windows were judged on, graph corroboration findings — which
  // stage 11 writes onto the action ledger beside each residual ledger entry.
  residualEvaluation?: ResidualEvaluation

  // The agreement the deal was priced with (stage 01, wave 143 lane 143C): the agent's terms in force on the
  // transaction's period — never today's profile — with the version, the date that decided and the signed
  // agreement of record. OPTIONAL like the fields above; stage 11 stores it as commission_calculations.engine_inputs.
  agreement?: AgentTermsResolution

  // The TEAM terms the team-lead override was priced with (stage 08, wave 143 lane 143C): which version, the date it was
  // judged on, and the agent's signed team agreement of record. OPTIONAL - set only when a team override applied.
  teamAgreement?: {
    teamId: string
    source: 'version' | 'live_team'
    effectiveFrom: string | null
    asOf: string
    signedAgreement: { id: string; fullyExecutedAt: string; documentUrl: string | null } | null
  }

  // Agent-to-agent referral payout (stage 09b, wave 143 lane 143C). OPTIONAL — only stage 09b sets them.
  // The fee is a CONSERVED distribution (deducted from the producing agent's running net, funded by the agent),
  // not a side row booked after the fact.
  referralDistributions?: DistributionRecord[]
  /** Cents the referral deduction takes off the top of the adjusted gross BEFORE the brokerage/agent split (stage 04 splits the remainder). */
  referralDeductionCents?: number
  /** referrals.id + the referring agent behind referralDistributions[0] — stage 11 links the referral to the deal. */
  referralLink?: { referralId: string; referringAgentId: string | null; partnerId?: string | null; alreadyLinked: boolean } | null
  referralFindings?: string[]

  // AGENT CONCESSIONS (stage 03, wave 144 lane 144D — owner ruling 4). OPTIONAL — only stage 03 sets them. Every
  // gross-level commission_adjustments row the stage saw, with what it did and why (applied / skipped / held), so the
  // calculation's evidence names the agent, beneficiary, amount, reason, approval, settlement treatment and ledger effect.
  concessions?: ConcessionEvidence[]

  // THE CAP CYCLE the deal was priced in (stage 07, wave 144 lane 144D — owner ruling 9). OPTIONAL — only stage 07 sets
  // it. null = no cap configured anywhere for this agent (the 'n/a' answer). Stage 10 spends the cap room the split left
  // on CAP-ELIGIBLE fees / royalty; stage 11 materialises the window (anniversary rollover) and advances it once.
  capCycle?: CapCycleContext | null

  // ROYALTY (stage 10, wave 144 lane 144D — owner ruling 7). OPTIONAL — only stage 10 sets them. A separate brokerage fee
  // under the agreement, never an ordinary fee, a referral, a residual or a concession.
  royaltyDistributions?: DistributionRecord[]
  royaltyCents?: number

  // Distribution collections
  grossAdjustments: DistributionRecord[]
  agentAdjustments: DistributionRecord[]
  brokerageAdjustments: DistributionRecord[]
  teamDistributions: DistributionRecord[]
  revenueShareDistributions: DistributionRecord[]
  feeDistributions: DistributionRecord[]
}
