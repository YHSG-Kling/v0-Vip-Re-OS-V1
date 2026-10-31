#!/usr/bin/env tsx
/**
 * scripts/wave145-canaries.ts — `npx tsx scripts/wave145-canaries.ts` (wave 145, lane 145J; key to register: test:wave145-canaries)
 * ─────────────────────────────────────────────────────────────────────────────
 * The WAVE-145 OWNER-RULING canaries: eight IN-MEMORY canaries, one per area of the "Required proofs" list (security · listings ·
 * financial onboarding · providers/channels · lead/contact · signals · marketing · compliance/UX), each asserting the owner's
 * 2026-10-27 RULINGS and the cross-lane CONTRACTS C1–C7 of WAVE145_SPEC.md — never a lane's internal shape.
 *
 * Modelled on scripts/wave144-canaries.ts and the ONE canary runner (scripts/canaries/run-canaries.ts), on the SAME harness:
 * canary() / canaryClient / cleanupCanary / landedModule (_harness.ts), rulingVerdict (_registry.ts). The selection, the per-canary
 * line, the verdict table and the RESULT line are the wave-144 runner's, byte for byte in shape; only the roster
 * (WAVE145_CANARY_KEYS, scripts/canaries/wave145-harness.ts) and the WAVE145 label differ. It is a separate entry because
 * run-canaries.ts selects its roster by CANARY_WAVE=144 only and lies outside this lane's file domain — the integrator may fold it in
 * as CANARY_WAVE=145 (lane 145J notes, Outside-lane).
 *
 * Verdicts: green · red-awaiting-lane-145X (the lane whose brief carries the behaviour has not landed it) · red-defect (no wave-145
 * brief owns it) · pending-owner (an OWNER decision no lane may take — counted apart, never a pass, never a failure).
 * `CANARY_ONLY=<key>[,<key>]` narrows the run. Exit 1 while any canary is red.
 */
import "./canaries/_harness"
import type { CanaryReport } from "./canaries/_harness"
import { rulingVerdict } from "./canaries/_registry"
import { WAVE145_CANARY_KEYS } from "./canaries/wave145-harness"

const only = (process.env.CANARY_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean)
const CANARIES = WAVE145_CANARY_KEYS
  .filter((key) => only.length === 0 || only.includes(key))
  .map((key) => ({ key, load: () => import(`./canaries/${key}`) as Promise<{ run: () => Promise<CanaryReport> }> }))

async function main() {
  console.log("══════════════════════════════════════════════════════════════")
  console.log(` Synthetic production canaries (${process.env.CANARY_LIVE === "1" ? "LIVE" : "in-memory"} mode) — WAVE 145 owner-ruling roster${only.length ? ` — only ${only.join(",")}` : ""}`)
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
  const pendingOwnerSteps = steps.filter((s) => s.pendingOwner)
  const passedSteps = steps.filter((s) => s.ok && !s.hook && !s.pendingOwner).length
  const failedCanaries = reports.filter((r) => !r.report.passed)
  const deleted = reports.flatMap((r) => r.report.cleanup).reduce((n, c) => n + Math.max(0, c.deleted), 0)
  console.log("\n──────────────────────────────────────────────────────────────")
  for (const r of reports) console.log(` ${r.report.passed ? "PASS" : "FAIL"}  ${r.key.padEnd(22)} steps ${r.report.steps.filter((s) => s.ok && !s.hook && !s.pendingOwner).length}/${r.report.steps.filter((s) => !s.hook && !s.pendingOwner).length}${r.report.hooks ? `  hooks ${r.report.hooks}` : ""}${r.report.pendingOwner ? `  pending-owner ${r.report.pendingOwner}` : ""}  deleted ${r.report.cleanup.reduce((n, c) => n + Math.max(0, c.deleted), 0)}  residual ${r.report.residual}${r.report.skipped ? "  (skipped)" : ""}`)
  // THE VERDICT TABLE (the wave-144 runner's): every red ruling step classified by the owner it names.
  let awaitingTotal = 0, defectTotal = 0
  console.log(" WAVE 145 VERDICTS:")
  for (const r of reports) {
    const v = rulingVerdict(r.report.steps)
    awaitingTotal += Object.values(v.awaiting).reduce((n, x) => n + x, 0); defectTotal += v.defects
    const lanes = Object.entries(v.awaiting).sort(([a], [b]) => a.localeCompare(b)).map(([l, n]) => `red-awaiting-lane-${l}×${n}`)
    const pend = v.pendingOwner ? [`pending-owner×${v.pendingOwner}`] : []
    console.log(`   ${r.key.padEnd(22)} ${v.verdict === "green" ? ["green", ...pend].join(", ") : [...lanes, ...(v.defects ? [`red-defect×${v.defects}`] : []), ...pend].join(", ")}`)
  }
  console.log(` WAVE145 RULINGS: ${steps.filter((s) => s.owner).length} ruling steps — ${steps.filter((s) => s.owner && s.ok && !s.pendingOwner).length} green, ${awaitingTotal} red-awaiting-lane, ${defectTotal} red-defect, ${pendingOwnerSteps.length} pending-owner`)
  for (const s of pendingOwnerSteps) console.log(`   ◌ PENDING OWNER DECISION [${s.owner}]: ${s.pendingOwner}`)
  console.log(` RESULT: canaries ${reports.length}, passed ${reports.length - failedCanaries.length}, failed ${failedCanaries.length}; steps ${passedSteps}/${steps.length - hookSteps.length - pendingOwnerSteps.length}; hooks pending ${hookSteps.length}; pending owner decision ${pendingOwnerSteps.length}; rows deleted ${deleted}`)
  if (failedCanaries.length > 0) { console.log(` ✗ failed: ${failedCanaries.map((r) => r.key).join(", ")}`); process.exit(1) }
  console.log(" ✅ every wave-145 owner-ruling canary ran end-to-end and cleaned up")
}

main().catch((e) => { console.error(e); process.exit(1) })
