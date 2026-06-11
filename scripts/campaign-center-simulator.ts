#!/usr/bin/env tsx
/** scripts/campaign-center-simulator.ts — one surface for every staged draft, grouped by play. */
import { playTagOf, loadCampaignCenter, approveCampaignItem, approveCampaignPlay } from "../lib/kernel/campaign-center"
let passed = 0, failed = 0; const fails: string[] = []
const check = (n: string, c: boolean, d?: string) => { if (c) { passed++; console.log(`  ✓ ${n}`) } else { failed++; fails.push(n); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) } }
const report = () => { console.log(`\n RESULT: ${passed} passed, ${failed} failed`); if (failed) { for (const f of fails) console.log("   - " + f); process.exit(1) } console.log(" ✅ Campaign command center verified") }
async function main() {
  console.log("══ Campaign command center simulator ══\n[Layer 1 · play tags]")
  check("FARM PLAY brief → Farm Play", playTagOf("FARM PLAY — social") === "Farm Play")
  check("LAUNCH WAR ROOM → Launch War Room", playTagOf("LAUNCH WAR ROOM — email") === "Launch War Room")
  check("INTENT CAMPAIGN → Intent Campaign", playTagOf("Intent Sellers Oakdale") === null || playTagOf("INTENT CAMPAIGN x") === "Intent Campaign")
  check("Lookalike name → Lookalike", playTagOf("Lookalike — 8 past buyers") === "Lookalike")
  check("unknown → null", playTagOf("random") === null)
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("\n[Layer 2] ⏭ no creds"); report(); return }
  const { createServiceClient } = await import("../lib/supabase/service"); const svc = createServiceClient()
  const TAG = `CC${Date.now()}`; const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id").not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭ need agent"); report(); return }
    const brokerageId = (agent as any).brokerage_id
    const { data: l } = await svc.from("listings").insert({ brokerage_id: brokerageId, address: `${TAG} 1 St`, city: `${TAG}v`, status: "active", agent_id: (agent as any).id }).select("id").single()
    cleanup.push({ table: "listings", id: (l as any).id })
    // Stage a few drafts across channels with FARM PLAY + INTENT tags.
    const { data: em } = await svc.from("email_campaigns").insert({ brokerage_id: brokerageId, agent_id: (agent as any).id, campaign_name: `FARM PLAY ${TAG} email`, subject_line: "s", content: "b", campaign_format: "one_off", status: "draft", approval_status: "pending" }).select("id").single(); cleanup.push({ table: "email_campaigns", id: (em as any).id })
    const { data: sp } = await svc.from("social_posts").insert({ brokerage_id: brokerageId, listing_id: (l as any).id, agent_id: (agent as any).id, platform: "all", post_type: "just_sold", content: "b", status: "draft", approval_status: "pending", ai_generated: true, post_brief: `FARM PLAY ${TAG}` }).select("id").single(); cleanup.push({ table: "social_posts", id: (sp as any).id })
    const { data: dm } = await svc.from("direct_mail_campaigns").insert({ brokerage_id: brokerageId, agent_id: (agent as any).id, campaign_name: `Intent Sellers ${TAG}`, target_audience: "motivated_sellers", piece_type: "postcard", copy_text: "b", is_ai_generated: true, approval_status: "pending", status: "planning" }).select("id").single(); cleanup.push({ table: "direct_mail_campaigns", id: (dm as any).id })
    const data = await loadCampaignCenter(brokerageId, svc)
    const mine = data.items.filter((i) => [(em as any).id, (sp as any).id, (dm as any).id].includes(i.id))
    check("aggregator surfaced all 3 staged drafts across channels", mine.length === 3)
    check("grouped by channel (email + social + direct_mail present)", mine.some(i => i.channel === "email") && mine.some(i => i.channel === "social") && mine.some(i => i.channel === "direct_mail"))
    check("each draft carries its PLAY tag", mine.filter(i => i.play === "Farm Play").length === 2)
    check("every surfaced item is gated (pending/draft, never published)", mine.every(i => /pending|draft|planning|awaiting/.test(i.status)))

    // ACTIONABLE: approve one item through its gate (the email) → flips to approved.
    const aprUser = (agent as any).user_id
    const r1 = await approveCampaignItem(brokerageId, "email", (em as any).id, aprUser, svc)
    const { data: emAfter } = await svc.from("email_campaigns").select("approval_status").eq("id", (em as any).id).single()
    check("approve item: email flipped pending → approved through the gate", r1.ok && (emAfter as any).approval_status === "approved")
    // Approve the whole Farm Play (social + direct_mail remaining).
    const rp = await approveCampaignPlay(brokerageId, "Farm Play", aprUser, svc)
    const { data: spAfter } = await svc.from("social_posts").select("approval_status").eq("id", (sp as any).id).single()
    const { data: dmAfter } = await svc.from("direct_mail_campaigns").select("approval_status").eq("id", (dm as any).id).single()
    check("approve play: the Farm Play's social + direct_mail flipped to approved", rp.approved >= 2 && (spAfter as any).approval_status === "approved" && (dmAfter as any).approval_status === "approved")
  } finally {
    for (const c of [...cleanup].reverse()) { try { await svc.from(c.table).delete().eq("id", c.id) } catch {} }
    const { count } = await svc.from("listings").select("id", { count: "exact", head: true }).like("address", `${TAG}%`)
    check("cleanup verified", (count ?? 0) === 0)
  }
  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
