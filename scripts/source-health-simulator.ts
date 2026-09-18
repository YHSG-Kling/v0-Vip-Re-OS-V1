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

  // ── WAVE 66 — a source whose items carry a BatchData CONFIG-fault error grades
  // 'connector_fault', never 'cheap_but_fading' (a broken connector is not a bad source) ──
  const withFault = aggregateSourceHealth([
    ...band("broken_connector", "at_risk", 4), ...band("broken_connector", "dormant", 4),
  ].map((it) => ({ ...it, vendorFaultMessage: "BatchData: token ability missing" })))
  const broken = withFault.find((s) => s.source === "broken_connector")
  check("majority CONFIG-fault items → 'connector_fault' (not 'cheap_but_fading')", broken?.verdict === "connector_fault")
  check("configFaultCount reflects every faulted item", broken?.configFaultCount === 8)

  // POSITIVE CONTROL — the SAME decayed shape with NO vendor fault message still reads as
  // the ordinary lead-quality verdict, proving connector_fault is not a default.
  const withoutFault = aggregateSourceHealth(band("broken_connector", "at_risk", 4).concat(band("broken_connector", "dormant", 4)))
  const notBroken = withoutFault.find((s) => s.source === "broken_connector")
  check("POSITIVE CONTROL: identical decay with NO vendor fault message → ordinary verdict, configFaultCount 0",
    notBroken?.verdict !== "connector_fault" && notBroken?.configFaultCount === 0)

  // A minority of transient (non-config) vendor errors must not misclassify a genuinely
  // lasting source as broken.
  const mostlyHealthyWithOneTransientError = aggregateSourceHealth([
    ...band("referral", "thriving", 8).map((it) => ({ ...it, vendorFaultMessage: "ETIMEDOUT" })),
    ...band("referral", "warm", 4),
  ])
  check("a transient (non-config) vendor error never flips a lasting source to connector_fault",
    mostlyHealthyWithOneTransientError.find((s) => s.source === "referral")?.verdict === "lasting")

  report()
}

main()
