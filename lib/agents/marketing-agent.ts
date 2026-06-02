/**
 * lib/agents/marketing-agent.ts
 *
 * Marketing Agent — the 6th Managed Agent kind. Per-brokerage, weekly.
 *
 * The user explicitly distinguished two marketing lanes:
 *   • Marketing TO contacts (1:1 / 1:few)   — sphere outreach, intros,
 *                                              anniversary, drip campaigns.
 *                                              Owned by the existing
 *                                              campaign_orchestrator (Wave 3).
 *   • Marketing the BRAND / LISTINGS (1:many) — Just Listed reels, market
 *                                              reports, brand social, blog
 *                                              cadence, listing-launch
 *                                              sequences. Owned by THIS agent.
 *
 * The marketing_agent oversees every brand/promotion asset coming out of
 * the platform — composing with existing kernel pieces rather than
 * duplicating any of them:
 *
 *   - listing_promo_videos (Wave 11/12)        — Just Listed reels queue
 *   - listing_health_scores                    — at-risk listings needing push
 *   - newsletter_campaigns + newsletter_sections taxonomy (Wave 5)
 *   - social_posts publisher (existing hourly cron)
 *   - blog_posts approval queue (existing)
 *   - direct_mail_campaigns via Lob
 *   - ai_video_projects                        — video render pipeline
 *   - De-Conflict broadcast cap (Wave 4)       — already enforces frequency
 *   - evaluateOutbound (canonical compliance)  — Brand voice + Fair Housing
 *                                                (state-specific, Florida +)
 *                                                + Them-First
 *
 * Trigger by: cron `app/api/cron/marketing-agent-weekly/route.ts` (Monday
 * morning, after sphere Sunday night and campaign-orchestrator Monday 7am).
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { spawnManagedAgentSession, type AgentTemplate, type SpawnResult } from "./spawn-helper"
import { resolveBrokerageContext, renderBrokerageContextForKickoff } from "./brokerage-context"
import { buildOutcomeFor, buildDefineOutcomeEvent } from "./outcomes"

const MARKETING_AGENT_SYSTEM = `You are the Marketing Agent for a real-estate brokerage. You serve under whichever
brokerage the kickoff names — name, tier, brand voice, prohibited words come from the kickoff.

YOUR JOB:
Own the brand/promotion marketing lane (1:many broadcast). Each week, scan:
  • Listings that just published and DON'T yet have a Just Listed reel queued
  • Listings whose health score has dropped — they need a marketing refresh
  • The brokerage's broadcast cadence: newsletter, social, blog, ad
  • Recent engagement on each channel — fold winners into next week's mix
  • De-conflict log — never queue past the broadcast frequency cap

Produce a ranked weekly plan the agent approves; you NEVER auto-publish.

YOU COMPOSE WITH EXISTING KERNEL PIECES (do not duplicate):
   - listing_promo_videos (m124) — the Just Listed reel ledger. Rows in
     status='remotion_pending' are waiting for the Remotion + ElevenLabs
     hybrid render pipeline. Queue render orders against THESE rows; do
     not create parallel records.
   - The Remotion property reel + cloned voice (ElevenLabs) + optional
     D-ID intro/outro hook is the CORRECT format for Just Listed,
     Just Sold, and Price Update promos. Avatar talking heads belong on
     intros + anniversaries, NOT on property promos.
   - Brand voice + compliance gates: evaluateOutbound chains Brand voice
     → Fair Housing (state-specific via state_protected_classes —
     Florida etc.) → Them-First. Run it on every script BEFORE queuing
     the render so D-ID + Remotion compute dollars are never wasted on
     a non-compliant draft.
   - Newsletter section taxonomy (lib/kernel/newsletter/section-types):
     13 canonical types (agent_intro, market_update, new_listings,
     property_highlight, local_news, local_event, neighborhood_spotlight,
     mortgage_rates, tips, testimonial, community_eats, cta, custom).
     Newsletter videos render ONCE per campaign and the same URL embeds
     in every recipient's email — $0.30 ÷ N, never $0.30 × N.
   - De-Conflict broadcast cap (lib/kernel/deconflict): newsletter
     1/segment/7d, social_post 3/day, blog 2/7d, ad 5/7d. Pre-attest
     against this in your plan so the gate doesn't surprise the agent.
   - Campaign Orchestrator (the 5th agent) owns 1:1 contact campaigns.
     If your plan would overlap their per-contact outreach, defer to
     them and ship only broadcast assets.

NEVER:
   - Auto-publish; the agent reviews + approves every asset.
   - Render a Just Listed talking-head video (wrong format — Remotion
     property reel only).
   - Stack channels on a contact within the platform suppression window.
   - Reference a listing or contact outside this brokerage.
   - Make commitments on specific rates, valuations, or appreciation.
   - Use protected-class language ("perfect for families" etc.).`

const TEMPLATE: AgentTemplate = {
  kind:    "marketing_agent",
  model:   "claude-sonnet-4-6",
  system:  MARKETING_AGENT_SYSTEM,
}

interface MarketingSnapshot {
  pendingListingPromos: number
  newListingsThisWeek:  number
  atRiskListings:       number
  recentSocialPosts:    number
  recentNewsletterSends: number
  recentBlogPublishes:  number
  weekSocialBudget:     number
  /** Wave 17/18 — top of the content topic bank, ranked for THIS brokerage.
   *  The agent uses these as the LEAD content topics for the week's
   *  podcast / newsletter / social mix. */
  topTopics: Array<{
    title:            string
    categories:       string[]
    engagement_score: number
    is_brokerage_local: boolean
    is_geo_tagged:    boolean
  }>
  /** Wave 18 — subscriber location distribution. Top 5 (city, state)
   *  buckets so the agent can route location-specific content. */
  topSubscriberLocations: Array<{
    city:    string | null
    state:   string | null
    count:   number
  }>
}

async function buildMarketingSnapshot(brokerageId: string): Promise<MarketingSnapshot> {
  const svc = createServiceClient()
  const since7d = new Date(Date.now() - 7 * 86_400_000).toISOString()

  let pendingListingPromos = 0
  try {
    const { count } = await svc
      .from("listing_promo_videos")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .eq("status", "remotion_pending")
    pendingListingPromos = count ?? 0
  } catch { /* table optional; m124 may not be applied in a fresh env */ }

  let newListingsThisWeek = 0
  try {
    const { count } = await svc
      .from("listings")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .eq("status", "active")
      .gte("created_at", since7d)
    newListingsThisWeek = count ?? 0
  } catch { /* best-effort */ }

  let atRiskListings = 0
  try {
    const { count } = await svc
      .from("listing_health_scores")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .lte("overall_score", 40)
    atRiskListings = count ?? 0
  } catch { /* table optional */ }

  let recentSocialPosts = 0
  try {
    const { count } = await svc
      .from("social_posts")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .in("status", ["published", "scheduled"])
      .gte("scheduled_for", since7d)
    recentSocialPosts = count ?? 0
  } catch { /* best-effort */ }

  let recentNewsletterSends = 0
  try {
    const { count } = await svc
      .from("newsletter_campaigns")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .eq("status", "sent")
      .gte("send_date", since7d)
    recentNewsletterSends = count ?? 0
  } catch { /* best-effort */ }

  let recentBlogPublishes = 0
  try {
    const { count } = await svc
      .from("blog_posts")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .eq("publish_status", "published")
      .gte("published_at", since7d)
    recentBlogPublishes = count ?? 0
  } catch { /* table optional */ }

  // Weekly broadcast budget: 1 newsletter + 3 social posts/day + 2 blogs
  const weekSocialBudget = 1 + 21 + 2

  // Wave 17 — top of the content topic bank for THIS brokerage. The agent
  // builds the week's plan from these instead of inventing topics.
  let topTopics: MarketingSnapshot["topTopics"] = []
  try {
    const { data } = await svc
      .from("content_topic_bank")
      .select("topic_title, categories, engagement_score, brokerage_id, geo_relevance")
      .eq("status", "fresh")
      .gt("expires_at", new Date().toISOString())
      .or(`brokerage_id.is.null,brokerage_id.eq.${brokerageId}`)
      .order("engagement_score", { ascending: false })
      .limit(10)
    topTopics = ((data ?? []) as Array<{ topic_title: string; categories: string[]; engagement_score: number; brokerage_id: string | null; geo_relevance: unknown }>).map((t) => ({
      title:              t.topic_title,
      categories:         t.categories ?? [],
      engagement_score:   t.engagement_score,
      is_brokerage_local: t.brokerage_id !== null,
      is_geo_tagged:      t.geo_relevance !== null,
    }))
  } catch { /* best-effort — bank may be empty in fresh installs */ }

  // Wave 18 — subscriber location distribution. The agent routes
  // location-specific content (newsletter sections, ad targeting) by
  // looking at where the audience actually is.
  let topSubscriberLocations: MarketingSnapshot["topSubscriberLocations"] = []
  try {
    // newsletter_subscribers → contacts.{city,state}. Aggregate the top 5.
    const { data } = await svc
      .from("newsletter_subscribers")
      .select("contact:contacts(city, state)")
      .eq("brokerage_id", brokerageId)
      .eq("status", "active")
      .limit(2000)
    const counts = new Map<string, { city: string | null; state: string | null; count: number }>()
    for (const row of (data ?? []) as Array<{ contact?: { city?: string | null; state?: string | null } | null }>) {
      const c = row.contact
      if (!c) continue
      const city  = (c.city  ?? "").trim() || null
      const state = (c.state ?? "").trim().toUpperCase() || null
      const key   = `${city ?? "-"}|${state ?? "-"}`
      const cur   = counts.get(key) ?? { city, state, count: 0 }
      cur.count++
      counts.set(key, cur)
    }
    topSubscriberLocations = [...counts.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
  } catch { /* best-effort */ }

  return {
    pendingListingPromos,
    newListingsThisWeek,
    atRiskListings,
    recentSocialPosts,
    recentNewsletterSends,
    recentBlogPublishes,
    weekSocialBudget,
    topTopics,
    topSubscriberLocations,
  }
}

export async function spawnMarketingAgentForBrokerage(params: {
  brokerageId:    string
  environmentId?: string
  kickoff?:       string
}): Promise<SpawnResult> {
  const brokerage = await resolveBrokerageContext({
    brokerageId: params.brokerageId,
    journeyType: "buyer",
    persona:     "first_time_buyer",
  })
  const snap = await buildMarketingSnapshot(params.brokerageId)

  const topicLines = snap.topTopics.length === 0
    ? "(content_topic_bank is empty — fall back to evergreen real-estate education)"
    : snap.topTopics.map((t, i) =>
        `  ${i + 1}. [${t.engagement_score}] ${t.title}` +
        (t.categories.length > 0 ? ` (${t.categories.join(", ")})` : "") +
        (t.is_brokerage_local ? " · LOCAL" : "") +
        (t.is_geo_tagged ? " · GEO-TAGGED" : "")
      ).join("\n")

  const locationLines = snap.topSubscriberLocations.length === 0
    ? "(no subscriber location data on file yet)"
    : snap.topSubscriberLocations.map((l) =>
        `  ${l.city ?? "(unknown city)"}, ${l.state ?? "(?)"}  →  ${l.count} subscribers`
      ).join("\n")

  const kickoff = params.kickoff ?? [
    renderBrokerageContextForKickoff(brokerage),
    "",
    "──── BRAND MARKETING SNAPSHOT (THIS WEEK) ────",
    `Just Listed reels pending Remotion render: ${snap.pendingListingPromos}`,
    `New listings published in last 7 days:     ${snap.newListingsThisWeek}`,
    `Listings at risk (health score ≤ 40):       ${snap.atRiskListings}`,
    `Social posts sent or scheduled last 7d:    ${snap.recentSocialPosts}`,
    `Newsletter campaigns sent last 7d:         ${snap.recentNewsletterSends}`,
    `Blog posts published last 7d:              ${snap.recentBlogPublishes}`,
    `Combined weekly broadcast budget:          ${snap.weekSocialBudget}`,
    "",
    "──── CONTENT INTELLIGENCE — TOP TOPICS FROM THE BANK ────",
    "Lead every asset this week with one of these. The audience is asking",
    "about these RIGHT NOW. Score is 0-100 engagement; LOCAL = brokerage-",
    "specific; GEO-TAGGED = bound to a city/state/zip (use those for",
    "location-targeted newsletter sections).",
    topicLines,
    "",
    "──── SUBSCRIBER LOCATION DISTRIBUTION ────",
    "The newsletter assembler honors target_locations on newsletter_sections —",
    "a Miami subscriber sees Miami-only sections, Tampa sees Tampa, all from",
    "ONE campaign send. Use this distribution to decide which location-",
    "specific sections are worth authoring this week.",
    locationLines,
    "",
    "Read the de-conflict log (deconflict_suppression_log) for the brokerage's recent",
    "broadcast cooldown decisions before scheduling new sends. Honor the broadcast",
    "frequency cap (newsletter 1/segment/7d, social_post 3/day, blog 2/7d, ad 5/7d).",
    "",
    "Produce the weekly plan in the JSON format the rubric specifies. Output JSON only.",
  ].filter(Boolean).join("\n")

  const rubric = buildOutcomeFor("marketing_agent", {
    brokerageName:        brokerage.brokerageName,
    subjectName:          brokerage.brokerageName,
    pendingListingPromos: snap.pendingListingPromos,
    atRiskListings:       snap.atRiskListings,
    weekSocialBudget:     snap.weekSocialBudget,
  })
  const outcomeEvent = buildDefineOutcomeEvent(rubric, kickoff)

  return spawnManagedAgentSession(TEMPLATE, {
    brokerageId:   params.brokerageId,
    entityType:    "brokerage",
    entityId:      params.brokerageId, // brokerage-level, like sphere + campaign_orchestrator
    environmentId: params.environmentId,
    title:         `Marketing Agent: ${brokerage.brokerageName}`,
    outcomeEvent,
    metadata: {
      pending_listing_promos:  String(snap.pendingListingPromos),
      new_listings_week:       String(snap.newListingsThisWeek),
      at_risk_listings:        String(snap.atRiskListings),
      tier:                    brokerage.tierKey,
    },
  })
}
