#!/usr/bin/env tsx
/**
 * scripts/steer-my-day-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the agent STEER-MY-DAY digest — fuses the health-ranked work list (who's slipping, work
 * first) with the dry-run cockpit (what the team plans + what's held). Agent-scoped. Pure +
 * shell-runnable. No mocks.
 *
 * Run: npx tsx scripts/steer-my-day-simulator.ts   (npm run test:steer-my-day)
 */
import { assembleSteerMyDay } from "../lib/intelligence/steer-my-day"

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
  console.log(" ✅ Steer-my-day verified — slipping clients surfaced, plan + holds summarized.")
  console.log(" STEER_MY_DAY_PASS")
  process.exit(0)
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Agent steer-my-day simulator")
  console.log("══════════════════════════════════════════════════\n")

  const health = [
    { contactId: "dormant1", score: 10, band: "dormant" as const, priority: 4, drivers: ["never reached back"] },
    { contactId: "risk1", score: 30, band: "at_risk" as const, priority: 3, drivers: [] },
    { contactId: "cool1", score: 50, band: "cooling" as const, priority: 2, drivers: [] },
    { contactId: "thrive1", score: 90, band: "thriving" as const, priority: 0, drivers: [] }, // excluded
  ]
  const planned = { total: 6, willSend: 4, blocked: 2, touches: [] as any }

  const day = assembleSteerMyDay({ healthRanked: health, plannedDay: planned, topN: 5 })
  check("only cooling-or-worse surface as work-first", day.workFirst.every((w) => w.priority >= 2) && !day.workFirst.some((w) => w.contactId === "thrive1"))
  check("most-at-risk leads the work-first list", day.workFirst[0].contactId === "dormant1")
  check("planned send/blocked counts carried", day.planned.willSend === 4 && day.planned.blocked === 2)
  check("headline names slipping count + plan + holds", /3 clients slipping/.test(day.headline) && /4 sends/.test(day.headline) && /2 held/.test(day.headline), day.headline)

  // topN caps the list.
  check("topN caps the work-first list", assembleSteerMyDay({ healthRanked: health, plannedDay: planned, topN: 1 }).workFirst.length === 1)

  // All healthy + nothing planned → reassuring headline.
  const calm = assembleSteerMyDay({ healthRanked: [{ contactId: "x", score: 95, band: "thriving", priority: 0, drivers: [] }], plannedDay: { total: 0, willSend: 0, blocked: 0, touches: [] } })
  check("no one slipping → reassuring headline", /on top of it/.test(calm.headline) && calm.workFirst.length === 0)

  report()
}

main()
