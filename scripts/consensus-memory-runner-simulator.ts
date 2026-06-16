#!/usr/bin/env tsx
/**
 * scripts/consensus-memory-runner-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves CONSENSUS MEMORY reads accumulated HISTORY: as a consulted manager's second opinions are
 * recorded right/wrong onto the existing ai_feedback_log, getConsultTrackRecord reads them back and
 * runs them through the pure consensus math (accuracy → confidence → weight), per (manager, play).
 *
 * Layer 1 (shell, pure): consultSystem namespace + describeTrackRecord phrasing. Layer 2 (live,
 * creds-gated): record a reliable manager (8 right / 2 wrong) and a shaky one (2 right / 8 wrong) on
 * the same play → read each back → reliable gets full weight, shaky gets salted, the two don't bleed
 * into each other. Seeds cleaned up. No mocks.
 *
 * Run: npx tsx scripts/consensus-memory-runner-simulator.ts   (npm run test:consensus-memory-runner)
 */
import { consultSystem, describeTrackRecord } from "../lib/kernel/consensus-memory"

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
  console.log(" ✅ Consensus memory reads history — reliable reads earn weight, shaky ones get salted.")
  console.log(" CONSENSUS_MEMORY_RUNNER_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Consensus memory runner simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[Layer 1 · pure namespace + phrasing]")
  check("consultSystem namespaces per play", consultSystem("price_drop") === "second_opinion:price_drop")
  check("describe: no history → fair hearing", /fair hearing/.test(describeTrackRecord({ consult: "shopping_agent", playType: "price_drop", calls: 0, accuracy: 0, confidence: "unproven", weight: 0.5 })))
  check("describe: reliable read names weight", /reliable/.test(describeTrackRecord({ consult: "shopping_agent", playType: "price_drop", calls: 10, accuracy: 0.8, confidence: "reliable", weight: 1.0 })))

  console.log("\n[Layer 2 · live: record history → read track record]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { getConsultTrackRecord, recordConsultOutcome } = await import("../lib/kernel/consensus-memory-runner")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  // Unique play namespace so this run never collides with real second-opinion history.
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  const play = `zz_test_play_${uuid().slice(0, 8)}`
  const system = consultSystem(play)
  try {
    const reliable = "shopping_agent", shaky = "deal_coordinator"
    for (let i = 0; i < 8; i++) await recordConsultOutcome({ brokerageId, consult: reliable, playType: play, correct: true }, svc)
    for (let i = 0; i < 2; i++) await recordConsultOutcome({ brokerageId, consult: reliable, playType: play, correct: false }, svc)
    for (let i = 0; i < 2; i++) await recordConsultOutcome({ brokerageId, consult: shaky, playType: play, correct: true }, svc)
    for (let i = 0; i < 8; i++) await recordConsultOutcome({ brokerageId, consult: shaky, playType: play, correct: false }, svc)

    const trReliable = await getConsultTrackRecord(svc, brokerageId, { consult: reliable, playType: play })
    const trShaky = await getConsultTrackRecord(svc, brokerageId, { consult: shaky, playType: play })

    check("reliable manager read back as 8/10 → reliable, full weight", trReliable.calls === 10 && Math.abs(trReliable.accuracy - 0.8) < 1e-9 && trReliable.confidence === "reliable" && trReliable.weight === 1.0, JSON.stringify(trReliable))
    check("shaky manager read back as 2/10 → unreliable, salted", trShaky.calls === 10 && Math.abs(trShaky.accuracy - 0.2) < 1e-9 && trShaky.confidence === "unreliable" && trShaky.weight < 0.3, JSON.stringify(trShaky))
    check("the two managers' records don't bleed together", trReliable.weight > trShaky.weight)
  } finally {
    await svc.from("ai_feedback_log").delete().eq("brokerage_id", brokerageId).eq("source_system", system).then(() => {}, () => {})
    const { count } = await svc.from("ai_feedback_log").select("id", { count: "exact", head: true }).eq("source_system", system)
    check("cleanup: history removed", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
