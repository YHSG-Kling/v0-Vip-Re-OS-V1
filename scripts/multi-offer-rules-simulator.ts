#!/usr/bin/env tsx
/**
 * scripts/multi-offer-rules-simulator.ts  (npm run test:multi-offer-rules) — pure, no DB.
 *
 * Proves the multi-offer governance rule (lib/offers/multi-offer-rules.ts, System 7.1A
 * Domain 2) surfaced by the new Multi-Offer status banner on a buyer's offers list:
 * a buyer may hold at most MAX_PENDING_OFFERS pending offers, and the banner severity
 * (clear / approaching / at_limit) is derived from the pending count.
 */
import { MAX_PENDING_OFFERS, evaluateOfferLimit, limitProximity } from "../lib/offers/multi-offer-rules"

let pass = 0, fail = 0
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

console.log("\n[multi-offer rules · pure]")

check("under the cap → can submit", evaluateOfferLimit(0).can_submit && evaluateOfferLimit(MAX_PENDING_OFFERS - 1).can_submit)
check("at the cap → blocked with reason", (() => { const v = evaluateOfferLimit(MAX_PENDING_OFFERS); return !v.can_submit && /Maximum/.test(v.reason ?? "") })())
check("over the cap → blocked", !evaluateOfferLimit(MAX_PENDING_OFFERS + 1).can_submit)
check("proximity: 0 pending → clear", limitProximity(0) === "clear")
check("proximity: one away → approaching", limitProximity(MAX_PENDING_OFFERS - 1) === "approaching")
check("proximity: at cap → at_limit", limitProximity(MAX_PENDING_OFFERS) === "at_limit")
check("proximity: over cap → at_limit", limitProximity(MAX_PENDING_OFFERS + 5) === "at_limit")
check("cap is the documented System 7.1A value (3)", MAX_PENDING_OFFERS === 3)

console.log("\n──────────────────────────────────────────────────")
if (fail > 0) { console.log(` RESULT: ${pass} passed, ${fail} failed`); process.exit(1) }
console.log(` RESULT: ${pass} passed, 0 failed`)
console.log(" ✅ MULTI_OFFER_RULES_PASS — pending-offer cap + banner severity verified")
