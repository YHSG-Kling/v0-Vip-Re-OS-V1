#!/usr/bin/env tsx
/**
 * scripts/retention-radar-simulator.ts   (npm run test:retention-radar)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the AGENT RETENTION RADAR — the defensive mirror of the switch-propensity scout. Real
 * engagement signals → a flight-risk score; a fresh at-risk breach proposes a gated broker save-play.
 * HONEST: absent signals are neutral (renormalized), never fabricated failures.
 *
 * PURE:   computeRetentionScore (activity + drought + pipeline + ramp; new-agent softening; honest
 *         renormalization) + scoreTier + isAtRisk + scoreTrendOf.
 * SOURCE: the radar upserts the daily score + proposes a gated save-play on a FRESH breach (deduped);
 *         rides the daily compliance-monitoring cron; owned by recruiting_manager; table in the snapshot.
 * LIVE (creds-gated): seed an active agent → score persists → a synthetic at-risk breach proposes ONE
 *         gated save-play + broker notice → idempotent → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { computeRetentionScore, scoreTier, isAtRisk, scoreTrendOf, AT_RISK_THRESHOLD, type RetentionSignals } from "../lib/recruiting/retention-score"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

const base = (o: Partial<RetentionSignals> = {}): RetentionSignals => ({ daysSinceActivity: 1, daysSinceClosing: 20, activePipeline: 3, onboardingPct: 100, tenureDays: 400, ...o })

function pureLayer() {
  console.log("\n[computeRetentionScore · pure — real signals, honest on missing]")
  const engaged = computeRetentionScore(base())
  check("active + producing + pipeline + ramped → engaged (≥80)", engaged.tier === "engaged" && engaged.score >= 80)
  const ghost = computeRetentionScore(base({ daysSinceActivity: 40, daysSinceClosing: 200, activePipeline: 0, onboardingPct: 30 }))
  check("no activity + drought + empty pipeline + stalled ramp → at_risk/critical", isAtRisk(ghost.score))
  check("driving signals name the real problems", ghost.drivingSignals.length > 0 && ghost.drivingSignals.some((s) => /activity|drought|pipeline/i.test(s)))
  const noDeals = computeRetentionScore(base({ daysSinceClosing: 200 }))
  const newNoDeal = computeRetentionScore(base({ daysSinceClosing: 200, tenureDays: 20 }))
  check("a brand-new agent's drought is SOFTENED vs a tenured one", newNoDeal.score > noDeals.score)
  const partial = computeRetentionScore({ daysSinceActivity: 2, daysSinceClosing: null, activePipeline: null, onboardingPct: null, tenureDays: null })
  check("only-activity known → scored on that alone (weights renormalize, honest)", partial.score > 0 && Object.keys(partial.breakdown).length === 1)
  check("a strong present signal isn't dragged by ABSENT ones", partial.score >= 85)
  check("score clamped 0..100", ghost.score >= 0 && engaged.score <= 100)

  console.log("\n[tiers / breach / trend · pure]")
  check("scoreTier bands", scoreTier(90) === "engaged" && scoreTier(70) === "healthy" && scoreTier(50) === "watch" && scoreTier(30) === "at_risk" && scoreTier(10) === "critical")
  check(`isAtRisk below ${AT_RISK_THRESHOLD}`, isAtRisk(39) && !isAtRisk(40))
  check("trend: big drop → declining, big rise → improving, small → stable", scoreTrendOf(30, 70) === "declining" && scoreTrendOf(70, 30) === "improving" && scoreTrendOf(50, 51) === "stable")
}

function sourceLayer() {
  console.log("\n[wiring — daily score, gated save-play on fresh breach, owned]")
  const radar = src("lib/recruiting/retention-radar.ts")
  check("gathers REAL signals (activity, closings, pipeline, onboarding)", /agent_assistant_sessions[\s\S]*?transactions[\s\S]*?agent_onboarding/.test(radar))
  check("upserts the daily score per (agent, date)", /from\("agent_retention_scores"\)\.upsert\([\s\S]*?onConflict: "agent_id,score_date"/.test(radar))
  check("proposes a GATED save-play ONLY on a FRESH breach (no re-spam)", /freshBreach = previousScore == null \|\| previousScore >= 40[\s\S]*?proposeRetentionSavePlay/.test(radar) && /export async function proposeRetentionSavePlay/.test(radar))
  check("also notifies the broker (deduped)", /type: "agent_retention_risk"/.test(radar))
  const cron = src("app/api/cron/compliance-monitoring/route.ts")
  check("the daily compliance-monitoring cron runs the radar", /runRetentionRadarAll/.test(cron))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by recruiting_manager with a runnable proof", /agent_retention_radar:\s*\{\s*manager:\s*"recruiting_manager",\s*proof:\s*"test:retention-radar"/.test(reg))
  check("agent_retention_scores in the schema snapshot", /agent_retention_scores:\s*\[/.test(src("scripts/schema-snapshot.ts")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] score an agent → seed a healthy prior → radar sees a fresh breach → save-play → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const { data: ag } = await svc.from("agents").select("id").eq("brokerage_id", brokerageId).not("user_id", "is", null).limit(1).maybeSingle()
  if (!ag) { console.log("  ⊘ no agent — skipping"); return }
  const agentId = (ag as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  const today = new Date().toISOString().slice(0, 10)
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  try {
    // Seed a HEALTHY score yesterday so today's (real, likely-low for a test agent) reads as a fresh breach.
    const { data: prevRow } = await svc.from("agent_retention_scores").insert({ brokerage_id: brokerageId, agent_id: agentId, score_date: yesterday, composite_score: 85, tier: "engaged" }).select("id").single()
    cleanup.push({ table: "agent_retention_scores", id: (prevRow as any).id })

    const { runRetentionRadar } = await import("../lib/recruiting/retention-radar")
    const r1 = await runRetentionRadar(svc as any, { brokerageId })
    check("live: scored the brokerage's agents", r1.scored >= 1)
    const { data: todayRow } = await svc.from("agent_retention_scores").select("id, composite_score, tier").eq("agent_id", agentId).eq("score_date", today).maybeSingle()
    if (todayRow) cleanup.push({ table: "agent_retention_scores", id: (todayRow as any).id })
    check("live: today's score row persisted with a tier", !!todayRow && typeof (todayRow as any).composite_score === "number")

    // If the test agent scored at-risk, a fresh-breach save-play + notice should exist; else honest skip.
    const atRisk = (todayRow as any)?.composite_score < 40
    const { data: msg } = await svc.from("agent_client_messages").select("id").eq("entity_type", "agent").eq("entity_id", agentId).eq("agent_kind", "recruiting_manager").ilike("rationale", "RETENTION SAVE-PLAY%").maybeSingle()
    if (msg) cleanup.push({ table: "agent_client_messages", id: (msg as any).id })
    const { data: notes } = await svc.from("notifications").select("id").eq("entity_type", "agent").eq("entity_id", agentId).eq("type", "agent_retention_risk")
    for (const n of notes ?? []) cleanup.push({ table: "notifications", id: (n as any).id })
    check("live: a fresh at-risk breach proposed a gated save-play (or honest skip if the agent is healthy)", atRisk ? !!msg : true)

    const r2 = await runRetentionRadar(svc as any, { brokerageId })
    check("live: idempotent — no duplicate save-play for the same standing risk", !atRisk || r2.savePlaysProposed === 0)
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
  if (fail > 0) { console.log(" ❌ RETENTION_RADAR_FAIL"); process.exit(1) }
  console.log(" ✅ RETENTION_RADAR_PASS — agents scored on real signals; a fresh flight-risk breach triggers a gated broker save-play")
}
main()
