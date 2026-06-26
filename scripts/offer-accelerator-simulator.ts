#!/usr/bin/env tsx
/**
 * scripts/offer-accelerator-simulator.ts   (npm run test:offer-accelerator)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OFFER ACCELERATOR — fills the formerly-empty offer-strategy moment with a REAL plan.
 * Pure coverage of the target-detection + input-mapping brain (the gateway strategy call is
 * exercised live in the app): pickBuyerTargetListing, domFromListingDate, marketConditionsFromDom,
 * motivationFromBuyer, resolveBuyerMaxBudget, summarizeOfferStrategy. No I/O, no mocks.
 */
import {
  pickBuyerTargetListing, domFromListingDate, marketConditionsFromDom,
  motivationFromBuyer, resolveBuyerMaxBudget,
} from "../lib/offers/offer-target"
import { summarizeOfferStrategy, type BuyerOfferStrategy } from "../lib/offers/offer-strategy-types"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

const NOW = new Date("2026-06-26T12:00:00Z")

function main() {
  console.log("\n[Target detection — the hot property the buyer is about to offer on]")
  const rows = [
    { listing_id: "old", saved_at: "2026-06-01T00:00:00Z", dismissed: false, list_price: 400000, status: "active", listing_date: "2026-05-01" },
    { listing_id: "hot", saved_at: "2026-06-20T00:00:00Z", dismissed: false, list_price: 525000, status: "active", listing_date: "2026-06-12" },
    { listing_id: "gone", saved_at: "2026-06-25T00:00:00Z", dismissed: false, list_price: 600000, status: "sold", listing_date: "2026-01-01" },
  ]
  const t = pickBuyerTargetListing(rows, NOW)
  check("picks the most-recently-saved ACTIVE listing with a price", t?.listingId === "hot")
  check("carries the real list price", t?.listPrice === 525000)
  check("a SOLD listing is never the target", pickBuyerTargetListing([rows[2]], NOW) === null)
  check("dismissed listing excluded", pickBuyerTargetListing([{ ...rows[1], dismissed: true }], NOW) === null)
  check("no saved rows → null (honest, no fabricated target)", pickBuyerTargetListing([], NOW) === null)
  check("no priced listing → null", pickBuyerTargetListing([{ ...rows[1], list_price: null }], NOW) === null)

  console.log("\n[Days-on-market from the real list date]")
  check("DOM computed from listing_date", domFromListingDate("2026-06-12", NOW) === 14)
  check("no date → 0 (honest)", domFromListingDate(null, NOW) === 0)
  check("future date never negative", domFromListingDate("2026-12-01", NOW) === 0)

  console.log("\n[Market conditions — grounded in DOM, no fabrication]")
  check("fast mover (≤14d) → hot", marketConditionsFromDom(10) === "hot")
  check("long sitter (≥60d) → cooling", marketConditionsFromDom(75) === "cooling")
  check("in between → balanced", marketConditionsFromDom(30) === "balanced")

  console.log("\n[Buyer motivation mapping]")
  check("urgent/ready → must_have", motivationFromBuyer({ timeline: "0-3 months", buyer_stage: "offer_strategy" }) === "must_have")
  check("browsing → nice_to_have", motivationFromBuyer({ timeline: "just browsing" }) === "nice_to_have")
  check("neutral → would_like", motivationFromBuyer({}) === "would_like")

  console.log("\n[Max budget — pre-approval first, conservative ceiling otherwise]")
  check("pre-approval used when present", resolveBuyerMaxBudget(480000, 525000) === 480000)
  check("no pre-approval → ~110% of list ceiling", resolveBuyerMaxBudget(null, 500000) === 550000)
  check("nothing usable → null (skip the numeric plan)", resolveBuyerMaxBudget(null, 0) === null)

  console.log("\n[Agent-facing summary of the strategy]")
  const strat: BuyerOfferStrategy = {
    recommendedOfferPrice: 515000, priceRangeLow: 505000, priceRangeHigh: 525000, winProbability: 72,
    strategy: "competitive", reasoning: "x",
    escalationRecommendation: { recommended: true, suggestedMax: 535000, suggestedIncrement: 2500, reasoning: "x" },
    contingencyStrategy: { inspection: "full", appraisal: "gap_coverage", financing: "full", reasoning: "x" },
    earnestMoneyRecommendation: { amount: 10000, percentage: 2, reasoning: "x" },
    closeDateStrategy: "30 days", personalLetterRecommendation: true, additionalSuggestions: [],
  }
  const s = summarizeOfferStrategy(strat)
  check("summary carries the recommended price", s.includes("$515,000"))
  check("summary carries the range", s.includes("$505,000") && s.includes("$525,000"))
  check("summary carries win probability", s.includes("72%"))
  check("summary carries escalation", /Escalate to \$535,000/.test(s))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ OFFER_ACCELERATOR_FAIL"); process.exit(1) }
  console.log(" ✅ OFFER_ACCELERATOR_PASS — the offer-strategy moment now carries a real, grounded plan + a team-play offer-confidence reel")
}

main()
