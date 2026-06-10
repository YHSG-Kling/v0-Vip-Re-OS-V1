#!/usr/bin/env tsx
/**
 * scripts/voice-dial-batch-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * VOICE ISA DIAL-BATCH GATE harness — the AI ISA's governed outbound calling.
 *
 * Layer 1 (pure): eligibleForIsaCall — every gate must be clear (TCPA consent + ISA
 *   re-engage permission, no DNC / phone opt-out / call-stop, has a phone).
 * Layer 2 (live, gated): seed an eligible consented contact + an ineligible one, propose
 *   a batch (only the eligible one is included), then REVOKE the eligible contact's consent
 *   and approve — the consent RE-CHECK at approval drops it, so dialedCount is 0. Proves
 *   nothing dials on a contact who revoked between propose and approve. Self-cleans.
 *
 * Run: npx tsx scripts/voice-dial-batch-simulator.ts  (npm run test:voice-dial-batch)
 */
import { eligibleForIsaCall, proposeIsaDialBatch, approveIsaDialBatch } from "../lib/ai-isa/voice-dial-batch"

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
  console.log(" ✅ Voice ISA dial-batch gate verified")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Voice ISA dial-batch gate simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · eligibleForIsaCall]")
  const ok = { tcpa_consent: true, isa_reengage_allowed: true, dnc_status: false, phone_opt_out: false, call_stop_flag: false, phone: "+15555550100" }
  check("fully consented contact is callable", eligibleForIsaCall(ok).allowed)
  check("no TCPA consent → blocked", !eligibleForIsaCall({ ...ok, tcpa_consent: false }).allowed)
  check("ISA re-engage not permitted → blocked", !eligibleForIsaCall({ ...ok, isa_reengage_allowed: false }).allowed)
  check("DNC → blocked", !eligibleForIsaCall({ ...ok, dnc_status: true }).allowed)
  check("phone opt-out → blocked", !eligibleForIsaCall({ ...ok, phone_opt_out: true }).allowed)
  check("call-stop flag → blocked", !eligibleForIsaCall({ ...ok, call_stop_flag: true }).allowed)
  check("no phone → blocked", !eligibleForIsaCall({ ...ok, phone: null }).allowed)
  check("blocked contacts carry a reason", (eligibleForIsaCall({ ...ok, tcpa_consent: false }).reason ?? "").length > 0)

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live batch lifecycle]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `__dialsim_${Date.now()}__`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    const { data: usr } = await svc.from("users").select("id").limit(1).single()
    if (!brk || !usr) { console.log("  ⏭  Skipped — need a brokerage + user."); report(); return }
    const brokerageId = (brk as any).id
    const approverId = (usr as any).id

    // High-propensity, fully-consented contact → should be proposed.
    const { data: hot } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Hot", last_name: TAG, phone: "+15555550111",
      tcpa_consent: true, isa_reengage_allowed: true, dnc_status: false, phone_opt_out: false,
      intent_score: 95, engagement_score: 90, equity_estimate: 500000,
      last_life_event_detected: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (hot as any).id })
    // High-propensity but NO consent → must be excluded from the proposal.
    const { data: noConsent } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "NoConsent", last_name: TAG, phone: "+15555550112",
      tcpa_consent: false, isa_reengage_allowed: true, intent_score: 95, engagement_score: 90,
      equity_estimate: 500000, last_life_event_detected: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (noConsent as any).id })

    // PROPOSE — only the consented hot contact is included.
    const prop = await proposeIsaDialBatch({ brokerageId, limit: 20, minScore: 40 }, svc)
    check("propose: a batch was proposed", prop.proposed === true, prop.reason)
    if (prop.batchId) cleanup.push({ table: "ai_isa_call_batches", id: prop.batchId })
    const { data: batch } = await svc.from("ai_isa_call_batches").select("target_contacts, proposed_count, status").eq("id", prop.batchId ?? "").maybeSingle()
    const targets = ((batch as any)?.target_contacts ?? []) as Array<{ contact_id: string }>
    check("propose: the consented contact is in the batch", targets.some((t) => t.contact_id === (hot as any).id))
    check("propose: the NON-consented contact is EXCLUDED", !targets.some((t) => t.contact_id === (noConsent as any).id))
    check("propose: status is proposed (awaiting human)", (batch as any)?.status === "proposed")

    // REVOKE consent between propose and approve, then APPROVE → consent re-check drops it.
    await svc.from("contacts").update({ tcpa_consent: false }).eq("id", (hot as any).id)
    const appr = await approveIsaDialBatch({ batchId: prop.batchId!, brokerageId, approverUserId: approverId }, svc)
    check("approve: succeeds", appr.ok === true, appr.error)
    check("approve: consent RE-CHECK dropped the revoked contact (0 dial)", appr.dialedCount === 0 && appr.droppedForConsent >= 1)
    const { data: after } = await svc.from("ai_isa_call_batches").select("status, dialed_count, approved_by").eq("id", prop.batchId ?? "").single()
    check("approve: batch completed + dialed_count persisted", (after as any).status === "completed" && (after as any).dialed_count === 0)
    check("approve: human approver recorded (oversight proof)", (after as any).approved_by === approverId)

    // Idempotency — re-approving a completed batch is a no-op.
    const appr2 = await approveIsaDialBatch({ batchId: prop.batchId!, brokerageId, approverUserId: approverId }, svc)
    check("idempotency: re-approving a completed batch is rejected", appr2.ok === false)
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).like("last_name", `${TAG}%`)
    check("cleanup verified — 0 seeded contacts remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
