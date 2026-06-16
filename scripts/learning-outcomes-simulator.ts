#!/usr/bin/env tsx
/**
 * scripts/learning-outcomes-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the LEARNING OUTCOMES recorder: persists each learner's win/loss onto the EXISTING
 * ai_feedback_log (no new table), entity-aware so BOTH leads and contacts are tracked, and reads
 * accumulated history back so the conductors learn over time.
 *
 * Layer 1 (shell, pure): outcome↔rating mapping. Layer 2 (live, creds-gated): record a CONTACT win
 * + a LEAD loss → read both back, filterable by entity. Seeds cleaned up. No mocks.
 *
 * Run: npx tsx scripts/learning-outcomes-simulator.ts   (npm run test:learning-outcomes)
 */
import { outcomeToRating, ratingToOutcome } from "../lib/intelligence/learning-outcomes"

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
  console.log(" ✅ Learning outcomes verified — recorded onto ai_feedback_log; leads AND contacts tracked.")
  console.log(" LEARNING_OUTCOMES_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Learning outcomes recorder simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[Layer 1 · outcome ↔ rating]")
  check("win → +1, loss → -1, neutral → 0", outcomeToRating("win") === 1 && outcomeToRating("loss") === -1 && outcomeToRating("neutral") === 0)
  check("rating → outcome inverse + null-safe", ratingToOutcome(1) === "win" && ratingToOutcome(-1) === "loss" && ratingToOutcome(0) === "neutral" && ratingToOutcome(null) === "neutral")

  console.log("\n[Layer 2 · live: record + read, BOTH leads and contacts]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { recordLearningOutcome, loadLearningOutcomes } = await import("../lib/intelligence/learning-outcomes-runner")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  const system = `zz_test_${uuid().slice(0, 8)}`
  const contactId = uuid(), leadId = uuid()
  const ids: string[] = []
  try {
    const r1 = await recordLearningOutcome({ brokerageId, system, outcome: "win", entityType: "contact", entityId: contactId, label: "reached thriving", detail: { lastReplyChannel: "video" } }, svc)
    const r2 = await recordLearningOutcome({ brokerageId, system, outcome: "loss", entityType: "lead", entityId: leadId, label: "ghosted", detail: {} }, svc)
    if (r1.id) ids.push(r1.id); if (r2.id) ids.push(r2.id)
    check("a CONTACT win and a LEAD loss were recorded", r1.ok && r2.ok)

    const all = await loadLearningOutcomes(svc, brokerageId, { system })
    check("both outcomes read back (leads AND contacts tracked)", all.length >= 2 && all.some((o) => o.entityType === "contact" && o.outcome === "win") && all.some((o) => o.entityType === "lead" && o.outcome === "loss"), JSON.stringify(all.map((o) => [o.entityType, o.outcome])))

    const leadsOnly = await loadLearningOutcomes(svc, brokerageId, { system, entityType: "lead" })
    check("filterable by entity (leads only → the lead loss)", leadsOnly.length === 1 && leadsOnly[0].entityType === "lead")
    check("detail (context_snapshot) round-trips", all.find((o) => o.entityType === "contact")?.detail?.lastReplyChannel === "video")
  } finally {
    for (const id of ids) await svc.from("ai_feedback_log").delete().eq("id", id).then(() => {}, () => {})
    const { count } = await svc.from("ai_feedback_log").select("id", { count: "exact", head: true }).eq("source_system", system)
    check("cleanup: outcomes removed", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
