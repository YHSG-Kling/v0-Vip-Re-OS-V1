#!/usr/bin/env tsx
/**
 * scripts/deliverables-summary-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * UNIFIED GOVERNED-DELIVERABLES RAIL harness.
 *
 * Layer 1 (pure): computeDeliverablesSummary — status tallies, the
 *   sent-with-approver governance invariant, per-manager + per-loop breakdown, and the
 *   entity_type → loop label mapping.
 * Layer 2 (live, gated): seed gate rows across multiple loops/managers + statuses, read
 *   them back through generateDeliverablesSummary, assert the rollup, then clean up.
 *
 * Run: npx tsx scripts/deliverables-summary-simulator.ts  (npm run test:deliverables)
 */
import { computeDeliverablesSummary, loopLabelFor, generateDeliverablesSummary } from "../lib/intelligence/deliverables-summary"

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
  console.log(" ✅ Governed-deliverables rail verified")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Governed-deliverables rail simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · computeDeliverablesSummary]")
  check("loop label: learning_module → Education", loopLabelFor("learning_module") === "Education")
  check("loop label: vendor_booking → Vendor marketplace", loopLabelFor("vendor_booking") === "Vendor marketplace")
  check("loop label: unknown entity → Other", loopLabelFor("zzz") === "Other")

  const rows = [
    { agent_kind: "shopping_agent", entity_type: "learning_module", status: "sent", approved_by: "u1" },
    { agent_kind: "shopping_agent", entity_type: "offer", status: "proposed", approved_by: null },
    { agent_kind: "deal_coordinator", entity_type: "vendor_booking", status: "sent", approved_by: "u2" },
    { agent_kind: "sphere_of_influence", entity_type: "referral", status: "rejected", approved_by: "u3" },
    { agent_kind: "recruiting_manager", entity_type: "recruit", status: "proposed", approved_by: null },
  ]
  const s = computeDeliverablesSummary(rows, "brk", "2026-06-01", "2026-06-08")
  check("totals: total = 5", s.totals.total === 5)
  check("totals: sent = 2", s.totals.sent === 2)
  check("totals: proposed = 2", s.totals.proposed === 2)
  check("totals: rejected = 1", s.totals.rejected === 1)
  check("governance: sentWithApprover = sent (2)", s.totals.sentWithApprover === 2 && s.totals.sentWithApprover === s.totals.sent)
  check("byManager: 4 distinct managers", s.byManager.length === 4)
  check("byManager: shopping_agent has the most (2)", s.byManager[0].manager === "shopping_agent" && s.byManager[0].total === 2)
  check("byLoop: Education + Vendor + Referrals + Recruiting + Offers present", s.byLoop.length === 5)

  // An UNAPPROVED sent row must break the invariant (caught by the operator).
  const bad = computeDeliverablesSummary([{ agent_kind: "shopping_agent", entity_type: "contact", status: "sent", approved_by: null }], "brk", "x", "y")
  check("governance: an unapproved sent row → sentWithApprover < sent (flagged)", bad.totals.sentWithApprover === 0 && bad.totals.sent === 1)

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live rollup]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `__delivsim_${Date.now()}__`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    const { data: usr } = await svc.from("users").select("id").limit(1).single()
    if (!brk || !usr) { console.log("  ⏭  Skipped — need a brokerage + user."); report(); return }
    const brokerageId = (brk as any).id
    const approver = (usr as any).id

    const seeds = [
      { agent_kind: "recruiting_manager", entity_type: "recruit", status: "sent", approved_by: approver },
      { agent_kind: "deal_coordinator", entity_type: "vendor_booking", status: "proposed", approved_by: null },
      { agent_kind: "shopping_agent", entity_type: "learning_module", status: "sent", approved_by: approver },
    ]
    for (const seed of seeds) {
      const { data } = await svc.from("agent_client_messages").insert({
        brokerage_id: brokerageId, agent_kind: seed.agent_kind, entity_type: seed.entity_type,
        audience: "agent", channel: "portal", subject: `${TAG} ${seed.entity_type}`, body: "x",
        status: seed.status, proposed_at: new Date().toISOString(),
        approved_by: seed.approved_by, sent_at: seed.status === "sent" ? new Date().toISOString() : null,
      }).select("id").single()
      cleanup.push({ table: "agent_client_messages", id: (data as any).id })
    }

    const summary = await generateDeliverablesSummary({ brokerageId, sinceIso: new Date(Date.now() - 3_600_000).toISOString() }, svc)
    check("live: at least the 3 seeded deliverables present", summary.totals.total >= 3)
    check("live: governance invariant holds (sentWithApprover === sent)", summary.totals.sentWithApprover === summary.totals.sent)
    check("live: recruiting + vendor + education loops represented",
      ["Recruiting", "Vendor marketplace", "Education"].every((l) => summary.byLoop.some((b) => b.loop === l)))
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("agent_client_messages").select("id", { count: "exact", head: true }).like("subject", `${TAG}%`)
    check("cleanup verified — 0 seeded deliverables remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
