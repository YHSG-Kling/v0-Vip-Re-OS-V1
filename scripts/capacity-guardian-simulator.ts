#!/usr/bin/env tsx
/**
 * scripts/capacity-guardian-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves THE CAPACITY GUARDIAN — never drop the ball. It detects when an agent is overloaded
 * (load against the tier ceiling OR alarming follow-up debt) and proposes the team rebalance work
 * BEFORE anything goes stale. Leads count as real load (a lead with no portal still needs the ISA).
 *
 * Layer 1 (pure, always runs): the workload-index + overload-decision matrix.
 * Layer 2 (live, SUPABASE_SERVICE_ROLE_KEY-gated, dryRun): seeds an agent carrying stale follow-up
 *   debt and asserts runCapacityGuardian flags them overloaded with a rebalance count — WITHOUT
 *   writing a signal (dryRun) so it can't pollute production. Seeds reverse-deleted. No mocks.
 *
 * Run: npx tsx scripts/capacity-guardian-simulator.ts   (npm run test:capacity-guardian)
 */
import { computeAgentWorkloadIndex, detectOverload, DEBT_ALARM, type WorkloadSignals } from "../lib/kernel/capacity-guardian"

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
  console.log(" ✅ Capacity Guardian verified — overload caught, rebalance proposed, ball never dropped.")
  console.log(" CAPACITY_GUARDIAN_PASS")
}

const T = { maxLoad: 40 } // solo tier ceiling
const base: WorkloadSignals = { activeContacts: 5, activeLeads: 2, staleContacts: 0, overdueTasks: 0, activeDeals: 1 }

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Capacity Guardian simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · workload index + overload decision]")
  const calm = computeAgentWorkloadIndex(base, T)
  check("light load → low burnout, not overloaded", calm.burnoutRisk === "low" && detectOverload(calm, T).overloaded === false)

  // Over the tier ceiling on headcount alone.
  const heavy = computeAgentWorkloadIndex({ ...base, activeContacts: 36, activeLeads: 4, activeDeals: 4 }, T)
  check("load over the ceiling → high burnout + overloaded", heavy.burnoutRisk === "high" && detectOverload(heavy, T).overloaded === true)
  check("rebalance count brings the agent back under the ceiling", detectOverload(heavy, T).rebalanceCount >= (44 - 40))

  // LEADS COUNT — a lead-heavy agent saturates too.
  const leadHeavy = computeAgentWorkloadIndex({ activeContacts: 2, activeLeads: 36, staleContacts: 0, overdueTasks: 0, activeDeals: 2 }, T)
  check("leads count as real load (lead-heavy agent → high)", leadHeavy.load === 40 && leadHeavy.burnoutRisk === "high")

  // THE DROPPED-BALL SIGNAL: follow-up debt alone trips overload even with light headcount.
  const debt = computeAgentWorkloadIndex({ ...base, staleContacts: DEBT_ALARM, overdueTasks: 0 }, T)
  check("follow-up debt alone → high burnout (ball is already dropping)", debt.burnoutRisk === "high" && detectOverload(debt, T).overloaded === true)
  check("medium band is NOT acted on (no premature rebalance)", computeAgentWorkloadIndex({ ...base, activeContacts: 28 }, T).burnoutRisk === "medium" && detectOverload(computeAgentWorkloadIndex({ ...base, activeContacts: 28 }, T), T).overloaded === false)
  check("drivers are real (no fabrication when calm)", calm.drivers.length === 0)

  console.log("\n[Layer 2 · live (dryRun): a stale-laden agent is flagged overloaded]")
  const hasCreds =
    !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    return report()
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { runCapacityGuardian } = await import("../lib/kernel/capacity-guardian-runner")
  const supabase = createServiceClient()

  const { data: brokerage } = await supabase.from("brokerages").select("id").limit(1).maybeSingle()
  const { data: agent } = brokerage
    ? await supabase.from("agents").select("id").eq("brokerage_id", (brokerage as any).id).limit(1).maybeSingle()
    : { data: null }
  if (!brokerage || !agent) { console.log("  ⏭  Skipped — need a real brokerage + agent."); return report() }
  const brokerageId = (brokerage as any).id
  const agentId = (agent as any).id
  const stamp = Date.now()

  // Seed DEBT_ALARM+1 stale contacts for this agent → follow-up debt trips overload.
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const ids: string[] = []
  for (let i = 0; i < DEBT_ALARM + 1; i++) {
    const { data } = await supabase.from("contacts").insert({
      brokerage_id: brokerageId, agent_id: agentId, first_name: "ZZLoad", last_name: `${stamp}-${i}`,
      email: `zz-load-${stamp}-${i}@example.com`, contact_type: "buyer", source: "test", last_contacted_at: old,
    }).select("id").single()
    if ((data as any)?.id) ids.push((data as any).id)
  }

  try {
    const r = await runCapacityGuardian(brokerageId, { agentIds: [agentId], dryRun: true }, supabase)
    check("the overloaded agent was flagged", r.overloaded >= 1 && r.proposals.some(p => p.agentId === agentId), JSON.stringify(r).slice(0, 160))
    const prop = r.proposals.find(p => p.agentId === agentId)
    check("a rebalance count was recommended (≥1)", (prop?.rebalanceCount ?? 0) >= 1)
    check("dryRun published NO signal (no prod pollution)", prop?.signalId === undefined)
  } finally {
    await supabase.from("contacts").delete().in("id", ids.length ? ids : ["none"])
    const { count } = await supabase.from("contacts").select("id", { count: "exact", head: true }).in("id", ids.length ? ids : ["none"])
    check("cleanup: seed contacts removed (count == 0)", (count ?? 0) === 0)
  }

  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
