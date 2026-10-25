// lib/content-intel/market-leadership.ts
// ─────────────────────────────────────────────────────────────────────────────
// MARKET LEADERSHIP — the intelligence that makes the brokerage the obvious answer in its market (wave 143, lane 143E).
//
// OWNER / LANE BRIEF (143E.3): "Market leadership / omnipresence: topic suggestions, AI-search visibility, competitor
// intelligence, content performance, local events → original marketing through existing campaign / media / marketing
// managers; no generic hard-coded content as the strategy."
//
// WHAT ALREADY EXISTED (audited, reused — not rebuilt):
//   · topic suggestions   lib/content-intel/topic-bank.ts + the Exa / Reddit / RSS / NewsAPI / Apify scrapers →
//                         content_topic_bank; lib/agents/marketing-agent.ts feeds `topTopics` to the weekly planner.
//   · AI-search visibility lib/kernel/ai-search-citation-monitor.ts writes ai_search_citation_observations;
//                         lib/geo/citation-share.ts turns them into citation rate + share of voice. READ BY: the geo
//                         dashboards only — the weekly marketing planner never saw it.
//   · competitor intel    lib/competitive-intel/content-intel-scan.ts → competitor_content (organic posts + engagement);
//                         lib/competitive-intel/brand-listening.ts → brand_mentions (sentiment, topics). READ BY: their own
//                         screens — the weekly planner never saw them.
//   · content performance content_topic_uses × content_topic_bank.performance_score (lib/content-intel/performance-aggregator.ts).
//   · the planner         lib/agents/marketing-agent.ts (campaign_orchestrator's 1:many weekly job): composes the existing
//                         blog / social / newsletter / video / podcast managers and never auto-publishes.
// THE GAP (one-sided data): four of the five intelligence streams had writers and screens but NO reader in the loop that
// decides what to make this week. This module is that reader — it reads each survivor, ranks opportunities BY THE
// EVIDENCE'S OWN MAGNITUDE, and hands the planner EVIDENCE + A BRIEF for original content. It writes no copy, creates no
// content and publishes nothing: the planner's managers write original pieces through their existing rails (brand voice,
// fair-housing gate, approval before any external publication).
//
// LOCAL EVENTS (superseded in wave 144): this header used to say no local-events source existed and that events were
// inferred from geo-tagged topic-bank headlines naming one (WAITING_EXTERNAL). Lane 144G built the source — the
// local-intelligence pass stores verified, dated, source-attributed local facts — and the loader now reads ONLY those
// (lib/content-intel/local-intel.ts loadLocalFacts). A tenant with no stored fact gets a published blind spot, never
// an inferred event.
//
// Not server-only: scripts/intent-driven-followup-guard.ts drives the PURE half. The loader takes an injected client.

//
// ── WAVE 144 (lane 144F, owner ruling 12) — FORMAT ≠ CHANNEL, AND THE TWO THAT WERE MISSING ────────────────────────────────
// "Leadership/campaign format is missing direct mail and possibly ads. Never conflate a creative format with a delivery channel."
// The old `LeadershipFormat = blog | social | newsletter | video | podcast` was FOUR channels and ONE format in one list (blog /
// social / newsletter / podcast are CampaignChannelKeys in lib/campaigns/channels.ts; a video is a payload those channels carry).
// Each opportunity now names BOTH, separately: `formats` (WHAT is made — an article, a short video, a printed postcard …) and
// `channels` (HOW it travels — the campaign taxonomy's own keys). DIRECT MAIL joins where the ontology fits (a local, physical,
// community piece: the local-event guide and the proven-topic piece, mailed to the brokerage's own farm), and ADS joins only where
// paid reach serves the evidence (an AI-search / competitor visibility gap) — each with the gate it rides named in the brief:
// a mailed piece goes through the CASS / opt-out gate and the approval step; an ad goes through the Ads Manager's housing
// special-ad-category rules and a human's approval before any spend. Nothing here sends, spends or publishes.

import { citationShare, type CitationShare, type ShareObservationRow } from "@/lib/geo/citation-share"
import type { CitationOutcome } from "@/lib/kernel/ai-search-citation-monitor"
import { CAMPAIGN_CHANNELS, type CampaignChannelKey } from "@/lib/campaigns/channels"

type Svc = { from: (table: string) => any }

/** WHAT the writing managers make — a creative format, never a delivery channel. */
export type LeadershipFormat = "article" | "short_video" | "avatar_video" | "audio_episode" | "social_post" | "newsletter_issue" | "postcard" | "letter" | "ad_creative"

/** HOW it travels — the campaign taxonomy's own keys (lib/campaigns/channels.ts), never a second spelling. */
export type LeadershipChannel = Extract<CampaignChannelKey, "blog" | "social" | "newsletter" | "podcast" | "direct_mail" | "ads" | "email">

/** The formats each channel can carry (a format with no carrier on the opportunity is refused by leadershipPlacement). */
const CHANNEL_CARRIES: Readonly<Record<LeadershipChannel, readonly LeadershipFormat[]>> = Object.freeze({
  blog: ["article", "short_video", "avatar_video"],
  social: ["social_post", "short_video", "avatar_video"],
  newsletter: ["newsletter_issue", "article", "short_video", "avatar_video"],
  podcast: ["audio_episode"],
  direct_mail: ["postcard", "letter"],
  ads: ["ad_creative", "short_video"],
  email: ["newsletter_issue", "article", "short_video", "avatar_video"],
})

/** The gate each channel rides before anything leaves (shown in the brief so the planner never skips one). */
const CHANNEL_GATE: Readonly<Partial<Record<LeadershipChannel, string>>> = Object.freeze({
  direct_mail: "Direct mail: to the brokerage's own consented farm / sphere list only — the CASS address check, mail opt-outs and the approval step run before print (lib/providers/dispatch.ts dispatchDirectMail).",
  ads: "Ads: the Ads Manager's housing special-ad-category rules (no age / ZIP / gender targeting for housing), a budget, and a human's approval before any spend — an ad is a proposal here, never a launch.",
})

/**
 * PURE. An opportunity's formats and channels, checked against each other and against the taxonomy: every channel is a real
 * CampaignChannelKey, every format rides at least one of the opportunity's channels. Throws on a drift (a programming error, caught
 * by the proof), never on data.
 */
function leadershipPlacement(formats: LeadershipFormat[], channels: LeadershipChannel[]): { formats: LeadershipFormat[]; channels: LeadershipChannel[] } {
  const known = new Set(CAMPAIGN_CHANNELS.map((c) => c.key as string))
  for (const ch of channels) if (!known.has(ch)) throw new Error(`market-leadership: "${ch}" is not a campaign channel`)
  for (const f of formats) if (!channels.some((ch) => CHANNEL_CARRIES[ch].includes(f))) throw new Error(`market-leadership: format "${f}" rides none of ${channels.join("/")}`)
  return { formats, channels }
}

/** The gates the opportunity's channels ride, as brief sentences. */
const gatesFor = (channels: readonly LeadershipChannel[]): string => channels.map((c) => CHANNEL_GATE[c]).filter(Boolean).join(" ")

export interface CompetitorMove { competitor: string | null; platform: string | null; topics: string[]; hook: string | null; engagement: number | null }

export interface LeadershipSignals {
  /** Share of AI-search answers that name us vs others (null = the monitor has not read an answer yet). */
  aiVisibility: CitationShare | null
  competitorMoves: CompetitorMove[]
  mentions: { total: number; negative: number; negativeTopics: Array<{ topic: string; count: number }> } | null
  ownPerformance: Array<{ assetType: string; topic: string; performance: number }>
  /** Event-like, geo-tagged scraped topics (the only local-event evidence there is). */
  localEvents: Array<{ title: string; sourceUrl: string | null }>
  /** What could not be read / does not exist — published beside the opportunities, never silent. */
  blindSpots: string[]
}

export type LeadershipKind = "ai_search_gap" | "competitor_gap" | "reputation_theme" | "double_down" | "local_event"

export interface LeadershipOpportunity {
  kind: LeadershipKind
  title: string
  /** The measured facts the opportunity rests on (shown to the planner verbatim). */
  evidence: string[]
  /** The evidence's own magnitude, 0..100 — the sort key (ties: LEADERSHIP_KIND_ORDER). */
  strength: number
  /** WHAT to make (creative formats). */
  formats: LeadershipFormat[]
  /** HOW it travels (campaign-taxonomy channels) — a separate list from the formats, by ruling. */
  channels: LeadershipChannel[]
  /** An instruction to the writing managers — original, local, brand-voiced; never copy. */
  brief: string
}

export const LEADERSHIP_KIND_ORDER: readonly LeadershipKind[] = ["ai_search_gap", "competitor_gap", "reputation_theme", "double_down", "local_event"]

const ORIGINALITY = "Make it ORIGINAL and local: draw on this brokerage's own listings, closings and market knowledge; never copy or paraphrase a competitor's material; run it through the normal brand-voice and fair-housing gates and the approval step before anything is published."
// Tombstone (wave 144, lane 144F on lane 144G's hand-off): EVENT_WORDS — the keyword list that guessed an event from a scraped
// headline — is deleted; local events are read from verified local facts in loadMarketLeadershipSignals below
// (lib/content-intel/local-intel.ts loadLocalFacts). Nothing else read it.

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)))

/**
 * PURE. Ranked, evidence-backed opportunities from the signals. Nothing here is a fixed content plan: with no signals the
 * list is EMPTY (the planner then says so and uses the topic bank) — it never invents an opportunity to fill a week.
 */
export function rankLeadershipOpportunities(sig: LeadershipSignals): LeadershipOpportunity[] {
  const out: LeadershipOpportunity[] = []

  // 1. AI-SEARCH GAP — a rival named in answers more than we are. Strength = the points of share they hold over us.
  const v = sig.aiVisibility
  if (v && v.queriesChecked > 0 && v.topCompetitors.length > 0) {
    const ours = v.shareOfVoicePct ?? 0
    const top = v.topCompetitors[0]
    if (top.sharePct > ours) {
      out.push({
        kind: "ai_search_gap",
        title: `${top.name} is named in AI answers more than we are`,
        evidence: [
          `${v.queriesChecked} AI answers read; we were named in ${v.queriesCited} (citation rate ${v.citationRatePct ?? "n/a"}%)`,
          `share of voice: us ${v.shareOfVoicePct ?? "n/a"}% vs ${top.name} ${top.sharePct}% (${top.citations} answers)`,
          ...(v.queriesNotChecked > 0 ? [`${v.queriesNotChecked} answers could not be read — a monitoring gap, not a miss`] : []),
        ],
        strength: clamp(top.sharePct - ours),
        ...leadershipPlacement(["article", "short_video", "newsletter_issue", "ad_creative"], ["blog", "newsletter", "ads"]),
        brief: `Publish direct, citable answers (clear question → specific local answer, with sources and the agent's own data) to the buyer and seller questions where ${top.name} is being cited and we are not. ${ORIGINALITY} ${gatesFor(["ads"])}`,
      })
    }
  }

  // 2. COMPETITOR GAP — topics where rivals' posts perform. Strength = how many distinct rivals' posts touch the topic.
  const byTopic = new Map<string, { moves: CompetitorMove[]; engagement: number }>()
  for (const m of sig.competitorMoves) {
    for (const t of m.topics) {
      const e = byTopic.get(t) ?? { moves: [], engagement: 0 }
      e.moves.push(m)
      e.engagement += m.engagement ?? 0
      byTopic.set(t, e)
    }
  }
  const topics = [...byTopic.entries()].sort((a, b) => b[1].moves.length - a[1].moves.length || b[1].engagement - a[1].engagement)
  for (const [topic, e] of topics.slice(0, 3)) {
    const rivals = [...new Set(e.moves.map((m) => m.competitor).filter((c): c is string => !!c))]
    out.push({
      kind: "competitor_gap",
      title: `Competitors are winning attention on "${topic}"`,
      evidence: [`${e.moves.length} high-performing competitor post(s)${rivals.length ? ` from ${rivals.slice(0, 3).join(", ")}` : ""}`, ...[...new Set(e.moves.map((m) => m.hook).filter((h): h is string => !!h))].slice(0, 2).map((h) => `hook style seen: ${h}`)],
      strength: clamp(e.moves.length * 20),
      ...leadershipPlacement(["social_post", "short_video", "article", "ad_creative"], ["social", "blog", "ads"]),
      brief: `Create your own take on "${topic}" with a point of view only this brokerage can offer. ${ORIGINALITY} ${gatesFor(["ads"])}`,
    })
  }

  // 3. REPUTATION THEME — what people complain about in public mentions. Strength = the share of mentions that are negative.
  const m = sig.mentions
  if (m && m.negative > 0 && m.negativeTopics.length > 0) {
    const t = m.negativeTopics[0]
    out.push({
      kind: "reputation_theme",
      title: `A recurring public concern: "${t.topic}"`,
      evidence: [`${m.negative} of ${m.total} recent public mentions were negative; "${t.topic}" appears in ${t.count}`],
      strength: clamp((m.negative / Math.max(1, m.total)) * 100),
      ...leadershipPlacement(["article", "newsletter_issue"], ["blog", "newsletter"]),
      brief: `Address "${t.topic}" honestly and helpfully for the people searching it — explain how this brokerage handles it. Do not respond to or name any reviewer. ${ORIGINALITY}`,
    })
  }

  // 4. DOUBLE DOWN — the brokerage's own best performers. Strength = the topic's measured performance score.
  const best = [...sig.ownPerformance].sort((a, b) => b.performance - a.performance)[0]
  if (best && best.performance > 0) {
    out.push({
      kind: "double_down",
      title: `"${best.topic}" performs for us as ${best.assetType}`,
      evidence: [`measured performance ${best.performance} on ${best.assetType}`],
      strength: clamp(best.performance),
      ...leadershipPlacement(["social_post", "short_video", "audio_episode", "postcard"], ["social", "podcast", "direct_mail"]),
      brief: `Build on what is already working: a fresh, different angle on "${best.topic}" in another format — not a repeat. ${ORIGINALITY} ${gatesFor(["direct_mail"])}`,
    })
  }

  // 5. LOCAL EVENT — only what the scrapers actually found. Strength = how many separate event topics there are.
  if (sig.localEvents.length > 0) {
    out.push({
      kind: "local_event",
      title: `${sig.localEvents.length} local event topic(s) in the market`,
      evidence: sig.localEvents.slice(0, 4).map((e) => e.title),
      strength: clamp(sig.localEvents.length * 15),
      ...leadershipPlacement(["social_post", "newsletter_issue", "short_video", "postcard"], ["social", "newsletter", "direct_mail"]),
      brief: `Be present in the community moment: a genuinely useful local guide or recap tied to these events. ${ORIGINALITY} ${gatesFor(["direct_mail"])}`,
    })
  }

  return out.sort((a, b) => b.strength - a.strength || LEADERSHIP_KIND_ORDER.indexOf(a.kind) - LEADERSHIP_KIND_ORDER.indexOf(b.kind))
}

/** PURE. The kickoff section the weekly planner reads — evidence, briefs and blind spots, never copy. */
export function renderLeadershipBriefForKickoff(sig: LeadershipSignals, opps: LeadershipOpportunity[]): string {
  const lines: string[] = [
    "──── MARKET LEADERSHIP — WHAT THE MARKET IS TELLING US (AI-SEARCH, COMPETITORS, REPUTATION, PERFORMANCE, LOCAL) ────",
    "Ranked by the strength of the evidence, not by a template. Each item names the facts behind it and a brief for ORIGINAL content;",
    "the managers write it (brand voice, fair-housing gate, approval before any publication). If a week has nothing here, say so.",
  ]
  if (opps.length === 0) lines.push("(no leadership signal this week — use the topic bank and the brokerage's own listings and closings)")
  opps.slice(0, 5).forEach((o, i) => {
    lines.push(`  ${i + 1}. [${o.strength}] ${o.title} — make: ${o.formats.join(", ")} · via: ${o.channels.join(", ")}`)
    for (const e of o.evidence) lines.push(`       · ${e}`)
    lines.push(`       → ${o.brief}`)
  })
  if (sig.blindSpots.length > 0) {
    lines.push("BLIND SPOTS (not read, or no source exists):")
    for (const b of sig.blindSpots) lines.push(`  · ${b}`)
  }
  return lines.join("\n")
}

// ── the loader — every stream through its survivor reader ──────────────────────────────────

/** A refused read is a published blind spot, never an empty stream that reads as "nothing happening". */
export async function loadMarketLeadershipSignals(svc: Svc, brokerageId: string, now: Date = new Date(), opts: { windowDays?: number } = {}): Promise<LeadershipSignals> {
  const sig: LeadershipSignals = { aiVisibility: null, competitorMoves: [], mentions: null, ownPerformance: [], localEvents: [], blindSpots: [] }
  if (!brokerageId) { sig.blindSpots.push("no brokerage — nothing was read"); return sig }
  const since = new Date(now.getTime() - (opts.windowDays ?? 30) * 86_400_000).toISOString()
  const sinceDay = since.slice(0, 10)

  // AI-search visibility (the monitor's rows → the share KPI)
  {
    const { data, error } = await svc.from("ai_search_citation_observations")
      .select("project_id, observed_on, outcome, competitors_cited").eq("brokerage_id", brokerageId).gte("observed_on", sinceDay).limit(2000)
    if (error) sig.blindSpots.push(`AI-search visibility not read (${error.message})`)
    else if ((data ?? []).length === 0) sig.blindSpots.push("AI-search visibility: the citation monitor has recorded no answers yet")
    else {
      const rows: ShareObservationRow[] = (data as Array<{ project_id: string; observed_on: string; outcome: CitationOutcome; competitors_cited: string[] | null }>)
        .map((r) => ({ pageId: r.project_id, observedOn: r.observed_on, outcome: r.outcome, competitorsCited: r.competitors_cited }))
      sig.aiVisibility = citationShare(rows)
    }
  }

  // Competitor intelligence (high-performing rival posts)
  {
    const { data, error } = await svc.from("competitor_content")
      .select("competitor_id, platform, detected_topics, hook_type, engagement_rate, is_high_performing, observed_at")
      .eq("brokerage_id", brokerageId).eq("is_high_performing", true).gte("observed_at", since).limit(200)
    if (error) sig.blindSpots.push(`competitor content not read (${error.message})`)
    else if ((data ?? []).length === 0) sig.blindSpots.push("competitor intelligence: no high-performing competitor posts observed in the window")
    else {
      const ids = [...new Set((data as Array<{ competitor_id: string | null }>).map((r) => r.competitor_id).filter((x): x is string => !!x))]
      const names = new Map<string, string>()
      if (ids.length > 0) {
        const { data: comps, error: compErr } = await svc.from("competitor_brokerages").select("id, competitor_name").eq("brokerage_id", brokerageId).in("id", ids)
        if (compErr) sig.blindSpots.push(`competitor names not read (${compErr.message})`)
        for (const c of (comps ?? []) as Array<{ id: string; competitor_name: string }>) names.set(c.id, c.competitor_name)
      }
      sig.competitorMoves = (data as Array<{ competitor_id: string | null; platform: string | null; detected_topics: string[] | null; hook_type: string | null; engagement_rate: number | null }>)
        .map((r) => ({ competitor: r.competitor_id ? (names.get(r.competitor_id) ?? null) : null, platform: r.platform, topics: Array.isArray(r.detected_topics) ? r.detected_topics.filter((t) => typeof t === "string") : [], hook: r.hook_type, engagement: typeof r.engagement_rate === "number" ? r.engagement_rate : null }))
    }
  }

  // Reputation (public mentions)
  {
    const { data, error } = await svc.from("brand_mentions").select("sentiment, topics").eq("brokerage_id", brokerageId).gte("captured_at", since).limit(500)
    if (error) sig.blindSpots.push(`brand mentions not read (${error.message})`)
    else if ((data ?? []).length === 0) sig.blindSpots.push("reputation: no public mentions captured in the window")
    else {
      const rows = data as Array<{ sentiment: string | null; topics: string[] | null }>
      const neg = rows.filter((r) => r.sentiment === "negative")
      const counts = new Map<string, number>()
      for (const r of neg) for (const t of r.topics ?? []) counts.set(t, (counts.get(t) ?? 0) + 1)
      sig.mentions = { total: rows.length, negative: neg.length, negativeTopics: [...counts.entries()].map(([topic, count]) => ({ topic, count })).sort((a, b) => b.count - a.count) }
    }
  }

  // Own content performance (what we made, how the topic did). Two plain reads instead of an embed: the topic bank rows are
  // fetched by id, tenant-pinned through the uses that named them.
  {
    const { data: uses, error } = await svc.from("content_topic_uses")
      .select("topic_id, asset_type").eq("brokerage_id", brokerageId).gte("used_at", since).limit(300)
    if (error) sig.blindSpots.push(`own content performance not read (${error.message})`)
    else {
      const useRows = (uses ?? []) as Array<{ topic_id: string | null; asset_type: string }>
      const ids = [...new Set(useRows.map((u) => u.topic_id).filter((x): x is string => !!x))]
      if (ids.length === 0) sig.blindSpots.push("content performance: no topic uses in the window")
      else {
        const { data: topics, error: topicErr } = await svc.from("content_topic_bank").select("id, topic_title, performance_score").in("id", ids)
        if (topicErr) sig.blindSpots.push(`topic performance not read (${topicErr.message})`)
        else {
          const byId = new Map(((topics ?? []) as Array<{ id: string; topic_title: string; performance_score: number | null }>).map((t) => [t.id, t]))
          sig.ownPerformance = useRows
            .map((u) => ({ u, t: u.topic_id ? byId.get(u.topic_id) : undefined }))
            .filter((x) => x.t && typeof x.t.performance_score === "number")
            .map((x) => ({ assetType: x.u.asset_type, topic: x.t!.topic_title, performance: x.t!.performance_score as number }))
          if (sig.ownPerformance.length === 0) sig.blindSpots.push("content performance: no scored topic uses in the window")
        }
      }
    }
  }

  // Local events — VERIFIED local facts only (wave 144, lane 144G hand-off): THE reader of the local-intelligence pass's stored
  // facts (lib/content-intel/local-intel.ts loadLocalFacts — tenant-pinned, source-attributed, dated). Upcoming / ongoing
  // local_event facts only; a news item, an expired event or an undated "current" fact is not an event to plan around.
  // Survivor note: this replaces the EVENT_WORDS keyword inference over geo-tagged scraped topics (a headline that NAMED a
  // festival was read as an event, with no date and no verification) and its "no dedicated events feed … WAITING_EXTERNAL"
  // blind spot — the feed now exists; its absence for a tenant is the blind spot below.
  {
    const { loadLocalFacts } = await import("@/lib/content-intel/local-intel")
    const local = await loadLocalFacts(svc, brokerageId, { now, limit: 20 })
    if (local.error) sig.blindSpots.push(`local events not read (${local.error})`)
    else {
      sig.localEvents = local.facts.filter((f) => f.kind === "local_event" && (f.temporal === "upcoming" || f.temporal === "ongoing"))
        .map((f) => ({ title: f.eventStart ? `${f.title} (${f.eventStart})` : f.title, sourceUrl: f.url }))
      if (!local.facts.length) sig.blindSpots.push("local events: the local-intelligence pass has stored no verified fact for this tenant's territories yet (needs an active territory and a web-search / news key, or a configured calendar feed)")
    }
  }
  return sig
}
