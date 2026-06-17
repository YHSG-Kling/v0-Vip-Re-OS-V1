#!/usr/bin/env tsx
/**
 * scripts/source-reallocation-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the SELF-LEARNING lead-gen loop closes: the source-conversion learner was advisory-only; now a
 * proven money-pit scrape source (trusted ROI below the floor) becomes a HANDLED lead_source_waste
 * signal → the Campaign Orchestrator proposes a one-tap GATED reallocate_lead_sources action → a human
 * approves in the Command Center → the market's enabled_sources is updated (the money-pit turned off).
 * Never acts on thin samples.
 *
 * Layer 1 (pure): the signal is handled + owned; the handler + the reallocate action exist.
 * Layer 2 (live, creds-gated): seed a market + enough leads on a money-pit source, run the scan, assert
 * the gated proposal, approve+execute, assert enabled_sources updated. Reverse-delete; cleanup == 0.
 *
 * Run: npx tsx scripts/source-reallocation-simulator.ts   (npm run test:source-reallocation)
 */
import { signalSpec } from "../lib/kernel/signal-registry"
import { SIGNAL_HANDLERS } from "../lib/kernel/manager-signals"

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
  console.log(" ✅ Lead-source learning loop closed — a money-pit source becomes a one-tap gated reallocation.")
  console.log(" SOURCE_REALLOCATION_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Source-reallocation (self-learning lead-gen) simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[Layer 1 · signal handled + owned + handler registered]")
  const spec = signalSpec("lead_source_waste")
  check("lead_source_waste is HANDLED", spec?.disposition === "handled")
  check("owned by the Campaign Orchestrator", !!spec && spec.consumers.includes("campaign_orchestrator"))
  check("a handler is registered", typeof SIGNAL_HANDLERS["campaign_orchestrator:lead_source_waste"] === "function")

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  console.log("\n[Layer 2 · money-pit source → gated reallocation → approve → applied]")
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { runSourceReallocationScan } = await import("../lib/lead-pipeline/source-conversion-runner")
  const { executeAction } = await import("../lib/agents/marketing-agent-actions")
  const svc = createServiceClient()
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⏭  Skipped — need a brokerage."); return report() }
  const brokerageId = (brk as any).id
  const { data: u } = await svc.from("users").select("id").limit(1).maybeSingle()
  const approverId = (u as any)?.id ?? "00000000-0000-0000-0000-0000000000aa"

  const MONEY_PIT = "zenrows_zillow"
  const cleanup: Array<{ table: string; id: string }> = []
  const leadIds: string[] = []
  let marketId = ""
  try {
    const { data: market } = await svc.from("lead_scraping_markets").insert({
      brokerage_id: brokerageId, city: "ZZ Testville", state: "TX", is_active: true, priority: 99,
      enabled_sources: [MONEY_PIT],
    }).select("id").single()
    marketId = (market as any).id; cleanup.push({ table: "lead_scraping_markets", id: marketId })

    // 10 leads on the money-pit source: real spend, ZERO conversions → trusted ROI of 0 (below floor).
    for (let i = 0; i < 10; i++) {
      const { data: lead } = await svc.from("leads").insert({
        brokerage_id: brokerageId, source: MONEY_PIT, cost_per_record: 12, contact_id: null,
        first_name: "ZZ", last_name: `Pit${i}-${Date.now()}`, lead_stage: "new", is_active: true,
      }).select("id").single()
      if (lead) leadIds.push((lead as any).id)
    }
    check("seeded 10 money-pit leads (trusted sample, no conversions)", leadIds.length === 10)

    const scan = await runSourceReallocationScan(brokerageId, { sinceDays: 365 }, svc)
    check("scan inspected the market + emitted a waste signal", scan.scanned >= 1 && scan.signalled >= 1, JSON.stringify(scan))

    const { data: proposed } = await svc.from("marketing_agent_actions")
      .select("id, status, action_input").eq("brokerage_id", brokerageId)
      .eq("action_type", "reallocate_lead_sources").contains("action_input", { market_id: marketId }).maybeSingle()
    check("proposed a gated reallocate_lead_sources action", !!proposed && (proposed as any).status === "proposed", JSON.stringify(proposed))
    check("recommendation is to turn the money-pit OFF", !!proposed && ((proposed as any).action_input?.disable ?? []).includes(MONEY_PIT), JSON.stringify((proposed as any)?.action_input))
    const actionId = (proposed as any)?.id
    if (actionId) cleanup.push({ table: "marketing_agent_actions", id: actionId })

    if (actionId) {
      const outcome = await executeAction(actionId, approverId)
      check("approve → execute succeeded", outcome.status === "succeeded", JSON.stringify(outcome))
      const { data: after } = await svc.from("lead_scraping_markets").select("enabled_sources").eq("id", marketId).maybeSingle()
      check("market's enabled_sources no longer includes the money-pit", !((after as any)?.enabled_sources ?? []).includes(MONEY_PIT), JSON.stringify(after))
    }
  } finally {
    await svc.from("marketing_agent_actions").delete().eq("brokerage_id", brokerageId).eq("action_type", "reallocate_lead_sources").contains("action_input", { market_id: marketId }).then(() => {}, () => {})
    await svc.from("manager_signals").delete().eq("entity_id", marketId || "none").then(() => {}, () => {})
    for (const id of leadIds) await svc.from("leads").delete().eq("id", id).then(() => {}, () => {})
    for (const c of [...cleanup].reverse()) await svc.from(c.table).delete().eq("id", c.id).then(() => {}, () => {})
    const { count } = await svc.from("lead_scraping_markets").select("id", { count: "exact", head: true }).eq("id", marketId || "none")
    check("cleanup: seeded market removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
