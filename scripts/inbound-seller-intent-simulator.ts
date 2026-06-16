#!/usr/bin/env tsx
/**
 * scripts/inbound-seller-intent-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves INBOUND SELLER-INTENT routing — a "what's my home worth" capture (home-value tool /
 * valuation magnet) is the strongest inbound seller signal, so it ENGAGES the Listing Concierge over
 * the bus, which proposes a GATED precise-CMA follow-up. A non-valuation magnet does NOT engage.
 *
 * Layer 1 (shell, pure): the classification (valuation+address → hot; valuation only → warm; other →
 * no engage). Layer 2 (live, creds-gated): publish for a real contact → the concierge proposes a
 * gated CMA-offer message → assert 'proposed' (never auto-sent) → idempotent → clean up.
 *
 * Run: npx tsx scripts/inbound-seller-intent-simulator.ts   (npm run test:inbound-seller-intent)
 */
import { classifyInboundSellerIntent } from "../lib/intelligence/inbound-seller-intent"

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
  console.log(" ✅ Inbound seller-intent verified — valuation captures engage the concierge (gated); others don't.")
  console.log(" INBOUND_SELLER_INTENT_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Inbound seller-intent simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[Layer 1 · classification]")
  const hot = classifyInboundSellerIntent({ source: "home_value_tool", hasPropertyAddress: true, estimatedValue: 650000, consent: true })
  check("home-value request WITH address → engage, hot", hot.engage && hot.intentStrength === "hot")
  const warm = classifyInboundSellerIntent({ source: "lead_magnet:home_valuation", hasPropertyAddress: false, estimatedValue: null, consent: true })
  check("valuation magnet WITHOUT address → engage, warm", warm.engage && warm.intentStrength === "warm")
  const buyer = classifyInboundSellerIntent({ source: "lead_magnet:buyer_guide", hasPropertyAddress: false, estimatedValue: null, consent: true })
  check("a buyer-guide magnet → NO engage (not seller intent)", !buyer.engage)

  console.log("\n[Layer 2 · live: engage the concierge → gated CMA-offer]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { publishInboundSellerIntent } = await import("../lib/intelligence/inbound-seller-intent-runner")
  const { consumeManagerSignals } = await import("../lib/kernel/manager-signals")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  let contactId: string | null = null
  try {
    const { data: c } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "ZZHomeval", last_name: `${Date.now()}`,
      email: `zz-hv-${Date.now()}@example.com`, contact_type: "lead", source: "home_value_tool",
    }).select("id").single()
    contactId = (c as any)?.id ?? null
    if (contactId) cleanup.push({ table: "contacts", id: contactId })

    const r = await publishInboundSellerIntent({
      brokerageId, contactId: contactId!, source: "home_value_tool",
      property: { address: "21 Birch Ln", city: "Austin", state: "TX", estimatedValue: 720000 },
    }, svc)
    check("the concierge was engaged (signal published)", r.engaged, JSON.stringify(r))

    await consumeManagerSignals({ brokerageId, toManager: "listing_concierge", limit: 20 }, svc)
    const { data: msg } = await svc.from("agent_client_messages")
      .select("id, status, audience, agent_kind, subject").eq("brokerage_id", brokerageId).eq("recipient_contact_id", contactId)
      .order("proposed_at", { ascending: false }).limit(1).maybeSingle()
    check("a GATED CMA-offer was proposed to the homeowner ('proposed', seller)", (msg as any)?.status === "proposed" && (msg as any)?.audience === "seller" && (msg as any)?.agent_kind === "listing_concierge", JSON.stringify(msg))
    if ((msg as any)?.id) cleanup.push({ table: "agent_client_messages", id: (msg as any).id })

    const again = await publishInboundSellerIntent({ brokerageId, contactId: contactId!, source: "home_value_tool", property: { address: "21 Birch Ln" } }, svc)
    check("re-engaging the same contact is idempotent", again.engaged === false)
  } finally {
    await svc.from("manager_signals").delete().eq("brokerage_id", brokerageId).eq("contact_id", contactId ?? "none").eq("signal_type", "home_value_seller_intent").then(() => {}, () => {})
    for (const c of [...cleanup].reverse()) await svc.from(c.table).delete().eq("id", c.id).then(() => {}, () => {})
    const { count } = await svc.from("manager_signals").select("id", { count: "exact", head: true }).eq("contact_id", contactId ?? "none").eq("signal_type", "home_value_seller_intent")
    check("cleanup: signals + seeds removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
