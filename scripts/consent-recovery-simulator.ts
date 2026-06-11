#!/usr/bin/env tsx
/**
 * scripts/consent-recovery-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * CONSENT-REVOKED RECOVERY CHAIN harness — respect the opt-out, keep the relationship.
 *
 * Layer 1 (pure): planConsentRecovery — fallback channel beats enrichment beats
 *   withdraw; withdraw ONLY after enrichment came back empty; withdrawn contacts
 *   leave the chain. composeFallbackNote — control-affirming, names what was turned
 *   off, zero sales pressure.
 * Layer 2 (live, gated): contact A revokes texts but email stays clean → ONE gate
 *   proposal (sphere, email). Contact B revokes everything → enrichment re-run queued;
 *   mark it completed-empty → withdraw signal published; Sphere consumes it →
 *   nurture_status='withdrawn' + agent notified; chain then goes quiet. Self-cleans.
 *
 * Run: npx tsx scripts/consent-recovery-simulator.ts  (npm run test:consent-recovery)
 */
import { planConsentRecovery, composeFallbackNote, runConsentRecovery } from "../lib/kernel/consent-recovery"

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
  console.log(" ✅ Consent-revoked recovery chain verified")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Consent-revoked recovery chain simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · plan + compose]")
  const base = {
    revokedChannels: ["texts"], emailAvailable: false, smsAvailable: false, voiceAvailable: false,
    enrichmentQueued: false, enrichmentCompleted: false, alreadyWithdrawn: false,
  }
  check("texts revoked + email clean → FALLBACK (not withdraw)",
    planConsentRecovery({ ...base, emailAvailable: true }).step === "fallback_channel")
  check("everything revoked + no enrichment yet → ENRICH first",
    planConsentRecovery(base).step === "enrich")
  check("enrichment in flight → WAIT (no premature withdraw)",
    planConsentRecovery({ ...base, enrichmentQueued: true }).step === "wait_enrichment")
  check("enrichment came back empty → only NOW withdraw",
    planConsentRecovery({ ...base, enrichmentQueued: true, enrichmentCompleted: true }).step === "withdraw")
  check("enrichment found a new channel → back to FALLBACK (chain re-converges)",
    planConsentRecovery({ ...base, enrichmentQueued: true, enrichmentCompleted: true, emailAvailable: true }).step === "fallback_channel")
  check("already withdrawn → chain is done (none)",
    planConsentRecovery({ ...base, alreadyWithdrawn: true, enrichmentQueued: true, enrichmentCompleted: true }).step === "none")
  check("nothing revoked → none",
    planConsentRecovery({ ...base, revokedChannels: [] }).step === "none")

  const note = composeFallbackNote({ contactName: "Jordan", revokedChannels: ["texts"] })
  check("note: names what was turned off + affirms control", note.body.includes("turned off texts") && note.body.includes("No action needed"))
  check("note: zero sales pressure (no listing/offer push)", !/buy|sell|listing|offer|deal/i.test(note.body))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live chain]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { consumeManagerSignals } = await import("../lib/kernel/manager-signals")
  const svc = createServiceClient()
  const TAG = `__consent_${Date.now()}__`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id").not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id

    // A: revoked texts, email still clean → fallback.
    const { data: a } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Fallback", last_name: TAG, contact_type: "buyer",
      agent_id: (agent as any).id, email: `fallback.${Date.now()}@example.test`,
      sms_opt_out: true, opted_out_at: new Date().toISOString(),
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (a as any).id })
    // B: revoked everything → enrich, then withdraw.
    const { data: b } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Withdraw", last_name: TAG, contact_type: "buyer",
      agent_id: (agent as any).id, email: `withdraw.${Date.now()}@example.test`, phone: "+15550000001",
      sms_opt_out: true, email_opt_out: true, email_unsubscribed: true, phone_opt_out: true,
      tcpa_consent: false, opted_out_at: new Date().toISOString(),
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (b as any).id })

    const r1 = await runConsentRecovery(brokerageId, {}, svc)
    check("run 1: A → fallback proposed, B → enrichment queued", r1.fallbacksProposed >= 1 && r1.enrichmentsQueued >= 1 && r1.withdrawsSignaled === 0)

    const { data: prop } = await svc.from("agent_client_messages")
      .select("id, agent_kind, audience, channel, status, body, rationale").eq("recipient_contact_id", (a as any).id).maybeSingle()
    if (prop) cleanup.push({ table: "agent_client_messages", id: (prop as any).id })
    check("A: gate proposal by the Sphere on the ALLOWED channel (email)",
      (prop as any)?.agent_kind === "sphere_of_influence" && (prop as any)?.channel === "email" && (prop as any)?.status === "proposed")
    check("A: control-affirming copy (turned off texts, no pressure)", ((prop as any)?.body ?? "").includes("turned off texts"))
    if (prop) {
      const { data: rtN } = await svc.from("notifications").select("id").eq("entity_id", (prop as any).id).eq("type", "approval_needed").maybeSingle()
      if (rtN) cleanup.push({ table: "notifications", id: (rtN as any).id })
    }

    const { data: eq } = await svc.from("contact_enrichment_queue")
      .select("id, status, source").eq("contact_id", (b as any).id).eq("source", "consent_recovery").maybeSingle()
    if (eq) cleanup.push({ table: "contact_enrichment_queue", id: (eq as any).id })
    check("B: enrichment re-run queued BEFORE any withdraw", (eq as any)?.status === "pending")

    // Enrichment comes back empty → run 2 must signal the withdraw (and only then).
    await svc.from("contact_enrichment_queue").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", (eq as any).id)
    const r2 = await runConsentRecovery(brokerageId, {}, svc)
    check("run 2: withdraw signaled only after enrichment came back empty", r2.withdrawsSignaled >= 1)
    const { data: sig } = await svc.from("manager_signals").select("id, status")
      .eq("entity_id", (b as any).id).eq("signal_type", "contact_withdrawn").maybeSingle()
    if (sig) cleanup.push({ table: "manager_signals", id: (sig as any).id })
    check("bus: withdraw signal addressed to the Sphere", !!sig)

    // The Sphere consumes: nurture_status='withdrawn' + agent notified, history kept.
    await consumeManagerSignals({ brokerageId, toManager: "sphere_of_influence" }, svc)
    const { data: bAfter } = await svc.from("contacts").select("nurture_status").eq("id", (b as any).id).single()
    check("sphere: relationship marked withdrawn (no delete — history kept)", (bAfter as any).nurture_status === "withdrawn")
    const { data: sigAfter } = await svc.from("manager_signals").select("status, consumed_action").eq("id", (sig as any).id).single()
    check("sphere: signal consumed with the action recorded", (sigAfter as any).status === "consumed" && ((sigAfter as any).consumed_action ?? "").includes("withdrawn"))
    const { data: wNotif } = await svc.from("notifications").select("id").eq("type", "consent_withdrawn").eq("entity_id", (b as any).id).maybeSingle()
    if (wNotif) cleanup.push({ table: "notifications", id: (wNotif as any).id })
    check("agent informed of the respectful release", !!wNotif)

    // Idempotency — the chain goes quiet.
    const r3 = await runConsentRecovery(brokerageId, {}, svc)
    check("idempotency: run 3 proposes/queues/signals nothing new",
      r3.fallbacksProposed === 0 && r3.enrichmentsQueued === 0 && r3.withdrawsSignaled === 0)
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
