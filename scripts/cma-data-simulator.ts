#!/usr/bin/env tsx
/**
 * scripts/cma-data-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 39 — CMA data→chart bridge harness. Proves buildCmaReelInputProps turns
 * the app's REAL comps/market shapes into valid CMAReel inputProps (the data
 * the charts I built render), and that the affordability donut's mortgage math
 * is correct. Pure — no DB, no network — runs fully in CI.
 *
 * Run:  npx tsx scripts/cma-data-simulator.ts   (npm run test:cma-data)
 */
import { buildCmaReelInputProps, monthlyPaymentBreakdown } from "../lib/charts/cma-reel-data"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const approx = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps

function testPayment() {
  console.log("\n[monthlyPaymentBreakdown]")
  const p = monthlyPaymentBreakdown(500000, { downPct: 0.20, annualRatePct: 6.5, termYears: 30, taxRatePct: 1.1, insRatePct: 0.35 })
  check("P&I on $400k loan @6.5%/30yr ≈ $2,528", approx(p.pi, 2528, 5), `got ${p.pi}`)
  check("taxes = price·1.1%/12 ≈ $458", approx(p.taxes, 458.33, 1))
  check("insurance = price·0.35%/12 ≈ $146", approx(p.insurance, 145.83, 1))
  check("total = sum of parts", approx(p.total, p.pi + p.taxes + p.insurance + p.hoa, 0.02))
  check("HOA defaults to 0", p.hoa === 0)
  const z = monthlyPaymentBreakdown(300000, { annualRatePct: 0, downPct: 0, termYears: 30 })
  check("zero-rate loan amortizes linearly (no NaN)", approx(z.pi, 300000 / 360, 0.5))
  check("zero price → zero payment (no divide error)", monthlyPaymentBreakdown(0).total === 0)
}

function testBuilder() {
  console.log("\n[buildCmaReelInputProps]")
  const props: any = buildCmaReelInputProps({
    subject: { address: "742 Evergreen Ter, Miami, FL", areaName: "Brickell, FL", estimatedPrice: 675000 },
    comparables: [
      { address: "501 N Riverwalk, Miami, FL", adjusted_price: 640000, sale_price: 635000, days_on_market: 18 },
      { address: "1245 Bay Rd, Miami, FL",     sale_price: 658000, days_on_market: 12 },
      { address: "210 SE 8th St, Miami, FL",   list_price: 612000, days_on_market: 25 },
      { address: "No Price Ave",               sale_price: 0 }, // filtered out
    ],
    priceHistory: [
      { price: 612000, recorded_at: "2025-06-15" },
      { price: 645000, recorded_at: "2025-08-15" },
      { price: 689000, recorded_at: "2025-10-15" },
    ],
    brand: { brokerageName: "Acme Realty", agentName: "Jane Doe", accentColor: "#F59E0B" },
    affordability: { hoaMonthly: 180 },
  })

  check("subject is the first comps bar + flagged", props.comps[0].isSubject === true && props.comps[0].value === 675000)
  check("comp price uses adjusted→sale→list fallback", props.comps[1].value === 640000 && props.comps[2].value === 658000 && props.comps[3].value === 612000)
  check("zero-price comp filtered out", props.comps.every((c: any) => c.value > 0) && props.comps.length === 4)
  check("comp labels shortened to street", props.comps[1].label === "501 N Riverwalk")
  check("priceTrend from sorted history with month labels", JSON.stringify(props.priceTrend.values) === JSON.stringify([612000, 645000, 689000]) && props.priceTrend.labels[0] === "Jun")
  check("daysOnMarket from comps that report it", props.daysOnMarket.values.length === 3 && props.daysOnMarket.values.includes(18))
  check("affordability includes HOA segment when > 0", props.affordability.segments.some((s: any) => s.label === "HOA"))
  const segSum = props.affordability.segments.reduce((s: number, x: any) => s + x.value, 0)
  const center = Number(props.affordability.centerValue.replace(/[$,]/g, ""))
  check("affordability segments sum ≈ centerValue total", approx(segSum, center, 1.5))
  check("subjectAddress + areaName passed through", props.subjectAddress.startsWith("742 Evergreen") && props.areaName === "Brickell, FL")
  check("brand carried through", props.brand.brokerageName === "Acme Realty" && props.brand.showEhoMark === true)

  // Degenerate: no history + no comps → priceTrend falls back to comps (subject only).
  const bare: any = buildCmaReelInputProps({ subject: { address: "1 A St", areaName: "X", estimatedPrice: 400000 }, comparables: [] })
  check("no comps/history → still valid props (subject-only trend)", bare.comps.length === 1 && bare.priceTrend.values.length >= 1)
  check("no HOA → donut omits HOA segment", !bare.affordability.segments.some((s: any) => s.label === "HOA"))
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" CMA data→chart bridge simulator")
  console.log("══════════════════════════════════════════════════")
  testPayment(); testBuilder()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ CMA data bridge verified (real comps → valid CMAReel inputProps)")
}
main()
