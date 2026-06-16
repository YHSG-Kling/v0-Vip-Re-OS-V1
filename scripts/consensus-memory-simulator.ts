#!/usr/bin/env tsx
/**
 * scripts/consensus-memory-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves CONSENSUS MEMORY: as a manager's second opinions are proven right/wrong by outcomes, the
 * huddle learns whose read to trust on which play — reliable managers weighted heavily, shaky ones
 * salted, new voices given a fair hearing. Sample-gated so luck doesn't crown anyone. Pure +
 * shell-runnable. No mocks.
 *
 * Run: npx tsx scripts/consensus-memory-simulator.ts   (npm run test:consensus-memory)
 */
import { consultAccuracy, consultConfidence, consultWeight, DEFAULT_MIN_SAMPLE } from "../lib/kernel/consensus-memory"

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
  console.log(" ✅ Consensus memory verified — track record builds trust; luck doesn't crown.")
  console.log(" CONSENSUS_MEMORY_PASS")
  process.exit(0)
}

const recs = (correct: number, wrong: number) => [
  ...Array.from({ length: correct }, () => ({ correct: true })),
  ...Array.from({ length: wrong }, () => ({ correct: false })),
]

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Consensus memory simulator")
  console.log("══════════════════════════════════════════════════\n")

  check("accuracy computed (8/10)", consultAccuracy(recs(8, 2)).accuracy === 0.8)
  check("empty track → 0 accuracy, no NaN", consultAccuracy([]).accuracy === 0)

  // Strong, well-sampled record → reliable → full weight.
  const strong = consultConfidence(consultAccuracy(recs(8, 2)))
  check("8/10 → reliable", strong === "reliable" && consultWeight(strong) === 1.0)

  // Weak record → unreliable → salted.
  const weak = consultConfidence(consultAccuracy(recs(2, 8)))
  check("2/10 → unreliable → low weight", weak === "unreliable" && consultWeight(weak) < 0.3)

  // Middle → mixed.
  check("5/10 → mixed", consultConfidence(consultAccuracy(recs(5, 5))) === "mixed")

  // Too few calls → unproven (luck can't crown), but still given a fair hearing.
  const newVoice = consultConfidence(consultAccuracy(recs(2, 0)))
  check(`< ${DEFAULT_MIN_SAMPLE} calls → unproven (not 'reliable' on luck)`, newVoice === "unproven")
  check("unproven still gets a fair hearing (weight 0.5)", consultWeight("unproven") === 0.5)

  // Reliable beats unreliable in weight ordering.
  check("weight ordering reliable > mixed > unproven > unreliable", consultWeight("reliable") > consultWeight("mixed") && consultWeight("mixed") > consultWeight("unproven") && consultWeight("unproven") > consultWeight("unreliable"))

  report()
}

main()
