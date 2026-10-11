#!/usr/bin/env tsx
/**
 * scripts/canaries/run-canaries.ts — `npm run test:canaries`
 * ─────────────────────────────────────────────────────────────────────────────
 * SYNTHETIC PRODUCTION CANARIES (wave 140, lane L). ONE runner drives the seven business
 * chains end-to-end through the REAL kernel services with providers stubbed per repo
 * policy (scripts/canaries/_harness.ts): subscriber, seat, lead, buyer, seller,
 * communication, self-healing. Each canary publishes its chain steps, its blind spots and
 * its cleanup counts; the runner prints one RESULT line and exits non-zero on any failed
 * step, any cleanup mismatch, or any residual tagged row.
 *
 * Audit at 9bb0208ce (why this exists): scripts/e2e-lifecycle-harness.ts (lead → deal →
 * closed, creds-gated), scripts/e2e-lead-to-transaction.ts (lead → offer → transaction,
 * creds-gated, not package-registered), scripts/lead-flow-e2e.ts (scrape pipeline, pure)
 * and scripts/portal-e2e-simulator.ts (the egress final hop, creds-gated) each prove ONE
 * chain and SKIP without a database. No subscriber / seat / self-healing chain existed, and
 * nothing ran the chains without credentials. The canaries reuse those harnesses' methods
 * (tag + counted delete, suppressed-contact gating) on the in-memory client so the chains
 * run everywhere; under CANARY_LIVE=1 the same code runs against the live project.
 *
 * Blind spots are printed beside the numbers (CLAUDE.md §2); the RESULT line is the signal.
 */
import "./_harness"
import type { CanaryReport } from "./_harness"

const CANARIES: Array<{ key: string; load: () => Promise<{ run: () => Promise<CanaryReport> }> }> = [
  { key: "subscriber", load: () => import("./subscriber") },
  { key: "seat", load: () => import("./seat") },
  { key: "lead", load: () => import("./lead") },
  { key: "buyer", load: () => import("./buyer") },
  { key: "seller", load: () => import("./seller") },
  { key: "communication", load: () => import("./communication") },
  { key: "self-healing", load: () => import("./self-healing") },
]

async function main() {
  console.log("══════════════════════════════════════════════════════════════")
  console.log(` Synthetic production canaries (${process.env.CANARY_LIVE === "1" ? "LIVE" : "in-memory"} mode)`)
  console.log("══════════════════════════════════════════════════════════════")
  const reports: Array<{ key: string; report: CanaryReport }> = []
  for (const { key, load } of CANARIES) {
    console.log(`\n▶ ${key}`)
    try {
      const mod = await load()
      const report = await mod.run()
      if (report.skipped) console.log(`    ⏭  skipped — ${report.skipped}`)
      for (const b of report.blindSpots) console.log(`    · blind spot: ${b}`)
      reports.push({ key, report })
    } catch (e) {
      console.log(`    ✗ THREW: ${(e as Error).stack ?? String(e)}`)
      reports.push({ key, report: { chain: key, steps: [{ step: "threw", ok: false, evidence: (e as Error).message }], blindSpots: [], cleanup: [], residual: -1, skipped: null, passed: false } })
    }
  }
  const steps = reports.flatMap((r) => r.report.steps)
  const passedSteps = steps.filter((s) => s.ok).length
  const failedCanaries = reports.filter((r) => !r.report.passed)
  const deleted = reports.flatMap((r) => r.report.cleanup).reduce((n, c) => n + Math.max(0, c.deleted), 0)
  console.log("\n──────────────────────────────────────────────────────────────")
  for (const r of reports) console.log(` ${r.report.passed ? "PASS" : "FAIL"}  ${r.key.padEnd(14)} steps ${r.report.steps.filter((s) => s.ok).length}/${r.report.steps.length}  deleted ${r.report.cleanup.reduce((n, c) => n + Math.max(0, c.deleted), 0)}  residual ${r.report.residual}${r.report.skipped ? "  (skipped)" : ""}`)
  console.log(` RESULT: canaries ${reports.length}, passed ${reports.length - failedCanaries.length}, failed ${failedCanaries.length}; steps ${passedSteps}/${steps.length}; rows deleted ${deleted}`)
  if (failedCanaries.length > 0) { console.log(` ✗ failed: ${failedCanaries.map((r) => r.key).join(", ")}`); process.exit(1) }
  console.log(" ✅ every business chain ran end-to-end and cleaned up")
}

main().catch((e) => { console.error(e); process.exit(1) })
