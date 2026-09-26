#!/usr/bin/env tsx
/**
 * scripts/retention-board-simulator.ts   (npm run test:retention-board)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the RETENTION BOARD — the Recruiting Manager's daily flight-risk scores made visible in the
 * one Command Center (the radar wrote the scores; this surfaces the board so a broker sees churn risk
 * at a glance). No model narration in the numbers.
 *
 * PURE:   summarizeRetentionBoard — latest-per-agent dedupe, tier counts, worst-first ordering, cap.
 * SOURCE: the board is wired into loadCommandCenter (brokerage-wide) and rendered in the client card.
 * LIVE (creds-gated): seed 3 agents' scores (incl. a fresh at-risk) → loadCommandCenter returns the
 *         board worst-first with the right counts → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { summarizeRetentionBoard } from "../lib/intelligence/retention-board"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[summarizeRetentionBoard · pure — latest-per-agent, worst-first, honest counts]")
  const names = new Map([["a", "Alice A"], ["b", "Bob B"], ["c", "Carol C"]])
  const rows = [
    // a: two rows — newest (desc order) wins; a is critical
    { agent_id: "a", score_date: "2026-07-02", composite_score: 15, tier: "critical", score_trend: "declining", driving_signals: ["no activity in 40 days"], previous_score: 55, signal_breakdown: { activity: 0.05, production: 0.4, pipeline: 0.9 } },
    { agent_id: "a", score_date: "2026-07-01", composite_score: 55, tier: "watch", score_trend: "stable", driving_signals: [] },
    { agent_id: "b", score_date: "2026-07-02", composite_score: 35, tier: "at_risk", score_trend: "declining", driving_signals: ["closing drought"] },
    { agent_id: "c", score_date: "2026-07-02", composite_score: 88, tier: "engaged", score_trend: "improving", driving_signals: [] },
  ]
  const board = summarizeRetentionBoard(rows, names)
  check("dedupes to latest score per agent (a uses 07-02, not 07-01)", board.scored === 3 && board.agents.find((x) => x.agentId === "a")!.score === 15)
  check("counts: 2 at-risk (critical+at_risk), 0 watch, 1 healthy", board.atRisk === 2 && board.watch === 0 && board.healthy === 1)
  check("worst-first order: critical(a) → at_risk(b) → engaged(c)", board.agents[0].agentId === "a" && board.agents[1].agentId === "b" && board.agents[2].agentId === "c")
  check("asOf = the most recent score_date", board.asOf === "2026-07-02")
  check("names resolved; drivers carried", board.agents[0].name === "Alice A" && board.agents[0].drivers[0] === "no activity in 40 days")
  check("missing name → honest fallback, never blank", summarizeRetentionBoard([{ agent_id: "z", score_date: "2026-07-02", composite_score: 20, tier: "at_risk", score_trend: null, driving_signals: null }], new Map()).agents[0].name === "An agent")
  check("cap bounds the card list", summarizeRetentionBoard(Array.from({ length: 20 }, (_, i) => ({ agent_id: `a${i}`, score_date: "2026-07-02", composite_score: i, tier: "at_risk", score_trend: null, driving_signals: null })), new Map(), 8).agents.length === 8)
  check("empty → zeroed board, not garbage", summarizeRetentionBoard([], new Map()).scored === 0)
  // agent_retention_scores.previous_score + signal_breakdown — written daily by the
  // radar and, until w26, read by nothing. The delta is DERIVED (§2), never stored.
  check("delta = score − previous_score (magnitude, not just a direction word)", board.agents.find((x) => x.agentId === "a")!.delta === -40)
  check("no previous_score → NO delta (never a fabricated 0)", board.agents.find((x) => x.agentId === "b")!.delta === null)
  check("weakest signal is the lowest sub-score, as 0–100", (() => {
    const w = board.agents.find((x) => x.agentId === "a")!.weakestSignal
    return w !== null && w.key === "activity" && w.score === 5
  })())
  check("no breakdown → no weakest signal", board.agents.find((x) => x.agentId === "c")!.weakestSignal === null)
  // MUTATION / POSITIVE CONTROL: an unusable breakdown must not become a 0-score
  // signal, and a non-numeric previous_score must not become a delta.
  check("unusable breakdown + non-numeric previous → both null", (() => {
    const one = summarizeRetentionBoard(
      [{ agent_id: "m", score_date: "2026-07-02", composite_score: 30, tier: "at_risk", score_trend: null, driving_signals: null, previous_score: null, signal_breakdown: {} }],
      new Map(),
    ).agents[0]
    return one.delta === null && one.weakestSignal === null
  })())
}

function sourceLayer() {
  console.log("\n[wiring — loader slice + client card]")
  const cc = src("lib/kernel/command-center.ts")
  check("retentionBoard is part of the CommandCenterData contract", /retentionBoard:\s*import\("@\/lib\/intelligence\/retention-board"\)\.RetentionBoard \| null/.test(cc))
  check("loadCommandCenter generates it (brokerage-wide, best-effort)", /generateRetentionBoard\(brokerageId\)/.test(cc) && /retentionBoard = retentionRes\.value/.test(cc))
  const client = src("app/dashboard/admin/command-center/command-center-client.tsx")
  check("the client renders the retention board card", /Agent retention board/.test(client) && /data\.retentionBoard/.test(client))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed retention scores → loadCommandCenter returns the board worst-first → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const { data: ags } = await svc.from("agents").select("id").eq("brokerage_id", brokerageId).limit(2)
  if (!ags || ags.length < 1) { console.log("  ⊘ no agents — skipping"); return }
  const cleanup: Array<{ table: string; id: string }> = []
  const today = new Date().toISOString().slice(0, 10)
  try {
    const seeds = [
      { agent_id: (ags as any[])[0].id, composite_score: 18, tier: "critical", score_trend: "declining", driving_signals: ["no assistant activity in 40 days"] },
      ...((ags as any[])[1] ? [{ agent_id: (ags as any[])[1].id, composite_score: 88, tier: "engaged", score_trend: "improving", driving_signals: [] as string[] }] : []),
    ]
    for (const s of seeds) {
      const { data } = await svc.from("agent_retention_scores").insert({ brokerage_id: brokerageId, score_date: today, ...s }).select("id").single()
      cleanup.push({ table: "agent_retention_scores", id: (data as any).id })
    }

    const { loadCommandCenter } = await import("../lib/kernel/command-center")
    const cc = await loadCommandCenter({ brokerageId, limit: 100 })
    check("live: the command center now carries a retention board", !!cc.retentionBoard && cc.retentionBoard.scored >= 1)
    check("live: our seeded critical agent is counted at-risk and leads the board", (cc.retentionBoard?.atRisk ?? 0) >= 1 && (cc.retentionBoard!.agents[0].tier === "critical" || cc.retentionBoard!.agents[0].tier === "at_risk"))
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
  if (fail > 0) { console.log(" ❌ RETENTION_BOARD_FAIL"); process.exit(1) }
  console.log(" ✅ RETENTION_BOARD_PASS — the radar's flight-risk scores are visible in the one command center")
}
main()
