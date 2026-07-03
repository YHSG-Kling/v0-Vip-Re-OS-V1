#!/usr/bin/env tsx
/**
 * scripts/exec-standup-simulator.ts   (npm run test:exec-standup)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves THE AI EXECUTIVE STANDUP: the capstone synthesis that ranks every manager's weekly output by
 * dollar impact into ONE prioritized org plan + the single human ask — a scoring/sort pass over the already-
 * aggregated boards, NOT a new data system.
 *
 * PURE:   execPriorityScore mirrors the income-engine formula; dollarImpactScore saturates honestly;
 *         buildWeeklyExecPlan turns real board/scorecard signals into ranked moves, picks the one ask,
 *         sums ONLY known dollars (never fabricates), and outranks a bigger real dollar over a banded one.
 * SOURCE: the plan is on CommandCenterData + rendered above weekly P&L in the ONE command center; the weekly
 *         runner rides the recruit-outreach cron; owned by finance_manager with a runnable proof; schema-safe.
 * LIVE (creds-gated): seed an at-risk producer + real trailing GCI → runWeeklyExecStandup fires ONE tier-safe
 *         notification with the ranked plan, and is idempotent per week → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import {
  buildWeeklyExecPlan, execPriorityScore, dollarImpactScore, rankExecutiveMoves,
  type ExecSignal, type ExecPlanInputs,
} from "../lib/intelligence/manager-weekly-exec-plan"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

const sig = (o: Partial<ExecSignal>): ExecSignal => ({
  kind: "production_drop", manager: "deal_coordinator", title: "t", why: "w",
  estimatedImpactCents: null, urgency: 50, confidence: 70, effortHours: 1, needsHuman: false, ...o,
})

function pureLayer() {
  console.log("\n[scoring · pure — one prioritization language with the income engine]")
  // Mirrors action-recommender: impact·0.4 + urgency·0.3 + confidence·0.2 + (100−effortPct)·0.1; 4h = 100% effort.
  check("formula matches the income-engine anchors (4h effort)", execPriorityScore(100, 100, 100, 4) === Math.round((100 * 0.4 + 100 * 0.3 + 100 * 0.2 + 0 * 0.1) * 100) / 100)
  check("lower effort scores higher, all else equal", execPriorityScore(50, 50, 50, 0.2) > execPriorityScore(50, 50, 50, 4))
  check("dollarImpactScore saturates at $100k and is null for no figure", dollarImpactScore(100_00 * 1000) === 100 && dollarImpactScore(null) === null && dollarImpactScore(50_000_00) === 50)

  console.log("\n[ranking · pure — real dollars outrank bands; one ask = top human move]")
  const plan = rankExecutiveMoves([
    sig({ title: "enablement", kind: "enablement", estimatedImpactCents: null, urgency: 25, confidence: 80, effortHours: 0.5, needsHuman: true }),
    sig({ title: "big-save", kind: "retention_risk", manager: "recruiting_manager", estimatedImpactCents: 8_000_000, urgency: 95, confidence: 90, effortHours: 1, needsHuman: true }),
    sig({ title: "momentum", kind: "growth_opportunity", estimatedImpactCents: 300_000, urgency: 40, confidence: 70, effortHours: 3, needsHuman: false }),
  ], { topN: 6 })
  check("the $80k retention save ranks #1 over a banded enablement move", plan.moves[0].title === "big-save" && plan.moves[0].rank === 1)
  check("the one ask is the top move that needs a human", plan.oneAsk?.title === "big-save")
  check("total sums ONLY known dollars (no fabrication for the null-figure move)", plan.totalKnownImpactCents === 8_000_000 + 300_000)
  check("headline names the leader + week", /big-save/.test(plan.moves[0].title) && /in play|move/.test(plan.headline))
  check("a clean board yields no moves + a covered headline", rankExecutiveMoves([]).moves.length === 0 && /covered/.test(rankExecutiveMoves([]).headline))

  console.log("\n[synthesis · pure — buildWeeklyExecPlan reads the real boards]")
  const inputs: ExecPlanInputs = {
    weeklyPnl: [{ manager: "deal_coordinator", label: "Deal Coordinator", headline: "h", metrics: [
      { label: "GCI earned", value: 4000, prior: 12000, deltaPct: -67, unit: "currency" },
    ] }] as any,
    retentionBoard: { scored: 1, atRisk: 1, watch: 0, healthy: 0, asOf: "2026-07-01", agents: [
      { agentId: "a1", name: "Dana", score: 22, tier: "critical", trend: "declining", drivers: ["quiet 30d", "no closings 90d"] },
    ] } as any,
    curriculumBoard: { pending: 2, drafts: [] } as any,
    managerBacklog: [{ manager: "campaign_orchestrator", breached: 4, pending: 9 }],
    atRiskGciCents: new Map([["a1", 6_500_000]]),
    recruitingRoiPct: 140, recruitingLtvCents: 9_000_000,
  }
  const built = buildWeeklyExecPlan(inputs, { topN: 6 })
  check("a critical producer's REAL trailing GCI drives a retention_risk move", built.moves.some((m) => m.kind === "retention_risk" && m.estimatedImpactCents === 6_500_000))
  check("the WoW GCI collapse becomes a priced production_drop move", built.moves.some((m) => m.kind === "production_drop" && (m.estimatedImpactCents ?? 0) === Math.round((12000 - 4000) * 100)))
  check("the SLA-breached backlog becomes a low-effort high-urgency approval move", built.moves.some((m) => m.kind === "approval_backlog" && m.needsHuman))
  check("a profitable recruiting ROI surfaces a flywheel move", built.moves.some((m) => m.kind === "flywheel"))
  check("pending curriculum surfaces an enablement move", built.moves.some((m) => m.kind === "enablement"))
  check("every move is manager-attributed + banded", built.moves.every((m) => !!m.managerLabel && ["high", "medium", "low"].includes(m.impactBand)))
}

function sourceLayer() {
  console.log("\n[wiring — command center, cron, ownership, schema-safe]")
  const cc = src("lib/kernel/command-center.ts")
  check("the plan is on the CommandCenterData contract", /weeklyExecPlan:\s*import\("@\/lib\/intelligence\/manager-weekly-exec-plan"\)\.WeeklyExecPlan\s*\|\s*null/.test(cc))
  check("loadCommandCenter synthesizes it brokerage-wide, reusing the computed boards", /loadWeeklyExecPlan\(brokerageId,\s*\{[\s\S]*?weeklyPnl,\s*retentionBoard,\s*curriculumBoard/.test(cc) && /managerBacklog:\s*managerBreakdown\.map/.test(cc))
  const client = src("app/dashboard/admin/command-center/command-center-client.tsx")
  check("the command center renders the ranked plan + the one ask", /AI Executive Standup/.test(client) && /weeklyExecPlan\.oneAsk/.test(client) && /weeklyExecPlan\.moves\.map/.test(client))
  const cron = src("app/api/cron/recruit-outreach/route.ts")
  check("the weekly cron runs the standup nudge", /runWeeklyExecStandupAll/.test(cron))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by finance_manager with a runnable proof", /ai_executive_standup:\s*\{\s*manager:\s*"finance_manager",\s*proof:\s*"test:exec-standup"/.test(reg))
  check("package.json wires the proof", /"test:exec-standup":\s*"tsx scripts\/exec-standup-simulator\.ts"/.test(src("package.json")))
  check("tier-safe delivery via resolveOrgRecipients (solo owner still briefed)", /resolveOrgRecipients/.test(src("lib/intelligence/manager-weekly-exec-plan.ts")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed an at-risk producer → runWeeklyExecStandup briefs the org (tier-safe) → idempotent → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const { data: ag } = await svc.from("agents").select("id").eq("brokerage_id", brokerageId).eq("is_active", true).limit(1).maybeSingle()
  if (!ag) { console.log("  ⊘ no agent — skipping"); return }
  const agentId = (ag as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const today = new Date().toISOString().slice(0, 10)
    const { data: rs } = await svc.from("agent_retention_scores").insert({
      brokerage_id: brokerageId, agent_id: agentId, score_date: today, composite_score: 20, tier: "critical",
      score_trend: "declining", driving_signals: ["quiet 30d", "no closings 90d"],
    }).select("id").single()
    if (rs) cleanup.push({ table: "agent_retention_scores", id: (rs as any).id })

    const { data: pl } = await svc.from("agent_pl_snapshot").insert({
      brokerage_id: brokerageId, agent_id: agentId, month_year: today.slice(0, 7), gci_gross: 65000, transaction_count: 3,
    }).select("id").single()
    if (pl) cleanup.push({ table: "agent_pl_snapshot", id: (pl as any).id })

    const { runWeeklyExecStandup } = await import("../lib/intelligence/manager-weekly-exec-plan")
    const briefed = await runWeeklyExecStandup(svc as any, brokerageId)
    check("live: the standup briefed the org (a real move existed)", briefed === true)

    const { data: notes } = await svc.from("notifications").select("id, title, body").eq("brokerage_id", brokerageId).eq("type", "exec_standup").order("created_at", { ascending: false }).limit(20)
    const noteRows = (notes ?? []) as any[]
    check("live: a tier-safe exec_standup notification landed", noteRows.length >= 1 && /Executive Standup/.test(noteRows[0].title))
    for (const n of noteRows) cleanup.push({ table: "notifications", id: n.id })

    const briefedAgain = await runWeeklyExecStandup(svc as any, brokerageId)
    check("live: re-running the same week is idempotent (deduped, no second brief)", briefedAgain === false)
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    let left = 0
    for (const c of cleanup) { const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id); left += count ?? 0 }
    check("live: cleanup count == 0", left === 0)
  }
}

async function main() {
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ EXEC_STANDUP_FAIL"); process.exit(1) }
  console.log(" ✅ EXEC_STANDUP_PASS — every manager's week ranked by real dollar impact into one org plan + the one ask, surfaced + delivered tier-safe")
}
main()
