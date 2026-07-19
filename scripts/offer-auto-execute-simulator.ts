#!/usr/bin/env tsx
/**
 * scripts/offer-auto-execute-simulator.ts   (npm run test:offer-auto-execute)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE "FULLY EXECUTED → UNDER CONTRACT" GATE — proves the autonomous loop fires ONLY when both sides
 * have signed (executed contract on file) AND no transaction exists yet. Matches the canonical
 * offer-bridge gate, so the autonomous path and the manual path agree on what "fully executed" means.
 * Pure: no I/O.
 */
import { isOfferFullyExecuted, shouldAutoExecuteOffer } from "../lib/transactions/offer-execution-state"
import { deriveEarnestDueDate, formatEarnestAmount, isCalendarDate } from "../lib/transactions/earnest-terms"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const T = "2026-06-27T00:00:00Z"

function main() {
  console.log("\n[Fully executed — both valid paths]")
  check("buyer-first then seller ACCEPTS (accepted + fully-signed received)",
    isOfferFullyExecuted({ seller_response_type: "accepted", fully_signed_contract_received_at: T }) === true)
  check("seller COUNTERS, buyer signs counter (seller_signed_at + fully-signed received)",
    isOfferFullyExecuted({ seller_signed_at: T, fully_signed_contract_received_at: T }) === true)

  console.log("\n[NOT fully executed — never auto-create a transaction]")
  check("buyer signed only, no seller response → NOT executed",
    isOfferFullyExecuted({ seller_response_type: null, seller_signed_at: null, fully_signed_contract_received_at: null }) === false)
  check("seller accepted but fully-signed contract NOT on file → NOT executed",
    isOfferFullyExecuted({ seller_response_type: "accepted", fully_signed_contract_received_at: null }) === false)
  check("seller COUNTERED (not accepted), buyer hasn't signed back → NOT executed",
    isOfferFullyExecuted({ seller_response_type: "countered", fully_signed_contract_received_at: null }) === false)
  check("seller REJECTED → NOT executed",
    isOfferFullyExecuted({ seller_response_type: "rejected", fully_signed_contract_received_at: null }) === false)

  console.log("\n[Auto-execute trigger — fully executed AND not already converted (idempotent)]")
  check("fully executed + no transaction → fire",
    shouldAutoExecuteOffer({ seller_response_type: "accepted", fully_signed_contract_received_at: T, transaction_id: null }) === true)
  check("fully executed + transaction already exists → DO NOT fire (idempotent)",
    shouldAutoExecuteOffer({ seller_response_type: "accepted", fully_signed_contract_received_at: T, transaction_id: "11111111-1111-1111-1111-111111111111" }) === false)
  check("not executed + no transaction → DO NOT fire",
    shouldAutoExecuteOffer({ seller_response_type: "countered", transaction_id: null }) === false)

  // ── Earnest AMOUNT (currency) vs earnest DUE (date) — owner correction R28: never conflated ──
  console.log("\n[Earnest amount renders as currency, earnest DUE renders as a date — never conflated]")
  check("earnest AMOUNT renders as currency ($X)",
    formatEarnestAmount(5000) === "$5,000")
  check("absent earnest amount → em dash, never a date",
    formatEarnestAmount(null) === "—")
  check("earnest DUE derives from contract_date + due_days as a calendar date",
    deriveEarnestDueDate({ contractDate: "2026-06-27", earnestMoneyDueDays: 3 }) === "2026-06-30")
  check("earnest DUE derived value is a real calendar date, not a currency string",
    isCalendarDate(deriveEarnestDueDate({ contractDate: "2026-06-27", earnestMoneyDueDays: 3 })) === true)
  check("earnest DUE falls back to stored earnest_money_due_at (date portion)",
    deriveEarnestDueDate({ earnestMoneyDueAt: "2026-07-05T00:00:00Z" }) === "2026-07-05")
  check("a mis-passed DOLLAR AMOUNT ('$5000') is REFUSED as the due date (guard)",
    deriveEarnestDueDate({ fallbackDue: "$5000" }) === undefined)
  check("a bare numeric amount ('5000') is REFUSED as the due date (guard)",
    deriveEarnestDueDate({ fallbackDue: "5000" }) === undefined)
  check("a genuine date fallback IS accepted as the due date",
    deriveEarnestDueDate({ fallbackDue: "2026-07-05" }) === "2026-07-05")
  check("'$5000' is not a calendar date; '2026-07-05' is (the two are never conflated)",
    isCalendarDate("$5000") === false && isCalendarDate("2026-07-05") === true)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ OFFER_AUTO_EXECUTE_FAIL"); process.exit(1) }
  console.log(" ✅ OFFER_AUTO_EXECUTE_PASS — both sides signed + compliant → transaction auto-created under contract; never premature, never double")
}

main()
