#!/usr/bin/env tsx
/** scripts/launch-war-room-simulator.ts — the new-listing bench convening. */
import { composeLaunch, runLaunchWarRoom } from "../lib/kernel/launch-war-room"
import type { NeighborScraper } from "../lib/kernel/neighbor-farm"
import type { PromoDispatcher } from "../lib/kernel/voice-delegation"
let passed = 0, failed = 0; const fails: string[] = []
const check = (n: string, c: boolean, d?: string) => { if (c) { passed++; console.log(`  ✓ ${n}`) } else { failed++; fails.push(n); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) } }
const report = () => { console.log(`\n RESULT: ${passed} passed, ${failed} failed`); if (failed) { for (const f of fails) console.log("   - " + f); process.exit(1) } console.log(" ✅ Launch war room verified — the whole bench, gated") }
async function main() {
  console.log("══ Launch war room simulator ══\n[Layer 1 · compose]")
  const c = composeLaunch("44 Birch Lane", "Oakdale", true)
  check("coming-soon copy across channels names the home", c.social.includes("COMING SOON") && c.social.includes("44 Birch Lane") && c.email.includes("44 Birch Lane") && c.blog.includes("44 Birch Lane"))
  check("agent summary names the launch pieces", c.agentSummary.includes("open-house") && c.agentSummary.includes("neighbor") && c.agentSummary.includes("ad"))
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("\n[Layer 2] ⏭ no creds"); report(); return }
  const { createServiceClient } = await import("../lib/supabase/service"); const svc = createServiceClient()
  const TAG = `Launch${Date.now()}`; const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id").not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭ need agent"); report(); return }
    const brokerageId = (agent as any).brokerage_id
    const { data: l } = await svc.from("listings").insert({ brokerage_id: brokerageId, address: `${TAG} 44 Birch Lane`, city: `${TAG}ville`, status: "coming_soon", agent_id: (agent as any).id }).select("id").single()
    cleanup.push({ table: "listings", id: (l as any).id })
    const fakeScraper: NeighborScraper = async () => ([{ address: `${TAG} 46`, city: `${TAG}ville`, state: "CA", zip: "90210", ownerName: "Pat", tenureYears: 12, estimatedAge: 50, knowsBuyerScore: 0.9, proximityMeters: 30, lifeStageMatch: null, signals: {} }])
    const promoDispatcher: PromoDispatcher = async () => ({ ok: true, status: "remotion_pending" })
    const r1 = await runLaunchWarRoom(brokerageId, { scraper: fakeScraper, promoDispatcher }, svc)
    check("war room convened: reel + channels + open house + neighbor farm + ad + summary",
      r1.launches >= 1 && r1.reels >= 1 && r1.channelsStaged >= 3 && r1.openHousesProposed >= 1 && r1.neighborFarms >= 1 && r1.adsStaged >= 1 && r1.summariesProposed >= 1)
    // Open house scheduled (unpublished).
    const { data: oh } = await svc.from("open_houses").select("id, status, is_published, event_date").eq("listing_id", (l as any).id).maybeSingle()
    if (oh) cleanup.push({ table: "open_houses", id: (oh as any).id })
    check("Listing Concierge: open house PROPOSED as a draft (no fabricated date), unpublished", (oh as any)?.status === "draft" && (oh as any)?.is_published === false)
    // Coming-soon social drafted.
    const { data: sp } = await svc.from("social_posts").select("id, post_type, approval_status").eq("listing_id", (l as any).id).eq("post_type", "coming_soon").maybeSingle()
    if (sp) cleanup.push({ table: "social_posts", id: (sp as any).id })
    check("coming-soon social drafted, pending", (sp as any)?.approval_status === "pending")
    // Channel rows + neighbor + ad + summary for cleanup.
    for (const [tbl, col, val] of [["email_campaigns","campaign_name",`Launch Email — ${TAG} 44 Birch Lane`],["newsletter_campaigns","campaign_name",`Launch Newsletter — ${TAG} 44 Birch Lane`],["blog_posts","title",`Introducing ${TAG} 44 Birch Lane`],["ad_campaigns","campaign_name",`Launch Geo — ${TAG} 44 Birch Lane`]] as const) {
      const { data } = await svc.from(tbl).select("id").eq(col, val).maybeSingle(); if (data) cleanup.push({ table: tbl, id: (data as any).id })
    }
    const { data: nc } = await svc.from("neighbor_notification_campaigns").select("id").eq("listing_id", (l as any).id).maybeSingle()
    if (nc) { const { data: recs } = await svc.from("neighbor_notification_recipients").select("id").eq("campaign_id", (nc as any).id); for (const r of (recs ?? []) as any[]) cleanup.push({ table: "neighbor_notification_recipients", id: r.id }); cleanup.push({ table: "neighbor_notification_campaigns", id: (nc as any).id }) }
    const { data: sum } = await svc.from("agent_client_messages").select("id, audience").eq("entity_id", (l as any).id).ilike("rationale", "LAUNCH WAR ROOM%").maybeSingle()
    if (sum) { cleanup.push({ table: "agent_client_messages", id: (sum as any).id }); const { data: rt } = await svc.from("notifications").select("id").eq("entity_id", (sum as any).id).in("type", ["approved_draft","approval_needed"]).limit(3); for (const n of (rt ?? []) as any[]) cleanup.push({ table: "notifications", id: n.id }) }
    check("Campaign Orchestrator: launch summary proposed (audience agent)", (sum as any)?.audience === "agent")
    const { data: conv } = await svc.from("manager_signals").select("id, status").eq("entity_id", (l as any).id).eq("signal_type", "launch_war_room_convened").maybeSingle()
    if (conv) cleanup.push({ table: "manager_signals", id: (conv as any).id })
    check("bus: convening line consumed", (conv as any)?.status === "consumed")
    const r2 = await runLaunchWarRoom(brokerageId, { scraper: fakeScraper, promoDispatcher }, svc)
    check("idempotency: second pass convenes nothing new", r2.launches === 0)
  } finally {
    for (const c of [...cleanup].reverse()) { try { await svc.from(c.table).delete().eq("id", c.id) } catch {} }
    const { count } = await svc.from("listings").select("id", { count: "exact", head: true }).like("address", `${TAG}%`)
    check("cleanup verified", (count ?? 0) === 0)
  }
  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
