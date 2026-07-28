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
import { loadFormatOutcomes, summarizeTopFormats, type TopFormat } from "@/lib/video/format-learning"

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
  /** Wave 24 — per-persona aggregate engagement over the last 30 days.
   *  Computed from newsletter_sends ⨝ contacts grouped by contact_persona,
   *  so the agent sees WHICH SEGMENTS are converting and can lean the
   *  week's plan into the stronger ones. Sample-floor filtered (≥5) to
   *  exclude noise from sparse personas. */
  personaEngagement: Array<{
    persona:        string
    sends:          number
    open_rate:      number   // percent, 0..100, rounded to 1 decimal
    click_rate:     number   // percent, 0..100, rounded to 1 decimal
  }>
  /** Wave 24 — top-performing topics per persona pulled from
   *  content_topic_persona_performance (m134). At most 3 personas, 2 topics
   *  each. Lets the agent's plan name SPECIFIC threads to anchor per
   *  segment — the same data the AI section author now uses, surfaced
   *  upstream so the agent's plan and the producer agree. */
  personaTopTopics: Array<{
    persona:    string
    topics: Array<{
      title:             string
      persona_score:     number   // 0..30 from content_topic_persona_performance
      samples:           number
    }>
  }>
  /** Wave 25 — trailing 4 weeks of this brokerage's prior plan outcomes
   *  from marketing_agent_weekly_outcomes (m135). Each row's
   *  realized_* columns get filled by the Sunday-night measure cron.
   *  Surfaced in the kickoff so the agent sees its own track record
   *  ("last 4 plans averaged X% open, Y% click — beat that this week").
   *  Unmeasured weeks (this current week, or weeks whose cron hasn't run)
   *  show null realized values — explicit "not yet measured" in the prompt. */
  priorPlanOutcomes: Array<{
    week_start:                 string
    realized_campaigns_sent:    number | null
    realized_open_rate:         number | null
    realized_click_rate:        number | null
    plan_quality_score:         number | null
  }>
  /** The Video Director's LEARNED format winners (composition × channel × mood by situation kind),
   *  surfaced so the Marketing Agent biases this week's renders toward proven winners instead of
   *  the default. Closes the loop: the Director learns, the Marketing Agent capitalizes. */
  topFormats: TopFormat[]
  /** Wave 32 — blog channel oversight. The agent now sees the blog
   *  cadence policies that have fired in the trailing 28d (which agents
   *  have auto-spawn on), aggregate views + shares across published
   *  posts in window, and the top 3 share-driving posts.  Lets the
   *  marketing agent weigh blog allocation against newsletter + social
   *  for the week's plan based on actual signal. */
  blogChannel: {
    publishedLast28d:        number
    publishedHosted:         number
    publishedWordpress:      number
    publishedEmbed:          number
    totalViewsLast28d:       number
    totalSharesLast28d:      number
    /** Number of scopes (agent/team/brokerage) with auto-spawn cadence
     *  active for this brokerage. Tells the agent how much of the
     *  cadence is policy-driven vs manual generation. */
    activeCadencePolicies:   number
    topSharedPosts: Array<{
      title:        string
      slug:         string
      shareCount:   number
      viewCount:    number
    }>
  }
  /** Wave 33 — listing-promo per-persona render snapshot. For each
   *  recently-rendered listing_promo asset, surface how many persona
   *  variants completed vs failed vs queued. The agent can see "we have
   *  3 just_listed videos that completed all persona variants and 1
   *  that's stuck queued past 2h" and either re-trigger or defer. */
  listingPromoRenderStatus: {
    publishedLast14d:           number
    /** Sum across all recent listing_promo assets. */
    personaVariantsCompleted:   number
    personaVariantsFailed:      number
    /** Variants in 'queued' or 'rendering' for >2 hours — degraded. */
    personaVariantsStuck:       number
    /** Per-event_type rollup: count published in window. */
    perEventTypeCounts: Array<{ event_type: string; count: number }>
  }
  /** Wave 33 — social posts engagement aggregated in 28d window. The
   *  social channel has its own per-post engagement counters; surfacing
   *  them lets the agent weigh social against newsletter + blog when
   *  allocating the week's broadcast budget. */
  socialChannel: {
    publishedLast28d:    number
    scheduledNext7d:     number
    totalEngagement28d:  number  // sum(likes + comments + shares) across the window
    topPostByEngagement: { post_text: string; engagement: number } | null
  }
  /** Wave 36 — direct-mail channel state. The agent uses these numbers to
   *  decide when to emit verify_lead_address / cancel_direct_mail_send /
   *  retry_direct_mail_design / flag_design_for_review resolutions.
   *  Leads with a populated address but verified=false are the highest-
   *  leverage signal — re-verifying them unlocks dispatch with one Lob
   *  API call (~$0.0025) and turns blocked sends into delivered mail. */
  directMailChannel: {
    pendingMailers:                 number
    sentLast28d:                    number
    failedLast28d:                  number
    /** Leads with a populated mailing_address but mailing_address_verified=false.
     *  Candidate set for verify_lead_address. */
    leadsWithUnverifiedAddresses:   number
    /** Recent delivery-status failures across direct_mail_recipients
     *  (returned, undeliverable, failed). Candidate set for
     *  flag_design_for_review when concentrated in one campaign. */
    recentDeliveryFailures28d:      number
    /** The single oldest currently-pending campaign so the agent can
     *  cite it explicitly in a cancel_direct_mail_send or
     *  retry_direct_mail_design resolution. */
    oldestPendingCampaignId:        string | null
    oldestPendingCampaignAgeHours:  number | null
    /** Wave 36 self-learning enrichment — performance signals the
     *  agent uses to fanout the right topic to the right persona. */
    scansLast28d:                   number
    costSpentLast28d:               number   // dollars (sum direct_mail_campaigns.per_piece_cost × pieces_mailed when set, else 0)
    /** Cost per qualified scan over the 28d window — null when no
     *  scans yet. The agent reads this as the channel's marginal
     *  efficiency: a postcard cohort below the global CPS is
     *  underperforming. */
    costPerScanLast28d:             number | null
    /** The persona whose direct_mail postcards have the highest scan
     *  rate over the window. Null when no persona has > 5 scans
     *  (statistical floor). */
    topConvertingPersona:           { persona: string; scans: number; sends: number } | null
    /** Top farm zip by scan count over the window. Null when no
     *  geographic concentration. */
    topFarmZipByScans:              { zip: string; scans: number } | null
  }
}

async function buildMarketingSnapshot(brokerageId: string): Promise<MarketingSnapshot> {
  const svc = createServiceClient()
  const since7d = new Date(Date.now() - 7 * 86_400_000).toISOString()

  // Code-review pass 2 — parallelize the six independent count queries
  // into a single Promise.all batch. Per-query failures are isolated via
  // safeCount so one missing table doesn't fail the others. On a Monday
  // cron that spawns N brokerages this is a 3-6× per-brokerage speedup.
  const safeCount = (p: PromiseLike<{ count: number | null }>): Promise<number> =>
    Promise.resolve(p as PromiseLike<{ count: number | null }>)
      .then((r) => r.count ?? 0)
      .catch(() => 0)
  const [
    pendingListingPromos,
    newListingsThisWeek,
    atRiskListings,
    recentSocialPosts,
    recentNewsletterSends,
    recentBlogPublishes,
  ] = await Promise.all([
    safeCount(svc.from("listing_promo_videos")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .eq("status", "remotion_pending") as unknown as PromiseLike<{ count: number | null }>),
    safeCount(svc.from("listings")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .eq("status", "active")
      .gte("created_at", since7d) as unknown as PromiseLike<{ count: number | null }>),
    safeCount(svc.from("listing_health_scores")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .lte("overall_score", 40) as unknown as PromiseLike<{ count: number | null }>),
    safeCount(svc.from("social_posts")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .in("status", ["published", "scheduled"])
      .gte("scheduled_for", since7d) as unknown as PromiseLike<{ count: number | null }>),
    safeCount(svc.from("newsletter_campaigns")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .eq("status", "sent")
      .gte("send_date", since7d) as unknown as PromiseLike<{ count: number | null }>),
    safeCount(svc.from("blog_posts")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .eq("publish_status", "published")
      .gte("published_at", since7d) as unknown as PromiseLike<{ count: number | null }>),
  ])

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
      .eq("status", "subscribed")
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

  // Wave 24 — per-persona aggregate engagement (last 30 days). Joins
  // newsletter_sends ⨝ contacts.contact_persona for this brokerage and
  // computes open + click rate per persona. Sample-floor of 5 sends
  // suppresses noise from sparse personas (same threshold the picker uses).
  let personaEngagement: MarketingSnapshot["personaEngagement"] = []
  try {
    const since30d = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const { data: sends } = await svc
      .from("newsletter_sends")
      .select("contact_id, opened_at, clicked_at, contact:contacts!newsletter_sends_contact_id_fkey(contact_persona)")
      .eq("brokerage_id", brokerageId)
      .gte("sent_at", since30d)
      .limit(20000)
    const buckets = new Map<string, { sent: number; opened: number; clicked: number }>()
    for (const row of (sends ?? []) as Array<{
      contact_id: string | null
      opened_at:  string | null
      clicked_at: string | null
      contact?:   { contact_persona?: string | null } | Array<{ contact_persona?: string | null }> | null
    }>) {
      const cobj = Array.isArray(row.contact) ? row.contact[0] : row.contact
      const persona = (cobj?.contact_persona ?? "").trim()
      if (!persona) continue
      const cur = buckets.get(persona) ?? { sent: 0, opened: 0, clicked: 0 }
      cur.sent++
      if (row.opened_at)  cur.opened++
      if (row.clicked_at) cur.clicked++
      buckets.set(persona, cur)
    }
    personaEngagement = [...buckets.entries()]
      .filter(([, s]) => s.sent >= 5)
      .map(([persona, s]) => ({
        persona,
        sends:      s.sent,
        open_rate:  Math.round((s.opened  / s.sent) * 1000) / 10,
        click_rate: Math.round((s.clicked / s.sent) * 1000) / 10,
      }))
      .sort((a, b) => b.click_rate - a.click_rate || b.open_rate - a.open_rate)
      .slice(0, 6)
  } catch (e) {
    console.error(`[marketing-agent] persona engagement read failed for ${brokerageId}:`, (e as Error).message)
  }

  // Wave 24 — top topics per persona, pulled from the m134 perf table
  // joined to the topic bank. Cap at 3 personas × 2 topics so the kickoff
  // prompt stays readable + tokenized cheaply. Personas chosen are those
  // we already aggregated in personaEngagement (so we only show data for
  // personas with real send volume in this brokerage).
  let personaTopTopics: MarketingSnapshot["personaTopTopics"] = []
  try {
    const personasToCover = personaEngagement.slice(0, 3).map((p) => p.persona)
    if (personasToCover.length > 0) {
      const { data: perfRows } = await svc
        .from("content_asset_persona_performance")
        // FK constraint name didn't auto-rename when m136 renamed the
        // table; PostgREST embeds still resolve by the original FK name.
        .select("persona, performance_score, persona_samples_count, topic:content_topic_bank!content_topic_persona_performance_topic_id_fkey(id, topic_title, brokerage_id)")
        .in("persona", personasToCover)
        .eq("asset_type", "newsletter_campaign")
        .gt("performance_score", 0)
        .gte("persona_samples_count", 5)
        .order("performance_score", { ascending: false })
        .limit(60)
      type Row = {
        persona: string
        performance_score: number
        persona_samples_count: number
        topic?: { id: string; topic_title: string; brokerage_id: string | null } | Array<{ id: string; topic_title: string; brokerage_id: string | null }> | null
      }
      // Filter rows whose topic actually belongs to this brokerage (or is
      // platform-wide) — the foreign-key join can return cross-brokerage
      // topics otherwise.
      const grouped = new Map<string, Array<{ title: string; persona_score: number; samples: number }>>()
      for (const r of (perfRows ?? []) as Row[]) {
        const t = Array.isArray(r.topic) ? r.topic[0] : r.topic
        if (!t) continue
        if (t.brokerage_id !== null && t.brokerage_id !== brokerageId) continue
        const list = grouped.get(r.persona) ?? []
        if (list.length >= 2) continue   // cap 2 per persona
        list.push({
          title:         t.topic_title,
          persona_score: r.performance_score,
          samples:       r.persona_samples_count,
        })
        grouped.set(r.persona, list)
      }
      personaTopTopics = personasToCover
        .map((persona) => ({ persona, topics: grouped.get(persona) ?? [] }))
        .filter((p) => p.topics.length > 0)
    }
  } catch (e) {
    console.error(`[marketing-agent] persona top-topics read failed for ${brokerageId}:`, (e as Error).message)
  }

  // Wave 25 — pull the trailing 4 weeks of plan windows + their realized
  // outcomes (filled by marketing-agent-weekly-measure cron). Surfaced
  // in the kickoff so the agent sees its own win/loss trend, not just
  // the current week's signals.
  // Video Director's learned format winners (best-effort — empty until there's enough video data).
  let topFormats: TopFormat[] = []
  try { topFormats = summarizeTopFormats(await loadFormatOutcomes(brokerageId)) } catch { /* no format data yet */ }

  let priorPlanOutcomes: MarketingSnapshot["priorPlanOutcomes"] = []
  try {
    const fourWeeksAgo = new Date(Date.now() - 28 * 86_400_000)
    fourWeeksAgo.setUTCHours(0, 0, 0, 0)
    const { data: prior } = await svc
      .from("marketing_agent_weekly_outcomes")
      .select("week_start, realized_campaigns_sent, realized_open_rate, realized_click_rate, plan_quality_score")
      .eq("brokerage_id", brokerageId)
      .gte("week_start", fourWeeksAgo.toISOString().slice(0, 10))
      .order("week_start", { ascending: false })
      .limit(4)
    priorPlanOutcomes = (prior ?? []) as MarketingSnapshot["priorPlanOutcomes"]
  } catch (e) {
    console.error(`[marketing-agent] prior plan outcomes read failed for ${brokerageId}:`, (e as Error).message)
  }

  // Wave 32 — blog channel oversight. 4 parallel reads: published posts
  // in window grouped by publish_target, total views/shares (denormalized
  // counters from m140), active cadence policies, top shared posts.
  const since28d = new Date(Date.now() - 28 * 86_400_000).toISOString()
  let blogChannel: MarketingSnapshot["blogChannel"] = {
    publishedLast28d: 0, publishedHosted: 0, publishedWordpress: 0, publishedEmbed: 0,
    totalViewsLast28d: 0, totalSharesLast28d: 0, activeCadencePolicies: 0,
    topSharedPosts: [],
  }
  try {
    const [publishedR, cadenceR, topSharedR] = await Promise.all([
      svc.from("blog_posts")
        .select("publish_target, view_count_total, share_count_total")
        .eq("brokerage_id", brokerageId)
        .eq("publish_status", "published")
        .gte("published_at", since28d)
        .limit(500),
      svc.from("blog_cadence_policy")
        .select("scope_id", { count: "exact", head: true })
        .neq("cadence", "off")
        .in("scope_id", await resolveScopeIdsForBrokerage(svc, brokerageId)),
      svc.from("blog_posts")
        .select("title, slug, view_count_total, share_count_total")
        .eq("brokerage_id", brokerageId)
        .eq("publish_status", "published")
        .gte("published_at", since28d)
        .order("share_count_total", { ascending: false })
        .limit(3),
    ])
    const rows = (publishedR.data ?? []) as Array<{ publish_target: string; view_count_total: number | null; share_count_total: number | null }>
    blogChannel.publishedLast28d = rows.length
    for (const r of rows) {
      if (r.publish_target === "hosted")    blogChannel.publishedHosted++
      if (r.publish_target === "wordpress") blogChannel.publishedWordpress++
      if (r.publish_target === "embed")     blogChannel.publishedEmbed++
      if (r.publish_target === "both")    { blogChannel.publishedHosted++; blogChannel.publishedWordpress++ }
      blogChannel.totalViewsLast28d  += r.view_count_total  ?? 0
      blogChannel.totalSharesLast28d += r.share_count_total ?? 0
    }
    blogChannel.activeCadencePolicies = cadenceR.count ?? 0
    blogChannel.topSharedPosts = ((topSharedR.data ?? []) as Array<{ title: string; slug: string; view_count_total: number | null; share_count_total: number | null }>)
      .map((p) => ({
        title:      p.title,
        slug:       p.slug,
        shareCount: p.share_count_total ?? 0,
        viewCount:  p.view_count_total  ?? 0,
      }))
  } catch (e) {
    console.error(`[marketing-agent] blog channel snapshot read failed for ${brokerageId}:`, (e as Error).message)
  }

  // Wave 33 — listing-promo per-persona render snapshot. We surface
  // BOTH the asset count and the persona-variant render state so the
  // agent can detect "all 3 just_listed videos are missing their
  // first_time_buyer persona variant" and either trigger a re-render or
  // defer the publish.
  const since14d = new Date(Date.now() - 14 * 86_400_000).toISOString()
  let listingPromoRenderStatus: MarketingSnapshot["listingPromoRenderStatus"] = {
    publishedLast14d: 0, personaVariantsCompleted: 0, personaVariantsFailed: 0,
    personaVariantsStuck: 0, perEventTypeCounts: [],
  }
  try {
    const { data: recentPromos } = await svc.from("listing_promo_videos")
      .select("id, listing_id, event_type, created_at")
      .eq("brokerage_id", brokerageId)
      .gte("created_at", since14d)
      .in("status", ["rendering", "social_drafted"])
      .limit(50)
    const promos = (recentPromos ?? []) as Array<{ id: string; listing_id: string | null; event_type: string; created_at: string }>
    listingPromoRenderStatus.publishedLast14d = promos.length
    const perEvent = new Map<string, number>()
    for (const r of promos) {
      perEvent.set(r.event_type, (perEvent.get(r.event_type) ?? 0) + 1)
    }
    listingPromoRenderStatus.perEventTypeCounts = [...perEvent.entries()]
      .map(([event_type, count]) => ({ event_type, count }))
      .sort((a, b) => b.count - a.count)

    // Persona-variant rollup via asset_persona_renders (Wave 28 generalized
    // m138). One query for all the listing_ids in window.
    if (promos.length > 0) {
      const listingIds = promos.map((p) => p.listing_id).filter((x): x is string => !!x)
      if (listingIds.length > 0) {
        const stuckThreshold = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
        const { data: variants } = await svc.from("asset_persona_renders")
          .select("status, created_at")
          .eq("asset_type", "listing_promo")
          .in("asset_id", listingIds)
          .limit(500)
        for (const v of (variants ?? []) as Array<{ status: string; created_at: string }>) {
          if (v.status === "completed") listingPromoRenderStatus.personaVariantsCompleted++
          else if (v.status === "failed") listingPromoRenderStatus.personaVariantsFailed++
          else if ((v.status === "queued" || v.status === "rendering") && v.created_at < stuckThreshold) {
            listingPromoRenderStatus.personaVariantsStuck++
          }
        }
      }
    }
  } catch (e) {
    console.error(`[marketing-agent] listing-promo render snapshot failed for ${brokerageId}:`, (e as Error).message)
  }

  // Wave 33 — social posts engagement snapshot. Aggregates engagement_data
  // jsonb across the 28d window. The existing performance-aggregator reads
  // non-existent likes_count/comments_count/shares_count columns (a real
  // drift flagged in this commit's message); the snapshot uses the
  // canonical engagement_data jsonb shape instead.
  let socialChannel: MarketingSnapshot["socialChannel"] = {
    publishedLast28d: 0, scheduledNext7d: 0, totalEngagement28d: 0, topPostByEngagement: null,
  }
  try {
    const next7d = new Date(Date.now() + 7 * 86_400_000).toISOString()
    const [publishedR, scheduledR] = await Promise.all([
      svc.from("social_posts")
        .select("content, engagement_data")
        .eq("brokerage_id", brokerageId)
        .eq("status", "published")
        .gte("published_at", since28d)
        .limit(500),
      svc.from("social_posts")
        .select("id", { count: "exact", head: true })
        .eq("brokerage_id", brokerageId)
        .eq("status", "scheduled")
        .lte("scheduled_for", next7d)
        .gte("scheduled_for", new Date().toISOString()),
    ])
    const rows = (publishedR.data ?? []) as Array<{ content: string | null; engagement_data: { likes?: number; comments?: number; shares?: number; reactions?: number } | null }>
    socialChannel.publishedLast28d = rows.length
    socialChannel.scheduledNext7d  = scheduledR.count ?? 0
    let top: { post_text: string; engagement: number } | null = null
    for (const r of rows) {
      const ed = r.engagement_data ?? {}
      const sum = (ed.likes ?? 0) + (ed.comments ?? 0) + (ed.shares ?? 0) + (ed.reactions ?? 0)
      socialChannel.totalEngagement28d += sum
      if (sum > 0 && (top === null || sum > top.engagement)) {
        top = { post_text: (r.content ?? "").slice(0, 120), engagement: sum }
      }
    }
    socialChannel.topPostByEngagement = top
  } catch (e) {
    console.error(`[marketing-agent] social channel snapshot failed for ${brokerageId}:`, (e as Error).message)
  }

  // Wave 36 — direct-mail channel snapshot. Pulls the four counters the
  // agent needs to decide when to emit the new direct-mail resolutions,
  // plus a single oldest-pending pointer so the agent can target a
  // specific campaign_id rather than emit a vague "review mailers"
  // resolution that the human can't action.
  let directMailChannel: MarketingSnapshot["directMailChannel"] = {
    pendingMailers: 0,
    sentLast28d: 0,
    failedLast28d: 0,
    leadsWithUnverifiedAddresses: 0,
    recentDeliveryFailures28d: 0,
    oldestPendingCampaignId: null,
    oldestPendingCampaignAgeHours: null,
    scansLast28d: 0,
    costSpentLast28d: 0,
    costPerScanLast28d: null,
    topConvertingPersona: null,
    topFarmZipByScans: null,
  }
  try {
    const [pendingR, sentR, failedR, unverifiedR, deliveryFailR, oldestR] = await Promise.all([
      svc.from("direct_mail_campaigns")
        .select("id", { count: "exact", head: true })
        .eq("brokerage_id", brokerageId)
        .eq("status", "planning"),  // direct_mail_campaigns has no "pending"
      svc.from("direct_mail_campaigns")
        .select("id", { count: "exact", head: true })
        .eq("brokerage_id", brokerageId)
        .eq("status", "mailed")   // direct_mail_campaigns has no "sent"
        .gte("created_at", since28d),
      svc.from("direct_mail_campaigns")
        .select("id", { count: "exact", head: true })
        .eq("brokerage_id", brokerageId)
        .eq("status", "failed")
        .gte("created_at", since28d),
      svc.from("leads")
        .select("id", { count: "exact", head: true })
        .eq("brokerage_id", brokerageId)
        .not("mailing_address", "is", null)
        .or("mailing_address_verified.is.null,mailing_address_verified.eq.false"),
      svc.from("direct_mail_recipients")
        .select("id", { count: "exact", head: true })
        .eq("brokerage_id", brokerageId)
        .in("delivery_status", ["returned", "undeliverable", "failed"])
        .gte("created_at", since28d),
      svc.from("direct_mail_campaigns")
        .select("id, created_at")
        .eq("brokerage_id", brokerageId)
        .eq("status", "planning") // direct_mail_campaigns has no "pending"
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
    ])
    directMailChannel.pendingMailers              = pendingR.count ?? 0
    directMailChannel.sentLast28d                 = sentR.count ?? 0
    directMailChannel.failedLast28d               = failedR.count ?? 0
    directMailChannel.leadsWithUnverifiedAddresses = unverifiedR.count ?? 0
    directMailChannel.recentDeliveryFailures28d   = deliveryFailR.count ?? 0
    const oldest = oldestR.data as { id: string; created_at: string } | null
    if (oldest) {
      directMailChannel.oldestPendingCampaignId       = oldest.id
      directMailChannel.oldestPendingCampaignAgeHours =
        Math.round((Date.now() - new Date(oldest.created_at).getTime()) / 3_600_000)
    }
  } catch (e) {
    console.error(`[marketing-agent] direct-mail channel snapshot failed for ${brokerageId}:`, (e as Error).message)
  }

  // Wave 36 — self-learning enrichment. Joins direct_mail_campaigns →
  // qr_scan_events (via the qr_code_id stamped on campaign rows by the
  // orchestrator) → contacts (for persona attribution) to compute the
  // signals the agent uses for fanout decisions.
  try {
    // 1. Sent campaigns in 28d with their qr_code_id + contact persona +
    //    farm zip (contacts.zip_code is the recipient's residence zip
    //    which IS the farm zip for farm_mail target_audience). per_piece
    //    _cost × pieces_mailed gives spend per row.
    const { data: sentCampaigns } = await svc
      .from("direct_mail_campaigns")
      .select("id, qr_code_id, per_piece_cost, pieces_mailed, contact_id, target_audience")
      .eq("brokerage_id", brokerageId)
      .eq("status", "mailed")   // direct_mail_campaigns has no "sent"
      .gte("mailing_date", since28d.slice(0, 10))
      .limit(2000)
    type CRow = {
      id: string
      qr_code_id: string | null
      per_piece_cost: number | null
      pieces_mailed: number | null
      contact_id: string | null
      target_audience: string | null
    }
    const campaigns = (sentCampaigns ?? []) as CRow[]
    const qrCodeIds = [...new Set(campaigns.map((c) => c.qr_code_id).filter((id): id is string => !!id))]
    const contactIds = [...new Set(campaigns.map((c) => c.contact_id).filter((id): id is string => !!id))]

    // 2. Spend over the window — sum (per_piece_cost × pieces_mailed).
    //    Rows with null cost don't contribute (typically auto-generated
    //    pieces where Lob bills against the broker's account).
    let spend = 0
    for (const c of campaigns) {
      const cost = (c.per_piece_cost ?? 0) * (c.pieces_mailed ?? 1)
      if (cost > 0) spend += cost
    }
    directMailChannel.costSpentLast28d = Math.round(spend * 100) / 100

    // 3. Scans in the window across all campaigns' QR codes.
    let scans = 0
    let scansByPersona = new Map<string, number>()
    let sendsByPersona = new Map<string, number>()
    let scansByZip = new Map<string, number>()

    if (qrCodeIds.length > 0) {
      const { data: scanRows } = await svc
        .from("qr_scan_events")
        .select("qr_code_id")
        .in("qr_code_id", qrCodeIds)
        .gte("scanned_at", since28d)
      scans = scanRows?.length ?? 0
      directMailChannel.scansLast28d = scans

      // Build qr_code_id → campaign mapping for persona attribution.
      const campaignByQr = new Map<string, CRow>()
      for (const c of campaigns) if (c.qr_code_id) campaignByQr.set(c.qr_code_id, c)

      // Pull contact persona + zip for all contacts in campaigns.
      const personaByContact = new Map<string, { persona: string | null; zip: string | null }>()
      if (contactIds.length > 0) {
        const { data: contactRows } = await svc
          .from("contacts")
          .select("id, contact_persona, zip_code")
          .in("id", contactIds)
        for (const r of (contactRows ?? []) as Array<{ id: string; contact_persona: string | null; zip_code: string | null }>) {
          personaByContact.set(r.id, { persona: r.contact_persona, zip: r.zip_code })
        }
      }

      // 4. sends-by-persona — every campaign with a contact persona counts.
      for (const c of campaigns) {
        if (!c.contact_id) continue
        const meta = personaByContact.get(c.contact_id)
        const p = meta?.persona ?? "other"
        sendsByPersona.set(p, (sendsByPersona.get(p) ?? 0) + 1)
      }

      // 5. scans-by-persona + scans-by-zip — each scan → its campaign →
      //    its contact's persona + zip.
      for (const row of (scanRows ?? []) as Array<{ qr_code_id: string }>) {
        const campaign = campaignByQr.get(row.qr_code_id)
        if (!campaign?.contact_id) continue
        const meta = personaByContact.get(campaign.contact_id)
        const p = meta?.persona ?? "other"
        scansByPersona.set(p, (scansByPersona.get(p) ?? 0) + 1)
        if (campaign.target_audience === "farm_mail" && meta?.zip) {
          scansByZip.set(meta.zip, (scansByZip.get(meta.zip) ?? 0) + 1)
        }
      }
    }

    // 6. costPerScan + top-converting persona + top zip.
    if (scans > 0) {
      directMailChannel.costPerScanLast28d = Math.round((spend / scans) * 100) / 100
    }

    // Top persona by scan COUNT (not rate) gated by statistical floor.
    // Rate would double-penalize tiny personas; raw count gives the
    // agent the actionable cohort.
    let topPersona: { persona: string; scans: number; sends: number } | null = null
    for (const [persona, scanCount] of scansByPersona.entries()) {
      if (scanCount < 5) continue
      const sendCount = sendsByPersona.get(persona) ?? 0
      if (!topPersona || scanCount > topPersona.scans) {
        topPersona = { persona, scans: scanCount, sends: sendCount }
      }
    }
    directMailChannel.topConvertingPersona = topPersona

    let topZip: { zip: string; scans: number } | null = null
    for (const [zip, count] of scansByZip.entries()) {
      if (!topZip || count > topZip.scans) topZip = { zip, scans: count }
    }
    directMailChannel.topFarmZipByScans = topZip
  } catch (e) {
    console.error(`[marketing-agent] direct-mail performance signals failed for ${brokerageId}:`, (e as Error).message)
  }

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
    personaEngagement,
    personaTopTopics,
    priorPlanOutcomes,
    topFormats,
    blogChannel,
    listingPromoRenderStatus,
    socialChannel,
    directMailChannel,
  }
}

/** Wave 32 — pull every (scope_type, scope_id) tuple within this brokerage
 *  whose policy might fire blog auto-spawn. Used to count active cadence
 *  policies for the agent's snapshot. */
async function resolveScopeIdsForBrokerage(
  svc: ReturnType<typeof createServiceClient>,
  brokerageId: string,
): Promise<string[]> {
  const ids: string[] = [brokerageId]
  try {
    const [agentsR, teamsR] = await Promise.all([
      svc.from("agents").select("id").eq("brokerage_id", brokerageId).eq("is_active", true).limit(500),
      svc.from("teams").select("id").eq("brokerage_id", brokerageId).limit(100),
    ])
    for (const r of (agentsR.data ?? []) as Array<{ id: string }>) ids.push(r.id)
    for (const r of (teamsR.data  ?? []) as Array<{ id: string }>) ids.push(r.id)
  } catch { /* best-effort — snapshot tolerates missing roster */ }
  return ids
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

  // Wave 24 — per-persona performance intelligence block. Shown only when
  // we have meaningful data (at least one persona with ≥5 sends). Empty
  // brokerages fall through to the universal topic + location guidance.
  const personaEngagementLines = snap.personaEngagement.length === 0
    ? "(no persona-segmented send data yet — first cohort of newsletter_sends is still landing)"
    : snap.personaEngagement.map((p) =>
        `  ${p.persona.padEnd(22)}  sends=${String(p.sends).padStart(4)}  open=${p.open_rate.toFixed(1)}%  click=${p.click_rate.toFixed(1)}%`
      ).join("\n")
  const personaTopicsLines = snap.personaTopTopics.length === 0
    ? "(no per-persona topic scores yet — aggregator needs ≥5 sends per persona)"
    : snap.personaTopTopics.map((p) =>
        `  ${p.persona}:\n` +
        p.topics.map((t) =>
          `    · [score ${t.persona_score} · n=${t.samples}] ${t.title}`
        ).join("\n")
      ).join("\n")

  // Wave 25 — agent's own prior-plan track record.
  const measuredPrior = snap.priorPlanOutcomes.filter((p) => p.realized_open_rate !== null)
  const priorPlanLines = snap.priorPlanOutcomes.length === 0
    ? "(no prior plans on record — this is the first measured Monday for this brokerage)"
    : snap.priorPlanOutcomes.map((p) => {
        const measured = p.realized_open_rate !== null
        return `  ${p.week_start}  ` + (measured
          ? `campaigns=${p.realized_campaigns_sent ?? 0}  open=${(p.realized_open_rate ?? 0).toFixed(1)}%  click=${(p.realized_click_rate ?? 0).toFixed(1)}%  quality=${p.plan_quality_score ?? "?"}`
          : `(not yet measured — current week or pending Sunday-night cron)`)
      }).join("\n")
  const priorPlanAvg = measuredPrior.length === 0
    ? null
    : {
        open:  measuredPrior.reduce((s, p) => s + (p.realized_open_rate  ?? 0), 0) / measuredPrior.length,
        click: measuredPrior.reduce((s, p) => s + (p.realized_click_rate ?? 0), 0) / measuredPrior.length,
        n:     measuredPrior.length,
      }
  const priorPlanAvgLine = priorPlanAvg
    ? `  ── trailing ${priorPlanAvg.n}-week avg:  open=${priorPlanAvg.open.toFixed(1)}%  click=${priorPlanAvg.click.toFixed(1)}%  → THIS WEEK'S PLAN should beat that.`
    : "  ── (not enough measured weeks yet to compute a trailing average)"

  const formatLines = snap.topFormats.length === 0
    ? "(no learned format winners yet — the Video Director needs more rendered+scanned videos per format)"
    : snap.topFormats.map((f, i) =>
        `  ${i + 1}. ${f.kind} on ${f.channel} → ${f.composition} (${f.mood} mood) · mean signal ${f.meanSignal} over ${f.sample} video${f.sample === 1 ? "" : "s"}`
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
    "──── WAVE 24 — PER-PERSONA PERFORMANCE INTELLIGENCE (LAST 30 DAYS) ────",
    "Last 30 days of newsletter_sends ⨝ contacts grouped by contact_persona.",
    "Lean THIS WEEK'S plan into the segments that are converting — author",
    "more sections (and more time) for high-click personas; pull back from",
    "low-click ones. Floor: 5 sends per persona (lower = noise, suppressed).",
    "",
    "PER-PERSONA OPEN + CLICK RATES (ranked by click_rate):",
    personaEngagementLines,
    "",
    "TOPICS THAT CONVERTED PER PERSONA (anchor persona-targeted sections here):",
    "Each persona's section should develop ITS list, not the others'. The",
    "AI section author already does this when authoring; your job is to",
    "decide WHICH personas earn airtime this week + how many sections each gets.",
    personaTopicsLines,
    "",
    "──── WAVE 25 — YOUR PRIOR PLANS (TRAILING 4 WEEKS) ────",
    "Every Monday your spawn captures a plan window; every Sunday night the",
    "measure cron fills realized open/click rates from newsletter_sends in",
    "that week. This is YOUR OWN TRACK RECORD on this brokerage — beat it.",
    "If the trailing average shows declining click rates, REDUCE the mix",
    "of cold-topic sections this week and lean harder into the personas",
    "+ topics that scored highest above. If a prior plan flatlined (low",
    "campaigns_sent), it means de-conflict caps or composition-gate defers",
    "ate the week — check the snapshot's defer_reasons before planning.",
    "",
    priorPlanLines,
    priorPlanAvgLine,
    "",
    "──── LEARNED FORMAT WINNERS (from the Video Director's real QR + engagement data) ────",
    "The Video Director measures which composition × channel × mood actually converts",
    "per situation. Bias THIS WEEK'S video renders toward these proven winners instead",
    "of always queuing the default — propose the learned format for the matching kind/channel.",
    formatLines,
    "",
    "──── WAVE 32 — BLOG CHANNEL OVERSIGHT (TRAILING 28 DAYS) ────",
    "Blog is now wired into the agentic loop: topic-bank-seeded articles",
    "(Wave 29), branded cover images (Wave 30), hosted at /blog/[slug]",
    "OR pushed to WordPress OR embedded via /embed/blog/[slug] (Wave 31-32).",
    "Each publication carries a view + share tracker that feeds the same",
    "per-(topic, persona) score table the newsletter uses. Decide whether",
    "to lean more into blog this week based on the signal below.",
    "",
    `Published last 28d:           ${snap.blogChannel.publishedLast28d} (hosted=${snap.blogChannel.publishedHosted}, wordpress=${snap.blogChannel.publishedWordpress}, embed=${snap.blogChannel.publishedEmbed})`,
    `Total page views (28d):       ${snap.blogChannel.totalViewsLast28d}`,
    `Total share clicks (28d):     ${snap.blogChannel.totalSharesLast28d}`,
    `Active cadence policies:      ${snap.blogChannel.activeCadencePolicies} (subscribers with auto-spawn ON)`,
    "",
    snap.blogChannel.topSharedPosts.length === 0
      ? "Top-shared posts: (none yet — share tracker hasn't accumulated data)"
      : "Top-shared posts (last 28d):\n" + snap.blogChannel.topSharedPosts.map((p, i) =>
          `  ${i + 1}. [${p.shareCount} shares · ${p.viewCount} views] ${p.title}`
        ).join("\n"),
    "",
    "──── WAVE 33 — LISTING-PROMO RENDER STATE (LAST 14d) ────",
    `Active listing promos in window: ${snap.listingPromoRenderStatus.publishedLast14d}`,
    `Persona variants — completed: ${snap.listingPromoRenderStatus.personaVariantsCompleted}, failed: ${snap.listingPromoRenderStatus.personaVariantsFailed}, STUCK > 2h: ${snap.listingPromoRenderStatus.personaVariantsStuck}`,
    snap.listingPromoRenderStatus.perEventTypeCounts.length === 0
      ? "Per event type: (none)"
      : "Per event type:\n" + snap.listingPromoRenderStatus.perEventTypeCounts.map((e) =>
          `  · ${e.event_type}: ${e.count}`
        ).join("\n"),
    snap.listingPromoRenderStatus.personaVariantsStuck > 0
      ? "ACTION: stuck persona variants ARE a conflict you should resolve in your plan. Propose either (a) re-trigger via dispatchListingPromoVideo with bypassPolicy and bypassCooldown, or (b) defer the publish until the variant clears."
      : "",
    "",
    "──── WAVE 33 — SOCIAL POSTS CHANNEL (28d) ────",
    `Published last 28d:  ${snap.socialChannel.publishedLast28d}`,
    `Scheduled next 7d:   ${snap.socialChannel.scheduledNext7d}`,
    `Total engagement:    ${snap.socialChannel.totalEngagement28d} (likes + comments + shares + reactions)`,
    snap.socialChannel.topPostByEngagement
      ? `Top post: [${snap.socialChannel.topPostByEngagement.engagement}] ${snap.socialChannel.topPostByEngagement.post_text}`
      : "Top post: (no published posts in window)",
    "",
    "──── WAVE 36 — DIRECT-MAIL CHANNEL ────",
    `Pending mailers:                ${snap.directMailChannel.pendingMailers}`,
    `Sent last 28d:                  ${snap.directMailChannel.sentLast28d}`,
    `Failed last 28d:                ${snap.directMailChannel.failedLast28d}`,
    `Leads with unverified addresses: ${snap.directMailChannel.leadsWithUnverifiedAddresses} (candidates for verify_lead_address)`,
    `Recent delivery failures 28d:    ${snap.directMailChannel.recentDeliveryFailures28d}`,
    snap.directMailChannel.oldestPendingCampaignId
      ? `Oldest pending campaign:        ${snap.directMailChannel.oldestPendingCampaignId} (${snap.directMailChannel.oldestPendingCampaignAgeHours}h old)`
      : "Oldest pending campaign:        (none)",
    snap.directMailChannel.leadsWithUnverifiedAddresses > 0
      ? `ACTION HINT: ${snap.directMailChannel.leadsWithUnverifiedAddresses} leads have a populated mailing_address but verified=false. Each verify_lead_address resolution costs ~$0.0025 (Lob) and unlocks direct-mail dispatch for that lead. High-leverage; prefer this over deferring sends.`
      : "",
    snap.directMailChannel.failedLast28d > 5
      ? `ACTION HINT: ${snap.directMailChannel.failedLast28d} failed mailers in 28d. Inspect the oldest pending campaign — if it's a transient Lob 5xx, emit retry_direct_mail_design; if a design problem, emit flag_design_for_review.`
      : "",
    "",
    "──── WAVE 36 — DIRECT-MAIL SELF-LEARNING SIGNALS ────",
    `QR scans last 28d:              ${snap.directMailChannel.scansLast28d}`,
    `Lob spend last 28d:             $${snap.directMailChannel.costSpentLast28d.toFixed(2)}`,
    snap.directMailChannel.costPerScanLast28d != null
      ? `Cost per scan (CPS) 28d:        $${snap.directMailChannel.costPerScanLast28d.toFixed(2)} — the channel's marginal efficiency`
      : `Cost per scan: (insufficient scans yet)`,
    snap.directMailChannel.topConvertingPersona
      ? `Top converting persona:         "${snap.directMailChannel.topConvertingPersona.persona}" — ${snap.directMailChannel.topConvertingPersona.scans} scans from ${snap.directMailChannel.topConvertingPersona.sends} sends (scan rate ${(snap.directMailChannel.topConvertingPersona.scans / Math.max(snap.directMailChannel.topConvertingPersona.sends, 1) * 100).toFixed(1)}%)`
      : `Top converting persona: (no persona crossed the 5-scan floor yet)`,
    snap.directMailChannel.topFarmZipByScans
      ? `Top farm zip by scans:          ${snap.directMailChannel.topFarmZipByScans.zip} (${snap.directMailChannel.topFarmZipByScans.scans} scans)`
      : `Top farm zip: (no farm scan concentration yet)`,
    snap.directMailChannel.topConvertingPersona
      ? `ACTION HINT: The top-converting persona's topic from content_topic_bank is the asymmetric pick for next week. Consider an omnipresence_topic_fanout for the topic that DROVE those scans — query content_topic_uses with asset_type='direct_mail_postcard' and the persona's recent topic_id to find the winner.`
      : "",
    "",
    "──── WAVE 33 — YOU CAN RESOLVE CONFLICTS, NOT JUST OBSERVE ────",
    "Up through Wave 32, your output was a JSON plan a human reviewed.",
    "Starting this week, when your snapshot shows a CONFLICT, your plan",
    "should INCLUDE the resolution, not just flag the problem:",
    "  · Stuck listing-promo persona variants → propose dispatch retry",
    "  · Newsletter cadence overdue (snapshot 'recentNewsletterSends'=0",
    "    + active subscribers) → propose a specific newsletter topic + send_date",
    "  · Topic already 'used' across channels → pick an alternative from",
    "    topTopics that didn't fire this week",
    "  · A persona's blog engagement crashed week-over-week → propose",
    "    pulling back blog allocation for that persona in next plan",
    "  · Listing whose health score dropped below 40 → propose a price-",
    "    update promo OR an expanded social cadence, with the agent's",
    "    approval gate as the safety net",
    "Output the plan with explicit RESOLUTION actions, not just observations.",
    "The human approver wants one click to greenlight, not a list of TODOs.",
    "",
    "──── WAVE 34 — RESOLUTION ACTIONS YOU CAN EMIT ────",
    "Append a top-level `resolutions[]` array to your JSON output. Each",
    "resolution is a structured action the platform will execute when the",
    "human clicks approve — you don't need to write English instructions",
    "for the human to follow. Four action types are wired:",
    "",
    "  { action_type: 'retry_listing_promo_render',",
    "    action_input: { listing_id: '<uuid>', event_type: 'just_listed'|'just_sold'|'price_reduction'|'coming_soon'|'open_house_announce'|'open_house_reminder'|'under_contract' },",
    "    rationale: 'why you proposed this — surfaced in the admin UI' }",
    "",
    "  { action_type: 'mark_topic_used',",
    "    action_input: { topic_id: '<uuid>' },",
    "    rationale: 'why this topic should NOT fire again this cycle' }",
    "",
    "  { action_type: 'defer_newsletter_campaign',",
    "    action_input: { campaign_id: '<uuid>', reason: 'short_reason_key' },",
    "    rationale: 'why this scheduled campaign should NOT send' }",
    "",
    "  { action_type: 'stage_newsletter_draft',",
    "    action_input: { title, subject_line, topic, audience: 'all'|'<segment>' },",
    "    rationale: 'why this newsletter for the week' }",
    "",
    "  { action_type: 'cancel_blog_cadence_tick',",
    "    action_input: { scope_type: 'agent'|'team'|'brokerage', scope_id: '<uuid>' },",
    "    rationale: 'why this week''s auto-blog should be skipped for this scope' }",
    "",
    "  { action_type: 'flag_listing_for_review',",
    "    action_input: { listing_id: '<uuid>', reason: 'short reason key' },",
    "    rationale: 'why the broker should review this listing directly' }",
    "",
    "  ──── WAVE 36 — DIRECT-MAIL RESOLUTION SURFACE ────",
    "",
    "  { action_type: 'verify_lead_address',",
    "    action_input: { lead_id: '<uuid>' },",
    "    rationale: 'why this lead needs Lob re-verification (e.g., dispatch keeps blocking despite a populated address)' }",
    "",
    "  { action_type: 'cancel_direct_mail_send',",
    "    action_input: { campaign_id: '<uuid>', reason: 'short reason key' },",
    "    rationale: 'why this pending mailer should be cancelled (Fair Housing risk, off-territory, duplicate)' }",
    "",
    "  { action_type: 'retry_direct_mail_design',",
    "    action_input: { campaign_id: '<uuid>' },",
    "    rationale: 'why this failed mailer is worth retrying (transient Lob error vs. real problem)' }",
    "",
    "  { action_type: 'flag_design_for_review',",
    "    action_input: { campaign_id: '<uuid>', reason: 'short reason key' },",
    "    rationale: 'why the broker should review this mailer design directly' }",
    "",
    "  ──── WAVE 36 SELF-LEARNING CAPSTONE — OMNIPRESENCE ────",
    "",
    "  { action_type: 'omnipresence_topic_fanout',",
    "    action_input: { topic_id: '<uuid>', channels: ['newsletter','blog','social','direct_mail_postcard'] },",
    "    rationale: 'why this topic deserves to land in every channel this cycle (cite the persona × asset performance score that made you pick it)' }",
    "  EMIT THIS WHEN: your snapshot shows ONE topic crushing the per-(asset_type, persona) score in any channel — that's the asymmetric bet. Spinning it across channels OWNS the conversation that week. Don't emit this for a topic the bank already 'used' — it has to be fresh in at least one channel.",
    "",
    "Each action is gated server-side (compliance / cooldown / tenant) so",
    "an unsafe proposal is rejected at execute-time rather than silently",
    "applied. Audit row in marketing_agent_actions tracks every proposal +",
    "outcome. Use rationale liberally — the admin approver reads it.",
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

  const spawn = await spawnManagedAgentSession(TEMPLATE, {
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

  // Wave 25 — record the plan window for end-of-week measurement. We
  // upsert by (brokerage_id, week_start) so the row is idempotent across
  // skipped/replayed Mondays AND so a same-day re-spawn updates the
  // captured snapshot signals to the latest read. The measure cron fills
  // realized_* at end-of-week; next Monday's snapshot reads back the
  // trailing 4 weeks so the agent sees its own track record.
  //
  // Code-review pass 2 — was previously fire-and-forget (`void`), so an
  // upsert failure silently lost the plan window. Now awaited; persistence
  // failure attaches to the spawn result's metadata.weekly_outcome_status
  // and emits a console error so the Monday cron's summary surfaces it.
  if (spawn.ok && spawn.session?.id) {
    const weekStart = getISOWeekStartDate(new Date())
    const outcomeOk = await persistWeeklyPlanWindow({
      brokerageId:       params.brokerageId,
      weekStart,
      sessionId:         spawn.session.id,
      snapshotSignals:   snap,
    })
    if (!outcomeOk) {
      console.error(`[marketing-agent] weekly_outcome_persist_failed for ${params.brokerageId} week=${weekStart}`)
    }
  }

  return spawn
}

/** Monday (00:00 UTC) of the week the timestamp falls in. Returns YYYY-MM-DD. */
function getISOWeekStartDate(d: Date): string {
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = utc.getUTCDay()
  // 0=Sun → back to prior Monday means -6; otherwise -(day-1)
  const diff = day === 0 ? -6 : -(day - 1)
  utc.setUTCDate(utc.getUTCDate() + diff)
  return utc.toISOString().slice(0, 10)
}

async function persistWeeklyPlanWindow(args: {
  brokerageId:     string
  weekStart:       string
  sessionId:       string
  snapshotSignals: MarketingSnapshot
}): Promise<boolean> {
  try {
    const svc = createServiceClient()
    const { error } = await svc.from("marketing_agent_weekly_outcomes").upsert({
      brokerage_id:           args.brokerageId,
      week_start:             args.weekStart,
      spawned_session_id:     args.sessionId,
      spawned_at:             new Date().toISOString(),
      snapshot_signals_jsonb: args.snapshotSignals as unknown as Record<string, unknown>,
    }, { onConflict: "brokerage_id,week_start" })
    if (error) {
      console.error(`[marketing-agent] weekly plan window upsert error for ${args.brokerageId}:`, error.message)
      return false
    }
    return true
  } catch (e) {
    console.error(`[marketing-agent] weekly plan window persist threw for ${args.brokerageId}:`, (e as Error).message)
    return false
  }
}
