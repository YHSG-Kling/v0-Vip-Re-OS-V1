#!/usr/bin/env tsx
/**
 * scripts/predictor-learning-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves PREDICTOR LEARNING — the heuristic manager predictors (buyer-stall, listing-stall, dual-
 * transaction, stuck-stage) become SELF-IMPROVING. Each play's outcome (the contact re-engaged → win;
 * didn't → loss) is recorded onto ai_feedback_log; getPredictorTuning reads it back and decides, PER
 * BROKERAGE, whether to keep firing at the normal bar or RAISE the bar when a predictor's been missing.
 *
 * Layer 1 (shell, pure): the tuning math + the fire gate. Layer 2 (live, creds-gated): record a
 * reliable predictor (8/2) and an unreliable one (2/8) → read each tuning back → reliable fires
 * normally, unreliable only on the strongest signal → clean up.
 *
 * Run: npx tsx scripts/predictor-learning-simulator.ts   (npm run test:predictor-learning)
 */
import { predictorTuning, shouldFireWithTuning, PREDICTOR_MIN_SAMPLE } from "../lib/intelligence/predictor-learning"

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
  console.log(" ✅ Predictor learning verified — predictors self-tune per brokerage from real outcomes.")
  console.log(" PREDICTOR_LEARNING_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Predictor learning simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[Layer 1 · tuning + fire gate]")
  const reliable = predictorTuning(8, 2)
  check("8/10 → reliable, normal bar", reliable.confidence === "reliable" && reliable.thresholdMultiplier === 1.0 && !reliable.requireStrongest)
  const unreliable = predictorTuning(2, 8)
  check("2/10 → unreliable, raise the bar (require strongest)", unreliable.confidence === "unreliable" && unreliable.requireStrongest && unreliable.thresholdMultiplier > 1.0)
  const mixed = predictorTuning(5, 5)
  check("5/10 → mixed (nudge the bar up, not strongest-only)", mixed.confidence === "mixed" && !mixed.requireStrongest)
  check(`< ${PREDICTOR_MIN_SAMPLE} fired → unproven, fires normally (earns a record)`, predictorTuning(2, 0).confidence === "unproven" && predictorTuning(2, 0).thresholdMultiplier === 1.0)

  check("reliable: an 'elevated' signal fires", shouldFireWithTuning("elevated", reliable))
  check("unreliable: 'elevated' is HELD, only 'high'/'overdue' fires", !shouldFireWithTuning("elevated", unreliable) && shouldFireWithTuning("high", unreliable) && shouldFireWithTuning("overdue", unreliable))
  check("severity 'none' never fires", !shouldFireWithTuning("none", reliable))

  console.log("\n[Layer 2 · live: record outcomes → tuning reads them back]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { recordPredictorOutcome, getPredictorTuning, predictorSystem } = await import("../lib/intelligence/predictor-learning-runner")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  // Use throwaway contact ids so cleanup is precise; the predictor namespace is real but we delete ours.
  const recorded: string[] = []
  try {
    // buyer_stall: reliable (8 win / 2 loss). listing_stall: unreliable (2 win / 8 loss).
    for (let i = 0; i < 8; i++) { const id = uuid(); await recordPredictorOutcome({ brokerageId, predictor: "buyer_stall", contactId: id, won: true }, svc); recorded.push(id) }
    for (let i = 0; i < 2; i++) { const id = uuid(); await recordPredictorOutcome({ brokerageId, predictor: "buyer_stall", contactId: id, won: false }, svc); recorded.push(id) }
    for (let i = 0; i < 2; i++) { const id = uuid(); await recordPredictorOutcome({ brokerageId, predictor: "listing_stall", contactId: id, won: true }, svc); recorded.push(id) }
    for (let i = 0; i < 8; i++) { const id = uuid(); await recordPredictorOutcome({ brokerageId, predictor: "listing_stall", contactId: id, won: false }, svc); recorded.push(id) }

    const buyerTuning = await getPredictorTuning(svc, brokerageId, "buyer_stall")
    const listingTuning = await getPredictorTuning(svc, brokerageId, "listing_stall")
    check("buyer_stall read back as reliable (fires normally)", buyerTuning.confidence === "reliable" && !buyerTuning.requireStrongest, JSON.stringify(buyerTuning))
    check("listing_stall read back as unreliable (raise the bar)", listingTuning.confidence === "unreliable" && listingTuning.requireStrongest, JSON.stringify(listingTuning))
    check("the two predictors tune independently", buyerTuning.accuracy > listingTuning.accuracy)
    void predictorSystem
  } finally {
    for (const id of recorded) await svc.from("ai_feedback_log").delete().eq("brokerage_id", brokerageId).eq("source_record_id", id).then(() => {}, () => {})
    const { count } = await svc.from("ai_feedback_log").select("id", { count: "exact", head: true }).in("source_record_id", recorded.length ? recorded : ["none"])
    check("cleanup: recorded outcomes removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
