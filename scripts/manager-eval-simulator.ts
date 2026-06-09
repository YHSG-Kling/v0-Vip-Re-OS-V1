#!/usr/bin/env tsx
/**
 * scripts/manager-eval-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 54 — runs the autonomous-manager evaluation harness (FINRA 2026 framework)
 * and prints the compliance scorecard. Every case exercises a REAL deterministic
 * governance guard against adversarial input — no mocks, no Anthropic API. A
 * release-blocking failure (bias / privacy / injection) exits non-zero.
 *
 * Run: npx tsx scripts/manager-eval-simulator.ts  (npm run test:manager-eval) — no DB.
 */
import { runManagerEval, RELEASE_BLOCKING } from "../lib/compliance/manager-eval-harness"

const report = runManagerEval()

console.log("══════════════════════════════════════════════════")
console.log(" Autonomous-Manager Eval Harness — FINRA 2026 compliance scorecard")
console.log("══════════════════════════════════════════════════")
for (const c of report.cases) {
  const mark = c.pass ? "✓" : "✗"
  const blocking = RELEASE_BLOCKING.has(c.category) ? "🔒" : "  "
  console.log(`  ${mark} ${blocking} [${c.category}] ${c.id} (${c.manager}) — ${c.detail}`)
}
console.log("\n── By category ──")
for (const [cat, b] of Object.entries(report.byCategory)) {
  console.log(`  ${cat.padEnd(20)} ${b.passed}/${b.total} pass${RELEASE_BLOCKING.has(cat as never) ? "  (release-blocking)" : ""}`)
}
console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${report.passed}/${report.total} passed · release ${report.releaseBlocked ? "BLOCKED 🔒" : "CLEARED ✅"}`)
if (report.failed > 0) {
  console.log(" ✗ Failures:")
  for (const c of report.cases.filter((x) => !x.pass)) console.log(`   - ${c.id}: ${c.detail} [${c.severity}]`)
  process.exit(1)
}
console.log(" ✅ Every manager's client-facing output is Fair-Housing-clean, injection-resistant, and leak-free")
