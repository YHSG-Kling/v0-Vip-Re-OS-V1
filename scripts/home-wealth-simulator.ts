#!/usr/bin/env tsx
/**
 * scripts/home-wealth-simulator.ts   (npm run test:home-wealth)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the lifetime portal's "home wealth story" math (computeHomeWealthStory):
 * realized gain ($ + %), annualized appreciation (CAGR) only when ≥1 year of
 * history exists, a purchase-anchored normalized curve, and graceful handling of
 * loss / no-estimate / no-series cases. Realized history only — no forward
 * forecast (compliance). Pure: no I/O.
 */
import { computeHomeWealthStory } from "../lib/portal/home-wealth"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const near = (a: number, b: number, eps = 0.05) => Math.abs(a - b) <= eps

function main() {
  console.log("\n[gain from a single latest estimate]")
  const single = computeHomeWealthStory({
    purchasePrice: 400000,
    closeDate: "2020-06-01",
    estimatedValueMid: 520000,
    estimatedValueLow: 500000,
    estimatedValueHigh: 540000,
    latestGeneratedAt: "2024-06-01",
  })
  check("hasEstimate", single.hasEstimate)
  check("gainAbsolute = 120000", single.gainAbsolute === 120000)
  check("gainPercent = 30%", near(single.gainPercent, 30))
  check("isGain", single.isGain)
  check("yearsHeld = 4", single.yearsHeld === 4)
  check("annualized ≈ 6.78%/yr (CAGR)", single.annualizedPercent !== null && near(single.annualizedPercent, 6.78, 0.1))
  check("currentValue from latest mid", single.currentValue === 520000)
  check("equityLow = 500000-400000", single.equityLow === 100000)
  check("equityHigh = 540000-400000", single.equityHigh === 140000)

  console.log("\n[series overrides single latest; curve anchored by purchase price]")
  const series = computeHomeWealthStory({
    purchasePrice: 300000,
    closeDate: "2019-01-01",
    estimatedValueMid: 999999, // should be ignored in favor of series last
    latestGeneratedAt: "2099-01-01",
    series: [
      { estimated_value_mid: 310000, generated_at: "2020-01-01" },
      { estimated_value_mid: 360000, generated_at: "2022-01-01" },
      { estimated_value_mid: 420000, generated_at: "2024-01-01" },
    ],
  })
  check("currentValue = last series mid (420000)", series.currentValue === 420000)
  check("gainAbsolute = 120000", series.gainAbsolute === 120000)
  check("curve length = purchase + 3 points", series.curve.length === 4)
  check("first curve point is purchase", series.curve[0].isPurchase && series.curve[0].value === 300000)
  check("curve y normalized 0..1", series.curve.every((p) => p.y >= 0 && p.y <= 1))
  check("min value point has y=0", series.curve.some((p) => p.value === 300000 && p.y === 0))
  check("max value point has y=1", series.curve.some((p) => p.value === 420000 && p.y === 1))
  // 2019-01-01 → 2024-01-01 is ~4.999 yr (leap days) → floor 4; anchored to the
  // last series date (2024), NOT the latestGeneratedAt input (2099) — series wins.
  check("yearsHeld anchored to last series date (≈5yr → floor 4)", series.yearsHeld === 4)

  console.log("\n[loss case]")
  const loss = computeHomeWealthStory({
    purchasePrice: 500000,
    closeDate: "2023-01-01",
    estimatedValueMid: 470000,
    latestGeneratedAt: "2023-09-01",
  })
  check("isGain false", !loss.isGain)
  check("gainAbsolute = -30000", loss.gainAbsolute === -30000)
  check("gainPercent = -6%", near(loss.gainPercent, -6))
  check("annualized null (<1 year held)", loss.annualizedPercent === null)
  check("yearsHeld = 0 (sub-year)", loss.yearsHeld === 0)

  console.log("\n[no estimate / empty]")
  const none = computeHomeWealthStory({ purchasePrice: 400000, closeDate: "2020-01-01" })
  check("hasEstimate false", !none.hasEstimate)
  check("curve empty", none.curve.length === 0)
  check("gain 0", none.gainAbsolute === 0)

  console.log("\n[no purchase price — gainPercent guarded, no divide-by-zero]")
  const noPrice = computeHomeWealthStory({ estimatedValueMid: 500000, latestGeneratedAt: "2024-01-01" })
  check("hasEstimate true", noPrice.hasEstimate)
  check("gainPercent = 0 (no base)", noPrice.gainPercent === 0)
  check("annualized null (no base)", noPrice.annualizedPercent === null)
  check("gainAbsolute Number.isFinite", Number.isFinite(noPrice.gainAbsolute))

  console.log("\n[no forward forecast — curve never extends past latest estimate]")
  const fwd = computeHomeWealthStory({
    purchasePrice: 300000,
    closeDate: "2020-01-01",
    latestGeneratedAt: "2024-01-01",
    series: [
      { estimated_value_mid: 320000, generated_at: "2021-01-01" },
      { estimated_value_mid: 380000, generated_at: "2024-01-01" },
    ],
  })
  check("last curve point == latest estimate (no projected future point)",
    fwd.curve[fwd.curve.length - 1].value === 380000 && !fwd.curve[fwd.curve.length - 1].isPurchase)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ HOME_WEALTH_FAIL"); process.exit(1) }
  console.log(" ✅ HOME_WEALTH_PASS — realized gain/%, CAGR, purchase-anchored curve, no forward forecast")
}
main()
