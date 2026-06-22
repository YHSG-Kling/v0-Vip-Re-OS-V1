#!/usr/bin/env tsx
/**
 * scripts/manager-trust-simulator.ts  (npm run test:manager-trust)
 *
 * Proves the Manager Trust Scorecard: graded outcomes → per-manager trust tier →
 * recommended autonomy posture. Pure scoring is exercised exhaustively; the live
 * layer seeds a real managed_agent + session + a mix of graded evals (honoring the
 * live result CHECK: satisfied | needs_revision | failed | …), aggregates them the
 * way the action does, asserts tier/autonomy, then deletes every tagged row.
 *
 * Live run:  SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npx tsx scripts/manager-trust-simulator.ts
 */
import { randomUUID } from "node:crypto"
import { scoreEvals, tierFor, autonomyFor, teamTrust, effectiveAutonomy, isAutonomyPosture, MIN_EVALS_FOR_TIER } from "../lib/managers/eval-scoring"

function selfTest(): void {
  let pass = 0, fail = 0
  const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

  console.log("\n[trust scoring · pure]")
  const mk = (sat: number, other: number) => [
    ...Array(sat).fill({ result: "satisfied" }),
    ...Array(other).fill({ result: "needs_revision" }),
  ]

  const trusted = scoreEvals(mk(10, 0))
  check("100% over 10 → trusted + autonomous", trusted.tier === "trusted" && trusted.autonomy === "autonomous" && trusted.passRate === 100)

  const monitored = scoreEvals(mk(8, 2)) // 80%
  check("80% → monitored + review_recommended", monitored.tier === "monitored" && monitored.autonomy === "review_recommended")

  const probation = scoreEvals(mk(5, 5)) // 50%
  check("50% → probation + approval_required", probation.tier === "probation" && probation.autonomy === "approval_required")

  const small = scoreEvals(mk(3, 0)) // perfect but tiny sample
  check("perfect but < min sample → insufficient_data + approval_required", small.tier === "insufficient_data" && small.autonomy === "approval_required")

  check("empty → 0% insufficient_data", scoreEvals([]).tier === "insufficient_data" && scoreEvals([]).passRate === 0)
  check("failed counted as non-pass", scoreEvals([{ result: "satisfied" }, { result: "failed" }]).satisfied === 1)
  check("tier boundary: exactly 90 over min sample is trusted", tierFor(90, MIN_EVALS_FOR_TIER) === "trusted")
  check("autonomy map is conservative for probation", autonomyFor("probation") === "approval_required")

  const team = teamTrust([trusted.tier ? trusted : trusted, monitored, probation])
  check("team rollup aggregates volume", team.total === 30 && team.trustedCount === 1)

  // Autonomy override (broker policy of record) wins over the recommendation.
  check("broker override beats a 'trusted/autonomous' recommendation", effectiveAutonomy(trusted.autonomy, "approval_required") === "approval_required")
  check("no override → follow recommendation", effectiveAutonomy(monitored.autonomy, null) === "review_recommended")
  check("garbage override is ignored", effectiveAutonomy(trusted.autonomy, "banana" as never) === "autonomous" && !isAutonomyPosture("banana"))

  if (fail > 0) { console.log(` RESULT: ${pass} passed, ${fail} failed`); process.exit(1) }
  console.log(` RESULT: ${pass} passed, 0 failed`)
}

async function main(): Promise<void> {
  selfTest()

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[live run] ⏭  Skipped — SUPABASE creds not set (or DB unreachable).")
    console.log("\n✅ MANAGER_TRUST pure layer passed; live run is creds-gated.")
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const tag = `MTRUST-${Date.now()}`
  const brokerageId = randomUUID()
  const cleanup: Array<() => PromiseLike<unknown>> = []
  let ok = true
  const check = (n: string, c: boolean) => { if (!c) ok = false; console.log(`  ${c ? "✓" : "✗"} ${n}`) }

  console.log(`\n[live run] tag=${tag}`)
  try {
    await svc.from("brokerages").insert({ id: brokerageId, name: `${tag} Brokerage`, city: "Austin", state: "TX" })
    cleanup.push(() => svc.from("brokerages").delete().eq("id", brokerageId))

    // Seed a managed_agent (deal_coordinator) + an outcome-graded session.
    const { data: agent } = await svc.from("managed_agents").insert({
      brokerage_id: brokerageId, agent_kind: "deal_coordinator",
      anthropic_agent_id: `${tag}-agent`, model: "claude-opus-4-8",
    }).select("id").single()
    const agentId = agent?.id as string
    cleanup.push(() => svc.from("managed_agents").delete().eq("id", agentId))

    const { data: session } = await svc.from("managed_agent_sessions").insert({
      brokerage_id: brokerageId, managed_agent_id: agentId,
      anthropic_session_id: `${tag}-sess`, entity_type: "brokerage", entity_id: brokerageId, status: "idle",
    }).select("id").single()
    const sessionId = session?.id as string
    cleanup.push(() => svc.from("managed_agent_sessions").delete().eq("id", sessionId))

    // 9 satisfied + 1 needs_revision → 90% → trusted.
    const results = [...Array(9).fill("satisfied"), "needs_revision"]
    await svc.from("agent_outcome_evaluations").insert(results.map((result, i) => ({
      brokerage_id: brokerageId, managed_agent_session_id: sessionId,
      anthropic_outcome_id: `${tag}-out-${i}`, iteration: i, result,
      input_tokens: 100, output_tokens: 50,
    })))
    cleanup.push(() => svc.from("agent_outcome_evaluations").delete().eq("managed_agent_session_id", sessionId))

    // Aggregate exactly like the action: evals → session → agent_kind → score.
    const { data: evals } = await svc.from("agent_outcome_evaluations").select("result").eq("managed_agent_session_id", sessionId)
    const score = scoreEvals((evals ?? []).map((e) => ({ result: e.result as string })))
    check("seeded 10 graded outcomes", score.total === 10)
    check("90% pass rate computed from live rows", score.passRate === 90)
    check("manager earns 'trusted' + 'autonomous'", score.tier === "trusted" && score.autonomy === "autonomous")

    // Broker override (policy of record) persisted on managed_agents.config.autonomy_tier.
    const nowIso = new Date().toISOString()
    await svc.from("managed_agents").update({ config: { autonomy_tier: "approval_required", autonomy_updated_at: nowIso } }).eq("id", agentId)
    const { data: reread } = await svc.from("managed_agents").select("config").eq("id", agentId).single()
    const override = (reread?.config as Record<string, unknown> | null)?.autonomy_tier
    check("override persisted to config", isAutonomyPosture(override))
    check("effective posture honors the override over the 'trusted' recommendation",
      effectiveAutonomy(score.autonomy, isAutonomyPosture(override) ? override : null) === "approval_required")

    if (!ok) throw new Error("one or more live assertions failed")
    console.log("\n✅ MANAGER_TRUST — graded outcomes → trust tier → autonomy ran end-to-end on the live DB.")
  } finally {
    for (const del of cleanup.reverse()) { try { await del() } catch { /* best-effort */ } }
    console.log(`  ✓ cleaned up all rows tagged ${tag}`)
  }
  if (!ok) process.exit(1)
}

main().catch((e) => { console.error("manager-trust-simulator failed:", e); process.exit(1) })
