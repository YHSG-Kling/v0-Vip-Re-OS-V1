#!/usr/bin/env tsx
/**
 * scripts/standup-narrative-simulator.ts   (npm run test:standup-narrative)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the spoken manager-standup script (composeStandupScript): time-based
 * greeting, total actions + reaper "caught" + needs-you counts, managers named
 * worst-first (needs-human/caught before busy), graceful all-quiet case, and that
 * the script is plain spoken text (no markdown/JSON). Pure: no I/O, no TTS.
 */
import { composeStandupScript } from "../lib/intelligence/standup-narrative"
import type { ManagerStandupLine } from "../lib/intelligence/manager-standup"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

const L = (m: ManagerStandupLine["manager"], label: string, activity: number, needs: number, reaped: number, headline: string): ManagerStandupLine =>
  ({ manager: m, label, activity_24h: activity, needs_human: needs, reaped_24h: reaped, headline })

function main() {
  const lines: ManagerStandupLine[] = [
    L("asset_manager", "Asset Manager", 4, 0, 2, "4 video renders completed · AI caught 2 stuck items"),
    L("campaign_orchestrator", "Campaign Orchestrator", 6, 3, 0, "3 client messages proposed — awaiting your approval"),
    L("ai_isa", "AI ISA", 9, 0, 0, "9 qualified handoffs · working 2 hot conversations"),
    L("deal_coordinator", "Deal Coordinator", 2, 0, 1, "2 transaction tasks advanced · AI caught 1 stuck item"),
  ]

  console.log("\n[greeting + totals]")
  const morning = composeStandupScript(lines, { hour: 8 })
  check("morning greeting", morning.startsWith("Good morning."))
  check("afternoon greeting", composeStandupScript(lines, { hour: 14 }).startsWith("Good afternoon."))
  check("evening greeting", composeStandupScript(lines, { hour: 20 }).startsWith("Good evening."))
  check("no-hour → neutral open", composeStandupScript(lines, {}).startsWith("Here's your team standup."))
  check("totals: 21 governed actions", morning.includes("21 governed actions"))
  check("reaper caught total (3 stuck items)", morning.includes("caught 3 stuck items"))
  check("needs-you bottom line (3 items)", /3 items need your decision/.test(morning))

  console.log("\n[brokerage name woven in]")
  check("names the brokerage", composeStandupScript(lines, { hour: 8, brokerageName: "Acme Realty" }).includes("Acme Realty"))

  console.log("\n[worst-first ordering]")
  // Campaign Orchestrator (3 need you) should be named before AI ISA (9 actions, 0 need you).
  const idxCampaign = morning.indexOf("Campaign Orchestrator:")
  const idxIsa = morning.indexOf("AI ISA:")
  check("manager needing attention named before merely-busy one", idxCampaign > -1 && (idxIsa === -1 || idxCampaign < idxIsa))

  console.log("\n[maxNamed caps the named list, summarizes rest]")
  const capped = composeStandupScript(lines, { hour: 8, maxNamed: 2 })
  check("summarizes the remaining managers", /other manager/.test(capped))

  console.log("\n[all-quiet case]")
  const quiet = composeStandupScript([], { hour: 8 })
  check("quiet shift handled", quiet.toLowerCase().includes("quiet shift"))
  check("no 'undefined'/NaN leak", !/undefined|NaN/.test(quiet))

  console.log("\n[no needs-human → reassuring close]")
  const calm = composeStandupScript([L("asset_manager", "Asset Manager", 3, 0, 0, "3 renders done")], { hour: 8 })
  check("reassuring close when nothing blocked", calm.toLowerCase().includes("nothing is blocked on you"))

  console.log("\n[spoken text only — no markdown/json]")
  check("no markdown/braces/asterisks", !/[*_`{}\[\]]/.test(morning))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ STANDUP_NARRATIVE_FAIL"); process.exit(1) }
  console.log(" ✅ STANDUP_NARRATIVE_PASS — spoken standup: greeting, totals, worst-first, graceful")
}
main()
