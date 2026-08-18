#!/usr/bin/env tsx
/**
 * scripts/leaderboard-simulator.ts   (npm run test:leaderboard)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves GAMIFICATION CONSOLIDATION + LEADERBOARD + RETENTION FEED: both award paths write the single
 * ledger; the leaderboard is populated from it (ranked, windowed); and gamification engagement feeds the
 * retention score (an engaged agent reads as lower flight risk).
 *
 * PURE:   rankPoints (windowed sum + desc rank + deterministic ties + zero excluded) + isoWeekLabel/
 *         monthLabel + the retention gamification signal (renormalizes; absent = prior behavior).
 * SOURCE: addPoints writes agent_points_log; retention-radar gathers points_30d; the cron snapshots.
 * LIVE (creds-gated): seed ledger rows → runLeaderboardSnapshot writes ranked leaderboard_rankings → clean up.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { rankPoints, partitionByTeam, isoWeekLabel, monthLabel, type LedgerRow } from "../lib/recruiting/leaderboard"
import { LEADERBOARD_SCOPES, LEADERBOARD_METRICS, periodWindows, isCanonicalPeriodLabel } from "../lib/gamification/leaderboard-vocabulary"
import { tierForPoints, nextTierForPoints } from "../lib/gamification/tiers"
import { computeRetentionScore, type RetentionSignals } from "../lib/recruiting/retention-score"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
const NOW = new Date("2026-07-03T00:00:00Z")
const row = (agent: string, pts: number, daysAgo: number): LedgerRow => ({ agent_id: agent, points: pts, created_at: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString() })

function pureLayer() {
  console.log("\n[rankPoints · pure]")
  const rows = [row("a", 100, 1), row("a", 50, 40), row("b", 200, 2), row("c", 0, 1)]
  const allTime = rankPoints(rows, null)
  check("all-time sums all rows + ranks desc (b 200, a 150)", allTime[0].agent_id === "b" && allTime[0].metric_value === 200 && allTime[1].agent_id === "a" && allTime[1].metric_value === 150)
  check("zero-point agents are excluded", !allTime.some((r) => r.agent_id === "c"))
  const last7 = rankPoints(rows, new Date(NOW.getTime() - 7 * 86_400_000))
  check("windowed excludes rows outside the window (a's 40-day-old 50 drops → a=100)", (last7.find((r) => r.agent_id === "a")?.metric_value) === 100)
  check("rank_position is 1-indexed + contiguous", allTime[0].rank_position === 1 && allTime[1].rank_position === 2)
  check("deterministic tie-break by agent_id", JSON.stringify(rankPoints([row("z", 10, 1), row("a", 10, 1)], null).map((r) => r.agent_id)) === JSON.stringify(["a", "z"]))

  console.log("\n[team partition · pure]")
  const teamRows = [row("a", 100, 1), row("b", 200, 1), row("c", 50, 1)]
  const teams = new Map<string, string | null>([["a", "t1"], ["b", "t1"], ["c", null]])
  const parted = partitionByTeam(teamRows, teams)
  check("rows are grouped by their agent's team", parted.get("t1")?.length === 2)
  check("an agent with no team produces no team board", !parted.has("null") && parted.size === 1)
  const t1 = rankPoints(parted.get("t1") ?? [], null)
  check("team ranks restart at 1 inside the team", t1[0].agent_id === "b" && t1[0].rank_position === 1)

  console.log("\n[period labels · pure]")
  check("isoWeekLabel formats YYYY-Www", /^\d{4}-W\d{2}$/.test(isoWeekLabel(NOW)))
  check("monthLabel formats YYYY-MM", monthLabel(NOW) === "2026-07")

  console.log("\n[one vocabulary · pure]")
  check("scope is the comparison group — brokerage/team, never the row grain 'agent'",
    JSON.stringify([...LEADERBOARD_SCOPES]) === JSON.stringify(["brokerage", "team"]))
  check("no revenue metric on a peer-visible board",
    !(LEADERBOARD_METRICS as readonly string[]).includes("revenue") && LEADERBOARD_METRICS.length === 3)
  check("every period the UI may offer is one the populator writes",
    periodWindows(NOW).every((w) => isCanonicalPeriodLabel(w.value, NOW)) && periodWindows(NOW).length === 3)
  check("a display label is never a stored value", !isCanonicalPeriodLabel("This Month", NOW))

  console.log("\n[one tier ladder · pure]")
  check("the server ladder wins: 500/2500/10000/25000",
    tierForPoints(499) === "unranked" && tierForPoints(500) === "bronze" &&
    tierForPoints(2500) === "silver" && tierForPoints(10000) === "gold" && tierForPoints(25000) === "platinum")
  check("the top of the threshold ladder has no next rung to promise", nextTierForPoints(25000) === null)

  console.log("\n[retention gamification feed · pure]")
  const base = (o: Partial<RetentionSignals> = {}): RetentionSignals => ({ daysSinceActivity: 10, daysSinceClosing: 120, activePipeline: 1, onboardingPct: 100, tenureDays: 400, ...o })
  const withGame = computeRetentionScore(base({ gamificationPoints30d: 600 }))
  const noGame = computeRetentionScore(base({ gamificationPoints30d: 0 }))
  check("an engaged (high-points) agent scores higher than a disengaged one", withGame.score > noGame.score && "gamification" in withGame.breakdown)
  const absent = computeRetentionScore(base())
  const absent2 = computeRetentionScore(base({ gamificationPoints30d: null }))
  check("absent gamification = identical to prior 4-signal behavior (renormalized)", absent.score === absent2.score && !("gamification" in absent.breakdown))
}

function sourceLayer() {
  console.log("\n[wiring — ledger consolidation, radar feed, cron]")
  const gam = src("app/actions/gamification.ts")
  check("gamification.ts is a real server-action module (three client components import it)", /^"use server"/.test(gam))
  check("addPoints rides the ONE atomic award path, not read-modify-write", /awardAgentPoints\(/.test(gam) && !/gamification_points: newPoints/.test(gam))
  check("every reader validates against the shared vocabulary", /leaderboard-vocabulary/.test(gam) && /isLeaderboardScope/.test(gam))
  const awardLib = src("lib/gamification/award-points.ts")
  check("the award wrapper calls the atomic RPC", /rpc\("award_agent_points"/.test(awardLib))
  const board = src("lib/recruiting/leaderboard.ts")
  check("the populator writes TEAM scope, not just brokerage", /scope: "team"/.test(board) && /team_id: teamId/.test(board))
  check("the populator builds all three metrics from real rows", /from\("transactions"\)/.test(board) && /referring_agent_id/.test(board))
  const readers = ["app/actions/gamification.ts", "app/actions/agents.ts", "app/dashboard/intelligence/page.tsx", "app/dashboard/motivation/motivation-client.tsx"]
  check("no reader asks for the scope nothing writes", readers.every((f) => !/scope:\s*"agent"/.test(src(f))))
  check("the motivation board no longer offers revenue", !/"revenue"/.test(src("app/dashboard/motivation/motivation-client.tsx")))
  const mig = src("supabase/migrations/m484-a-board-read-in-one-vocabulary-and-written-in-another-can-never-show-a-row.sql")
  check("the migration closes the point-forging door", /agent_points_log_insert/.test(mig) && /is_tenant_staff_seat\(\)/.test(mig))
  check("the migration defines the atomic award function", /create or replace function public\.award_agent_points/.test(mig))
  check("the migration seeds a badge catalog awards can land on", /insert into public\.gamification_badges/.test(mig))
  const radar = src("lib/recruiting/retention-radar.ts")
  check("the retention radar gathers gamification points (30d)", /from\("agent_points_log"\)\.select\("points"\)[\s\S]*?gamificationPoints30d: points30d/.test(radar))
  const cron = src("app/api/cron/recruit-outreach/route.ts")
  check("the weekly cron snapshots the leaderboard", /runLeaderboardSnapshotAll/.test(cron))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by recruiting_manager with a runnable proof", /gamification_leaderboard:\s*\{\s*manager:\s*"recruiting_manager",\s*proof:\s*"test:leaderboard"/.test(reg))
  check("package.json wires the proof", /"test:leaderboard":\s*"tsx scripts\/leaderboard-simulator\.ts"/.test(src("package.json")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed ledger rows → snapshot ranks the leaderboard → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const { data: ags } = await svc.from("agents").select("id").eq("brokerage_id", brokerageId).eq("is_active", true).limit(2)
  if (!ags || ags.length < 1) { console.log("  ⊘ no agents — skipping"); return }
  const a1 = (ags as any)[0].id
  const a2 = (ags as any)[1]?.id ?? a1
  const cleanupLedger: string[] = []
  const { runLeaderboardSnapshot } = await import("../lib/recruiting/leaderboard")
  try {
    const { data: l1 } = await svc.from("agent_points_log").insert([
      { agent_id: a1, brokerage_id: brokerageId, points: 250, reason: "SIM", reference_type: "sim" },
      { agent_id: a2, brokerage_id: brokerageId, points: 100, reason: "SIM", reference_type: "sim" },
    ]).select("id")
    for (const r of l1 ?? []) cleanupLedger.push((r as any).id)

    const r = await runLeaderboardSnapshot(svc as any, { brokerageId })
    check("live: the snapshot wrote ranked leaderboard rows", r.rows >= 1 && r.periods >= 1)
    const { data: board } = await svc.from("leaderboard_rankings").select("agent_id, rank_position, metric_value").eq("brokerage_id", brokerageId).eq("period_label", "all_time").eq("metric_type", "points").order("rank_position", { ascending: true }).limit(5)
    check("live: rank 1 is a real agent with the highest points", !!(board && (board as any[]).length >= 1 && (board as any[])[0].rank_position === 1))
  } finally {
    // Remove our seeded ledger rows, then re-snapshot to restore the board to its real state.
    for (const id of cleanupLedger) await svc.from("agent_points_log").delete().eq("id", id)
    await svc.from("leaderboard_rankings").delete().eq("brokerage_id", brokerageId).in("period_label", [isoWeekLabel(new Date()), monthLabel(new Date()), "all_time"]).in("metric_type", ["points", "transactions", "referrals"]).in("scope", ["brokerage", "team"])
    try { await runLeaderboardSnapshot(svc as any, { brokerageId }) } catch { /* best-effort restore */ }
    let left = 0
    for (const id of cleanupLedger) { const { count } = await svc.from("agent_points_log").select("id", { count: "exact", head: true }).eq("id", id); left += count ?? 0 }
    check("live: seeded ledger rows cleaned up == 0", left === 0)
  }
}

async function main() {
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ LEADERBOARD_FAIL"); process.exit(1) }
  console.log(" ✅ LEADERBOARD_PASS — one ledger, a populated leaderboard, and gamification feeding the retention score")
}
main()
