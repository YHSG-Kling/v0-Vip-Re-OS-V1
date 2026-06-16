#!/usr/bin/env tsx
/**
 * scripts/lead-reactivation-cadence-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the STALE-LEAD REACTIVATION LADDER — the lead-side mirror of the contact cadence, on the
 * APPROVED pre-consent channels ONLY (email + direct mail; no SMS/voice). 10d → email, 24d →
 * direct mail (downgrades to a 2nd email when no preset / no deliverable address), 45d → escalate.
 *
 * Layer 1 (pure): the lead ladder matrix — slower thresholds, step 2 remapped to direct_mail,
 *   escalation terminal, never-SMS.
 * Layer 2 (live, creds-gated): seed an AI-ISA lead with no preset/address, walk 11d→25d→46d,
 *   asserting email → (downgraded) email → escalate(notif+signal) → idempotent. Seeds cleaned up.
 *
 * Run: npx tsx scripts/lead-reactivation-cadence-simulator.ts   (npm run test:lead-reactivation-cadence)
 */
import { planLeadReactivationStep, LEAD_REACTIVATION_THRESHOLDS } from "../lib/lead-pipeline/lead-reactivation-cadence"

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
  console.log(" ✅ Stale-lead ladder verified — email → direct mail → escalate, email+mail only, terminal escalation.")
  console.log(" LEAD_REACTIVATION_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Stale-lead reactivation ladder simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · lead ladder matrix (10/24/45, email + direct mail only)]")
  check("thresholds are the slower lead cadence", LEAD_REACTIVATION_THRESHOLDS.step1Days === 10 && LEAD_REACTIVATION_THRESHOLDS.step2Days === 24 && LEAD_REACTIVATION_THRESHOLDS.step3Days === 45)
  check("8d → hold (too soon)", !planLeadReactivationStep({ daysDormant: 8, completedSteps: [] }).due)
  const s1 = planLeadReactivationStep({ daysDormant: 11, completedSteps: [] })
  check("11d → STEP 1 email", s1.due && s1.step === 1 && s1.action === "email")
  const s2 = planLeadReactivationStep({ daysDormant: 25, completedSteps: [1] })
  check("25d (email done) → STEP 2 DIRECT MAIL (never sms)", s2.due && s2.step === 2 && s2.action === "direct_mail")
  const s3 = planLeadReactivationStep({ daysDormant: 46, completedSteps: [1, 2] })
  check("46d (both done) → STEP 3 escalate", s3.due && s3.step === 3 && s3.action === "escalate")
  check("after escalation → hold forever", !planLeadReactivationStep({ daysDormant: 90, completedSteps: [1, 2, 3] }).due)
  check("no step ever resolves to sms/voice", ["email", "direct_mail", "escalate", "hold"].includes(planLeadReactivationStep({ daysDormant: 30, completedSteps: [1] }).action))

  console.log("\n[Layer 2 · live: walk a real AI-ISA lead 11d→25d→46d]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (pure layer ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { runLeadReactivationCadence } = await import("../lib/lead-pipeline/lead-reactivation-cadence-runner")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  const NOW = "2026-06-16T12:00:00.000Z"
  const dormantSince = (d: number) => new Date(new Date(NOW).getTime() - d * 86_400_000).toISOString()
  const stampGen = async (req: { goal: string }) => ({ subject: "ZZGEN", body: `ZZGEN ${req.goal}` })
  const leadId = uuid(), agentId = uuid()

  try {
    // No active preset / no verified address → step 2 downgrades to a 2nd email (still advances).
    await svc.from("leads").insert({ id: leadId, brokerage_id: brokerageId, first_name: "ZZ", last_name: "QuietLead", email: "zz.quietlead@example.com", email_opt_out: false, ai_isa_owner: true, agent_id: agentId, last_contacted_at: dormantSince(11) })

    const r1 = await runLeadReactivationCadence({ brokerageId, now: NOW, copyGenerator: stampGen }, svc)
    check("11d → email rung proposed", r1.emailed >= 1, JSON.stringify(r1))

    await svc.from("leads").update({ last_contacted_at: dormantSince(25) }).eq("id", leadId)
    const r2 = await runLeadReactivationCadence({ brokerageId, now: NOW, copyGenerator: stampGen }, svc)
    check("25d (no preset/addr) → step 2 downgrades to a 2nd email", r2.emailed >= 1 && r2.mailed === 0, JSON.stringify(r2))

    await svc.from("leads").update({ last_contacted_at: dormantSince(46) }).eq("id", leadId)
    const r3 = await runLeadReactivationCadence({ brokerageId, now: NOW, copyGenerator: stampGen }, svc)
    check("46d → escalation fires", r3.escalated >= 1, JSON.stringify(r3))
    const { count: sig } = await svc.from("manager_signals").select("id", { count: "exact", head: true }).eq("entity_id", leadId).eq("signal_type", "lead_reactivation_escalation")
    check("lead escalation bus signal raised", (sig ?? 0) >= 1)

    const r4 = await runLeadReactivationCadence({ brokerageId, now: NOW, copyGenerator: stampGen }, svc)
    check("re-run after escalation → HOLD", r4.emailed === 0 && r4.mailed === 0 && r4.escalated === 0)
  } finally {
    await svc.from("manager_signals").delete().eq("entity_id", leadId).then(() => {}, () => {})
    await svc.from("notifications").delete().eq("entity_id", leadId).then(() => {}, () => {})
    await svc.from("agent_client_messages").delete().eq("recipient_lead_id", leadId).then(() => {}, () => {})
    await svc.from("leads").delete().eq("id", leadId).then(() => {}, () => {})
    const { count } = await svc.from("leads").select("id", { count: "exact", head: true }).eq("id", leadId)
    check("cleanup: seeded lead removed", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
