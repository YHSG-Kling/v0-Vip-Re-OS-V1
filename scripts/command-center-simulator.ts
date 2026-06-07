#!/usr/bin/env tsx
/**
 * scripts/command-center-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 39 — Agent Command Center end-to-end harness. Drives the REAL kernel
 * load command (loadCommandCenter) against seeded rows and verifies the
 * approval-queue read + the reject transition, then cleans up every row.
 *
 * Coverage:
 *   · loadCommandCenter returns the seeded manager session (correct agent_kind,
 *     status) and BOTH proposed agent actions (marketing + asset), with the
 *     summary counts.
 *   · Reject contract: a proposed action moved to 'skipped' (the exact mutation
 *     rejectAgentAction performs) drops out of the pending queue on reload.
 *   · The approve contract (executeAction stamps a human approved_by before
 *     executing — no autonomous self-execution) is proven by the
 *     agent-governance simulator + the live MCP round-trip; not re-driven here
 *     because the executors are server-only and run real side-effect handlers.
 *
 * Gated on SUPABASE_SERVICE_ROLE_KEY; skips cleanly without it. Self-cleans.
 *
 * Run:  npx tsx scripts/command-center-simulator.ts   (npm run test:command-center)
 */
import { loadCommandCenter } from "../lib/kernel/command-center"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Agent Command Center simulator")
  console.log("══════════════════════════════════════════════════")

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.")
    console.log("\n RESULT: 0 passed, 0 failed (skipped — no DB credentials)")
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `__cmdsim_${Date.now()}__`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    const { data: usr } = await svc.from("users").select("id").limit(1).single()
    if (!brk || !usr) { console.log("  ⏭  Skipped — need a brokerage + user."); return }
    const brokerageId = (brk as any).id
    const userId = (usr as any).id

    // Seed: manager agent + running session + two proposed actions.
    const { data: agent } = await svc.from("managed_agents").insert({
      brokerage_id: brokerageId, agent_kind: "marketing_agent",
      anthropic_agent_id: `${TAG}agent`, model: "claude-sonnet-4-6",
    }).select("id").single()
    if (!agent) throw new Error("agent seed failed")
    cleanup.push({ table: "managed_agents", id: (agent as any).id })

    const { data: session } = await svc.from("managed_agent_sessions").insert({
      managed_agent_id: (agent as any).id, brokerage_id: brokerageId,
      anthropic_session_id: `${TAG}sess`, entity_type: "brokerage", entity_id: brokerageId, status: "running",
    }).select("id").single()
    if (!session) throw new Error("session seed failed")
    cleanup.push({ table: "managed_agent_sessions", id: (session as any).id })

    const { data: mAction } = await svc.from("marketing_agent_actions").insert({
      brokerage_id: brokerageId, managed_agent_session_id: (session as any).id,
      action_type: "mark_topic_used", action_input: {}, rationale: `${TAG} marketing`, status: "proposed",
    }).select("id").single()
    if (!mAction) throw new Error("marketing action seed failed")
    cleanup.push({ table: "marketing_agent_actions", id: (mAction as any).id })

    const { data: aAction } = await svc.from("asset_manager_actions").insert({
      brokerage_id: brokerageId, managed_agent_session_id: (session as any).id,
      action_type: "flag_asset_for_review", action_input: {}, rationale: `${TAG} asset`, status: "proposed",
    }).select("id").single()
    if (!aAction) throw new Error("asset action seed failed")
    cleanup.push({ table: "asset_manager_actions", id: (aAction as any).id })

    // Drive the REAL load command.
    const data = await loadCommandCenter({ brokerageId, limit: 100 })

    const seededSession = data.sessions.find((s) => s.id === (session as any).id)
    check("load: seeded session present", !!seededSession)
    check("load: session resolves agent_kind via join", seededSession?.agentKind === "marketing_agent")
    check("load: session status running", seededSession?.status === "running")
    check("load: summary counts the running session", data.summary.activeSessions >= 1)

    const ids = new Set(data.pendingActions.map((a) => a.id))
    check("load: marketing proposed action in queue", ids.has((mAction as any).id))
    check("load: asset proposed action in queue", ids.has((aAction as any).id))
    check("load: both queues represented", data.pendingActions.some((a) => a.queue === "marketing") && data.pendingActions.some((a) => a.queue === "asset"))
    check("load: pendingApprovals count covers both", data.summary.pendingApprovals >= 2)
    const mInQueue = data.pendingActions.find((a) => a.id === (mAction as any).id)
    check("load: action carries type + rationale", mInQueue?.actionType === "mark_topic_used" && (mInQueue?.rationale ?? "").includes(TAG))

    // Reject contract — the exact mutation rejectAgentAction performs.
    const { error: rejErr } = await svc.from("marketing_agent_actions")
      .update({ status: "skipped", approved_by: userId, approved_at: new Date().toISOString() })
      .eq("id", (mAction as any).id).eq("status", "proposed")
    check("reject: proposed → skipped succeeds", !rejErr, rejErr?.message)

    const after = await loadCommandCenter({ brokerageId, limit: 100 })
    check("reject: rejected action drops out of pending queue", !after.pendingActions.some((a) => a.id === (mAction as any).id))
    check("reject: asset action still pending (untouched)", after.pendingActions.some((a) => a.id === (aAction as any).id))
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("managed_agents").select("id", { count: "exact", head: true }).like("anthropic_agent_id", `${TAG}%`)
    check("cleanup verified — 0 seeded agents remain", (count ?? 0) === 0)
  }

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Command Center verified end-to-end (load + reject, test rows cleaned up)")
}
main().catch((e) => { console.error(e); process.exit(1) })
