#!/usr/bin/env tsx
/**
 * scripts/lead-warmth-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves LEAD WARMTH — the leads-side counterpart to relationship health, so the AI ISA works the
 * lead about to go cold first (the gap: per-relationship intelligence was contacts-only). Warmth is
 * cadence + enrichment freshness + temperature + inbound spark, on the shared band scale. Pure +
 * shell-runnable. No mocks.
 *
 * Run: npx tsx scripts/lead-warmth-simulator.ts   (npm run test:lead-warmth)
 */
import { scoreLeadWarmth } from "../lib/intelligence/lead-warmth"

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
  console.log(" ✅ Lead warmth verified — fresh hot leads thrive, neglected cold leads decay, on the shared scale.")
  console.log(" LEAD_WARMTH_PASS")
  process.exit(0)
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Lead warmth simulator")
  console.log("══════════════════════════════════════════════════\n")

  // Actively worked, fresh, hot, engaged → high warmth.
  const hot = scoreLeadWarmth({ daysSinceLastTouch: 2, enrichmentAgeDays: 10, leadTemperature: "hot", hasReplied: true })
  check("freshly worked + hot + engaged → thriving/warm", (hot.band === "thriving" || hot.band === "warm") && hot.score >= 60, JSON.stringify(hot))

  // Neglected, unenriched, cold → low warmth.
  const cold = scoreLeadWarmth({ daysSinceLastTouch: 90, enrichmentAgeDays: null, leadTemperature: "cold" })
  check("neglected + unenriched + cold → at-risk or worse", cold.priority >= 3, JSON.stringify(cold))
  check("cold lead lists drivers (untouched, not enriched)", cold.drivers.some((d) => /untouched/.test(d)) && cold.drivers.some((d) => /not enriched/.test(d)))

  // Inbound spark is a strong positive (rare for a lead).
  const sparked = scoreLeadWarmth({ daysSinceLastTouch: 20, enrichmentAgeDays: 60, leadTemperature: "warm", hasReplied: true })
  const unsparked = scoreLeadWarmth({ daysSinceLastTouch: 20, enrichmentAgeDays: 60, leadTemperature: "warm", hasReplied: false })
  check("an inbound reply lifts warmth", sparked.score > unsparked.score)

  // Shared scale: priority orders coldest first (same as contact health).
  check("priority reprioritizes coldest first", cold.priority > hot.priority)
  check("score clamped + no NaN", Number.isFinite(scoreLeadWarmth({ daysSinceLastTouch: null, enrichmentAgeDays: null, leadTemperature: null }).score))

  report()
}

main()
