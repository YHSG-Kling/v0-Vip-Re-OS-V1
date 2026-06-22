#!/usr/bin/env tsx
/**
 * scripts/commission-disclosure-simulator.ts  (npm run test:commission-disclosure) — pure, no DB.
 *
 * Proves the NAR-2024 buyer commission disclosure gate (lib/offers/commission-disclosure.ts)
 * that the new offer-flow dialog records and that submit-for-signature hard-blocks on. No offer
 * may be sent for signature unless these rules clear: affirmative consent, explicit comp terms
 * (pct or flat), a valid payer, and — when an agent records on the buyer's behalf — a signed
 * method (never the buyer's self click-through).
 */
import {
  validateCommissionDisclosure, resolveDisclosureMethod, isEsignDispatchMethod,
} from "../lib/offers/commission-disclosure"

let pass = 0, fail = 0
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

console.log("\n[commission disclosure gate · pure]")

// Valid buyer self-ack (click-through)
check("valid buyer click-through clears", validateCommissionDisclosure(
  { affirmativeConsent: true, disclosedBuyerCommissionPct: 2.5, disclosedCommissionPayer: "seller", disclosureMethod: "click_through" }, true) === null)

// Valid agent-recorded (wet signature)
check("valid agent wet-signature clears", validateCommissionDisclosure(
  { affirmativeConsent: true, disclosedBuyerCommissionFlat: 10000, disclosedCommissionPayer: "split", disclosureMethod: "wet_signature" }, false) === null)

// Consent required
check("missing affirmative consent blocks", validateCommissionDisclosure(
  { affirmativeConsent: false, disclosedBuyerCommissionPct: 2.5, disclosedCommissionPayer: "seller" }, true)?.includes("affirmatively") === true)

// Explicit comp terms required (neither pct nor flat)
check("missing comp terms blocks (NAR 2024)", validateCommissionDisclosure(
  { affirmativeConsent: true, disclosedCommissionPayer: "seller" }, true)?.includes("percentage or flat") === true)

// Payer required + validated
check("missing payer blocks", validateCommissionDisclosure(
  { affirmativeConsent: true, disclosedBuyerCommissionPct: 2.5 }, true)?.includes("payer") === true)
check("bogus payer blocks", validateCommissionDisclosure(
  { affirmativeConsent: true, disclosedBuyerCommissionPct: 2.5, disclosedCommissionPayer: "landlord" }, true)?.includes("payer") === true)

// Agent may NOT use the buyer's self click-through
check("agent click-through is rejected", validateCommissionDisclosure(
  { affirmativeConsent: true, disclosedBuyerCommissionPct: 2.5, disclosedCommissionPayer: "seller", disclosureMethod: "click_through" }, false)?.includes("wet_signature") === true)
check("agent default (no method) is rejected as click-through", validateCommissionDisclosure(
  { affirmativeConsent: true, disclosedBuyerCommissionPct: 2.5, disclosedCommissionPayer: "seller" }, false)?.includes("wet_signature") === true)

// Method resolution
check("buyer default method = click_through", resolveDisclosureMethod(undefined, true) === "click_through")
check("agent default method = wet_signature", resolveDisclosureMethod(undefined, false) === "wet_signature")
check("explicit method wins", resolveDisclosureMethod("docusign", true) === "docusign")

// E-sign dispatch classification
check("docusign + dotloop dispatch via provider", isEsignDispatchMethod("docusign") && isEsignDispatchMethod("dotloop"))
check("wet_signature + click_through recorded inline", !isEsignDispatchMethod("wet_signature") && !isEsignDispatchMethod("click_through"))

console.log("\n──────────────────────────────────────────────────")
if (fail > 0) { console.log(` RESULT: ${pass} passed, ${fail} failed`); process.exit(1) }
console.log(` RESULT: ${pass} passed, 0 failed`)
console.log(" ✅ COMMISSION_DISCLOSURE_PASS — no offer clears the gate without consent + explicit terms + valid payer/method")
