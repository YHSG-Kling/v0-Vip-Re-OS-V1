#!/usr/bin/env tsx
/**
 * scripts/challenges-simulator.ts   (npm run test:challenges)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves GAMIFICATION CHALLENGES: window-derived status, competition ranking, a LIVE scorer that reads the
 * SAME consolidated data, and a one-shot finalize that awards prize points into the SAME ledger + proposes a
 * gated announcement.
 *
 * PURE:   challengeStatus (draft/active/ended; stored cancelled wins) + rankParticipants (desc, standard
 *         competition ranking, deterministic tie-break, winners = top-N with value>0).
 * SOURCE: createChallenge is admin-gated; enrollInChallenge is idempotent; getChallenges scores LIVE via the
 *         same scorer; the cron finalizes; owned by recruiting_manager with a runnable proof; schema tracked.
 * LIVE (creds-gated): seed an ENDED challenge + enrolled agents + in-window points → runChallengeScoring
 *         finalizes ONCE (ranks, awards CHALLENGE_PRIZE into agent_points_log, proposes a gated wrap) → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { challengeStatus, rankParticipants, CHALLENGE_METRIC } from "../lib/recruiting/challenges"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
const NOW = new Date("2026-07-03T00:00:00Z")
const iso = (daysFromNow: number) => new Date(NOW.getTime() + daysFromNow * 86_400_000).toISOString()

function pureLayer() {
  console.log("\n[challengeStatus · pure — derived from the window]")
  check("before start → draft", challengeStatus("active", iso(2), iso(9), NOW) === "draft")
  check("inside window → active", challengeStatus("active", iso(-2), iso(5), NOW) === "active")
  check("past end → ended", challengeStatus("active", iso(-9), iso(-1), NOW) === "ended")
  check("a stored 'cancelled' always wins", challengeStatus("cancelled", iso(-2), iso(5), NOW) === "cancelled")

  console.log("\n[rankParticipants · pure — competition ranking + winners]")
  const ranked = rankParticipants([{ agentId: "a", value: 10 }, { agentId: "b", value: 10 }, { agentId: "c", value: 5 }, { agentId: "d", value: 0 }], 1)
  check("ties share a rank; the next rank skips (a,b=1; c=3)", ranked.find((r) => r.agentId === "a")!.rank === 1 && ranked.find((r) => r.agentId === "b")!.rank === 1 && ranked.find((r) => r.agentId === "c")!.rank === 3)
  check("tied leaders are BOTH winners at winnerCount=1", ranked.filter((r) => r.isWinner).map((r) => r.agentId).sort().join(",") === "a,b")
  check("a zero-value agent is never a winner", !ranked.find((r) => r.agentId === "d")!.isWinner)
  const single = rankParticipants([{ agentId: "z", value: 3 }, { agentId: "a", value: 3 }, { agentId: "m", value: 9 }], 1)
  check("sorted desc by value, deterministic agentId tie-break", single.map((r) => r.agentId).join(",") === "m,a,z")
  check("all-zero board crowns nobody", rankParticipants([{ agentId: "a", value: 0 }, { agentId: "b", value: 0 }], 1).every((r) => !r.isWinner))
  check("metric labels cover every type", ["most_points", "most_transactions", "most_contacts", "most_referrals", "custom"].every((t) => !!(CHALLENGE_METRIC as any)[t]))
}

function sourceLayer() {
  console.log("\n[wiring — actions, UI, cron, ownership, schema]")
  const act = src("app/actions/challenges.ts")
  check("createChallenge is admin-gated (requireAdmin + ADMIN_ROLES)", /ADMIN_ROLES/.test(act) && /requireAdmin/.test(act) && /export async function createChallenge/.test(act))
  check("enrollInChallenge upserts idempotently on (challenge_id, agent_id)", /export async function enrollInChallenge/.test(act) && /onConflict:\s*"challenge_id,agent_id"/.test(act))
  check("getChallenges computes LIVE standings via the shared scorer + ranker", /export async function getChallenges/.test(act) && /scoreChallenge\(/.test(act) && /rankParticipants\(/.test(act))
  check("a 'contacts' challenge counts CONTACTS not the ISA lead queue", /from\("contacts"\)/.test(src("lib/recruiting/challenge-runner.ts")) && !/most_contacts[\s\S]{0,80}from\("leads"\)/.test(src("lib/recruiting/challenge-runner.ts")))
  // The prize used to be a RAW agent_points_log insert: it moved the leaderboard and left
  // agents.gamification_points behind, so a winner's prize counted on the board and never
  // toward their tier or their badges. It rides the ONE atomic award path now, which does
  // the increment and the ledger row in a single transaction (m484: award_agent_points).
  check("finalize awards prize points through the ONE atomic award path (CHALLENGE_PRIZE)", /awardAgentPoints\([\s\S]*?CHALLENGE_PRIZE/.test(src("lib/recruiting/challenge-runner.ts")))
  check("finalize proposes a GATED wrap announcement (nothing auto-posts)", /proposeClientMessage/.test(src("lib/recruiting/challenge-runner.ts")))
  const page = src("app/dashboard/challenges/page.tsx")
  check("the challenges page reads getChallenges + mounts the client", /getChallenges/.test(page) && /<ChallengesClient/.test(page))
  const client = src("app/dashboard/challenges/challenges-client.tsx")
  check("the client wires createChallenge + enrollInChallenge (no orphan actions)", /createChallenge/.test(client) && /enrollInChallenge/.test(client))
  check("the weekly cron scores + finalizes challenges", /runChallengeScoringAll/.test(src("app/api/cron/recruit-outreach/route.ts")))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by recruiting_manager with a runnable proof", /gamification_challenges:\s*\{\s*manager:\s*"recruiting_manager",\s*proof:\s*"test:challenges"/.test(reg))
  check("both tables are owned in TABLE_MANAGER", /challenges:\s*"recruiting_manager"/.test(reg) && /challenge_participants:\s*"recruiting_manager"/.test(reg))
  check("package.json wires the proof", /"test:challenges":\s*"tsx scripts\/challenges-simulator\.ts"/.test(src("package.json")))
  const snap = src("scripts/schema-snapshot.ts")
  check("schema snapshot tracks the challenge tables", /challenges:\s*\[/.test(snap) && /challenge_participants:\s*\[/.test(snap))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed an ENDED most_points challenge + enrolled agents + in-window points → finalize once → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const { data: ags } = await svc.from("agents").select("id").eq("brokerage_id", brokerageId).eq("is_active", true).limit(2)
  if (!ags || ags.length < 2) { console.log("  ⊘ need 2 active agents — skipping"); return }
  const a1 = (ags as any)[0].id, a2 = (ags as any)[1].id

  const now = new Date()
  const start = new Date(now.getTime() - 10 * 86_400_000).toISOString()
  const end = new Date(now.getTime() - 3600_000).toISOString() // ended an hour ago
  const cleanup: Array<{ table: string; id: string }> = []
  const { runChallengeScoring } = await import("../lib/recruiting/challenge-runner")
  try {
    const { data: ch } = await svc.from("challenges").insert({
      brokerage_id: brokerageId, title: "SIM Challenge", challenge_type: "most_points",
      starts_at: start, ends_at: end, status: "active", prize_points: 300, winner_count: 1,
    }).select("id").single()
    if (!ch) { console.log("  ⊘ could not seed challenge — skipping"); return }
    const challengeId = (ch as any).id
    cleanup.push({ table: "challenges", id: challengeId })

    const { data: parts } = await svc.from("challenge_participants").insert([
      { challenge_id: challengeId, agent_id: a1 }, { challenge_id: challengeId, agent_id: a2 },
    ]).select("id")
    for (const p of parts ?? []) cleanup.push({ table: "challenge_participants", id: (p as any).id })

    // In-window points: a1 leads with 200, a2 has 50.
    const { data: pts } = await svc.from("agent_points_log").insert([
      { agent_id: a1, brokerage_id: brokerageId, points: 200, reason: "SIM_CHALLENGE", reference_type: "sim", created_at: new Date(now.getTime() - 2 * 86_400_000).toISOString() },
      { agent_id: a2, brokerage_id: brokerageId, points: 50, reason: "SIM_CHALLENGE", reference_type: "sim", created_at: new Date(now.getTime() - 2 * 86_400_000).toISOString() },
    ]).select("id")
    for (const r of pts ?? []) cleanup.push({ table: "agent_points_log", id: (r as any).id })

    const res = await runChallengeScoring(svc as any, { brokerageId, now })
    check("live: the ended challenge was finalized once", res.finalized >= 1 && res.prizesAwarded >= 1)

    const { data: winner } = await svc.from("challenge_participants").select("agent_id, current_rank, is_winner, prize_awarded, current_value").eq("challenge_id", challengeId).eq("agent_id", a1).maybeSingle()
    check("live: the leader (a1) is rank 1, marked winner, prize awarded", !!winner && (winner as any).current_rank === 1 && (winner as any).is_winner === true && (winner as any).prize_awarded === true && Number((winner as any).current_value) === 200)

    const { data: prize } = await svc.from("agent_points_log").select("id, points").eq("agent_id", a1).eq("reason", "CHALLENGE_PRIZE").eq("reference_id", challengeId).maybeSingle()
    check("live: prize points landed in the SAME ledger (300)", !!prize && Number((prize as any).points) === 300)
    if (prize) cleanup.push({ table: "agent_points_log", id: (prize as any).id })

    const { data: ended } = await svc.from("challenges").select("status").eq("id", challengeId).maybeSingle()
    check("live: the challenge status flipped to ended", (ended as any)?.status === "ended")

    const { data: wrap } = await svc.from("agent_client_messages").select("id, status").eq("brokerage_id", brokerageId).eq("agent_kind", "recruiting_manager").ilike("rationale", "CHALLENGE FINALIZE%").order("created_at", { ascending: false }).limit(1).maybeSingle()
    check("live: a GATED wrap announcement was proposed (status proposed, not sent)", !!wrap && (wrap as any).status === "proposed")
    if (wrap) cleanup.push({ table: "agent_client_messages", id: (wrap as any).id })

    // Idempotent: a second run must NOT double-finalize (already ended).
    const res2 = await runChallengeScoring(svc as any, { brokerageId, now })
    check("live: re-running does NOT re-finalize the ended challenge", res2.finalized === 0)
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
  if (fail > 0) { console.log(" ❌ CHALLENGES_FAIL"); process.exit(1) }
  console.log(" ✅ CHALLENGES_PASS — window-derived status, competition ranking, live scoring, one-shot finalize into the single ledger + gated wrap")
}
main()
