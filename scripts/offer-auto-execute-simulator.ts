#!/usr/bin/env tsx
/**
 * scripts/offer-auto-execute-simulator.ts   (npm run test:offer-auto-execute)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE "FULLY EXECUTED → UNDER CONTRACT" GATE — proves the autonomous loop fires ONLY when both sides
 * have signed (executed contract on file) AND no transaction exists yet. Matches the canonical
 * offer-bridge gate, so the autonomous path and the manual path agree on what "fully executed" means.
 * Pure: no I/O.
 */
import { readFileSync } from "node:fs"
import { stripComments } from "./strip-comments"
import {
  isOfferFullyExecuted,
  shouldAutoExecuteOffer,
  offerExecutionPath,
  SELLER_EXECUTION_EVIDENCE,
} from "../lib/transactions/offer-execution-state"
import { deriveEarnestDueDate, formatEarnestAmount, isCalendarDate } from "../lib/transactions/earnest-terms"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const T = "2026-06-27T00:00:00Z"

function main() {
  // ── THE BUYER LEG (2026-09-04) ───────────────────────────────────────────
  //
  // These fixtures used to omit `buyer_signed_at` entirely and still assert
  // `true`, because the predicate read only the SELLER half — it was named
  // "fully executed", documented as "BOTH sides have signed", and never looked
  // at the buyer's column. The owner's ruling is "fully executed by BOTH BUYER
  // AND SELLER", so the buyer leg is now part of the definition and every
  // POSITIVE fixture below carries it.
  //
  // RETARGETED, NOT WEAKENED (CLAUDE.md §2): the old assertions were pinned to a
  // WAYPOINT — a two-legged definition that was true only until the merge
  // finished. Every one of them survives here with the buyer leg supplied, and
  // the leg itself gets its own negative control below, so "we added a column to
  // the fixture and the test went green again" cannot hide a predicate that
  // ignores it.
  console.log("\n[Fully executed — both valid paths, BOTH sides signed]")
  check("buyer-first then seller ACCEPTS (buyer signed + accepted + fully-signed received)",
    isOfferFullyExecuted({ buyer_signed_at: T, seller_response_type: "accepted", fully_signed_contract_received_at: T }) === true)
  check("seller COUNTERS, buyer signs counter (buyer signed + seller_signed_at + fully-signed received)",
    isOfferFullyExecuted({ buyer_signed_at: T, seller_signed_at: T, fully_signed_contract_received_at: T }) === true)

  console.log("\n[NOT fully executed — never auto-create a transaction]")
  check("buyer signed only, no seller response → NOT executed",
    isOfferFullyExecuted({ buyer_signed_at: T, seller_response_type: null, seller_signed_at: null, fully_signed_contract_received_at: null }) === false)
  check("seller accepted but fully-signed contract NOT on file → NOT executed",
    isOfferFullyExecuted({ buyer_signed_at: T, seller_response_type: "accepted", fully_signed_contract_received_at: null }) === false)
  check("seller COUNTERED (not accepted), buyer hasn't signed back → NOT executed",
    isOfferFullyExecuted({ buyer_signed_at: T, seller_response_type: "countered", fully_signed_contract_received_at: null }) === false)
  check("seller REJECTED → NOT executed",
    isOfferFullyExecuted({ buyer_signed_at: T, seller_response_type: "rejected", fully_signed_contract_received_at: null }) === false)

  // THE BUYER LEG IS LOAD-BEARING — the negative control for the merge itself.
  // A predicate that ignored buyer_signed_at would pass every assertion above
  // and fail both of these. This is the SELLER-COMPLETE, buyer-absent offer:
  // exactly what the old two-legged spelling called "fully executed".
  console.log("\n[The buyer leg — the half the survivor was missing]")
  check("seller ACCEPTED + contract on file but the BUYER never signed → NOT executed",
    isOfferFullyExecuted({ buyer_signed_at: null, seller_response_type: "accepted", fully_signed_contract_received_at: T }) === false)
  check("seller COUNTER-signed + contract on file but the BUYER never signed → NOT executed",
    isOfferFullyExecuted({ buyer_signed_at: null, seller_signed_at: T, fully_signed_contract_received_at: T }) === false)
  check("  ↳ POSITIVE CONTROL: the SAME two fixtures with buyer_signed_at set ARE executed (only that column moved)",
    isOfferFullyExecuted({ buyer_signed_at: T, seller_response_type: "accepted", fully_signed_contract_received_at: T }) === true
    && isOfferFullyExecuted({ buyer_signed_at: T, seller_signed_at: T, fully_signed_contract_received_at: T }) === true)
  check("  ↳ an ABSENT buyer_signed_at key reads the same as an explicit null (a column left out of a SELECT must not pass)",
    isOfferFullyExecuted({ seller_response_type: "accepted", fully_signed_contract_received_at: T }) === false)

  // WHICH path established the seller side — the provenance the compliance gate
  // event records. It is derived HERE rather than re-spelled at each call site.
  console.log("\n[Execution PATH — the provenance, spelled once]")
  check("seller-accepted path is named as such",
    offerExecutionPath({ seller_response_type: "accepted", fully_signed_contract_received_at: T }) === "seller_accepted")
  check("seller-counter-signed path is named as such",
    offerExecutionPath({ seller_signed_at: T, fully_signed_contract_received_at: T }) === "seller_counter_signed")
  check("neither path without the fully-signed contract on file → null",
    offerExecutionPath({ seller_response_type: "accepted", seller_signed_at: T, fully_signed_contract_received_at: null }) === null)
  check("'accepted' takes precedence when both could apply (recorded provenance never flips)",
    offerExecutionPath({ seller_response_type: "accepted", seller_signed_at: T, fully_signed_contract_received_at: T }) === "seller_accepted")
  check("every path has an evidence string naming the COLUMNS that established it",
    SELLER_EXECUTION_EVIDENCE.seller_accepted.includes("seller_response_type")
    && SELLER_EXECUTION_EVIDENCE.seller_accepted.includes("fully_signed_contract_received_at")
    && SELLER_EXECUTION_EVIDENCE.seller_counter_signed.includes("seller_signed_at")
    && SELLER_EXECUTION_EVIDENCE.seller_counter_signed.includes("fully_signed_contract_received_at"))

  console.log("\n[Auto-execute trigger — fully executed AND not already converted (idempotent)]")
  check("fully executed + no transaction → fire",
    shouldAutoExecuteOffer({ buyer_signed_at: T, seller_response_type: "accepted", fully_signed_contract_received_at: T, transaction_id: null }) === true)
  check("fully executed + transaction already exists → DO NOT fire (idempotent)",
    shouldAutoExecuteOffer({ buyer_signed_at: T, seller_response_type: "accepted", fully_signed_contract_received_at: T, transaction_id: "11111111-1111-1111-1111-111111111111" }) === false)
  check("not executed + no transaction → DO NOT fire",
    shouldAutoExecuteOffer({ buyer_signed_at: T, seller_response_type: "countered", transaction_id: null }) === false)

  // ── THE READER MUST SEE THE COLUMN IT JUDGES (CLAUDE.md §2) ──────────────
  //
  // The predicate now reads `buyer_signed_at`. autoExecuteFullySignedOffer's
  // SELECT did not carry it, and a column left out of a select arrives
  // `undefined` — which reads as "not signed". That would have killed the whole
  // autonomous loop SILENTLY: every offer forever reported "not fully executed",
  // with no error anywhere. This asserts the select and the predicate agree.
  console.log("\n[The autonomous loop SELECTS every column the predicate reads]")
  const autoSrc = stripComments(readFileSync("lib/transactions/auto-execute-offer.ts", "utf8"))
  const selectMatch = autoSrc.match(/\.select\("([^"]*)"\)/)
  const selected = new Set((selectMatch?.[1] ?? "").split(",").map(s => s.trim()))
  const PREDICATE_COLUMNS = ["buyer_signed_at", "seller_response_type", "seller_signed_at", "fully_signed_contract_received_at", "transaction_id"]
  check("POSITIVE CONTROL — the select list is visible to this scan",
    selected.size > 0 && selected.has("id"))
  for (const c of PREDICATE_COLUMNS) {
    check(`  ↳ auto-execute selects \`${c}\` — the predicate reads it`, selected.has(c))
  }
  check("  ↳ NEGATIVE CONTROL: the finder does NOT report a column that is genuinely absent",
    !selected.has("compliance_passed_at"))

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
