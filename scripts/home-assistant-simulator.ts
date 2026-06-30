#!/usr/bin/env tsx
/**
 * scripts/home-assistant-simulator.ts   (npm run test:home-assistant)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the lifetime portal's "ask your home anything" guardrails (pure layer):
 * question validation, the facts block only carries provided facts, the system
 * prompt encodes every hard rail (no legal/tax/lending/appraisal advice, no value
 * guarantee/forecast, fair-housing, scope + agent redirect), and the deterministic
 * fallback answer (the floor) summarizes facts + routes to the agent with no
 * forecast. Pure: no I/O, no LLM call.
 */
import {
  validateHomeQuestion,
  buildHomeFactsBlock,
  buildHomeAssistantSystemPrompt,
  fallbackHomeAnswer,
  type HomeFacts,
} from "../lib/portal/home-assistant"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

const FACTS: HomeFacts = {
  firstName: "Dana",
  agentName: "Sam Rivera",
  propertyAddress: "123 Oak St, Austin, TX",
  purchasePrice: 400000,
  closeDate: "2020-06-01",
  currentValue: 520000,
  estimatedEquity: 120000,
  gainPercent: 30,
  marketTrend: "appreciating",
  neighborhoodActivityCount: 4,
  vendorCategories: ["plumbing", "roofing"],
}

function main() {
  console.log("\n[question validation]")
  check("empty rejected", !validateHomeQuestion("").ok)
  check("too short rejected", !validateHomeQuestion("hi").ok)
  check("normal accepted + trimmed", validateHomeQuestion("  How much equity?  ").clean === "How much equity?")
  check("overlong clamped to 500", (validateHomeQuestion("x".repeat(900)).clean ?? "").length === 500)

  console.log("\n[facts block carries only provided facts]")
  const block = buildHomeFactsBlock(FACTS)
  check("includes address", block.includes("123 Oak St"))
  check("includes purchase price formatted", block.includes("$400,000"))
  check("labels value as estimate not appraisal", block.toLowerCase().includes("not an appraisal"))
  const sparse = buildHomeFactsBlock({ firstName: "Lee" })
  check("sparse block omits missing facts", !sparse.includes("$") && sparse.includes("Lee"))
  check("empty facts → graceful line", buildHomeFactsBlock({}).toLowerCase().includes("no specific home facts"))

  console.log("\n[system prompt encodes every hard rail]")
  const sys = buildHomeAssistantSystemPrompt(FACTS).toLowerCase()
  check("no legal/tax/lending/appraisal advice", sys.includes("not a lawyer") && sys.includes("appraiser"))
  check("no future-value guarantee/forecast", sys.includes("never guarantee or predict"))
  check("fair-housing / no steering", sys.includes("protected class") && sys.includes("steer"))
  check("scope + redirect to agent", sys.includes("redirect") && sys.includes("sam rivera"))
  check("use only provided facts", sys.includes("use only the facts"))

  console.log("\n[deterministic fallback floor]")
  const fb = fallbackHomeAnswer(FACTS)
  check("summarizes the home", fb.includes("123 Oak St"))
  check("mentions current value as estimate", fb.toLowerCase().includes("estimate"))
  check("routes to the agent by name", fb.includes("Sam Rivera"))
  check("no forecast words", !/\b(will|guarantee|forecast|predict|expect)\b/i.test(fb))
  const fbBare = fallbackHomeAnswer({})
  check("bare fallback still routes to 'your agent'", fbBare.includes("your agent"))
  check("bare fallback admits no details", fbBare.toLowerCase().includes("don't have"))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ HOME_ASSISTANT_FAIL"); process.exit(1) }
  console.log(" ✅ HOME_ASSISTANT_PASS — validated, scoped, railed, deterministic floor")
}
main()
