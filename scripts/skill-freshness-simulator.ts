#!/usr/bin/env tsx
/**
 * scripts/skill-freshness-simulator.ts   (npm run test:skill-freshness)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the CONTINUING-COMPETENCY / SKILL-FRESHNESS loop — the education-domain closure. Real
 * last-practice signals → per-skill freshness; a STALE skill (or an untested one for a tenured agent)
 * → ONE gated refresher nudge; the whole roster rolls into a Command Center board. HONEST: never-practiced
 * is "untested" (not decayed); a failed quiz is a weak score; missing data is neutral, never fabricated.
 *
 * PURE:   scoreSkill / computeSkillFreshness (decay windows, weak-score accelerator, honest untested) +
 *         summarizeSkillBoard (roster roll-up, rustiest-first).
 * SOURCE: the radar rides the onboarding-reminders cron + gated nudge; the board is wired into
 *         loadCommandCenter + rendered; owned by recruiting_manager with a runnable proof.
 * LIVE (creds-gated): seed an agent with a STALE objection drill + a FRESH quiz → radar proposes ONE
 *         gated objection refresher (not for the fresh skill) → idempotent → board shows it → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { scoreSkill, computeSkillFreshness, type SkillSignal } from "../lib/education/skill-freshness"
import { summarizeSkillBoard } from "../lib/intelligence/skill-freshness-board"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[scoreSkill / computeSkillFreshness · pure — real decay, honest untested]")
  check("objection drill 90 days ago → stale", scoreSkill({ area: "objection_handling", lastPracticedDays: 90, lastScore: 80 }).status === "stale")
  check("objection drill 10 days ago → fresh", scoreSkill({ area: "objection_handling", lastPracticedDays: 10, lastScore: 80 }).status === "fresh")
  check("recent but WEAK score → stale accelerated", scoreSkill({ area: "objection_handling", lastPracticedDays: 40, lastScore: 45 }).status === "stale")
  check("never practiced → untested (not decayed)", scoreSkill({ area: "product_knowledge", lastPracticedDays: null, lastScore: null }).status === "untested" && scoreSkill({ area: "product_knowledge", lastPracticedDays: null, lastScore: null }).decayed === false)
  check("coursework decays slower than objection handling", scoreSkill({ area: "coursework", lastPracticedDays: 90, lastScore: 80 }).status === "fresh")
  check("reason names the real signal", /days|scored|never/.test(scoreSkill({ area: "objection_handling", lastPracticedDays: 90, lastScore: 80 }).reason))

  const report = computeSkillFreshness([
    { area: "objection_handling", lastPracticedDays: 90, lastScore: 80 },  // stale
    { area: "product_knowledge", lastPracticedDays: 10, lastScore: 95 },   // fresh
    { area: "coursework", lastPracticedDays: null, lastScore: null },      // untested
  ])
  check("report: 1 stale → overall needs_refresh", report.staleCount === 1 && report.overall === "needs_refresh")
  check("all-untested agent → overall unproven (not needs_refresh)", computeSkillFreshness([{ area: "objection_handling", lastPracticedDays: null, lastScore: null }]).overall === "unproven")
  check("all-fresh agent → overall sharp", computeSkillFreshness([{ area: "objection_handling", lastPracticedDays: 5, lastScore: 90 }]).overall === "sharp")

  console.log("\n[summarizeSkillBoard · pure — rustiest first]")
  const board = summarizeSkillBoard([
    { agentId: "a", name: "Stale Sam", skills: computeSkillFreshness([{ area: "objection_handling", lastPracticedDays: 90, lastScore: 80 }]) },
    { agentId: "b", name: "Sharp Sue", skills: computeSkillFreshness([{ area: "objection_handling", lastPracticedDays: 5, lastScore: 95 }]) },
    { agentId: "c", name: "New Ned", skills: computeSkillFreshness([{ area: "objection_handling", lastPracticedDays: null, lastScore: null }]) },
  ])
  check("board counts: 1 need-refresh, 1 unproven, 1 sharp", board.needRefresh === 1 && board.unproven === 1 && board.sharp === 1)
  check("rustiest first: stale(a) leads, then untested(c)", board.agents[0].agentId === "a" && board.agents[1].agentId === "c")
  check("stale agent's area is named", board.agents[0].areas.some((x) => /Objection/i.test(x)))
}

function sourceLayer() {
  console.log("\n[wiring — radar cron, gated nudge, board in command center, owned]")
  const radar = src("lib/education/skill-freshness-radar.ts")
  check("gathers REAL last-practice signals (objection / quiz / completed modules)", /objection_training_sessions[\s\S]*?agent_quiz_attempts[\s\S]*?learning_assignments/.test(radar))
  check("coursework signal reads the canonical learning_assignments rail, NOT the write-dead agent_courses", !/from\("agent_courses"\)/.test(radar))
  check("nudges on STALE always, UNTESTED only when tenured", /status === "stale" \|\| \(s\.status === "untested" && \(tenureDays \?\? 0\) >= UNTESTED_TENURE_DAYS\)/.test(radar))
  check("proposes a GATED refresher, deduped per (agent, skill, month)", /SKILL REFRESH — agent:\$\{a\.id\} — \$\{skill\.area\} — \$\{monthKey\}/.test(radar) && /proposeClientMessage/.test(radar))
  const cron = src("app/api/cron/onboarding-reminders/route.ts")
  check("the daily onboarding-reminders cron runs the radar", /runSkillFreshnessRadarAll/.test(cron))
  const cc = src("lib/kernel/command-center.ts")
  check("skillBoard is in the CommandCenterData contract + generated", /skillBoard:\s*import\("@\/lib\/intelligence\/skill-freshness-board"\)/.test(cc) && /generateSkillFreshnessBoard\(brokerageId\)/.test(cc))
  const client = src("app/dashboard/admin/command-center/command-center-client.tsx")
  check("the client renders the skill-freshness board card", /Skill freshness/.test(client) && /data\.skillBoard/.test(client))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by recruiting_manager with a runnable proof", /skill_freshness_radar:\s*\{\s*manager:\s*"recruiting_manager",\s*proof:\s*"test:skill-freshness"/.test(reg))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed a STALE objection drill → radar proposes ONE gated refresher → idempotent → board → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const { data: ag } = await svc.from("agents").select("id, user_id").eq("brokerage_id", brokerageId).not("user_id", "is", null).limit(1).maybeSingle()
  if (!ag) { console.log("  ⊘ no agent — skipping"); return }
  const agentId = (ag as any).id
  const agentUserId = (ag as any).user_id
  const cleanup: Array<{ table: string; id: string }> = []
  const staleDate = new Date(Date.now() - 90 * 86_400_000).toISOString()
  try {
    const { data: sess } = await svc.from("objection_training_sessions").insert({
      brokerage_id: brokerageId, agent_user_id: agentUserId, scenario_key: "zz_test_price", scenario_label: "ZZ Test — price objection",
      status: "completed", started_at: staleDate, completed_at: staleDate, total_score: 82,
    }).select("id").single()
    cleanup.push({ table: "objection_training_sessions", id: (sess as any).id })

    const { runSkillFreshnessRadar } = await import("../lib/education/skill-freshness-radar")
    const r1 = await runSkillFreshnessRadar(svc as any, { brokerageId })
    check("live: scanned the agent and found a stale skill", r1.scanned >= 1 && r1.staleSkills >= 1)
    check("live: proposed at least one gated refresher", r1.nudged >= 1)

    const { data: msg } = await svc.from("agent_client_messages").select("id, entity_type, audience, status")
      .eq("brokerage_id", brokerageId).eq("entity_type", "agent").eq("entity_id", agentId)
      .eq("agent_kind", "recruiting_manager").ilike("rationale", "SKILL REFRESH — agent:%objection_handling%").order("created_at", { ascending: false }).limit(1).maybeSingle()
    if (msg) cleanup.push({ table: "agent_client_messages", id: (msg as any).id })
    check("live: the objection refresher is a GATED proposal to the agent", !!msg && (msg as any).status === "proposed" && (msg as any).audience === "agent")

    const r2 = await runSkillFreshnessRadar(svc as any, { brokerageId })
    check("live: idempotent — no duplicate refresher the same month", r2.nudged === 0)

    const { generateSkillFreshnessBoard } = await import("../lib/intelligence/skill-freshness-board")
    const board = await generateSkillFreshnessBoard(brokerageId, svc as any)
    check("live: the command-center board flags an agent needing a refresher", !!board && board.needRefresh >= 1)
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
  if (fail > 0) { console.log(" ❌ SKILL_FRESHNESS_FAIL"); process.exit(1) }
  console.log(" ✅ SKILL_FRESHNESS_PASS — decayed skills trigger gated refreshers; the roster's competency is visible in the command center")
}
main()
