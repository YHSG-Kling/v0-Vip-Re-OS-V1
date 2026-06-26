#!/usr/bin/env tsx
/**
 * scripts/urgent-sla-simulator.ts   (npm run test:urgent-sla)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE URGENT-NUDGE SLA — owner's rule: urgent, time-critical items get acted on within 6 HOURS,
 * never left a day. Pure: the breach boundary + the hours math. No I/O.
 */
import { URGENT_NUDGE_MAX_HOURS, hoursSince, urgentSlaBreached } from "../lib/kernel/urgent-sla"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

const NOW = new Date("2026-06-26T18:00:00Z")
const agoHours = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()

function main() {
  console.log("\n[The 6-hour ceiling]")
  check("the urgent ceiling is 6 hours (owner's rule)", URGENT_NUDGE_MAX_HOURS === 6)
  check("5h old → NOT breached (still within SLA)", urgentSlaBreached(agoHours(5), NOW) === false)
  check("exactly 6h → NOT breached (boundary inclusive)", urgentSlaBreached(agoHours(6), NOW) === false)
  check("6.5h old → BREACHED (act now)", urgentSlaBreached(agoHours(6.5), NOW) === true)
  check("a full day old → BREACHED", urgentSlaBreached(agoHours(24), NOW) === true)

  console.log("\n[Honest edges]")
  check("null timestamp → not breached (nothing to act on)", urgentSlaBreached(null, NOW) === false)
  check("invalid timestamp → not breached", urgentSlaBreached("not-a-date", NOW) === false)
  check("future timestamp → 0 hours, not breached", urgentSlaBreached(new Date(NOW.getTime() + 3_600_000).toISOString(), NOW) === false)
  check("hoursSince computes whole/fractional hours", Math.abs(hoursSince(agoHours(3.5), NOW) - 3.5) < 0.01)

  console.log("\n[Tighter override]")
  check("a 2h override breaches a 3h-old item", urgentSlaBreached(agoHours(3), NOW, 2) === true)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ URGENT_SLA_FAIL"); process.exit(1) }
  console.log(" ✅ URGENT_SLA_PASS — urgent nudges escalate within 6 hours, never a day")
}

main()
