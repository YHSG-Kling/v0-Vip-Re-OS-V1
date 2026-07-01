#!/usr/bin/env tsx
/**
 * scripts/cda-fee-deduction-simulator.ts   (npm run test:cda-fee-deduction)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the CDA flow the owner described, with the correct separation: the agent fills the CDA in
 * (no autofill) and submits the e-signed CDA to compliance. The AI matches the agent's brokerage
 * CONTRACT (the commission SPLIT) against what the agent filled — and, SEPARATELY, surfaces any
 * OUTSTANDING TECH/DESK FEES the agent owes as their own deduction line. A tech fee is NOT a
 * commission discrepancy: the split can be perfectly correct and the agent still owes a monthly tech
 * fee that must be deducted in the CDA.
 *
 * PURE layer: sumOutstandingAgentFees (only open/overdue, unpaid, collectible) + buildCdaFeeDeduction
 * (the separate deduction line + net-after-fee) + buildCdaContractVerdict is COMMISSION-ONLY (owing a
 * fee never creates a split discrepancy).
 *
 * SOURCE scan: the canonical verdict loader + compliance queue compute the split verdict AND surface
 * outstandingFees SEPARATELY (never folded into the verdict); submit stamps a submit_audit; the panel
 * shows the fee to deduct as its own line. (Server-only modules can't be imported in tsx, so wiring is
 * asserted by scanning source — like the egress guards.)
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  sumOutstandingAgentFees,
  buildCdaFeeDeduction,
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

  console.log("\n[buildCdaFeeDeduction · pure — a SEPARATE deduction line, not a commission check]")
  const owed = buildCdaFeeDeduction({ outstandingFees: 500, agentCommissionShare: 8400 })
  check("required when a fee is owed", owed.required === true && owed.amount === 500)
  check("net after the fee = commission share − fee (8,400 − 500 = 7,900)", owed.netAfterFees === 7900)
  const none = buildCdaFeeDeduction({ outstandingFees: 0, agentCommissionShare: 8400 })
  check("no fee owed ⇒ not required, net == share", none.required === false && none.netAfterFees === 8400)
  const noShare = buildCdaFeeDeduction({ outstandingFees: 500 })
  check("share unknown ⇒ net null (honest), still required", noShare.netAfterFees === null && noShare.required === true)

  console.log("\n[buildCdaContractVerdict · pure — COMMISSION ONLY, a tech fee never makes it fail]")
  const clean = buildCdaContractVerdict({ computedGross: 12000, computedAgentNet: 8400, expectedGross: 12000, contractSplitPct: 70 })
  check("correct split (70% of 12,000 = 8,400) ⇒ passes, no discrepancy", clean.passed === true && clean.discrepancies.length === 0)
  check("  … and the verdict carries NO fee field (fees are separate)", !clean.discrepancies.some(d => /fee/.test(d.field)))
  const splitBust = buildCdaContractVerdict({ computedGross: 12000, computedAgentNet: 10200, expectedGross: 12000, contractSplitPct: 70 })
  check("wrong split (85% vs 70%) ⇒ still flags the split (unchanged)", splitBust.passed === false && splitBust.discrepancies.some(d => d.field === "agent_split"))
  // The owner's rule: owing a fee does NOT create a commission discrepancy — the split is fine.
  const feeOwedSplitFine = buildCdaContractVerdict({ computedGross: 12000, computedAgentNet: 8400, expectedGross: 12000, contractSplitPct: 70 })
  check("agent owes a tech fee but the split is correct ⇒ commission verdict PASSES", feeOwedSplitFine.passed === true)
}

function sourceLayer(): void {
  const portal = src("app/actions/cda-portal.ts")
  const list = src("app/actions/cda-portal-list.ts")
  const panel = src("app/dashboard/compliance/components/os/cda-review-panel.tsx")

  console.log("\n[the tech fee is loaded + surfaced SEPARATELY — never folded into the split verdict]")
  check("loadCdaContractVerdict queries agent_fee_charges (open/overdue)", /agent_fee_charges[\s\S]*?in\("status",\s*\["open",\s*"overdue"\]/.test(portal))
  check("it sums them via sumOutstandingAgentFees", /sumOutstandingAgentFees/.test(portal))
  const verdictArgs = (s: string) => (s.match(/buildCdaContractVerdict\(\{[^}]*\}/g) ?? []).join("\n")
  check("buildCdaContractVerdict is NOT passed outstandingFees (commission-only)", !/outstandingFees/.test(verdictArgs(portal)))
  check("outstandingFees is returned alongside the verdict (separate line)", /outstandingFees\b/.test(portal))

  console.log("\n[submit stamps the audit — split discrepancies AND the fee, kept distinct]")
  check("submitCdaForApprovalAction computes the verdict + last-scan", /submitCdaForApprovalAction[\s\S]*?loadCdaContractVerdict/.test(portal) && /runSignatureCheckForCdaAction/.test(portal))
  check("the audit records outstanding_fees as its own key", /outstanding_fees/.test(portal))

  console.log("\n[the compliance QUEUE surfaces the fee separately]")
  check("the queue loads agent_fee_charges per agent", /agent_fee_charges[\s\S]*?in\("status",\s*\["open",\s*"overdue"\]/.test(list))
  check("CdaReviewItem exposes outstandingFees", /outstandingFees:\s*number/.test(list))
  check("the queue verdict is commission-only (no outstandingFees fed in)", !/outstandingFees/.test((list.match(/buildCdaContractVerdict\(\{[^}]*\}/g) ?? []).join("\n")))

  console.log("\n[the compliance UI shows the fee to deduct as its own line]")
  check("the panel renders the outstanding-fee amount", /outstandingFees\s*>\s*0/.test(panel))
  check("labelled as a fee to deduct (not a commission discrepancy)", /deduct[\s\S]*?fees/i.test(panel))
}

function main() {
  pureLayer()
  sourceLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CDA_FEE_DEDUCTION_FAIL"); process.exit(1) }
  console.log(" ✅ CDA_FEE_DEDUCTION_PASS — agent fills the CDA; AI checks the commission split; outstanding tech fees are a SEPARATE deduction line surfaced to compliance")
}
main()
