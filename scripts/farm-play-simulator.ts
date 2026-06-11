#!/usr/bin/env tsx
/**
 * scripts/farm-play-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FARM PLAY harness — a Team Play for a PLACE; six managers convene on a
 * just-sold address.
 *
 * Layer 1 (pure): farmWinIsRecruitingProof (fast OR high close only); composeFarmPlay
 *   (neighbor postcard, ad name, agent summary, recruiting note only for standouts;
 *   earned lines, no fabrication).
 * Layer 2 (live, gated): seed a closed deal (14-day DOM, $800k) with a farmable
 *   listing; run runFarmPlays; assert ALL SIX contributions land on their own rails —
 *   neighbor campaign awaiting seller permission, postcard pending approval, geo ad
 *   draft, recruiting win on the bus, the agent summary proposed (audience 'agent'),
 *   the convening line consumed — and the second pass is a no-op. Self-cleans.
 *
 * Run: npx tsx scripts/farm-play-simulator.ts  (npm run test:farm-play)
 */
import { farmWinIsRecruitingProof, composeFarmPlay, runFarmPlays } from "../lib/kernel/farm-play"

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
  console.log(" ✅ Farm Play verified — six managers, one block, all gated")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Farm Play simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · proof + compose]")
  check("fast close (≤14 DOM) → recruiting proof", farmWinIsRecruitingProof({ soldAddress: "x", soldCity: null, dealName: null, daysOnMarket: 10, salePrice: 300_000 }))
  check("high close (≥$750k) → recruiting proof", farmWinIsRecruitingProof({ soldAddress: "x", soldCity: null, dealName: null, daysOnMarket: 60, salePrice: 900_000 }))
  check("slow + modest close → NOT recruiting proof", !farmWinIsRecruitingProof({ soldAddress: "x", soldCity: null, dealName: null, daysOnMarket: 60, salePrice: 300_000 }))
  const standout = composeFarmPlay({ soldAddress: "44 Birch Lane", soldCity: "Oakdale", dealName: "44 Birch", daysOnMarket: 9, salePrice: 820_000 })
  check("postcard: names the sold home + the speed, invites a valuation", standout.postcardCopy.includes("44 Birch Lane") && standout.postcardCopy.includes("9 days") && standout.postcardCopy.toLowerCase().includes("valuation"))
  check("agent summary: names the bench (Data Steward + Marketing + Ads) + the gate", standout.agentSummary.includes("Data Steward") && standout.agentSummary.includes("Marketing") && standout.agentSummary.includes("Ads") && standout.agentSummary.includes("seller's OK"))
  check("recruiting note present + carries the win facts for a standout", !!standout.recruitingNote && standout.recruitingNote!.includes("$820,000"))
  const modest = composeFarmPlay({ soldAddress: "9 Elm", soldCity: null, dealName: "9 Elm", daysOnMarket: 70, salePrice: 250_000 })
  check("modest close: NO recruiting note (nothing to crow about)", modest.recruitingNote === null)

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live farm play]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `Farm${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id").not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id

    // listings.agent_id FK → agents.id (NOT users.id).
    const { data: lst } = await svc.from("listings").insert({
      brokerage_id: brokerageId, address: `${TAG} 44 Birch Lane`, city: `${TAG}ville`,
      status: "sold", agent_id: (agent as any).id,
    }).select("id").single()
    cleanup.push({ table: "listings", id: (lst as any).id })
    const { data: txn } = await svc.from("transactions").insert({
      brokerage_id: brokerageId, deal_name: `${TAG} 44 Birch Lane`, status: "closed",
      listing_id: (lst as any).id, agent_id: (agent as any).id,
      contract_date: new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10),
      close_date: new Date(Date.now() - 1 * 86_400_000).toISOString().slice(0, 10),
      purchase_price: 800_000,
    }).select("id").single()
    cleanup.push({ table: "transactions", id: (txn as any).id })

    const r1 = await runFarmPlays(brokerageId, {}, svc)
    check("farm play: convened (all six contributions counted)",
      r1.plays >= 1 && r1.neighborCampaigns >= 1 && r1.postcards >= 1 && r1.adsStaged >= 1 && r1.recruitingProofs >= 1 && r1.summariesProposed >= 1)

    // Data Steward — neighbor farm staged, awaiting seller permission (never sends).
    const { data: nc } = await svc.from("neighbor_notification_campaigns").select("id, status")
      .eq("listing_id", (lst as any).id).maybeSingle()
    if (nc) cleanup.push({ table: "neighbor_notification_campaigns", id: (nc as any).id })
    check("Data Steward: neighbor farm staged + AWAITING seller permission", (nc as any)?.status === "awaiting_seller_permission")

    // Marketing — postcard drafted, pending approval.
    const { data: dm } = await svc.from("direct_mail_campaigns").select("id, approval_status, status, copy_text")
      .eq("campaign_name", `Just Sold Farm — ${TAG} 44 Birch Lane`).maybeSingle()
    if (dm) cleanup.push({ table: "direct_mail_campaigns", id: (dm as any).id })
    check("Marketing: 'just sold near you' postcard drafted, PENDING approval",
      (dm as any)?.approval_status === "pending" && ((dm as any)?.copy_text ?? "").includes("just sold on your street"))

    // Ads — geo campaign staged as a draft (inactive).
    const { data: ad } = await svc.from("ad_campaigns").select("id, status, targeting_config")
      .eq("campaign_name", `Just Sold Farm — ${TAG} 44 Birch Lane`).maybeSingle()
    if (ad) cleanup.push({ table: "ad_campaigns", id: (ad as any).id })
    check("Ads: geo campaign STAGED as a draft, targeting the city", (ad as any)?.status === "draft" && Array.isArray((ad as any)?.targeting_config?.locations) && (ad as any).targeting_config.locations[0] === `${TAG}ville`)

    // Recruiting — the standout win on the bus.
    const { data: rsig } = await svc.from("manager_signals").select("id, to_manager, signal_type")
      .eq("entity_id", (txn as any).id).eq("signal_type", "win_story").maybeSingle()
    if (rsig) cleanup.push({ table: "manager_signals", id: (rsig as any).id })
    check("Recruiting: standout win logged on the bus (→ recruiting_manager)", (rsig as any)?.to_manager === "recruiting_manager")

    // Campaign Orchestrator — the one agent summary, gated (audience 'agent').
    const { data: summary } = await svc.from("agent_client_messages").select("id, status, audience, agent_kind, rationale")
      .eq("entity_id", (lst as any).id).ilike("rationale", "FARM PLAY%").maybeSingle()
    if (summary) cleanup.push({ table: "agent_client_messages", id: (summary as any).id })
    check("Campaign Orchestrator: ONE agent summary proposed (audience 'agent', gated)",
      (summary as any)?.status === "proposed" && (summary as any)?.audience === "agent" && (summary as any)?.agent_kind === "campaign_orchestrator")
    if (summary) {
      const { data: rtN } = await svc.from("notifications").select("id").eq("entity_id", (summary as any).id).eq("type", "approved_draft").limit(3)
      for (const n of (rtN ?? []) as any[]) cleanup.push({ table: "notifications", id: n.id })
    }

    // The bus convening line, consumed inline.
    const { data: conv } = await svc.from("manager_signals").select("id, status, consumed_action")
      .eq("entity_id", (lst as any).id).eq("signal_type", "farm_play_convened").maybeSingle()
    if (conv) cleanup.push({ table: "manager_signals", id: (conv as any).id })
    check("bus: the convening line consumed (Command Center shows six converge)",
      (conv as any)?.status === "consumed" && ((conv as any)?.consumed_action ?? "").includes("farm play staged"))

    // Idempotency.
    const r2 = await runFarmPlays(brokerageId, {}, svc)
    check("idempotency: second pass convenes nothing new", r2.plays === 0)
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("listings").select("id", { count: "exact", head: true }).like("address", `${TAG}%`)
    check("cleanup verified — 0 seeded listings remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
