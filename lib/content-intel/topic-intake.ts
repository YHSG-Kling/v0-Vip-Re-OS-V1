// lib/content-intel/topic-intake.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE TYPED TOPIC INTAKE (wave 154, lane 154C — owner rulings R1, R3, R9; directive C5.4 / C5.6).
//
// SURVIVOR: the live table content_topic_bank (m128) and its source rows content_topic_sources — no new table, no new column.
// Every producer of a topic (scraped chatter, Facebook group questions, Meta Ad Library creatives, competitor ads, Reddit,
// Apify handles, search demand, a subscriber's own hand-saved link) hands this ONE function a TopicIdea; this function is the
// only typed insert. What it guarantees, in order, before any write:
//   1. TENANT — every read and write is pinned to the brokerage the caller resolved from its session / cron scope
//      (`brokerage_id = X`, or `brokerage_id IS NULL` for the platform pool, which then requires an explicit sourceId).
//   2. THE EXCLUSION GATE (R9) — classifyTopicExclusion runs BEFORE storage and before any generation: competitor brand
//      self-promotion, agent-joining announcements, recruiting pitches, listing brags / contests with no consumer value and
//      unverified performance claims never enter the pool. A post that MAINLY carries a consumer question or market fact
//      survives once the pitch sentences are separated. Engagement is not an input — high reactions never rescue an item.
//   3. NO PERSONAL DATA, NO SOURCE WORDING — a title / angle carrying an email, a phone number or a profile link is refused;
//      brief keys that would carry an author, a member list, contact details or the source's own text are STRIPPED and
//      counted. `title` is the caller's REWORDED topic (public_read_reworded callers prove that with rewordedNearCopyProblem).
//   4. RIGHTS — rights "unknown" is refused (a source whose rights nobody recorded is not stored).
//   5. FRESHNESS — expires_at is set on every row; an item whose source is older than its kind's current-intent window, or
//      whose expiry is already past, is refused ("a year-old post is not current intent").
//   6. EVIDENCE — measured / proxy / unknown with metric + unit kept in raw_data.evidence. The engagement_score COLUMN is
//      written only from a 0–100 score the caller states (unit "score_0_100"); an unmeasured engagement is NOT written as a
//      number (raw_data.evidence.value stays null). BLIND SPOT, schema truth: m128 declares engagement_score NOT NULL DEFAULT
//      0, so the column reads 0 for such a row — readers must consult raw_data.popularity_evidence_type.
//   7. ONE IDEA, LINKED PROVENANCE — the dedup key (caller's, or the normalized reworded title + geography) finds an existing
//      row of this tenant; a new observation appends to raw_data.provenance, while the SAME observation (its observation_key:
//      a content digest or the canonical source URL) found again by another transport only adds that transport — it is
//      counted once as popularity evidence, however many transports saw it.
//   8. COUNTED WRITES (CLAUDE.md §3) — every insert / update `.select("id")`s and counts what came back; a refusal is read
//      and reported, never swallowed. A used / rejected row is never resurrected by a re-observation.
//
// The C5.6 creative brief (consumer_question, topic_concept, hook_pattern, format_pattern, emotional_need, market_relevance,
// proof_needed, localization_opportunity, suggested_original_formats, source_observed_at, popularity_evidence_type,
// source_rights, expires_at, exclusion_reason) is mapped into raw_data.creative_brief — the presentation contract on the
// surviving jsonb column.
//
// Not server-only: the proofs (scripts/public-chatter-topics-guard.ts) drive it with an in-memory client.

import { REAL_ESTATE_THEMES, isQuestion } from "./topic-themes"
import { resolveSystemTopicSource, type SystemTopicWriter } from "./system-topic-source"

type Db = { from: (table: string) => any }

// ── The contract (WAVE154 charter — every lane calls this shape) ──────────────────────────────────────────────────────

export type TopicEvidenceKind = "measured" | "proxy" | "unknown"
/** ADDITIVE (wave 154, lane 154G1): "public_citation" — a public article's HEADLINE, a short credited excerpt, its link and
 *  date (the local-intelligence / RSS / Exa news rule since wave 144: "title, ≤280-char excerpt, link and date only — never
 *  the article body"). It is NOT a rewording, so it never claims to be one. */
export type TopicRights = "licensed" | "own_content" | "public_read_reworded" | "public_citation" | "first_party" | "unknown"

export interface TopicIdea {
  sourceKind: string
  /** The REWORDED consumer question / topic — never a source's own wording (a public_citation idea carries the credited headline). */
  title: string
  angle?: string | null
  categories?: string[]
  /** ADDITIVE (154G1): cities / states / zip_codes for a topic that spans several places of a territory. The stored
   *  geo_relevance is ALWAYS the picker's reader shape { cities[], states[], zip_codes[] } (+ label) — see geoRelevanceOf. */
  geo?: { city?: string | null; state?: string | null; zip?: string | null; label?: string | null; cities?: string[] | null; states?: string[] | null; zip_codes?: string[] | null } | null
  sourceUrl?: string | null
  publishedAt?: string | null
  observedAt: string
  expiresAt?: string | null
  evidence: { kind: TopicEvidenceKind; metric?: string | null; value?: number | null; unit?: string | null; note?: string | null }
  rights: TopicRights
  brief?: Record<string, unknown> | null
  dedupKey?: string | null
  /** ADDITIVE to the charter shape: the content_topic_sources row this idea files under. Absent → the tenant's system source
   *  for the idea's kind (resolveSystemTopicSource); the platform pool (brokerageId null) must name one. */
  sourceId?: string | null
}

export type TopicExclusionReason =
  | "competitor_brand_self_promotion" | "competitor_agent_joining" | "recruitment_pitch" | "no_consumer_value" | "unverified_performance"

/** Intake refusals beyond the R9 gate — machine-readable, returned in `excluded`, never stored. */
type TopicIntakeRefusal = "personal_data_in_topic" | "rights_unknown" | "stale_source" | "already_expired" | "empty_title" | "invalid_observed_at"

/** What a person is told when an idea was NOT stored — one sentence per reason in the two closed vocabularies above. */
const NOT_STORED_TEXT: Readonly<Record<TopicExclusionReason | TopicIntakeRefusal, string>> = Object.freeze({
  competitor_brand_self_promotion: "It reads as another company promoting itself, not a question a buyer or seller would ask.",
  competitor_agent_joining: "It is an announcement about an agent joining a company, not a topic for consumers.",
  recruitment_pitch: "It is a recruiting pitch, not a topic for consumers.",
  no_consumer_value: "It does not contain a question or need a buyer, seller or homeowner would recognize.",
  unverified_performance: "It rests on a performance claim that could not be verified.",
  personal_data_in_topic: "It contains personal details (a name, phone number, email or address). Topics are stored without them.",
  rights_unknown: "The source's usage rights are not recorded, so nothing from it is stored.",
  stale_source: "The source is too old to count as a current topic.",
  already_expired: "The topic's freshness window has already ended.",
  empty_title: "There was no topic text to save.",
  invalid_observed_at: "The observation date could not be read.",
})
/** The tenant-facing sentence for a not-stored reason; an unlisted reason gets a plain fallback, never a raw code. */
export function explainTopicNotStored(reason: string): string {
  return Object.prototype.hasOwnProperty.call(NOT_STORED_TEXT, reason) ? NOT_STORED_TEXT[reason as TopicExclusionReason | TopicIntakeRefusal] : "It could not be saved as a topic."
}

export interface TopicIntakeResult {
  ok: boolean
  inserted: number
  merged: number
  excluded: Array<{ title: string; reason: string }>
  refused?: string
  /** ADDITIVE: the row each stored idea landed on (callers that propose follow-ons need the id). */
  rows: Array<{ dedupKey: string; id: string; isNew: boolean }>
  /** ADDITIVE: brief fields stripped because they could carry personal data or the source's own wording. */
  strippedFields: number
  /** ADDITIVE: re-observations that added only a transport to an existing observation (counted once). */
  sameObservation: number
  errors: string[]
}

// ── The exclusion gate (R9 / directive C5.4) — PURE ──────────────────────────────────────────────────────────────────

const JOINING_RE = /\b(?:(?:please\s+)?welcome|welcoming|excited to (?:welcome|announce)|proud to (?:welcome|announce)|thrilled to (?:welcome|announce)|happy to (?:welcome|announce))\b[^.!?\n]{0,80}\b(?:new(?:est)?\s+(?:agent|realtor|team member|associate|broker|loan officer)s?|to (?:our|the) (?:team|brokerage|family|office))\b|\b(?:has|have)\s+(?:officially\s+)?joined\s+(?:our|the)\s+(?:team|brokerage|office|family)\b|\bjoins\s+(?:our|the)\s+(?:team|brokerage|office)\b|\bnewest\s+(?:agent|realtor|team member)\b|\bwelcome (?:aboard|to the team)\b/i
const RECRUITING_RE = /\b(?:join our (?:team|brokerage)|we(?:'re| are) hiring|now hiring|agents? wanted|recruiting (?:agents|realtors)|career opportunit\w*|grow your (?:real estate )?(?:career|business) with us|(?:higher|better|100%|90\/10|80\/20) (?:commission )?splits?|commission splits?|(?:capped|cap) at \$?\d|thinking (?:of|about) (?:switching|changing) brokerages?|switch(?:ing)? brokerages?|attention (?:agents|realtors)|calling all (?:agents|realtors)|licensed agents?,? (?:are you|looking))\b/i
const BRAND_PROMO_RE = /\b(?:we(?:'re| are) (?:the )?#?\s?1|number one brokerage|#1 (?:brokerage|team|real estate)|award[- ]winning (?:brokerage|team)|(?:brokerage|company|office)(?:'s)? (?:\d+\w*\s+)?anniversary|celebrating \d+ years|grand opening|office opening|opened (?:our|a) new office|new office location|rebrand(?:ed|ing)?|(?:our|the) new website|proud to be (?:named|recognized)|voted (?:the )?best (?:brokerage|team|agent)|brand awareness)\b/i
const BRAG_RE = /\b(?:just sold|another one sold|sold over asking|under contract in \d+ (?:hours|days)|giveaway|contest|tag (?:a friend|\d+ friends)|like (?:and|&) share|follow us|enter to win|broker selfie|trophy)\b/i
const PERFORMANCE_RE = /\b(?:top \d+(?:\.\d+)?%|#1 (?:agent|realtor)|number one agent|sold \d[\d,]*\+? homes|record[- ]breaking|best agent in|guaranteed (?:sale|to sell)|we sell homes in \d+ days|\$\d[\d.,]*\s?(?:m|k|million|billion)? in (?:sales|volume))\b/i

const NOISE_RULES: ReadonlyArray<{ reason: TopicExclusionReason; re: RegExp }> = [
  { reason: "competitor_agent_joining", re: JOINING_RE },
  { reason: "recruitment_pitch", re: RECRUITING_RE },
  { reason: "unverified_performance", re: PERFORMANCE_RE },
  { reason: "competitor_brand_self_promotion", re: BRAND_PROMO_RE },
  { reason: "no_consumer_value", re: BRAG_RE },
]

/** PURE — the sentences of a text that carry consumer value (page chrome, names and pitches fall away). The observation
 *  digest of public chatter is taken over these, so the same post reposted on another site is ONE observation. */
export function consumerValueSentences(text: string): string[] {
  return String(text ?? "").replace(/\s+/g, " ").split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => words(s).length > 0 && sentenceHasConsumerValue(s))
}

/** A sentence carries consumer value: it touches a real-estate question theme, or it is a real-estate question. */
function sentenceHasConsumerValue(s: string): boolean {
  if (REAL_ESTATE_THEMES.some((t) => t.re.test(s))) return true
  return isQuestion(s) && /\b(home|house|buy\w*|sell\w*|mortgage|closing|rent\w*|lease|neighborhood|inspection|insurance|offer|agent representation|buyer representation)\b/i.test(s)
}

const words = (s: string): string[] => String(s ?? "").toLowerCase().match(/[a-z0-9']+/g) ?? []

/**
 * PURE — R9 / C5.4. Excluded when the text's noise (pitch, joining, recruiting, brag, unverified claim) is not outweighed by
 * substantive consumer value once the noise sentences are separated: the remaining value sentences must carry ≥ 8 words and
 * ≥ 40% of the text's words. No noise → not excluded (the gate never guesses value away). Engagement is not an input.
 */
export function classifyTopicExclusion(input: { title: string; text?: string | null; sourceKind?: string | null }): { excluded: boolean; reason: TopicExclusionReason | null } {
  const full = `${input.title ?? ""}. ${input.text ?? ""}`.replace(/\s+/g, " ").trim()
  const sentences = full.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => words(s).length > 0)
  const noisy: Array<{ s: string; reason: TopicExclusionReason }> = []
  const clean: string[] = []
  // A CIVIC local fact (wave 154, lane 154G1): a public news item / event of the place — "grand opening of the new library",
  // "giveaway at the farmers market" — is the local content R9 must NOT remove; brand promotion and listing brags are rules
  // about a COMPETITOR's own posts. Joining, recruiting and unverified performance claims still exclude it.
  const rules = input.sourceKind === "local_fact" ? NOISE_RULES.filter((r) => r.reason !== "competitor_brand_self_promotion" && r.reason !== "no_consumer_value") : NOISE_RULES
  for (const s of sentences) {
    const hit = rules.find((r) => r.re.test(s))
    if (hit) noisy.push({ s, reason: hit.reason })
    else clean.push(s)
  }
  if (noisy.length === 0) return { excluded: false, reason: null }
  const total = sentences.reduce((n, s) => n + words(s).length, 0)
  const valueWords = clean.filter(sentenceHasConsumerValue).reduce((n, s) => n + words(s).length, 0)
  if (valueWords >= 8 && total > 0 && valueWords / total >= 0.4) return { excluded: false, reason: null }
  // The strongest reason, in rule order (joining > recruiting > performance > brand > brag).
  for (const r of rules) if (noisy.some((n) => n.reason === r.reason)) return { excluded: true, reason: r.reason }
  return { excluded: true, reason: noisy[0].reason }
}

// ── Reword-before-store: the deterministic near-copy refusal (R1) — PURE ─────────────────────────────────────────────

/**
 * PURE — refuse a "reworded" title / angle that is still a near-copy of the source text: any shared run of 5 words, the
 * candidate (≥ 4 words) contained in the source, or ≥ 70% of the candidate's content words taken from the source when the
 * candidate shares a 3-word run with it. Returns the reason, or null when the rewording is original enough.
 */
export function rewordedNearCopyProblem(candidate: string, sourceText: string): string | null {
  const c = words(candidate), s = words(sourceText)
  if (c.length === 0) return "empty rewording"
  if (s.length === 0) return null
  const sj = ` ${s.join(" ")} `
  if (c.length >= 4 && sj.includes(` ${c.join(" ")} `)) return "the rewording is contained verbatim in the source"
  const grams = (xs: string[], n: number) => { const g = new Set<string>(); for (let i = 0; i + n <= xs.length; i++) g.add(xs.slice(i, i + n).join(" ")); return g }
  const s5 = grams(s, 5)
  for (const g of grams(c, 5)) if (s5.has(g)) return `shares a five-word run with the source ("${g}")`
  const STOP = new Set(["the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "is", "are", "it", "with", "your", "you", "what", "how", "do", "does", "my", "our", "i", "we"])
  const content = c.filter((w) => !STOP.has(w))
  const sset = new Set(s)
  const taken = content.filter((w) => sset.has(w)).length
  const s3 = grams(s, 3)
  const shares3 = [...grams(c, 3)].some((g) => s3.has(g))
  if (content.length >= 4 && shares3 && taken / content.length >= 0.7) return `${Math.round((taken / content.length) * 100)}% of the rewording's content words come from the source with a shared phrase — a synonym-swap, not a rewording`
  return null
}

// ── Personal-data screens — PURE ─────────────────────────────────────────────────────────────────────────────────────

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/
const PROFILE_RE = /\b(?:facebook\.com\/(?:profile\.php|people|[A-Za-z0-9.]{5,}\/?$)|nextdoor\.com\/profile|instagram\.com\/[A-Za-z0-9._]+\/?$|linkedin\.com\/in\/)/i

/** PURE — does a stored text carry a contact point or a profile link? */
export function personalDataProblem(text: string | null | undefined): string | null {
  const t = String(text ?? "")
  if (EMAIL_RE.test(t)) return "an email address"
  if (PHONE_RE.test(t)) return "a phone number"
  if (PROFILE_RE.test(t)) return "a profile link"
  return null
}

/** Brief keys that would carry a person or the source's own wording — stripped before storage, counted. */
const STRIP_KEYS = /^(?:author\w*|user\w*|profile\w*|member\w*|commenter\w*|comments?|top_?comments|email\w*|phone\w*|contact\w*|name|full_?name|handle|avatar\w*|text|post_?text|source_?text|caption|body|quote\w*|selftext|summary|ad_?copy|ad_?headline|snippet|html)$/i
/** raw_data keys this intake owns — a caller's brief may not overwrite them. */
const RESERVED_KEYS = new Set(["intake", "dedup_key", "evidence", "popularity_evidence_type", "provenance", "independent_observations", "creative_brief", "source_removals"])
const CREATIVE_BRIEF_FIELDS = [
  "consumer_question", "topic_concept", "hook_pattern", "format_pattern", "emotional_need", "market_relevance", "proof_needed",
  "localization_opportunity", "suggested_original_formats", "source_observed_at", "popularity_evidence_type", "source_rights", "expires_at", "exclusion_reason",
] as const

// ── Freshness windows by source kind (days) ──────────────────────────────────────────────────────────────────────────

/** How long a topic stays fresh after observation, and how old its source may be and still read as CURRENT. */
const KIND_WINDOWS: Readonly<Record<string, { expiresDays: number; maxSourceAgeDays: number }>> = Object.freeze({
  community_post: { expiresDays: 21, maxSourceAgeDays: 60 },
  facebook_group_question: { expiresDays: 21, maxSourceAgeDays: 60 },
  meta_ad_creative: { expiresDays: 30, maxSourceAgeDays: 180 },
  competitor_ad: { expiresDays: 30, maxSourceAgeDays: 180 },
  reddit_thread: { expiresDays: 21, maxSourceAgeDays: 90 },
  apify_social: { expiresDays: 14, maxSourceAgeDays: 90 },
  manual_link: { expiresDays: 30, maxSourceAgeDays: 365 },
  own_observation: { expiresDays: 30, maxSourceAgeDays: 365 },
  // wave 154 (154G1) — the producers routed onto the intake keep the TTL they already wrote (cited at each caller).
  news_article: { expiresDays: 21, maxSourceAgeDays: 120 },          // content-intel-rss (21 d)
  web_research: { expiresDays: 14, maxSourceAgeDays: 120 },          // content-intel-exa (14 d)
  refurbish_competitor_post: { expiresDays: 30, maxSourceAgeDays: 180 },
})
const DEFAULT_WINDOW = { expiresDays: 21, maxSourceAgeDays: 365 }

/**
 * TOPIC SOURCE KIND → REFURBISH TRIGGER KIND (wave 154, lane 154G1 — cross-lane defect D2, lane 154F). The pool's kinds
 * (this file's vocabulary + search-demand.ts SEARCH_DEMAND_SOURCE_KINDS + public-chatter-topics.ts) are not the names
 * lib/repurpose/refurbish-idea.ts refurbishTriggerVerdict reads ("google_trend" / "public_chatter" / "competitor_watch" /
 * "own_underperformer"), so a stored trend or community topic could never start a Refurbish draft. ONE published mapping;
 * lane 154H's sessionless starter reads it (or the stamped raw_data.intake.refurbish_trigger_kind). null = this kind does not
 * start a Refurbish (local facts, look-alike briefs, citations, manual notes, internal theme intelligence).
 * "competitor_watch" still needs the trigger's own watchlist authorization — the mapping grants nothing.
 */
const REFURBISH_TRIGGER_BY_TOPIC_SOURCE: Readonly<Record<string, "google_trend" | "public_chatter" | "competitor_watch" | "own_underperformer">> = Object.freeze({
  google_trends: "google_trend", search_demand_search_console: "google_trend", search_demand_first_party: "google_trend", search_demand_keyword_intel: "google_trend",
  community_post: "public_chatter", facebook_group_question: "public_chatter", reddit_thread: "public_chatter", apify_social: "public_chatter", brand_listening: "public_chatter",
  meta_ad_creative: "competitor_watch", competitor_ad: "competitor_watch", competitor_post: "competitor_watch", refurbish_competitor_post: "competitor_watch",
  own_content_outcome: "own_underperformer",
})
export function refurbishTriggerKindForTopicSource(kind: string | null | undefined): "google_trend" | "public_chatter" | "competitor_watch" | "own_underperformer" | null {
  return kind && Object.prototype.hasOwnProperty.call(REFURBISH_TRIGGER_BY_TOPIC_SOURCE, kind) ? REFURBISH_TRIGGER_BY_TOPIC_SOURCE[kind] : null
}
function topicWindowFor(kind: string): { expiresDays: number; maxSourceAgeDays: number } { return KIND_WINDOWS[kind] ?? DEFAULT_WINDOW }

/** The system writer a source kind files under when the caller names no source row (the tenant's own off switch). */
function systemWriterFor(kind: string): SystemTopicWriter {
  if (kind === "competitor_ad" || kind === "meta_ad_creative") return "competitor_promotion"
  if (kind === "topic_intelligence") return "topic_intelligence"
  if (kind === "community_post" || kind === "facebook_group_question" || kind === "manual_link" || kind === "own_observation") return "public_chatter"
  return "topic_intake"
}

const DAY_MS = 86_400_000
const normKey = (s: string) => words(s).join(" ").slice(0, 160)
const iso = (v: string | null | undefined): string | null => { if (!v) return null; const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null }
const hostOf = (u: string | null | undefined): string | null => { try { return u ? new URL(u).hostname.toLowerCase().replace(/^www\./, "") : null } catch { return null } }
const EVIDENCE_RANK: Record<TopicEvidenceKind, number> = { unknown: 0, proxy: 1, measured: 2 }

/** PURE — the dedup key: the caller's, or the reworded title + the geography the source stated. */
function topicDedupKey(idea: Pick<TopicIdea, "title" | "geo" | "dedupKey">): string {
  if (idea.dedupKey && idea.dedupKey.trim()) return idea.dedupKey.trim().slice(0, 200)
  const gr = geoRelevanceOf(idea.geo)
  const g = gr ? normKey([...gr.zip_codes, ...gr.cities, ...gr.states, gr.label].filter(Boolean).join(" ")) : ""
  return `t:${normKey(idea.title)}|g:${g}`
}

/**
 * PURE — the stored geo_relevance, in the shape its READER expects. lib/content-intel/topic-bank.ts matchesGeo reads
 * { cities[], states[], zip_codes[] }; at the batch-2 base this intake stored the idea's { city, state, zip, label } verbatim,
 * so NO intake-filed topic could ever earn the picker's geo match (a localized topic ranked as if it were national). FIXED
 * (wave 154, lane 154G1): singular and plural forms merge into the reader shape; the label rides along. null when no place.
 */
function geoRelevanceOf(geo: TopicIdea["geo"]): { cities: string[]; states: string[]; zip_codes: string[]; label: string | null } | null {
  if (!geo) return null
  const list = (one: string | null | undefined, many: string[] | null | undefined, f: (s: string) => string) =>
    [...new Set([one, ...(many ?? [])].map((s) => String(s ?? "").trim()).filter(Boolean).map(f))]
  const cities = list(geo.city, geo.cities, (s) => s)
  const states = list(geo.state, geo.states, (s) => s.toUpperCase())
  const zip_codes = list(geo.zip, geo.zip_codes, (s) => s.slice(0, 5))
  const label = geo.label ? String(geo.label).trim() || null : null
  if (!cities.length && !states.length && !zip_codes.length && !label) return null
  return { cities, states, zip_codes, label }
}

/** PURE — the observation key: one real observation, however many transports found it. */
function topicObservationKey(idea: Pick<TopicIdea, "sourceUrl" | "brief" | "sourceKind" | "title">): string {
  const k = idea.brief?.observation_key
  if (typeof k === "string" && k.trim()) return `o:${k.trim().slice(0, 120)}`
  if (idea.sourceUrl) {
    try { const u = new URL(idea.sourceUrl); u.hash = ""; for (const p of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref)/i.test(p)) u.searchParams.delete(p); return `u:${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${u.search}` } catch { /* fall through */ }
  }
  return `k:${idea.sourceKind}:${normKey(idea.title)}`
}

interface ProvenanceEntry {
  observation_key: string; source_kind: string; host: string | null; source_url: string | null; urls: string[]
  observed_at: string; published_at: string | null; transports: string[]; rights: TopicRights
  evidence: { kind: TopicEvidenceKind; metric: string | null; value: number | null; unit: string | null }
}

type Prepared = { idea: TopicIdea; dedupKey: string; obsKey: string; expiresAt: string; observedAt: string; brief: Record<string, unknown>; extra: Record<string, unknown>; transport: string | null }

/** PURE — screen + normalize one idea. Returns the refusal reason or the prepared idea. */
function prepare(idea: TopicIdea, nowMs: number, strip: { n: number }): { reason: string } | Prepared {
  const title = String(idea.title ?? "").replace(/\s+/g, " ").trim()
  if (!title) return { reason: "empty_title" }
  const observedAt = iso(idea.observedAt)
  if (!observedAt) return { reason: "invalid_observed_at" }
  const gate = classifyTopicExclusion({ title, text: idea.angle ?? null, sourceKind: idea.sourceKind })
  if (gate.excluded && gate.reason) return { reason: gate.reason }
  const pd = personalDataProblem(title) ?? personalDataProblem(idea.angle)
  if (pd) return { reason: "personal_data_in_topic" }
  if (idea.rights === "unknown" || !idea.rights) return { reason: "rights_unknown" }
  const win = topicWindowFor(idea.sourceKind)
  const published = iso(idea.publishedAt)
  if (published && nowMs - Date.parse(published) > win.maxSourceAgeDays * DAY_MS) return { reason: "stale_source" }
  const ceiling = published ? Date.parse(published) + win.maxSourceAgeDays * DAY_MS : Infinity
  const wanted = iso(idea.expiresAt) ? Date.parse(iso(idea.expiresAt)!) : Date.parse(observedAt) + win.expiresDays * DAY_MS
  const expiresMs = Math.min(wanted, ceiling)
  if (!(expiresMs > nowMs)) return { reason: "already_expired" }
  const brief: Record<string, unknown> = {}
  const extra: Record<string, unknown> = {}
  let transport: string | null = null
  for (const [k, v] of Object.entries(idea.brief ?? {})) {
    if (k === "observation_key") continue
    if (k === "transport") { transport = typeof v === "string" ? v : null; continue }
    if (STRIP_KEYS.test(k)) { strip.n++; continue }
    if (typeof v === "string" && personalDataProblem(v)) { strip.n++; continue }
    if ((CREATIVE_BRIEF_FIELDS as readonly string[]).includes(k)) brief[k] = v
    else if (!RESERVED_KEYS.has(k)) extra[k] = v
  }
  return { idea: { ...idea, title: title.slice(0, 240) }, dedupKey: topicDedupKey({ ...idea, title }), obsKey: topicObservationKey({ ...idea, title }), expiresAt: new Date(expiresMs).toISOString(), observedAt, brief, extra, transport }
}

function creativeBrief(p: Prepared): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of CREATIVE_BRIEF_FIELDS) out[f] = p.brief[f] ?? null
  out.consumer_question = out.consumer_question ?? (isQuestion(p.idea.title) ? p.idea.title : null)
  out.topic_concept = out.topic_concept ?? p.idea.title
  out.source_observed_at = p.observedAt
  out.popularity_evidence_type = p.idea.evidence?.kind ?? "unknown"
  out.source_rights = p.idea.rights
  out.expires_at = p.expiresAt
  out.exclusion_reason = null
  return out
}

function evidenceOf(p: Prepared): ProvenanceEntry["evidence"] {
  const e = p.idea.evidence ?? { kind: "unknown" }
  const value = typeof e.value === "number" && Number.isFinite(e.value) && e.kind !== "unknown" ? e.value : null
  return { kind: value === null ? "unknown" : e.kind, metric: e.metric ?? null, value, unit: value === null ? null : (e.unit ?? null) }
}

/** The 0–100 column value, only when the caller stated a 0–100 score; otherwise undefined (the column is not written). */
function columnScore(ev: ProvenanceEntry["evidence"]): number | undefined {
  if (ev.value === null || ev.unit !== "score_0_100") return undefined
  return Math.max(0, Math.min(100, Math.round(ev.value)))
}

/** The row-level evidence: the strongest kind across DISTINCT observations, its largest value (never a sum across transports). */
function strongest(entries: ProvenanceEntry[]): ProvenanceEntry["evidence"] {
  let best: ProvenanceEntry["evidence"] = { kind: "unknown", metric: null, value: null, unit: null }
  for (const e of entries) {
    const ev = e.evidence
    if (EVIDENCE_RANK[ev.kind] > EVIDENCE_RANK[best.kind] || (ev.kind === best.kind && (ev.value ?? -1) > (best.value ?? -1))) best = ev
  }
  return best
}

/**
 * THE ONE TYPED PRODUCER into content_topic_bank. Never throws; every refusal is returned.
 */
export async function intakeTopicIdeas(db: Db, args: { brokerageId: string | null; ideas: readonly TopicIdea[]; now?: Date }): Promise<TopicIntakeResult> {
  const out: TopicIntakeResult = { ok: false, inserted: 0, merged: 0, excluded: [], rows: [], strippedFields: 0, sameObservation: 0, errors: [] }
  const now = args.now ?? new Date()
  const nowMs = now.getTime()
  const brokerageId = args.brokerageId
  if (brokerageId !== null && (typeof brokerageId !== "string" || !brokerageId.trim())) { out.refused = "no tenant — the intake is pinned to the session's brokerage (or null for the platform pool)"; return out }
  try {
    const strip = { n: 0 }
    const ready: Prepared[] = []
    for (const idea of args.ideas ?? []) {
      const p = prepare(idea, nowMs, strip)
      if ("reason" in p) { out.excluded.push({ title: String(idea?.title ?? "").slice(0, 120), reason: p.reason }); continue }
      if (brokerageId === null && !p.idea.sourceId) { out.excluded.push({ title: p.idea.title.slice(0, 120), reason: "platform_pool_needs_source_id" }); continue }
      ready.push(p)
    }
    out.strippedFields = strip.n
    if (ready.length === 0) { out.ok = out.errors.length === 0; return out }

    // Source rows: the caller's, or the tenant's system source for the kind (resolved once per writer; its off switch holds).
    const sourceByWriter = new Map<SystemTopicWriter, { id: string } | { skip: string }>()
    for (const p of ready) {
      if (p.idea.sourceId) continue
      const w = systemWriterFor(p.idea.sourceKind)
      if (!sourceByWriter.has(w)) {
        const s = await resolveSystemTopicSource(db, brokerageId as string, w)
        sourceByWriter.set(w, !s.ok ? { skip: `topic source unavailable: ${s.error}` } : !s.active ? { skip: "topic_source_disabled_by_tenant" } : { id: s.id })
      }
    }

    // Existing rows of THIS tenant with these dedup keys (one read; a refused read stores nothing).
    const keys = [...new Set(ready.map((p) => p.dedupKey))]
    let q = db.from("content_topic_bank").select("id, status, categories, raw_data, expires_at, source_url, engagement_score")
    q = brokerageId === null ? q.is("brokerage_id", null) : q.eq("brokerage_id", brokerageId)
    const { data: existingRows, error: readErr } = await q.in("raw_data->>dedup_key", keys)
    if (readErr) { out.refused = `content_topic_bank read refused — nothing stored: ${readErr.message ?? "unknown"}`; return out }
    const byKey = new Map<string, { id: string; status: string; categories: string[] | null; raw_data: Record<string, any> | null; expires_at: string | null }>()
    for (const r of (existingRows ?? []) as Array<any>) { const k = r?.raw_data?.dedup_key; if (typeof k === "string" && !byKey.has(k)) byKey.set(k, r) }

    // LEGACY ADOPTION (wave 154, lane 154G1): the producers routed onto this intake in batch 2 (the rss / exa crons,
    // local-intel) deduped by (source_id, source_url) — UNIQUE on the live table (m128) — and their rows carry no dedup_key.
    // Without this, the first pass after the cut-over would refuse every re-observed article with 23505. A row of THIS tenant
    // at the same source URL with NO dedup_key is adopted (the merge stamps the key); a row that already has another key is
    // a different idea and is left alone.
    const unmatchedUrls = [...new Set(ready.filter((p) => !byKey.has(p.dedupKey) && p.idea.sourceUrl).map((p) => p.idea.sourceUrl as string))]
    if (unmatchedUrls.length) {
      let lq = db.from("content_topic_bank").select("id, status, categories, raw_data, expires_at, source_url, engagement_score")
      lq = brokerageId === null ? lq.is("brokerage_id", null) : lq.eq("brokerage_id", brokerageId)
      const { data: legacyRows, error: legacyErr } = await lq.in("source_url", unmatchedUrls)
      if (legacyErr) { out.refused = `content_topic_bank legacy read refused — nothing stored: ${legacyErr.message ?? "unknown"}`; return out }
      const legacyByUrl = new Map<string, any>()
      for (const r of (legacyRows ?? []) as Array<any>) if (r?.source_url && typeof r?.raw_data?.dedup_key !== "string" && !legacyByUrl.has(r.source_url)) legacyByUrl.set(r.source_url, r)
      for (const p of ready) {
        if (byKey.has(p.dedupKey) || !p.idea.sourceUrl) continue
        const r = legacyByUrl.get(p.idea.sourceUrl)
        if (r) { byKey.set(p.dedupKey, r); legacyByUrl.delete(p.idea.sourceUrl) }
      }
    }

    for (const p of ready) {
      const ev = evidenceOf(p)
      const entry: ProvenanceEntry = {
        observation_key: p.obsKey, source_kind: p.idea.sourceKind, host: hostOf(p.idea.sourceUrl), source_url: p.idea.sourceUrl ?? null,
        urls: p.idea.sourceUrl ? [p.idea.sourceUrl] : [], observed_at: p.observedAt, published_at: iso(p.idea.publishedAt),
        transports: p.transport ? [p.transport] : [], rights: p.idea.rights, evidence: ev,
      }
      const prior = byKey.get(p.dedupKey)
      if (prior) {
        const prov: ProvenanceEntry[] = Array.isArray(prior.raw_data?.provenance) ? [...prior.raw_data!.provenance] : []
        const same = prov.find((x) => x.observation_key === entry.observation_key)
        if (same) {
          // The SAME observation again (another transport, a replay, a cross-site repost with the same digest): linked, counted once.
          same.transports = [...new Set([...(same.transports ?? []), ...entry.transports])]
          same.urls = [...new Set([...(same.urls ?? []), ...entry.urls])]
          if (EVIDENCE_RANK[ev.kind] > EVIDENCE_RANK[same.evidence?.kind ?? "unknown"] || (ev.kind === same.evidence?.kind && (ev.value ?? -1) > (same.evidence?.value ?? -1))) same.evidence = ev
          out.sameObservation++
        } else prov.push(entry)
        const best = strongest(prov)
        const keepStatus = prior.status === "used" || prior.status === "rejected"
        const expires = new Date(Math.max(Date.parse(prior.expires_at ?? "") || 0, Date.parse(p.expiresAt))).toISOString()
        const patch: Record<string, unknown> = {
          categories: [...new Set([...(prior.categories ?? []), ...(p.idea.categories ?? [])])],
          expires_at: expires, scraped_at: now.toISOString(),
          status: keepStatus ? prior.status : "fresh",
          raw_data: {
            ...(prior.raw_data ?? {}), ...p.extra,
            dedup_key: p.dedupKey, provenance: prov, independent_observations: prov.length,
            evidence: best, popularity_evidence_type: best.kind,
            intake: { ...(prior.raw_data?.intake ?? {}), version: 1, last_observed_at: p.observedAt },
            creative_brief: { ...(prior.raw_data?.creative_brief ?? {}), ...Object.fromEntries(Object.entries(creativeBrief(p)).filter(([, v]) => v !== null)), expires_at: expires, popularity_evidence_type: best.kind },
          },
        }
        const score = columnScore(best)
        if (score !== undefined) patch.engagement_score = score
        if (p.idea.angle) patch.value_angle = String(p.idea.angle).slice(0, 600)
        let u = db.from("content_topic_bank").update(patch).eq("id", prior.id)
        u = brokerageId === null ? u.is("brokerage_id", null) : u.eq("brokerage_id", brokerageId)
        const { data: upd, error: updErr } = await u.select("id")
        if (updErr || (upd ?? []).length !== 1) { out.errors.push(`merge refused (${p.dedupKey}): ${updErr?.message ?? `${(upd ?? []).length} rows matched`}`); continue }
        prior.raw_data = patch.raw_data as Record<string, any>
        prior.categories = patch.categories as string[]
        prior.expires_at = expires
        out.merged++
        out.rows.push({ dedupKey: p.dedupKey, id: prior.id, isNew: false })
        continue
      }
      let sourceId = p.idea.sourceId ?? null
      if (!sourceId) {
        const s = sourceByWriter.get(systemWriterFor(p.idea.sourceKind))
        if (!s || "skip" in s) { out.excluded.push({ title: p.idea.title.slice(0, 120), reason: s && "skip" in s ? s.skip : "topic source unavailable" }); continue }
        sourceId = s.id
      }
      const score = columnScore(ev)
      const { data: ins, error: insErr } = await db.from("content_topic_bank").insert({
        source_id: sourceId, brokerage_id: brokerageId, topic_title: p.idea.title,
        value_angle: p.idea.angle ? String(p.idea.angle).slice(0, 600) : null, source_url: p.idea.sourceUrl ?? null,
        categories: [...new Set(p.idea.categories ?? [])], topic_posted_at: iso(p.idea.publishedAt), scraped_at: now.toISOString(),
        expires_at: p.expiresAt, status: "fresh", geo_relevance: geoRelevanceOf(p.idea.geo),
        ...(score !== undefined ? { engagement_score: score } : {}),
        raw_data: {
          ...p.extra, dedup_key: p.dedupKey, provenance: [entry], independent_observations: 1, evidence: ev, popularity_evidence_type: ev.kind,
          intake: { version: 1, source_kind: p.idea.sourceKind, rights: p.idea.rights, first_observed_at: p.observedAt, last_observed_at: p.observedAt, refurbish_trigger_kind: refurbishTriggerKindForTopicSource(p.idea.sourceKind) },
          creative_brief: creativeBrief(p),
        },
      }).select("id")
      const row = ((ins ?? []) as Array<{ id: string }>)[0]
      if (insErr || !row) { out.errors.push(`insert refused (${p.dedupKey}): ${insErr?.message ?? "no row returned"}`); continue }
      out.inserted++
      out.rows.push({ dedupKey: p.dedupKey, id: String(row.id), isNew: true })
      byKey.set(p.dedupKey, { id: String(row.id), status: "fresh", categories: p.idea.categories ?? [], raw_data: { dedup_key: p.dedupKey, provenance: [entry] }, expires_at: p.expiresAt })
    }
    out.ok = out.errors.length === 0
    return out
  } catch (e) {
    out.errors.push(`intakeTopicIdeas threw: ${(e as Error)?.message ?? String(e)}`)
    return out
  }
}

/**
 * A SOURCE WAS DELETED OR SUPERSEDED (directive C2 / C4): every topic of this tenant that cites it is re-evaluated, never
 * silently kept. The citing observation leaves the provenance; a topic left with no observation becomes 'rejected'
 * (deleted) or 'stale' (superseded) — except a 'used' topic, whose status stays (it already shipped) and is flagged.
 * Counted (`.select("id")`), tenant-pinned, idempotent (a second call finds nothing left to remove).
 */
export async function reevaluateRemovedTopicSource(db: Db, args: { brokerageId: string; sourceUrl: string; disposition: "deleted" | "superseded"; now?: Date }): Promise<{ ok: boolean; reevaluated: number; retired: number; kept: number; error: string | null }> {
  const now = args.now ?? new Date()
  if (!args.brokerageId) return { ok: false, reevaluated: 0, retired: 0, kept: 0, error: "no tenant" }
  const { data, error } = await db.from("content_topic_bank").select("id, status, raw_data")
    .eq("brokerage_id", args.brokerageId).contains("raw_data", { provenance: [{ urls: [args.sourceUrl] }] })
  if (error) return { ok: false, reevaluated: 0, retired: 0, kept: 0, error: `read refused: ${error.message ?? "unknown"}` }
  let reevaluated = 0, retired = 0, kept = 0
  const errs: string[] = []
  for (const r of (data ?? []) as Array<{ id: string; status: string; raw_data: Record<string, any> | null }>) {
    const prov: ProvenanceEntry[] = Array.isArray(r.raw_data?.provenance) ? r.raw_data!.provenance : []
    // The removed URL leaves each observation; an observation with no URL left (it was seen only there) leaves the topic.
    let touched = false
    const left: ProvenanceEntry[] = []
    for (const x of prov) {
      const urls = (x.urls ?? (x.source_url ? [x.source_url] : [])).filter((u) => u !== args.sourceUrl)
      if (urls.length !== (x.urls ?? (x.source_url ? [x.source_url] : [])).length || x.source_url === args.sourceUrl) touched = true
      if (urls.length === 0) continue
      left.push({ ...x, urls, source_url: x.source_url === args.sourceUrl ? urls[0] : x.source_url })
    }
    if (!touched) continue
    const status = left.length > 0 || r.status === "used" ? r.status : args.disposition === "deleted" ? "rejected" : "stale"
    const best = strongest(left)
    const patch = {
      status,
      raw_data: { ...(r.raw_data ?? {}), provenance: left, independent_observations: left.length, evidence: best, popularity_evidence_type: best.kind,
        source_removals: [...(Array.isArray(r.raw_data?.source_removals) ? r.raw_data!.source_removals : []), { source_url: args.sourceUrl, disposition: args.disposition, at: now.toISOString() }] },
    }
    const { data: upd, error: updErr } = await db.from("content_topic_bank").update(patch).eq("id", r.id).eq("brokerage_id", args.brokerageId).select("id")
    if (updErr || (upd ?? []).length !== 1) { errs.push(`${r.id}: ${updErr?.message ?? "matched no row"}`); continue }
    reevaluated++
    if (left.length === 0 && r.status !== "used") retired++
    else kept++
  }
  return { ok: errs.length === 0, reevaluated, retired, kept, error: errs.length ? errs.join("; ") : null }
}
