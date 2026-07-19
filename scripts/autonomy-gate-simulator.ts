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

  console.log("\n[per-tenant staff halt · pure — between the god switch and broker posture]")
  const th = { halted: true, reason: "Billing dispute — autonomy paused pending resolution." }
  const heldTenant = autonomyDecision({ managerKey: "ai_isa", effective: "autonomous", tenantHalt: th })
  check("tenant halt HOLDS even when the broker posture is 'autonomous' (tenant cannot out-rank staff)",
    heldTenant.allow === false && heldTenant.held === true && heldTenant.reason === th.reason)
  check("human-approved ⇒ allow even under a tenant halt (approved/human sends unaffected)",
    autonomyDecision({ managerKey: "ai_isa", effective: "autonomous", tenantHalt: th, humanApproved: true }).allow === true)
  check("no managerKey ⇒ allow under a tenant halt (transactional/system never gated)",
    autonomyDecision({ effective: null, tenantHalt: th }).allow === true)
  const bothHalts = autonomyDecision({
    managerKey: "ai_isa", effective: "autonomous",
    platformHalt: { halted: true, reason: "platform emergency" }, tenantHalt: th,
  })
  check("god switch out-ranks the tenant halt (platform reason wins when both are set)",
    bothHalts.allow === false && bothHalts.reason === "platform emergency")
  check("tenantHalt {halted:false} changes nothing", autonomyDecision({ managerKey: "ai_isa", effective: "autonomous", tenantHalt: { halted: false, reason: null } }).allow === true)

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
  let flagCreated = false

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

    // PER-TENANT STAFF HALT — a brokerage-scoped feature_access_overrides 'autonomy' disable
    // out-ranks even a broker-set 'autonomous' posture; removing it restores the posture.
    const { TENANT_AUTONOMY_FEATURE_KEY, loadTenantAutonomyHalt } = await import("../lib/managers/autonomy-gate")
    await svc.from("managed_agents").update({ config: { autonomy_tier: "autonomous", autonomy_set_by: tag } }).eq("id", agentId)
    const { data: preFlag } = await svc.from("feature_flags").select("feature_key").eq("feature_key", TENANT_AUTONOMY_FEATURE_KEY).maybeSingle()
    if (!preFlag) {
      await svc.from("feature_flags").insert({
        feature_key: TENANT_AUTONOMY_FEATURE_KEY, display_name: "Autonomous AI managers", category: "governance",
        enabled: true, superadmin_only: false, solo_agent_access: true, team_access: true, brokerage_access: true, multi_location_access: true,
      })
      flagCreated = true
    }
    const { error: haltErr } = await svc.from("feature_access_overrides").insert({
      brokerage_id: brokerageId, feature_key: TENANT_AUTONOMY_FEATURE_KEY, override_type: "disable",
      disabled_reason: `${tag} staff halt`,
    })
    check("staff halt row written (brokerage-scoped 'autonomy' disable)", !haltErr)
    __clearAutonomyCache()
    check("tenant halt reads back with the staff reason",
      (await loadTenantAutonomyHalt(brokerageId)).halted === true)
    check("halted tenant resolves approval_required even with broker posture 'autonomous'",
      (await resolveManagerAutonomy(brokerageId, "ai_isa")) === "approval_required")
    await svc.from("feature_access_overrides").delete().eq("brokerage_id", brokerageId).eq("feature_key", TENANT_AUTONOMY_FEATURE_KEY)
    __clearAutonomyCache()
    check("resume (override removed) restores the broker posture",
      (await resolveManagerAutonomy(brokerageId, "ai_isa")) === "autonomous")
  } finally {
    await svc.from("feature_access_overrides").delete().eq("brokerage_id", brokerageId)
    if (flagCreated) await svc.from("feature_flags").delete().eq("feature_key", "autonomy")
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
