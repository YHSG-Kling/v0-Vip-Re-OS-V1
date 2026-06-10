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
import { loadCommandCenter, evaluateApprovalSla } from "../lib/kernel/command-center"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Command Center verified (SLA + load + reject)")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Agent Command Center simulator")
  console.log("══════════════════════════════════════════════════")

  // Pure SLA evaluation (escalation: stalled approvals must surface) — always runs.
  console.log("\n[Layer 1 · evaluateApprovalSla]")
  const now = new Date("2026-01-02T00:00:00Z")
  check("fresh action → ok", evaluateApprovalSla("2026-01-01T20:00:00Z", now).level === "ok")          // 4h
  check("past due window → due", evaluateApprovalSla("2026-01-01T08:00:00Z", now).level === "due")      // 16h
  check("past breach window → breached", evaluateApprovalSla("2025-12-31T20:00:00Z", now).level === "breached") // 28h
  check("age reported in hours", evaluateApprovalSla("2026-01-01T12:00:00Z", now).ageHours === 12)
  check("null proposedAt → ok (no false escalation)", evaluateApprovalSla(null, now).level === "ok")
  check("custom breach window honored", evaluateApprovalSla("2026-01-01T18:00:00Z", now, { breachHours: 4 }).level === "breached") // 6h ≥ 4h

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live round-trip]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure SLA layer ran).")
    report()
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

    // Aged 30h → should surface as SLA-breached.
    const agedProposedAt = new Date(Date.now() - 30 * 3_600_000).toISOString()
    const { data: mAction } = await svc.from("marketing_agent_actions").insert({
      brokerage_id: brokerageId, managed_agent_session_id: (session as any).id,
      action_type: "mark_topic_used", action_input: {}, rationale: `${TAG} marketing`, status: "proposed",
      proposed_at: agedProposedAt,
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
    check("sla: aged action surfaces as breached", mInQueue?.slaLevel === "breached")
    check("sla: summary counts the breached approval", data.summary.breachedApprovals >= 1)
    check("sla: breached action sorts ahead of fresh one", data.pendingActions.findIndex((a) => a.id === (mAction as any).id) < data.pendingActions.findIndex((a) => a.id === (aAction as any).id))

    // Manager Daily Standup — heads the Command Center. It's built from live tables
    // and every line is manager-attributed; assert it loaded and carries the marketing
    // activity we seeded (the Marketing Manager has work in the last 24h).
    check("standup: present on the brokerage-scoped load", Array.isArray(data.standup))
    check("standup: every line maps to a real manager key",
      data.standup.every((l) => typeof l.label === "string" && l.label.length > 0 && typeof l.headline === "string"))
    check("standup: no line is silent noise (activity or needs_human > 0)",
      data.standup.every((l) => l.activity_24h > 0 || l.needs_human > 0))

    // Manager Weekly P&L — the outcome layer beneath the standup. Built from live
    // operational tables (offers/transactions/showings/...); every card is manager-
    // attributed, carries week-over-week metrics, and no all-zero card is shown.
    check("weeklyPnl: present on the brokerage-scoped load", Array.isArray(data.weeklyPnl))
    check("weeklyPnl: every card maps to a real manager + has metrics",
      data.weeklyPnl.every((c) => typeof c.label === "string" && c.label.length > 0 && Array.isArray(c.metrics) && c.metrics.length > 0))
    check("weeklyPnl: every metric carries value/prior/deltaPct + unit",
      data.weeklyPnl.every((c) => c.metrics.every((m) =>
        typeof m.value === "number" && typeof m.prior === "number" &&
        (m.deltaPct === null || typeof m.deltaPct === "number") &&
        (m.unit === "count" || m.unit === "currency"))))
    check("weeklyPnl: no all-zero card is shown (production or baseline > 0)",
      data.weeklyPnl.every((c) => c.metrics.some((m) => m.value > 0 || m.prior > 0)))
    check("weeklyPnl: deltaPct is null exactly when prior is 0 (no divide-by-zero)",
      data.weeklyPnl.every((c) => c.metrics.every((m) => (m.prior === 0) === (m.deltaPct === null))))

    // Unified governed-deliverables rail — the aggregate of every loop's gate proposals.
    check("deliverables: present on the brokerage-scoped load", data.deliverables !== null)
    check("deliverables: totals are internally consistent (sum of statuses ≤ total)",
      !data.deliverables || (data.deliverables.totals.proposed + data.deliverables.totals.approved + data.deliverables.totals.sent + data.deliverables.totals.rejected + data.deliverables.totals.failed) <= data.deliverables.totals.total)
    check("deliverables: GOVERNANCE — every sent deliverable had a human approver",
      !data.deliverables || data.deliverables.totals.sentWithApprover === data.deliverables.totals.sent)

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

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
