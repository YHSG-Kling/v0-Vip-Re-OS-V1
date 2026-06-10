#!/usr/bin/env tsx
/**
 * scripts/voice-dial-batch-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * VOICE ISA DIAL-BATCH GATE harness — the AI ISA's governed outbound calling.
 *
 * Layer 1 (pure): eligibleForIsaCall — every gate must be clear (TCPA consent + ISA
 *   re-engage permission, no DNC / phone opt-out / call-stop, has a phone).
 * Layer 2 (live, gated): the full governed flow —
 *   · AGENT-SCOPED propose: a batch built from ONE agent's consented contacts (the agent
 *     who owns them is the approver); a different agent's contact is excluded.
 *   · APPROVE dials each consented target through an INJECTED executor (the vendor seam —
 *     never a real call) and RECORDS each governed attempt into ai_isa_calls; dialed_count
 *     reflects placed calls.
 *   · Consent RE-CHECK at approval drops a contact who revoked in the interim.
 *   · AGENT-FIRST notifications: the responsible agent is alerted on a fresh batch; the
 *     manager is escalated only past 4h.
 * Self-cleans every row.
 *
 * Run: npx tsx scripts/voice-dial-batch-simulator.ts  (npm run test:voice-dial-batch)
 */
import {
  eligibleForIsaCall, proposeIsaDialBatch, approveIsaDialBatch, enqueueDialBatchNotifications,
  type DialExecutor,
} from "../lib/ai-isa/voice-dial-batch"

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

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live governed flow]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `__dialsim_${Date.now()}__`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: agents } = await svc.from("agents").select("id, user_id, brokerage_id").not("user_id", "is", null).not("brokerage_id", "is", null).limit(2)
    const agentList = (agents ?? []) as Array<{ id: string; user_id: string; brokerage_id: string }>
    if (agentList.length < 1) { console.log("  ⏭  Skipped — need an agent with a user."); report(); return }
    const agentA = agentList[0]
    const agentB = agentList[1] ?? null
    const brokerageId = agentA.brokerage_id
    const { data: usr } = await svc.from("users").select("id").eq("brokerage_id", brokerageId).in("user_type", ["broker", "broker_admin", "admin"]).limit(1).maybeSingle()
    const managerId = (usr as any)?.id ?? null

    const mkContact = async (suffix: string, agentId: string, overrides: Record<string, unknown> = {}) => {
      const { data } = await svc.from("contacts").insert({
        brokerage_id: brokerageId, first_name: suffix, last_name: TAG, agent_id: agentId, phone: "+15555550111",
        tcpa_consent: true, isa_reengage_allowed: true, dnc_status: false, phone_opt_out: false,
        intent_score: 95, engagement_score: 90, equity_estimate: 500000,
        last_life_event_detected: new Date(Date.now() - 5 * 86_400_000).toISOString(), ...overrides,
      }).select("id").single()
      cleanup.push({ table: "contacts", id: (data as any).id })
      return (data as any).id as string
    }
    const cA = await mkContact("Owned", agentA.id)
    const cB = agentB ? await mkContact("OtherAgent", agentB.id) : null

    // AGENT-SCOPED propose → only agentA's contact is in the batch.
    const prop = await proposeIsaDialBatch({ brokerageId, agentId: agentA.id, limit: 20, minScore: 40 }, svc)
    check("propose: agent-scoped batch created", prop.proposed === true, prop.reason)
    if (prop.batchId) cleanup.push({ table: "ai_isa_call_batches", id: prop.batchId })
    const { data: batch } = await svc.from("ai_isa_call_batches").select("target_contacts, proposed_by_agent_id, status").eq("id", prop.batchId ?? "").maybeSingle()
    const targets = ((batch as any)?.target_contacts ?? []) as Array<{ contact_id: string }>
    check("propose: agentA's contact is in the batch", targets.some((t) => t.contact_id === cA))
    check("propose: another agent's contact is EXCLUDED (agent-scoped)", !cB || !targets.some((t) => t.contact_id === cB))
    check("propose: proposed_by_agent_id = agentA (the approver)", (batch as any)?.proposed_by_agent_id === agentA.id)

    // AGENT-FIRST notification: agentA (the owner) is alerted; no manager escalation on a fresh batch.
    const n1 = await enqueueDialBatchNotifications(brokerageId, svc)
    check("notify: the responsible AGENT is alerted (front line)", n1.agentAlerts >= 1)
    check("notify: NO manager escalation on a fresh (<4h) batch", n1.managerEscalations === 0)
    const { data: agentNotif } = await svc.from("notifications").select("id, type, priority").eq("user_id", agentA.user_id).eq("type", "dial_batch_approval").eq("entity_id", prop.batchId ?? "").maybeSingle()
    if (agentNotif) cleanup.push({ table: "notifications", id: (agentNotif as any).id })
    check("notify: agent alert exists for the batch", !!agentNotif)

    // APPROVE with an INJECTED executor (vendor seam — no real call) → records ai_isa_calls.
    const executor: DialExecutor = async (t) => ({ contactId: t.contact_id, placed: true, voiceCallId: null })
    const appr = await approveIsaDialBatch({ batchId: prop.batchId!, brokerageId, approverUserId: agentA.user_id, executor }, svc)
    check("approve: succeeds", appr.ok === true, appr.error)
    check("approve: dialed + attempted counts reflect the consented target", appr.dialedCount === 1 && appr.attemptedCount === 1)
    const { data: calls } = await svc.from("ai_isa_calls").select("id, contact_id, voice_call_id, script_used").eq("contact_id", cA).ilike("script_used", "%AI ISA re-engagement%")
    for (const c of (calls ?? []) as Array<{ id: string }>) cleanup.push({ table: "ai_isa_calls", id: c.id })
    check("approve: a governed ai_isa_calls record was written with the script", ((calls ?? []).length) === 1 && !!(calls as any)[0]?.script_used)
    const { data: after } = await svc.from("ai_isa_call_batches").select("status, dialed_count, approved_by").eq("id", prop.batchId ?? "").single()
    check("approve: batch completed, dialed_count persisted, agent recorded as approver", (after as any).status === "completed" && (after as any).dialed_count === 1 && (after as any).approved_by === agentA.user_id)

    // CONSENT RE-CHECK: a second agent-scoped batch, revoke consent, approve → 0 dial.
    const prop2 = await proposeIsaDialBatch({ brokerageId, agentId: agentA.id, limit: 20, minScore: 40 }, svc)
    if (prop2.batchId) {
      cleanup.push({ table: "ai_isa_call_batches", id: prop2.batchId })
      await svc.from("contacts").update({ tcpa_consent: false }).eq("id", cA)
      let dialed = 0
      const exec2: DialExecutor = async (t) => { dialed += 1; return { contactId: t.contact_id, placed: true, voiceCallId: null } }
      const appr2 = await approveIsaDialBatch({ batchId: prop2.batchId, brokerageId, approverUserId: agentA.user_id, executor: exec2 }, svc)
      check("re-check: revoked contact dropped at approval (0 dialed, executor never called)", appr2.dialedCount === 0 && appr2.droppedForConsent >= 1 && dialed === 0)
    }

    // 4h MANAGER ESCALATION: age a proposed batch past 4h → manager escalated.
    if (managerId) {
      await svc.from("contacts").update({ tcpa_consent: true }).eq("id", cA)
      const prop3 = await proposeIsaDialBatch({ brokerageId, agentId: agentA.id, limit: 20, minScore: 40 }, svc)
      if (prop3.batchId) {
        cleanup.push({ table: "ai_isa_call_batches", id: prop3.batchId })
        await svc.from("ai_isa_call_batches").update({ proposed_at: new Date(Date.now() - 5 * 3_600_000).toISOString() }).eq("id", prop3.batchId)
        const n3 = await enqueueDialBatchNotifications(brokerageId, svc)
        check("escalation: manager escalated on the 5h-aged batch", n3.managerEscalations >= 1)
        const { data: esc } = await svc.from("notifications").select("id, priority").eq("type", "dial_batch_escalation").eq("entity_id", prop3.batchId).limit(1).maybeSingle()
        if (esc) cleanup.push({ table: "notifications", id: (esc as any).id })
        check("escalation: it is high priority", (esc as any)?.priority === "high")
        const { data: a3 } = await svc.from("notifications").select("id").eq("user_id", agentA.user_id).eq("type", "dial_batch_approval").eq("entity_id", prop3.batchId).maybeSingle()
        if (a3) cleanup.push({ table: "notifications", id: (a3 as any).id })
      }
    }
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
