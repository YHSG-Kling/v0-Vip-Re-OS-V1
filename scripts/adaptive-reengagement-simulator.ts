#!/usr/bin/env tsx
/**
 * scripts/adaptive-reengagement-simulator.ts   (npm run test:adaptive-reengagement)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the AI-ISA re-engages non-responders THEM-FIRST — a fresh angle per attempt,
 * toned to the lead's generational cohort — and that it can NEVER violate Fair Housing.
 *
 * Layer 1 (pure):
 *   - the angle rotates by attempt (life-context → market → expertise → soft-close).
 *   - the cohort resolves from enrichment age / age_range (else 'unknown').
 *   - every (cohort × angle) hook is non-empty and the angle genuinely varies the copy.
 *   - FAIR HOUSING: no hook references a protected class (race/religion/sex/national
 *     origin/disability/familial status) NOR age itself — it's STYLE, not targeting.
 */
import {
  reengagementAngleForAttempt,
  cohortFromEnrichment,
  buildAdaptiveReengagementHook,
  adaptiveReengagementHook,
  type ReengagementAngle,
} from "../lib/ai-isa/adaptive-reengagement"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

const COHORTS = ["gen_z", "millennial", "gen_x", "boomer", "silent", "unknown"] as const
const ANGLES: ReengagementAngle[] = ["life_context", "market_timing", "expertise", "soft_close"]

function main(): void {
  console.log("\n[angle rotates by attempt — never the same message repeated]")
  check("attempts 1-2 → life_context", reengagementAngleForAttempt(1) === "life_context" && reengagementAngleForAttempt(2) === "life_context")
  check("attempts 3-4 → market_timing", reengagementAngleForAttempt(3) === "market_timing" && reengagementAngleForAttempt(4) === "market_timing")
  check("attempts 5-6 → expertise", reengagementAngleForAttempt(5) === "expertise" && reengagementAngleForAttempt(6) === "expertise")
  check("attempts 7+ → soft_close", reengagementAngleForAttempt(7) === "soft_close" && reengagementAngleForAttempt(20) === "soft_close")
  const a1 = buildAdaptiveReengagementHook("millennial", reengagementAngleForAttempt(1))
  const a3 = buildAdaptiveReengagementHook("millennial", reengagementAngleForAttempt(3))
  const a5 = buildAdaptiveReengagementHook("millennial", reengagementAngleForAttempt(5))
  const a7 = buildAdaptiveReengagementHook("millennial", reengagementAngleForAttempt(7))
  check("a non-responder gets 4 DISTINCT angles across the cadence", new Set([a1, a3, a5, a7]).size === 4)

  console.log("\n[cohort resolves from enrichment age]")
  check("age 24 → gen_z", cohortFromEnrichment({ age: 24 }) === "gen_z")
  check("age 38 → millennial", cohortFromEnrichment({ age: 38 }) === "millennial")
  check("age 55 → gen_x", cohortFromEnrichment({ age: 55 }) === "gen_x")
  check("age 70 → boomer", cohortFromEnrichment({ age: 70 }) === "boomer")
  check("age_range '35-44' → millennial (midpoint)", cohortFromEnrichment({ age_range: "35-44" }) === "millennial")
  check("no age signal → unknown (neutral tone)", cohortFromEnrichment({}) === "unknown" && cohortFromEnrichment(null) === "unknown")

  console.log("\n[every cohort × angle hook is real + cohort-distinct]")
  for (const angle of ANGLES) {
    const hooks = COHORTS.map((c) => buildAdaptiveReengagementHook(c, angle))
    check(`angle '${angle}': all cohorts produce a non-empty hook`, hooks.every((h) => h.trim().length > 10))
  }
  check("tone differs by cohort (gen_z terse vs boomer warm) for the same angle",
    buildAdaptiveReengagementHook("gen_z", "life_context") !== buildAdaptiveReengagementHook("boomer", "life_context"))

  console.log("\n[FAIR HOUSING — no protected-class / age language in ANY hook]")
  // Protected classes (federal FHA) + age/familial proxies that must never appear.
  const BANNED = [
    "race", "color", "religion", "christian", "jewish", "muslim", "church",
    "sex", "gender", "male", "female", "national origin", "ethnic",
    "disab", "handicap", "wheelchair",
    "familial", "children", "kids", "family", "married", "single mom", "couple",
    "age", "aged", "old", "young", "elderly", "senior", "retire", "boomer", "millennial", "gen z", "gen x",
  ]
  let allClean = true
  for (const c of COHORTS) {
    for (const a of ANGLES) {
      const hook = buildAdaptiveReengagementHook(c, a).toLowerCase()
      const hit = BANNED.find((w) => hook.includes(w))
      if (hit) { allClean = false; fails.push(`hook(${c},${a}) contains banned term "${hit}": ${hook}`) }
    }
  }
  check("no hook references a protected class or age (style, not targeting)", allClean)

  console.log("\n[convenience resolver]")
  const r = adaptiveReengagementHook({ attempt: 5, enrichment: { age: 70 } })
  check("adaptiveReengagementHook resolves cohort + angle + hook", r.cohort === "boomer" && r.angle === "expertise" && r.hook.length > 10)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ ADAPTIVE_REENGAGEMENT_FAIL"); process.exit(1) }
  console.log(" ✅ ADAPTIVE_REENGAGEMENT_PASS — fresh angle per attempt, cohort-toned, Fair-Housing safe")
}

main()
