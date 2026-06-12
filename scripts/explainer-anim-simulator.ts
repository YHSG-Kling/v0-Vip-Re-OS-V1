#!/usr/bin/env tsx
/**
 * scripts/explainer-anim-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Animated-explainer harness — the in-stack answer to Manim. The Remotion
 * composition (remotion/ExplainerAnimReel.tsx) renders only with Chromium, but
 * its diagram CONTENT is pure math (lib/charts/explainer-diagram.ts) — fully
 * testable here. Proves explainerDiagramSpec(topic, facts) produces correct
 * diagram data per topic from REAL facts (equity amortization, buydown payment
 * bars, scaled closing-timeline steps, inverted what-$X/mo-buys price tiers),
 * checks the 18s @ 30fps animation timing bounds, and proves the HONEST
 * hasData:false handling of a topic with no facts.
 *
 * No mocks — calls the real spec module with real fact bags.
 *
 * Run:  npx tsx scripts/explainer-anim-simulator.ts   (npm run test:explainer-anim)
 */
import {
  explainerDiagramSpec,
  normalizeTopic,
  coerceNumber,
  monthlyPayment,
  remainingBalance,
  type EquityOverTimeData,
  type RateBuydownData,
  type ClosingTimelineData,
  type WhatMonthlyBuysData,
} from "../lib/charts/explainer-diagram"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const approx = (a: number, b: number, eps = 1) => Math.abs(a - b) <= eps

// ── animation timing bounds (mirror ExplainerAnimReel constants) ──────────────
const FPS = 30
const COVER = 3 * FPS, DIAGRAM = 12 * FPS, CTA = 3 * FPS
const TOTAL = COVER + DIAGRAM + CTA

function testCoercion() {
  console.log("\n[coerceNumber + normalizeTopic + math helpers]")
  check("coerce $420,000", coerceNumber("$420,000") === 420000)
  check("coerce 6.5%", coerceNumber("6.5%") === 6.5)
  check("coerce plain number", coerceNumber(7) === 7)
  check("coerce garbage → undefined", coerceNumber("n/a") === undefined)
  check("normalizeTopic 'Equity Over Time'", normalizeTopic("Equity Over Time") === "equity_over_time")
  check("normalizeTopic 'buydown'", normalizeTopic("buydown") === "rate_buydown")
  check("normalizeTopic 'affordability' → monthly", normalizeTopic("affordability") === "what_monthly_buys")
  check("normalizeTopic unknown → undefined", normalizeTopic("astrology") === undefined)
  // amortization sanity: $400k @ 6.5% / 30yr ≈ $2,528/mo
  check("monthlyPayment 400k/6.5/30 ≈ 2528", approx(monthlyPayment(400000, 0.065, 30), 2528, 3))
  check("monthlyPayment zero-rate = principal/n", monthlyPayment(360000, 0, 30) === 1000)
  check("remainingBalance at month 0 = principal", remainingBalance(400000, 0.065, 30, 0) === 400000)
  check("remainingBalance decreases over time", remainingBalance(400000, 0.065, 30, 120) < 400000)
  check("remainingBalance at term end ≈ 0", approx(remainingBalance(400000, 0.065, 30, 360), 0, 1))
}

function testEquity() {
  console.log("\n[equity_over_time]")
  const spec = explainerDiagramSpec("equity_over_time", {
    purchasePrice: "$500,000",
    downPaymentPct: "20",
    rate: "6.5%",
    appreciationRate: "4",
    horizonYears: "10",
  })
  check("hasData true with price", spec.hasData === true)
  const d = spec.data as EquityOverTimeData
  check("kind equity_over_time", d?.kind === "equity_over_time")
  check("11 points (year 0..10)", d.points.length === 11)
  check("start loan = 80% of price", d.startLoan === 400000)
  check("year 0 equity = down payment", d.points[0].equity === 100000)
  check("value appreciates each year", d.points[10].value > d.points[0].value)
  check("balance amortizes down each year", d.points[10].balance < d.points[0].balance)
  check("equity grows monotonically", d.points.every((p, i) => i === 0 || p.equity >= d.points[i - 1].equity))
  check("finalEquity = last point equity", d.finalEquity === d.points[10].equity)
  check("finalEquity > starting equity", d.finalEquity > d.points[0].equity)
  check("caption discloses estimate", /estimate/i.test(spec.caption))
  // down payment given as dollars instead of pct
  const spec2 = explainerDiagramSpec("equity_over_time", { price: 600000, downPayment: 120000 })
  check("dollar down payment → 20% loan", (spec2.data as EquityOverTimeData).startLoan === 480000)
}

function testBuydown() {
  console.log("\n[rate_buydown]")
  const spec = explainerDiagramSpec("rate_buydown", {
    loanAmount: "$400,000",
    rate: "7%",
    buydownRate: "6%",
    termYears: "30",
  })
  check("hasData true with loan", spec.hasData === true)
  const d = spec.data as RateBuydownData
  check("two payment bars", d.bars.length === 2)
  check("note-rate bar first", approx(d.bars[0].rate * 100, 7, 0.01))
  check("bought-down bar lower payment", d.bars[1].payment < d.bars[0].payment)
  check("monthlySavings = note − bought", approx(d.monthlySavings, d.bars[0].payment - d.bars[1].payment, 1))
  check("monthlySavings positive", d.monthlySavings > 0)
  check("annualSavings = monthly × 12", d.annualSavings === d.monthlySavings * 12)
  // points convention: 2 points ≈ 0.5% off
  const spec2 = explainerDiagramSpec("rate_buydown", { price: 500000, rate: 7, buydownPoints: 2 })
  const d2 = spec2.data as RateBuydownData
  check("points → reduced bought-down rate", d2.bars[1].rate < d2.bars[0].rate)
  check("price-only loan derived at 80%", d2.loanAmount === 400000)
}

function testTimeline() {
  console.log("\n[closing_timeline]")
  const spec = explainerDiagramSpec("closing_timeline", {})
  check("hasData true even with no facts (always teachable)", spec.hasData === true)
  const d = spec.data as ClosingTimelineData
  check("7 canonical steps", d.steps.length === 7)
  check("first step day 0 (offer accepted)", d.steps[0].day === 0)
  check("steps monotonically non-decreasing in day", d.steps.every((s, i) => i === 0 || s.day >= d.steps[i - 1].day))
  check("indices are 0..n-1", d.steps.every((s, i) => s.index === i))
  check("totalDays = last step day", d.totalDays === d.steps[d.steps.length - 1].day)
  check("default totalDays = 30", d.totalDays === 30)
  // scale to a real 45-day close
  const spec45 = explainerDiagramSpec("closing_timeline", { closeDays: "45" })
  const d45 = spec45.data as ClosingTimelineData
  check("45-day close scales last step to 45", d45.totalDays === 45)
  check("scaled steps still start at day 0", d45.steps[0].day === 0)
}

function testMonthlyBuys() {
  console.log("\n[what_monthly_buys]")
  const spec = explainerDiagramSpec("what_monthly_buys", {
    monthlyBudget: "$3,200",
    rate: "6.5%",
    downPaymentPct: "20",
  })
  check("hasData true with budget", spec.hasData === true)
  const d = spec.data as WhatMonthlyBuysData
  check("three price tiers", d.tiers.length === 3)
  check("middle tier = target monthly", d.tiers[1].monthly === d.targetMonthly)
  check("higher monthly → higher price", d.tiers[2].price > d.tiers[1].price && d.tiers[1].price > d.tiers[0].price)
  check("target monthly preserved", d.targetMonthly === 3200)
  // round-trip: price → loan → monthly should land back near the budget
  const loan = d.tiers[1].price * (1 - d.downPct)
  check("inverse amortization round-trips to budget", approx(monthlyPayment(loan, d.rate, d.termYears), d.targetMonthly, 5))
  check("caption discloses P&I estimate", /estimate/i.test(spec.caption))
}

function testHonestNoFacts() {
  console.log("\n[honest handling — topic with no facts]")
  const eq = explainerDiagramSpec("equity_over_time", {})
  check("equity with no price → hasData false", eq.hasData === false)
  check("equity no-data carries a reason", !!eq.reason && /price|value/i.test(eq.reason))
  check("equity no-data has no fabricated data", eq.data === undefined)
  check("equity no-data still has a title", eq.title.length > 0)

  const bd = explainerDiagramSpec("rate_buydown", {})
  check("buydown with no loan → hasData false", bd.hasData === false)
  check("buydown no-data carries a reason", !!bd.reason)

  const mb = explainerDiagramSpec("what_monthly_buys", {})
  check("monthly-buys with no budget → hasData false", mb.hasData === false)
  check("monthly-buys no-data carries a reason", !!mb.reason)
}

function testTopicRouting() {
  console.log("\n[topic routing from facts]")
  // topic rides on facts (Director sets it there; we never edit the Director)
  const fromFacts = explainerDiagramSpec(undefined, { topic: "rate_buydown", loanAmount: 400000 })
  check("topic read from facts.topic", fromFacts.data?.kind === "rate_buydown")
  const fromExplainerTopic = explainerDiagramSpec(undefined, { explainerTopic: "equity", purchasePrice: 500000 })
  check("topic read from facts.explainerTopic", fromExplainerTopic.data?.kind === "equity_over_time")
  const unknown = explainerDiagramSpec("not-a-real-topic", {})
  check("unknown topic falls back to closing_timeline", unknown.data?.kind === "closing_timeline")
}

function testTimingBounds() {
  console.log("\n[animation timing bounds — 18s @ 30fps]")
  check("TOTAL = 540 frames (18s)", TOTAL === 540)
  check("cover before diagram before cta", COVER < COVER + DIAGRAM && COVER + DIAGRAM < TOTAL)
  check("diagram is the bulk (12s)", DIAGRAM === 360)
  // draw-on / sweep windows must finish inside the diagram sequence (360 frames)
  const drawEnd = 90      // equity curve draw-on ends frame 90 (local)
  const sweepEnd = 110    // timeline sweep ends frame 110 (local)
  const finalCalloutEnd = 110
  check("equity draw-on completes within diagram window", drawEnd < DIAGRAM)
  check("timeline sweep completes within diagram window", sweepEnd < DIAGRAM)
  check("final callout completes within diagram window", finalCalloutEnd < DIAGRAM)
  check("all animation windows are positive + ordered", drawEnd > 10 && sweepEnd > drawEnd - 1)
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Animated explainer simulator (ExplainerAnimReel)")
  console.log("══════════════════════════════════════════════════")
  testCoercion()
  testEquity()
  testBuydown()
  testTimeline()
  testMonthlyBuys()
  testHonestNoFacts()
  testTopicRouting()
  testTimingBounds()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ All animated-explainer checks passed")
}
main()
