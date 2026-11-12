#!/usr/bin/env tsx
/**
 * scripts/retention-outcomes-simulator.ts   (npm run test:retention-outcomes)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the RETENTION OUTCOME loop — did the save-play WORK? A save-play's result is classified from
 * existing data (score recovery + is_active) — no new table — and rolled into a win-rate the command
 * center shows, making the AI team's retention interventions accountable. Honest: no fabricated wins.
 *
 * PURE:   classifyRetentionOutcome (retained/lost/pending) + summarizeRetentionOutcomes (win rate).
 * SOURCE: the board reads real save-plays + scores + is_active; wired into loadCommandCenter + the card.
 * LIVE (creds-gated): seed a save-play + a recovered score → retained; the board surfaces the win rate;
 *         clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { classifyRetentionOutcome, summarizeRetentionOutcomes, OUTCOME_SETTLE_DAYS } from "../lib/intelligence/retention-outcomes"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
const now = new Date("2026-07-03T00:00:00Z")

function pureLayer() {
  console.log("\n[classifyRetentionOutcome · pure — honest win/loss]")
  check("agent deactivated after a save-play → lost", classifyRetentionOutcome({ savePlayDate: "2026-06-01", scoresAfter: [{ score_date: "2026-06-10", composite_score: 30 }], isActive: false, now }) === "lost")
  check("score recovered above at-risk while active → retained", classifyRetentionOutcome({ savePlayDate: "2026-06-01", scoresAfter: [{ score_date: "2026-06-20", composite_score: 62 }], isActive: true, now }) === "retained")
  check("still at-risk + active, inside the settle window → pending (not a fabricated win)", classifyRetentionOutcome({ savePlayDate: "2026-06-20", scoresAfter: [{ score_date: "2026-06-25", composite_score: 25 }], isActive: true, now }) === "pending")
  check("only scores AFTER the save-play count", classifyRetentionOutcome({ savePlayDate: "2026-06-15", scoresAfter: [{ score_date: "2026-06-01", composite_score: 90 }], isActive: true, now }) === "pending")
  check("no scores yet + active (recent) → pending", classifyRetentionOutcome({ savePlayDate: "2026-06-25", scoresAfter: [], isActive: true, now }) === "pending")

  console.log(`\n[aging · pure — unresolved past OUTCOME_SETTLE_DAYS (${OUTCOME_SETTLE_DAYS}d) stops reading as "still working"]`)
  // Derive the boundary dates from the RULE (§2: assert the rule, never pin a waypoint).
  const justInside = new Date(now.getTime() - (OUTCOME_SETTLE_DAYS - 1) * 86_400_000).toISOString()
  const justPast = new Date(now.getTime() - (OUTCOME_SETTLE_DAYS + 1) * 86_400_000).toISOString()
  check("unresolved younger than the settle window → still pending", classifyRetentionOutcome({ savePlayDate: justInside, scoresAfter: [], isActive: true, now }) === "pending")
  check("unresolved older than the settle window → aging", classifyRetentionOutcome({ savePlayDate: justPast, scoresAfter: [], isActive: true, now }) === "aging")
  check("a settled case never ages: old + recovered → retained", classifyRetentionOutcome({ savePlayDate: justPast, scoresAfter: [{ score_date: "2026-06-20", composite_score: 70 }], isActive: true, now }) === "retained")
  check("a settled case never ages: old + deactivated → lost", classifyRetentionOutcome({ savePlayDate: justPast, scoresAfter: [], isActive: false, now }) === "lost")

  console.log("\n[summarizeRetentionOutcomes · pure — win rate]")
  const b = summarizeRetentionOutcomes(["retained", "retained", "lost", "pending", "aging"])
  check("counts retained/lost/pending/aging", b.retained === 2 && b.lost === 1 && b.pending === 1 && b.aging === 1 && b.total === 5)
  check("win rate = retained / settled (2/3) — aging stays OUT of the settled denominator", b.winRate === 0.67)
  check("win rate null until a case settles (pending/aging alone never settle it)", summarizeRetentionOutcomes(["pending", "aging"]).winRate === null)
}

function sourceLayer() {
  console.log("\n[wiring — reads real save-plays + scores, board in command center]")
  const board = src("lib/intelligence/retention-outcomes.ts")
  check("reads the radar's save-plays (RETENTION SAVE-PLAY)", /ilike\("rationale", "RETENTION SAVE-PLAY%"\)/.test(board))
  check("reads is_active + agent_retention_scores to classify", /from\("agents"\)[\s\S]*?is_active[\s\S]*?agent_retention_scores/.test(board))
  const cc = src("lib/kernel/command-center.ts")
  check("retentionOutcomes wired into loadCommandCenter", /retentionOutcomes:\s*import\("@\/lib\/intelligence\/retention-outcomes"\)/.test(cc) && /generateRetentionOutcomeBoard\(brokerageId\)/.test(cc))
  const client = src("app/dashboard/admin/command-center/command-center-client.tsx")
  check("the retention card shows save-play effectiveness + win rate", /Save-play effectiveness/.test(client) && /data\.retentionOutcomes/.test(client))
  check("the retention card surfaces the aging count distinctly", /retentionOutcomes\.aging/.test(client))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed a save-play + a recovered score → retained → board win rate → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const { data: ag } = await svc.from("agents").select("id").eq("brokerage_id", brokerageId).eq("is_active", true).limit(1).maybeSingle()
  if (!ag) { console.log("  ⊘ no active agent — skipping"); return }
  const agentId = (ag as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  const playDate = new Date(Date.now() - 20 * 86_400_000).toISOString()
  const recoverDate = new Date().toISOString().slice(0, 10)
  try {
    const { data: msg } = await svc.from("agent_client_messages").insert({
      brokerage_id: brokerageId, agent_kind: "recruiting_manager", entity_type: "agent", entity_id: agentId,
      audience: "agent", subject: "Retention watch", body: "check in", status: "proposed", created_at: playDate,
      rationale: `RETENTION SAVE-PLAY — agent:${agentId} — test`,
    }).select("id").single()
    cleanup.push({ table: "agent_client_messages", id: (msg as any).id })
    const { data: sc } = await svc.from("agent_retention_scores").insert({
      brokerage_id: brokerageId, agent_id: agentId, score_date: recoverDate, composite_score: 68, tier: "healthy",
    }).select("id").single()
    cleanup.push({ table: "agent_retention_scores", id: (sc as any).id })

    const { generateRetentionOutcomeBoard } = await import("../lib/intelligence/retention-outcomes")
    const board = await generateRetentionOutcomeBoard(brokerageId, svc as any)
    check("live: the recovered agent is counted retained", !!board && board.retained >= 1)
    check("live: a settled case yields a win rate", !!board && board.winRate !== null)
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
  if (fail > 0) { console.log(" ❌ RETENTION_OUTCOMES_FAIL"); process.exit(1) }
  console.log(" ✅ RETENTION_OUTCOMES_PASS — the save-play loop is closed; the AI team's retention win-rate is accountable")
}
main()
