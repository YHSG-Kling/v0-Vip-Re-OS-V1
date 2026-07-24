#!/usr/bin/env tsx
/**
 * scripts/autonomy-accuracy-glance-simulator.ts  (npm run test:autonomy-accuracy-glance)
 * ─────────────────────────────────────────────────────────────────────────────
 * AUTONOMY IS EARNED, AND THAT GOVERNANCE MUST BE VISIBLE ON THE ONE SCREEN.
 * The prediction-accuracy gate/holds surfaced only on Manager Trust; the
 * Command Center — the operator's one screen — showed only the behavioral trust
 * meter + earned-autonomy grants. This proves the compact glance now mirrors the
 * accuracy gate onto the Command Center: (1) the REAL pure summarizer folds
 * per-domain verdicts + hold rollup correctly, ignoring not_applicable domains
 * and reporting an honest "still learning" until a domain has a verdict; (2) the
 * card + page are wired, best-effort, with a link back to the full report.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { summarizeAutonomyAccuracy } from "../lib/managers/accuracy-gate"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

const V = (state: string, domain = "pricing") =>
  ({ domain, railId: null, railLabel: null, state, observations: 0, reason: "" } as any)

console.log("\n── the REAL pure summarizer folds verdicts + holds correctly ──")
{
  // Mixed verdicts + a hold rollup.
  const s = summarizeAutonomyAccuracy(
    [V("earned"), V("earned"), V("supervised"), V("no_signal"), V("not_applicable")],
    { windowDays: 30, totalHolds: 4, rows: [] },
  )
  check("counts earned domains", s.earned === 2)
  check("counts supervised domains", s.supervised === 1)
  check("counts gathering (no_signal) domains", s.gathering === 1)
  check("not_applicable domains are excluded entirely", s.earned + s.supervised + s.gathering === 4)
  check("held reflects the rollup total", s.held === 4)
  check("holdWindowDays reflects the rollup window", s.holdWindowDays === 30)
  check("hasSignal true when a domain is earned/supervised", s.hasSignal === true)

  // No holds rollup at all (loader returned null) → held 0, default window.
  const s2 = summarizeAutonomyAccuracy([V("earned")], null)
  check("null hold rollup → held 0, default 30d window", s2.held === 0 && s2.holdWindowDays === 30)

  // Only not_applicable / no_signal → honest "still learning".
  const s3 = summarizeAutonomyAccuracy([V("not_applicable"), V("no_signal")], null)
  check("no earned/supervised domain → hasSignal false (still learning)", s3.hasSignal === false)
  check("gathering still counted when only no_signal present", s3.gathering === 1)

  // Empty input is safe.
  const s4 = summarizeAutonomyAccuracy([], null)
  check("empty verdicts → all zeros, hasSignal false", s4.earned === 0 && s4.held === 0 && s4.hasSignal === false)
}

console.log("\n── the Command Center is wired to the glance (best-effort, linked) ──")
{
  const page = src("app/dashboard/admin/command-center/page.tsx")
  check("page loads the report + hold rollup and summarizes them",
    /loadAccuracyGateReport[\s\S]*?loadAccuracyHoldRollup[\s\S]*?summarizeAutonomyAccuracy\(/.test(page))
  check("the load is best-effort (try/catch) so it never blocks the Command Center",
    /try \{[\s\S]*?summarizeAutonomyAccuracy[\s\S]*?\} catch/.test(page))
  check("the load is brokerage-scoped, not superadmin platform-wide",
    /brokerageId && userType !== "superadmin"[\s\S]*?loadAccuracyGateReport/.test(page))
  check("the card renders in the panel stack", /<AutonomyAccuracyCard summary=\{autonomyAccuracy\} \/>/.test(page))

  const card = src("app/dashboard/admin/command-center/autonomy-accuracy-card.tsx")
  check("card links to the full report on Manager Trust", card.includes("/dashboard/admin/manager-trust"))
  check("card has an honest 'still learning' branch when hasSignal is false",
    card.includes("Still learning") && /hasSignal \?/.test(card))
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ AUTONOMY_ACCURACY_GLANCE_FAIL"); process.exit(1) }
console.log(" ✅ AUTONOMY_ACCURACY_GLANCE_PASS — the earned-autonomy governance is visible on the one screen, honestly")
