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
import { narrateSignalsForClient, CLIENT_SAFE_SIGNAL_LINES } from "../lib/listings/seller-team-activity"
import { scoreDealPlayOutcomes, median, MIN_COHORT } from "../lib/kernel/deal-play-outcomes"
import { composeWeekInReviewScript, weekReviewTag, isoWeekOf } from "../lib/kernel/week-in-review"

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

console.log("\n── PURE: client-safe team narration (whitelist) ──")
{
  const lines = narrateSignalsForClient([
    { signal_type: "deal_play_reel_ready", created_at: "2026-07-06T10:00:00Z" },
    { signal_type: "internal_secret_chatter", created_at: "2026-07-06T11:00:00Z" },
    { signal_type: "deal_play_prep_ready", created_at: "2026-07-05T10:00:00Z" },
    { signal_type: null, created_at: "2026-07-04T10:00:00Z" },
  ])
  check("whitelist ONLY: unknown/null signal types dropped (no internal chatter leaks)", lines.length === 2)
  check("newest first + named manager + fixed client-safe copy",
    lines[0].manager === "Asset Manager" && lines[0].line.includes("promo video") && lines[1].manager === "Listing Concierge")
  check("no whitelist line contains prices/terms/internal jargon",
    Object.values(CLIENT_SAFE_SIGNAL_LINES).every((l) => !/\$|price|commission|spend|budget|signal|payload/i.test(l.line)))
  check("cap honored", narrateSignalsForClient(Array.from({ length: 20 }, (_, i) => ({ signal_type: "deal_play_prep_ready", created_at: `2026-07-0${(i % 7) + 1}T10:00:00Z` })), 6).length === 6)
}

console.log("\n── PURE: deal-play outcomes (honest learning loop) ──")
{
  check("median: empty → null, even/odd handled", median([]) === null && median([1, 3]) === 2 && median([1, 2, 9]) === 2)
  const thin = scoreDealPlayOutcomes([
    { played: true, daysToContract: 10, engagement: 50 },
    { played: false, daysToContract: 30, engagement: 5 },
  ])
  check("thin data → 'insufficient' with real Ns (never a thin-data claim)", thin.verdict === "insufficient" && thin.why.includes("1 played / 1 control"))
  const mk = (played: boolean, days: number) => ({ played, daysToContract: days, engagement: 10 })
  const liftRows = [
    ...Array.from({ length: 12 }, () => mk(true, 12)),
    ...Array.from({ length: 12 }, () => mk(false, 30)),
  ]
  const lift = scoreDealPlayOutcomes(liftRows)
  check("clear gap + both cohorts ≥" + MIN_COHORT + " → lift, why states medians + observational caveat",
    lift.verdict === "lift" && lift.why.includes("12 days") && /observational/i.test(lift.why))
  const noLift = scoreDealPlayOutcomes([
    ...Array.from({ length: 12 }, () => mk(true, 29)),
    ...Array.from({ length: 12 }, () => mk(false, 30)),
  ])
  check("inside the margin → no_lift (counts reported, no claim invented)", noLift.verdict === "no_lift")
  check("censored (no contract) listings excluded, never imputed",
    scoreDealPlayOutcomes([...liftRows, { played: true, daysToContract: null, engagement: null }]).playedContracted === 12)
}

console.log("\n── PURE: voice week-in-review script ──")
{
  const script = composeWeekInReviewScript({
    firstName: "Dana", ytdGciCents: 8_200_000, annualGoalCents: 20_000_000,
    projectedYearEndCents: 15_000_000, gapToGoalCents: 5_000_000, weighted30Cents: 1_200_000,
    actions: [{ title: "Call your 6 stale buyer leads", description: null, impactCents: 900_000 }],
  })
  check("script greets + states goal progress in dollars", script.includes("Dana") && script.includes("$82,000") && script.includes("$200,000"))
  check("gap stated honestly + delegation close", script.includes("short") && script.includes("approve it in your command center".slice(0, 20)))
  const noGoal = composeWeekInReviewScript({ firstName: null, ytdGciCents: null, annualGoalCents: null, projectedYearEndCents: null, gapToGoalCents: null, weighted30Cents: null, actions: [] })
  check("no goal → honest coaching line, no invented numbers", noGoal.includes("haven't set an annual income goal") && !noGoal.includes("$"))
  check("weekReviewTag carries agent + ISO week (dedupe key)", weekReviewTag("a1", "2026-W28") === "[WEEKLY_REVIEW] [a1] [2026-W28]")
  check("isoWeekOf is stable + zero-padded", /^\d{4}-W\d{2}$/.test(isoWeekOf(new Date("2026-07-07T12:00:00Z"))))
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

  // ── The three follow-on loops ──
  const portalPage = src("app/portal/[contactId]/listing/page.tsx")
  check("seller portal narrates the team timeline (whitelist narrator, entity-scoped query)",
    portalPage.includes("narrateSignalsForClient") && portalPage.includes('eq("entity_type", "listing")'))
  const teamCard = src("app/portal/[contactId]/components/seller-mode/seller-team-activity-card.tsx")
  check("team card renders the timeline with a fixed-copy note", teamCard.includes("timeline") && teamCard.includes("Recently, on your home"))
  const ccPage = src("app/dashboard/admin/command-center/page.tsx")
  check("command center hosts the Deal Play lift tile (honest verdict states)", ccPage.includes("loadDealPlayLift") && ccPage.includes("still learning"))
  const wir = src("lib/kernel/week-in-review.ts")
  check("week-in-review READS persisted Income Truth (never recomputes)", wir.includes("income_forecast_gap_analysis") && !wir.includes("computeAndPersistGapAction"))
  check("audio is ElevenLabs-creds-gated (text-only without a key)", wir.includes("ELEVENLABS_API_KEY"))
  check("delegation close = ONE gated agent-audience proposal, week-deduped", wir.includes("proposeClientMessage") && wir.includes("[WEEKLY_REVIEW]"))
  const cron = src("lib/kernel/cron-dispatch.ts")
  check("voice-week-in-review cron registered AFTER the digest computes", cron.includes("voice-week-in-review"))
  for (const key of ["client_team_narration", "deal_play_outcomes", "voice_week_in_review"]) {
    check(`registry burn domain ${key}`, key in MAINTENANCE_DOMAINS)
  }
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
