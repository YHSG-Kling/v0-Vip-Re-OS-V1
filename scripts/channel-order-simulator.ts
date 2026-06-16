#!/usr/bin/env tsx
/**
 * scripts/channel-order-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves CHANNEL-ORDER learning: rank channels by real reply rate and recommend the lead channel —
 * sample-gated so a cadence never reorders on noise. Advisory. Pure + shell-runnable. No mocks.
 *
 * Run: npx tsx scripts/channel-order-simulator.ts   (npm run test:channel-order)
 */
import { rankChannelsByReplyRate, DEFAULT_MIN_SAMPLE } from "../lib/campaign-sequences/channel-order"

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
  console.log(" ✅ Channel-order learning verified — best-reply channel recommended; low-sample/noise held.")
  console.log(" CHANNEL_ORDER_PASS")
  process.exit(0)
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Channel-order learning simulator")
  console.log("══════════════════════════════════════════════════\n")

  // SMS clearly out-replies email → lead with SMS.
  const r = rankChannelsByReplyRate([{ channel: "email", sent: 200, replies: 8 }, { channel: "sms", sent: 200, replies: 30 }])
  check("higher-reply channel recommended (sms)", r.recommended === "sms" && r.ranked[0].channel === "sms")
  check("ranking is best-rate first", r.ranked[0].rate > r.ranked[1].rate)

  // Under-sampled channel excluded.
  check(`< ${DEFAULT_MIN_SAMPLE} sends excluded`, rankChannelsByReplyRate([{ channel: "sms", sent: 10, replies: 5 }]).recommended === null)

  // No replies anywhere → keep default order.
  check("zero replies → no recommendation", rankChannelsByReplyRate([{ channel: "email", sent: 100, replies: 0 }]).recommended === null)

  // Empty → keep default.
  check("empty → no recommendation", rankChannelsByReplyRate([]).recommended === null)

  // Single eligible channel with replies → recommended.
  check("single eligible channel with replies → recommended", rankChannelsByReplyRate([{ channel: "video", sent: 50, replies: 6 }]).recommended === "video")

  report()
}

main()
