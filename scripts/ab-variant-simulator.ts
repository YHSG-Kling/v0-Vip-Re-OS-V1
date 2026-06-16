#!/usr/bin/env tsx
/**
 * scripts/ab-variant-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the executor A/B split — the missing half of the self-improving copy loop. assignAbVariant
 * splits new enrollments 50/50 only when the sequence is_ab_test; pickStepVariant routes execution
 * to the matching step row — and is BEHAVIOUR-PRESERVING for non-A/B sequences (single row → as-is).
 * Pure + shell-runnable. No mocks.
 *
 * Run: npx tsx scripts/ab-variant-simulator.ts   (npm run test:ab-variant)
 */
import { assignAbVariant, pickStepVariant } from "../lib/campaign-sequences/ab-variant"

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
  console.log(" ✅ A/B split verified — assigned only on test sequences; routing behaviour-preserving.")
  console.log(" AB_VARIANT_PASS")
  process.exit(0)
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Executor A/B variant simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[assignAbVariant]")
  check("non-test sequence → no variant (unchanged behaviour)", assignAbVariant({ isAbTest: false }) === null)
  check("test sequence + rand<0.5 → A", assignAbVariant({ isAbTest: true, rand: 0.2 }) === "A")
  check("test sequence + rand>=0.5 → B", assignAbVariant({ isAbTest: true, rand: 0.8 }) === "B")
  check("explicit provided variant wins", assignAbVariant({ isAbTest: true, provided: "B", rand: 0.1 }) === "B")
  check("invalid provided ignored on non-test → null", assignAbVariant({ isAbTest: false, provided: "Z" as any }) === null)

  console.log("\n[pickStepVariant]")
  const single = [{ id: "s1", ab_variant: null }]
  check("single row → returned as-is (non-A/B unchanged)", pickStepVariant(single, "A")?.id === "s1")
  const ab = [{ id: "A1", ab_variant: "A" }, { id: "B1", ab_variant: "B" }]
  check("enrollment A → step A", pickStepVariant(ab, "A")?.id === "A1")
  check("enrollment B → step B", pickStepVariant(ab, "B")?.id === "B1")
  check("no variant on enrollment → control (A)", pickStepVariant(ab, null)?.id === "A1")
  const withControl = [{ id: "ctrl", ab_variant: null }, { id: "B1", ab_variant: "B" }]
  check("variant requested but only control+B → matches B", pickStepVariant(withControl, "B")?.id === "B1")
  check("variant A requested, only control(null)+B → falls back to control", pickStepVariant(withControl, "A")?.id === "ctrl")
  check("no rows → null", pickStepVariant([], "A") === null)

  report()
}

main()
