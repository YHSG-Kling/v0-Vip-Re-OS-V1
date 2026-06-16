#!/usr/bin/env tsx
/**
 * scripts/listing-stall-predictor-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the LISTING-STALL PREDICTOR — it catches a stall BEFORE expiry (relist_recovery is the
 * after-the-fact net) and hands the Listing Concierge an early, gated play: a marketing refresh when
 * showings dry up, or a price strategy when showings happen but no offers land.
 *
 * Layer 1 (shell, pure): the prediction cases (healthy / priced-wrong / visibility / early). Layer 2
 * (live, creds-gated): publish a predicted stall for a real listing+seller → the concierge handler
 * proposes a GATED early recommendation → assert 'proposed' (never auto-sent) → clean up.
 *
 * Run: npx tsx scripts/listing-stall-predictor-simulator.ts   (npm run test:listing-stall-predictor)
 */
import { predictListingStall } from "../lib/intelligence/listing-stall-predictor"

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
  console.log(" ✅ Listing-stall predictor verified — stalls caught early; the right play, gated.")
  console.log(" LISTING_STALL_PREDICTOR_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Listing-stall predictor simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[Layer 1 · prediction cases]")
  const healthy = predictListingStall({ daysOnMarket: 8, areaMedianDom: 30, showingsLast14: 5, showingsPrev14: 4, offers: 0 })
  check("fresh, active listing → no stall", !healthy.willStall && healthy.risk !== "high", JSON.stringify(healthy))

  // Showings happening but no offers past the area's pace → priced wrong (price_strategy).
  const pricedWrong = predictListingStall({ daysOnMarket: 45, areaMedianDom: 30, showingsLast14: 4, showingsPrev14: 4, offers: 0 })
  check("showings but no offers, past pace → stall + price_strategy", pricedWrong.willStall && pricedWrong.recommendedPlay === "price_strategy", JSON.stringify(pricedWrong))

  // Showings drying up → visibility problem (marketing_refresh).
  const drying = predictListingStall({ daysOnMarket: 35, areaMedianDom: 30, showingsLast14: 0, showingsPrev14: 6, offers: 0 })
  check("showings dried up → stall + marketing_refresh", drying.willStall && drying.recommendedPlay === "marketing_refresh", JSON.stringify(drying))

  check("predictor surfaces human-readable reasons", drying.reasons.length > 0 && pricedWrong.reasons.length > 0)
  check("uses a conservative default when no area benchmark", predictListingStall({ daysOnMarket: 50, areaMedianDom: null, showingsLast14: 0, showingsPrev14: 5, offers: 0 }).willStall)

  console.log("\n[Layer 2 · live: predict → concierge proposes a GATED early recommendation]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { predictAndPublishStall } = await import("../lib/intelligence/listing-stall-predictor-runner")
  const { consumeManagerSignals } = await import("../lib/kernel/manager-signals")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  const listingId = uuid()
  const cleanup: Array<{ table: string; id: string }> = []
  let sellerContactId: string | null = null
  try {
    const { data: c } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "ZZStall", last_name: `${Date.now()}`,
      email: `zz-stall-${Date.now()}@example.com`, contact_type: "seller",
    }).select("id").single()
    sellerContactId = (c as any)?.id ?? null
    if (sellerContactId) cleanup.push({ table: "contacts", id: sellerContactId })

    // No showings/offers seeded → with a 50-day-old go-live the predictor yields a stall.
    const goLiveAt = new Date(Date.now() - 50 * 86_400_000).toISOString()
    const r = await predictAndPublishStall({ brokerageId, listingId, sellerContactId, propertyAddress: "12 Pine St", goLiveAt, areaMedianDom: 30 }, svc)
    check("a stall was predicted + published early", r.published && r.play !== null && r.play !== "hold", JSON.stringify(r))

    await consumeManagerSignals({ brokerageId, toManager: "listing_concierge", limit: 20 }, svc)
    const { data: msg } = await svc.from("agent_client_messages")
      .select("id, status, audience, agent_kind").eq("brokerage_id", brokerageId).eq("entity_id", listingId)
      .eq("recipient_contact_id", sellerContactId).order("proposed_at", { ascending: false }).limit(1).maybeSingle()
    check("the concierge proposed a GATED early recommendation ('proposed', seller)", (msg as any)?.status === "proposed" && (msg as any)?.audience === "seller", JSON.stringify(msg))
    if ((msg as any)?.id) cleanup.push({ table: "agent_client_messages", id: (msg as any).id })

    const again = await predictAndPublishStall({ brokerageId, listingId, sellerContactId, propertyAddress: "12 Pine St", goLiveAt, areaMedianDom: 30 }, svc)
    check("re-predicting the same play in the window is idempotent", again.published === false)
  } finally {
    await svc.from("manager_signals").delete().eq("brokerage_id", brokerageId).eq("entity_id", listingId).eq("signal_type", "listing_stall_predicted").then(() => {}, () => {})
    for (const c of [...cleanup].reverse()) await svc.from(c.table).delete().eq("id", c.id).then(() => {}, () => {})
    const { count } = await svc.from("manager_signals").select("id", { count: "exact", head: true }).eq("entity_id", listingId).eq("signal_type", "listing_stall_predicted")
    check("cleanup: predicted signals + seeds removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
