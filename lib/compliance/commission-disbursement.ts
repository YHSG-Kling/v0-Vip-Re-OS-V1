/**
 * lib/compliance/commission-disbursement.ts
 *
 * Pure helpers for calculating per-agent commission disbursement.
 * Server-only — Compliance Officer dashboard wires these into actions.
 *
 * Owned by: Compliance Officer / Admin / Broker.
 * Visible to (read-only): the agent on the disbursement.
 */

import "server-only"

export interface SplitInputs {
  /** Gross commission earned on this side of the deal (listing or buyer). */
  grossCommission: number
  /** Agent's split as a percentage of the gross AFTER deductions. e.g. 70 means agent gets 70%. */
  brokerageSplitPercent: number
  /** Optional referral fee paid out of the gross before the brokerage split. */
  referralAmount?: number
  /** Optional team lead override (e.g. 5%) deducted from the agent's net. */
  teamOverridePercent?: number
  /** Per-deal franchise fee (e.g. RE/MAX, KW). */
  franchiseFeeAmount?: number
  /** E&O insurance per-deal fee. */
  eAndOAmount?: number
  /** Brokerage transaction fees (TC fee, compliance fee, etc.). */
  transactionFeesAmount?: number
  /** Any other adjustments. */
  otherDeductionsAmount?: number
}

export interface SplitResult {
  grossCommission: number
  referralAmount: number
  netAfterReferral: number
  brokerageSplitAmount: number
  agentGrossAfterSplit: number
  teamOverrideAmount: number
  franchiseFeeAmount: number
  eAndOAmount: number
  transactionFeesAmount: number
  otherDeductionsAmount: number
  totalDeductionsFromAgent: number
  netToAgent: number
}

/**
 * Standard deduction order (industry-standard waterfall):
 *   gross
 *   − referral fee (off the top)
 *   = net after referral
 *   ÷ brokerage split  (agent gets brokerageSplitPercent of net after referral)
 *   − team override    (% of agent's gross-after-split)
 *   − franchise fee
 *   − E&O
 *   − transaction fees
 *   − other deductions
 *   = net to agent
 */
export function computeSplit(input: SplitInputs): SplitResult {
  const round2 = (n: number) => Math.round(n * 100) / 100

  const grossCommission = round2(input.grossCommission)
  const referralAmount = round2(input.referralAmount ?? 0)
  const netAfterReferral = round2(grossCommission - referralAmount)

  const agentPct = Math.max(0, Math.min(100, input.brokerageSplitPercent))
  const agentGrossAfterSplit = round2(netAfterReferral * (agentPct / 100))
  const brokerageSplitAmount = round2(netAfterReferral - agentGrossAfterSplit)

  const teamOverrideAmount = round2(
    agentGrossAfterSplit * ((input.teamOverridePercent ?? 0) / 100),
  )
  const franchiseFeeAmount = round2(input.franchiseFeeAmount ?? 0)
  const eAndOAmount = round2(input.eAndOAmount ?? 0)
  const transactionFeesAmount = round2(input.transactionFeesAmount ?? 0)
  const otherDeductionsAmount = round2(input.otherDeductionsAmount ?? 0)

  const totalDeductionsFromAgent = round2(
    teamOverrideAmount +
      franchiseFeeAmount +
      eAndOAmount +
      transactionFeesAmount +
      otherDeductionsAmount,
  )

  const netToAgent = round2(agentGrossAfterSplit - totalDeductionsFromAgent)

  return {
    grossCommission,
    referralAmount,
    netAfterReferral,
    brokerageSplitAmount,
    agentGrossAfterSplit,
    teamOverrideAmount,
    franchiseFeeAmount,
    eAndOAmount,
    transactionFeesAmount,
    otherDeductionsAmount,
    totalDeductionsFromAgent,
    netToAgent,
  }
}
