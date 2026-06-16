#!/usr/bin/env tsx
/**
 * scripts/voice-report-format-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the voice "why" + "steer" report verbs: spokenReceipts turns the decision-receipts trail
 * into a plain answer ("why did X get that?"), spokenSteerDay speaks the health work-list + plan
 * ("who's slipping?"), and both verbs are registered + gated in the voice tool pool. Pure +
 * shell-runnable. No mocks.
 *
 * Run: npx tsx scripts/voice-report-format-simulator.ts   (npm run test:voice-report)
 */
import { spokenReceipts, spokenSteerDay } from "../lib/voice/voice-report-format"
import { getVoiceTool, authorityAllows } from "../lib/voice/tool-registry"

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
  console.log(" ✅ Voice report verbs verified — why/steer spoken naturally; verbs registered + gated.")
  console.log(" VOICE_REPORT_PASS")
  process.exit(0)
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Voice why/steer report formatter simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[spokenReceipts — 'why did they get that?']")
  const r = spokenReceipts("the Hendersons", [
    { at: "2026-06-14T03:00:00Z", channel: "sms", action: "blocked", summary: "sms blocked by compliance: quiet hours (their local time 22:00)" },
    { at: "2026-06-10T10:00:00Z", channel: "email", action: "sent", summary: "ai_isa sent a email — intent: \"a warm re-engagement\"", manager: "ai_isa" },
  ])
  check("names the contact + recounts the trail (incl. a skip reason)", /Hendersons/.test(r) && /quiet hours/.test(r) && /warm re-engagement/.test(r))
  check("no receipts → honest 'nothing went out'", /nothing's gone out/.test(spokenReceipts("Pat", [])))

  console.log("\n[spokenSteerDay — 'who's slipping?']")
  const steer = {
    workFirst: [
      { contactId: "c1", score: 18, band: "dormant" as const, priority: 4, drivers: [] },
      { contactId: "c2", score: 32, band: "at_risk" as const, priority: 3, drivers: [] },
    ],
    planned: { total: 5, willSend: 3, blocked: 2 },
    headline: "2 clients slipping — work them first · your team plans 3 sends today (2 held by the gates)",
  }
  const spoken = spokenSteerDay(steer, { c1: "Pat Rivera", c2: "Dana Cole" })
  check("speaks the headline + names the slipping clients with band/score", /slipping/.test(spoken) && /Pat Rivera \(dormant, 18\)/.test(spoken) && /Dana Cole \(at_risk, 32\)/.test(spoken))
  check("calm day → reassuring, no list", /on top of it/.test(spokenSteerDay({ workFirst: [], planned: { total: 0, willSend: 0, blocked: 0 }, headline: "no clients slipping — you're on top of it" })))

  console.log("\n[voice tool pool registration + gating]")
  const slip = getVoiceTool("whos_slipping")
  const why = getVoiceTool("explain_touches")
  check("whos_slipping registered as a read-only report verb", slip?.category === "report" && slip?.is_outbound === false && slip?.gates.length === 0)
  check("explain_touches registered as a read-only report verb", why?.category === "report" && why?.is_outbound === false)
  check("both allowed for an agent", authorityAllows("whos_slipping", "agent") && authorityAllows("explain_touches", "agent"))

  report()
}

main()
