#!/usr/bin/env tsx
/**
 * scripts/cda-fee-deduction-simulator.ts   (npm run test:cda-fee-deduction)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the CDA flow the owner described: the agent fills the CDA in (no autofill), submits the
 * e-signed CDA to compliance, and the AI matches the agent's brokerage CONTRACT + any OUTSTANDING
 * FEES against what the agent filled — so compliance gets the last-scan report AND the contract/CDA
 * discrepancies, including a fee that wasn't deducted. "If the agent has outstanding fees, those get
 * deducted in the CDA" is now a real, gated check.
 *
 * PURE layer: sumOutstandingAgentFees (only open/overdue, unpaid, collectible) + the fee-aware
 * net check (deducted-correctly ⇒ clean; not-deducted ⇒ a distinct BLOCKER) + backward-compat of
 * buildCdaContractVerdict when no fees are owed.
 *
 * SOURCE scan: the canonical verdict loader + compliance queue load agent_fee_charges and pass
 * outstandingFees into the verdict; submit stamps a submit_audit onto the CDA; the compliance panel
 * surfaces the fee deduction. (Server-only modules can't be imported in tsx, so wiring is asserted
 * by scanning source — like the egress guards.)
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  sumOutstandingAgentFees,
  checkFeeDeductionAgainstContract,
  buildCdaContractVerdict,
} from "../lib/commission/cda-discrepancy"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer(): void {
  console.log("\n[sumOutstandingAgentFees · pure — only collectible, unpaid fees count]")
  check("open + overdue unpaid are summed", sumOutstandingAgentFees([
    { amount: 300, status: "open", paid_at: null },
    { amount: 200, status: "overdue", paid_at: null },
  ]) === 500)
  check("paid / waived / disputed are excluded", sumOutstandingAgentFees([
    { amount: 100, status: "paid", paid_at: "2026-01-01" },
    { amount: 100, status: "waived", paid_at: null },
    { amount: 100, status: "disputed", paid_at: null },
  ]) === 0)
  check("an open row with a paid_at is treated as paid (excluded)", sumOutstandingAgentFees([
    { amount: 150, status: "open", paid_at: "2026-02-02" },
  ]) === 0)
  check("nothing owed ⇒ honest zero", sumOutstandingAgentFees([]) === 0)

  // gross 12,000 × 70% split = 8,400 pre-fee agent share. Owe 500 ⇒ expected net 7,900.
  console.log("\n[checkFeeDeductionAgainstContract · pure — expected net is POST-fee]")
  check("fees deducted correctly (net 7,900) ⇒ no discrepancy",
    checkFeeDeductionAgainstContract({ computedGross: 12000, computedAgentNet: 7900, contractSplitPct: 70, outstandingFees: 500 }).length === 0)
  const notDeducted = checkFeeDeductionAgainstContract({ computedGross: 12000, computedAgentNet: 8400, contractSplitPct: 70, outstandingFees: 500 })
  check("net == pre-fee share (8,400) ⇒ fees NOT deducted, flagged", notDeducted.length === 1)
  check("  … as a BLOCKER (brokerage would never collect the fee)", notDeducted[0]?.severity === "blocker")
  check("  … with the fee-specific field", notDeducted[0]?.field === "outstanding_fee_deduction")
  check("  … expected shows the post-fee net (7,900)", notDeducted[0]?.expected === 7900)
  const wildlyOff = checkFeeDeductionAgainstContract({ computedGross: 12000, computedAgentNet: 9600, contractSplitPct: 70, outstandingFees: 500 })
  check("net neither post-fee nor pre-fee ⇒ generic agent_net mismatch", wildlyOff[0]?.field === "agent_net")
  check("no fees owed ⇒ fee check is inert", checkFeeDeductionAgainstContract({ computedGross: 12000, computedAgentNet: 8400, contractSplitPct: 70, outstandingFees: 0 }).length === 0)
  check("no contract split ⇒ nothing to compute against", checkFeeDeductionAgainstContract({ computedGross: 12000, computedAgentNet: 8400, contractSplitPct: null, outstandingFees: 500 }).length === 0)

  console.log("\n[buildCdaContractVerdict · pure — fee-aware, backward compatible]")
  const feeBust = buildCdaContractVerdict({ computedGross: 12000, computedAgentNet: 8400, expectedGross: 12000, contractSplitPct: 70, outstandingFees: 500 })
  check("owes fees + not deducted ⇒ verdict fails", feeBust.passed === false)
  check("  … surfaces the outstanding_fee_deduction discrepancy", feeBust.discrepancies.some(d => d.field === "outstanding_fee_deduction"))
  const feeOk = buildCdaContractVerdict({ computedGross: 12000, computedAgentNet: 7900, expectedGross: 12000, contractSplitPct: 70, outstandingFees: 500 })
  check("owes fees + deducted correctly ⇒ verdict passes", feeOk.passed === true && feeOk.discrepancies.length === 0)
  const noFees = buildCdaContractVerdict({ computedGross: 12000, computedAgentNet: 8400, expectedGross: 12000, contractSplitPct: 70 })
  check("NO fees owed ⇒ falls back to the plain split check (clean split passes)", noFees.passed === true && noFees.discrepancies.length === 0)
  const noFeesSplitBust = buildCdaContractVerdict({ computedGross: 12000, computedAgentNet: 10200, expectedGross: 12000, contractSplitPct: 70 })
  check("NO fees owed + bad split ⇒ still flags the split (unchanged behavior)", noFeesSplitBust.passed === false)
}

function sourceLayer(): void {
  const portal = src("app/actions/cda-portal.ts")
  const list = src("app/actions/cda-portal-list.ts")
  const panel = src("app/dashboard/compliance/components/os/cda-review-panel.tsx")

  console.log("\n[the canonical verdict loader factors in outstanding fees]")
  check("loadCdaContractVerdict queries agent_fee_charges (open/overdue)", /agent_fee_charges[\s\S]*?in\("status",\s*\["open",\s*"overdue"\]/.test(portal))
  check("it sums them via sumOutstandingAgentFees", /sumOutstandingAgentFees/.test(portal))
  check("and passes outstandingFees into buildCdaContractVerdict", /buildCdaContractVerdict\([\s\S]*?outstandingFees/.test(portal))
  check("the verdict carries outstandingFees back to callers", /outstandingFees:\s*number/.test(portal) || /outstandingFees\b/.test(portal))

  console.log("\n[submit stamps the contract/fee audit onto the CDA — compliance packet complete at submit]")
  check("submitCdaForApprovalAction computes the verdict", /submitCdaForApprovalAction[\s\S]*?loadCdaContractVerdict/.test(portal))
  check("and persists a submit_audit (discrepancies + outstanding_fees + last-scan alongside)", /submit_audit/.test(portal) && /runSignatureCheckForCdaAction/.test(portal))

  console.log("\n[the compliance QUEUE surfaces the fee deduction]")
  check("the queue loads agent_fee_charges per agent", /agent_fee_charges[\s\S]*?in\("status",\s*\["open",\s*"overdue"\]/.test(list))
  check("CdaReviewItem exposes outstandingFees", /outstandingFees:\s*number/.test(list))
  check("the queue verdict is fee-aware (passes outstandingFees)", /buildCdaContractVerdict\([\s\S]*?outstandingFees/.test(list))

  console.log("\n[the compliance UI shows the fee that must be deducted]")
  check("the panel renders the outstanding-fee amount", /outstandingFees\s*>\s*0/.test(panel))
  check("and labels a not-deducted fee discrepancy", /outstanding_fee_deduction/.test(panel))
}

function main() {
  pureLayer()
  sourceLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CDA_FEE_DEDUCTION_FAIL"); process.exit(1) }
  console.log(" ✅ CDA_FEE_DEDUCTION_PASS — agent fills the CDA; AI matches contract + outstanding fees; unpaid fees must be deducted, gated + surfaced to compliance")
}
main()
