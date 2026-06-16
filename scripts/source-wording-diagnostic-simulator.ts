#!/usr/bin/env tsx
/**
 * scripts/source-wording-diagnostic-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the SOURCE WORDING-vs-QUALITY DIAGNOSTIC — before downranking a source by outcomes, decide
 * if it's a fixable COPY problem or a genuinely bad source. The discriminator: low engagement +
 * HEALTHY downstream conversion = wording (test new copy, DON'T downrank); low engagement + weak
 * downstream = source quality (downrank candidate). Advisory only — never auto-downranks.
 *
 * Pure + shell-runnable. No mocks.
 *
 * Run: npx tsx scripts/source-wording-diagnostic-simulator.ts   (npm run test:source-wording)
 */
import { diagnoseSource } from "../lib/lead-pipeline/source-wording-diagnostic"

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
  console.log(" ✅ Source diagnostic verified — wording vs source-quality distinguished; never auto-downranks.")
  console.log(" SOURCE_WORDING_PASS")
  process.exit(0)
}

const B = { leadToContactRate: 20, contactToApptRate: 15, earlyStepReplyRate: 0.10 }

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Source wording-vs-quality diagnostic simulator")
  console.log("══════════════════════════════════════════════════\n")

  // Too little data → don't judge.
  const insufficient = diagnoseSource({ leadToContactRate: 5, contactToApptRate: 2, closeRate: 0, earlyStepOpenRate: 0.1, earlyStepReplyRate: 0.01, sentVolume: 10, benchmarks: B })
  check("low volume → insufficient_data / gather_more_data", insufficient.verdict === "insufficient_data" && insufficient.recommendation === "gather_more_data")

  // Healthy engagement → keep.
  const healthy = diagnoseSource({ leadToContactRate: 22, contactToApptRate: 16, closeRate: 10, earlyStepOpenRate: 0.4, earlyStepReplyRate: 0.12, sentVolume: 200, benchmarks: B })
  check("engagement near/above benchmark → healthy / keep_as_is", healthy.verdict === "healthy" && healthy.recommendation === "keep_as_is")

  // THE KEY CASE: low engagement BUT healthy downstream + qualifies → WORDING, not a bad source.
  const wording = diagnoseSource({ leadToContactRate: 18, contactToApptRate: 14, closeRate: 8, earlyStepOpenRate: 0.15, earlyStepReplyRate: 0.02, sentVolume: 150, benchmarks: B })
  check("low replies + healthy downstream → WORDING issue (NOT downrank)", wording.verdict === "wording_issue" && wording.recommendation === "test_different_copy", JSON.stringify(wording))

  // Low engagement + leads don't even qualify → targeting.
  const targeting = diagnoseSource({ leadToContactRate: 5, contactToApptRate: 14, closeRate: 5, earlyStepOpenRate: 0.1, earlyStepReplyRate: 0.02, sentVolume: 150, benchmarks: B })
  check("low replies + leads don't qualify → targeting_issue / test_cadence", targeting.verdict === "targeting_issue" && targeting.recommendation === "test_cadence", JSON.stringify(targeting))

  // Low engagement AND weak downstream → genuinely bad source → downrank candidate.
  const bad = diagnoseSource({ leadToContactRate: 18, contactToApptRate: 3, closeRate: 0, earlyStepOpenRate: 0.08, earlyStepReplyRate: 0.02, sentVolume: 150, benchmarks: B })
  check("low replies + weak downstream → source_quality_issue / downrank", bad.verdict === "source_quality_issue" && bad.recommendation === "downrank", JSON.stringify(bad))

  // Safety: the diagnostic NEVER returns downrank for a healthy-downstream source (the user's point).
  check("a source with any closings is never downranked on copy alone", diagnoseSource({ leadToContactRate: 18, contactToApptRate: 5, closeRate: 4, earlyStepOpenRate: 0.05, earlyStepReplyRate: 0.01, sentVolume: 150, benchmarks: B }).recommendation !== "downrank")

  report()
}

main()
