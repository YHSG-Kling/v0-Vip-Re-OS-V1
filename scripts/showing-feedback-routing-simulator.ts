#!/usr/bin/env tsx
/**
 * scripts/showing-feedback-routing-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves SHOWING-FEEDBACK ROUTING — the week's buyer-showing feedback on an in-house listing becomes
 * a MANAGER-ORCHESTRATED play (price pressure / strong interest / presentation), not a passive task.
 * The Listing Concierge consumes the routed signal and proposes a GATED seller recommendation.
 *
 * Layer 1 (shell, pure): the routing decisions (price/interest/presentation/thin-data/external).
 * Layer 2 (live, creds-gated): publish a routed signal for a real listing+seller → the concierge
 * handler proposes a gated seller message → assert it landed 'proposed' (never auto-sent) → clean up.
 *
 * Run: npx tsx scripts/showing-feedback-routing-simulator.ts   (npm run test:showing-feedback-routing)
 */
import { routeShowingFeedback } from "../lib/intelligence/showing-feedback-routing"

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
  console.log(" ✅ Showing-feedback routing verified — feedback drives a manager play, gated; never a passive task.")
  console.log(" SHOWING_FEEDBACK_ROUTING_PASS")
  process.exit(0)
}

const base = { objections: [] as string[], positiveThemes: [] as string[], feedbackCount: 5, highInterestCount: 1, lowInterestCount: 1 }

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Showing-feedback routing simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[Layer 1 · routing decisions]")
  const price = routeShowingFeedback({ ...base, pricingPressure: "reduce", objections: ["Price too high"], lowInterestCount: 4, highInterestCount: 0 }, { isInHouse: true })
  check("repeated price objections → price_pressure play, urgent", price.play === "price_pressure" && price.toManager === "listing_concierge" && price.urgency === "now", JSON.stringify(price))

  const hot = routeShowingFeedback({ ...base, pricingPressure: "raise", highInterestCount: 4, lowInterestCount: 0, positiveThemes: ["Updated kitchen"] }, { isInHouse: true })
  check("strong interest → strong_interest play (invite offers)", hot.play === "strong_interest" && hot.coachingPoints.includes("Updated kitchen"))

  const stage = routeShowingFeedback({ ...base, pricingPressure: "hold", objections: ["Needs updates", "dated finishes"] }, { isInHouse: true })
  check("presentation objections → presentation_coaching play", stage.play === "presentation_coaching" && stage.coachingPoints.length > 0)

  check("external (not our listing) → no play", routeShowingFeedback({ ...base, pricingPressure: "reduce", objections: ["Price too high"] }, { isInHouse: false }).play === null)
  check("thin feedback (<3) → no play (honest)", routeShowingFeedback({ ...base, pricingPressure: "reduce", feedbackCount: 2, objections: ["Price too high"] }, { isInHouse: true }).play === null)
  check("steady feedback → no play (keep strategy)", routeShowingFeedback({ ...base, pricingPressure: "hold" }, { isInHouse: true }).play === null)

  console.log("\n[Layer 2 · live: route → concierge proposes a GATED seller recommendation]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { routeAndPublishShowingFeedback } = await import("../lib/intelligence/showing-feedback-routing-runner")
  const { consumeManagerSignals } = await import("../lib/kernel/manager-signals")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  const listingId = uuid()
  let sellerContactId: string | null = null
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: c } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "ZZSeller", last_name: `${Date.now()}`,
      email: `zz-sfr-${Date.now()}@example.com`, contact_type: "seller",
    }).select("id").single()
    sellerContactId = (c as any)?.id ?? null
    if (sellerContactId) cleanup.push({ table: "contacts", id: sellerContactId })

    const r = await routeAndPublishShowingFeedback({
      brokerageId, listingId, sellerContactId, propertyAddress: "9 Oak Ave",
      isInHouse: true,
      summary: { pricingPressure: "reduce", objections: ["Price too high"], positiveThemes: [], feedbackCount: 5, highInterestCount: 0, lowInterestCount: 4 },
    }, svc)
    check("a price_pressure signal was routed to the concierge", r.routed && r.play === "price_pressure", JSON.stringify(r))

    await consumeManagerSignals({ brokerageId, toManager: "listing_concierge", limit: 20 }, svc)
    const { data: msg } = await svc.from("agent_client_messages")
      .select("id, status, audience, agent_kind").eq("brokerage_id", brokerageId).eq("entity_id", listingId)
      .eq("recipient_contact_id", sellerContactId).order("proposed_at", { ascending: false }).limit(1).maybeSingle()
    check("the concierge proposed a GATED seller recommendation (status 'proposed', never auto-sent)", (msg as any)?.status === "proposed" && (msg as any)?.audience === "seller" && (msg as any)?.agent_kind === "listing_concierge", JSON.stringify(msg))
    if ((msg as any)?.id) cleanup.push({ table: "agent_client_messages", id: (msg as any).id })

    // Idempotent — a second route within the week is a no-op.
    const again = await routeAndPublishShowingFeedback({
      brokerageId, listingId, sellerContactId, propertyAddress: "9 Oak Ave", isInHouse: true,
      summary: { pricingPressure: "reduce", objections: ["Price too high"], positiveThemes: [], feedbackCount: 5, highInterestCount: 0, lowInterestCount: 4 },
    }, svc)
    check("re-routing the same play within the week is idempotent (no duplicate)", again.routed === false)
  } finally {
    await svc.from("manager_signals").delete().eq("brokerage_id", brokerageId).eq("entity_id", listingId).eq("signal_type", "showing_feedback_routed").then(() => {}, () => {})
    for (const c of [...cleanup].reverse()) await svc.from(c.table).delete().eq("id", c.id).then(() => {}, () => {})
    const { count } = await svc.from("manager_signals").select("id", { count: "exact", head: true }).eq("entity_id", listingId).eq("signal_type", "showing_feedback_routed")
    check("cleanup: routed signals + seeds removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
