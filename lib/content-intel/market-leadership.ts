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
// WHAT IT DOES NOT HAVE, SAID PLAINLY: no dedicated local-EVENTS source exists in the repo (no events provider, no events
// table). Local events are inferred ONLY from geo-tagged topic-bank rows whose text names an event; the blind spot is
// published beside the opportunities. A real events feed is WAITING_EXTERNAL (provider choice + credentials — owner).
//
// Not server-only: scripts/intent-driven-followup-guard.ts drives the PURE half. The loader takes an injected client.

import { citationShare, type CitationShare, type ShareObservationRow } from "@/lib/geo/citation-share"
import type { CitationOutcome } from "@/lib/kernel/ai-search-citation-monitor"

type Svc = { from: (table: string) => any }

export type LeadershipFormat = "blog" | "social" | "newsletter" | "video" | "podcast"

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
  formats: LeadershipFormat[]
  /** An instruction to the writing managers — original, local, brand-voiced; never copy. */
  brief: string
}

export const LEADERSHIP_KIND_ORDER: readonly LeadershipKind[] = ["ai_search_gap", "competitor_gap", "reputation_theme", "double_down", "local_event"]

const ORIGINALITY = "Make it ORIGINAL and local: draw on this brokerage's own listings, closings and market knowledge; never copy or paraphrase a competitor's material; run it through the normal brand-voice and fair-housing gates and the approval step before anything is published."
const EVENT_WORDS = /\b(festival|fair|parade|concert|market day|farmers market|marathon|open house tour|street party|block party|fundraiser|expo|tour of homes|parade of homes|ribbon cutting|grand opening)\b/i

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
        formats: ["blog", "video", "newsletter"],
        brief: `Publish direct, citable answers (clear question → specific local answer, with sources and the agent's own data) to the buyer and seller questions where ${top.name} is being cited and we are not. ${ORIGINALITY}`,
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
      formats: ["social", "video", "blog"],
      brief: `Create your own take on "${topic}" with a point of view only this brokerage can offer. ${ORIGINALITY}`,
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
      formats: ["blog", "newsletter"],
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
      formats: ["social", "video", "podcast"],
      brief: `Build on what is already working: a fresh, different angle on "${best.topic}" in another format — not a repeat. ${ORIGINALITY}`,
    })
  }

  // 5. LOCAL EVENT — only what the scrapers actually found. Strength = how many separate event topics there are.
  if (sig.localEvents.length > 0) {
    out.push({
      kind: "local_event",
      title: `${sig.localEvents.length} local event topic(s) in the market`,
      evidence: sig.localEvents.slice(0, 4).map((e) => e.title),
      strength: clamp(sig.localEvents.length * 15),
      formats: ["social", "newsletter", "video"],
      brief: `Be present in the community moment: a genuinely useful local guide or recap tied to these events. ${ORIGINALITY}`,
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
    lines.push(`  ${i + 1}. [${o.strength}] ${o.title} — formats: ${o.formats.join(", ")}`)
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

  // Local events — the only evidence: geo-tagged scraped topics that name an event.
  {
    const { data, error } = await svc.from("content_topic_bank").select("topic_title, source_url, geo_relevance, brokerage_id")
      .or(`brokerage_id.eq.${brokerageId},brokerage_id.is.null`).not("geo_relevance", "is", null).gte("scraped_at", since).limit(300)
    if (error) sig.blindSpots.push(`local topics not read (${error.message})`)
    else sig.localEvents = (data as Array<{ topic_title: string; source_url: string | null }>).filter((r) => EVENT_WORDS.test(r.topic_title)).map((r) => ({ title: r.topic_title, sourceUrl: r.source_url }))
  }
  sig.blindSpots.push("local events: no dedicated events feed is connected (WAITING_EXTERNAL — provider + credentials); events are inferred only from geo-tagged scraped topics")
  return sig
}
