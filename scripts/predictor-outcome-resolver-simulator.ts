#!/usr/bin/env tsx
/**
 * scripts/predictor-outcome-resolver-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the PREDICTOR OUTCOME RESOLVER — the fuel line that closes the self-tuning loop. A predictor
 * play settles to a WIN when the contact re-engages after it (reply / tour / offer) and a LOSS when
 * the window passes with no re-engagement; plays still inside the window stay pending. The win/loss is
 * recorded onto ai_feedback_log (so getPredictorTuning has data) and the signal is marked resolved.
 *
 * Layer 1 (shell, pure): the decision + signal→predictor mapping. Layer 2 (live, creds-gated): seed a
 * play + a later tour (→ win) and an old play with no re-engagement (→ loss), resolve, assert the
 * recorded outcomes + resolved signals, idempotent, clean up.
 *
 * Run: npx tsx scripts/predictor-outcome-resolver-simulator.ts (npm run test:predictor-outcome-resolver)
 */
import { decidePredictorOutcome, predictorNameForSignal, PREDICTOR_EVAL_WINDOW_DAYS } from "../lib/intelligence/predictor-outcome"

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
  console.log(" ✅ Predictor outcome resolver verified — re-engagement → win, silence → loss; the loop is fueled.")
  console.log(" PREDICTOR_OUTCOME_RESOLVER_PASS")
  process.exit(0)
}

const DAY = 86_400_000

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Predictor outcome resolver simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[Layer 1 · decision + mapping]")
  const now = Date.now()
  const playAt = now - 20 * DAY
  check("re-engagement after the play → settled win", decidePredictorOutcome(playAt, now - 18 * DAY, now).settled && decidePredictorOutcome(playAt, now - 18 * DAY, now).won)
  check("window passed, no re-engagement → settled loss", (() => { const d = decidePredictorOutcome(playAt, null, now); return d.settled && !d.won })())
  check("inside the window, no re-engagement → not settled (wait)", !decidePredictorOutcome(now - 3 * DAY, null, now).settled)
  check("re-engagement BEFORE the play doesn't count", !decidePredictorOutcome(now - 3 * DAY, now - 5 * DAY, now).won)
  check("signal_type → predictor name", predictorNameForSignal("buyer_stall_predicted") === "buyer_stall" && predictorNameForSignal("stage_stalled") === "stuck_stage" && predictorNameForSignal("not_a_predictor") === null)

  console.log("\n[Layer 2 · live: seed plays + re-engagement → record win/loss]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { resolvePredictorOutcomes } = await import("../lib/intelligence/predictor-outcome-resolver")
  const { publishManagerSignal } = await import("../lib/kernel/manager-signals")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  const winContact = uuid(), lossContact = uuid()
  const contactIds = [winContact, lossContact]
  const sigIds: string[] = []
  const showingIds: string[] = []
  try {
    // A buyer_stall play 20 days ago for each contact (past the 14d window).
    for (const cid of contactIds) {
      const r = await publishManagerSignal({
        brokerageId, fromManager: "shopping_agent", toManager: "shopping_agent",
        signalType: "buyer_stall_predicted", message: "buyer stall (test)",
        entityType: "contact", entityId: cid, contactId: cid, payload: { play: "recalibrate", risk: "elevated" },
      }, svc)
      if ((r as any).id) sigIds.push((r as any).id)
      // Backdate the signal 20 days so it's past the window.
      if ((r as any).id) await svc.from("manager_signals").update({ created_at: new Date(Date.now() - 20 * DAY).toISOString() }).eq("id", (r as any).id)
    }
    // WIN contact re-engaged: a tour 10 days ago (after the 20-day-old play).
    const { data: sh } = await svc.from("showings").insert({
      brokerage_id: brokerageId, contact_id: winContact, scheduled_at: new Date(Date.now() - 10 * DAY).toISOString(), status: "completed",
    }).select("id").single()
    if ((sh as any)?.id) showingIds.push((sh as any).id)

    const res = await resolvePredictorOutcomes(brokerageId, {}, svc)
    check("resolved both plays (1 win, 1 loss)", res.wins >= 1 && res.losses >= 1, JSON.stringify(res))

    const { data: winFb } = await svc.from("ai_feedback_log").select("rating").eq("brokerage_id", brokerageId).eq("source_system", "predictor:buyer_stall").eq("source_record_id", winContact)
    const { data: lossFb } = await svc.from("ai_feedback_log").select("rating").eq("brokerage_id", brokerageId).eq("source_system", "predictor:buyer_stall").eq("source_record_id", lossContact)
    check("the re-engaged contact recorded a WIN (+1)", ((winFb ?? []) as any[]).some(r => r.rating === 1))
    check("the silent contact recorded a LOSS (-1)", ((lossFb ?? []) as any[]).some(r => r.rating === -1))

    const again = await resolvePredictorOutcomes(brokerageId, {}, svc)
    check("re-resolving is idempotent (signals already resolved)", again.scanned === 0 || (again.wins === 0 && again.losses === 0))
  } finally {
    for (const id of sigIds) await svc.from("manager_signals").delete().eq("id", id).then(() => {}, () => {})
    for (const id of showingIds) await svc.from("showings").delete().eq("id", id).then(() => {}, () => {})
    for (const cid of contactIds) await svc.from("ai_feedback_log").delete().eq("brokerage_id", brokerageId).eq("source_record_id", cid).then(() => {}, () => {})
    const { count } = await svc.from("ai_feedback_log").select("id", { count: "exact", head: true }).in("source_record_id", contactIds)
    check("cleanup: outcomes + seeds removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
