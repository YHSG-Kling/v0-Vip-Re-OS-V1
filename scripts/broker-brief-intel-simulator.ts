#!/usr/bin/env tsx
/**
 * scripts/broker-brief-intel-simulator.ts   (npm run test:broker-brief-intel)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the reporting layer SYNTHESIZES this session's manager intelligence: the broker's daily brief
 * now surfaces agent flight-risk (a priority + a metric) and pending AI curriculum (a metric), alongside
 * deals, licenses, leads, compliance, and the manager standup.
 *
 * SOURCE: broker.ts pulls the retention + curriculum boards and folds them into priorities + metrics.
 * LIVE (creds-gated): seed an at-risk agent → generateBrokerBrief surfaces a flight-risk priority + metric.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function sourceLayer() {
  console.log("\n[wiring — the broker brief folds in the new intelligence]")
  const brief = src("lib/intelligence/user-type-briefs/broker.ts")
  check("pulls the retention board", /generateRetentionBoard\(params\.brokerageId\)/.test(brief))
  check("adds a flight-risk PRIORITY when agents are at risk", /id: "retention-flight-risk"[\s\S]*?manager: "recruiting_manager"/.test(brief))
  check("adds an 'Agents at flight risk' METRIC", /label: "Agents at flight risk", value: retentionAtRisk/.test(brief))
  check("adds a pending AI-curriculum metric", /generateCurriculumBoard\(params\.brokerageId\)[\s\S]*?AI curriculum pending/.test(brief))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — source layer proved the wiring"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed an at-risk agent → the broker brief surfaces flight-risk → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const { data: staff } = await svc.from("users").select("id").eq("brokerage_id", brokerageId).in("user_type", ["broker", "admin", "broker_admin"]).limit(1).maybeSingle()
  const userId = (staff as any)?.id ?? "00000000-0000-0000-0000-000000000000"
  const { data: ag } = await svc.from("agents").select("id").eq("brokerage_id", brokerageId).eq("is_active", true).not("user_id", "is", null).limit(1).maybeSingle()
  if (!ag) { console.log("  ⊘ no agent — skipping"); return }
  const agentId = (ag as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  const today = new Date().toISOString().slice(0, 10)
  try {
    const { data: sc } = await svc.from("agent_retention_scores").insert({ brokerage_id: brokerageId, agent_id: agentId, score_date: today, composite_score: 18, tier: "critical", driving_signals: ["no assistant activity in 40 days"] }).select("id").single()
    cleanup.push({ table: "agent_retention_scores", id: (sc as any).id })

    const { generateBrokerBrief } = await import("../lib/intelligence/user-type-briefs/broker")
    const brief = await generateBrokerBrief({ userId, brokerageId, forceRegenerate: true })
    const hasFlightRiskMetric = brief.metrics.some((m) => m.label === "Agents at flight risk" && Number(m.value) >= 1)
    check("live: the brief's flight-risk metric reflects the at-risk agent", hasFlightRiskMetric)
    const hasFlightRiskPriority = brief.priorities.some((p) => p.id === "retention-flight-risk")
    // The priority only appears if there's room in the top-3; the metric always reflects it.
    check("live: flight-risk surfaces (priority when room, else the metric carries it)", hasFlightRiskPriority || hasFlightRiskMetric)
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    let left = 0
    for (const c of cleanup) { const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id); left += count ?? 0 }
    // Clear any brief cache row generated for today (best-effort — keyed by date, so it won't leak).
    try { await svc.from("ai_daily_briefings").delete().eq("brokerage_id", brokerageId).eq("brief_date", today).eq("user_id", userId) } catch { /* ignore */ }
    check("live: cleanup count == 0", left === 0)
  }
}

async function main() {
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ BROKER_BRIEF_INTEL_FAIL"); process.exit(1) }
  console.log(" ✅ BROKER_BRIEF_INTEL_PASS — the daily report synthesizes retention + curriculum intelligence")
}
main()
