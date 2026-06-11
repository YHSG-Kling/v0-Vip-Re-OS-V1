#!/usr/bin/env tsx
/**
 * scripts/recruiter-agent-management-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * RECRUITER AGENT-MANAGEMENT harness — looping the Recruiting Manager into the
 * brokerage's agent-management plays via the inter-manager signal bus. Two signals,
 * both from the Commission & Cap Forecaster (Deal Coordinator owns the forecast):
 *   1. agent_crushed_cap — a current agent HIT/crossed cap → RECRUITING PROOF.
 *   2. agent_stalling    — real pipeline but projected to badly miss, or zero
 *                          production with a thin pipeline → COACHING prompt.
 *
 * Layer 1 (pure, always runs): classifyAgentForRecruiting — the crushing/stalling
 *   boundary logic from the ALREADY-COMPUTED capStatus/forecast/closedYtd:
 *     · post-cap (isCapped)                              → 'crushed'
 *     · real pipeline + big projected goal miss          → 'stalling'
 *     · real pipeline + low cap progress, well into year → 'stalling'
 *     · zero closed YTD + thin pipeline                  → 'stalling'
 *     · healthy mid-progress / nothing real to say       → null
 *   No fabrication — only the real numbers decide; conservative on purpose.
 *
 * Layer 2 (live, creds-gated): seed an agent whose CLOSED-YTD GCI crosses a known
 *   cap (→ 'crushed'), run runCommissionForecaster, assert a manager_signals row was
 *   emitted to recruiting_manager (signal_type 'agent_crushed_cap', from deal_coordinator),
 *   then CLEAN UP every seeded row in reverse order and verify cleanup == 0.
 *
 * Run: npx tsx scripts/recruiter-agent-management-simulator.ts  (npm run test:recruiter-agent-mgmt)
 */
import {
  classifyAgentForRecruiting,
  forecastGci,
  capDistance,
  STALL_GOAL_MISS_FRACTION,
  STALL_CAP_PROGRESS,
  STALL_THIN_PIPELINE,
  type PipelineDeal,
} from "../lib/kernel/commission-forecaster"

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
  console.log(" ✅ Recruiter agent-management verified — crushing/stalling classification + recruiting bus signal")
}

const deal = (over: Partial<PipelineDeal>): PipelineDeal => ({
  id: over.id ?? "d", name: over.name ?? "Deal", estimatedCommission: over.estimatedCommission ?? 0,
  winProbability: over.winProbability ?? 0.5, stage: over.stage ?? "UNDER_CONTRACT",
  expectedCloseDate: over.expectedCloseDate ?? null,
})

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Recruiter agent-management simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · crushing / stalling classification boundaries]")

  // Mid-year reference point: ~44% through 2026 (deterministic yearElapsed ≥ 0.4).
  const now = new Date(Date.UTC(2026, 5, 11))

  // ── CRUSHED — post-cap. A capped agent is recruiting proof regardless of pipeline. ──
  {
    const cap = capDistance(110_000, 100_000) // gci ≥ cap → isCapped
    const f = forecastGci(110_000, [deal({ estimatedCommission: 20_000, winProbability: 0.9, stage: "CLOSING_PREP" })], now, 150_000)
    check("post-cap agent → 'crushed'", classifyAgentForRecruiting(cap, f, 110_000) === "crushed", String(cap.isCapped))
  }
  {
    // Exactly AT cap is still capped (gci ≥ cap).
    const cap = capDistance(100_000, 100_000)
    const f = forecastGci(100_000, [], now, null)
    check("exactly at cap → 'crushed'", classifyAgentForRecruiting(cap, f, 100_000) === "crushed")
  }

  // ── STALLING (a) — real pipeline but projected to BADLY miss a real goal. ──
  {
    // goal 200k; closed 10k + weighted pipeline 20k → projected 30k; vsGoal -170k ≤ -(0.4×200k=-80k).
    const pipeline = [deal({ id: "p", estimatedCommission: 40_000, winProbability: 0.5, stage: "UNDER_CONTRACT" })]
    const f = forecastGci(10_000, pipeline, now, 200_000)
    const cap = capDistance(10_000, null) // cap unconfigured → not capped
    check("real pipeline + big projected goal miss → 'stalling'", classifyAgentForRecruiting(cap, f, 10_000) === "stalling",
      `vsGoal=${f.projectedVsGoal} threshold=${-(STALL_GOAL_MISS_FRACTION * 200_000)}`)
  }

  // ── STALLING (b) — cap configured, well into the year, cap progress very low. ──
  {
    // cap 200k; gci 10k → progress 0.05 ≤ 0.25, yearElapsed ≥ 0.4, real pipeline present.
    const cap = capDistance(10_000, 200_000)
    const f = forecastGci(10_000, [deal({ estimatedCommission: 20_000, winProbability: 0.5, stage: "UNDER_CONTRACT" })], now, null)
    check("cap configured + low progress deep in year → 'stalling'", classifyAgentForRecruiting(cap, f, 10_000) === "stalling",
      `progress=${cap.progress} elapsed=${f.yearElapsed} thresh=${STALL_CAP_PROGRESS}`)
  }

  // ── STALLING (c) — zero closed YTD + only a THIN pipeline (≤ $5k weighted). ──
  {
    // weighted = 4000 × 0.5 = 2000 ≤ 5000, closed 0 → at risk of a no-production year.
    const pipeline = [deal({ id: "thin", estimatedCommission: 4_000, winProbability: 0.5, stage: "UNDER_CONTRACT" })]
    const f = forecastGci(0, pipeline, now, null)
    const cap = capDistance(0, null)
    check("zero closed + thin pipeline → 'stalling'", classifyAgentForRecruiting(cap, f, 0) === "stalling",
      `weighted=${f.weightedPipeline} thresh=${STALL_THIN_PIPELINE}`)
  }

  // ── NULL — healthy mid-progress: good cap progress, on/near a real goal. ──
  {
    // cap 100k; gci 60k → progress 0.6 (> 0.25, not capped); goal 100k, projected 93k (vsGoal -7k,
    // a small miss well above the -40k stall threshold) → the healthy middle.
    const pipeline = [
      deal({ id: "a", estimatedCommission: 20_000, winProbability: 0.9, stage: "CLOSING_PREP" }),
      deal({ id: "b", estimatedCommission: 30_000, winProbability: 0.5, stage: "UNDER_CONTRACT" }),
    ]
    const f = forecastGci(60_000, pipeline, now, 100_000)
    const cap = capDistance(60_000, 100_000)
    check("healthy mid-progress → null (not crushed, not stalling)", classifyAgentForRecruiting(cap, f, 60_000) === null,
      `progress=${cap.progress} vsGoal=${f.projectedVsGoal}`)
  }

  // ── NULL — zero everything: no production, no pipeline → nothing real to say. ──
  {
    const f = forecastGci(0, [], now, null)
    const cap = capDistance(0, null)
    check("zero everything → null (silent, no fabrication)", classifyAgentForRecruiting(cap, f, 0) === null)
  }

  // ── NULL — a stalling-shaped goal miss but NO real pipeline never fires (a) ──
  {
    // closed 10k, no pipeline, goal 200k → projected 10k. Big miss BUT no real pipeline,
    // cap unconfigured, closed > 0 → none of (a)/(b)/(c) apply → null (conservative).
    const f = forecastGci(10_000, [], now, 200_000)
    const cap = capDistance(10_000, null)
    check("big goal miss but NO pipeline + cap unconfigured → null (conservative)", classifyAgentForRecruiting(cap, f, 10_000) === null,
      `weighted=${f.weightedPipeline} vsGoal=${f.projectedVsGoal}`)
  }

  // ── Crushed wins over stalling — a capped agent is NEVER stalling. ──
  {
    // Capped AND a thin pipeline (which would otherwise trip (c) if closed were 0) — but isCapped
    // short-circuits to 'crushed'.
    const cap = capDistance(105_000, 100_000)
    const f = forecastGci(105_000, [deal({ estimatedCommission: 2_000, winProbability: 0.5 })], now, 300_000)
    check("capped + would-be-stalling signals → 'crushed' wins", classifyAgentForRecruiting(cap, f, 105_000) === "crushed")
  }

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live recruiting bus signal]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  console.log("\n[Layer 2 · live recruiting bus signal — agent crushes cap]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const { runCommissionForecaster } = await import("../lib/kernel/commission-forecaster")
  const svc = createServiceClient()
  const TAG = `__ramsim_${Date.now()}__`
  const now2 = new Date()
  const cleanup: Array<{ table: string; id: string }> = []
  let agentId: string | null = null
  let savedCap: number | null | undefined

  try {
    const { data: agent } = await svc.from("agents").select("id, brokerage_id, cap_amount")
      .not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id
    agentId = (agent as any).id
    savedCap = (agent as any).cap_amount

    // Configure a LOW cap so the seeded closed GCI crosses it → 'crushed' deterministically.
    await svc.from("agents").update({ cap_amount: 50_000 }).eq("id", agentId)

    const { data: con } = await svc.from("contacts").select("id").eq("brokerage_id", brokerageId).limit(1).maybeSingle()
    const contactId = (con as any)?.id ?? null

    // Closed-YTD GCI = 40000 + 30000 = 70000 ≥ 50000 cap → post-cap → 'crushed'.
    for (const amt of [40_000, 30_000]) {
      const { data: t } = await svc.from("transactions").insert({
        brokerage_id: brokerageId, agent_id: agentId, contact_id: contactId,
        deal_name: `${TAG} closed ${amt}`, deal_type: "buyer", status: "closed", stage: "CLOSED",
        property_address: `${TAG} ${amt} Crushed Ave`, commission_amount: amt,
        close_date: new Date().toISOString().slice(0, 10),
      }).select("id").single()
      cleanup.push({ table: "transactions", id: (t as any).id })
    }

    // One IN-PROGRESS deal so there's a representative push entity for the gated brief.
    {
      const { data: t } = await svc.from("transactions").insert({
        brokerage_id: brokerageId, agent_id: agentId, contact_id: contactId,
        deal_name: `${TAG} pipe 20000`, deal_type: "buyer", status: "under_contract", stage: "CLOSING_PREP",
        property_address: `${TAG} 20000 Pipe Ave`, estimated_commission: 20_000, win_probability: 0.9,
      }).select("id").single()
      cleanup.push({ table: "transactions", id: (t as any).id })
    }

    // Run the forecaster (no-op synthesizer → text path, no TTS spend).
    const r = await runCommissionForecaster(brokerageId, { now: now2, synthesizer: async () => null }, svc)
    check("run: at least one forecast proposed", r.forecastsProposed >= 1, JSON.stringify({ ...r, errors: r.errors.slice(0, 3) }))
    check("run: a recruiting-proof signal was emitted (agent crushed cap)", r.recruitingProofSignals >= 1,
      JSON.stringify({ proof: r.recruitingProofSignals, coaching: r.coachingSignals, errors: r.errors.slice(0, 3) }))
    check("run: no fatal errors", r.errors.length === 0, r.errors.slice(0, 3).join(" | "))

    // The gated agent-facing forecast proposal (so we can clean it up too).
    const { data: msg } = await svc.from("agent_client_messages")
      .select("id").eq("brokerage_id", brokerageId).eq("agent_kind", "deal_coordinator")
      .ilike("rationale", `%agent:${agentId}%`).order("created_at", { ascending: false }).limit(1).maybeSingle()
    if (msg) cleanup.push({ table: "agent_client_messages", id: (msg as any).id })

    // Assert the manager_signals row: deal_coordinator → recruiting_manager, agent_crushed_cap,
    // entity = the agent, with the supporting numbers in the payload.
    const { data: sig } = await svc.from("manager_signals")
      .select("id, from_manager, to_manager, signal_type, entity_type, entity_id, status, payload, message")
      .eq("brokerage_id", brokerageId).eq("to_manager", "recruiting_manager")
      .eq("signal_type", "agent_crushed_cap").eq("entity_id", agentId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle()
    if (sig) cleanup.push({ table: "manager_signals", id: (sig as any).id })

    check("bus: signal emitted to recruiting_manager (agent_crushed_cap)", !!sig)
    check("bus: from deal_coordinator (owns the forecast domain)", (sig as any)?.from_manager === "deal_coordinator")
    check("bus: entity is the agent (stable dedupe key)", (sig as any)?.entity_type === "agent" && (sig as any)?.entity_id === agentId)
    check("bus: status open (handler decides the action; nothing autonomous to the agent)", (sig as any)?.status === "open")
    check("bus: payload carries agent_id + the supporting cap/production numbers",
      (sig as any)?.payload?.agent_id === agentId && Number((sig as any)?.payload?.cap) === 50_000 && Number((sig as any)?.payload?.closed_ytd) >= 70_000,
      JSON.stringify((sig as any)?.payload))

    // Idempotency — a second run in the same week emits no NEW signal (bus dedupes on the
    // open (recruiting_manager, agent_crushed_cap, agent) tuple).
    await runCommissionForecaster(brokerageId, { now: now2, synthesizer: async () => null }, svc)
    const { count: sigCount } = await svc.from("manager_signals").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("to_manager", "recruiting_manager")
      .eq("signal_type", "agent_crushed_cap").eq("entity_id", agentId).eq("status", "open")
    check("idempotent: at most one OPEN crushed-cap signal per agent (bus dedupe)", (sigCount ?? 0) === 1, `count=${sigCount}`)
  } finally {
    // Restore the agent's original cap.
    if (agentId) { try { await svc.from("agents").update({ cap_amount: savedCap ?? null }).eq("id", agentId) } catch { /* noop */ } }
    // Delete every seeded row in reverse order.
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count: txnLeft } = await svc.from("transactions").select("id", { count: "exact", head: true }).like("property_address", `${TAG}%`)
    check("cleanup verified — 0 seeded transactions remain", (txnLeft ?? 0) === 0)
    const { count: sigLeft } = agentId
      ? await svc.from("manager_signals").select("id", { count: "exact", head: true })
          .eq("to_manager", "recruiting_manager").eq("signal_type", "agent_crushed_cap").eq("entity_id", agentId)
      : { count: 0 }
    check("cleanup verified — 0 seeded recruiting signals remain", (sigLeft ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
