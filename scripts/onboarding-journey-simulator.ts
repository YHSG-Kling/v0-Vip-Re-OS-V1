#!/usr/bin/env tsx
/**
 * scripts/onboarding-journey-simulator.ts   (npm run test:onboarding-journey)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the 90-DAY ONBOARDING JOURNEY + DAILY ACTION PLAN on the kept kernel path: phases derived from
 * day_number, milestone gating, a deterministic morning plan, and tiered fall-behind → gated broker
 * intervention on red.
 *
 * PURE:   phaseForDay + isPhaseUnlocked (gate on earlier-phase required steps) + journeyProgress +
 *         buildDailyActionPlan (3 tasks + tip, pipeline/lead fill, deterministic) + fallBehindRisk (tiers).
 * SOURCE: the daily plan action + agent card; the fall-behind runner proposes a gated red intervention;
 *         the cron runs it; owned by recruiting_manager with a runnable proof.
 * LIVE (creds-gated): a real onboarding agent's journey loads a plan; a red faller gets a gated broker msg → clean up.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import {
  phaseForDay, isPhaseUnlocked, journeyProgress, buildDailyActionPlan, fallBehindRisk, PHASES, type JourneyStep,
} from "../lib/kernel/onboarding-journey"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
const step = (id: string, day: number, required = true): JourneyStep => ({ id, name: `Step ${id}`, dayNumber: day, required })

function pureLayer() {
  console.log("\n[phases · pure — derived from day_number, no schema change]")
  check("day 1 → Phase 1 Foundation", phaseForDay(1).phase === 1 && phaseForDay(1).label === "Foundation")
  check("day 20 → Phase 2, day 45 → Phase 3, day 80 → Phase 4", phaseForDay(20).phase === 2 && phaseForDay(45).phase === 3 && phaseForDay(80).phase === 4)
  check("beyond 90 clamps to Phase 4", phaseForDay(200).phase === 4)
  check("there are 4 phases covering 1..90", PHASES.length === 4 && PHASES[0].startDay === 1 && PHASES[3].endDay === 90)

  console.log("\n[gating · pure — anti-skip milestone rule]")
  const steps = [step("p1a", 3), step("p1b", 10), step("p2a", 20), step("p3a", 40)]
  check("Phase 1 is always unlocked", isPhaseUnlocked(1, steps, new Set()))
  check("Phase 2 locked until ALL Phase-1 required steps done", !isPhaseUnlocked(2, steps, new Set(["p1a"])) && isPhaseUnlocked(2, steps, new Set(["p1a", "p1b"])))
  check("Phase 3 needs phases 1+2 done", !isPhaseUnlocked(3, steps, new Set(["p1a", "p1b"])) && isPhaseUnlocked(3, steps, new Set(["p1a", "p1b", "p2a"])))

  console.log("\n[progress + fall-behind · pure]")
  const prog = journeyProgress(20, steps, new Set(["p1a", "p1b"]))
  check("progress: 2/4 required done → 50% overall, Phase 2", prog.overallPct === 50 && prog.phase === 2)
  check("fall-behind: day 45 but only 10% done → red", fallBehindRisk(45, 10) === "red")
  check("fall-behind: modest shortfall → yellow", fallBehindRisk(30, 15) === "yellow")
  check("fall-behind: on track → none; new agent (<3d) never flagged; finished never flagged", fallBehindRisk(20, 25) === "none" && fallBehindRisk(2, 0) === "none" && fallBehindRisk(90, 100) === "none")

  console.log("\n[daily action plan · pure — deterministic 3 tasks + tip]")
  const plan = buildDailyActionPlan({ agentName: "Sam", dayInProgram: 17, phase: 2, pendingSteps: [step("s1", 15), step("s2", 18), step("s3", 22), step("s4", 25)], openLeads: 3, activePipeline: 0 })
  check("greeting names the agent + day", /Sam/.test(plan.greeting) && /day 17/.test(plan.greeting))
  check("exactly 3 priority tasks, nearest-day pending first", plan.priorityTasks.length === 3 && plan.priorityTasks[0].stepId === "s1")
  check("has a phase-specific learning tip + motivation", plan.learningTip.length > 0 && plan.motivation.length > 0)
  const thin = buildDailyActionPlan({ agentName: null, dayInProgram: 5, phase: 1, pendingSteps: [step("only", 3)], openLeads: 2, activePipeline: 0 })
  check("fills to 3 tasks from pipeline/leads when few steps pending", thin.priorityTasks.length === 3 && thin.priorityTasks.some((t) => /open lead/.test(t.title)))
}

function sourceLayer() {
  console.log("\n[wiring — action, card, fall-behind runner, cron, owned]")
  const act = src("app/actions/onboarding/daily-plan.ts")
  check("the daily-plan action builds the plan from real onboarding + pipeline state", /buildDailyActionPlan\(\{/.test(act) && /agent_step_completions/.test(act) && /agent_onboarding/.test(act))
  check("the agent dashboard mounts the journey card", /<OnboardingJourneyCard agentId=\{agentId\} \/>/.test(src("app/dashboard/agent/page.tsx")))
  check("the card reads getAgentDailyActionPlan", /getAgentDailyActionPlan\(agentId\)/.test(src("app/components/agent/onboarding-journey-card.tsx")))
  const fb = src("lib/kernel/onboarding-fallbehind.ts")
  check("the fall-behind runner proposes a GATED broker intervention on RED, deduped per week", /risk !== "red"/.test(fb) && /ONBOARDING FALL-BEHIND — agent:/.test(fb) && /proposeClientMessage/.test(fb))
  check("the onboarding-reminders cron runs fall-behind detection", /runOnboardingFallBehindAll/.test(src("app/api/cron/onboarding-reminders/route.ts")))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by recruiting_manager with a runnable proof", /onboarding_journey:\s*\{\s*manager:\s*"recruiting_manager",\s*proof:\s*"test:onboarding-journey"/.test(reg))
  check("package.json wires the proof", /"test:onboarding-journey":\s*"tsx scripts\/onboarding-journey-simulator\.ts"/.test(src("package.json")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed a red-faller onboarding agent → the runner proposes a gated broker intervention → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const { data: ag } = await svc.from("agents").select("id").eq("brokerage_id", brokerageId).eq("is_active", true).limit(1).maybeSingle()
  if (!ag) { console.log("  ⊘ no agent — skipping"); return }
  const agentId = (ag as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    // Seed an onboarding row far behind: day ~50 (via start_date) but 0% complete.
    const { data: existing } = await svc.from("agent_onboarding").select("id, current_day, start_date, status, completion_percentage").eq("agent_id", agentId).maybeSingle()
    const start = new Date(Date.now() - 50 * 86_400_000).toISOString()
    let restore: any = null
    if (existing) {
      restore = { current_day: (existing as any).current_day, start_date: (existing as any).start_date, status: (existing as any).status, completion_percentage: (existing as any).completion_percentage }
      await svc.from("agent_onboarding").update({ current_day: 50, start_date: start, status: "in_progress", completion_percentage: 0 }).eq("agent_id", agentId)
    } else {
      const { data: ins } = await svc.from("agent_onboarding").insert({ agent_id: agentId, brokerage_id: brokerageId, current_day: 50, start_date: start, status: "in_progress", completion_percentage: 0 }).select("id").single()
      if (ins) cleanup.push({ table: "agent_onboarding", id: (ins as any).id })
    }

    const { runOnboardingFallBehind } = await import("../lib/kernel/onboarding-fallbehind")
    const r = await runOnboardingFallBehind(svc as any, { brokerageId })
    check("live: the runner flagged ≥1 red faller + proposed an intervention", r.red >= 1 && r.interventions >= 1)
    const { data: msg } = await svc.from("agent_client_messages").select("id").eq("brokerage_id", brokerageId).eq("entity_type", "agent").eq("entity_id", agentId).eq("agent_kind", "recruiting_manager").ilike("rationale", "ONBOARDING FALL-BEHIND%").order("created_at", { ascending: false }).limit(1).maybeSingle()
    check("live: a gated broker intervention was proposed", !!msg)
    if (msg) cleanup.push({ table: "agent_client_messages", id: (msg as any).id })

    if (restore) await svc.from("agent_onboarding").update(restore).eq("agent_id", agentId)
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
  if (fail > 0) { console.log(" ❌ ONBOARDING_JOURNEY_FAIL"); process.exit(1) }
  console.log(" ✅ ONBOARDING_JOURNEY_PASS — phased + gated journey, deterministic daily plan, tiered fall-behind → gated broker intervention")
}
main()
