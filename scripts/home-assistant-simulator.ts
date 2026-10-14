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
import { readFileSync } from "node:fs"
import { stripComments } from "./strip-comments"
import {
  validateHomeQuestion,
  buildHomeFactsBlock,
  buildHomeAssistantSystemPrompt,
  fallbackHomeAnswer,
  classifyHomeFollowUp,
  vendorCategoryFor,
  followUpAcknowledgement,
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

  // Lane 90C — the follow-up the question earns (the loop no longer ends at the answer).
  console.log("\n[follow-up classifier — home value / refinance / vendor, conservative]")
  check("'what is my home worth now?' → home_value", classifyHomeFollowUp("What is my home worth now?") === "home_value")
  check("'how much equity do we have?' → home_value", classifyHomeFollowUp("How much equity do we have?") === "home_value")
  check("'should I refinance with rates dropping?' → refinance", classifyHomeFollowUp("Should I refinance with rates dropping?") === "refinance")
  check("'is a HELOC a good idea to tap equity' → refinance (refi wins over the equity word)", classifyHomeFollowUp("Is a HELOC a good idea to tap equity?") === "refinance")
  check("'do you know a good plumber?' → vendor", classifyHomeFollowUp("Do you know a good plumber?") === "vendor")
  check("'who would you recommend for a roof repair' → vendor", classifyHomeFollowUp("Who would you recommend for a roof repair?") === "vendor")
  check("'when is my property tax due?' → null (no phantom task — the agent redirect is the floor)", classifyHomeFollowUp("When is my property tax due?") === null)
  check("'thanks!' / empty → null", classifyHomeFollowUp("thanks!") === null && classifyHomeFollowUp("") === null && classifyHomeFollowUp(null) === null)
  check("vendor category: the brokerage's OWN category wins when it names the trade", vendorCategoryFor("know a good plumber?", ["roofing", "plumbing_and_drains"]) === "plumbing_and_drains")
  check("vendor category: generic word list when the bench has no match", vendorCategoryFor("need someone to fix my gutters", ["plumbing"]) === "gutters")
  check("vendor category: a vague ask → home_services (never an invented trade)", vendorCategoryFor("know anyone good?", []) === "home_services")
  check("acknowledgement names the agent and never quotes a number or a promise of value",
    followUpAcknowledgement("home_value", "Sam Rivera").includes("Sam Rivera") && !/\$|\bwill (rise|grow|go up)\b/.test(followUpAcknowledgement("home_value", "Sam Rivera"))
    && followUpAcknowledgement("refinance", null).includes("your agent") && followUpAcknowledgement("vendor", null).toLowerCase().includes("bench"))

  console.log("\n[askHomeAssistant files the follow-up through the EXISTING asks — stripped source]")
  const actionSrc = stripComments(readFileSync("app/actions/portal-lifetime.ts", "utf8"))
  const askIdx = actionSrc.indexOf("export async function askHomeAssistant")
  const askBody = actionSrc.slice(askIdx)
  check("askHomeAssistant exists and classifies the question (classifyHomeFollowUp) — code, not a comment", askIdx >= 0 && askBody.includes("classifyHomeFollowUp("))
  check("the three survivors are called (requestValueUpdate / submitNextMoveIntent 'refinance' / requestVendorIntro) — never a fourth writer",
    actionSrc.includes("await requestValueUpdate(") && /submitNextMoveIntent\(\{[^}]*intent:\s*"refinance"/.test(actionSrc) && actionSrc.includes("await requestVendorIntro("))
  check("dedupe: a recent client_to_agent portal message with the same marker suppresses a second filing (7-day window)",
    actionSrc.includes("HOME_FOLLOW_UP_DEDUPE_DAYS = 7") && /\.from\("client_portal_messages"\)[\s\S]{0,400}\.eq\("direction", "client_to_agent"\)[\s\S]{0,300}\.ilike\("body"/.test(actionSrc))
  check("the dedupe read's error is READ and fails closed (nothing filed on a refused read)", /recentErr\) return \{ filed: false/.test(actionSrc))
  check("no in-house agent → nothing filed, nothing acknowledged (the survivors would no-op 'successfully')",
    /if \(!ctx\.contact\?\.agent_id\) return \{ ok: true, answer, followUp/.test(askBody))
  check("the acknowledgement rides ONLY a landed (or already-landed) row — followUpAcknowledgement is gated on filed || deduped",
    /acknowledged = filed\.filed \|\| filed\.deduped/.test(askBody) && /acknowledged \? `\$\{answer\} \$\{followUpAcknowledgement\(kind/.test(askBody))
  check("POSITIVE CONTROL: the survivor scan DOES flag a fixture that files through a bare insert instead",
    !/await requestVendorIntro\(/.test('await svc.from("client_portal_messages").insert({ body: "Vendor intro request" })'))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ HOME_ASSISTANT_FAIL"); process.exit(1) }
  console.log(" ✅ HOME_ASSISTANT_PASS — validated, scoped, railed, deterministic floor")
}
main()
