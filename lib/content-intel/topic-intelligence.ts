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
import { intakeTopicIdeas, type TopicIdea } from "./topic-intake"
import {
  competitorPostThemes, viralPatternThemes, customerQuestionThemes, educationGapThemes, aiSearchGapThemes, marketThemes, publicResearchThemes,
  type CitationRow, type CompetitorContentRow, type IntelTheme, type MarketDataRow, type ModuleRow, type PublicResearchRow, type QuestionRow,
  type TopicEvidence, type TopicFeed, type TopicSourceClass,
} from "./topic-themes"

type Db = { from: (table: string) => any }

// ── Theme → the ONE intake's TopicIdea (wave 154, lane 154G1) — PURE ─────────────────────────────

const themeDedupKey = (themeKey: string): string => `ti:${themeKey}`

/** Who may use what a source class yields: themes of public pages are reworded labels; the tenant's own records are first party. */
const RIGHTS_BY_CLASS: Readonly<Partial<Record<TopicSourceClass, TopicIdea["rights"]>>> = Object.freeze({
  competitor_post: "public_read_reworded", viral_pattern: "public_read_reworded", competitor_ad: "public_read_reworded",
  public_market_research: "public_read_reworded",
  customer_question: "first_party", education_gap: "first_party", ai_search_gap: "first_party",
  property_value_trend: "first_party", market_change: "first_party", tenant_performance: "first_party",
})

/**
 * The theme's evidence, honestly classed. IntelTheme.engagementScore is a RANKING HEURISTIC computed in topic-themes.ts from
 * the counts it keeps in topic_evidence.engagement.metrics (e.g. 20 × distinct askers, capped at 100) — it is a proxy for
 * priority, never a measured engagement figure, so it is filed as kind "proxy", metric `priority_from_<basis>`. A theme with
 * no engagement basis files "unknown" (the 0–100 column is then not written). The measured counts stay in topic_evidence.
 */
function themeEvidence(t: IntelTheme): TopicIdea["evidence"] {
  const basis = t.evidence.engagement.basis
  if (basis === "none") return { kind: "unknown", metric: null, value: null, unit: null, note: "no engagement evidence for this theme" }
  return { kind: "proxy", metric: `priority_from_${basis}`, value: t.engagementScore, unit: "score_0_100", note: `a ranking heuristic over ${basis.replace(/_/g, " ")} (raw counts in topic_evidence.engagement.metrics) — not a measured engagement figure` }
}

function themeToIdea(t: IntelTheme, ctx: { sourceId: string; sourceUrl: string | null; now: Date }): TopicIdea {
  return {
    sourceKind: "topic_intelligence", sourceId: ctx.sourceId, title: t.title, angle: t.valueAngle, categories: t.categories,
    geo: t.geo ? { cities: t.geo.cities ?? [], states: t.geo.states ?? [], zip_codes: t.geo.zip_codes ?? [] } : null,
    sourceUrl: ctx.sourceUrl, publishedAt: t.topicPostedAt, observedAt: t.evidence.observed_at || ctx.now.toISOString(),
    expiresAt: new Date(ctx.now.getTime() + t.expiresDays * DAY_MS).toISOString(),
    evidence: themeEvidence(t), rights: RIGHTS_BY_CLASS[t.evidence.source_class] ?? "first_party",
    dedupKey: themeDedupKey(t.evidence.theme_key),
    brief: { topic_evidence: t.evidence, source_class: t.evidence.source_class, observation_key: `theme:${t.evidence.theme_key}` },
  }
}

// ── The pass (I/O)────────────────────────────────────────────────────────────────────────────────

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
export async function runTopicIntelligencePass(db: Db, brokerageId: string, opts: { now?: Date; maxIdeas?: number; adoptSubjectKeys?: import("./topic-intake").SubjectKeyAdopter } = {}): Promise<TopicIntelligenceResult> {
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
      // FREQUENT SUPPORT SUBJECTS (wave 154, lane 154G1 — directive G2): the tenant's own user_to_brokerage tickets. Read in
      // memory for THEME matching only; the subject / description never leave customerQuestionThemes (label + distinct-asker
      // count only, ≥ MIN_DISTINCT_ASKERS). tenant_to_platform tickets are software support, not consumer content — not read.
      const { data: tix, error: tixErr } = await db.from("support_tickets").select("submitted_by_user_id, contact_id, subject, description, created_at")
        .eq("brokerage_id", brokerageId).eq("lane", "user_to_brokerage").gte("created_at", since30).limit(500)
      if (tixErr) out.blindSpots.push(`support tickets not read (${tixErr.message ?? "unknown"})`)
      else for (const t of (tix ?? []) as Array<{ submitted_by_user_id: string | null; contact_id: string | null; subject: string | null; description: string | null; created_at: string | null }>) q.push({ contact_key: t.contact_id ? `c:${t.contact_id}` : t.submitted_by_user_id ? `u:${t.submitted_by_user_id}` : null, text: `${t.subject ?? ""}. ${t.description ?? ""}`, at: t.created_at, channel: "support" })
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

    // PUBLIC-MARKET RESEARCH (wave 150, lane 150KLMO — directive 150L): the cited Exa observations THE ONE RawData producer
    // holds for this tenant's scraping territories as market / civic-event / anonymous-question EVIDENCE — the consumer that
    // makes those rows more than a write (C35: writer + consumer + outcome). Never a person: the subject kinds are evidence-only.
    {
      const { data: mk, error: mkErr } = await db.from("lead_scraping_markets").select("id").eq("brokerage_id", brokerageId).limit(200)
      if (mkErr) out.blindSpots.push(`public-market research not read — territories refused (${mkErr.message ?? "unknown"})`)
      else if ((mk ?? []).length > 0) {
        const { data, error } = await db.from("raw_scraped_leads")
          .select("subject_kind, source_record_id, proof_urls, ttl_expires_at, observed_at, city, state, raw_data")
          .in("market_id", (mk as Array<{ id: string }>).map((m) => m.id)).in("subject_kind", ["market", "job_civic_event", "anonymous_question"])
          .gte("ttl_expires_at", now.toISOString()).limit(300)
        if (error) out.blindSpots.push(`public-market research not read (${error.message ?? "unknown"})`)
        else { const r = publicResearchThemes((data ?? []) as PublicResearchRow[], now); addDropped(r.dropped); themes.push(...r.themes) }
      }
    }

    // File in the ONE pool THROUGH THE ONE INTAKE (wave 154, lane 154G1 — this pass inserted directly at the batch-2 base),
    // under the tenant's system source. Idempotent per theme: the intake's dedup key is `ti:<theme_key>`.
    const { data: bank, error: bankErr } = await db.from("content_topic_bank").select("id, raw_data, source_url")
      .eq("brokerage_id", brokerageId).eq("source_id", src.id).gte("expires_at", now.toISOString())
    if (bankErr) { out.errors.push(`content_topic_bank read refused — nothing filed: ${bankErr.message ?? "unknown"}`); return out }
    const urlsTaken = new Set<string>()
    for (const r of (bank ?? []) as Array<{ id: string; raw_data: { topic_evidence?: { theme_key?: string }; dedup_key?: string } | null; source_url: string | null }>) {
      const k = r.raw_data?.topic_evidence?.theme_key
      if (r.source_url) urlsTaken.add(r.source_url)
      // A row filed before the cut-over carries its theme_key but no dedup_key: stamp it ONCE (counted, tenant-pinned) so the
      // intake finds and refreshes it instead of filing a duplicate. An annotation of an existing row — not a producer.
      if (k && typeof r.raw_data?.dedup_key !== "string") {
        const { data: st, error: stErr } = await db.from("content_topic_bank").update({ raw_data: { ...(r.raw_data ?? {}), dedup_key: themeDedupKey(k) } })
          .eq("id", r.id).eq("brokerage_id", brokerageId).select("id")
        if (stErr || (st ?? []).length !== 1) out.errors.push(`legacy theme ${k} not keyed: ${stErr?.message ?? "matched no row"}`)
      }
    }
    const topicIdeas: TopicIdea[] = []
    for (const t of themes) {
      // (source_id, source_url) is UNIQUE (m128): a URL another theme of this source already holds is not claimed again.
      const sourceUrl = t.sourceUrl && !urlsTaken.has(t.sourceUrl) ? t.sourceUrl : null
      if (sourceUrl) urlsTaken.add(sourceUrl)
      topicIdeas.push(themeToIdea(t, { sourceId: src.id, sourceUrl, now }))
    }
    const filed: Array<{ id: string; theme: IntelTheme; isNew: boolean }> = []
    if (topicIdeas.length) {
      // ONE SUBJECT, ONE TOPIC (wave 155, lane 155F2): a live row already holding this subject under the retired question
      // key is merged into, never duplicated beside. The adopter is PASSED IN by the cron (topic-intake.ts SubjectKeyAdopter
      // says why it is not imported here); a caller that passes none files each idea under its own key, as before wave 155.
      const adoption = opts.adoptSubjectKeys ? await opts.adoptSubjectKeys(db, brokerageId, topicIdeas) : { ideas: topicIdeas, adopted: new Map<string, string>(), held: [] as string[] }
      const r = await intakeTopicIdeas(db, { brokerageId, ideas: adoption.ideas, now })
      if (r.refused) out.errors.push(`intake refused — nothing filed: ${r.refused}`)
      out.errors.push(...r.errors)
      for (const x of r.excluded) out.dropped[`intake:${x.reason}`] = (out.dropped[`intake:${x.reason}`] ?? 0) + 1
      const byKey = new Map(themes.map((t) => { const k = themeDedupKey(t.evidence.theme_key); return [adoption.adopted.get(k) ?? k, t] }))
      for (const row of r.rows) {
        const t = byKey.get(row.dedupKey)
        if (!t) continue
        if (row.isNew) { out.inserted++; out.bySource[t.evidence.source_class] = (out.bySource[t.evidence.source_class] ?? 0) + 1 }
        else out.refreshed++
        filed.push({ id: row.id, theme: t, isNew: row.isNew })
      }
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

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// EVIDENCE → ROUTE, AND THE DAILY INTELLIGENCE BRIEF (wave 155, lane 155H — directive H3 / H4, owner ruling R12)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// H3: "TOPIC EVIDENCE → freshness / relevance decision → existing topic bank → arbiter chooses Refurbish / Omnipresence / local
// newsletter / flyer / educational video / portal article / no action". The decision below is NOT a new arbiter: it names, for a
// topic the ONE intake already filed, which EXISTING executor may take it, and why — each executor keeps its own gates
// (refurbishTriggerVerdict re-checks the competitor watchlist; planOmnipresenceSchedule spaces the platforms; pickTopics claims
// per office; selectVideoFormat picks the video artifact). A competitor CONCEPT may inspire an original piece (idea_only); no
// copied text, no borrowed metric is ever presented as the tenant's own.
// H4: a high-signal, low-cost brief per authorized tenant territory (the tenant's ACTIVE lead_scraping_markets rows), with the
// ladder rung of every topic and MEASURED cost per topic-linked asset — assisted conversations and qualified Contacts stay
// UNKNOWN (no attribution link from a topic to a conversation or a Contact exists in the schema) rather than estimated.

/** Mirrors lib/lead-pipeline/source-discovery-planner.ts INTELLIGENCE_LADDER (kept local so this module adds no import edge;
 *  scripts/intelligence-brief-guard.ts asserts the two vocabularies agree). */
type BriefRung = "cached_verified" | "first_party" | "public_fact" | "search_demand" | "public_chatter" | "grounded_person" | "licensed_dataset" | "costly_scrape"
type BriefClass = "idea" | "acquisition" | "market_evidence"

/** The topic pool's source kinds → the ladder rung and source class they stand on. A kind not listed is said, never guessed. */
export const TOPIC_KIND_LADDER: Readonly<Record<string, { rung: BriefRung; sourceClass: BriefClass }>> = Object.freeze({
  website_question: { rung: "first_party", sourceClass: "idea" },
  search_demand_first_party: { rung: "first_party", sourceClass: "idea" },
  own_content_outcome: { rung: "first_party", sourceClass: "idea" },
  own_observation: { rung: "first_party", sourceClass: "idea" },
  local_fact: { rung: "public_fact", sourceClass: "market_evidence" },
  news_article: { rung: "public_fact", sourceClass: "market_evidence" },
  google_trends: { rung: "search_demand", sourceClass: "idea" },
  search_demand_search_console: { rung: "search_demand", sourceClass: "idea" },
  search_demand_keyword_intel: { rung: "search_demand", sourceClass: "idea" },
  community_post: { rung: "public_chatter", sourceClass: "idea" },
  facebook_group_question: { rung: "public_chatter", sourceClass: "idea" },
  reddit_thread: { rung: "public_chatter", sourceClass: "idea" },
  apify_social: { rung: "public_chatter", sourceClass: "idea" },
  brand_listening: { rung: "public_chatter", sourceClass: "idea" },
  meta_ad_creative: { rung: "public_chatter", sourceClass: "idea" },
  competitor_ad: { rung: "public_chatter", sourceClass: "idea" },
  competitor_post: { rung: "public_chatter", sourceClass: "idea" },
  refurbish_competitor_post: { rung: "public_chatter", sourceClass: "idea" },
  web_research: { rung: "public_chatter", sourceClass: "idea" },
  manual_link: { rung: "public_chatter", sourceClass: "idea" },
})

export type TopicRoute = "refurbish" | "omnipresence" | "newsletter" | "flyer" | "educational_video" | "portal_article" | "no_action"

/** The EXISTING executor each route hands to (file + function). */
export const TOPIC_ROUTE_EXECUTORS: Readonly<Record<Exclude<TopicRoute, "no_action">, string>> = Object.freeze({
  refurbish: "lib/repurpose/refurbish-idea.ts refurbishTriggerVerdict (idea_only for outside sources; the watchlist is re-checked there)",
  omnipresence: "lib/repurpose/omnipresence-plan.ts planOmnipresenceSchedule",
  newsletter: "lib/content-intel/topic-bank.ts pickTopics (asset newsletter_campaign — the newsletter selects its sections)",
  flyer: "lib/content-intel/topic-bank.ts pickTopics (the flyer / print builder claims the topic)",
  educational_video: "lib/video/video-director.ts selectVideoFormat (video is the artifact; the channel is chosen at delivery)",
  portal_article: "lib/content-intel/topic-bank.ts pickTopics (asset blog_post — the answer published where the question is asked)",
})

/**
 * THE ROUTE POLICY — a PRODUCT ORDERING CHOICE, not a measurement (said so the numbers below never read as evidence):
 * a topic seen in at least `omnipresenceMinObservations` DISTINCT observations with MEASURED evidence earns multi-platform
 * presence; otherwise the topic's own kind decides.
 */
export const TOPIC_ROUTE_POLICY = Object.freeze({ omnipresenceMinObservations: 3 })

export interface BriefTopicRow {
  id: string
  topic_title: string
  status: string | null
  expires_at: string | null
  categories: string[] | null
  geo_relevance: { cities?: string[]; states?: string[]; zip_codes?: string[]; label?: string | null } | null
  raw_data: Record<string, any> | null
  scraped_at?: string | null
}

export interface TopicRouteDecision { route: TopicRoute; alternates: TopicRoute[]; executor: string | null; why: string }

const COMPETITOR_KINDS = new Set(["meta_ad_creative", "competitor_ad", "competitor_post", "refurbish_competitor_post"])
const SEARCH_KINDS = new Set(["google_trends", "search_demand_search_console", "search_demand_keyword_intel"])

/** PURE — which existing executor may take this topic, or no action (with the reason). */
export function routeTopicEvidence(t: BriefTopicRow, now: Date = new Date()): TopicRouteDecision {
  const none = (why: string): TopicRouteDecision => ({ route: "no_action", alternates: [], executor: null, why })
  const pick = (route: Exclude<TopicRoute, "no_action">, alternates: TopicRoute[], why: string): TopicRouteDecision => ({ route, alternates, executor: TOPIC_ROUTE_EXECUTORS[route], why })
  if (t.status !== "fresh") return none(`the topic is ${t.status ?? "of unknown status"} — retired, used or rejected topics start nothing`)
  if (!t.expires_at || Date.parse(t.expires_at) <= now.getTime()) return none("the topic's freshness window has ended")
  const rd = t.raw_data ?? {}
  const kind = String(rd.intake?.source_kind ?? "")
  const observations = Number(rd.independent_observations ?? 0)
  if (Array.isArray(rd.source_removals) && rd.source_removals.length && observations === 0) return none("every source behind the topic was removed — dependent content must not start")
  if (!kind) return none("filed before the one intake — no source kind to route on")
  const evidenceKind = String(rd.evidence?.kind ?? rd.popularity_evidence_type ?? "unknown")
  const local = rd.intake?.freshness?.local_specificity ? rd.intake.freshness.local_specificity !== "none"
    : !!(t.geo_relevance && ((t.geo_relevance.cities ?? []).length || (t.geo_relevance.states ?? []).length || (t.geo_relevance.zip_codes ?? []).length))
  const question = typeof rd.creative_brief?.consumer_question === "string" && rd.creative_brief.consumer_question.trim().length > 0

  let base: TopicRouteDecision
  if (COMPETITOR_KINDS.has(kind)) base = pick("refurbish", [], "a competitor concept — an ORIGINAL piece in the subscriber's voice; no copied text, no borrowed metrics")
  else if (kind === "own_content_outcome") base = pick("refurbish", [], "the tenant's own piece under its own measured baseline — refresh it")
  else if (kind === "local_fact") {
    const ev = rd.intake?.freshness?.event_date ?? rd.event_start ?? null
    const upcoming = typeof ev === "string" && Date.parse(ev) > now.getTime()
    base = upcoming ? pick("newsletter", ["flyer", "educational_video"], "a verified upcoming local event — the newsletter's community section (R8), a flyer if the office wants print")
      : pick("newsletter", ["portal_article"], "a verified local fact — market / community education")
  } else if (kind === "news_article") base = pick("newsletter", ["portal_article"], "a credited headline — market education with the source named")
  else if (SEARCH_KINDS.has(kind)) base = local ? pick("newsletter", ["educational_video", "portal_article"], "real local search demand — a market-education section that answers it")
    : pick("portal_article", ["educational_video"], "search demand without a place — an evergreen answer")
  else if (kind === "website_question" || kind === "search_demand_first_party" || kind === "own_observation") base = pick("portal_article", ["educational_video", "newsletter"], "a question this tenant's own people keep asking — answer it where it is asked")
  else if (TOPIC_KIND_LADDER[kind]?.rung === "public_chatter") base = question ? pick("educational_video", ["portal_article", "newsletter"], "a public consumer question, reworded — an educational video artifact answers it")
    : pick("refurbish", [], "a public conversation theme — an original piece (idea only)")
  else return none(`no route policy names source kind ${kind}`)

  if (evidenceKind === "measured" && observations >= TOPIC_ROUTE_POLICY.omnipresenceMinObservations && !COMPETITOR_KINDS.has(kind)) {
    return { route: "omnipresence", alternates: [base.route, ...base.alternates].filter((r) => r !== "omnipresence"), executor: TOPIC_ROUTE_EXECUTORS.omnipresence, why: `${observations} distinct observations with measured evidence — present it on every platform (${base.why})` }
  }
  return base
}

export interface BriefEntry {
  id: string
  title: string
  sourceKind: string | null
  rung: BriefRung | "unclassified"
  sourceClass: BriefClass | "unclassified"
  /** measured / proxy / unknown — a value only when measured or proxy, with its metric; never shown as the tenant's own. */
  evidence: { kind: string; metric: string | null; value: number | null; basis: string }
  observations: number
  freshness: { eventDate: string | null; firstSeen: string | null; lastChecked: string | null; expiresAt: string | null; localSpecificity: string }
  route: TopicRouteDecision
}

export interface IntelligenceBrief {
  ok: boolean
  brokerageId: string
  generatedAt: string
  windowHours: number
  territories: Array<{ id: string; label: string; entries: BriefEntry[] }>
  /** Topics with no place, or a place outside every active territory (still the tenant's). */
  tenantWide: BriefEntry[]
  freshTotal: number
  byRung: Record<string, number>
  byRoute: Record<string, number>
  cost: null | {
    windowDays: number
    spendUsd: number | null
    spendBasis: string
    topicLinkedAssets: number
    costPerTopicLinkedAsset: number | null
    assistedConversations: null
    costPerAssistedConversation: null
    qualifiedContacts: null
    costPerQualifiedContact: null
    unknownBecause: string
  }
  blindSpots: string[]
  error: string | null
}

/** vendor_usage_tracking.request_metadata.system_source values that ARE intelligence spend (proven bookings only). */
export const INTELLIGENCE_SPEND_SYSTEM_SOURCES = ["local_intel", "brand_listening"] as const

function briefEntry(t: BriefTopicRow, now: Date): BriefEntry {
  const rd = t.raw_data ?? {}
  const kind = typeof rd.intake?.source_kind === "string" ? rd.intake.source_kind : null
  const lad = kind ? TOPIC_KIND_LADDER[kind] : undefined
  const ev = rd.evidence ?? {}
  const evKind = ev.kind === "measured" || ev.kind === "proxy" ? ev.kind : "unknown"
  const value = evKind !== "unknown" && typeof ev.value === "number" && Number.isFinite(ev.value) ? ev.value : null
  const fr = rd.intake?.freshness ?? {}
  return {
    id: t.id, title: t.topic_title, sourceKind: kind, rung: lad?.rung ?? "unclassified", sourceClass: lad?.sourceClass ?? "unclassified",
    evidence: { kind: value === null ? "unknown" : evKind, metric: value === null ? null : (ev.metric ?? null), value,
      basis: value === null ? "unknown — not measured; no number is shown" : evKind === "proxy" ? "a proxy from the source (not the tenant's own engagement)" : "measured at the source (not the tenant's own engagement)" },
    observations: Number(rd.independent_observations ?? 0) || 0,
    freshness: { eventDate: fr.event_date ?? null, firstSeen: fr.first_seen ?? rd.intake?.first_observed_at ?? null, lastChecked: fr.last_checked ?? t.scraped_at ?? null, expiresAt: t.expires_at, localSpecificity: fr.local_specificity ?? "unknown" },
    route: routeTopicEvidence(t, now),
  }
}

/** PURE — does a topic's place fall inside a territory (ZIP, city or state named on both sides; never a guess). */
function topicInTerritory(geo: BriefTopicRow["geo_relevance"], m: { city: string | null; state: string | null; zip_codes: string[] | null }): boolean {
  if (!geo) return false
  const lc = (s: unknown) => String(s ?? "").trim().toLowerCase()
  const zips = new Set((m.zip_codes ?? []).map((z) => String(z).slice(0, 5)))
  if ((geo.zip_codes ?? []).some((z) => zips.has(String(z).slice(0, 5)))) return true
  const sameState = !m.state || !(geo.states ?? []).length || (geo.states ?? []).some((s) => lc(s) === lc(m.state))
  if (m.city && (geo.cities ?? []).some((c) => lc(c) === lc(m.city)) && sameState) return true
  return !m.city && !!m.state && !(geo.cities ?? []).length && (geo.states ?? []).some((s) => lc(s) === lc(m.state))
}

/**
 * THE DAILY INTELLIGENCE BRIEF for one tenant (H4) — computed on read for the last `windowHours` (no new table, no new cron):
 * the topics the ONE intake filed or re-observed in the window, per active territory, each with its ladder rung, evidence kind,
 * freshness record and route. `includeCost` (the caller decides — a tenant admin) adds MEASURED intelligence spend over
 * `costWindowDays` against topic-linked assets; unknowns stay unknown. Tenant-pinned; every refusal is read and said.
 */
export async function buildTerritoryIntelligenceBrief(db: Db, brokerageId: string, opts: { now?: Date; windowHours?: number; costWindowDays?: number; includeCost?: boolean } = {}): Promise<IntelligenceBrief> {
  const now = opts.now ?? new Date()
  const windowHours = opts.windowHours ?? 24
  const out: IntelligenceBrief = { ok: false, brokerageId, generatedAt: now.toISOString(), windowHours, territories: [], tenantWide: [], freshTotal: 0, byRung: {}, byRoute: {}, cost: null, blindSpots: [], error: null }
  if (!brokerageId) { out.error = "no tenant"; return out }
  const { data: markets, error: mErr } = await db.from("lead_scraping_markets").select("id, name, city, state, zip_codes").eq("brokerage_id", brokerageId).eq("is_active", true).limit(50)
  if (mErr) out.blindSpots.push(`territories not read (${mErr.message ?? "unknown"}) — every topic is listed tenant-wide`)
  const terr = ((mErr ? [] : markets ?? []) as Array<{ id: string; name: string | null; city: string | null; state: string | null; zip_codes: string[] | null }>)
  if (!mErr && terr.length === 0) out.blindSpots.push("no active territory — every topic is listed tenant-wide")
  const { data: topics, error: tErr } = await db.from("content_topic_bank").select("id, topic_title, status, expires_at, categories, geo_relevance, raw_data, scraped_at")
    .eq("brokerage_id", brokerageId).eq("status", "fresh").gt("expires_at", now.toISOString()).order("scraped_at", { ascending: false }).limit(300)
  if (tErr) { out.error = `content_topic_bank read refused: ${tErr.message ?? "unknown"}`; return out }
  const rows = (topics ?? []) as BriefTopicRow[]
  out.freshTotal = rows.length
  const since = now.getTime() - windowHours * 3_600_000
  const today = rows.filter((r) => { const at = Date.parse(String(r.scraped_at ?? "")); return Number.isFinite(at) && at >= since })
  out.territories = terr.map((m) => ({ id: m.id, label: m.name || [m.city, m.state].filter(Boolean).join(", ") || m.id, entries: [] }))
  for (const r of today) {
    const e = briefEntry(r, now)
    out.byRung[e.rung] = (out.byRung[e.rung] ?? 0) + 1
    out.byRoute[e.route.route] = (out.byRoute[e.route.route] ?? 0) + 1
    let placed = false
    terr.forEach((m, i) => { if (topicInTerritory(r.geo_relevance, m)) { out.territories[i].entries.push(e); placed = true } })
    if (!placed) out.tenantWide.push(e)
  }
  out.blindSpots.push("platform-pool topics (brokerage_id null) are not in a tenant's brief — they are not this tenant's evidence")
  out.blindSpots.push("topics retired today are not listed (retirement time lives in raw_data.source_removals; the brief reads fresh topics only)")

  if (opts.includeCost) {
    const days = opts.costWindowDays ?? 30
    const sinceIso = new Date(now.getTime() - days * DAY_MS).toISOString()
    const unknownBecause = "no attribution link from a topic to a conversation or a Contact exists in the schema — never estimated"
    const cost: NonNullable<IntelligenceBrief["cost"]> = { windowDays: days, spendUsd: null, spendBasis: "", topicLinkedAssets: 0, costPerTopicLinkedAsset: null, assistedConversations: null, costPerAssistedConversation: null, qualifiedContacts: null, costPerQualifiedContact: null, unknownBecause }
    const { data: spend, error: sErr } = await db.from("vendor_usage_tracking").select("total_cost, request_metadata").eq("brokerage_id", brokerageId).gte("created_at", sinceIso).limit(5000)
    if (sErr) cost.spendBasis = `spend unknown — vendor_usage_tracking read refused (${sErr.message ?? "unknown"})`
    else {
      const mine = ((spend ?? []) as Array<{ total_cost: number | null; request_metadata: Record<string, any> | null }>).filter((r) => (INTELLIGENCE_SPEND_SYSTEM_SOURCES as readonly string[]).includes(String(r.request_metadata?.system_source ?? "")))
      const unpriced = mine.filter((r) => r.request_metadata?.price_state === "unknown" || typeof r.total_cost !== "number").length
      if (unpriced > 0) cost.spendBasis = `spend unknown — ${unpriced} of ${mine.length} intelligence bookings carry no price`
      else { cost.spendUsd = Math.round(mine.reduce((n, r) => n + Number(r.total_cost), 0) * 100) / 100; cost.spendBasis = `${mine.length} platform-covered booking(s) under ${INTELLIGENCE_SPEND_SYSTEM_SOURCES.join(" / ")} (vendor_usage_tracking)` }
    }
    const { data: uses, error: uErr } = await db.from("content_topic_uses").select("asset_id, asset_type").eq("brokerage_id", brokerageId).gte("used_at", sinceIso).limit(5000)
    if (uErr) out.blindSpots.push(`topic-linked assets not read (${uErr.message ?? "unknown"}) — cost per asset unknown`)
    else cost.topicLinkedAssets = new Set(((uses ?? []) as Array<{ asset_id: string | null; asset_type: string | null }>).filter((u) => u.asset_id).map((u) => `${u.asset_type}:${u.asset_id}`)).size
    cost.costPerTopicLinkedAsset = cost.spendUsd !== null && !uErr && cost.topicLinkedAssets > 0 ? Math.round((cost.spendUsd / cost.topicLinkedAssets) * 100) / 100 : null
    out.cost = cost
    out.blindSpots.push("topic-linked assets are content_topic_uses rows — a topic used in an asset; publication is not verified here")
    out.blindSpots.push("community / Apify / Exa / RSS / Reddit topic transports report cost on the action ledger only — not yet booked under a system source this brief reads")
  }
  out.ok = true
  return out
}
