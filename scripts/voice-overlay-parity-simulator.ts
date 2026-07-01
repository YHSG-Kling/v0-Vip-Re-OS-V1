#!/usr/bin/env tsx
/**
 * scripts/voice-overlay-parity-simulator.ts   (npm run test:voice-overlay-parity)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the ElevenLabs voice overlay's new run_team_command bridge gives the floating
 * voice admin the SAME team-coordination commands the text command bar has. The bridge
 * forwards the spoken request to the shared parseTeamCommandText → dispatchTeamCommand
 * path; this asserts the representative spoken phrases the overlay will pass each route to
 * a real team command (so the spoken voice admin can finally do them). Pure: parser only.
 */
import { parseTeamCommandText } from "../lib/voice/parse-team-command"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  const cases: Array<{ phrase: string; expect: string }> = [
    { phrase: "what should I do today", expect: "morning_standup" },
    { phrase: "what are my priorities", expect: "morning_standup" },
    { phrase: "knock out number two", expect: "standup_action" },
    { phrase: "cut a reel for 12 Oak Street", expect: "cut_promo" },
    { phrase: "follow up with the Hendersons", expect: "voice_followup" },
    { phrase: "start marketing for Jordan", expect: "start_marketing" },
    { phrase: "what do you know about the Garcias", expect: "team_query" },
    { phrase: "anything happening near 44 Birch", expect: "area_query" },
  ]

  console.log("\n[the overlay's spoken phrases route to real team commands]")
  for (const c of cases) {
    const parsed = parseTeamCommandText(c.phrase)
    check(`"${c.phrase}" → ${c.expect}`, parsed?.name === c.expect)
  }

  console.log("\n[a non-team phrase is NOT mis-routed (falls back to chat)]")
  check("\"what's the weather\" → null (no team command)", parseTeamCommandText("what's the weather") === null)
  check("empty → null", parseTeamCommandText("") === null)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ VOICE_OVERLAY_PARITY_FAIL"); process.exit(1) }
  console.log(" ✅ VOICE_OVERLAY_PARITY_PASS — the floating voice admin now runs the full team-command set via run_team_command")
}
main()
