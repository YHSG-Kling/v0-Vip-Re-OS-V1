// lib/content-intel/topic-intelligence.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE TOPIC BANK GATHERS EVERY KIND OF VERIFIED INTELLIGENCE (wave 145, lane 145G — owner ruling 22, 2026-10-27: "Supposed to
// include all topics from competitor ads and post topics that are viral, etc. tenants need to dominate and become the top of
// market expert from educational to market/local property values").
//
// THE SURVIVOR IS THE ONE POOL. content_topic_bank (lib/content-intel/topic-bank.ts pickTopics) is what every writer already
// reads — newsletter, blog, podcast, topic video, contact reels, social cadence, farm mail, lead-magnet suggestions, the book
// creator, the weekly planner — and the TV lane (lib/marketing/ctv-lane.ts) now too. Several sources already fed it (the census
// below). Five did NOT, although their data sat in this OS with a writer and no topic reader:
//   · competitor PUBLIC POST themes — competitor_content (lib/competitive-intel/content-intel-scan.ts) was read only by its own
//     screen and the leadership planner;
//   · HIGH-ENGAGEMENT / VIRAL PATTERNS — which format + hook outperformed a competitor's own typical post;
//   · CUSTOMER QUESTIONS — what this tenant's own inbound messages and listing inquiries keep asking;
//   · EDUCATION GAPS — questions customers ask that no education module of the tenant covers;
//   · AI-SEARCH / DISCOVERY GAPS — the questions the AI-search monitor asks on the tenant's behalf where the answer names a
//     competitor and not the tenant (ai_search_citation_observations, lib/kernel/ai-search-citation-monitor.ts);
//   · PROPERTY-VALUE TRENDS and MARKET CHANGES — the tenant's own market statistics (market_data).
// This pass reads each survivor (tenant-pinned, every refusal read and SAID as a blind spot), extracts THEMES — never the
// creative, never a message's words, never a private metric — and files them in the ONE pool under the tenant's own system
// source (lib/content-intel/system-topic-source.ts 'topic_intelligence'; the tenant's off switch), with the evidence the ruling
// names on every row (raw_data.topic_evidence): source, timestamp, the ACCESSIBLE engagement evidence (and its basis — a
// public count, a search-ranking proxy, an internal count), confidence and its basis. The strongest new themes are proposed as
// ORIGINAL campaign ideas PENDING a human's approval in the ONE approval queue (approval_items, the 144Z pattern); an approved
// topic is what the TV lane may use (contract C5).
//
// NEVER: a competitor's caption, headline or copy stored or reused (themes only; a theme is a topic label); a customer's
// words, name or id in a topic (counts only, and only once ≥ MIN_DISTINCT_ASKERS different people asked — one person's
// question never becomes public content); a private competitor metric (counts the platform cannot see are NULL and said);
// a steering topic (crime / safety, school ratings, religious congregations, demographic composition — the ONE exclusion list,
// lib/content-intel/local-intel.ts EXCLUDED_TOPIC_RULES); a valuation (a market statistic is never a home's value); a promise
// of rank, virality or revenue.
//
// The PURE half (census, theme vocabulary, extractors) is lib/content-intel/topic-themes.ts; this file is the pass (I/O).
// Not server-only: scripts/content-distribution-guard.ts drives the pure half and the pass on an in-memory client.

import { resolveSystemTopicSource } from "./system-topic-source"
import {
  competitorPostThemes, viralPatternThemes, customerQuestionThemes, educationGapThemes, aiSearchGapThemes, marketThemes,
  type CitationRow, type CompetitorContentRow, type IntelTheme, type MarketDataRow, type ModuleRow, type QuestionRow,
  type TopicEvidence, type TopicFeed, type TopicSourceClass,
} from "./topic-themes"

type Db = { from: (table: string) => any }

// ── The pass (I/O) ────────────────────────────────────────────────────────────────────────────────

export interface TopicIntelligenceResult {
  brokerageId: string
  ran: boolean
  /** Themes filed (new rows) / refreshed (existing fresh rows) per source class. */
  inserted: number
  refreshed: number
  bySource: Partial<Record<TopicSourceClass, number>>
  dropped: Record<string, number>
  proposedIdeas: number
  /** Themes filed for a person's TV approval (contract C5). */
  proposedTv: number
  /** What could not be read — published beside the counts, never silent. */
  blindSpots: string[]
  errors: string[]
}

const DAY_MS = 86_400_000

/**
 * One tenant's topic-intelligence pass: read each survivor, extract themes, file them in the ONE pool under the tenant's own
 * system source (idempotent per theme while fresh: a repeat refreshes the evidence instead of duplicating), then propose the
 * strongest new themes as campaign ideas PENDING approval. Tenant-pinned everywhere; never throws.
 */
export async function runTopicIntelligencePass(db: Db, brokerageId: string, opts: { now?: Date; maxIdeas?: number } = {}): Promise<TopicIntelligenceResult> {
  const now = opts.now ?? new Date()
  const out: TopicIntelligenceResult = { brokerageId, ran: false, inserted: 0, refreshed: 0, bySource: {}, dropped: {}, proposedIdeas: 0, proposedTv: 0, blindSpots: [], errors: [] }
  const addDropped = (d: Record<string, number>) => { for (const [k, v] of Object.entries(d)) out.dropped[k] = (out.dropped[k] ?? 0) + v }
  try {
    if (!brokerageId) { out.errors.push("no tenant"); return out }
    const src = await resolveSystemTopicSource(db, brokerageId, "topic_intelligence")
    if (!src.ok) { out.errors.push(`topic source unavailable — nothing filed: ${src.error}`); return out }
    if (!src.active) { out.blindSpots.push("the tenant switched the topic-intelligence source off — nothing filed"); return out }
    out.ran = true
    const since30 = new Date(now.getTime() - 30 * DAY_MS).toISOString()
    const themes: IntelTheme[] = []

    // Competitor public posts → themes + high-engagement patterns.
    {
      const { data, error } = await db.from("competitor_content")
        .select("competitor_id, platform, content_type, content_url, detected_topics, hook_type, engagement_rate, is_high_performing, likes_count, comments_count, shares_count, views_count, observed_at, posted_at")
        .eq("brokerage_id", brokerageId).gte("observed_at", since30).limit(500)
      if (error) out.blindSpots.push(`competitor posts not read (${error.message ?? "unknown"})`)
      else if ((data ?? []).length === 0) out.blindSpots.push("competitor posts: none observed in the last 30 days (needs a competitor watchlist + the content-intel scan)")
      else {
        const rows = data as CompetitorContentRow[]
        const posts = competitorPostThemes(rows, now)
        addDropped(posts.dropped)
        themes.push(...posts.themes, ...viralPatternThemes(rows, now))
      }
    }
    // Customer questions (inbound messages + listing inquiries) → themes, then education gaps against the modules.
    let askersByTheme = new Map<string, number>()
    {
      const q: QuestionRow[] = []
      const { data: msgs, error: msgErr } = await db.from("messages").select("contact_id, body, created_at")
        .eq("brokerage_id", brokerageId).eq("direction", "inbound").gte("created_at", since30).limit(500)
      if (msgErr) out.blindSpots.push(`inbound messages not read (${msgErr.message ?? "unknown"})`)
      else for (const m of (msgs ?? []) as Array<{ contact_id: string | null; body: string | null; created_at: string | null }>) q.push({ contact_key: m.contact_id ? `c:${m.contact_id}` : null, text: m.body, at: m.created_at })
      const { data: inq, error: inqErr } = await db.from("listing_inquiries").select("email, phone, message, created_at")
        .eq("brokerage_id", brokerageId).gte("created_at", since30).limit(500)
      if (inqErr) out.blindSpots.push(`listing inquiries not read (${inqErr.message ?? "unknown"})`)
      else for (const m of (inq ?? []) as Array<{ email: string | null; phone: string | null; message: string | null; created_at: string | null }>) q.push({ contact_key: m.email ? `e:${m.email.toLowerCase()}` : m.phone ? `p:${m.phone}` : null, text: m.message, at: m.created_at })
      if (q.length === 0 && !msgErr && !inqErr) out.blindSpots.push("customer questions: no inbound messages or inquiries in the last 30 days")
      const cq = customerQuestionThemes(q, now)
      askersByTheme = cq.askersByTheme
      addDropped(cq.dropped)
      themes.push(...cq.themes)
      if (!msgErr && !inqErr) {
        const { data: mods, error: modErr } = await db.from("learning_modules").select("title, summary, gap_tags, status")
          .or(`brokerage_id.is.null,brokerage_id.eq.${brokerageId}`).limit(500)
        if (modErr) out.blindSpots.push(`education modules not read — no education gap judged (${modErr.message ?? "unknown"})`)
        else themes.push(...educationGapThemes(askersByTheme, (mods ?? []) as ModuleRow[], now))
      }
    }
    // AI-search gaps.
    {
      const { data, error } = await db.from("ai_search_citation_observations").select("query, outcome, competitors_cited, platform, observed_at")
        .eq("brokerage_id", brokerageId).gte("observed_at", since30).limit(2000)
      if (error) out.blindSpots.push(`AI-search observations not read (${error.message ?? "unknown"})`)
      else if ((data ?? []).length === 0) out.blindSpots.push("AI-search gaps: the citation monitor has recorded no answers in the last 30 days")
      else themes.push(...aiSearchGapThemes(data as CitationRow[], now))
    }
    // Property-value trends + market changes (the tenant's own market statistics).
    {
      const { data, error } = await db.from("market_data")
        .select("zip_code, city, state, market_area, data_date, source_type, median_sale_price, price_trend_pct_1yr, months_of_inventory, avg_days_on_market")
        .eq("brokerage_id", brokerageId).order("data_date", { ascending: false }).limit(200)
      if (error) out.blindSpots.push(`market statistics not read (${error.message ?? "unknown"})`)
      else if ((data ?? []).length === 0) out.blindSpots.push("property values / market changes: no market statistics recorded for this tenant")
      else { const m = marketThemes(data as MarketDataRow[], now); addDropped(m.dropped); themes.push(...m.themes) }
    }

    // File in the ONE pool (idempotent per theme while fresh), under the tenant's system source.
    const { data: bank, error: bankErr } = await db.from("content_topic_bank").select("id, raw_data, source_url")
      .eq("brokerage_id", brokerageId).eq("source_id", src.id).gte("expires_at", now.toISOString())
    if (bankErr) { out.errors.push(`content_topic_bank read refused — nothing filed: ${bankErr.message ?? "unknown"}`); return out }
    const existing = new Map<string, string>()
    const urlsTaken = new Set<string>()
    for (const r of (bank ?? []) as Array<{ id: string; raw_data: { topic_evidence?: { theme_key?: string } } | null; source_url: string | null }>) {
      const k = r.raw_data?.topic_evidence?.theme_key
      if (k) existing.set(k, r.id)
      if (r.source_url) urlsTaken.add(r.source_url)
    }
    const filed: Array<{ id: string; theme: IntelTheme; isNew: boolean }> = []
    for (const t of themes) {
      const expiresAt = new Date(now.getTime() + t.expiresDays * DAY_MS).toISOString()
      const rawData = { topic_evidence: t.evidence }
      const prior = existing.get(t.evidence.theme_key)
      if (prior) {
        const { data, error } = await db.from("content_topic_bank").update({ value_angle: t.valueAngle, engagement_score: t.engagementScore, scraped_at: now.toISOString(), expires_at: expiresAt, raw_data: rawData, categories: t.categories })
          .eq("id", prior).eq("brokerage_id", brokerageId).select("id")
        if (error || (data ?? []).length !== 1) out.errors.push(`refresh refused (${t.evidence.theme_key}): ${error?.message ?? "matched no row"}`)
        else { out.refreshed++; filed.push({ id: prior, theme: t, isNew: false }) }
        continue
      }
      const sourceUrl = t.sourceUrl && !urlsTaken.has(t.sourceUrl) ? t.sourceUrl : null
      if (sourceUrl) urlsTaken.add(sourceUrl)
      const { data, error } = await db.from("content_topic_bank").insert({
        source_id: src.id, brokerage_id: brokerageId, topic_title: t.title, value_angle: t.valueAngle, source_url: sourceUrl,
        categories: t.categories, engagement_score: t.engagementScore, topic_posted_at: t.topicPostedAt, scraped_at: now.toISOString(),
        expires_at: expiresAt, status: "fresh", geo_relevance: t.geo, raw_data: rawData,
      }).select("id")
      const row = ((data ?? []) as Array<{ id: string }>)[0]
      if (error || !row) { out.errors.push(`insert refused (${t.evidence.theme_key}): ${error?.message ?? "no row"}`); continue }
      out.inserted++
      out.bySource[t.evidence.source_class] = (out.bySource[t.evidence.source_class] ?? 0) + 1
      existing.set(t.evidence.theme_key, row.id)
      filed.push({ id: row.id, theme: t, isNew: true })
    }

    // The strongest NEW themes → original campaign ideas PENDING a human's approval.
    const proposals = filed.filter((f) => f.isNew).sort((a, b) => b.theme.engagementScore * b.theme.evidence.confidence - a.theme.engagementScore * a.theme.evidence.confidence)
    const ideas = await proposeTopicCampaignIdeas(db, brokerageId, proposals.map((p) => ({ topicId: p.id, title: p.theme.title, valueAngle: p.theme.valueAngle, feeds: p.theme.evidence.feeds })), { now, max: opts.maxIdeas ?? 3 })
    out.proposedIdeas = ideas.proposed
    if (ideas.error) out.errors.push(`campaign ideas: ${ideas.error}`)
    // …and the single strongest new theme that SUITS a TV spot is filed for a person's TV approval (contract C5 — the TV lane
    // and the Ads Manager's gateway both read that approval; the budget and the launch are approved separately).
    const { proposeCtvTopic, topicSuitsTv } = await import("@/lib/marketing/ctv-lane")
    const tv = proposals.find((p) => topicSuitsTv({ categories: p.theme.categories, evidence: p.theme.evidence }))
    if (tv) {
      const filedTv = await proposeCtvTopic(db, brokerageId, { id: tv.id, title: tv.theme.title, valueAngle: tv.theme.valueAngle, categories: tv.theme.categories, evidence: tv.theme.evidence }, { now })
      if (filedTv.error) out.errors.push(`TV approval: ${filedTv.error}`)
      else if (filedTv.proposed) out.proposedTv++
    }
    return out
  } catch (e) {
    out.errors.push(`runTopicIntelligencePass threw: ${(e as Error)?.message ?? String(e)}`)
    return out
  }
}

// ── TOPIC → ORIGINAL CAMPAIGN IDEA → HUMAN APPROVAL (the 144Z pattern, generalised from local facts to every topic) ───

/** approval_items.item_type for an intelligence topic's campaign idea (item_id = content_topic_bank.id). */
export const TOPIC_CAMPAIGN_IDEA_ITEM_TYPE = "topic_campaign_idea"

/**
 * File campaign ideas as PENDING approval items (idempotent per topic: a topic that already has an idea row — pending,
 * approved or rejected — is never re-proposed). Counted insert; never throws.
 */
async function proposeTopicCampaignIdeas(db: Db, brokerageId: string, candidates: ReadonlyArray<{ topicId: string; title: string; valueAngle: string; feeds: readonly TopicFeed[] }>, opts: { now?: Date; max?: number } = {}): Promise<{ proposed: number; existing: number; error: string | null }> {
  const now = opts.now ?? new Date()
  try {
    const pick = candidates.slice(0, Math.min(opts.max ?? 3, 10))
    if (pick.length === 0) return { proposed: 0, existing: 0, error: null }
    const { data: prior, error: priorErr } = await db.from("approval_items").select("item_id")
      .eq("brokerage_id", brokerageId).eq("item_type", TOPIC_CAMPAIGN_IDEA_ITEM_TYPE).in("item_id", pick.map((c) => c.topicId))
    if (priorErr) return { proposed: 0, existing: 0, error: `approval_items read refused: ${priorErr.message ?? "unknown"}` }
    const seen = new Set(((prior ?? []) as Array<{ item_id: string | null }>).map((r) => r.item_id))
    const fresh = pick.filter((c) => !seen.has(c.topicId))
    if (fresh.length === 0) return { proposed: 0, existing: pick.length, error: null }
    const { data: ins, error: insErr } = await db.from("approval_items").insert(fresh.map((c) => ({
      brokerage_id: brokerageId, agent_id: null, item_type: TOPIC_CAMPAIGN_IDEA_ITEM_TYPE, item_id: c.topicId, status: "pending", submitted_at: now.toISOString(),
      review_notes: JSON.stringify({ violations: [], excerpt: `${c.title} — ${c.valueAngle} Formats: ${c.feeds.join(", ")}. Each piece made from it still goes through its own approval before it is published.`.slice(0, 500) }),
    }))).select("id")
    if (insErr) return { proposed: 0, existing: pick.length - fresh.length, error: `approval_items insert refused: ${insErr.message ?? "unknown"}` }
    const n = (ins ?? []).length
    return { proposed: n, existing: pick.length - fresh.length, error: n === fresh.length ? null : `approval_items insert returned ${n} of ${fresh.length} rows` }
  } catch (e) {
    return { proposed: 0, existing: 0, error: `proposeTopicCampaignIdeas threw: ${(e as Error)?.message ?? String(e)}` }
  }
}

/** The idea item types a PERSON approves a topic through (local facts — 144Z — and every other intelligence topic). */
export const TOPIC_IDEA_ITEM_TYPES = ["local_campaign_idea", TOPIC_CAMPAIGN_IDEA_ITEM_TYPE] as const

/**
 * IS THIS TOPIC APPROVED? A person approved its campaign idea (approval_items status 'approved') AND the topic is still in the
 * tenant's pool (its own or the platform-wide bank), fresh and unexpired. Tenant-pinned; a refused read is `error` (the caller
 * fails closed). The TV lane (contract C5) and the community-video door read this.
 */
export async function readTopicApproval(db: Db, brokerageId: string, topicId: string, opts: { now?: Date } = {}): Promise<{ approved: boolean; reason: string; topic: { id: string; title: string; categories: string[]; evidence: TopicEvidence | null; rawData: Record<string, unknown> | null } | null; approvedBy: string | null; approvedAt: string | null; error: string | null }> {
  const now = opts.now ?? new Date()
  const none = (reason: string, error: string | null = null) => ({ approved: false, reason, topic: null, approvedBy: null, approvedAt: null, error })
  if (!brokerageId || !topicId) return none("a tenant and a topic are required")
  const { data: items, error } = await db.from("approval_items").select("item_type, status, reviewed_by, reviewed_at")
    .eq("brokerage_id", brokerageId).eq("item_id", topicId).in("item_type", [...TOPIC_IDEA_ITEM_TYPES])
  if (error) return none("approval unreadable", `approval_items read refused: ${error.message ?? "unknown"}`)
  const approvedItem = ((items ?? []) as Array<{ status: string | null; reviewed_by: string | null; reviewed_at: string | null }>).find((i) => i.status === "approved")
  if (!approvedItem) return none(((items ?? []) as unknown[]).length ? "the topic's campaign idea is not approved (pending or rejected)" : "no campaign idea was ever proposed for this topic — nothing a person approved")
  const { data: topic, error: topicErr } = await db.from("content_topic_bank").select("id, brokerage_id, topic_title, categories, status, expires_at, raw_data")
    .eq("id", topicId).or(`brokerage_id.is.null,brokerage_id.eq.${brokerageId}`).maybeSingle()
  if (topicErr) return none("topic unreadable", `content_topic_bank read refused: ${topicErr.message ?? "unknown"}`)
  const t = topic as { id: string; topic_title: string; categories: string[] | null; status: string | null; expires_at: string | null; raw_data: Record<string, unknown> | null } | null
  if (!t) return none("the topic is not in this tenant's pool")
  if (t.status === "rejected" || t.status === "stale") return none(`the topic is ${t.status}`)
  if (t.expires_at && Date.parse(t.expires_at) <= now.getTime()) return none("the topic has expired")
  return {
    approved: true, reason: "approved", approvedBy: approvedItem.reviewed_by ?? null, approvedAt: approvedItem.reviewed_at ?? null, error: null,
    topic: { id: t.id, title: t.topic_title, categories: t.categories ?? [], evidence: ((t.raw_data as { topic_evidence?: TopicEvidence } | null)?.topic_evidence) ?? null, rawData: t.raw_data },
  }
}
