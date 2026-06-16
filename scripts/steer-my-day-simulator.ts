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
import { assembleSteerMyDay, mergeWorkQueue } from "../lib/intelligence/steer-my-day"

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
  // Leads ride the SAME queue — a lead about to go cold competes with slipping clients on one scale.
  const leads = [
    { leadId: "lead_risk1", score: 28, band: "at_risk" as const, priority: 3, drivers: ["untouched 90d"] },
    { leadId: "lead_warm1", score: 72, band: "warm" as const, priority: 1, drivers: [] }, // excluded (warm)
  ]
  const planned = { total: 6, willSend: 4, blocked: 2, touches: [] as any }

  const day = assembleSteerMyDay({ healthRanked: health, leadRanked: leads, plannedDay: planned, topN: 5 })
  check("only cooling-or-worse surface as work-first (leads + contacts)", day.workFirst.every((w) => w.priority >= 2) && !day.workFirst.some((w) => w.id === "thrive1") && !day.workFirst.some((w) => w.id === "lead_warm1"))
  check("most-at-risk leads the unified work-first list", day.workFirst[0].id === "dormant1" && day.workFirst[0].kind === "contact")
  check("a slipping LEAD is merged onto the queue (whole-funnel view)", day.workFirst.some((w) => w.kind === "lead" && w.id === "lead_risk1"))
  check("within a band, the lead and contact at_risk sort by urgency (lower score first)", (() => { const ar = day.workFirst.filter((w) => w.band === "at_risk"); return ar.length === 2 && ar[0].score <= ar[1].score })())
  check("planned send/blocked counts carried", day.planned.willSend === 4 && day.planned.blocked === 2)
  check("headline names slipping mix + plan + holds", /4 slipping/.test(day.headline) && /3 clients, 1 lead/.test(day.headline) && /4 sends/.test(day.headline) && /2 held/.test(day.headline), day.headline)

  // topN caps the list.
  check("topN caps the unified work-first list", assembleSteerMyDay({ healthRanked: health, leadRanked: leads, plannedDay: planned, topN: 1 }).workFirst.length === 1)

  // All healthy + nothing planned → reassuring headline.
  const calm = assembleSteerMyDay({ healthRanked: [{ contactId: "x", score: 95, band: "thriving", priority: 0, drivers: [] }], plannedDay: { total: 0, willSend: 0, blocked: 0, touches: [] } })
  check("no one slipping → reassuring headline", /on top of it/.test(calm.headline) && calm.workFirst.length === 0)

  // Pure merge helper orders the whole funnel by urgency.
  const merged = mergeWorkQueue(health, leads)
  check("mergeWorkQueue orders leads+contacts by priority desc", merged[0].priority >= merged[merged.length - 1].priority && merged.length === 6)

  report()
}

main()
