#!/usr/bin/env tsx
/**
 * scripts/next-move-simulator.ts   (npm run test:next-move)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the lifetime portal's "Your Next Move" radar (nextMoveDeck / intents):
 * equity-aware headline, the invest option surfaces ONLY when equity clears the
 * relevance floor, every option routes to a real manager, intents validate, and
 * each intent yields a concrete next step. Fair-housing-safe by construction —
 * inputs are equity/tenure only (no protected-class signal). Pure: no I/O.
 */
import { nextMoveDeck, nextStepForIntent, isNextMoveIntent, NEXT_MOVE_INTENTS, type NextMoveIntent } from "../lib/portal/next-move"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

const VALID_MANAGERS = ["shopping_agent", "listing_concierge", "finance_manager", "sphere_of_influence"]

function main() {
  console.log("\n[high equity → invest option surfaces, $ headline]")
  const rich = nextMoveDeck({ estimatedEquity: 250000, yearsHeld: 6 })
  check("headline mentions the equity amount", rich.headline.includes("$250,000"))
  check("invest option present (>= floor)", rich.options.some((o) => o.intent === "invest"))
  check("6 options when invest shows", rich.options.length === 6)

  console.log("\n[low equity → no invest option]")
  const lean = nextMoveDeck({ estimatedEquity: 40000, yearsHeld: 2 })
  check("invest NOT present (< floor)", !lean.options.some((o) => o.intent === "invest"))
  check("5 base options", lean.options.length === 5)
  check("headline still mentions equity", lean.headline.includes("$40,000"))

  console.log("\n[no/negative equity → curiosity headline, still has options]")
  const none = nextMoveDeck({ estimatedEquity: 0, yearsHeld: null })
  check("curiosity headline (no $ promise)", none.headline.toLowerCase().includes("curious"))
  check("still offers options", none.options.length === 5)
  check("explore option always present", none.options.some((o) => o.intent === "explore"))
  const neg = nextMoveDeck({ estimatedEquity: -10000, yearsHeld: 1 })
  check("negative equity → no invest", !neg.options.some((o) => o.intent === "invest"))

  console.log("\n[every option routes to a real manager + has copy]")
  check("all routeManager valid", rich.options.every((o) => VALID_MANAGERS.includes(o.routeManager)))
  check("all have title/blurb/cta", rich.options.every((o) => o.title && o.blurb && o.cta))
  check("move_up + right_size route to shopping_agent",
    rich.options.filter((o) => o.intent === "move_up" || o.intent === "right_size").every((o) => o.routeManager === "shopping_agent"))
  check("refinance routes to finance_manager",
    rich.options.find((o) => o.intent === "refinance")?.routeManager === "finance_manager")

  console.log("\n[intent validation + next step]")
  check("isNextMoveIntent accepts known", isNextMoveIntent("move_up") && isNextMoveIntent("explore"))
  check("isNextMoveIntent rejects junk", !isNextMoveIntent("buy_a_yacht") && !isNextMoveIntent(42))
  check("every intent yields a non-empty next step",
    NEXT_MOVE_INTENTS.every((i: NextMoveIntent) => nextStepForIntent(i).length > 0))
  check("move-up next step mentions CMA (both sides)", nextStepForIntent("move_up").toLowerCase().includes("cma"))

  console.log("\n[fair-housing-safe — copy carries no protected-class targeting]")
  // Word-boundary match — "age" must not flag "agent"/"agenda" (substring false positives).
  const banned = ["age", "aged", "senior", "elderly", "family", "families", "children", "kids", "religion", "religious", "race", "ethnic", "ethnicity", "disabled", "disability", "retire", "retired", "retirement"]
  const allCopy = rich.options.map((o) => `${o.title} ${o.blurb} ${o.cta}`).join(" ").toLowerCase() + " " + rich.headline.toLowerCase()
  const hit = banned.find((w) => new RegExp(`\\b${w}\\b`).test(allCopy))
  check(`no protected-class language in option copy${hit ? ` (found: ${hit})` : ""}`, !hit)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ NEXT_MOVE_FAIL"); process.exit(1) }
  console.log(" ✅ NEXT_MOVE_PASS — equity-aware, relevance-filtered, manager-routed, fair-housing-safe")
}
main()
