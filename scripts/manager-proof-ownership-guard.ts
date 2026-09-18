#!/usr/bin/env tsx
/**
 * scripts/manager-proof-ownership-guard.ts (npm run test:proof-ownership)
 * ─────────────────────────────────────────────────────────────────────────────
 * A FEATURE WITHOUT AN ACCOUNTABLE MANAGER IS NOW A BUILD BREAK.
 *
 * MAINTENANCE_DOMAINS is this OS's ownership ledger: each entry names the manager
 * accountable for a domain and the proof that holds it. test:manager-ownership
 * checks that every DECLARED domain has a valid manager — but it never asked the
 * other direction: does every PROOF have a domain?
 *
 * It did not, and six features shipped across two days with no owner at all while
 * the guard stayed green. That is exactly the drift class this repo keeps closing
 * structurally rather than by remembering: a route with no inbound link, a read
 * with no writer, a CHECK value no picker can produce.
 *
 * So: the proof list is derived from package.json (never a hand-kept copy), the
 * owned set from MAINTENANCE_DOMAINS, and everything unowned is compared against a
 * SHRINK-ONLY baseline. The legacy backlog can only get smaller; a NEW unowned
 * proof FAILS. Adding a feature now means answering "whose is it?".
 *
 * Why a baseline rather than demanding all 425 at once: most of those proofs are
 * unit-level checks of a domain that IS owned — the ownership ledger is
 * deliberately domain-grained, not script-grained. Forcing a 1:1 mapping would
 * turn a real invariant into noise. The ratchet gets the behaviour we want (no new
 * orphans) without inventing 400 fake domains.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"

const ROOT = process.cwd()
const BASELINE_PATH = join(ROOT, "scripts", "proof-ownership-baseline.json")

// Every proof the repo can run, from the one place that defines them.
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>
}
const allProofs = Object.keys(pkg.scripts)
  .filter((s) => s.startsWith("test:"))
  // Aggregate/meta scripts are not features and own nothing.
  .filter((s) => !["test:e2e", "test:e2e:ui", "test:sweep"].includes(s))
  .sort()

// Every proof some manager is accountable for.
const ownedProofs = new Set(Object.values(MAINTENANCE_DOMAINS).map((d) => d.proof))
const unowned = allProofs.filter((p) => !ownedProofs.has(p)).sort()

const baseline: string[] = existsSync(BASELINE_PATH)
  ? (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as { unowned: string[] }).unowned
  : []
const baselineSet = new Set(baseline)

const brandNewUnowned = unowned.filter((p) => !baselineSet.has(p))
// Proofs that GAINED an owner since the baseline — the burn-down working.
const newlyOwned = baseline.filter((p) => !unowned.includes(p))

console.log("══════════════════════════════════════════════════")
console.log(" Proof ownership — every feature has an accountable manager")
console.log("══════════════════════════════════════════════════")
console.log(`  · ${allProofs.length} proofs on the chain`)
console.log(`  · ${ownedProofs.size} named by a MAINTENANCE_DOMAINS owner`)
console.log(`  · ${unowned.length} unowned (baseline ${baseline.length})`)

if (process.argv.includes("--write-baseline")) {
  writeFileSync(BASELINE_PATH, JSON.stringify({
    note:
      "Shrink-only baseline of test:* proofs with no MAINTENANCE_DOMAINS owner. " +
      "A NEW unowned proof FAILS test:proof-ownership. Remove entries as domains " +
      "are declared; never add. Regenerate deliberately with --write-baseline.",
    unowned,
  }, null, 2) + "\n")
  console.log(`\n  baseline written: ${unowned.length} unowned proofs recorded`)
  process.exit(0)
}

let failed = false

if (newlyOwned.length > 0) {
  console.log(`\n  ✓ ${newlyOwned.length} proof(s) gained an owner since the baseline:`)
  for (const p of newlyOwned) console.log(`      · ${p}`)
  console.log("      (run with --write-baseline to lock the smaller number in)")
}

if (brandNewUnowned.length > 0) {
  failed = true
  console.log(`\n  ✗ ${brandNewUnowned.length} NEW proof(s) with no accountable manager:`)
  for (const p of brandNewUnowned) console.log(`      · ${p}`)
  console.log(
    "\n  Add a MAINTENANCE_DOMAINS entry in lib/kernel/manager-registry.ts naming\n" +
    "  the manager accountable for the feature, its proof, and what it holds.\n" +
    "  A feature nobody owns is a feature nobody fixes.",
  )
}

console.log("\n──────────────────────────────────────────────────")
if (failed) { console.log(" ❌ PROOF_OWNERSHIP_FAIL"); process.exit(1) }
console.log(" ✅ PROOF_OWNERSHIP_PASS — no new feature shipped without an owner")
