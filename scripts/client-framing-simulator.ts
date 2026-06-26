#!/usr/bin/env tsx
/**
 * scripts/client-framing-simulator.ts   (npm run test:client-framing)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CLIENT-FRAMING DOCTRINE — proves every client-facing money read is warm + agent-routing,
 * never a stark verdict that scares them off. Pure: no I/O.
 */
import { valueNewsTone, clientSafeCtaLine } from "../lib/kernel/client-framing"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[valueNewsTone — classify FEEL without leaking the number]")
  check("strong positive equity → good", valueNewsTone({ value: 180000 }) === "good")
  check("negative equity (underwater) → sensitive", valueNewsTone({ value: -15000 }) === "sensitive")
  check("zero → neutral", valueNewsTone({ value: 0 }) === "neutral")
  check("null/unknown → neutral", valueNewsTone({ value: null }) === "neutral")
  check("net BELOW a promised reference → sensitive", valueNewsTone({ value: 192000, reference: 212000 }) === "sensitive")
  check("net clearly ABOVE the reference → good", valueNewsTone({ value: 230000, reference: 212000 }) === "good")
  check("within ~2% of reference → neutral (no false alarm)", valueNewsTone({ value: 210000, reference: 212000 }) === "neutral")

  console.log("\n[clientSafeCtaLine — warm, conversation-starting, ALWAYS routes to the agent]")
  for (const tone of ["good", "sensitive", "neutral"] as const) {
    const line = clientSafeCtaLine(tone, "your equity")
    check(`${tone} line routes to the agent`, /agent/i.test(line))
    check(`${tone} line names the topic softly`, /your equity/.test(line))
    check(`${tone} line uses NO scary word`, !/underwater|loss|lost|overpriced|can.?t|denied|bad news|problem|warning/i.test(line))
  }
  check("sensitive is reframed as a conversation, not an alarm", /conversation|connect|talk/i.test(clientSafeCtaLine("sensitive")))
  check("good invites making the most of it", /make the most|capitaliz|most of it/i.test(clientSafeCtaLine("good")))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CLIENT_FRAMING_FAIL"); process.exit(1) }
  console.log(" ✅ CLIENT_FRAMING_PASS — client surfaces are warm + agent-routing; stark reads stay with the agent")
}

main()
