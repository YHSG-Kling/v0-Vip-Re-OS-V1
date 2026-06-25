#!/usr/bin/env tsx
/**
 * scripts/relist-recovery-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves EXPIRED/WITHDRAWN LISTING RE-LIST RECOVERY (seller-side mirror of offer-rejection
 * recovery) — verified white space (LISTING_EXPIRED/CANCELLED fire but nothing re-engages the
 * seller). Pure recovery-window engine, honest (a SOLD listing is a win, never a re-list
 * target); the runner proposes ONE gated seller re-launch message + routes acute cases to the
 * AI ISA for a re-list call.
 *
 * Layer 1 (pure): the re-list window verdict (acute/followup/expired/not_eligible) + copy.
 * Layer 2 (live, gated): seed a real expired listing with a seller contact → run recovery →
 *   assert a gated seller proposal + an ai_isa bus signal; a SOLD listing is NOT recovered;
 *   re-run idempotent. Seeds cleaned up. No mocks.
 *
 * Run: npx tsx scripts/relist-recovery-simulator.ts   (npm run test:relist-recovery)
 */
import { planRelistRecovery, ACUTE_WINDOW_DAYS, isRelistStatus } from "../lib/listings/relist-recovery"

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
  console.log(" ✅ Re-list recovery verified — off-market window caught, sold skipped, gated re-launch + ISA call.")
  console.log(" RELIST_RECOVERY_PASS")
  process.exit(0)
}

const NOW = "2026-06-16T12:00:00.000Z"
const daysAgo = (d: number) => new Date(new Date(NOW).getTime() - d * 86_400_000).toISOString()

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Expired/withdrawn re-list recovery simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · re-list window verdict]")
  const acute = planRelistRecovery({ status: "expired", transitionAt: daysAgo(2), now: NOW, address: "9 Oak Ave" })
  check("expired 2 days ago → acute + recommend call", acute.urgency === "acute" && acute.eligible && acute.recommendCall)
  check("acute brief urges reposition before a competitor", acute.agentBrief.toLowerCase().includes("competitor"))
  check("seller outreach names the home + is warm", /9 Oak Ave/.test(acute.sellerOutreach))

  // The acute re-list call hand-off to the AI ISA is now CONSUMED, not orphaned on the feed.
  {
    const { SIGNAL_HANDLERS } = await import("../lib/kernel/manager-signals")
    check("AI ISA consumes the re-list call hand-off (no longer a flat feed-only signal)",
      typeof SIGNAL_HANDLERS["ai_isa:relist_recovery"] === "function")
  }

  check("withdrawn is a re-list status", isRelistStatus("withdrawn") && isRelistStatus("cancelled"))
  const followup = planRelistRecovery({ status: "withdrawn", transitionAt: daysAgo(ACUTE_WINDOW_DAYS + 10), now: NOW })
  check("withdrawn ~17 days ago → followup, no rush call", followup.urgency === "followup" && followup.eligible && !followup.recommendCall)

  const expired = planRelistRecovery({ status: "expired", transitionAt: daysAgo(60), now: NOW })
  check("off-market 60 days ago → expired window (no out-of-the-blue nudge)", expired.urgency === "expired" && !expired.eligible)

  // HONEST: a SOLD/active listing is never a re-list target.
  check("a SOLD listing → not eligible (it's a win)", !planRelistRecovery({ status: "sold", transitionAt: daysAgo(2), now: NOW }).eligible)
  check("an ACTIVE listing → not eligible", !planRelistRecovery({ status: "active", transitionAt: daysAgo(2), now: NOW }).eligible)
  check("no transition timestamp → not eligible", !planRelistRecovery({ status: "expired", transitionAt: null, now: NOW }).eligible)
  check("future timestamp → not eligible (no fabrication)", !planRelistRecovery({ status: "expired", transitionAt: daysAgo(-3), now: NOW }).eligible)

  console.log("\n[Layer 2 · live: an expired listing is recovered + routed to the ISA, idempotently]")
  const hasCreds =
    !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    return report()
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { runRelistRecovery } = await import("../lib/listings/relist-recovery-runner")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  const stampGen = async (req: { goal: string }) => ({ subject: "ZZGEN", body: `ZZGEN ${req.goal}` })

  const sellerId = uuid()
  const soldSellerId = uuid()
  const agentId = uuid()
  const listingId = uuid()
  const soldListingId = uuid()
  try {
    await svc.from("contacts").insert({ id: sellerId, brokerage_id: brokerageId, first_name: "ZZ", last_name: "Seller", contact_type: "seller" })
    await svc.from("contacts").insert({ id: soldSellerId, brokerage_id: brokerageId, first_name: "ZZ", last_name: "Sold", contact_type: "seller" })
    await svc.from("listings").insert({
      id: listingId, brokerage_id: brokerageId, address: "ZZ 11 Relist Rd", status: "expired",
      seller_contact_id: sellerId, agent_id: agentId, stage_updated_at: daysAgo(2), updated_at: daysAgo(2),
    })
    // A SOLD listing must NOT be recovered.
    await svc.from("listings").insert({
      id: soldListingId, brokerage_id: brokerageId, address: "ZZ 12 Sold St", status: "sold",
      seller_contact_id: soldSellerId, agent_id: agentId, stage_updated_at: daysAgo(2), updated_at: daysAgo(2),
    })

    const r1 = await runRelistRecovery({ brokerageId, now: NOW, copyGenerator: stampGen }, svc)
    check("the expired listing is recovered + call routed", r1.recovered >= 1 && r1.callsRouted >= 1, JSON.stringify(r1))

    const { count: msgCount } = await svc.from("agent_client_messages").select("id", { count: "exact", head: true })
      .eq("entity_id", listingId).eq("audience", "seller")
    check("a gated seller re-launch proposal was created", (msgCount ?? 0) >= 1)
    const { count: soldMsg } = await svc.from("agent_client_messages").select("id", { count: "exact", head: true }).eq("entity_id", soldListingId)
    check("the SOLD listing was NOT recovered (honest)", (soldMsg ?? 0) === 0)
    const { count: sigCount } = await svc.from("manager_signals").select("id", { count: "exact", head: true })
      .eq("entity_id", sellerId).eq("signal_type", "relist_recovery")
    check("an ai_isa relist-call bus signal was published", (sigCount ?? 0) >= 1)

    const r2 = await runRelistRecovery({ brokerageId, now: NOW, copyGenerator: stampGen }, svc)
    check("re-run is idempotent (no duplicate recovery)", r2.recovered === 0)
  } finally {
    await svc.from("manager_signals").delete().eq("entity_id", sellerId).then(() => {}, () => {})
    await svc.from("agent_client_messages").delete().in("entity_id", [listingId, soldListingId]).then(() => {}, () => {})
    await svc.from("listings").delete().in("id", [listingId, soldListingId]).then(() => {}, () => {})
    await svc.from("contacts").delete().in("id", [sellerId, soldSellerId]).then(() => {}, () => {})
    const { count } = await svc.from("listings").select("id", { count: "exact", head: true }).in("id", [listingId, soldListingId])
    check("cleanup: seeded listings removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
