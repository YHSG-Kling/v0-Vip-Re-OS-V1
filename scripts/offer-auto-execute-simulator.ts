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

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ OFFER_AUTO_EXECUTE_FAIL"); process.exit(1) }
  console.log(" ✅ OFFER_AUTO_EXECUTE_PASS — both sides signed + compliant → transaction auto-created under contract; never premature, never double")
}

main()
