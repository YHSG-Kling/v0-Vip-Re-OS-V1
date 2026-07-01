#!/usr/bin/env tsx
/**
 * scripts/commission-set-in-stone-simulator.ts   (npm run test:commission-set-in-stone)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the CORRECTED money lifecycle: CLOSE (final CD, both signed) FREEZES the commission amount —
 * it does NOT pay. Close ≠ paid. The ledger tracks the money AFTER close (deposit received →
 * disbursed); 'paid' is stamped at DISBURSEMENT, not at close. The full spine:
 *   final calc → (CDA broker-sign → approved) → CLOSE freezes the amount (non-CDA auto-approves) →
 *   deposit received (ledger) → DISBURSEMENT locks BOTH trackings to paid.
 *
 * SOURCE scan (the CLOSED transition is server-only): close calls finalizeCommissionAtClose (freeze,
 * not pay), never force-pays at close; disbursement (kernel markCommissionPaid) is where the ledger
 * lock lives.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function main() {
  const sp = src("lib/transactions/stage-progression.ts")
  const closedIdx = sp.indexOf('params.targetStage === "CLOSED"')
  const block = sp.slice(closedIdx, closedIdx + 3200)

  console.log("\n[CLOSE FREEZES the amount — it does NOT pay (close ≠ paid)]")
  check("CLOSE runs the FINAL commission calc first (freezes the numbers)", /calculationMode:\s*'final'/.test(block))
  check("CLOSE calls finalizeCommissionAtClose (freeze, not pay)", /finalizeCommissionAtClose/.test(block))
  check("CLOSE does NOT force agent_commissions to 'paid'", !/agent_commissions[\s\S]{0,400}status:\s*"paid"/.test(block))
  check("CLOSE does NOT reconcile the ledger to paid at close (that moved to disbursement)", !/reconcileCommissionTrackingAtClose|reconcileCommissionDisbursement/.test(block))

  console.log("\n[non-CDA brokerages auto-APPROVE at close (no CDA broker-sign exists)]")
  const rec = src("lib/commission/reconcile-tracking.ts")
  check("finalizeCommissionAtClose reads brokerages.offers_cda", /finalizeCommissionAtClose[\s\S]*?offers_cda/.test(rec))
  check("non-CDA path auto-approves pending → approved (uniform disbursement path)", /offersCda[\s\S]*?status:\s*"approved"/.test(rec))
  check("CDA brokerages are left to the broker's CDA signature (no auto-approve)", /if\s*\(offersCda\)\s*return/.test(rec))

  console.log("\n[the ledger tracks the DEPOSIT between close and disbursement]")
  check("recordCommissionDepositReceived stamps deposit_received_at", /recordCommissionDepositReceived[\s\S]*?deposit_received_at/.test(rec))
  check("deposit stamp is idempotent (only rows not already marked)", /is\("deposit_received_at",\s*null\)/.test(rec))

  console.log("\n[DISBURSEMENT is the ONE LOCK — both trackings go paid together, at payout]")
  const fin = src("lib/kernel/financial.ts")
  check("kernel markCommissionPaid locks the ledger via reconcileCommissionDisbursement", /markCommissionPaid[\s\S]*?reconcileCommissionDisbursement/.test(fin))
  check("reconcileCommissionDisbursement reuses the canonical payment path", /reconcileCommissionDisbursement[\s\S]*?markCommissionPaid/.test(rec))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ COMMISSION_SET_IN_STONE_FAIL"); process.exit(1) }
  console.log(" ✅ COMMISSION_SET_IN_STONE_PASS — close FREEZES the amount; the ledger tracks deposit→disbursement; paid is stamped at disbursement, not close")
}
main()
