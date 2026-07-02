#!/usr/bin/env tsx
/**
 * scripts/recruiting-roi-simulator.ts   (npm run test:recruiting-roi)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the RECRUITING ROI WRITER (recruiting_manager): recruiting_roi finally has a PRODUCTION
 * writer. The brokerage's REAL net from a recruited agent (gross × (1 − the agent's split)) is folded
 * with recruiting_costs into a durable recruiting_roi row on first-close + cost entry — HONEST about
 * what the data can't support (breakeven/LTV stay null, never fabricated).
 *
 * PURE:   brokerageNetFromSplit (gross × (1−split); honest null on unknown split) + computeRecruitingRoi
 *         (total cost, lifetime net, roi_pct; null roi when cost=0; null breakeven/ltv).
 * SOURCE: agent_first_close handler records the real net + recomputes ROI; addRecruitingCost recomputes;
 *         the weekly cron sweeps brokerage-wide; owned by recruiting_manager; m257 unique index.
 * LIVE (creds-gated): seed cost + analytics → upsert → assert real ROI row → idempotent (one per agent)
 *         → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { computeRecruitingRoi, brokerageNetFromSplit } from "../lib/recruiting/recruiting-roi-compute"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[brokerageNetFromSplit · pure — real net, honest on unknown split]")
  check("gross 10000 @ 70% agent split → 3000 brokerage net", brokerageNetFromSplit(10000, 70) === 3000)
  check("gross 10000 @ 100% split → 0 net (agent keeps all)", brokerageNetFromSplit(10000, 100) === 0)
  check("UNKNOWN split → null (honest, records gross-only)", brokerageNetFromSplit(10000, null) === null)
  check("zero/negative gross → 0", brokerageNetFromSplit(0, 70) === 0)
  check("split clamped to [0,100]", brokerageNetFromSplit(10000, 130) === 0)

  console.log("\n[computeRecruitingRoi · pure — real cost/net, honest nulls]")
  const roi = computeRecruitingRoi(
    [{ amount: 4000 }, { amount: 1000 }],
    [{ brokerage_net_from_agent: 9000, gross_commission_generated: 30000, year_number: 1 }, { brokerage_net_from_agent: 6000, gross_commission_generated: 20000, year_number: 2 }],
  )
  check("total_recruiting_cost sums costs (5000)", roi.total_recruiting_cost === 5000)
  check("lifetime_brokerage_net sums NET, not gross (15000)", roi.lifetime_brokerage_net === 15000)
  check("roi_pct = (net−cost)/cost×100 = 200", roi.roi_pct === 200)
  check("breakeven_month null (no monthly cohort — HONEST, not fabricated)", roi.breakeven_month === null)
  check("ltv_estimate null (no retention model — HONEST)", roi.ltv_estimate === null)
  const zeroCost = computeRecruitingRoi([], [{ brokerage_net_from_agent: 5000, gross_commission_generated: 0, year_number: 1 }])
  check("no cost → roi_pct null (can't divide, not '0%')", zeroCost.roi_pct === null && zeroCost.lifetime_brokerage_net === 5000)
  const noNet = computeRecruitingRoi([{ amount: 3000 }], [{ brokerage_net_from_agent: null, gross_commission_generated: 12000, year_number: 1 }])
  check("net unknown (null) → counted as 0, roi negative but real", noNet.lifetime_brokerage_net === 0 && noNet.roi_pct === -100)
}

function sourceLayer() {
  console.log("\n[wiring — real net at first close, recompute on both events, autonomous sweep, owned]")
  const sig = src("lib/kernel/manager-signals.ts")
  check("agent_first_close records the REAL brokerage net from the agent's split", /brokerageNetFromSplit\(commission/.test(sig) && /brokerage_net_from_agent: brokerageNet/.test(sig))
  check("agent_first_close recomputes recruiting_roi (the missing writer)", /upsertRecruitingRoi\(ctx\.supabase/.test(sig))
  const act = src("app/actions/recruiting-roi.ts")
  check("addRecruitingCost recomputes ROI on spend change", /upsertRecruitingRoi\(createServiceClient\(\)/.test(act))
  const cron = src("app/api/cron/recruit-outreach/route.ts")
  check("weekly cron sweeps ROI brokerage-wide (autonomous safety net)", /refreshAllRecruitingRoi/.test(cron))
  const writer = src("lib/recruiting/recruiting-roi-writer.ts")
  check("writer upserts idempotently per recruited agent", /eq\("recruited_agent_id", params\.recruitedAgentId\)[\s\S]*?update\(row\)/.test(writer))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by recruiting_manager with a runnable proof", /recruiting_roi_compute:\s*\{\s*manager:\s*"recruiting_manager",\s*proof:\s*"test:recruiting-roi"/.test(reg))
  check("m257 unique index migration exists", /idx_recruiting_roi_agent_unique/.test(src("supabase/migrations/m257-recruiting-roi-agent-unique.sql")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed cost + analytics → upsert ROI → idempotent → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const { data: agent } = await svc.from("agents").select("id").eq("brokerage_id", brokerageId).limit(1).maybeSingle()
  if (!agent) { console.log("  ⊘ no agent — skipping"); return }
  const agentId = (agent as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: cost } = await svc.from("recruiting_costs").insert({ brokerage_id: brokerageId, recruited_agent_id: agentId, cost_type: "signing_bonus", amount: 4000, incurred_date: new Date().toISOString() }).select("id").single()
    cleanup.push({ table: "recruiting_costs", id: (cost as any).id })
    const { data: an } = await svc.from("recruiting_analytics").insert({ brokerage_id: brokerageId, recruited_agent_id: agentId, year_number: 1, gross_commission_generated: 30000, brokerage_net_from_agent: 12000, transaction_count: 1, computed_at: new Date().toISOString() }).select("id").single()
    cleanup.push({ table: "recruiting_analytics", id: (an as any).id })

    const { upsertRecruitingRoi } = await import("../lib/recruiting/recruiting-roi-writer")
    const r1 = await upsertRecruitingRoi(svc as any, { brokerageId, recruitedAgentId: agentId })
    check("live: ROI computed + written (roi_pct = (12000−4000)/4000×100 = 200)", r1.ok && r1.roiPct === 200)
    const { data: roiRow } = await svc.from("recruiting_roi").select("id, total_recruiting_cost, lifetime_brokerage_net, roi_pct, breakeven_month").eq("recruited_agent_id", agentId).eq("brokerage_id", brokerageId).maybeSingle()
    if (roiRow) cleanup.push({ table: "recruiting_roi", id: (roiRow as any).id })
    check("live: row has real cost + net, honest-null breakeven", Number((roiRow as any)?.total_recruiting_cost) === 4000 && Number((roiRow as any)?.lifetime_brokerage_net) === 12000 && (roiRow as any)?.breakeven_month === null)

    await upsertRecruitingRoi(svc as any, { brokerageId, recruitedAgentId: agentId })
    const { count } = await svc.from("recruiting_roi").select("id", { count: "exact", head: true }).eq("recruited_agent_id", agentId).eq("brokerage_id", brokerageId)
    check("live: idempotent — still ONE ROI row per recruited agent", count === 1)
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
  if (fail > 0) { console.log(" ❌ RECRUITING_ROI_FAIL"); process.exit(1) }
  console.log(" ✅ RECRUITING_ROI_PASS — the ROI dashboard's table finally has a real, honest production writer")
}
main()
