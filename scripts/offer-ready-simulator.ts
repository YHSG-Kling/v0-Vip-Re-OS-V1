#!/usr/bin/env tsx
/**
 * scripts/offer-ready-simulator.ts   (npm run test:offer-ready)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE AUTONOMOUS OFFER TRIGGER — proves isOfferReady fires ONLY when a buyer is genuinely at
 * the offer moment: pre-approved AND a fresh active saved target AND no offer yet. All three
 * must hold. Pure: every branch, no I/O.
 */
import { isOfferReady } from "../lib/agents/offer-ready-decision"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[isOfferReady — all three signals must hold]")
  check("pre-approved + fresh target + no offer → READY",
    isOfferReady({ preApprovalAmount: 450000, hasRecentActiveTarget: true, hasOpenOrPastOffer: false }).ready === true)
  check("not pre-approved → not ready",
    isOfferReady({ preApprovalAmount: null, hasRecentActiveTarget: true, hasOpenOrPastOffer: false }).ready === false)
  check("pre-approval 0 → not ready",
    isOfferReady({ preApprovalAmount: 0, hasRecentActiveTarget: true, hasOpenOrPastOffer: false }).ready === false)
  check("no fresh target → not ready (a casual pre-approval isn't an offer)",
    isOfferReady({ preApprovalAmount: 450000, hasRecentActiveTarget: false, hasOpenOrPastOffer: false }).ready === false)
  check("already has an offer → not ready (past this moment)",
    isOfferReady({ preApprovalAmount: 450000, hasRecentActiveTarget: true, hasOpenOrPastOffer: true }).ready === false)
  check("existing offer outranks everything (checked first)",
    isOfferReady({ preApprovalAmount: 450000, hasRecentActiveTarget: true, hasOpenOrPastOffer: true }).reason === "already has an offer on record")
  check("ready reason is honest", isOfferReady({ preApprovalAmount: 1, hasRecentActiveTarget: true, hasOpenOrPastOffer: false }).reason.includes("fresh saved target"))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ OFFER_READY_FAIL"); process.exit(1) }
  console.log(" ✅ OFFER_READY_PASS — the offer accelerator now fires autonomously for genuinely offer-ready buyers")
}

main()
