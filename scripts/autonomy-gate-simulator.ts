#!/usr/bin/env tsx
/**
 * scripts/autonomy-gate-simulator.ts  (npm run test:autonomy-gate)
 *
 * Proves the GOVERNED AUTONOMY LOOP — the enforcement link that turns the Manager Trust
 * Scorecard from a dashboard into a control. eval-scoring grades each manager → a posture;
 * the broker can override it (managed_agents.config.autonomy_tier); now dispatch.ts CONSULTS
 * it: a manager on `approval_required` may not send unattended.
 *
 *  - PURE layer (always): autonomyDecision — the exact logic dispatch enforces.
 *      · no managerKey ⇒ allow (transactional/system, never gated)
 *      · humanApproved ⇒ allow (the approval queue already cleared it)
 *      · approval_required + autonomous ⇒ HELD
 *      · autonomous / review_recommended / no-signal ⇒ allow
 *  - LIVE layer (creds-gated, self-cleaning): seeds a throwaway brokerage + a managed_agents
 *      row (ai_isa, autonomy_tier='approval_required'), then proves (a) resolveManagerAutonomy
 *      reads the seeded posture, (b) dispatchEmail HOLDS the autonomous send at the gate
 *      BEFORE any provider is called (providerKey 'autonomy_gate'), (c) the broker override
 *      wins over the eval-derived recommendation, (d) a manager with no row resolves to
 *      no-signal ⇒ allow. Then deletes every tagged row (cleanup count == 0).
 *
 * Live run: SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npx tsx scripts/autonomy-gate-simulator.ts
 */
import { randomUUID } from "node:crypto"
import { autonomyDecision, managerForDispatch } from "../lib/managers/autonomy-gate"

let pass = 0, fail = 0
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

function pureLayer(): void {
  console.log("\n[autonomy decision · pure]")
  check("no managerKey ⇒ allow (transactional/system not gated)",
    autonomyDecision({ effective: "approval_required" }).allow === true)
  check("human-approved ⇒ allow even when approval_required",
    autonomyDecision({ managerKey: "ai_isa", effective: "approval_required", humanApproved: true }).allow === true)
  const held = autonomyDecision({ managerKey: "ai_isa", effective: "approval_required" })
  check("approval_required + autonomous ⇒ HELD", held.allow === false && held.held === true && !!held.reason)
  check("autonomous ⇒ allow", autonomyDecision({ managerKey: "ai_isa", effective: "autonomous" }).allow === true)
  check("review_recommended ⇒ allow (advisory only)", autonomyDecision({ managerKey: "ai_isa", effective: "review_recommended" }).allow === true)
  check("no posture signal (null) ⇒ allow (no day-one regression)", autonomyDecision({ managerKey: "ai_isa", effective: null }).allow === true)

  console.log("\n[manager inference · pure]")
  check("explicit managerKey wins over systemSource", managerForDispatch("listing_concierge", "sequence") === "listing_concierge")
  check("'sequence' ⇒ campaign_orchestrator", managerForDispatch(null, "sequence") === "campaign_orchestrator")
  check("'ai_isa' ⇒ ai_isa", managerForDispatch(null, "ai_isa") === "ai_isa")
  check("'ghost_recovery' ⇒ ai_isa", managerForDispatch(null, "ghost_recovery") === "ai_isa")
  check("human-approved source is NOT a governed autonomous manager", managerForDispatch(null, "agent_client_message") === null)
  check("transactional source ('transaction_notification') ⇒ not gated", managerForDispatch(null, "transaction_notification") === null)
}

async function liveLayer(): Promise<void> {
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[autonomy gate · live]  ⊘ skipped (no SUPABASE creds) — pure layer proved the decision logic")
    return
  }
  console.log("\n[autonomy gate · live — seed posture → resolve + dispatch hold → self-clean]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const { resolveManagerAutonomy, __clearAutonomyCache } = await import("../lib/managers/autonomy-gate")
  const { dispatchEmail } = await import("../lib/providers/dispatch")
  const svc = createServiceClient()

  const tag = `autonomy-sim-${randomUUID().slice(0, 8)}`
  const brokerageId = randomUUID()
  const agentId = randomUUID()

  try {
    await svc.from("brokerages").insert({ id: brokerageId, name: `${tag} (autonomy test)` })
    await svc.from("managed_agents").insert({
      id: agentId, brokerage_id: brokerageId, agent_kind: "ai_isa",
      config: { autonomy_tier: "approval_required", autonomy_set_by: tag },
    })

    __clearAutonomyCache()
    const resolved = await resolveManagerAutonomy(brokerageId, "ai_isa")
    check("resolveManagerAutonomy reads the seeded broker override", resolved === "approval_required")

    // The gate is the FIRST thing in dispatchEmail — an approval_required autonomous send is
    // held and returns BEFORE any provider is called (so this never sends a real email).
    const blocked = await dispatchEmail({
      brokerageId, managerKey: "ai_isa", from: "", to: "noreply@example.com",
      subject: "autonomy gate test", html: "<p>held</p>", systemSource: "autonomy_sim",
    })
    check("dispatchEmail HOLDS the autonomous send at the gate", blocked.success === false && blocked.providerKey === "autonomy_gate")

    // Broker override wins over a (contradicting) eval-derived recommendation.
    await svc.from("managed_agents").update({
      config: { autonomy_tier: "autonomous", autonomy_recommended: "approval_required", autonomy_set_by: tag },
    }).eq("id", agentId)
    __clearAutonomyCache()
    check("broker override ('autonomous') wins over eval recommendation ('approval_required')",
      (await resolveManagerAutonomy(brokerageId, "ai_isa")) === "autonomous")

    // No override → eval-derived recommendation enforced.
    await svc.from("managed_agents").update({ config: { autonomy_recommended: "approval_required", autonomy_set_by: tag } }).eq("id", agentId)
    __clearAutonomyCache()
    check("with no override, the persisted eval-derived posture is what resolves",
      (await resolveManagerAutonomy(brokerageId, "ai_isa")) === "approval_required")

    // A manager with no managed_agents row ⇒ no signal ⇒ allow.
    __clearAutonomyCache()
    check("manager with no row resolves to no-signal (⇒ allow)",
      (await resolveManagerAutonomy(brokerageId, "deal_coordinator")) === null)
  } finally {
    await svc.from("managed_agents").delete().eq("id", agentId)
    await svc.from("brokerages").delete().eq("id", brokerageId)
    const { count } = await svc.from("managed_agents").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId)
    check("cleanup complete — zero tagged rows remain", (count ?? 0) === 0)
  }
}

async function main(): Promise<void> {
  pureLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ AUTONOMY_GATE_FAIL"); process.exit(1) }
  console.log(" ✅ AUTONOMY_GATE_PASS — manager autonomy posture is enforced at the egress")
}

main().catch((e) => { console.error(e); process.exit(1) })
