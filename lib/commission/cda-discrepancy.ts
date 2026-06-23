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
 * PURE: the full Compliance contract verdict — combines the gross compare and the split-vs-contract
 * compare into one go/no-go the compliance officer sees before approving the CDA. `contractSplitPct`
 * is the agent's CONTRACT split already adjusted for cap status (a capped agent keeps 100%, so the
 * caller passes 100 when the cap is met). `passed` is false iff any discrepancy is a BLOCKER —
 * warnings surface but don't block (compliance can still approve on a small, explainable delta).
 */
export function buildCdaContractVerdict(input: {
  computedGross: number
  computedAgentNet: number
  expectedGross: number | null | undefined
  contractSplitPct: number | null | undefined
}): { passed: boolean; discrepancies: CdaDiscrepancy[] } {
  const discrepancies = [
    ...computeCdaDiscrepancies({ computedGross: input.computedGross, expectedGross: input.expectedGross }),
    ...checkSplitAgainstContract({
      computedGross: input.computedGross,
      computedAgentNet: input.computedAgentNet,
      contractSplitPct: input.contractSplitPct,
    }),
  ]
  return { passed: !discrepancies.some(d => d.severity === "blocker"), discrepancies }
}
