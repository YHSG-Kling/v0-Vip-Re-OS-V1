#!/usr/bin/env tsx
/**
 * scripts/source-health-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves SOURCE LIFETIME-HEALTH feedback: grade each lead source by what % of its contacts reached
 * a LASTING relationship (thriving/warm) vs decayed (at-risk/dormant) — so acquisition optimizes for
 * lifetime value, not just cheap leads that convert once. Pure + shell-runnable. No mocks.
 *
 * Run: npx tsx scripts/source-health-simulator.ts   (npm run test:source-health)
 */
import { aggregateSourceHealth } from "../lib/lead-pipeline/source-health"

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
  console.log(" ✅ Source health verified — lasting vs cheap-but-fading sources distinguished.")
  console.log(" SOURCE_HEALTH_PASS")
  process.exit(0)
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Source lifetime-health simulator")
  console.log("══════════════════════════════════════════════════\n")

  const band = (s: string, b: any, n: number) => Array.from({ length: n }, () => ({ source: s, band: b }))
  const summary = aggregateSourceHealth([
    ...band("referral", "thriving", 8), ...band("referral", "warm", 4),                 // 12 healthy → lasting
    ...band("cheap_ads", "at_risk", 9), ...band("cheap_ads", "dormant", 6), ...band("cheap_ads", "warm", 1), // mostly decayed
    ...band("thin", "thriving", 2),                                                       // < min volume
  ])

  const referral = summary.find((s) => s.source === "referral")
  const ads = summary.find((s) => s.source === "cheap_ads")
  const thin = summary.find((s) => s.source === "thin")

  check("a source whose contacts LAST → 'lasting'", referral?.verdict === "lasting" && (referral?.healthRate ?? 0) >= 0.5)
  check("cheap leads that decay → 'cheap_but_fading'", ads?.verdict === "cheap_but_fading" && (ads?.healthRate ?? 1) < 0.25)
  check("low volume → insufficient_data (no premature judgment)", thin?.verdict === "insufficient_data")
  check("sorted by lifetime health (best first)", summary[0].source === "referral")
  check("counts healthy vs decayed", referral?.healthy === 12 && ads?.decayed === 15)
  check("empty → empty", aggregateSourceHealth([]).length === 0)

  report()
}

main()
