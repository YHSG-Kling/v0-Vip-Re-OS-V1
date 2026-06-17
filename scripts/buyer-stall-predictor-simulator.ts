#!/usr/bin/env tsx
/**
 * scripts/buyer-stall-predictor-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the BUYER-STALL PREDICTOR — the buyer-side counterpart to listing-stall. A buyer touring a
 * lot with no offer (fatigue / expectations / drifting) is caught, and the Shopping Agent proposes a
 * GATED reset: recalibrate (still touring, no offers) or re-energize (touring dried up).
 *
 * Layer 1 (shell, pure): the prediction cases. Layer 2 (live, creds-gated): publish a predicted stall
 * for a real buyer → the Shopping Agent handler proposes a gated buyer message → assert 'proposed'
 * (never auto-sent) → idempotent → clean up.
 *
 * Run: npx tsx scripts/buyer-stall-predictor-simulator.ts   (npm run test:buyer-stall-predictor)
 */
import { predictBuyerStall } from "../lib/intelligence/buyer-stall-predictor"

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
  console.log(" ✅ Buyer-stall predictor verified — touring-without-offers caught early; the right reset, gated.")
  console.log(" BUYER_STALL_PREDICTOR_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Buyer-stall predictor simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[Layer 1 · prediction cases]")
  const fresh = predictBuyerStall({ toursTotal: 2, toursLast30: 2, toursPrev30: 0, offersMade: 0, daysSinceFirstTour: 9 })
  check("a fresh buyer (few tours) → no stall", !fresh.willStall, JSON.stringify(fresh))

  // Touring a lot, still going out, no offers → recalibrate expectations.
  const recal = predictBuyerStall({ toursTotal: 9, toursLast30: 3, toursPrev30: 3, offersMade: 0, daysSinceFirstTour: 50 })
  check("many tours, still touring, no offers → stall + recalibrate", recal.willStall && recal.recommendedPlay === "recalibrate", JSON.stringify(recal))

  // Was touring, dried up → re-energize with fresh matches.
  const cold = predictBuyerStall({ toursTotal: 8, toursLast30: 0, toursPrev30: 5, offersMade: 0, daysSinceFirstTour: 60 })
  check("touring dried up → stall + re_energize", cold.willStall && cold.recommendedPlay === "re_energize", JSON.stringify(cold))

  check("predictor surfaces human-readable reasons", recal.reasons.length > 0 && cold.reasons.length > 0)
  check("a buyer who WROTE an offer isn't stalled on the offer axis", !predictBuyerStall({ toursTotal: 9, toursLast30: 3, toursPrev30: 3, offersMade: 1, daysSinceFirstTour: 50 }).reasons.some(r => /no offer/.test(r)))

  console.log("\n[Layer 2 · live: predict → Shopping Agent proposes a GATED reset]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { predictAndPublishBuyerStall } = await import("../lib/intelligence/buyer-stall-predictor-runner")
  const { consumeManagerSignals } = await import("../lib/kernel/manager-signals")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  let contactId: string | null = null
  try {
    const { data: c } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "ZZBuyer", last_name: `${Date.now()}`,
      email: `zz-buyer-${Date.now()}@example.com`, contact_type: "buyer",
    }).select("id").single()
    contactId = (c as any)?.id ?? null
    if (contactId) cleanup.push({ table: "contacts", id: contactId })

    // Seed 7 tours spread over ~50 days, all in the recent two windows, no offers → recalibrate.
    const now = Date.now()
    for (let i = 0; i < 7; i++) {
      const daysAgo = 5 + i * 7 // 5,12,...,47 days ago
      const { data: sh } = await svc.from("showings").insert({
        brokerage_id: brokerageId, contact_id: contactId,
        scheduled_at: new Date(now - daysAgo * 86_400_000).toISOString(), status: "completed",
      }).select("id").single()
      if ((sh as any)?.id) cleanup.push({ table: "showings", id: (sh as any).id })
    }

    const r = await predictAndPublishBuyerStall({ brokerageId, contactId: contactId! }, svc)
    check("a buyer stall was predicted + published", r.published && r.play !== null && r.play !== "hold", JSON.stringify(r))

    await consumeManagerSignals({ brokerageId, toManager: "shopping_agent", limit: 20 }, svc)
    const { data: msg } = await svc.from("agent_client_messages")
      .select("id, status, audience, agent_kind").eq("brokerage_id", brokerageId).eq("recipient_contact_id", contactId)
      .order("proposed_at", { ascending: false }).limit(1).maybeSingle()
    check("the Shopping Agent proposed a GATED buyer reset ('proposed', buyer)", (msg as any)?.status === "proposed" && (msg as any)?.audience === "buyer" && (msg as any)?.agent_kind === "shopping_agent", JSON.stringify(msg))
    if ((msg as any)?.id) cleanup.push({ table: "agent_client_messages", id: (msg as any).id })

    const again = await predictAndPublishBuyerStall({ brokerageId, contactId: contactId! }, svc)
    check("re-predicting the same play in the window is idempotent", again.published === false)
  } finally {
    await svc.from("manager_signals").delete().eq("brokerage_id", brokerageId).eq("contact_id", contactId ?? "none").eq("signal_type", "buyer_stall_predicted").then(() => {}, () => {})
    for (const c of [...cleanup].reverse()) await svc.from(c.table).delete().eq("id", c.id).then(() => {}, () => {})
    const { count } = await svc.from("manager_signals").select("id", { count: "exact", head: true }).eq("contact_id", contactId ?? "none").eq("signal_type", "buyer_stall_predicted")
    check("cleanup: predicted signals + seeds removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
