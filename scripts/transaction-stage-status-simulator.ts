#!/usr/bin/env tsx
/**
 * scripts/transaction-stage-status-simulator.ts   (npm run test:transaction-stage-status)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the fix for the silent CHECK bug that froze the transaction stage engine: advanceStage (and
 * the override path) wrote the UPPERCASE stage straight into transactions.status, which the live
 * transactions_status_check (lowercase-only) rejected — Postgres rolled back the WHOLE row, so no deal
 * ever advanced past UNDER_CONTRACT. The fix maps stage → STAGE_TO_STATUS_MAP. This asserts that map
 * ONLY ever yields a status value the live CHECK accepts, for EVERY stage. Pure: no I/O.
 *
 * ── WHY THIS FILE WAS REWRITTEN (2026-08-26) ────────────────────────────────
 * It used to hand-mirror the allowed set as a literal — `["lead","qualifying","active",
 * "under_contract","closing","closed","lost"]` — and then assert, in so many words, that
 * FINANCING_PENDING/CLOSING_PREP map to `closing`. m291 had ALREADY removed `closing` from the
 * column and put the real ladder there (under_contract → pending → clear_to_close → closed →
 * funded). So this guard was green for months while both writers below still lost the WHOLE row to
 * 23514, and no deal persisted an advance past APPRAISAL. CLAUDE.md §2: do not pin an assertion to
 * a waypoint, and check a hardcoded vocabulary against the generated live cache. Both sets are now
 * DERIVED from scripts/check-vocabularies.ts (machine-written from public.live_check_constraints_json,
 * drift-guarded by scripts/schema-cache-drift-guard.ts), so the day the column changes, this fails.
 */
import { STAGE_TO_STATUS_MAP, TRANSACTION_STAGES } from "../lib/transactions/transaction-stages"
import { TRANSACTION_STATUSES } from "../lib/transactions/transaction-status"
import { CHECK_VOCABULARIES } from "./check-vocabularies"

// DERIVED, never mirrored — the live CHECK vocabularies as generated from the database.
const VALID_STATUS = new Set(CHECK_VOCABULARIES.transactions?.status ?? [])
const VALID_STAGE = new Set(CHECK_VOCABULARIES.transactions?.stage ?? [])

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[The derived vocabularies are non-empty — a guard that sees nothing passes everything]")
  check(`transactions.status vocabulary loaded (${VALID_STATUS.size} values)`, VALID_STATUS.size > 0)
  check(`transactions.stage vocabulary loaded (${VALID_STAGE.size} values)`, VALID_STAGE.size > 0)

  console.log("\n[Every stage maps to a status the live transactions_status_check accepts]")
  for (const stage of Object.values(TRANSACTION_STAGES)) {
    check(`stage in transactions_stage_check: ${stage}`, VALID_STAGE.has(stage))
    const status = STAGE_TO_STATUS_MAP[stage]
    check(`${stage} → status '${status}' is CHECK-valid`, VALID_STATUS.has(status))
    // Compared as strings on purpose: STAGE_TO_STATUS_MAP is now typed
    // Record<TransactionStage, TransactionStatus>, so `tsc` already proves the two
    // sets disjoint. The runtime assertion stays as the guard for the day the type
    // is widened back to `string` — a type is not a substitute for a proof.
    check(`${stage} status is never the raw UPPERCASE stage (the old bug)`, (status as string) !== (stage as string))
  }

  console.log("\n[Mapping is semantically correct across the lifecycle — the ladder, not a scheduling word]")
  check("UNDER_CONTRACT/INSPECTION/APPRAISAL → under_contract (contingencies still live)",
    ["UNDER_CONTRACT", "INSPECTION", "APPRAISAL"].every((s) => STAGE_TO_STATUS_MAP[s as keyof typeof STAGE_TO_STATUS_MAP] === "under_contract"))
  check("FINANCING_PENDING → pending (inspection/appraisal cleared, lender still working)",
    STAGE_TO_STATUS_MAP.FINANCING_PENDING === "pending")
  check("CLOSING_PREP → clear_to_close (the lender has issued CTC)",
    STAGE_TO_STATUS_MAP.CLOSING_PREP === "clear_to_close")
  check("CLOSED → closed", STAGE_TO_STATUS_MAP.CLOSED === "closed")
  check("LOST → lost", STAGE_TO_STATUS_MAP.LOST === "lost")
  check("no stage maps to `closing` — the value m291 deleted from the column",
    Object.values(STAGE_TO_STATUS_MAP).every((s) => (s as string) !== "closing"))

  console.log("\n[The ONE vocabulary and the live CHECK agree — CLAUDE.md §6]")
  check("lib/transactions/transaction-status.ts lists exactly the live CHECK values",
    TRANSACTION_STATUSES.length === VALID_STATUS.size && TRANSACTION_STATUSES.every((s) => VALID_STATUS.has(s)))

  console.log("\n[Completeness — no stage left unmapped]")
  check("every TRANSACTION_STAGES key has a status mapping", Object.values(TRANSACTION_STAGES).every((s) => typeof STAGE_TO_STATUS_MAP[s] === "string"))

  console.log("\n[POSITIVE CONTROL — the finder still recognises the defect it was written for]")
  const POISONED: Record<string, string> = { ...STAGE_TO_STATUS_MAP, CLOSING_PREP: "closing" }
  const caught = Object.values(POISONED).some((s) => !VALID_STATUS.has(s))
  check("a `closing` status re-introduced into the map IS rejected by the derived vocabulary", caught)
  const caughtUpper = !VALID_STATUS.has("CLOSING_PREP")
  check("the ORIGINAL bug (raw UPPERCASE stage as status) IS rejected by the derived vocabulary", caughtUpper)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ STAGE_STATUS_FAIL"); process.exit(1) }
  console.log(" ✅ STAGE_STATUS_PASS — advanceStage writes a CHECK-valid status for every stage; the lifecycle can advance")
}

main()
