#!/usr/bin/env tsx
/**
 * scripts/property-buyer-match-simulator.ts  (npm run test:property-buyer-match) — pure, no DB.
 *
 * Proves the listing→buyer smart-match scorer (lib/property-matching/match-scorer.ts) that
 * powers the new "Matching Buyers" panel on the listing lifecycle page: price/bed/bath/location
 * alignment scoring, confidence tiers, ranking, and the viable-buyer threshold. Runtime-only
 * scores, never persisted (System 5.1A).
 */
import {
  scoreBuyerForListing, rankBuyersForListing, filterViableBuyers,
  type BuyerProfile, type ListingProfile,
} from "../lib/property-matching/match-scorer"

const listing: ListingProfile = {
  id: "L1", price: 400000, bedrooms: 3, bathrooms: 2, square_feet: 1800,
  property_type: "single_family", city: "Austin", state: "TX", zip: "78701",
  features: null, status: "active", created_at: "2026-06-01T00:00:00Z",
}

const prefs = (p: Record<string, unknown>) => JSON.stringify({ ai_inference: { buyer_preferences: p } })

const strongFit: BuyerProfile = {
  contact_id: "b-strong", first_name: "Strong", last_name: "Fit", created_at: "2026-06-01T00:00:00Z",
  notes: prefs({ maxPrice: 450000, minBeds: 3, minBaths: 2, preferredCities: ["Austin"], preferredStates: ["TX"] }),
}
const overBudget: BuyerProfile = {
  contact_id: "b-over", first_name: "Over", last_name: "Budget", created_at: "2026-06-01T00:00:00Z",
  notes: prefs({ maxPrice: 300000, minBeds: 3 }),
}
const noPrefs: BuyerProfile = {
  contact_id: "b-none", first_name: "No", last_name: "Prefs", created_at: "2026-06-01T00:00:00Z", notes: null,
}

let pass = 0, fail = 0
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

console.log("\n[property→buyer match scorer · pure]")

const sStrong = scoreBuyerForListing(strongFit, listing)
const sOver = scoreBuyerForListing(overBudget, listing)
const sNone = scoreBuyerForListing(noPrefs, listing)

check("strong-fit buyer scores within budget", sStrong.match_factors.some((f) => /within budget/i.test(f)))
check("strong-fit outscores the over-budget buyer", sStrong.score > sOver.score)
check("over-budget buyer carries a caution note", sOver.caution_notes.some((c) => /over budget/i.test(c)))
check("score is bounded 0–100", sStrong.score >= 0 && sStrong.score <= 100)
check("confidence tier is one of low/medium/high", ["low", "medium", "high"].includes(sStrong.match_confidence))
check("no-prefs buyer scores low (nothing to align)", sNone.score < sStrong.score)

const ranked = rankBuyersForListing([overBudget, noPrefs, strongFit], listing)
check("ranking puts the strongest fit first", ranked[0].contact_id === "b-strong")
check("ranking is sorted descending", ranked.every((m, i) => i === 0 || ranked[i - 1].score >= m.score))

const viable = filterViableBuyers(ranked, 45)
check("viable filter keeps only ≥ threshold", viable.every((m) => m.score >= 45))
check("the strong fit survives the viable filter", viable.some((m) => m.contact_id === "b-strong"))

console.log("\n──────────────────────────────────────────────────")
if (fail > 0) { console.log(` RESULT: ${pass} passed, ${fail} failed`); process.exit(1) }
console.log(` RESULT: ${pass} passed, 0 failed`)
console.log(" ✅ PROPERTY_BUYER_MATCH_PASS — listing→buyer scoring, ranking + viable filter verified")
