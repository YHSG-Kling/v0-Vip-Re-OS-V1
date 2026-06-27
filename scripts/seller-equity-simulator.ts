#!/usr/bin/env tsx
/**
 * scripts/seller-equity-simulator.ts   (npm run test:seller-equity)
 * ─────────────────────────────────────────────────────────────────────────────
 * SELLER EQUITY & NET-PROCEEDS — proves the seller-side analogue of the buyer affordability tool:
 * value − selling costs − mortgage payoff = what they actually keep. Honest (gross-only until the
 * balance is known, never a fabricated payoff) and warm (never a cold/scary number). Reuses the
 * canonical computeNetProceeds math, so it agrees with the interactive net sheet. Pure: no I/O.
 */
import {
  estimateSellerNetProceeds, clientEquityFraming, DEFAULT_COMMISSION_RATE,
} from "../lib/seller-equity/equity-estimate"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[Net proceeds — value − commission − payoff − taxes − HOA − other]")
  // $600k value, $300k balance, 6% comm ($36k), taxes 0.5% ($3k), other 1% ($6k), no HOA.
  // net = 600k − 36k − 300k − 3k − 6k = 255k
  const e = estimateSellerNetProceeds({ estimatedValue: 600_000, mortgageBalance: 300_000 })
  check("selling costs = commission + taxes + other (45k)", e.sellingCosts === 45_000)
  check("gross equity = value − balance (300k)", e.grossEquity === 300_000)
  check("net proceeds = 255k (reuses canonical net math)", e.netProceeds === 255_000)
  check("mortgageKnown = true", e.mortgageKnown === true)
  check("default commission rate is 6%", DEFAULT_COMMISSION_RATE === 0.06)

  console.log("\n[Honest — no fabricated payoff when the balance isn't on file]")
  const noBal = estimateSellerNetProceeds({ estimatedValue: 600_000, mortgageBalance: null })
  check("net proceeds is null until the seller adds their balance", noBal.netProceeds === null)
  check("gross equity is null too (we don't guess)", noBal.grossEquity === null)
  check("still shows selling costs (known from value)", noBal.sellingCosts === 45_000)
  check("mortgageKnown = false", noBal.mortgageKnown === false)

  console.log("\n[Tunable assumptions]")
  const lowComm = estimateSellerNetProceeds({ estimatedValue: 600_000, mortgageBalance: 300_000, commissionRate: 0.05 })
  check("lower commission → higher net", (lowComm.netProceeds ?? 0) > (e.netProceeds ?? 0))
  const withHoa = estimateSellerNetProceeds({ estimatedValue: 600_000, mortgageBalance: 300_000, hoaDuesMonthly: 400 })
  check("HOA proration reduces net by ~400", (e.netProceeds ?? 0) - (withHoa.netProceeds ?? 0) === 400)

  console.log("\n[Warm, them-first framing — never a cold/scary number]")
  check("positive net → celebratory + routes to agent", (() => { const f = clientEquityFraming(e); return f.tone === "good" && /agent/i.test(f.line) })())
  check("unknown balance → invites adding it (neutral, not alarming)", (() => { const f = clientEquityFraming(noBal); return f.tone === "neutral" && /mortgage/i.test(f.label) })())
  const underwater = estimateSellerNetProceeds({ estimatedValue: 300_000, mortgageBalance: 320_000 })
  check("negative net → 'map your options', never scary/red", (() => { const f = clientEquityFraming(underwater); return f.tone === "neutral" && /options|strategy|where you want/i.test(f.line) })())

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ SELLER_EQUITY_FAIL"); process.exit(1) }
  console.log(" ✅ SELLER_EQUITY_PASS — sellers see what they'd actually keep; honest + warm; reuses the canonical net math")
}

main()
