#!/usr/bin/env tsx
/**
 * scripts/seller-decision-room-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves THE SELLER DECISION ROOM — turns the net-sheet into a guided seller decision: per-offer
 * modeled outcome (net + timeline + certainty-of-close), highest-money vs safest-bet, and the
 * recommended offer balancing both. Kills "which offer is actually best for me?". Pure — reuses
 * computeNetProceeds + scoreBuyerStrength (no parallel math).
 *
 * Run: npx tsx scripts/seller-decision-room-simulator.ts   (npm run test:seller-decision)
 */
import { buildSellerDecisionRoom, type DecisionOffer, type SellerCosts } from "../lib/kernel/seller-decision-room"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Seller decision room verified — money vs certainty, modeled and recommended.")
  console.log(" SELLER_DECISION_PASS")
}

const costs: SellerCosts = { commissionRate: 0.05, mortgagePayoff: 200000, countyCityTaxes: 2000, hoaDuesProration: 500, otherProratedFees: 1000 }

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Seller decision room simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Clear pick — one offer is both top net AND safest]")
  // A: higher STICKER ($600k) but a big buyer credit drags net below B; weak buyer (FHA, 3 contingencies).
  // B: lower sticker ($580k), zero credit, cash, 0 contingencies, strong EMD → higher NET + safest.
  const offers: DecisionOffer[] = [
    { offerId: "offer-aaaaaaa", buyerName: "A", offerPrice: 600000, financingType: "fha", downPaymentPercent: 5, contingencies: ["inspection", "appraisal", "financing"], emd: 3000, buyerClosingCredit: 20000, closeDateDays: 45 },
    { offerId: "offer-bbbbbbb", buyerName: "B", offerPrice: 580000, financingType: "cash", downPaymentPercent: 100, contingencies: [], emd: 30000, buyerClosingCredit: 0, closeDateDays: 21 },
  ]
  const room = buildSellerDecisionRoom(offers, costs)
  const bCard = room.cards.find(c => c.offerId === "offer-bbbbbbb")!
  const aCard = room.cards.find(c => c.offerId === "offer-aaaaaaa")!
  check("net proceeds computed per offer", bCard.netProceeds > 0 && aCard.netProceeds > 0)
  check("highest NET beats highest STICKER price (the insight sellers miss)", room.netBeatsPrice === true && bCard.isTopNet === true)
  check("the cash buyer is the safest to close (very_strong)", bCard.strengthLabel === "very_strong" && bCard.isTopCertainty === true)
  check("the weak FHA buyer is NOT top net or top certainty", !aCard.isTopNet && !aCard.isTopCertainty && aCard.strengthLabel === "weak")
  check("recommends the offer that's both money + certainty (B)", room.recommendedOfferId === "offer-bbbbbbb")
  check("recommendation explains it's the clear pick", /clear pick|both/i.test(room.recommendationReason))
  check("each card has a factual modeled outcome", room.cards.every(c => /Nets you \$/.test(c.modeledOutcome)) && /closes in ~21 days/.test(bCard.modeledOutcome))

  console.log("\n[Tradeoff — most money is a weaker buyer than the safest]")
  // X: highest net but FHA + contingencies (riskier). Y: cash, strong, but nets less.
  const tradeoff: DecisionOffer[] = [
    { offerId: "offer-xxxxxxx", buyerName: "X", offerPrice: 640000, financingType: "fha", downPaymentPercent: 5, contingencies: ["inspection", "appraisal"], emd: 5000, buyerClosingCredit: 0, closeDateDays: 50 },
    { offerId: "offer-yyyyyyy", buyerName: "Y", offerPrice: 600000, financingType: "cash", downPaymentPercent: 100, contingencies: [], emd: 40000, buyerClosingCredit: 0, closeDateDays: 18 },
  ]
  const t = buildSellerDecisionRoom(tradeoff, costs)
  check("top net (X) differs from top certainty (Y)", t.cards.find(c => c.offerId === "offer-xxxxxxx")!.isTopNet && t.cards.find(c => c.offerId === "offer-yyyyyyy")!.isTopCertainty)
  check("a balanced recommendation is made (one of the two)", ["offer-xxxxxxx", "offer-yyyyyyy"].includes(t.recommendedOfferId ?? ""))
  check("the reason surfaces the money-vs-certainty tradeoff", /balancing money and certainty/i.test(t.recommendationReason))

  console.log("\n[Empty]")
  const empty = buildSellerDecisionRoom([], costs)
  check("no offers → empty room, no fabrication", empty.cards.length === 0 && empty.recommendedOfferId === null)

  report()
}

main()
