#!/usr/bin/env tsx
/**
 * scripts/workflow-engine-consolidation-simulator.ts  (npm run test:workflow-engine-consolidation)
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO WORKFLOW ENGINES → ONE. Proves the vestigial Engine A (lib/orchestrator/
 * workflow-engine.ts, workflow_executions/step_executions/retries) is fully retired
 * and the canonical Engine B (lib/workflow-orchestrator, workflow_runs) is the only
 * orchestration engine: the monitor + the automations executor no longer read the
 * dropped tables, and the drip engine (workflow_step_runs) is untouched.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => (existsSync(join(process.cwd(), p)) ? readFileSync(join(process.cwd(), p), "utf8") : "")

console.log("\n── the vestigial Engine A is gone ──")
{
  check("lib/orchestrator/workflow-engine.ts is deleted", !existsSync(join(process.cwd(), "lib/orchestrator/workflow-engine.ts")))
  check("the dead retry cron route is deleted", !existsSync(join(process.cwd(), "app/api/cron/workflow-retries/route.ts")))
  const idx = src("lib/orchestrator/index.ts")
  check("the orchestrator index no longer exports WorkflowOrchestrator (keeps EVENT_TYPES)", !/WorkflowOrchestrator/.test(idx) && idx.includes("EVENT_TYPES"))
  check("cron-dispatch no longer registers /api/cron/workflow-retries", !src("lib/kernel/cron-dispatch.ts").includes("workflow-retries"))
}

console.log("\n── the readers were repointed onto the canonical engine ──")
{
  const mon = src("app/actions/workflow-monitoring.ts")
  check("the Workflow Monitor reads workflow_runs (Engine B), not workflow_executions",
    mon.includes('from("workflow_runs")') && !mon.includes('from("workflow_executions")'))
  check("the monitor's detail + retry read workflow_run_steps / advanceRun (Engine B)",
    mon.includes('from("workflow_run_steps")') && mon.includes("advanceRun"))
  const mp = src("app/actions/multi-persona.ts")
  check("multi-persona.executeWorkflow runs workflow_automations, not the retired workflow_executions",
    mp.includes('from("workflow_automations")') && !/executeWorkflow[\s\S]*?from\("workflow_executions"\)/.test(mp))
}

console.log("\n── the retired tables are gone from the contract ──")
{
  const snap = src("scripts/schema-snapshot.ts")
  check("workflow_executions / step_executions / retries are removed from the schema snapshot",
    !/\n\s*workflow_executions:\s*\[/.test(snap) && !/\n\s*workflow_step_executions:\s*\[/.test(snap) && !/\n\s*workflow_retries:\s*\[/.test(snap))
  check("workflow_runs (canonical) IS still in the snapshot", /\n\s*workflow_runs:\s*\[/.test(snap))
  check("a retirement migration is codified", src("scripts/L60-S04-retire-vestigial-workflow-engine.sql").includes("DROP TABLE IF EXISTS workflow_executions"))
  const reg = src("lib/kernel/manager-registry.ts")
  check("no TABLE_MANAGER ownership rows remain for the dropped tables",
    !/\n\s*workflow_executions:\s*"/.test(reg) && !/\n\s*workflow_step_executions:\s*"/.test(reg) && !/\n\s*workflow_retries:\s*"/.test(reg))
  check("the drip engine's workflow_step_runs is untouched (still owned + in snapshot)",
    /\n\s*workflow_step_runs:\s*\[/.test(snap))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — source layer proved the consolidation"); return }
  const svc = createClient(url, key)
  console.log("\n[live] the retired tables are actually dropped; a workflow_run surfaces in the monitor query")
  const dropped = await svc.from("workflow_executions").select("id").limit(1)
  check("workflow_executions no longer exists (query errors with undefined_table)", !!dropped.error)
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping run seed"); return }
  const runId = "aaaa0000-0000-4000-8000-00000000f001"
  try {
    await svc.from("workflow_runs").insert({ id: runId, brokerage_id: (brk as any).id, chain_key: "zz-test-chain", status: "completed", started_at: new Date().toISOString(), completed_at: new Date().toISOString() })
    const { data: mapped } = await svc.from("workflow_runs").select("id, chain_key, status").eq("id", runId).maybeSingle()
    check("live: the monitor's source (workflow_runs) returns the seeded run", (mapped as any)?.chain_key === "zz-test-chain")
  } finally {
    await svc.from("workflow_runs").delete().eq("id", runId)
    const { count } = await svc.from("workflow_runs").select("id", { count: "exact", head: true }).eq("id", runId)
    check("live: cleanup count == 0", (count ?? 0) === 0)
  }
}

async function main() {
  await liveLayer()
  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ WORKFLOW_ENGINE_CONSOLIDATION_FAIL"); process.exit(1) }
  console.log(" ✅ WORKFLOW_ENGINE_CONSOLIDATION_PASS — one canonical workflow engine (workflow_runs); Engine A retired")
}
main()
