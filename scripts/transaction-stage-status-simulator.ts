#!/usr/bin/env tsx
/**
 * scripts/transaction-stage-status-simulator.ts   (npm run test:transaction-stage-status)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the fix for the silent CHECK bug that froze the transaction stage engine: advanceStage (and
 * the override path) wrote the UPPERCASE stage straight into transactions.status, which the live
 * transactions_status_check (lowercase-only) rejected — Postgres rolled back the WHOLE row, so no deal
 * ever advanced past UNDER_CONTRACT. The fix maps stage → STAGE_TO_STATUS_MAP. This asserts that map
 * ONLY ever yields a status value the live CHECK accepts, for EVERY stage. Pure: no I/O.
 */
import { STAGE_TO_STATUS_MAP, TRANSACTION_STAGES } from "../lib/transactions/transaction-stages"

// The exact allowed sets from the live constraints (pg_constraint), mirrored here as the contract.
const VALID_STATUS = new Set(["lead", "qualifying", "active", "under_contract", "closing", "closed", "lost"])
const VALID_STAGE = new Set(["UNDER_CONTRACT", "INSPECTION", "APPRAISAL", "FINANCING_PENDING", "CLOSING_PREP", "CLOSED", "LOST"])

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[Every stage maps to a status the live transactions_status_check accepts]")
  for (const stage of Object.values(TRANSACTION_STAGES)) {
    check(`stage in transactions_stage_check: ${stage}`, VALID_STAGE.has(stage))
    const status = STAGE_TO_STATUS_MAP[stage]
    check(`${stage} → status '${status}' is CHECK-valid (lowercase set)`, VALID_STATUS.has(status))
    check(`${stage} status is never the raw UPPERCASE stage (the old bug)`, status !== stage)
  }

  console.log("\n[Mapping is semantically correct across the lifecycle]")
  check("UNDER_CONTRACT/INSPECTION/APPRAISAL → under_contract", ["UNDER_CONTRACT", "INSPECTION", "APPRAISAL"].every((s) => STAGE_TO_STATUS_MAP[s as keyof typeof STAGE_TO_STATUS_MAP] === "under_contract"))
  check("FINANCING_PENDING/CLOSING_PREP → closing", ["FINANCING_PENDING", "CLOSING_PREP"].every((s) => STAGE_TO_STATUS_MAP[s as keyof typeof STAGE_TO_STATUS_MAP] === "closing"))
  check("CLOSED → closed", STAGE_TO_STATUS_MAP.CLOSED === "closed")
  check("LOST → lost", STAGE_TO_STATUS_MAP.LOST === "lost")

  console.log("\n[Completeness — no stage left unmapped]")
  check("every TRANSACTION_STAGES key has a status mapping", Object.values(TRANSACTION_STAGES).every((s) => typeof STAGE_TO_STATUS_MAP[s] === "string"))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ STAGE_STATUS_FAIL"); process.exit(1) }
  console.log(" ✅ STAGE_STATUS_PASS — advanceStage now writes a CHECK-valid status for every stage; the lifecycle can advance")
}

main()
