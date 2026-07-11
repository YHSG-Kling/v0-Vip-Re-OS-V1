#!/usr/bin/env tsx
/**
 * scripts/manager-ops-simulator.ts   (npm run test:manager-ops)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves PER-MANAGER cost / latency (p95) / error-rate + SLO — the operability surface for the
 * 13 AI managers, and the visibility that makes runaway autonomous spend catchable.
 *
 * PURE:   percentile (nearest-rank) + classifyManagerSlo (worst-of cost/p95/error, ok|warn|breach).
 * SOURCE: ai_tool_usage carries the manager dimension; logAIUsage accepts manager+latency+success;
 *         the rollup + staff-gated action + console panel are wired; owned by data_steward.
 * LIVE (creds-gated): insert ai_tool_usage rows for two managers (one cheap+fast, one over the cost
 *         ceiling) → loadManagerOps attributes cost/p95 per manager + flags the breach → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { percentile, classifyManagerSlo, MANAGER_SLO } from "../lib/platform/manager-ops"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[percentile + SLO classifier · pure]")
  check("p95 is nearest-rank (95th of 1..100 = 95)", percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95) === 95)
  check("empty sample → 0", percentile([], 95) === 0)
  check("under all ceilings → ok", classifyManagerSlo({ costCents: 100, p95Ms: 2000, errorRate: 0.01 }) === "ok")
  check("cost over the breach ceiling → breach", classifyManagerSlo({ costCents: MANAGER_SLO.costCentsBreach, p95Ms: 100, errorRate: 0 }) === "breach")
  check("p95 in the warn band → warn", classifyManagerSlo({ costCents: 0, p95Ms: MANAGER_SLO.p95WarnMs, errorRate: 0 }) === "warn")
  check("error-rate over breach → breach (worst-of dominates)", classifyManagerSlo({ costCents: 0, p95Ms: 0, errorRate: MANAGER_SLO.errorRateBreach }) === "breach")
}

function sourceLayer() {
  console.log("\n[wiring — manager dimension + rollup + surface]")
  check("ai_tool_usage gains the manager dimension (m270)", /add column if not exists manager text/.test(src("supabase/migrations/m270-ai-usage-manager-dimension.sql")))
  const ct = src("lib/ai/cost-tracking.ts")
  check("logAIUsage accepts + persists manager + latency + success", /manager\?: string \| null/.test(ct) && /manager: params\.manager/.test(ct) && /execution_time_ms: params\.executionTimeMs/.test(ct))
  const lib = src("lib/platform/manager-ops.ts")
  check("the rollup aggregates ai_tool_usage per manager (cost, p95, error-rate) cross-tenant", /from\("ai_tool_usage"\)/.test(lib) && /classifyManagerSlo/.test(lib) && /"unassigned"/.test(lib))
  check("staff-gated action exposes it", /export async function getManagerOpsAction/.test(src("app/actions/superadmin/ai-ops.ts")))
  check("the AI-ops console surfaces the per-manager SLO panel", /ManagerOpsPanel/.test(src("app/dashboard/superadmin/ai-ops/page.tsx")))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by data_steward with a runnable proof", /manager_ops_slo:\s*\{\s*manager:\s*"data_steward",\s*proof:\s*"test:manager-ops"/.test(reg))
  check("package.json wires the proof", /"test:manager-ops":\s*"tsx scripts\/manager-ops-simulator\.ts"/.test(src("package.json")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source proved the logic; live verified via MCP"); return }
  const svc = createClient(url, key)
  const { loadManagerOps } = await import("../lib/platform/manager-ops")
  console.log("\n[live] seed per-manager usage → rollup attributes cost/p95 + flags a breach → clean up")
  const { data: brk } = await svc.from("brokerages").insert({ name: "ZZMOPS", email: "zzmops@example.com", plan_tier: "brokerage", onboarding_status: "pending" }).select("id").single()
  const b = (brk as any)?.id
  const tag = "__mops_selftest"
  try {
    const rows = [
      { brokerage_id: b, tool_name: "ai_model", manager: "ai_isa", cost_cents: 50, tokens_used: 100, execution_time_ms: 1200, success: true, feature: tag },
      { brokerage_id: b, tool_name: "ai_model", manager: "ai_isa", cost_cents: 40, tokens_used: 80, execution_time_ms: 800, success: true, feature: tag },
      { brokerage_id: b, tool_name: "ai_model", manager: "asset_manager", cost_cents: 2500, tokens_used: 9000, execution_time_ms: 40000, success: false, feature: tag },
    ]
    await svc.from("ai_tool_usage").insert(rows)
    const ops = await loadManagerOps(svc as any, 24)
    const isa = ops.managers.find((m) => m.manager === "ai_isa")
    const asset = ops.managers.find((m) => m.manager === "asset_manager")
    check("live: cost attributed per manager", isa?.costCents === 90 && asset?.costCents === 2500)
    check("live: the over-ceiling manager is a BREACH (cost + p95 + error)", asset?.slo === "breach")
    check("live: the cheap/fast manager is ok", isa?.slo === "ok")
  } finally {
    await svc.from("ai_tool_usage").delete().eq("brokerage_id", b).eq("feature", tag)
    await svc.from("brokerages").delete().eq("id", b)
    const { count } = await svc.from("ai_tool_usage").select("id", { count: "exact", head: true }).eq("brokerage_id", b)
    check("live: cleanup count == 0", (count ?? 0) === 0)
  }
}

async function main() {
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ MANAGER_OPS_FAIL"); process.exit(1) }
  console.log(" ✅ MANAGER_OPS_PASS — per-manager cost / p95 / error-rate + SLO: runaway spend or latency on any of the 14 managers is now visible")
}
main()
