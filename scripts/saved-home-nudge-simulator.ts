#!/usr/bin/env tsx
/**
 * scripts/saved-home-nudge-simulator.ts   (npm run test:saved-home-nudge)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SAVED-HOME WATCH — proves every change type maps to the right PERSONAL nudge the AI ISA
 * sends, with the highest-emotion moments flagged avatar-worthy. Pure: no I/O, them-first.
 */
import { classifySavedHomeNudge, SAVED_HOME_NUDGE_KINDS } from "../lib/ai-isa/saved-home-nudge"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[Every change type classifies to a personal nudge]")
  for (const k of SAVED_HOME_NUDGE_KINDS) {
    const n = classifySavedHomeNudge(k)
    check(`${k} → a nudge with headline + angle`, !!n && n.kind === k && n.headline.length > 0 && n.angle.length > 0)
  }
  check("six nudge kinds incl. coming_soon", SAVED_HOME_NUDGE_KINDS.length === 6 && SAVED_HOME_NUDGE_KINDS.includes("coming_soon"))

  console.log("\n[Avatar-worthy = the highest-emotion moments → Asset Manager makes the video]")
  check("price_drop → avatar-worthy", classifySavedHomeNudge("price_drop")!.avatarWorthy === true)
  check("back_on_market → avatar-worthy", classifySavedHomeNudge("back_on_market")!.avatarWorthy === true)
  check("coming_soon (exclusive first look) → avatar-worthy", classifySavedHomeNudge("coming_soon")!.avatarWorthy === true)
  check("under_contract → NOT avatar (keep it light, text)", classifySavedHomeNudge("under_contract")!.avatarWorthy === false)
  check("new_match → not avatar", classifySavedHomeNudge("new_match")!.avatarWorthy === false)
  check("open_house → not avatar", classifySavedHomeNudge("open_house")!.avatarWorthy === false)

  console.log("\n[Urgency + framing]")
  check("price_drop is high urgency", classifySavedHomeNudge("price_drop")!.urgency === "high")
  check("new_match is medium urgency (stay engaged, not pressure)", classifySavedHomeNudge("new_match")!.urgency === "medium")
  check("angles drive to the portal", SAVED_HOME_NUDGE_KINDS.every((k) => /portal/i.test(classifySavedHomeNudge(k)!.angle)))
  check("price_drop angle forbids quoting the exact price (agent's conversation)", /do NOT quote/i.test(classifySavedHomeNudge("price_drop")!.angle))

  console.log("\n[Honest]")
  check("unknown kind → null (never a fabricated reason to reach out)", classifySavedHomeNudge("random") === null)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ SAVED_HOME_NUDGE_FAIL"); process.exit(1) }
  console.log(" ✅ SAVED_HOME_NUDGE_PASS — saved-home changes become personal ISA nudges, avatar on the big moments")
}

main()
