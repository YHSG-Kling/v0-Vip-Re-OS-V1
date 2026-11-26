// lib/content-intel/public-chatter-topics.ts
// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC CHATTER → REWORDED TOPICS, IDEAS ONLY (wave 154, lane 154C — owner rulings R1, R2, R3; directive C1–C5).
//
// Three producers, one destination (the ONE intake, lib/content-intel/topic-intake.ts → content_topic_bank):
//   · NEXTDOOR PUBLIC POSTS — fetched through the checkpointed Zyte / ZenRows transport under the community TOPIC purpose
//     (lib/providers/scrape-checkpoint.ts COMMUNITY_TOPIC_RESEARCH_PURPOSE — the owner's accepted risk recorded on the rule).
//   · PUBLIC FACEBOOK GROUP QUESTIONS — items of `apify/facebook-groups-scraper` through the existing Apify fabric.
//   · META AD LIBRARY CREATIVES — items of `apify/facebook-ads-scraper` through the same fabric.
//   · A SUBSCRIBER'S OWN hand-saved permitted link or observation (saveManualTopicObservation).
//
// THE BOUNDARY (R1 / R3 — binding): this path yields TOPICS ONLY. It never writes RawData, a Raw Lead, a Lead, a Contact, a
// person dossier, an audience or an outbound message, and it does not import the acquisition side door
// (lib/lead-pipeline/social-sourcer.ts, ingestRawSourceBatch, the AI ISA) — scripts/public-chatter-topics-guard.ts walks the
// import graph from this file (static AND dynamic imports) with a positive control. A first-person housing request seen here
// is still only a content question: on Nextdoor its person-level path stays LICENSE-HELD (the SCRAPE_TARGET_AGREEMENTS
// switch); from Facebook it is IDEAS-ONLY by ruling and never a person.
//
// UNTRUSTED TEXT: every fetched or actor-returned text is FENCED (UntrustedSourceText): it is read only for its themes, its
// question shape and a content digest. Nothing in it can choose a tool, a tenant, a spend or a priority — those come from the
// caller's scope. It is discarded after derivation; it is never stored, logged or returned.
//
// REWORD BEFORE STORE: the stored title / angle is either (a) a rewording model's output (injected `reword`; none is wired by
// default — no model is named in this repo artifact) that PASSES the deterministic near-copy refusal
// (topic-intake.ts rewordedNearCopyProblem) and the personal-data screen, or (b) the rule-derived category-level topic
// (topic-themes.ts ruleDerivedTopic). Neither available → HELD, never stored verbatim.
//
// Not server-only: the proofs drive it with in-memory clients and counting seams.

import { createHash } from "node:crypto"
import { readPublicStatement } from "@/lib/acquisition-plays/public-statement"
import { intakeTopicIdeas, classifyTopicExclusion, rewordedNearCopyProblem, personalDataProblem, consumerValueSentences, type TopicIdea, type TopicIntakeResult } from "./topic-intake"
import { ruleDerivedTopic } from "./topic-themes"

type Db = { from: (table: string) => any }

// ── Fencing ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Untrusted source text. Only this module's derivation reads `.text`; it is never stored, logged or returned. */
export interface UntrustedSourceText { readonly fenced: true; readonly text: string }
export function fenceUntrusted(text: unknown): UntrustedSourceText {
  // eslint-disable-next-line no-control-regex
  const t = String(text ?? "").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 8000)
  return Object.freeze({ fenced: true as const, text: t })
}

/** PURE — visible text of an HTML page (scripts / styles / tags removed); the result is fenced at once. */
function visibleTextOf(html: string): UntrustedSourceText {
  return fenceUntrusted(String(html ?? "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    // A block boundary ends a sentence, so an author line or a nav label never fuses into the post's first sentence.
    .replace(/<\/(?:div|p|h[1-6]|li|section|article|header|footer|span)>|<br\s*\/?>/gi, ". ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"'))
}

/** PURE — the publication date a page itself declares (article:published_time / datePublished / <time datetime>), or null. */
function declaredPublishedAt(html: string): string | null {
  const h = String(html ?? "")
  const m = /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i.exec(h)
    ?? /"datePublished"\s*:\s*"([^"]+)"/i.exec(h)
    ?? /<time[^>]+datetime=["']([^"']+)["']/i.exec(h)
  if (!m) return null
  const t = Date.parse(m[1])
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

/** PURE — a content digest of the fenced text (the observation key): the same post reposted elsewhere is ONE observation. */
export function observationDigest(fenced: UntrustedSourceText): string {
  // Over the consumer-value sentences only: page chrome, author lines and pitches fall away, so a repost of the same post on
  // another site digests the same (a text with no such sentence digests whole).
  const core = consumerValueSentences(fenced.text)
  const norm = (core.length ? core.join(" ") : fenced.text).toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/[^a-z0-9]+/g, " ").trim()
  return createHash("sha256").update(norm).digest("hex").slice(0, 32)
}

// ── Rewording ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A rewording model seam. Receives the fenced text and the themes; returns an ORIGINAL title / angle, or null. */
export type Rewording = (input: { fenced: UntrustedSourceText; themeKeys: string[]; geoLabel: string | null }) => Promise<{ title: string; angle?: string | null } | null>

export type DerivedTopic =
  | { status: "reworded" | "rule_derived"; title: string; angle: string; consumerQuestion: string; categories: string[]; themeKeys: string[]; note: string | null }
  | { status: "excluded"; reason: string }
  | { status: "held"; reason: string }

/**
 * Untrusted text → a REWORDED topic, or a refusal. Order: the R9 exclusion gate on the SOURCE text (before any model) →
 * steering / no-theme hold → the model's rewording (if wired) checked for near-copy and personal data → else the rule-derived
 * category-level topic, itself checked. Never returns source wording.
 */
export async function deriveRewordedTopic(fenced: UntrustedSourceText, opts: { geoLabel?: string | null; reword?: Rewording | null; sourceKind?: string }): Promise<DerivedTopic> {
  const gate = classifyTopicExclusion({ title: "", text: fenced.text, sourceKind: opts.sourceKind ?? null })
  if (gate.excluded && gate.reason) return { status: "excluded", reason: gate.reason }
  const base = ruleDerivedTopic(fenced.text, opts.geoLabel ?? null)
  if ("held" in base) return { status: "held", reason: base.held }
  let note: string | null = null
  if (opts.reword) {
    const r = await opts.reword({ fenced, themeKeys: base.themeKeys, geoLabel: opts.geoLabel ?? null }).catch(() => null)
    if (r && r.title) {
      const problem = rewordedNearCopyProblem(r.title, fenced.text) ?? (r.angle ? rewordedNearCopyProblem(r.angle, fenced.text) : null)
        ?? personalDataProblem(r.title) ?? personalDataProblem(r.angle)
      if (!problem) return { status: "reworded", title: r.title.slice(0, 200), angle: (r.angle ?? base.angle).slice(0, 600), consumerQuestion: base.consumerQuestion, categories: base.categories, themeKeys: base.themeKeys, note: null }
      note = `model rewording refused (${problem}) — the rule-derived topic was used`
    } else note = "no rewording returned — the rule-derived topic was used"
  }
  const copy = rewordedNearCopyProblem(base.title, fenced.text)
  if (copy) return { status: "held", reason: `rule-derived title still resembles the source (${copy})` }
  return { status: "rule_derived", title: base.title, angle: base.angle, consumerQuestion: base.consumerQuestion, categories: base.categories, themeKeys: base.themeKeys, note }
}

// ── Routing: a public first-person question vs an anonymous discussion (directive C4) ────────────────────────────────

/** The statement classifier's shape. PRODUCTION DEFAULT (wave 154, lane 154G1): the ONE reader, readPublicStatement, from
 *  the PURE module lib/acquisition-plays/public-statement.ts — an omitted (undefined) classifier uses it; an explicit null
 *  records "not evaluated" (the seam the proofs use for the unclassified route). */
export type StatementClassifier = (text: string) => { firstPerson: boolean; requestsAgentContact: boolean; statesHousingNeed: boolean }

export type ChatterRoute = "first_person_topic_only" | "anonymous_topic" | "unclassified_topic"

/** PURE — on this path BOTH routes end as a topic; they differ in what is recorded about the person path. */
/** @proofSeam scripts/public-chatter-topics-guard.ts checks each route with a stand-in classifier; production callers researchCommunityPostTopics / normalizeFacebookGroupItems in this file. */
export function routeChatter(fenced: UntrustedSourceText, sourceKind: "community_post" | "facebook_group_question", classifier: StatementClassifier | null | undefined): { route: ChatterRoute; personPath: string } {
  const classify = classifier === undefined ? readPublicStatement : classifier
  if (!classify) return { route: "unclassified_topic", personPath: "not_evaluated" }
  const s = classify(fenced.text)
  if (s.firstPerson || s.requestsAgentContact) {
    return { route: "first_person_topic_only", personPath: sourceKind === "community_post" ? "license_held:nextdoor.com (LICENSE_REQUIRED — SCRAPE_TARGET_AGREEMENTS switch)" : "ideas_only:facebook (owner ruling R3 — never a person)" }
  }
  return { route: "anonymous_topic", personPath: "none — an anonymous discussion is never a person" }
}

// ── Nextdoor public posts through the checkpointed transport (TOPIC purpose) ───────────────────────────────────────────

type ScrapeCheckpointModule = typeof import("@/lib/providers/scrape-checkpoint")
type Snapshot = Awaited<ReturnType<ScrapeCheckpointModule["fetchCheckpointedSnapshot"]>>
type SnapshotDeps = Parameters<ScrapeCheckpointModule["fetchCheckpointedSnapshot"]>[1]

export interface CommunityTopicDeps {
  /** The checkpoint seams (store / fetcher / robots / spend / tick budget) — passed through to fetchCheckpointedSnapshot. */
  snapshot: NonNullable<SnapshotDeps>
  intake?: typeof intakeTopicIdeas
  reword?: Rewording | null
  classify?: StatementClassifier | null
}

export interface CommunityTopicResult {
  urls: number
  fetched: number
  /** Per-URL holds / refusals, each named (robots, spend, backoff, sign-in wall, non-public URL …). */
  held: Array<{ url: string; status: string; reason: string }>
  derived: { reworded: number; ruleDerived: number; excluded: Array<{ url: string; reason: string }>; heldTopics: Array<{ url: string; reason: string }> }
  routes: Record<ChatterRoute, number>
  intake: TopicIntakeResult | null
  costUsd: number
}

/**
 * Read public Nextdoor post pages for TOPIC research. Each URL goes through fetchCheckpointedSnapshot under
 * COMMUNITY_TOPIC_RESEARCH_PURPOSE (its target rule refuses a non-public URL before any request; a sign-in wall is held);
 * the page's visible text is fenced, reworded in memory and discarded; the reworded topics go to the ONE intake with rights
 * `public_read_reworded`; the snapshot is committed only after the intake answered.
 */
export async function researchCommunityPostTopics(db: Db, args: { brokerageId: string; urls: readonly string[]; geo?: TopicIdea["geo"]; now?: Date }, deps: CommunityTopicDeps): Promise<CommunityTopicResult> {
  const now = args.now ?? new Date()
  const out: CommunityTopicResult = { urls: args.urls.length, fetched: 0, held: [], derived: { reworded: 0, ruleDerived: 0, excluded: [], heldTopics: [] }, routes: { first_person_topic_only: 0, anonymous_topic: 0, unclassified_topic: 0 }, intake: null, costUsd: 0 }
  if (!args.brokerageId) { out.held.push({ url: "*", status: "refused", reason: "no tenant" }); return out }
  const ck = await import("@/lib/providers/scrape-checkpoint")
  const ideas: TopicIdea[] = []
  const commits: Array<Snapshot> = []
  const geoLabel = args.geo?.label ?? args.geo?.city ?? null
  for (const url of args.urls) {
    const snap = await ck.fetchCheckpointedSnapshot({ url, scope: { brokerageId: args.brokerageId, marketId: null, purpose: ck.COMMUNITY_TOPIC_RESEARCH_PURPOSE, lane: "nextdoor_topic_research" } }, { ...deps.snapshot, now: deps.snapshot.now ?? (() => now) })
    out.costUsd += snap.costUsd
    if (snap.status !== "fetched_changed") { out.held.push({ url, status: snap.status, reason: snap.reason }); continue }
    out.fetched++
    commits.push(snap)
    for (const html of snap.html) {
      const fenced = visibleTextOf(html)
      const publishedAt = declaredPublishedAt(html)
      const route = routeChatter(fenced, "community_post", deps.classify)
      out.routes[route.route]++
      const d = await deriveRewordedTopic(fenced, { geoLabel, reword: deps.reword ?? null, sourceKind: "community_post" })
      if (d.status === "excluded") { out.derived.excluded.push({ url, reason: d.reason }); continue }
      if (d.status === "held") { out.derived.heldTopics.push({ url, reason: d.reason }); continue }
      if (d.status === "reworded") out.derived.reworded++
      else out.derived.ruleDerived++
      ideas.push({
        sourceKind: "community_post", title: d.title, angle: d.angle, categories: [...d.categories, "public_chatter"], geo: args.geo ?? null,
        sourceUrl: url, publishedAt, observedAt: now.toISOString(),
        evidence: { kind: "unknown", metric: null, value: null, unit: null, note: "public post — reactions are not read on the topic path" },
        rights: "public_read_reworded",
        brief: {
          observation_key: observationDigest(fenced), transport: snap.provider ?? "page_transport",
          consumer_question: d.consumerQuestion, topic_concept: d.title, emotional_need: null, market_relevance: geoLabel ? `raised publicly in ${geoLabel}` : null,
          proof_needed: "verified local facts with their source and date — never the neighbors' words", localization_opportunity: geoLabel,
          suggested_original_formats: ["local_guide", "faq", "short_video"], theme_keys: d.themeKeys, chatter_route: route.route, person_path: route.personPath,
          rewording: d.status, rewording_note: d.note,
        },
      })
    }
  }
  const intake = deps.intake ?? intakeTopicIdeas
  out.intake = ideas.length ? await intake(db, { brokerageId: args.brokerageId, ideas, now }) : null
  const ok = !out.intake || out.intake.ok
  for (const s of commits) await s.commit({ ok }).catch(() => null)
  return out
}

// ── Facebook groups and the Meta Ad Library (Apify) — IDEAS ONLY ──────────────────────────────────────────────────────

/**
 * The two Apify actors this path may use, as VERIFIED from Apify's PUBLIC actor pages / API metadata on 2026-11-18 (lane
 * 154C read `GET api.apify.com/v2/acts/{id}` and the default build's input schema + README; NO actor was run). What could
 * not be verified is marked UNVERIFIED. A source row stays inactive until its rights + credential are on record; an inactive
 * source makes zero network calls (the cron selects is_active = true only).
 */
export const APIFY_IDEA_ACTORS = Object.freeze({
  "apify/facebook-groups-scraper": {
    sourceKind: "facebook_group_question" as const,
    actorId: "2chN8UQcH1CfxLRNE", owner: "apify (Apify-maintained)", latestBuild: "0.0.405",
    input: ["startUrls (required — group URLs)", "resultsLimit", "viewOption", "onlyPostsNewerThan"],
    output: ["facebookUrl", "url", "time", "text", "likesCount", "commentsCount", "sharesCount", "groupTitle", "user {id,name} (DROPPED in memory)", "topComments (DROPPED)", "profileUrl / profileName (DROPPED)"],
    visibility: "README: 'only works with public groups' — private groups would need login credentials, which the actor does not use",
    login: "none for public groups (README); a cookie / credential field in a source's input is REFUSED by this path",
    pricing: "pay-per-event: actor start $0.001–0.006 + $0.0008–0.005 per post (+ date-filter add-on), tier-dependent (pricingInfos, 2026-03-04)",
    unverified: ["the exact per-post field set beyond the README sample", "deleted-post signalling (no documented field) — a removed source is honored through reevaluateRemovedTopicSource"],
  },
  "apify/facebook-ads-scraper": {
    sourceKind: "meta_ad_creative" as const,
    actorId: "JJghSZmShuco4j9gJ", owner: "apify (Apify-maintained)", latestBuild: "0.0.410",
    input: ["startUrls (required — Ad Library URL or Page URL)", "resultsLimit", "activeStatus", "onlyAdsNewerThan", "onlyAdsOlderThan", "isDetailsPerAd", "includeAboutPage (NOT used — returns page contact details)"],
    output: ["adArchiveID", "pageID", "pageName", "collationId", "collationCount", "snapshot.title", "snapshot.body.text", "snapshot.displayFormat", "snapshot.ctaText", "startDateFormatted", "endDateFormatted", "publisherPlatform", "spend / impressions / reachEstimate (often absent — UNKNOWN unless present)"],
    visibility: "public Meta Ad Library pages; README: no private content or sensitive user data",
    login: "none documented",
    pricing: "pay-per-event: $0.001–0.0058 per ad, tier-dependent (+ optional e-commerce add-on) (pricingInfos, 2026-07-14)",
    unverified: ["whether spend / impressions appear for non-political US ads (Meta publishes them for political / EU ads only) — treated as unknown", "Meta's own terms for automated collection — R1 accepted risk applies to topics only"],
  },
})
export type ApifyIdeaActor = keyof typeof APIFY_IDEA_ACTORS
export function apifyIdeaActorFor(actor: string | null | undefined): ApifyIdeaActor | null {
  return actor && Object.prototype.hasOwnProperty.call(APIFY_IDEA_ACTORS, actor) ? (actor as ApifyIdeaActor) : null
}

/** PURE — a Facebook idea source's config refusal (private / login / contact-detail inputs), or null. */
export function apifyIdeaSourceProblem(cfg: { actor?: string; input?: Record<string, unknown>; visibility?: string | null; rights?: string | null } | null | undefined): string | null {
  const actor = apifyIdeaActorFor(cfg?.actor)
  if (!actor) return null
  const input = cfg?.input ?? {}
  const keys = Object.keys(input)
  if (keys.some((k) => /cookie|session|login|password|credential|token|email/i.test(k))) return "refused: the actor input carries a login / cookie / credential field — public pages only, no sign-in"
  if (actor === "apify/facebook-ads-scraper" && input.includeAboutPage === true) return "refused: includeAboutPage returns page contact details — not collected on the idea path"
  if (actor === "apify/facebook-groups-scraper" && cfg?.visibility !== "public") return "refused: the group is not recorded as PUBLIC (source_config.visibility = 'public') — a private or unverified group is never read"
  if (!cfg?.rights || cfg.rights === "unknown") return "held: no source-rights status recorded for this source (source_config.rights) — PENDING_RIGHTS, the source makes no call"
  return null
}

/** The documented DEAREST per-run price (FREE tier) of each idea actor — public pricingInfos read 2026-11-18. */
const IDEA_ACTOR_PRICE_USD: Readonly<Record<ApifyIdeaActor, { start: number; perItem: number }>> = Object.freeze({
  "apify/facebook-groups-scraper": { start: 0.006, perItem: 0.005 + 0.002 /* + the date-filter add-on */ },
  "apify/facebook-ads-scraper": { start: 0, perItem: 0.0058 },
})

/** PURE — the run budget BEFORE any call: a bounded resultsLimit and a recorded per-run budget the estimate fits. null = ok. */
export function apifyIdeaBudgetProblem(cfg: { actor?: string; input?: Record<string, unknown>; max_run_usd?: number | null } | null | undefined): string | null {
  const actor = apifyIdeaActorFor(cfg?.actor)
  if (!actor) return null
  const price = IDEA_ACTOR_PRICE_USD[actor]
  const limit = typeof cfg?.input?.resultsLimit === "number" && (cfg.input.resultsLimit as number) > 0 ? (cfg.input.resultsLimit as number) : null
  const budget = typeof cfg?.max_run_usd === "number" && cfg.max_run_usd > 0 ? cfg.max_run_usd : null
  if (limit === null) return "held: input.resultsLimit is not set — an unbounded run has no estimate"
  if (budget === null) return "held: no per-run budget recorded (source_config.max_run_usd)"
  const estimate = price.start + price.perItem * limit
  if (estimate > budget) return `held: estimated $${estimate.toFixed(4)} exceeds the $${budget} per-run budget`
  return null
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null)
const isoOf = (v: unknown): string | null => {
  if (v == null) return null
  if (typeof v === "number") { const ms = v < 10_000_000_000 ? v * 1000 : v; return new Date(ms).toISOString() }
  const t = Date.parse(String(v)); return Number.isFinite(t) ? new Date(t).toISOString() : null
}

/** A competitor_ads row for one Meta Ad Library item (live columns; the cron adds brokerage_id / competitor_id). */
interface MetaAdMirrorRow {
  source_platform: "facebook"; provider_ad_id: string; page_id: string; competitor_name: string; ad_headline: ""; ad_copy: ""; landing_page_url: null
  ad_delivery_start: string | null; ad_delivery_stop: string | null; engagement_score: null; categories: string[]
  geo_relevance: { cities: string[]; states: string[]; zip_codes: string[] } | null; raw_payload: Record<string, unknown>; last_seen_at: string
}

export interface IdeaNormalizeResult { ideas: TopicIdea[]; excluded: Array<{ reason: string }>; held: Array<{ reason: string }>; routes: Record<ChatterRoute, number>; droppedPersonFields: number }

/**
 * Facebook group items → TopicIdeas. The author, profile links, comments and member data are DROPPED in memory (counted);
 * the post text is fenced, reworded and discarded. Public counts the actor reports are MEASURED evidence in their own unit
 * (never folded into the 0–100 column).
 */
/** @proofSeam scripts/public-chatter-topics-guard.ts drives group items directly; production caller normalizeApifyIdeaItems in this file (content-intel-apify cron). */
export async function normalizeFacebookGroupItems(items: readonly Record<string, any>[], ctx: { geo?: TopicIdea["geo"]; now: Date; reword?: Rewording | null; classify?: StatementClassifier | null; sourceId?: string | null }): Promise<IdeaNormalizeResult> {
  const out: IdeaNormalizeResult = { ideas: [], excluded: [], held: [], routes: { first_person_topic_only: 0, anonymous_topic: 0, unclassified_topic: 0 }, droppedPersonFields: 0 }
  const geoLabel = ctx.geo?.label ?? ctx.geo?.city ?? null
  for (const raw of items) {
    for (const k of ["user", "profileUrl", "profileName", "profilePicture", "topComments", "comments", "author"]) if (raw?.[k] != null) out.droppedPersonFields++
    if (raw?.error || raw?.errorDescription) { out.held.push({ reason: `actor reported: ${String(raw.error ?? raw.errorDescription).slice(0, 80)} (private or inaccessible group — refused)` }); continue }
    const fenced = fenceUntrusted(raw?.text)
    if (!fenced.text) { out.held.push({ reason: "no post text" }); continue }
    const url = typeof raw?.url === "string" ? raw.url : (typeof raw?.facebookUrl === "string" ? raw.facebookUrl : null)
    const route = routeChatter(fenced, "facebook_group_question", ctx.classify)
    out.routes[route.route]++
    const d = await deriveRewordedTopic(fenced, { geoLabel, reword: ctx.reword ?? null, sourceKind: "facebook_group_question" })
    if (d.status === "excluded") { out.excluded.push({ reason: d.reason }); continue }
    if (d.status === "held") { out.held.push({ reason: d.reason }); continue }
    const likes = num(raw?.likesCount), comments = num(raw?.commentsCount)
    const measured = likes !== null || comments !== null
    out.ideas.push({
      sourceKind: "facebook_group_question", sourceId: ctx.sourceId ?? null, title: d.title, angle: d.angle, categories: [...d.categories, "public_chatter"], geo: ctx.geo ?? null,
      sourceUrl: url, publishedAt: isoOf(raw?.time ?? raw?.date), observedAt: ctx.now.toISOString(),
      evidence: measured ? { kind: "measured", metric: "public_reactions_plus_comments", value: (likes ?? 0) + (comments ?? 0), unit: "count", note: "platform-reported public counts on the group post" } : { kind: "unknown", metric: null, value: null, unit: null, note: "no public count reported" },
      rights: "public_read_reworded",
      brief: { observation_key: observationDigest(fenced), transport: "apify", consumer_question: d.consumerQuestion, topic_concept: d.title, proof_needed: "verified local facts with source and date — never the group's words", localization_opportunity: geoLabel, suggested_original_formats: ["faq", "local_guide", "short_video"], theme_keys: d.themeKeys, chatter_route: route.route, person_path: route.personPath, rewording: d.status },
    })
  }
  return out
}

/**
 * Meta Ad Library items → TopicIdeas: THEME and TRANSFERABLE TECHNIQUE only. Conversion, CPA, CTR, impressions and spend are
 * UNKNOWN unless the item itself carries them (and then only stored as the platform's own range, never a derived rate); a
 * long-running ad is NOT evidence of performance; versions of one campaign (collationId, else the creative digest) are ONE
 * observation.
 */
/** @proofSeam scripts/public-chatter-topics-guard.ts drives Ad Library items directly; production caller normalizeApifyIdeaItems in this file (content-intel-apify cron). */
export async function normalizeMetaAdItems(items: readonly Record<string, any>[], ctx: { geo?: TopicIdea["geo"]; now: Date; reword?: Rewording | null; sourceId?: string | null }): Promise<IdeaNormalizeResult & { campaignsCollapsed: number; competitorAds: MetaAdMirrorRow[] }> {
  const out = { ideas: [] as TopicIdea[], excluded: [] as Array<{ reason: string }>, held: [] as Array<{ reason: string }>, routes: { first_person_topic_only: 0, anonymous_topic: 0, unclassified_topic: 0 } as Record<ChatterRoute, number>, droppedPersonFields: 0, campaignsCollapsed: 0, competitorAds: [] as MetaAdMirrorRow[] }
  const geoLabel = ctx.geo?.label ?? ctx.geo?.city ?? null
  const seen = new Set<string>()
  for (const raw of items) {
    const snap = raw?.snapshot ?? {}
    const fenced = fenceUntrusted(`${snap?.title ?? ""}. ${snap?.body?.text ?? snap?.body ?? ""} ${snap?.linkDescription ?? ""}`)
    if (!fenced.text.replace(/[.\s]/g, "")) { out.held.push({ reason: "no creative text" }); continue }
    const pageId = String(raw?.pageID ?? raw?.pageId ?? raw?.page_id ?? "unknown_page")
    const campaign = raw?.collationId ?? raw?.collation_id ?? null
    const obs = `meta_ad:${pageId}:${campaign ?? observationDigest(fenced)}`
    if (seen.has(obs)) { out.campaignsCollapsed++; continue }
    seen.add(obs)
    const d = await deriveRewordedTopic(fenced, { geoLabel, reword: ctx.reword ?? null, sourceKind: "meta_ad_creative" })
    if (d.status === "excluded") { out.excluded.push({ reason: d.reason }); continue }
    if (d.status === "held") { out.held.push({ reason: d.reason }); continue }
    const startedAt = isoOf(raw?.startDateFormatted ?? raw?.startDate)
    const format = typeof snap?.displayFormat === "string" ? snap.displayFormat.toLowerCase() : null
    const questionLed = /\?/.test(String(snap?.title ?? ""))
    const archiveId = raw?.adArchiveID ?? raw?.adArchiveId ?? null
    out.ideas.push({
      sourceKind: "meta_ad_creative", sourceId: ctx.sourceId ?? null,
      title: d.title.replace(/: what .* neighbors are asking right now$/, ": a question competitors are paying to answer"), angle: "Learn the general format, then ask a completely new question about your own audience's needs — never the ad's words, images, offer or branding.",
      categories: [...d.categories, "competitor_intel"], geo: ctx.geo ?? null,
      sourceUrl: archiveId ? `https://www.facebook.com/ads/library/?id=${encodeURIComponent(String(archiveId))}` : null,
      // The ad's START date is not its currency (a long-running ad is still current while it runs) — freshness is the
      // observation; the start date is kept in the brief, and longevity is never read as performance.
      publishedAt: null, observedAt: ctx.now.toISOString(),
      evidence: { kind: "unknown", metric: null, value: null, unit: null, note: "Ad Library shows no engagement; conversion / CPA / CTR / impressions / spend unknown; ad longevity is not evidence of performance" },
      rights: "public_read_reworded",
      brief: {
        observation_key: obs, transport: "apify", consumer_question: d.consumerQuestion, topic_concept: d.title,
        hook_pattern: questionLed ? "question-led opening (format only — write a new question)" : null, format_pattern: format,
        proof_needed: "independent, sourced facts — a competitor ad proves nothing", suggested_original_formats: format === "video" ? ["short_video", "faq"] : ["social_post", "faq"],
        theme_keys: d.themeKeys, rewording: d.status,
        ad_metrics: { conversion: "unknown", cpa: "unknown", ctr: "unknown", impressions: raw?.impressions ?? "unknown", spend: raw?.spend ?? "unknown", longevity_is_not_performance: true, campaign_versions: num(raw?.collationCount) },
        ad_observation: { platform: Array.isArray(raw?.publisherPlatform) ? raw.publisherPlatform : null, page_id: pageId, paid_creative: true, started_at: startedAt, active: typeof raw?.isActive === "boolean" ? raw.isActive : null },
      },
    })
    // The competitor screen's row (wave 154, lane 154G1 — lane 154C PARTIAL 4): only for an ad that PASSED the exclusion gate
    // and the rewording, and only with its public Ad Library id. IDEAS ONLY (owner R3): the ad's own headline / body are NOT
    // stored (empty, the existing Exa writer's fallback — the screen truncates the column and cannot take NULL); the reworded
    // theme and the archive link ride in raw_payload; engagement is NULL (Ad Library shows none — and NULL keeps the competitor
    // promoter, which needs a score and copy, from re-filing the same ad as a second topic).
    if (archiveId) out.competitorAds.push({
      source_platform: "facebook", provider_ad_id: String(archiveId), page_id: pageId,
      competitor_name: typeof raw?.pageName === "string" && raw.pageName.trim() ? raw.pageName.trim().slice(0, 120) : "Unknown advertiser",
      ad_headline: "", ad_copy: "", landing_page_url: null, ad_delivery_start: startedAt, ad_delivery_stop: isoOf(raw?.endDateFormatted ?? raw?.endDate),
      engagement_score: null, categories: [...d.categories, "competitor_intel"],
      geo_relevance: ctx.geo ? { cities: [ctx.geo.city, ...(ctx.geo.cities ?? [])].filter((x): x is string => !!x), states: [ctx.geo.state, ...(ctx.geo.states ?? [])].filter((x): x is string => !!x), zip_codes: [ctx.geo.zip, ...(ctx.geo.zip_codes ?? [])].filter((x): x is string => !!x) } : null,
      raw_payload: { ideas_only: true, source: "apify/facebook-ads-scraper", reworded_theme: d.title, archive_url: `https://www.facebook.com/ads/library/?id=${encodeURIComponent(String(archiveId))}`, format, collation_id: campaign, observation_key: obs, ad_metrics: "unknown — Ad Library shows no engagement; longevity is not performance" },
      last_seen_at: ctx.now.toISOString(),
    })
  }
  return out
}

/** Route Apify dataset items to the idea normalizer of their actor; null for an actor this path does not own. */
export async function normalizeApifyIdeaItems(actor: string, items: readonly Record<string, any>[], ctx: { geo?: TopicIdea["geo"]; now: Date; reword?: Rewording | null; classify?: StatementClassifier | null; sourceId?: string | null }): Promise<(IdeaNormalizeResult & { competitorAds?: MetaAdMirrorRow[] }) | null> {
  const a = apifyIdeaActorFor(actor)
  if (a === "apify/facebook-groups-scraper") return normalizeFacebookGroupItems(items, ctx)
  if (a === "apify/facebook-ads-scraper") return normalizeMetaAdItems(items, ctx)
  return null
}

// ── A subscriber's own hand-saved permitted link or observation ────────────────────────────────────────────────────────

/**
 * The manual door (directive C5.1): a subscriber or authorized teammate saves a permitted link and/or their OWN observation.
 * The caller resolves the tenant from the session (CLAUDE.md §4) and passes it; this never accepts a body-supplied tenant.
 * Own words are the subscriber's own content (rights own_content) and still pass the exclusion gate and the personal-data
 * screen; a saved third-party link's text is never fetched here — the subscriber's note is the topic.
 */
export async function saveManualTopicObservation(db: Db, args: { brokerageId: string; note: string; link?: string | null; geo?: TopicIdea["geo"]; now?: Date }, deps: { intake?: typeof intakeTopicIdeas } = {}): Promise<TopicIntakeResult> {
  const now = args.now ?? new Date()
  const note = String(args.note ?? "").replace(/\s+/g, " ").trim().slice(0, 240)
  const intake = deps.intake ?? intakeTopicIdeas
  return intake(db, {
    brokerageId: args.brokerageId, now,
    ideas: [{ sourceKind: args.link ? "manual_link" : "own_observation", title: note, angle: null, categories: ["manual"], geo: args.geo ?? null, sourceUrl: args.link ?? null, observedAt: now.toISOString(), evidence: { kind: "unknown", note: "a subscriber's own observation" }, rights: "own_content", brief: { transport: "manual" } }],
  })
}
