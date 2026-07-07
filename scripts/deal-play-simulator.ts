// scripts/deal-play-simulator.ts   (npm run test:deal-play)
// ─────────────────────────────────────────────────────────────────────────────
// THE DEAL PLAY — proves the visible AI-team orchestration end to end.
// PURE:   composePlayHandoffs — four hops, correct manager pairs, honest lines
//         (states staged vs deduped), 'ready/staged' signal types so the feed
//         classifies them as handoffs.
// SOURCE: the play reuses the war room (onlyListingId) + produceListingAdCampaign
//         (no parallel producers), narrates via publishManagerSignal + the
//         consumed-with-action war-room pattern, is idempotent per listing, the
//         button mounts on the listing launch panel, the action is auth-gated.
// LIVE (creds-gated): seed a listing → runDealPlay → 4 consumed handoff signals
//         + gated artifacts exist → second run reports alreadyRan → cleanup==0.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { composePlayHandoffs } from "../lib/kernel/deal-play"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"
import { classifyCoordination } from "../lib/kernel/coordination-kind"

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── PURE: the four narrated hops ──")
{
  const hops = composePlayHandoffs("12 Oak St, Austin", { reels: 1, channelsStaged: 4, openHousesProposed: 1, adsStaged: 2 })
  check("exactly four hops", hops.length === 4)
  check("hop order: concierge → asset → campaign → ads → back to concierge",
    hops[0].from === "listing_concierge" && hops[0].to === "asset_manager" &&
    hops[1].from === "asset_manager" && hops[1].to === "campaign_orchestrator" &&
    hops[2].from === "campaign_orchestrator" && hops[2].to === "ads_manager" &&
    hops[3].from === "ads_manager" && hops[3].to === "listing_concierge")
  check("every hop classifies as a HANDOFF in the command-center feed",
    hops.every((h) => classifyCoordination(h.signalType) === "handoff"))
  check("lines carry the address + honest staged counts",
    hops[0].message.includes("12 Oak St") && hops[2].message.includes("4 channel drafts"))
  check("every hop states the real consumed action (never fake-awaiting)", hops.every((h) => h.consumedAction.length > 5))
  const deduped = composePlayHandoffs("12 Oak St", { reels: 0, channelsStaged: 0, openHousesProposed: 0, adsStaged: 0 })
  check("zero-staged (all deduped) → lines say 'already' honestly, never claim new work",
    deduped[1].message.includes("already") && deduped[2].message.includes("already") && deduped[3].message.includes("already"))
  check("nothing in any line promises publishing — gated language only",
    composePlayHandoffs("x", { reels: 1, channelsStaged: 1, openHousesProposed: 1, adsStaged: 1 })
      .every((h) => !/published|sent|live now/i.test(h.message)))
}

console.log("\n── SOURCE: consolidation + gating + UI ──")
{
  const play = src("lib/kernel/deal-play.ts")
  check("heavy lifting reuses the war room (onlyListingId) — no parallel producers", play.includes("runLaunchWarRoom") && play.includes("onlyListingId: listingId"))
  check("ad step reuses produceListingAdCampaign", play.includes("produceListingAdCampaign"))
  check("narration = publish → mark consumed with the real action (war-room pattern)",
    play.includes("publishManagerSignal") && play.includes('status: "consumed"') && play.includes("consumed_action"))
  check("idempotent per listing (keyed on the first handoff signal)", play.includes('"deal_play_prep_ready"') && play.includes("alreadyRan"))
  check("play refuses a listing with no address / wrong status (honest reasons)", play.includes("needs an address") && play.includes("coming-soon/active"))
  const war = src("lib/kernel/launch-war-room.ts")
  check("war room gained the on-demand onlyListingId path (backward-compatible)", war.includes("onlyListingId"))
  const action = src("app/actions/deal-play.ts")
  check("action is auth-gated + brokerage-scoped (caller's brokerage only)", action.includes("getAgentContext") && action.includes("ctx.brokerageId, listingId"))
  const panel = src("app/dashboard/listings/[id]/components/launch/launch-actions-panel.tsx")
  check("the button mounts on the listing launch panel + reports the staged summary",
    panel.includes("runDealPlayAction") && panel.includes("Run the Deal Play") && panel.includes("handoffs narrated"))
  check("registry burn domain listing_deal_play (campaign_orchestrator)",
    "listing_deal_play" in MAINTENANCE_DOMAINS && MAINTENANCE_DOMAINS.listing_deal_play.manager === "campaign_orchestrator")
}

async function live() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) { console.log("\n  ⏭  live skipped (no creds) — live proof runs via MCP"); return }
  const { createClient } = await import("@supabase/supabase-js")
  const svc = createClient(url, key)
  const { runDealPlay } = await import("../lib/kernel/deal-play")
  console.log("\n── LIVE: seeded play round-trip ──")

  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { check("live: a brokerage exists", false); return }
  const bId = (brk as any).id
  const { data: listing, error: lErr } = await svc.from("listings").insert({
    brokerage_id: bId, address: "SIM 99 Deal Play Ln", city: "Austin", status: "active",
  }).select("id").single()
  check("live: listing seeds", !lErr && !!listing, lErr?.message)
  if (!listing) return
  const lId = (listing as any).id
  try {
    const r1 = await runDealPlay(bId, lId, svc as any)
    check("live: play runs ok", r1.ok, r1.reason)
    check("live: four handoffs narrated", r1.handoffs === 4, `got ${r1.handoffs}`)
    const { data: sigs } = await svc.from("manager_signals").select("signal_type, status, consumed_action")
      .eq("entity_id", lId)
    const played = (sigs ?? []) as any[]
    check("live: handoff signals exist + consumed with real actions",
      played.filter((s) => s.signal_type.startsWith("deal_play_")).length === 4 &&
      played.filter((s) => s.signal_type.startsWith("deal_play_")).every((s) => s.status === "consumed" && s.consumed_action))
    const r2 = await runDealPlay(bId, lId, svc as any)
    check("live: second run reports alreadyRan (idempotent)", r2.ok && r2.alreadyRan === true)
  } finally {
    // Cleanup EVERYTHING the play staged for the sim listing.
    await svc.from("manager_signals").delete().eq("entity_id", lId)
    await svc.from("agent_client_messages").delete().eq("entity_id", lId)
    const { data: camps } = await svc.from("ad_campaigns").select("id").contains("targeting_config", { listing_id: lId })
    for (const c of (camps ?? []) as any[]) {
      await svc.from("ad_creative_variations").delete().eq("campaign_id", c.id)
      await svc.from("ad_campaigns").delete().eq("id", c.id)
    }
    await svc.from("social_posts").delete().eq("listing_id", lId).then(undefined, () => {})
    await svc.from("open_houses").delete().eq("listing_id", lId).then(undefined, () => {})
    await svc.from("ai_video_projects").delete().eq("listing_id", lId).then(undefined, () => {})
    await svc.from("listings").delete().eq("id", lId)
    const { count } = await svc.from("listings").select("id", { count: "exact", head: true }).eq("id", lId)
    check("live: cleanup complete (count==0)", (count ?? 0) === 0)
  }
}

live().then(() => {
  console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ❌ DEAL_PLAY_FAIL"); process.exit(1) }
  console.log(" ✅ DEAL_PLAY_PASS — the AI team works a listing visibly: four honest handoffs, every artifact gated")
})
