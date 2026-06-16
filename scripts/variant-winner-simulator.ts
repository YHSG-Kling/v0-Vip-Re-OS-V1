#!/usr/bin/env tsx
/**
 * scripts/variant-winner-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the self-improving-copy learning core: when the source diagnostic flags a wording issue
 * and a 2nd ai_intent variant runs, pickWinningVariant decides which phrasing wins by reply rate —
 * sample-size + margin gated so it never flips on noise (safe default: null = keep testing).
 * Pure + shell-runnable. No mocks.
 *
 * Run: npx tsx scripts/variant-winner-simulator.ts   (npm run test:variant-winner)
 */
import { pickWinningVariant, DEFAULT_MIN_SAMPLE } from "../lib/lead-pipeline/variant-winner"

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
  console.log(" ✅ Variant winner verified — clear winners promoted, noise/ties keep testing.")
  console.log(" VARIANT_WINNER_PASS")
  process.exit(0)
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Variant winner (self-improving copy) simulator")
  console.log("══════════════════════════════════════════════════\n")

  // Clear winner: A 12% vs B 4%, both well-sampled → promote A.
  const clear = pickWinningVariant([{ variant: "A", sent: 100, replies: 12 }, { variant: "B", sent: 100, replies: 4 }])
  check("clear winner promoted", clear.winner === "A" && (clear.winnerRate ?? 0) > 0.1)

  // Too close: A 11% vs B 10% → within margin → keep testing.
  check("near-tie → keep testing (no flip on noise)", pickWinningVariant([{ variant: "A", sent: 200, replies: 22 }, { variant: "B", sent: 200, replies: 20 }]).winner === null)

  // Insufficient sample: B only 10 sends → only A qualifies → keep testing.
  check(`< ${DEFAULT_MIN_SAMPLE} sends on a variant → that variant excluded; <2 qualify → keep testing`,
    pickWinningVariant([{ variant: "A", sent: 100, replies: 10 }, { variant: "B", sent: 10, replies: 3 }]).winner === null)

  // No replies at all → keep testing (don't crown a 0% winner).
  check("zero replies anywhere → keep testing", pickWinningVariant([{ variant: "A", sent: 100, replies: 0 }, { variant: "B", sent: 100, replies: 0 }]).winner === null)

  // Single variant → nothing to compare.
  check("single variant → keep testing", pickWinningVariant([{ variant: "A", sent: 100, replies: 12 }]).winner === null)

  // Custom margin: a 5% lead with a 0.04 margin → wins.
  check("custom margin honored", pickWinningVariant([{ variant: "A", sent: 200, replies: 21 }, { variant: "B", sent: 200, replies: 20 }], { margin: 0.04 }).winner === "A")

  report()
}

main()
