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
 *
 * WAVE 141 (lane 141J — certification): fourteen more canaries on the SAME harness, the roster now in
 * scripts/canaries/_registry.ts (CANARY_KEYS — the release gate reads the same list): solo-subscriber,
 * same-name-brokerage, brokerage-adoption, user-invite, lead-magnet, business-card, transaction-provider,
 * cda-esign, legal-description, crm-outbound, crm-inbound, coupon, custom-domain, mobile. A step written
 * against another lane's contract whose module is absent at HEAD is a WAVE141 HOOK (⏳ pending — counted
 * beside the RESULT line, never a pass); the census of pending hooks is printed from the registry's
 * probes so the integrator sees exactly what to wire. `CANARY_ONLY=<key>[,<key>]` runs a subset.
 */
import "./_harness"
import type { CanaryReport } from "./_harness"
import { CANARY_KEYS, hookCensus } from "./_registry"

const only = (process.env.CANARY_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean)
const CANARIES: Array<{ key: string; load: () => Promise<{ run: () => Promise<CanaryReport> }> }> = CANARY_KEYS
  .filter((key) => only.length === 0 || only.includes(key))
  .map((key) => ({ key, load: () => import(`./${key}`) as Promise<{ run: () => Promise<CanaryReport> }> }))

async function main() {
  console.log("══════════════════════════════════════════════════════════════")
  console.log(` Synthetic production canaries (${process.env.CANARY_LIVE === "1" ? "LIVE" : "in-memory"} mode)${only.length ? ` — only ${only.join(",")}` : ""}`)
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
      reports.push({ key, report: { chain: key, steps: [{ step: "threw", ok: false, evidence: (e as Error).message }], blindSpots: [], cleanup: [], residual: -1, skipped: null, passed: false, hooks: 0 } })
    }
  }
  const steps = reports.flatMap((r) => r.report.steps)
  const hookSteps = steps.filter((s) => s.hook)
  const passedSteps = steps.filter((s) => s.ok && !s.hook).length
  const failedCanaries = reports.filter((r) => !r.report.passed)
  const deleted = reports.flatMap((r) => r.report.cleanup).reduce((n, c) => n + Math.max(0, c.deleted), 0)
  console.log("\n──────────────────────────────────────────────────────────────")
  for (const r of reports) console.log(` ${r.report.passed ? "PASS" : "FAIL"}  ${r.key.padEnd(20)} steps ${r.report.steps.filter((s) => s.ok && !s.hook).length}/${r.report.steps.filter((s) => !s.hook).length}${r.report.hooks ? `  hooks ${r.report.hooks}` : ""}  deleted ${r.report.cleanup.reduce((n, c) => n + Math.max(0, c.deleted), 0)}  residual ${r.report.residual}${r.report.skipped ? "  (skipped)" : ""}`)
  // THE HOOK CENSUS — read from the registry's probes (stripped source), not from the steps, so the
  // runner and the release gate (production-readiness-guard section G) print the same facts.
  const census = hookCensus()
  const byLane = new Map<string, number>()
  for (const h of census.pending) byLane.set(h.lane, (byLane.get(h.lane) ?? 0) + 1)
  console.log(` WAVE141 HOOKS: ${census.pending.length} pending (${[...byLane].map(([l, n]) => `${l}×${n}`).join(", ") || "none"}), ${census.landed.length} landed${census.landed.length ? ` (${census.landed.map((h) => `${h.lane}@${h.at}`).join(", ")})` : ""}`)
  console.log(` RESULT: canaries ${reports.length}, passed ${reports.length - failedCanaries.length}, failed ${failedCanaries.length}; steps ${passedSteps}/${steps.length - hookSteps.length}; hooks pending ${hookSteps.length}; rows deleted ${deleted}`)
  if (failedCanaries.length > 0) { console.log(` ✗ failed: ${failedCanaries.map((r) => r.key).join(", ")}`); process.exit(1) }
  console.log(hookSteps.length ? ` ✅ every business chain ran end-to-end and cleaned up — ${hookSteps.length} contract step(s) still behind a WAVE141 HOOK (the release gate reads them as NOT CERTIFIED)` : " ✅ every business chain ran end-to-end and cleaned up")
}

main().catch((e) => { console.error(e); process.exit(1) })
