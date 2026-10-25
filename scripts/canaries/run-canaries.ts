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
 *
 * WAVE 142 (lane 142J — final convergence): thirteen more canaries on the SAME harness, one per journey on the
 * owner's list (support-isolation, listing-lifecycle, offer-lifecycle, form-wizard, preliminary-cd, cda-closing,
 * commission-payment, lifetime, immediate-enrichment, autonomous-marketing, video-pipeline, ai-by-your-side,
 * commercial-platform), every one IN-MEMORY ONLY (the live database has never been operated — a live run would
 * prove nothing). Steps written against lanes 142A–I's contracts are WAVE142 HOOKS (same probes, same ⏳), and the
 * census prints one line per wave.
 *
 * WAVE 144 (lane 144J — integrated real-estate, financial & AI canaries): `CANARY_WAVE=144` (scripts/wave144-canaries.ts,
 * `test:wave144-canaries`) runs the fourteen wave-144 OWNER-RULING canaries (WAVE144_CANARY_KEYS) on this same runner and
 * harness. Their steps are RULING steps (c.rule — owner lane named): never pending, red where HEAD does not yet behave as the
 * owner ruled, and the runner prints a VERDICT TABLE (green / red-awaiting-lane-X / red-defect) beside the RESULT line. The
 * default roster is untouched.
 */
import "./_harness"
import type { CanaryReport } from "./_harness"
import { CANARY_KEYS, WAVE144_CANARY_KEYS, hookCensus, rulingVerdict } from "./_registry"

const only = (process.env.CANARY_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean)
// WAVE 144 (lane 144J): CANARY_WAVE=144 runs the wave-144 ruling roster instead (scripts/wave144-canaries.ts sets it); the
// default roster — and so `test:canaries` and the release gate — is unchanged.
const WAVE144 = process.env.CANARY_WAVE === "144"
const ROSTER: readonly string[] = WAVE144 ? WAVE144_CANARY_KEYS : CANARY_KEYS
const CANARIES: Array<{ key: string; load: () => Promise<{ run: () => Promise<CanaryReport> }> }> = ROSTER
  .filter((key) => only.length === 0 || only.includes(key))
  .map((key) => ({ key, load: () => import(`./${key}`) as Promise<{ run: () => Promise<CanaryReport> }> }))

async function main() {
  console.log("══════════════════════════════════════════════════════════════")
  console.log(` Synthetic production canaries (${process.env.CANARY_LIVE === "1" ? "LIVE" : "in-memory"} mode)${WAVE144 ? " — WAVE 144 owner-ruling roster" : ""}${only.length ? ` — only ${only.join(",")}` : ""}`)
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
  if (WAVE144) {
    // THE VERDICT TABLE (lane 144J): every red ruling step classified by the owner it names — red-awaiting-lane-X (a wave-144
    // lane's brief carries the fix) or red-defect (no lane owns it; a cleanup / fixture failure is a defect too).
    let awaitingTotal = 0, defectTotal = 0
    console.log(" WAVE 144 VERDICTS:")
    for (const r of reports) {
      const v = rulingVerdict(r.report.steps)
      awaitingTotal += Object.values(v.awaiting).reduce((n, x) => n + x, 0); defectTotal += v.defects
      const lanes = Object.entries(v.awaiting).map(([l, n]) => `red-awaiting-lane-${l}×${n}`)
      console.log(`   ${r.key.padEnd(16)} ${v.verdict === "green" ? "green" : [...lanes, ...(v.defects ? [`red-defect×${v.defects}`] : [])].join(", ")}`)
    }
    console.log(` WAVE144 RULINGS: ${steps.filter((s) => s.owner).length} ruling steps — ${steps.filter((s) => s.owner && s.ok).length} green, ${awaitingTotal} red-awaiting-lane, ${defectTotal} red-defect`)
  }
  // THE HOOK CENSUS — read from the registry's probes (stripped source), not from the steps, so the
  // runner and the release gate (production-readiness-guard section G) print the same facts. One line per
  // wave (lane 142J): the wave-141 hooks landed through integration; the wave-142 hooks are the lanes A–I
  // still to land at fec8b6a95.
  // (The wave-144 roster carries no hooks — a ruling step is never pending — so its run prints the verdict table instead.)
  for (const wave of WAVE144 ? [] : (["141", "142"] as const)) {
    const census = hookCensus(wave)
    const byLane = new Map<string, number>()
    for (const h of census.pending) byLane.set(h.lane, (byLane.get(h.lane) ?? 0) + 1)
    console.log(` WAVE${wave} HOOKS: ${census.pending.length} pending (${[...byLane].map(([l, n]) => `${l}×${n}`).join(", ") || "none"}), ${census.landed.length} landed${census.landed.length ? ` (${census.landed.map((h) => `${h.lane}@${h.at}`).join(", ")})` : ""}`)
  }
  console.log(` RESULT: canaries ${reports.length}, passed ${reports.length - failedCanaries.length}, failed ${failedCanaries.length}; steps ${passedSteps}/${steps.length - hookSteps.length}; hooks pending ${hookSteps.length}; rows deleted ${deleted}`)
  if (failedCanaries.length > 0) { console.log(` ✗ failed: ${failedCanaries.map((r) => r.key).join(", ")}`); process.exit(1) }
  console.log(hookSteps.length ? ` ✅ every business chain ran end-to-end and cleaned up — ${hookSteps.length} contract step(s) still behind a WAVE141/WAVE142 HOOK (the release gate reads them as NOT CERTIFIED)` : " ✅ every business chain ran end-to-end and cleaned up")
}

main().catch((e) => { console.error(e); process.exit(1) })
