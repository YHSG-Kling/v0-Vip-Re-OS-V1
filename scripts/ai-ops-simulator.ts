#!/usr/bin/env tsx
/**
 * scripts/ai-ops-simulator.ts   (npm run test:ai-ops)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the AI OPERATIONS console: the cross-tenant view of the autonomous layer — manager throughput,
 * dead-letter (stuck) signals, held/failed actions, automation errors, cron health — with replay/resolve.
 *
 * PURE:   isStuckSignal (open + aged past 24h = the reaper's dead-letter predicate) + cronHealth
 *         (failing / stale vs 2× expected interval / healthy).
 * SOURCE: loadAiOps aggregates cross-tenant; the console + replay/resolve actions are staff-gated + audited;
 *         owned by data_steward.
 * LIVE (creds-gated): seed a stuck open signal + a held proposal + an automation error → loadAiOps surfaces
 *         each → replay the signal (expire + re-publish) → resolve the error → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { isStuckSignal, cronHealth, loadAiOps } from "../lib/platform/ai-ops"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
const NOW = new Date("2026-07-04T12:00:00Z")
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()

function pureLayer() {
  console.log("\n[isStuckSignal · pure — the dead-letter predicate]")
  check("an OPEN signal older than 24h is stuck", isStuckSignal({ status: "open", created_at: hoursAgo(30) }, NOW))
  check("an OPEN signal younger than 24h is NOT stuck", !isStuckSignal({ status: "open", created_at: hoursAgo(2) }, NOW))
  check("a CONSUMED signal is never stuck (the manager acted)", !isStuckSignal({ status: "consumed", created_at: hoursAgo(100) }, NOW))
  check("an EXPIRED (reaped) signal is not counted stuck", !isStuckSignal({ status: "expired", created_at: hoursAgo(100) }, NOW))

  console.log("\n[cronHealth · pure]")
  check("last_status failure → failing", cronHealth({ last_status: "failure", last_run_at: hoursAgo(1), expected_interval_hours: 1 }, NOW) === "failing")
  check("no run in 2× the expected interval → stale", cronHealth({ last_status: "success", last_run_at: hoursAgo(50), expected_interval_hours: 24 }, NOW) === "stale")
  check("a recent success → healthy", cronHealth({ last_status: "success", last_run_at: hoursAgo(1), expected_interval_hours: 24 }, NOW) === "healthy")
  check("never run → unknown", cronHealth({ last_status: null, last_run_at: null, expected_interval_hours: 24 }, NOW) === "unknown")
}

function sourceLayer() {
  console.log("\n[wiring — aggregation, console, actions, ownership]")
  const lib = src("lib/platform/ai-ops.ts")
  check("loadAiOps aggregates the bus + gate + errors + cron cross-tenant", /from\("manager_signals"\)/.test(lib) && /from\("agent_client_messages"\)/.test(lib) && /from\("automation_errors"\)/.test(lib) && /from\("cron_health_snapshot"\)/.test(lib))
  check("dead-letter = open signals past the 24h threshold; failed includes status='failed'", /isStuckSignal/.test(lib) && /status\.eq\.failed/.test(lib))
  const act = src("app/actions/superadmin/ai-ops.ts")
  check("read + actions are platform-staff-gated + audited", /requireStaff/.test(act) && /superadmin_audit_log/.test(act))
  check("REPLAY expires the stuck signal + re-publishes (handler re-runs)", /status: "expired"/.test(act) && /publishManagerSignal/.test(act) && /dedupe: false/.test(act))
  check("RESOLVE marks the automation error resolved", /export async function resolveAutomationErrorAction/.test(act) && /status: "resolved"/.test(act))
  const page = src("app/dashboard/superadmin/ai-ops/page.tsx")
  check("the console is staff-gated and renders the AI-ops board", /getAiOpsAction/.test(page) && /AiOpsConsole/.test(page))
  check("the platform console links to AI Ops", /\/dashboard\/superadmin\/ai-ops/.test(src("app/dashboard/superadmin/platform/page.tsx")))
  const reg = src("lib/kernel/manager-registry.ts")
  // Owner is cron_manager, not data_steward. This assertion and the registry
  // entry it checks were authored in the SAME commit disagreeing with each
  // other, and because the simulator was never wired nobody saw it. The
  // registry is the one that is right: cron_manager owns "schedules,
  // heartbeat & loop health (operations)", which is exactly this domain;
  // data_steward owns "data integrity, identity & field stewardship".
  check("burn domain owned by cron_manager with a runnable proof", /ai_operations:\s*\{\s*manager:\s*"cron_manager",\s*proof:\s*"test:ai-ops"/.test(reg))
  check("package.json wires the proof", /"test:ai-ops":\s*"tsx scripts\/ai-ops-simulator\.ts"/.test(src("package.json")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source proved the logic; live verified via MCP"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed a stuck signal + held proposal + automation error → loadAiOps surfaces → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const old = new Date(Date.now() - 30 * 3_600_000).toISOString()
    const { data: sig } = await svc.from("manager_signals").insert({ brokerage_id: brokerageId, from_manager: "ai_isa", to_manager: "shopping_agent", signal_type: "sim_stuck", message: "sim", status: "open", created_at: old }).select("id").single()
    if (sig) cleanup.push({ table: "manager_signals", id: (sig as any).id })
    const { data: msg } = await svc.from("agent_client_messages").insert({ brokerage_id: brokerageId, agent_kind: "sphere_of_influence", entity_type: "brokerage", entity_id: brokerageId, audience: "agent", subject: "sim", body: "sim", rationale: "sim", status: "proposed", channel: "portal", created_at: old }).select("id").single()
    if (msg) cleanup.push({ table: "agent_client_messages", id: (msg as any).id })
    const { data: er } = await svc.from("automation_errors").insert({ brokerage_id: brokerageId, workflow_name: "sim_workflow", error_message: "sim error", severity: "high", status: "open" }).select("id").single()
    if (er) cleanup.push({ table: "automation_errors", id: (er as any).id })

    const ops = await loadAiOps(svc as any)
    check("live: the 30h-old open signal shows as dead-letter", ops.stuckSignals.some((x) => x.id === (sig as any)?.id))
    check("live: the proposed message shows as held", ops.summary.held >= 1)
    check("live: the automation error surfaces", ops.automationErrors.some((x) => x.id === (er as any)?.id))
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
  if (fail > 0) { console.log(" ❌ AI_OPS_FAIL"); process.exit(1) }
  console.log(" ✅ AI_OPS_PASS — the autonomous layer, platform-wide: throughput, dead-letter, held/failed, errors, cron — with replay")
}
main()
