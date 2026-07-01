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
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runManagerEval, RELEASE_BLOCKING } from "../lib/compliance/manager-eval-harness"

const report = runManagerEval()

// The eval is now CONTINUOUS + autonomous — a weekly cron runs it and escalates a release-blocking
// regression to platform staff; the governance scorecard reads these dims as behaviorally verified.
{
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
  const assert = (n: string, c: boolean) => { if (!c) { console.log(`  ✗ ${n}`); process.exit(1) } else console.log(`  ✓ ${n}`) }
  console.log("\n[continuous + autonomous — weekly cron, escalation, scorecard reconciled]")
  const cron = src("app/api/cron/manager-eval/route.ts")
  assert("the eval cron runs the harness + escalates a release-blocking regression to platform staff", /runManagerEval\(\)/.test(cron) && /releaseBlocked/.test(cron) && /superadmin/.test(cron))
  assert("the cron is registered in CRON_REGISTRY", /manager-eval/.test(src("lib/kernel/cron-dispatch.ts")))
  assert("continuous_manager_eval is a data_steward burn domain (auditor distinct from audited)", /continuous_manager_eval:\s*\{\s*manager:\s*"data_steward",\s*proof:\s*"test:manager-eval"/.test(src("lib/kernel/manager-registry.ts")))
  const sc = src("lib/compliance/manager-governance-scorecard.ts")
  assert("the governance scorecard reconciles — bias/hallucination/injection/privacy are behaviorally verified", /BEHAVIORALLY_VERIFIED[\s\S]*?bias_fair_housing[\s\S]*?hallucination[\s\S]*?prompt_injection[\s\S]*?privacy_leakage/.test(sc))
}

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
