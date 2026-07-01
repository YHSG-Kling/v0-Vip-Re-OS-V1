#!/usr/bin/env tsx
/**
 * scripts/stuck-campaign-reaper-simulator.ts   (npm run test:stuck-campaign-reaper)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the stuck-campaign reaper's pure policy — the Campaign Orchestrator's PRIMARY table
 * (marketing_campaigns) finally has a nothing-falls-through watcher. classifyStuckCampaign flags:
 *   • overdue_scheduled — scheduled, start date passed >1d, never launched
 *   • live_no_traction  — live >30d with ZERO impressions (distributed nothing)
 *   • stale_draft       — draft >30d (abandoned)
 * and keeps everything healthy (active, terminal, recent, in-window). Escalate-only — never
 * auto-fails a human-owned campaign. Pure: no I/O.
 */
import { classifyStuckCampaign, stuckCampaignMessage } from "../lib/marketing/stuck-campaign-policy"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

const now = new Date("2026-07-01T00:00:00Z")
const daysAgo = (d: number) => new Date(now.getTime() - d * 86400_000).toISOString()
const daysAhead = (d: number) => new Date(now.getTime() + d * 86400_000).toISOString()
const base = { status: null as string | null, scheduledStartAt: null as string | null, launchedAt: null as string | null, impressions: 0 as number | null, createdAt: daysAgo(1), now }

function main() {
  console.log("\n[overdue_scheduled — scheduled but never launched]")
  check("scheduled + start 2d ago → overdue_scheduled", classifyStuckCampaign({ ...base, status: "scheduled", scheduledStartAt: daysAgo(2) }) === "overdue_scheduled")
  check("scheduled + start in the FUTURE → keep", classifyStuckCampaign({ ...base, status: "scheduled", scheduledStartAt: daysAhead(1) }) === "keep")
  check("scheduled + start 12h ago (within 1d grace) → keep", classifyStuckCampaign({ ...base, status: "scheduled", scheduledStartAt: new Date(now.getTime() - 12 * 3600_000).toISOString() }) === "keep")
  check("scheduled + no start date → keep (nothing to compare)", classifyStuckCampaign({ ...base, status: "scheduled", scheduledStartAt: null }) === "keep")

  console.log("\n[live_no_traction — live but distributed nothing]")
  check("live 40d + 0 impressions → live_no_traction", classifyStuckCampaign({ ...base, status: "live", launchedAt: daysAgo(40), impressions: 0 }) === "live_no_traction")
  check("live 40d + 5 impressions → keep (it's working)", classifyStuckCampaign({ ...base, status: "live", launchedAt: daysAgo(40), impressions: 5 }) === "keep")
  check("live 10d + 0 impressions → keep (still within window)", classifyStuckCampaign({ ...base, status: "live", launchedAt: daysAgo(10), impressions: 0 }) === "keep")
  check("live + null impressions treated as 0 → live_no_traction at 40d", classifyStuckCampaign({ ...base, status: "live", launchedAt: daysAgo(40), impressions: null }) === "live_no_traction")

  console.log("\n[stale_draft — abandoned draft]")
  check("draft 40d old → stale_draft", classifyStuckCampaign({ ...base, status: "draft", createdAt: daysAgo(40) }) === "stale_draft")
  check("draft 5d old → keep (recent WIP)", classifyStuckCampaign({ ...base, status: "draft", createdAt: daysAgo(5) }) === "keep")

  console.log("\n[healthy + terminal states keep]")
  for (const s of ["approved", "paused", "ended", "archived", "failed", "completed"]) {
    check(`status '${s}' → keep`, classifyStuckCampaign({ ...base, status: s, launchedAt: daysAgo(90), scheduledStartAt: daysAgo(90), createdAt: daysAgo(90) }) === "keep")
  }

  console.log("\n[escalation copy exists for every stuck verdict]")
  for (const v of ["overdue_scheduled", "live_no_traction", "stale_draft"] as const) {
    const m = stuckCampaignMessage(v)
    check(`${v} → title + body`, !!m.title && !!m.body && m.body.length > 20)
  }

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ STUCK_CAMPAIGN_REAPER_FAIL"); process.exit(1) }
  console.log(" ✅ STUCK_CAMPAIGN_REAPER_PASS — the Campaign Orchestrator's primary table is finally reaper-covered")
}
main()
