#!/usr/bin/env tsx
/** scripts/intent-campaign-simulator.ts — Data Steward outbound: scrape sellers + hot buyers. */
import { composeSellerIntent, composeBuyerIntent, runIntentCampaign, BUYER_INTENT_THRESHOLD, type SellerScraper, type BuyerIntentScraper } from "../lib/kernel/intent-campaign"
let passed = 0, failed = 0; const fails: string[] = []
const check = (n: string, c: boolean, d?: string) => { if (c) { passed++; console.log(`  ✓ ${n}`) } else { failed++; fails.push(n); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) } }
const report = () => { console.log(`\n RESULT: ${passed} passed, ${failed} failed`); if (failed) { for (const f of fails) console.log("   - " + f); process.exit(1) } console.log(" ✅ Intent campaign verified") }
async function main() {
  console.log("══ Intent campaign simulator ══\n[Layer 1 · compose]")
  const s = composeSellerIntent("Oakdale", 12, ["high_equity"])
  check("seller copy: names area + count + situation (equity)", s.subject.includes("Oakdale") && s.subject.includes("12") && s.body.includes("equity"))
  const b = composeBuyerIntent("Oakdale", 3)
  check("buyer copy: speaks to an active searcher", b.subject.includes("Oakdale") && b.body.includes("matches"))
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("\n[Layer 2] ⏭ no creds"); report(); return }
  const { createServiceClient } = await import("../lib/supabase/service"); const svc = createServiceClient()
  const TAG = `Intent${Date.now()}`; const CITY = `${TAG}ville`; const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id").not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭ need agent"); report(); return }
    const brokerageId = (agent as any).brokerage_id
    const { data: l } = await svc.from("listings").insert({ brokerage_id: brokerageId, address: `${TAG} 1 St`, city: CITY, state: "CA", status: "active", agent_id: (agent as any).id }).select("id").single()
    cleanup.push({ table: "listings", id: (l as any).id })
    const { data: hb } = await svc.from("contacts").insert({ brokerage_id: brokerageId, first_name: "Hot", last_name: TAG, contact_type: "buyer", intent_score: 88, updated_at: new Date().toISOString() }).select("id").single()
    cleanup.push({ table: "contacts", id: (hb as any).id })
    // Injected seller scraper — no BatchData spend; returns a count.
    const sellerScraper: SellerScraper = async () => ({ recordsFound: 17 })
    const buyerIntentScraper: BuyerIntentScraper = async () => ({ recordsFound: 9 })  // Exa NEW buyers
    const r1 = await runIntentCampaign(brokerageId, { sellerScraper, buyerIntentScraper, maxMarkets: 1 }, svc)
    check("scraped sellers (BatchData) + NEW buyers (Exa) + hot buyer + staged channels", r1.sellersFound === 17 && r1.newBuyersFound === 9 && r1.sellerChannels >= 2 && r1.buyerChannels >= 1)
    // Seller direct mail + email gated.
    const { data: dm } = await svc.from("direct_mail_campaigns").select("id, approval_status, target_audience").ilike("campaign_name", `Intent Sellers ${CITY}%`).maybeSingle()
    if (dm) cleanup.push({ table: "direct_mail_campaigns", id: (dm as any).id })
    check("seller direct mail drafted, pending, audience motivated_sellers", (dm as any)?.approval_status === "pending" && (dm as any)?.target_audience === "motivated_sellers")
    const { data: se } = await svc.from("email_campaigns").select("id, status").ilike("campaign_name", `Intent Sellers Email ${CITY}%`).maybeSingle()
    if (se) cleanup.push({ table: "email_campaigns", id: (se as any).id })
    check("seller email drafted (gated)", (se as any)?.status === "draft")
    const { data: be } = await svc.from("email_campaigns").select("id, status").ilike("campaign_name", `Intent Buyers ${CITY}%`).maybeSingle()
    if (be) cleanup.push({ table: "email_campaigns", id: (be as any).id })
    check("buyer email drafted (gated)", (be as any)?.status === "draft")
    const { data: sum } = await svc.from("agent_client_messages").select("id, audience, agent_kind").ilike("rationale", "INTENT CAMPAIGN%").gte("proposed_at", new Date(Date.now() - 60000).toISOString()).maybeSingle()
    if (sum) { cleanup.push({ table: "agent_client_messages", id: (sum as any).id })
      const { data: rt } = await svc.from("notifications").select("id").eq("entity_id", (sum as any).id).in("type", ["approved_draft", "approval_needed"]).limit(3); for (const n of (rt ?? []) as any[]) cleanup.push({ table: "notifications", id: n.id }) }
    check("Campaign Orchestrator: agent summary proposed (audience agent, by data_steward)", (sum as any)?.audience === "agent" && (sum as any)?.agent_kind === "data_steward")
    const r2 = await runIntentCampaign(brokerageId, { sellerScraper, buyerIntentScraper, maxMarkets: 1 }, svc)
    check("idempotency: second pass stages nothing new", r2.sellerChannels === 0 && r2.buyerChannels === 0)
  } finally {
    for (const c of [...cleanup].reverse()) { try { await svc.from(c.table).delete().eq("id", c.id) } catch {} }
    const { count } = await svc.from("listings").select("id", { count: "exact", head: true }).like("address", `${TAG}%`)
    check("cleanup verified", (count ?? 0) === 0)
  }
  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
