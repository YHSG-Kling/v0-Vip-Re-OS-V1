#!/usr/bin/env tsx
/**
 * scripts/deal-ladder-simulator.ts   (npm run test:deal-ladder) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEAL LADDER LIVES ON THE TRANSACTION. THE LISTING IS INVENTORY.
 *
 * OWNER-STATED PROCESS, two separate objects:
 *
 *   LISTING   listing signed → coming soon → active → withdrawn / cancelled /
 *             off market / sold
 *   DEAL      under contract → pending → clear to close → closed / sold → funded
 *
 * Both were wrong in the database, in opposite directions.
 *
 * ── transactions (m291) ─────────────────────────────────────────────────────
 * The column admitted `closing` and none of `pending`, `clear_to_close`,
 * `funded`. So the three states an agent actually chases could not be stored:
 *
 *   pending         contingencies cleared — off inspection/financing risk
 *   clear_to_close  the lender issued CTC — docs to title, figures final
 *   funded          the loan disbursed and the money moved
 *
 * `closed` and `funded` are not the same day and not the same risk. The agent is
 * paid at funded, which is exactly why the commission ledger cares about the gap.
 * `closing` is a scheduling word, not a milestone — it cannot tell you whether
 * the lender has signed off — so it is retired onto clear_to_close.
 *
 * FIVE surfaces had hand-rolled `["under_contract", "closing"]` to mean "a live
 * deal", each one silently missing the two states in between. They now share one
 * set. And the coordinator's own status colour map already had `case "pending"`
 * and `case "clear_to_close"` branches — the UI was written against this process
 * before the column could store it.
 *
 * ── listings (m292) ─────────────────────────────────────────────────────────
 * Missing listing_signed, cancelled, off_market outright. Additive by owner
 * direction: draft / pending / expired stay valid and no row moves, so no reader
 * can break.
 *
 * VERIFIED LIVE, both ladders walked end to end then deleted:
 *   under_contract → pending → clear_to_close → closed → funded
 *   listing_signed → coming_soon → active → off_market → cancelled → sold
 *   and `closing` is now refused (check_violation).
 */
import { readFileSync } from "node:fs"
import {
  TRANSACTION_STATUSES,
  TRANSACTION_STATUSES_IN_ESCROW,
  TRANSACTION_STATUSES_OPEN,
  TRANSACTION_STATUSES_TERMINAL,
  isTransactionStatus,
  isInEscrow,
  isOpenDeal,
  closeConfidence,
} from "../lib/transactions/transaction-status"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) =>
  stripComments(readFileSync(p, "utf8"))

console.log("\n── the deal ladder matches the live CHECK (m291) ──")
{
  const live = CHECK_VOCABULARIES.transactions?.status ?? []
  check(`transactions.status has 10 values (${live.length})`, live.length === 10)
  for (const v of ["under_contract", "pending", "clear_to_close", "closed", "funded"]) {
    check(`'${v}' is a real deal state`, live.includes(v))
  }
  check("'closing' is RETIRED — it was a scheduling word, not a milestone",
    !live.includes("closing"))
  check("the module declares exactly the live set",
    TRANSACTION_STATUSES.length === live.length &&
    TRANSACTION_STATUSES.every((s) => live.includes(s)) &&
    live.every((s) => (TRANSACTION_STATUSES as readonly string[]).includes(s)))
  check("'closing' is refused by the module too", !isTransactionStatus("closing"))
}

console.log("\n── closed is not funded ──")
{
  check("closed is terminal", (TRANSACTION_STATUSES_TERMINAL as readonly string[]).includes("closed"))
  check("funded is terminal too", (TRANSACTION_STATUSES_TERMINAL as readonly string[]).includes("funded"))
  check("they are two distinct values — the agent is paid at funded",
    TRANSACTION_STATUSES.indexOf("funded") > TRANSACTION_STATUSES.indexOf("closed"))
  check("neither is in escrow — escrow ends at the closing table",
    !isInEscrow("closed") && !isInEscrow("funded"))
  check("neither is an open deal", !isOpenDeal("closed") && !isOpenDeal("funded"))
}

console.log("\n── in-escrow is the set the five surfaces were reaching for ──")
{
  check("under_contract is in escrow", isInEscrow("under_contract"))
  check("pending is in escrow — the state the old filter MISSED", isInEscrow("pending"))
  check("clear_to_close is in escrow — the other state it missed", isInEscrow("clear_to_close"))
  check("active is NOT in escrow (no contract yet)", !isInEscrow("active"))
  check("lost is not in escrow", !isInEscrow("lost"))
  check("null never counts as a live deal", !isInEscrow(null) && !isOpenDeal(null))
  check("in-escrow ⊂ open", TRANSACTION_STATUSES_IN_ESCROW.every((s) => isOpenDeal(s)))
  check("open adds exactly 'active' on top of in-escrow",
    TRANSACTION_STATUSES_OPEN.length === TRANSACTION_STATUSES_IN_ESCROW.length + 1 &&
    isOpenDeal("active"))
  check("open and terminal never overlap",
    TRANSACTION_STATUSES_OPEN.every((s) => !(TRANSACTION_STATUSES_TERMINAL as readonly string[]).includes(s)))
  check("every set member is a real status",
    [...TRANSACTION_STATUSES_IN_ESCROW, ...TRANSACTION_STATUSES_OPEN, ...TRANSACTION_STATUSES_TERMINAL]
      .every((s) => isTransactionStatus(s)))
}

console.log("\n── forecast confidence rises as hurdles clear ──")
{
  check("clear_to_close beats pending", closeConfidence("clear_to_close") > closeConfidence("pending"))
  check("pending beats under_contract", closeConfidence("pending") > closeConfidence("under_contract"))
  check("under_contract beats active", closeConfidence("under_contract") > closeConfidence("active"))
  check("closed and funded are certain",
    closeConfidence("closed") === 1 && closeConfidence("funded") === 1)
  check("lost is zero", closeConfidence("lost") === 0)
  check("an unknown status is zero, never a default optimism",
    closeConfidence("closing") === 0 && closeConfidence(null) === 0)
  check("the old hand-rolled weight is gone — it read closing?0.9:0.6, so pending and " +
    "clear_to_close would both have scored 0.6",
    closeConfidence("pending") !== 0.6 && closeConfidence("clear_to_close") !== 0.6)
}

console.log("\n── the five hand-rolled filters now share one set ──")
{
  const inEscrowSites = [
    "app/actions/ai-transaction-coordinator.ts",
    "app/actions/ai-calendar-management.ts",
    "app/actions/multi-persona.ts",
  ]
  for (const p of inEscrowSites) {
    const s = src(p)
    check(`${p} filters on TRANSACTION_STATUSES_IN_ESCROW`,
      /\.in\("status", \[\.\.\.TRANSACTION_STATUSES_IN_ESCROW\]\)/.test(s))
    check(`${p} no longer hand-rolls ["under_contract", "closing"]`,
      !/"under_contract", "closing"/.test(s))
  }
  for (const p of ["app/crm/components/closing-workflow-tab.tsx", "app/actions/admin/agent-360.ts"]) {
    const s = src(p)
    check(`${p} filters on TRANSACTION_STATUSES_OPEN`,
      /\.in\("status", \[\.\.\.TRANSACTION_STATUSES_OPEN\]\)/.test(s))
    check(`${p} no longer names 'closing'`, !/"closing"/.test(s))
  }
  const mp = src("app/actions/multi-persona.ts")
  check("the pipeline weight calls closeConfidence instead of a ternary on 'closing'",
    /closeConfidence\(t\.status\)/.test(mp) && !/status === "closing"/.test(mp))
}

console.log("\n── the listing is inventory, and carries all 7 owner phases (m292) ──")
{
  const live = CHECK_VOCABULARIES.listings?.status ?? []
  for (const v of ["listing_signed", "coming_soon", "active", "withdrawn", "cancelled", "off_market", "sold"]) {
    check(`listing phase '${v}' is storable`, live.includes(v))
  }
  check("under_contract is NOT a listing phase — it belongs to the deal",
    !live.includes("under_contract"))
  check("clear_to_close and funded are not listing phases either",
    !live.includes("clear_to_close") && !live.includes("funded"))
  check("the additive values were kept, by owner direction (nothing migrated)",
    live.includes("draft") && live.includes("pending") && live.includes("expired"))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ DEAL_LADDER_FAIL"); process.exit(1) }
console.log(" ✅ DEAL_LADDER_PASS — the deal ladder is on the transaction, the phases are on the listing")
