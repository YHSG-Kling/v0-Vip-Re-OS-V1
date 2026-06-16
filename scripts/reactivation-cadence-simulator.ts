#!/usr/bin/env tsx
/**
 * scripts/reactivation-cadence-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the REACTIVATION CADENCE — the escalating, self-limiting ladder that the system
 * lacked (every reactivation today is one-off). 7d → warm EMAIL, 14d → direct SMS, 21d →
 * ESCALATE to a human and HOLD (stop nagging). Each rung fires once; touching the contact
 * resets dormancy; post-escalation always holds.
 *
 * Layer 1 (pure): the ladder matrix — too-soon holds, each threshold fires its rung once,
 *   highest-crossed-uncompleted wins, escalation is terminal.
 * Layer 2 (live, provider-free): seed a real assigned contact, walk it 8d→15d→22d dormant,
 *   asserting an email proposal, then an SMS proposal, then an escalation (agent notification
 *   + ai_isa bus signal), then idempotent HOLD. proposeClientMessage only PROPOSES (no
 *   approve → no provider). Seeds cleaned up. No mocks.
 *
 * Run: npx tsx scripts/reactivation-cadence-simulator.ts   (npm run test:reactivation-cadence)
 */
import { planReactivationStep } from "../lib/lead-pipeline/reactivation-cadence"

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
  console.log(" ✅ Reactivation cadence verified — email→sms→escalate→hold, each rung once, terminal escalation.")
  console.log(" REACTIVATION_CADENCE_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Reactivation cadence simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · ladder matrix]")
  check("3d dormant → hold (too soon)", !planReactivationStep({ daysDormant: 3, completedSteps: [] }).due)
  const s1 = planReactivationStep({ daysDormant: 8, completedSteps: [] })
  check("8d dormant → STEP 1 email", s1.due && s1.step === 1 && s1.action === "email")
  check("8d but step 1 done → hold (await next threshold)", !planReactivationStep({ daysDormant: 8, completedSteps: [1] }).due)
  const s2 = planReactivationStep({ daysDormant: 15, completedSteps: [1] })
  check("15d dormant, email done → STEP 2 sms", s2.due && s2.step === 2 && s2.action === "sms")
  const s3 = planReactivationStep({ daysDormant: 22, completedSteps: [1, 2] })
  check("22d dormant, email+sms done → STEP 3 escalate", s3.due && s3.step === 3 && s3.action === "escalate")
  check("after escalation → hold forever (no over-nagging)", !planReactivationStep({ daysDormant: 40, completedSteps: [1, 2, 3] }).due)
  // Highest-crossed-uncompleted wins (e.g. a contact discovered already 22d dormant w/ nothing done escalates straight away? no — ladder integrity: it takes the top crossed rung).
  const jump = planReactivationStep({ daysDormant: 30, completedSteps: [] })
  check("30d dormant, nothing done → top crossed rung (escalate)", jump.due && jump.step === 3)
  // Custom thresholds honored.
  check("custom thresholds shift the rungs", planReactivationStep({ daysDormant: 4, completedSteps: [], thresholds: { step1Days: 3 } }).step === 1)

  console.log("\n[Layer 2 · live: walk a real contact 8d→15d→22d, idempotently]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (pure layer ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { runReactivationCadence } = await import("../lib/lead-pipeline/reactivation-cadence-runner")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  const NOW = "2026-06-16T12:00:00.000Z"
  const dormantSince = (days: number) => new Date(new Date(NOW).getTime() - days * 86_400_000).toISOString()
  const stampGen = async (req: { goal: string }) => ({ subject: "ZZGEN", body: `ZZGEN ${req.goal}` })
  const contactId = uuid()
  const agentId = uuid()

  try {
    await svc.from("contacts").insert({ id: contactId, brokerage_id: brokerageId, first_name: "ZZ", last_name: "Dormant", contact_type: "lead", agent_id: agentId, dnc_status: false, last_contacted_at: dormantSince(8) })

    const r1 = await runReactivationCadence({ brokerageId, now: NOW, copyGenerator: stampGen }, svc)
    check("8d → an email rung is proposed", r1.emailed >= 1, JSON.stringify(r1))

    await svc.from("contacts").update({ last_contacted_at: dormantSince(15) }).eq("id", contactId)
    const r2 = await runReactivationCadence({ brokerageId, now: NOW, copyGenerator: stampGen }, svc)
    check("15d (email done) → an SMS rung is proposed", r2.texted >= 1, JSON.stringify(r2))

    await svc.from("contacts").update({ last_contacted_at: dormantSince(22) }).eq("id", contactId)
    const r3 = await runReactivationCadence({ brokerageId, now: NOW, copyGenerator: stampGen }, svc)
    check("22d (email+sms done) → escalation fires", r3.escalated >= 1, JSON.stringify(r3))
    const { count: notif } = await svc.from("notifications").select("id", { count: "exact", head: true }).eq("entity_id", contactId).eq("type", "reactivation_escalation")
    check("the responsible agent was notified", (notif ?? 0) >= 1)
    const { count: sig } = await svc.from("manager_signals").select("id", { count: "exact", head: true }).eq("entity_id", contactId).eq("signal_type", "reactivation_escalation")
    check("an ai_isa escalation bus signal was raised", (sig ?? 0) >= 1)

    const r4 = await runReactivationCadence({ brokerageId, now: NOW, copyGenerator: stampGen }, svc)
    check("re-run after escalation → HOLD (no new touches)", r4.emailed === 0 && r4.texted === 0 && r4.escalated === 0)
  } finally {
    await svc.from("manager_signals").delete().eq("entity_id", contactId).then(() => {}, () => {})
    await svc.from("notifications").delete().eq("entity_id", contactId).then(() => {}, () => {})
    await svc.from("agent_client_messages").delete().eq("recipient_contact_id", contactId).then(() => {}, () => {})
    await svc.from("contacts").delete().eq("id", contactId).then(() => {}, () => {})
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).eq("id", contactId)
    check("cleanup: seeded contact removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
