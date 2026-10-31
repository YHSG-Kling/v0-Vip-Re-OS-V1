// lib/content-intel/topic-themes.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE PURE HALF OF TOPIC INTELLIGENCE (wave 145, lane 145G — owner ruling 22). The source census, the theme vocabulary and the
// extractors that turn each survivor's rows into THEMES with their evidence (source, timestamp, the accessible engagement
// evidence and its basis, confidence) — never a competitor's creative, never a customer's words, never a private metric.
// No I/O: the pass that reads the tables and files the themes in the ONE pool is lib/content-intel/topic-intelligence.ts
// (runTopicIntelligencePass); the competitor-ad promoter (lib/competitive-intel/promote-to-topic-bank.ts) files
// competitorAdTheme; the TV lane (lib/marketing/ctv-lane.ts) reads TopicEvidence. The full ruling text and the NEVER list are
// in topic-intelligence.ts's header. Pure / I-O split as in lib/lead-magnets/book-publishing.ts + book-publishing-produce.ts.

import { EXCLUDED_TOPIC_RULES } from "./local-intel"

// ── The census ────────────────────────────────────────────────────────────────────────────────────

export const TOPIC_SOURCE_CLASSES = [
  "competitor_ad", "competitor_post", "viral_pattern", "local_event", "local_news", "property_value_trend", "market_change",
  "customer_question", "education_gap", "ai_search_gap", "community_interest", "tenant_performance",
] as const
export type TopicSourceClass = (typeof TOPIC_SOURCE_CLASSES)[number]

/** Every ruling-22 source → the survivor that feeds the ONE pool (file:function). */
export const TOPIC_SOURCE_CENSUS: Readonly<Record<TopicSourceClass, { writer: string; reads: string; since: string }>> = Object.freeze({
  competitor_ad:        { writer: "lib/competitive-intel/promote-to-topic-bank.ts promoteCompetitorAdsToTopicBank", reads: "competitor_ads", since: "wave 36" },
  competitor_post:      { writer: "lib/content-intel/topic-intelligence.ts runTopicIntelligencePass", reads: "competitor_content (detected_topics)", since: "wave 145" },
  viral_pattern:        { writer: "lib/content-intel/topic-intelligence.ts runTopicIntelligencePass", reads: "competitor_content (format + hook vs the competitor's own typical post)", since: "wave 145" },
  local_event:          { writer: "lib/content-intel/local-intel.ts runLocalIntelPass", reads: "web_search / NewsAPI.ai / tenant calendar feeds", since: "wave 144" },
  local_news:           { writer: "lib/content-intel/local-intel.ts runLocalIntelPass", reads: "web_search / NewsAPI.ai / tenant RSS feeds", since: "wave 144" },
  property_value_trend: { writer: "lib/content-intel/topic-intelligence.ts runTopicIntelligencePass", reads: "market_data (price trends)", since: "wave 145" },
  market_change:        { writer: "lib/content-intel/topic-intelligence.ts runTopicIntelligencePass", reads: "market_data (months of supply, 90-day trend)", since: "wave 145" },
  customer_question:    { writer: "lib/content-intel/topic-intelligence.ts runTopicIntelligencePass", reads: "messages (inbound) + listing_inquiries — themes and counts only", since: "wave 145" },
  education_gap:        { writer: "lib/content-intel/topic-intelligence.ts runTopicIntelligencePass", reads: "customer questions × learning_modules coverage", since: "wave 145" },
  ai_search_gap:        { writer: "lib/content-intel/topic-intelligence.ts runTopicIntelligencePass", reads: "ai_search_citation_observations", since: "wave 145" },
  community_interest:   { writer: "app/api/cron/content-intel-reddit/route.ts (and the rss / apify / exa twins) + lib/competitive-intel/brand-listening.ts", reads: "public chatter, feeds, brand mentions", since: "waves 18-143" },
  tenant_performance:   { writer: "lib/content-intel/performance-aggregator.ts (content_topic_bank.performance_score)", reads: "content_topic_uses × engagement", since: "wave 19" },
})

/** What a topic can become (ruling 22: posts, lead magnets, education, local market content, property-value commentary, video, podcast, books, TV). */
export const TOPIC_FEEDS = ["social_post", "lead_magnet", "education", "local_market", "property_value_commentary", "video", "podcast", "book", "ctv_ad"] as const
export type TopicFeed = (typeof TOPIC_FEEDS)[number]

/** The evidence every intelligence topic carries (content_topic_bank.raw_data.topic_evidence). */
export interface TopicEvidence {
  source_class: TopicSourceClass
  /** The table / provider the evidence was read from. */
  source: string
  /** When the source last observed it (ISO). */
  observed_at: string
  window_days: number
  engagement: {
    /** public_counts = counts anyone can see on the post; search_rank_proxy = the search provider's ranking score (documented, NOT engagement);
     *  internal_count = this tenant's own records; observation_count = monitor observations; none = no engagement evidence. */
    basis: "public_counts" | "search_rank_proxy" | "internal_count" | "observation_count" | "none"
    metrics: Record<string, number>
  }
  confidence: number
  confidence_basis: string
  theme_key: string
  /** Always true: a theme, never creative. */
  theme_only: true
  /** Always false: nothing here is a competitor's private metric. */
  private_metrics: false
  feeds: TopicFeed[]
  /** Facts the writer may state (figures from the tenant's own market data, with source + date) — nothing else. */
  facts?: string[]
}

// ── The theme vocabulary (pure) ───────────────────────────────────────────────────────────────────

interface ThemeRule { key: string; label: string; re: RegExp; categories: string[]; feeds: TopicFeed[] }

/**
 * The real-estate question themes — a TOPIC label each, mapped to the categories the pool's readers already filter on
 * (buyer_advice / seller_advice / finance / market_education / neighborhood / home_improvement / regulation). Deliberately
 * absent: schools, safety, demographics, places of worship (steering — screened again by EXCLUDED_TOPIC_RULES).
 */
export const REAL_ESTATE_THEMES: ReadonlyArray<ThemeRule> = [
  { key: "closing_costs", label: "Closing costs — what they are and who pays them", re: /\bclosing costs?\b|\bcash to close\b|\bclosing fees?\b/i, categories: ["buyer_advice", "finance"], feeds: ["social_post", "lead_magnet", "education", "video", "podcast", "book"] },
  { key: "mortgage_rates", label: "Mortgage rates and what they mean for a payment", re: /\b(?:mortgage|interest) rates?\b|\brates? (?:going|drop|rise|coming down)\b/i, categories: ["finance", "buyer_advice"], feeds: ["social_post", "education", "video", "podcast"] },
  { key: "down_payment", label: "Down payments and assistance programs", re: /\bdown ?payments?\b|\bdown payment assistance\b/i, categories: ["finance", "buyer_advice"], feeds: ["social_post", "lead_magnet", "education", "video", "book"] },
  { key: "pre_approval", label: "Getting pre-approved before you shop", re: /\bpre-?approv\w*|\bpre-?qualif\w*/i, categories: ["finance", "buyer_advice"], feeds: ["social_post", "education", "video"] },
  { key: "credit", label: "Credit and qualifying for a mortgage", re: /\bcredit (?:score|report|history)\b/i, categories: ["finance", "buyer_advice"], feeds: ["education", "video", "podcast"] },
  { key: "home_inspection", label: "Home inspections — what they find and what happens next", re: /\binspections?\b|\binspector\b/i, categories: ["buyer_advice", "home_improvement"], feeds: ["social_post", "lead_magnet", "education", "video"] },
  { key: "appraisal", label: "Appraisals and what happens when one comes in low", re: /\bapprais\w*/i, categories: ["buyer_advice", "seller_advice", "finance"], feeds: ["education", "video", "podcast"] },
  { key: "home_value", label: "What a home is worth — and how the market sets it", re: /\bwhat(?:'s| is) (?:my|our) (?:home|house) worth\b|\bhome(?:'s)? (?:value|worth)\b|\bhouse value\b|\bcomps?\b/i, categories: ["seller_advice", "market_education"], feeds: ["lead_magnet", "property_value_commentary", "video", "local_market"] },
  { key: "property_taxes", label: "Property taxes and exemptions", re: /\bproperty tax\w*|\bhomestead\b/i, categories: ["finance", "regulation"], feeds: ["education", "video", "podcast"] },
  { key: "insurance", label: "Homeowners and flood insurance", re: /\b(?:homeowners?|flood|wind|hazard) insurance\b|\binsurance (?:premium|rates?|costs?)\b/i, categories: ["finance", "regulation"], feeds: ["education", "video", "podcast"] },
  { key: "hoa", label: "HOAs and condo associations", re: /\bhoa\b|\bhomeowners? association\b|\bcondo (?:fees?|association)\b/i, categories: ["buyer_advice", "regulation"], feeds: ["education", "video"] },
  { key: "pricing_strategy", label: "Pricing a home to sell", re: /\blist(?:ing)? price\b|\bpric(?:e|ing) (?:my|our|your|the) (?:home|house)\b|\boverpric\w*/i, categories: ["seller_advice", "market_education"], feeds: ["social_post", "lead_magnet", "video", "book"] },
  { key: "home_prep", label: "Preparing a home for sale", re: /\bstag(?:e|ing)\b|\bdeclutter\w*|\bcurb appeal\b|\brepairs? before (?:listing|selling)\b/i, categories: ["seller_advice", "home_improvement"], feeds: ["social_post", "lead_magnet", "video", "book"] },
  { key: "selling_timeline", label: "How long it takes to sell — and the best time to list", re: /\bhow long (?:does it take |will it take )?to sell\b|\bdays on market\b|\bbest time to (?:sell|list|buy)\b/i, categories: ["seller_advice", "market_education"], feeds: ["social_post", "video", "local_market"] },
  { key: "buying_process", label: "How buying a home works, step by step", re: /\bfirst[- ]time (?:home ?)?buyers?\b|\bhow (?:do i|to) buy\b|\bbuying process\b/i, categories: ["buyer_advice"], feeds: ["lead_magnet", "education", "video", "book"] },
  { key: "offers_negotiation", label: "Offers, contingencies and negotiation", re: /\bmultiple offers\b|\bbidding wars?\b|\bcounter ?offers?\b|\bnegotiat\w*|\bcontingenc\w*/i, categories: ["buyer_advice", "seller_advice"], feeds: ["social_post", "education", "video", "podcast"] },
  { key: "escrow_title", label: "Earnest money, escrow and title", re: /\bearnest money\b|\bescrow\b|\btitle (?:company|insurance|search)\b/i, categories: ["buyer_advice", "regulation"], feeds: ["education", "video"] },
  { key: "new_construction", label: "Buying new construction", re: /\bnew construction\b|\bnew builds?\b|\bbuilder incentives?\b/i, categories: ["buyer_advice", "market_education"], feeds: ["social_post", "video", "local_market"] },
  { key: "relocation", label: "Relocating to the area", re: /\brelocat\w*|\bmoving (?:here|to the area|to town)\b/i, categories: ["buyer_advice", "neighborhood"], feeds: ["lead_magnet", "video", "local_market"] },
  { key: "investment_property", label: "Buying an investment or rental property", re: /\b(?:rental|investment) propert\w*|\bcash flow\b|\blandlord\b/i, categories: ["market_education", "finance"], feeds: ["education", "video", "podcast", "book"] },
  { key: "equity_refinance", label: "Home equity and refinancing", re: /\brefinanc\w*|\bhome equity\b|\bheloc\b|\bcash[- ]out\b/i, categories: ["finance"], feeds: ["education", "video", "podcast", "property_value_commentary"] },
  { key: "market_conditions", label: "What the local market is doing", re: /\bhousing market\b|\bmarket (?:update|crash|correction|conditions?)\b|\b(?:buyer|seller)'?s market\b|\binventory\b/i, categories: ["market_education"], feeds: ["social_post", "video", "podcast", "local_market", "ctv_ad"] },
  { key: "agent_compensation", label: "How agent compensation works", re: /\bcommissions?\b|\bagent fees?\b|\bbuyer(?:'s)? agent (?:fee|compensation)\b/i, categories: ["regulation", "buyer_advice", "seller_advice"], feeds: ["education", "video"] },
  { key: "renovation_permits", label: "Renovations and permits", re: /\bpermits?\b|\brenovat\w*|\bremodel\w*/i, categories: ["home_improvement", "regulation"], feeds: ["social_post", "video"] },
  { key: "hazard_risk", label: "Flood zones, storms and disclosures", re: /\bflood zones?\b|\bhurricane\w*|\bwind mitigation\b|\bwildfires?\b/i, categories: ["regulation", "home_improvement"], feeds: ["education", "video", "lead_magnet"] },
]

/** PURE. The themes a text touches (a topic label each — the text itself is never kept). */
function themesOf(text: string): ThemeRule[] {
  const t = String(text ?? "")
  return REAL_ESTATE_THEMES.filter((r) => r.re.test(t))
}

/** PURE. The steering reason a text is excluded for, or null (the ONE list — local-intel's). */
function excludedTopicReason(text: string): string | null {
  for (const r of EXCLUDED_TOPIC_RULES) if (r.pattern.test(String(text ?? ""))) return r.reason
  return null
}

/** PURE. Is a message a QUESTION? A question mark, or an interrogative opening. */
export function isQuestion(text: string): boolean {
  const t = String(text ?? "").trim()
  return /\?/.test(t) || /^(?:how|what|when|where|why|who|which|can|could|should|would|is|are|do|does|did|will)\b/i.test(t)
}

/** Fewer distinct askers than this and a question theme stays private (one person's question never becomes public content). */
export const MIN_DISTINCT_ASKERS = 3
/** A competitor post at or above this many times the competitor's own median ranking/engagement is a high-engagement pattern. */
export const VIRAL_MULTIPLE = 2

const clamp01 = (n: number) => Math.max(0, Math.min(1, Math.round(n * 100) / 100))
const slug = (s: string) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80)
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length === 0 ? 0 : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2 }

/** A theme ready for the pool (pure output of the extractors). */
export interface IntelTheme {
  title: string
  valueAngle: string
  categories: string[]
  engagementScore: number
  sourceUrl: string | null
  topicPostedAt: string
  expiresDays: number
  geo: { cities?: string[]; states?: string[]; zip_codes?: string[] } | null
  evidence: TopicEvidence
}

// ── Extractors (pure) ─────────────────────────────────────────────────────────────────────────────

export interface CompetitorContentRow {
  competitor_id: string | null; platform: string | null; content_type: string | null; content_url: string | null
  detected_topics: string[] | null; hook_type: string | null; engagement_rate: number | null; is_high_performing: boolean | null
  likes_count: number | null; comments_count: number | null; shares_count: number | null; views_count: number | null
  observed_at: string | null; posted_at: string | null
}

/** PURE. Competitor PUBLIC POST themes (detected topic labels only — never the caption) with the accessible engagement evidence. */
export function competitorPostThemes(rows: readonly CompetitorContentRow[], now: Date): { themes: IntelTheme[]; dropped: Record<string, number> } {
  const dropped: Record<string, number> = {}
  const byTopic = new Map<string, { label: string; posts: CompetitorContentRow[] }>()
  for (const r of rows) {
    for (const raw of r.detected_topics ?? []) {
      const label = String(raw ?? "").replace(/\s+/g, " ").trim()
      if (label.length < 3) continue
      const why = excludedTopicReason(label)
      if (why) { dropped[`excluded_topic:${why}`] = (dropped[`excluded_topic:${why}`] ?? 0) + 1; continue }
      const k = slug(label)
      const cur = byTopic.get(k) ?? { label, posts: [] }
      cur.posts.push(r)
      byTopic.set(k, cur)
    }
  }
  const themes: IntelTheme[] = []
  for (const [k, { label, posts }] of byTopic) {
    if (posts.length < 2) { dropped.single_post = (dropped.single_post ?? 0) + 1; continue }
    const counted = posts.filter((p) => [p.likes_count, p.comments_count, p.shares_count].some((x) => typeof x === "number"))
    const publicTotal = counted.reduce((s, p) => s + (p.likes_count ?? 0) + (p.comments_count ?? 0) + (p.shares_count ?? 0), 0)
    const proxy = posts.map((p) => (typeof p.engagement_rate === "number" ? p.engagement_rate : 0))
    const basis: TopicEvidence["engagement"]["basis"] = counted.length > 0 ? "public_counts" : proxy.some((x) => x > 0) ? "search_rank_proxy" : "none"
    const newest = posts.map((p) => p.observed_at ?? p.posted_at ?? "").filter(Boolean).sort().pop() ?? now.toISOString()
    const competitors = new Set(posts.map((p) => p.competitor_id).filter(Boolean)).size
    const engagementScore = basis === "public_counts" ? Math.min(100, Math.round(25 * Math.log10(1 + publicTotal))) : Math.min(100, Math.round(median(proxy)))
    const theme = themesOf(label)[0]
    themes.push({
      title: `Competitors are posting about: ${label}`.slice(0, 200),
      valueAngle: `${posts.length} public competitor posts (${competitors} competitor${competitors === 1 ? "" : "s"}) covered this in the window — make the clearer, local, original version. Use your own words; never reuse their wording, images or hooks.`,
      categories: [...new Set([...(theme?.categories ?? ["market_education"]), "competitor_intel", "topic_intelligence"])],
      engagementScore,
      sourceUrl: posts.find((p) => p.content_url)?.content_url ?? null,
      topicPostedAt: newest,
      expiresDays: 14,
      geo: null,
      evidence: {
        source_class: "competitor_post", source: "competitor_content", observed_at: newest, window_days: 30,
        engagement: { basis, metrics: basis === "public_counts" ? { public_interactions: publicTotal, posts_with_counts: counted.length, posts: posts.length } : { posts: posts.length, median_rank_score: median(proxy), high_ranked: posts.filter((p) => p.is_high_performing).length } },
        confidence: clamp01(0.4 + 0.1 * Math.min(4, posts.length) + (competitors > 1 ? 0.1 : 0)),
        confidence_basis: `${posts.length} posts, ${competitors} competitor(s)${basis === "search_rank_proxy" ? "; engagement is the search provider's ranking proxy, not interactions (platform counts need the competitor's own authorisation)" : ""}`,
        theme_key: `competitor_post:${k}`, theme_only: true, private_metrics: false,
        feeds: theme?.feeds ?? ["social_post", "video"],
      },
    })
  }
  return { themes, dropped }
}

/** PURE. HIGH-ENGAGEMENT PATTERNS: a format + opening hook that outperformed the competitor's own typical post (a pattern, not creative). */
export function viralPatternThemes(rows: readonly CompetitorContentRow[], now: Date): IntelTheme[] {
  const byCompetitor = new Map<string, CompetitorContentRow[]>()
  for (const r of rows) {
    const k = r.competitor_id ?? "unknown"
    byCompetitor.set(k, [...(byCompetitor.get(k) ?? []), r])
  }
  const patterns = new Map<string, { contentType: string; hook: string; platform: string; lifts: number[]; posts: number; newest: string }>()
  for (const posts of byCompetitor.values()) {
    const score = (p: CompetitorContentRow) => (typeof p.likes_count === "number" || typeof p.comments_count === "number" ? (p.likes_count ?? 0) + (p.comments_count ?? 0) + (p.shares_count ?? 0) : (p.engagement_rate ?? 0))
    const base = median(posts.map(score))
    if (posts.length < 3 || base <= 0) continue
    for (const p of posts) {
      const lift = score(p) / base
      if (lift < VIRAL_MULTIPLE) continue
      const contentType = p.content_type ?? "post", hook = p.hook_type ?? "unclassified", platform = p.platform ?? "social"
      const k = `${slug(platform)}:${slug(contentType)}:${slug(hook)}`
      const cur = patterns.get(k) ?? { contentType, hook, platform, lifts: [], posts: 0, newest: "" }
      cur.lifts.push(lift); cur.posts++
      cur.newest = [cur.newest, p.observed_at ?? p.posted_at ?? ""].sort().pop() ?? ""
      patterns.set(k, cur)
    }
  }
  return [...patterns.entries()].map(([k, v]) => {
    const lift = Math.round(median(v.lifts) * 10) / 10
    return {
      title: `What is outperforming: ${v.contentType.replace(/_/g, " ")} on ${v.platform} that opens with a ${v.hook.replace(/_/g, " ")} hook`.slice(0, 200),
      valueAngle: `${v.posts} competitor post(s) of this shape drew about ${lift}× that competitor's own typical post. Use the SHAPE (format and opening) for your own original topic — never their words, footage or offer. No result is promised.`,
      categories: ["market_education", "viral_pattern", "topic_intelligence"],
      engagementScore: Math.min(100, Math.round(60 + 10 * (lift - VIRAL_MULTIPLE))),
      sourceUrl: null,
      topicPostedAt: v.newest || now.toISOString(),
      expiresDays: 14,
      geo: null,
      evidence: {
        source_class: "viral_pattern" as const, source: "competitor_content", observed_at: v.newest || now.toISOString(), window_days: 30,
        engagement: { basis: "search_rank_proxy" as const, metrics: { posts: v.posts, median_lift: lift } },
        confidence: clamp01(0.5 + 0.1 * Math.min(3, v.posts)),
        confidence_basis: `lift measured against each competitor's OWN median (${v.posts} post(s)); a pattern, never a guarantee`,
        theme_key: `viral_pattern:${k}`, theme_only: true as const, private_metrics: false as const,
        feeds: ["social_post", "video", "ctv_ad"] as TopicFeed[],
      },
    }
  })
}

export interface QuestionRow { contact_key: string | null; text: string | null; at: string | null }

/** PURE. CUSTOMER QUESTION themes — counts per theme of distinct askers; never the words, never who. */
export function customerQuestionThemes(rows: readonly QuestionRow[], now: Date): { themes: IntelTheme[]; askersByTheme: Map<string, number>; dropped: Record<string, number> } {
  const dropped: Record<string, number> = {}
  const askers = new Map<string, Set<string>>()
  const newest = new Map<string, string>()
  for (const r of rows) {
    const text = String(r.text ?? "")
    if (!isQuestion(text)) continue
    const why = excludedTopicReason(text)
    if (why) { dropped[`excluded_topic:${why}`] = (dropped[`excluded_topic:${why}`] ?? 0) + 1; continue }
    for (const t of themesOf(text)) {
      const set = askers.get(t.key) ?? new Set<string>()
      set.add(r.contact_key ?? `anon:${set.size}`)
      askers.set(t.key, set)
      newest.set(t.key, [newest.get(t.key) ?? "", r.at ?? ""].sort().pop() ?? "")
    }
  }
  const askersByTheme = new Map<string, number>()
  const themes: IntelTheme[] = []
  for (const rule of REAL_ESTATE_THEMES) {
    const n = askers.get(rule.key)?.size ?? 0
    if (n === 0) continue
    askersByTheme.set(rule.key, n)
    if (n < MIN_DISTINCT_ASKERS) { dropped.too_few_askers = (dropped.too_few_askers ?? 0) + 1; continue }
    const at = newest.get(rule.key) || now.toISOString()
    themes.push({
      title: `Your clients keep asking: ${rule.label}`,
      valueAngle: `${n} different people asked about this in your own messages and inquiries in the last 30 days — answer it once, clearly, in your voice. (Counts only: no client's words or identity are stored.)`,
      categories: [...new Set([...rule.categories, "customer_question", "topic_intelligence"])],
      engagementScore: Math.min(100, 20 * n),
      sourceUrl: null,
      topicPostedAt: at,
      expiresDays: 30,
      geo: null,
      evidence: {
        source_class: "customer_question", source: "messages (inbound) + listing_inquiries", observed_at: at, window_days: 30,
        engagement: { basis: "internal_count", metrics: { distinct_askers: n } },
        confidence: clamp01(0.5 + 0.1 * Math.min(4, n - MIN_DISTINCT_ASKERS + 1)),
        confidence_basis: `${n} distinct askers (threshold ${MIN_DISTINCT_ASKERS})`,
        theme_key: `customer_question:${rule.key}`, theme_only: true, private_metrics: false, feeds: rule.feeds,
      },
    })
  }
  return { themes, askersByTheme, dropped }
}

export interface ModuleRow { title: string | null; summary: string | null; gap_tags: string[] | null; status: string | null }

/** PURE. EDUCATION GAPS — question themes (asked by enough people) that no published education module covers. */
export function educationGapThemes(askersByTheme: ReadonlyMap<string, number>, modules: readonly ModuleRow[], now: Date): IntelTheme[] {
  // Only a PUBLISHED module reaches a client (learning_modules.status CHECK: draft / pending_review / published / archived / rejected).
  const live = modules.filter((m) => m.status === "published")
  const covered = (rule: ThemeRule) => live.some((m) => rule.re.test(`${m.title ?? ""} ${m.summary ?? ""} ${(m.gap_tags ?? []).join(" ")}`))
  const out: IntelTheme[] = []
  for (const rule of REAL_ESTATE_THEMES) {
    const n = askersByTheme.get(rule.key) ?? 0
    if (n < MIN_DISTINCT_ASKERS || covered(rule)) continue
    out.push({
      title: `Education gap: ${rule.label}`,
      valueAngle: `${n} clients asked about this and none of your ${live.length} education module(s) covers it — a guide, a short video or a module closes the gap.`,
      categories: [...new Set([...rule.categories, "education_gap", "topic_intelligence"])],
      engagementScore: Math.min(100, 20 * n + 10),
      sourceUrl: null,
      topicPostedAt: now.toISOString(),
      expiresDays: 30,
      geo: null,
      evidence: {
        source_class: "education_gap", source: "customer questions × learning_modules", observed_at: now.toISOString(), window_days: 30,
        engagement: { basis: "internal_count", metrics: { distinct_askers: n, modules_checked: live.length } },
        confidence: 0.6, confidence_basis: "a theme match against module titles, summaries and gap tags (a module may cover it in other words)",
        theme_key: `education_gap:${rule.key}`, theme_only: true, private_metrics: false,
        feeds: [...new Set<TopicFeed>(["education", "lead_magnet", ...rule.feeds])],
      },
    })
  }
  return out
}

export interface CitationRow { query: string | null; outcome: string | null; competitors_cited: string[] | null; platform: string | null; observed_at: string | null }

/** PURE. AI-SEARCH GAPS — the questions the monitor asks where answers name competitors and not the tenant. */
export function aiSearchGapThemes(rows: readonly CitationRow[], now: Date): IntelTheme[] {
  const byQuery = new Map<string, { query: string; observed: number; missed: number; competitorCites: number; platforms: Set<string>; newest: string }>()
  for (const r of rows) {
    const q = String(r.query ?? "").replace(/\s+/g, " ").trim()
    if (!q || r.outcome === "not_checked") continue
    if (excludedTopicReason(q)) continue
    const k = slug(q)
    const cur = byQuery.get(k) ?? { query: q, observed: 0, missed: 0, competitorCites: 0, platforms: new Set<string>(), newest: "" }
    cur.observed++
    if (r.outcome === "not_cited") { cur.missed++; cur.competitorCites += (r.competitors_cited ?? []).length }
    if (r.platform) cur.platforms.add(r.platform)
    cur.newest = [cur.newest, r.observed_at ?? ""].sort().pop() ?? ""
    byQuery.set(k, cur)
  }
  const out: IntelTheme[] = []
  for (const [k, v] of byQuery) {
    if (v.missed === 0 || v.competitorCites === 0) continue
    const theme = themesOf(v.query)[0]
    out.push({
      title: `AI search answers this without you: "${v.query}"`.slice(0, 200),
      valueAngle: `${v.missed} of ${v.observed} AI-search answers to this question named ${v.competitorCites} competitor citation(s) and not you — publish the clearest answer (FAQ, article, short video). Visibility is never promised.`,
      categories: [...new Set([...(theme?.categories ?? ["market_education"]), "ai_search_gap", "topic_intelligence"])],
      engagementScore: Math.min(100, 15 * v.missed + 10 * v.competitorCites),
      sourceUrl: null,
      topicPostedAt: v.newest || now.toISOString(),
      expiresDays: 30,
      geo: null,
      evidence: {
        source_class: "ai_search_gap", source: "ai_search_citation_observations", observed_at: v.newest || now.toISOString(), window_days: 30,
        engagement: { basis: "observation_count", metrics: { observations: v.observed, not_cited: v.missed, competitor_citations: v.competitorCites, platforms: v.platforms.size } },
        confidence: clamp01(0.5 + 0.1 * Math.min(4, v.observed)),
        confidence_basis: `${v.observed} monitor observation(s) on ${v.platforms.size} platform(s)`,
        theme_key: `ai_search_gap:${k}`, theme_only: true, private_metrics: false,
        feeds: [...new Set<TopicFeed>(["education", "social_post", "video", ...(theme?.feeds ?? [])])],
      },
    })
  }
  return out
}

export interface MarketDataRow {
  zip_code: string | null; city: string | null; state: string | null; market_area: string | null; data_date: string | null; source_type: string | null
  median_sale_price: number | null; price_trend_pct_1yr: number | null
  months_of_inventory: number | null; avg_days_on_market: number | null
}
// NOT read: price_trend_pct_90d (no writer — the ONE market_data writer, lib/intelligence/market-insight-generator.ts, never
// sets it) and price_trend_pct_30d (that writer stores a constant 0). The 90-day move is DERIVED from the tenant's own
// median_sale_price history instead (two written columns, two dated rows) — never a column nobody fills.

/**
 * The market classification by months of supply — `.claude/skills/realestate-market` "Market Type Criteria" (Strong Seller's
 * < 2, Seller's 2-3, Balanced 4-6, Buyer's 6-8, Strong Buyer's > 8). The gaps the table leaves (3-4) read as the nearer band.
 */
function marketClassFromSupply(months: number): "strong_sellers" | "sellers" | "balanced" | "buyers" | "strong_buyers" {
  if (months < 2) return "strong_sellers"
  if (months < 4) return "sellers"
  if (months <= 6) return "balanced"
  if (months <= 8) return "buyers"
  return "strong_buyers"
}

const MARKET_STALE_DAYS = 90

/** PURE. PROPERTY-VALUE TRENDS and MARKET CHANGES from the tenant's own market statistics (facts with source + date; never a valuation). */
export function marketThemes(rows: readonly MarketDataRow[], now: Date): { themes: IntelTheme[]; dropped: Record<string, number> } {
  const dropped: Record<string, number> = {}
  const latest = new Map<string, MarketDataRow>()
  const history = new Map<string, MarketDataRow[]>()
  for (const r of rows) {
    const area = r.zip_code ?? r.market_area ?? r.city
    if (!area || !r.data_date) continue
    const k = slug(area)
    const cur = latest.get(k)
    if (!cur || (cur.data_date ?? "") < r.data_date) latest.set(k, r)
    history.set(k, [...(history.get(k) ?? []), r])
  }
  /** The ~90-day move in the median sale price: the row 60–120 days before the latest one, nearest to 90 (both prices written). */
  const move90Of = (k: string, r: MarketDataRow): { pct: number; from: MarketDataRow } | null => {
    if (typeof r.median_sale_price !== "number" || r.median_sale_price <= 0) return null
    const t = Date.parse(r.data_date as string)
    let best: { row: MarketDataRow; off: number } | null = null
    for (const h of history.get(k) ?? []) {
      if (typeof h.median_sale_price !== "number" || h.median_sale_price <= 0 || !h.data_date) continue
      const back = (t - Date.parse(h.data_date)) / 86_400_000
      if (back < 60 || back > 120) continue
      const off = Math.abs(back - 90)
      if (!best || off < best.off) best = { row: h, off }
    }
    if (!best) return null
    return { pct: Math.round(((r.median_sale_price - (best.row.median_sale_price as number)) / (best.row.median_sale_price as number)) * 1000) / 10, from: best.row }
  }
  const themes: IntelTheme[] = []
  for (const [k, r] of latest) {
    const ageDays = (now.getTime() - Date.parse(r.data_date as string)) / 86_400_000
    if (!(ageDays <= MARKET_STALE_DAYS)) { dropped.stale_market_data = (dropped.stale_market_data ?? 0) + 1; continue }
    const area = r.zip_code ? `ZIP ${r.zip_code}` : (r.market_area ?? [r.city, r.state].filter(Boolean).join(", "))
    const asOf = String(r.data_date).slice(0, 10)
    const src = `market_data (${r.source_type ?? "source unrecorded"}, as of ${asOf})`
    const geo = { ...(r.zip_code ? { zip_codes: [r.zip_code] } : {}), ...(r.city ? { cities: [r.city] } : {}), ...(r.state ? { states: [r.state] } : {}) }
    const confidence = ageDays <= 35 ? 0.8 : 0.6
    const base = { sourceUrl: null, topicPostedAt: String(r.data_date), expiresDays: 30, geo }
    if (typeof r.price_trend_pct_1yr === "number") {
      const pct = Math.round(r.price_trend_pct_1yr * 10) / 10
      const facts = [`Median sale-price trend over 12 months in ${area}: ${pct > 0 ? "+" : ""}${pct}% (${src})`]
      if (typeof r.median_sale_price === "number") facts.push(`Median sale price in ${area}: $${Math.round(r.median_sale_price).toLocaleString("en-US")} (${src})`)
      themes.push({
        ...base,
        title: `Home values in ${area}: ${pct > 0 ? "up" : pct < 0 ? "down" : "flat"} ${Math.abs(pct)}% over 12 months`,
        valueAngle: `Explain what the 12-month trend means for owners and buyers in ${area}, stating only these figures with their source and date — ${facts.join("; ")}. Market statistics describe the area — never the value of any one home (that takes a CMA or an appraisal).`,
        categories: ["market_education", "neighborhood", "property_value_trend", "topic_intelligence"],
        engagementScore: Math.min(100, Math.round(40 + Math.abs(pct) * 5)),
        evidence: {
          source_class: "property_value_trend", source: src, observed_at: String(r.data_date), window_days: 365,
          engagement: { basis: "none", metrics: {} }, confidence, confidence_basis: `the tenant's own market statistics, ${Math.round(ageDays)} day(s) old`,
          theme_key: `property_value_trend:${k}`, theme_only: true, private_metrics: false,
          feeds: ["property_value_commentary", "local_market", "video", "podcast", "social_post", "ctv_ad"], facts,
        },
      })
    }
    const supply = typeof r.months_of_inventory === "number" ? r.months_of_inventory : null
    const cls = supply !== null ? marketClassFromSupply(supply) : null
    const derived = move90Of(k, r)
    const move90 = derived ? derived.pct : null
    if ((cls && cls !== "balanced") || (move90 !== null && Math.abs(move90) >= 2)) {
      const facts = [
        ...(supply !== null ? [`Months of supply in ${area}: ${Math.round(supply * 10) / 10} (${src})`] : []),
        ...(derived ? [`Median sale price in ${area}: $${Math.round(derived.from.median_sale_price as number).toLocaleString("en-US")} on ${String(derived.from.data_date).slice(0, 10)} → $${Math.round(r.median_sale_price as number).toLocaleString("en-US")} on ${asOf}, ${derived.pct > 0 ? "+" : ""}${derived.pct}% (market_data (${r.source_type ?? "source unrecorded"}), two dated rows)`] : []),
        ...(typeof r.avg_days_on_market === "number" ? [`Average days on market in ${area}: ${Math.round(r.avg_days_on_market)} (${src})`] : []),
      ]
      const label = cls ? cls.replace(/_/g, " ").replace("sellers", "seller's").replace("buyers", "buyer's") : null
      themes.push({
        ...base,
        title: `Market shift in ${area}${label ? `: reading as a ${label} market` : ""}${move90 !== null ? ` (${move90 > 0 ? "+" : ""}${move90}% in 90 days)` : ""}`.slice(0, 200),
        valueAngle: `What changed in ${area} and what it means for anyone deciding now — state only these figures with their source and date: ${facts.join("; ")}. The market label follows the months-of-supply bands (realestate-market criteria), never a prediction.`,
        categories: ["market_education", "market_change", "topic_intelligence"],
        engagementScore: Math.min(100, Math.round(50 + Math.abs(move90 ?? 0) * 5)),
        evidence: {
          source_class: "market_change", source: src, observed_at: String(r.data_date), window_days: 90,
          engagement: { basis: "none", metrics: {} }, confidence, confidence_basis: `the tenant's own market statistics, ${Math.round(ageDays)} day(s) old; classification by months of supply`,
          theme_key: `market_change:${k}`, theme_only: true, private_metrics: false,
          feeds: ["local_market", "property_value_commentary", "video", "podcast", "social_post", "ctv_ad"], facts,
        },
      })
    }
  }
  return { themes, dropped }
}

/**
 * PURE. A competitor AD's THEME — the topic label(s) the ad touches, never its headline or copy. For the competitor-ad writer
 * (lib/competitive-intel/promote-to-topic-bank.ts) so its topic rows carry a theme instead of the rival's words (ruling 22:
 * "extract themes, never copy creative").
 */
export function competitorAdTheme(headline: string | null | undefined, copy: string | null | undefined): { title: string; valueAngle: string; themeKeys: string[] } | null {
  const text = `${headline ?? ""} ${copy ?? ""}`
  if (excludedTopicReason(text)) return null
  const themes = themesOf(text)
  if (themes.length === 0) return null
  return {
    title: `Competitors are advertising on: ${themes.slice(0, 2).map((t) => t.label.split(" — ")[0]).join(" and ")}`.slice(0, 120),
    valueAngle: "A competitor is paying to reach people on this topic — answer it better, in your own words and locally. Never reuse their headline, copy, images or offer.",
    themeKeys: themes.map((t) => t.key),
  }
}
