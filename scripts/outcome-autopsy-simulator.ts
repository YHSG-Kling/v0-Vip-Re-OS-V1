#!/usr/bin/env tsx
/**
 * scripts/outcome-autopsy-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves WIN/LOSS AUTOPSY learning: credit the channel/intent that earned the LAST engagement before
 * a relationship reached thriving (win) or churned dormant (loss) — so the team learns what moves a
 * relationship forward, not just what gets an open. Pure + shell-runnable. No mocks.
 *
 * Run: npx tsx scripts/outcome-autopsy-simulator.ts   (npm run test:outcome-autopsy)
 */
import { outcomeAutopsy, aggregateAutopsyByChannel } from "../lib/intelligence/outcome-autopsy"

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
  console.log(" ✅ Outcome autopsy verified — last-engagement channel credited; win rates per channel.")
  console.log(" OUTCOME_AUTOPSY_PASS")
  process.exit(0)
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Win/loss outcome autopsy simulator")
  console.log("══════════════════════════════════════════════════\n")

  // A win whose last engagement was a video email → credit video.
  const win = outcomeAutopsy([
    { channel: "email", ai_intent: "intro", replied_at: null, at: "2026-05-01T00:00:00Z" },
    { channel: "video", ai_intent: "warm re-intro", replied_at: "2026-05-10T00:00:00Z", at: "2026-05-09T00:00:00Z" },
  ], "win")
  check("last engaged channel credited (video)", win.lastReplyChannel === "video" && win.lastReplyIntent === "warm re-intro")
  check("touch count captured", win.touchCount === 2)

  // No reply anywhere → no channel credited.
  check("no reply → no channel credited", outcomeAutopsy([{ channel: "email", replied_at: null, at: "x" }], "loss").lastReplyChannel === null)

  // Aggregate: video precedes wins, sms precedes losses.
  const stats = aggregateAutopsyByChannel([
    { outcome: "win", lastReplyChannel: "video", lastReplyIntent: null, touchCount: 3 },
    { outcome: "win", lastReplyChannel: "video", lastReplyIntent: null, touchCount: 2 },
    { outcome: "loss", lastReplyChannel: "video", lastReplyIntent: null, touchCount: 4 },
    { outcome: "loss", lastReplyChannel: "sms", lastReplyIntent: null, touchCount: 5 },
  ])
  const video = stats.find((s) => s.channel === "video")
  const sms = stats.find((s) => s.channel === "sms")
  check("video win rate computed (2/3)", video && Math.abs(video.winRate - 2 / 3) < 1e-9)
  check("sms all-loss → 0 win rate", sms?.winRate === 0)
  check("ranked by win rate (video ahead of sms)", stats[0].channel === "video")
  check("empty → empty", aggregateAutopsyByChannel([]).length === 0)

  report()
}

main()
