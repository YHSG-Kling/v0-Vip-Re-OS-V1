#!/usr/bin/env tsx
/**
 * scripts/team-pl-simulator.ts   (npm run test:team-pl)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the TEAM P&L WRITER — the team-level rollup that closes a table-with-no-writer drift
 * (team_earnings / team_performance were read but never written). It rolls up the SAME canonical
 * agent_commissions the per-agent snapshot uses, so team + agent numbers reconcile. HONEST: what the
 * schema can't support (per-team goals, per-period retention) stays NULL, never fabricated.
 *
 * PURE:   computeTeamPnl — gross/net/top-agent/deal-count/cycle-time/conversion; honest nulls.
 * SOURCE: the writer rolls up agent_commissions per team's active members, upserts BOTH tables
 *         idempotently, rides the nightly brokerage-pl-rollup cron, owned by finance_manager.
 * LIVE (creds-gated): seed a team + 2 members + real closed commissions → writer persists reconciling
 *         team_earnings + team_performance → idempotent re-run → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { computeTeamPnl, monthLabel } from "../lib/finance/team-pl"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[computeTeamPnl · pure — canonical rollup, honest nulls]")
  const pnl = computeTeamPnl({
    commissions: [
      { agent_id: "a1", gross_commission: 10000, agent_commission: 7000, transaction_id: "t1" },
      { agent_id: "a1", gross_commission: 6000, agent_commission: 4200, transaction_id: "t2" },
      { agent_id: "a2", gross_commission: 8000, agent_commission: 5600, transaction_id: "t3" },
    ],
    activeAgentIds: ["a1", "a2", "a3"],
    closedCycle: [
      { contract_date: "2026-06-01", close_date: "2026-06-31" },
      { contract_date: "2026-06-10", close_date: "2026-06-30" },
    ],
    openDealCount: 3,
  })
  check("gross = Σ gross_commission", pnl.grossCommission === 24000)
  check("team_net = Σ agent_commission (team's take-home)", pnl.teamNet === 16800)
  check("total_revenue mirrors gross", pnl.totalRevenue === 24000)
  check("agent_count = active members (incl. a no-production member)", pnl.agentCount === 3)
  check("transaction_count = distinct closed deals", pnl.transactionCount === 3)
  check("top_agent = the period's top producer by gross (a1 @ 16k)", pnl.topAgentId === "a1")
  check("avg_days_to_close computed over dated deals", typeof pnl.avgDaysToClose === "number" && pnl.avgDaysToClose! > 0)
  check("conversion_rate = closed/(closed+open) = 3/6", pnl.conversionRate === 0.5)

  console.log("\n[honest nulls · pure]")
  const noSplit = computeTeamPnl({ commissions: [{ agent_id: "a1", gross_commission: 5000, agent_commission: null, transaction_id: "t9" }], activeAgentIds: ["a1"], closedCycle: [], openDealCount: 0 })
  check("team_net is NULL when no row carried a split (never invented)", noSplit.teamNet === null)
  check("avg_days_to_close NULL when no dated deals", noSplit.avgDaysToClose === null)
  check("conversion_rate NULL when the team had no deal activity", computeTeamPnl({ commissions: [], activeAgentIds: ["a1"], closedCycle: [], openDealCount: 0 }).conversionRate === null)
  check("empty team → zeros, not garbage", computeTeamPnl({ commissions: [], activeAgentIds: [], closedCycle: [], openDealCount: 0 }).grossCommission === 0)
  check("monthLabel is YYYY-MM", /^\d{4}-\d{2}$/.test(monthLabel(new Date("2026-07-02T00:00:00Z"))))
}

function sourceLayer() {
  console.log("\n[wiring — canonical source, both tables, idempotent, owned]")
  const w = src("lib/finance/team-pl-writer.ts")
  check("rolls up the CANONICAL agent_commissions (not commission_records/transactions.commission_amount)", /from\("agent_commissions"\)/.test(w) && !/commission_records/.test(w))
  check("upserts team_earnings idempotently per team+period", /from\("team_earnings"\)\.upsert\([\s\S]*?onConflict: "team_id,period_type,period_label"/.test(w))
  check("upserts team_performance idempotently per team+period", /from\("team_performance"\)\.upsert\([\s\S]*?onConflict: "team_id,period_label"/.test(w))
  check("only ACTIVE team members are rolled up", /from\("team_members"\)[\s\S]*?eq\("is_active", true\)/.test(w))
  const cron = src("app/api/cron/brokerage-pl-rollup/route.ts")
  check("the nightly brokerage-pl-rollup cron runs the team rollup", /runTeamPnlAll/.test(cron))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by finance_manager with a runnable proof", /team_pl_rollup:\s*\{\s*manager:\s*"finance_manager",\s*proof:\s*"test:team-pl"/.test(reg))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed team + members + real commissions → writer persists reconciling rows → idempotent → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const { data: ags } = await svc.from("agents").select("id").eq("brokerage_id", brokerageId).limit(2)
  if (!ags || ags.length < 1) { console.log("  ⊘ no agents — skipping"); return }
  const agentIds = (ags as any[]).map((a) => a.id)
  const cleanup: Array<{ table: string; id: string }> = []
  const now = new Date()
  const period = monthLabel(now)
  const closeIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15)).toISOString()
  try {
    const { data: team } = await svc.from("teams").insert({ brokerage_id: brokerageId, name: "ZZ Test Team" }).select("id").single()
    const teamId = (team as any).id
    cleanup.push({ table: "teams", id: teamId })
    for (const aid of agentIds) {
      const { data: tm } = await svc.from("team_members").insert({ brokerage_id: brokerageId, team_id: teamId, agent_id: aid, is_active: true }).select("id").single()
      cleanup.push({ table: "team_members", id: (tm as any).id })
      // agent_commission is a GENERATED column (gross × agent_split_percent/100) — set the split, not the derived value.
      const { data: ac } = await svc.from("agent_commissions").insert({ brokerage_id: brokerageId, agent_id: aid, gross_commission: 10000, agent_split_percent: 70, close_date: closeIso, status: "approved" }).select("id").single()
      cleanup.push({ table: "agent_commissions", id: (ac as any).id })
    }

    const { runTeamPnl } = await import("../lib/finance/team-pl-writer")
    const r1 = await runTeamPnl(svc as any, { brokerageId, now })
    check("live: wrote at least our test team", r1.written >= 1 && r1.withProduction >= 1)

    const { data: te } = await svc.from("team_earnings").select("id, gross_commission, team_net, agent_count, transaction_count").eq("team_id", teamId).eq("period_label", period).maybeSingle()
    if (te) cleanup.push({ table: "team_earnings", id: (te as any).id })
    const expectedGross = 10000 * agentIds.length
    check("live: team_earnings persisted with the reconciling gross", !!te && Number((te as any).gross_commission) === expectedGross)
    check("live: agent_count reflects the seeded members", !!te && (te as any).agent_count === agentIds.length)
    const { data: tp } = await svc.from("team_performance").select("id, total_revenue, goal_amount").eq("team_id", teamId).eq("period_label", period).maybeSingle()
    if (tp) cleanup.push({ table: "team_performance", id: (tp as any).id })
    // The writer never computes a per-team goal (no source) — it leaves goal_amount unset (DB default, not fabricated).
    check("live: team_performance persisted (total_revenue set, no fabricated goal)", !!tp && Number((tp as any).total_revenue) === expectedGross && !(tp as any).goal_amount)

    await runTeamPnl(svc as any, { brokerageId, now })
    const { count: dupEarnings } = await svc.from("team_earnings").select("id", { count: "exact", head: true }).eq("team_id", teamId).eq("period_label", period)
    check("live: idempotent — still exactly one team_earnings row after re-run", dupEarnings === 1)
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
  if (fail > 0) { console.log(" ❌ TEAM_PL_FAIL"); process.exit(1) }
  console.log(" ✅ TEAM_PL_PASS — team economics roll up the canonical source; both tables written, honest on missing")
}
main()
