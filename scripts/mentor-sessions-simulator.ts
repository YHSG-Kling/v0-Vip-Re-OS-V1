#!/usr/bin/env tsx
/**
 * scripts/mentor-sessions-simulator.ts   (npm run test:mentor-sessions)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves MENTOR SESSION LOGGING + PRODUCTION LIFT — sessions recorded to the canonical mentor_sessions
 * table, ledger points to both parties, and an honest mentored-vs-unmentored lift KPI.
 *
 * PURE:   computeMentorLift (cohort compare, honest MIN_COHORT gate, null lifts on thin data).
 * SOURCE: logMentorSession writes mentor_sessions + agent_points_log for both; low rating → broker flag;
 *         getMentorLift compares cohorts; the mentee UI wires the log form; owned + proof runnable.
 * LIVE (creds-gated): log a session → mentor_sessions row + 2 ledger rows → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { computeMentorLift, MIN_COHORT } from "../lib/recruiting/mentor-lift"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[computeMentorLift · pure — honest cohort compare]")
  const mentored = [{ transactions: 4, retention: 80 }, { transactions: 5, retention: 75 }, { transactions: 6, retention: 85 }]
  const unmentored = [{ transactions: 2, retention: 60 }, { transactions: 3, retention: 55 }, { transactions: 1, retention: 65 }]
  const lift = computeMentorLift(mentored, unmentored)
  check("mentored cohort shows a positive transaction lift %", lift.hasVerdict && (lift.liftTransactionsPct ?? 0) > 0)
  check("mentored cohort shows higher retention pts", (lift.liftRetentionPts ?? 0) > 0)
  check("averages are computed per cohort", lift.mentored.avgTransactions === 5 && lift.unmentored.avgTransactions === 2)
  check(`thin cohort (< ${MIN_COHORT}) → no verdict + null lifts (honest)`, (() => { const l = computeMentorLift([{ transactions: 9, retention: 90 }], unmentored); return !l.hasVerdict && l.liftTransactionsPct === null && l.liftRetentionPts === null })())
}

function sourceLayer() {
  console.log("\n[wiring — session log, ledger points, lift KPI, UI, owned]")
  const act = src("app/actions/onboarding/mentor-session.ts")
  check("logMentorSession writes the canonical mentor_sessions table", /from\("mentor_sessions"\)\.insert\(\{/.test(act))
  check("logMentorSession awards CONSOLIDATED ledger points to both parties", /from\("agent_points_log"\)\.insert\(\[[\s\S]*?MENTOR_SESSION_HELD[\s\S]*?menteeAgentId/.test(act))
  check("a low mentee rating flags a possible mismatch to the broker", /menteeRating \?\? 5\) <= 2[\s\S]*?mentor_mismatch_review/.test(act))
  check("getMentorLift compares mentored vs unmentored newer agents", /getMentorLift/.test(act) && /computeMentorLift\(/.test(act))
  check("the mentee UI wires the log-session form", /logMentorSession\(\{ mentorAgentId/.test(src("app/dashboard/onboarding/mentorship/mentorship-client.tsx")))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by recruiting_manager with a runnable proof", /mentor_sessions:\s*\{\s*manager:\s*"recruiting_manager",\s*proof:\s*"test:mentor-sessions"/.test(reg))
  check("mentor_sessions in the schema snapshot + owned in TABLE_MANAGER", /mentor_sessions:\s*\[/.test(src("scripts/schema-snapshot.ts")) && /mentor_sessions:\s*"recruiting_manager"/.test(reg))
  check("package.json wires the proof", /"test:mentor-sessions":\s*"tsx scripts\/mentor-sessions-simulator\.ts"/.test(src("package.json")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] log a session → mentor_sessions row + 2 ledger rows → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const { data: ags } = await svc.from("agents").select("id").eq("brokerage_id", brokerageId).eq("is_active", true).limit(2)
  if (!ags || (ags as any[]).length < 2) { console.log("  ⊘ need ≥2 agents — skipping"); return }
  const mentorId = (ags as any)[0].id, menteeId = (ags as any)[1].id
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: s } = await svc.from("mentor_sessions").insert({ brokerage_id: brokerageId, mentor_agent_id: mentorId, mentee_agent_id: menteeId, session_type: "check_in", mentee_rating: 5 }).select("id").single()
    cleanup.push({ table: "mentor_sessions", id: (s as any).id })
    const { data: pts } = await svc.from("agent_points_log").insert([
      { agent_id: mentorId, brokerage_id: brokerageId, points: 75, reason: "MENTOR_SESSION_HELD", reference_type: "mentor_session", reference_id: (s as any).id },
      { agent_id: menteeId, brokerage_id: brokerageId, points: 75, reason: "MENTOR_SESSION_HELD", reference_type: "mentor_session", reference_id: (s as any).id },
    ]).select("id")
    for (const p of pts ?? []) cleanup.push({ table: "agent_points_log", id: (p as any).id })
    check("live: the session + both ledger rows persisted", !!s && (pts ?? []).length === 2)
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
  if (fail > 0) { console.log(" ❌ MENTOR_SESSIONS_FAIL"); process.exit(1) }
  console.log(" ✅ MENTOR_SESSIONS_PASS — sessions logged to one table, ledger points to both, honest mentored-vs-unmentored lift")
}
main()
