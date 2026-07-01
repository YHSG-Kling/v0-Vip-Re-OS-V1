// lib/commission/cda-discrepancy.ts
//
// CDA discrepancy detection — the "Compare" step of the CDA workflow (was a stub returning []).
// Before the Compliance Officer approves a Closing Disclosure Agreement that DICTATES to the title
// company / closing attorney how to split funds, the computed commission must match the contract
// terms. A silent mismatch here = the brokerage authorizing the wrong disbursement. PURE so it's
// unit-tested; the workflow loads the real numbers and calls it.

export interface CdaDiscrepancy {
  field: string
  expected: number
  actual: number
  deltaPct: number
  severity: "warning" | "blocker"
}

/**
 * PURE: compare the computed gross commission to the contract-derived expected gross. Returns []
 * when there's nothing to compare (no expected number) or the delta is within tolerance. A delta
 * ≥ blockerPct is a BLOCKER (Compliance must resolve before approving); smaller deltas are warnings.
 */
export function computeCdaDiscrepancies(input: {
  computedGross: number
  expectedGross: number | null | undefined
  tolerancePct?: number
  minDollar?: number
  blockerPct?: number
}): CdaDiscrepancy[] {
  const tolerancePct = input.tolerancePct ?? 1
  const minDollar = input.minDollar ?? 50
  const blockerPct = input.blockerPct ?? 5
  const expected = input.expectedGross
  if (expected == null || !Number.isFinite(expected) || expected <= 0) return []

  const diff = Math.abs(input.computedGross - expected)
  if (diff < minDollar) return []
  const deltaPct = Math.round((diff / expected) * 1000) / 10
  if (deltaPct < tolerancePct) return []

  return [{
    field: "gross_commission",
    expected: Math.round(expected),
    actual: Math.round(input.computedGross),
    deltaPct,
    severity: deltaPct >= blockerPct ? "blocker" : "warning",
  }]
}

/** PURE: the contract-derived expected gross commission from the transaction's terms. */
export function expectedGrossFromTerms(t: {
  estimated_commission?: number | null
  purchase_price?: number | null
  commission_percentage?: number | null
}): number | null {
  if (t.estimated_commission != null && Number.isFinite(t.estimated_commission) && t.estimated_commission > 0) {
    return t.estimated_commission
  }
  if (t.purchase_price != null && t.commission_percentage != null && t.purchase_price > 0 && t.commission_percentage > 0) {
    return Math.round(t.purchase_price * (t.commission_percentage / 100))
  }
  return null
}

/**
 * PURE: verify the CDA's IMPLIED agent split (agent_net / gross) matches the agent's brokerage
 * CONTRACT split (agent_commission_profiles.split_percent). This is the compliance check the
 * business process names explicitly — "the agent's contract with the brokerage agrees with the
 * split." A material deviation is a BLOCKER (the CDA would pay against the contract).
 */
export function checkSplitAgainstContract(input: {
  computedGross: number
  computedAgentNet: number
  contractSplitPct: number | null | undefined
  tolerancePct?: number
  blockerPct?: number
}): CdaDiscrepancy[] {
  const tolerancePct = input.tolerancePct ?? 1.5
  const blockerPct = input.blockerPct ?? 5
  const contract = input.contractSplitPct
  if (contract == null || !Number.isFinite(contract) || contract <= 0) return []
  if (!Number.isFinite(input.computedGross) || input.computedGross <= 0) return []

  const impliedSplit = (input.computedAgentNet / input.computedGross) * 100
  const diff = Math.abs(impliedSplit - contract)
  if (diff < tolerancePct) return []
  return [{
    field: "agent_split",
    expected: Math.round(contract * 10) / 10,
    actual: Math.round(impliedSplit * 10) / 10,
    deltaPct: Math.round(diff * 10) / 10,
    severity: diff >= blockerPct ? "blocker" : "warning",
  }]
}

/**
 * PURE: sum an agent's OUTSTANDING (unpaid, collectible) fee charges — the amount that must be
 * DEDUCTED in the CDA so the brokerage collects what the agent owes it at disbursement. Only
 * open/overdue, never-paid charges count; paid/waived/disputed are excluded (a disputed charge
 * isn't collectible until resolved). Honest zero when nothing is owed.
 */
export function sumOutstandingAgentFees(
  charges: Array<{ amount?: number | string | null; status?: string | null; paid_at?: string | null }>,
): number {
  let total = 0
  for (const c of charges ?? []) {
    const status = (c.status ?? "").toLowerCase()
    if (status !== "open" && status !== "overdue") continue
    if (c.paid_at) continue
    const amt = Number(c.amount ?? 0)
    if (Number.isFinite(amt) && amt > 0) total += amt
  }
  return Math.round(total * 100) / 100
}

/**
 * PURE: verify the CDA DEDUCTS the agent's outstanding fees. In the real CDA the agent's take-home
 * = (gross × contract split, cap-adjusted) − outstanding fees owed to the brokerage. So the expected
 * agent_net is POST-fee. Two failure modes are characterized distinctly:
 *   • agent_net ≈ the PRE-fee split share  → the fees were NOT deducted (a BLOCKER — the brokerage
 *     would disburse the agent's full share and never collect the fees it's owed).
 *   • agent_net is otherwise off from post-fee expected → a net mismatch (warning/blocker by size).
 * Fires only when there ARE outstanding fees; otherwise the plain split check governs.
 */
export function checkFeeDeductionAgainstContract(input: {
  computedGross: number
  computedAgentNet: number
  contractSplitPct: number | null | undefined
  outstandingFees: number
  tolerancePct?: number
  minDollar?: number
  blockerPct?: number
}): CdaDiscrepancy[] {
  const tolerancePct = input.tolerancePct ?? 1.5
  const minDollar = input.minDollar ?? 50
  const blockerPct = input.blockerPct ?? 5
  const split = input.contractSplitPct
  const fees = Math.max(0, input.outstandingFees ?? 0)
  if (split == null || !Number.isFinite(split) || split <= 0) return []
  if (!Number.isFinite(input.computedGross) || input.computedGross <= 0) return []
  if (fees <= 0) return []

  const preFeeShare = input.computedGross * (split / 100)
  const expectedNet = preFeeShare - fees
  const diff = Math.abs(input.computedAgentNet - expectedNet)
  const pct = (diff / input.computedGross) * 100
  if (diff < minDollar || pct < tolerancePct) return []

  const feeTolerance = Math.max(minDollar, (input.computedGross * tolerancePct) / 100)
  const notDeducted = Math.abs(input.computedAgentNet - preFeeShare) <= feeTolerance
  return [{
    field: notDeducted ? "outstanding_fee_deduction" : "agent_net",
    expected: Math.round(expectedNet),
    actual: Math.round(input.computedAgentNet),
    deltaPct: Math.round(pct * 10) / 10,
    severity: notDeducted ? "blocker" : (pct >= blockerPct ? "blocker" : "warning"),
  }]
}

/**
 * PURE: the full Compliance contract verdict — combines the gross compare and the split-vs-contract
 * compare into one go/no-go the compliance officer sees before approving the CDA. `contractSplitPct`
 * is the agent's CONTRACT split already adjusted for cap status (a capped agent keeps 100%, so the
 * caller passes 100 when the cap is met). When the agent has OUTSTANDING FEES, the split check is
 * replaced by the fee-aware net check (expected agent_net is post-fee), so a CDA that fails to deduct
 * the fees is flagged distinctly. `passed` is false iff any discrepancy is a BLOCKER — warnings
 * surface but don't block (compliance can still approve on a small, explainable delta).
 */
export function buildCdaContractVerdict(input: {
  computedGross: number
  computedAgentNet: number
  expectedGross: number | null | undefined
  contractSplitPct: number | null | undefined
  /** Outstanding (unpaid) fees the agent owes the brokerage — must be deducted in the CDA. */
  outstandingFees?: number | null
}): { passed: boolean; discrepancies: CdaDiscrepancy[] } {
  const fees = Math.max(0, input.outstandingFees ?? 0)
  const netCheck = fees > 0
    ? checkFeeDeductionAgainstContract({
        computedGross: input.computedGross,
        computedAgentNet: input.computedAgentNet,
        contractSplitPct: input.contractSplitPct,
        outstandingFees: fees,
      })
    : checkSplitAgainstContract({
        computedGross: input.computedGross,
        computedAgentNet: input.computedAgentNet,
        contractSplitPct: input.contractSplitPct,
      })
  const discrepancies = [
    ...computeCdaDiscrepancies({ computedGross: input.computedGross, expectedGross: input.expectedGross }),
    ...netCheck,
  ]
  return { passed: !discrepancies.some(d => d.severity === "blocker"), discrepancies }
}
