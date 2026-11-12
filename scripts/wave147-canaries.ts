#!/usr/bin/env tsx
/**
 * scripts/wave147-canaries.ts — `npx tsx scripts/wave147-canaries.ts` (wave 147, lane 147J; key: test:wave147-canaries)
 * ─────────────────────────────────────────────────────────────────────────────
 * The WAVE-147 JOURNEY canaries: seven IN-MEMORY canaries, one per wave-147 lane journey (A consented intake · B movement
 * signals · C conversational buyer · E lead magnet + market report · F listing lifecycle, check-in and the five actions ·
 * G SMS → arbiter → completion · H support loop + the owner obligations). Each is a MULTI-STEP drive on memSupabase through
 * the REAL lane modules (imported, never re-implemented); only the network / send / session edges are seamed, exactly as the
 * lane proofs seam them (scripts/canaries/wave147-harness.ts). Every rule step reads STRIPPED source; every absence step carries
 * a positive control; every canary publishes its blind spots.
 *
 * Modelled on scripts/wave146-canaries.ts (itself the wave-145 runner's shape): the selection, the per-canary line, the verdict
 * table and the RESULT line are the wave-146 runner's, byte for byte in shape; only the roster (WAVE147_CANARY_KEYS) and the
 * WAVE147 label differ. It imports scripts/canaries/wave147-harness.ts FIRST so the edge seams are installed before any lane
 * module links.
 *
 * Verdicts: green · red-awaiting-lane-147X · red-defect · hook (a lane-147Z convergence item not yet landed — pending, never a
 * pass) · pending-owner (an OWNER decision no lane may take — counted apart, never a pass, never a failure).
 * `CANARY_ONLY=<key>[,<key>]` narrows the run; `CANARY_VERBOSE=1` prints every red step's full evidence. Exit 1 while any canary
 * is red. Test data: in-memory only; every tracked row is deleted and counted ("rows deleted").
 */
import "./canaries/_harness"
import { WAVE147_CANARY_KEYS } from "./canaries/wave147-harness"
import type { CanaryReport } from "./canaries/_harness"
import { rulingVerdict } from "./canaries/_registry"

const only = (process.env.CANARY_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean)
const CANARIES = WAVE147_CANARY_KEYS
  .filter((key) => only.length === 0 || only.includes(key))
  .map((key) => ({ key, load: () => import(`./canaries/${key}`) as Promise<{ run: () => Promise<CanaryReport> }> }))

async function main() {
  console.log("══════════════════════════════════════════════════════════════")
  console.log(` Synthetic production canaries (${process.env.CANARY_LIVE === "1" ? "LIVE" : "in-memory"} mode) — WAVE 147 journey roster${only.length ? ` — only ${only.join(",")}` : ""}`)
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
  for (const r of reports) console.log(` ${r.report.passed ? "PASS" : "FAIL"}  ${r.key.padEnd(30)} steps ${r.report.steps.filter((s) => s.ok && !s.hook && !s.pendingOwner).length}/${r.report.steps.filter((s) => !s.hook && !s.pendingOwner).length}${r.report.hooks ? `  hooks ${r.report.hooks}` : ""}${r.report.pendingOwner ? `  pending-owner ${r.report.pendingOwner}` : ""}  deleted ${r.report.cleanup.reduce((n, c) => n + Math.max(0, c.deleted), 0)}  residual ${r.report.residual}${r.report.skipped ? "  (skipped)" : ""}`)
  // THE VERDICT TABLE (the wave-144/145/146 runner's): every red ruling step classified by the owner it names.
  let awaitingTotal = 0, defectTotal = 0
  console.log(" WAVE 147 VERDICTS:")
  for (const r of reports) {
    const v = rulingVerdict(r.report.steps)
    awaitingTotal += Object.values(v.awaiting).reduce((n, x) => n + x, 0); defectTotal += v.defects
    const lanes = Object.entries(v.awaiting).sort(([a], [b]) => a.localeCompare(b)).map(([l, n]) => `red-awaiting-lane-${l}×${n}`)
    const pend = v.pendingOwner ? [`pending-owner×${v.pendingOwner}`] : []
    const hooks = r.report.hooks ? [`hook-147Z×${r.report.hooks}`] : []
    console.log(`   ${r.key.padEnd(30)} ${v.verdict === "green" ? ["green", ...hooks, ...pend].join(", ") : [...lanes, ...(v.defects ? [`red-defect×${v.defects}`] : []), ...hooks, ...pend].join(", ")}`)
  }
  console.log(` WAVE147 RULINGS: ${steps.filter((s) => s.owner).length} ruling steps — ${steps.filter((s) => s.owner && s.ok && !s.pendingOwner).length} green, ${awaitingTotal} red-awaiting-lane, ${defectTotal} red-defect, ${pendingOwnerSteps.length} pending-owner, ${hookSteps.length} convergence hook(s)`)
  for (const s of pendingOwnerSteps) console.log(`   ◌ PENDING OWNER DECISION [${s.owner}]: ${s.pendingOwner}`)
  for (const s of hookSteps) console.log(`   ⏳ ${s.step.slice(0, 200)}`)
  if (process.env.CANARY_VERBOSE === "1") for (const s of steps.filter((x) => !x.ok && !x.hook)) console.log(`   ✗ [${s.owner ?? "—"}] ${s.step.slice(0, 120)}\n       evidence: ${s.evidence}`)
  console.log(` RESULT: canaries ${reports.length}, passed ${reports.length - failedCanaries.length}, failed ${failedCanaries.length}; steps ${passedSteps}/${steps.length - hookSteps.length - pendingOwnerSteps.length}; hooks pending ${hookSteps.length}; pending owner decision ${pendingOwnerSteps.length}; rows deleted ${deleted}`)
  if (failedCanaries.length > 0) { console.log(` ✗ failed: ${failedCanaries.map((r) => r.key).join(", ")}`); process.exit(1) }
  console.log(" ✅ every wave-147 journey canary ran end-to-end and cleaned up")
}

main().catch((e) => { console.error(e); process.exit(1) })
