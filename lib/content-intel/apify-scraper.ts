/**
 * lib/content-intel/apify-scraper.ts
 *
 * Apify-based competitor + handle scraper. Apify ships a catalog of 500+
 * actors that crawl YouTube, TikTok, Instagram, Threads, Twitter/X, etc.
 * The most useful for real-estate competitive intel:
 *
 *   apify/instagram-hashtag-scraper       — posts under #realestate, #justlisted
 *   apify/instagram-profile-scraper       — top posts from a competitor's profile
 *   streamers/youtube-scraper             — videos from a channel + recent
 *   apidojo/tiktok-scraper                — TikTok hashtag/profile scrape
 *   apify/facebook-groups-scraper         — PUBLIC group questions, IDEAS ONLY (wave 154, R3)
 *   apify/facebook-ads-scraper            — Meta Ad Library creatives, IDEAS ONLY (wave 154, R3)
 *
 * Each source_config carries:
 *   {
 *     "actor": "apify/instagram-hashtag-scraper",
 *     "input": { ... actor-specific payload ... },
 *     "title_field": "caption" | "title" | "text",
 *     "url_field":   "url" | "videoUrl",
 *     "engagement_fields": ["likesCount","commentsCount","viewsCount"]
 *   }
 *
 * Routes through the official Apify SDK adapter (lib/providers/apify/client.ts,
 * wave 70B) for canonical egress; auth via the existing 'apify' connector
 * registry entry (Bearer APIFY_API_TOKEN — the registry's envKey; this file
 * alone spelled it APIFY_TOKEN until 2026-09-03, so a tenant with the
 * registry's spelling set had a topic scraper that no-op'd forever. Resolved
 * through lib/env/aliases.ts; the old spelling is accepted for one release).
 *
 * WAVE 154 (lane 154C — owner R1 / R3, directive C5.6): this file used to normalize the dataset into a TopicCandidate whose
 * `title` WAS the post's own caption and whose engagement was log-compressed into a 20–95 band (a floor of 20 for a post
 * nobody engaged with — an invented number). Both are gone. runApifyScrape now returns the dataset items IN MEMORY only; the
 * cron (app/api/cron/content-intel-apify/route.ts) fences them, rewords them (lib/content-intel/public-chatter-topics.ts) and
 * files the reworded topic through THE ONE intake (lib/content-intel/topic-intake.ts). A public count an actor reports is
 * MEASURED evidence in its own unit (apifySocialIdeas below); nothing is invented when no count exists.
 */
import "server-only"
import { runActorSyncGetDatasetItems } from "@/lib/providers/apify/client"
import { apifyToken } from "@/lib/env/aliases"
import { deriveRewordedTopic, fenceUntrusted, observationDigest, type Rewording } from "./public-chatter-topics"
import type { TopicIdea } from "./topic-intake"

interface ApifyRunInput {
  actor:              string
  input:              Record<string, unknown>
}

export interface ApifyRunResult { ok: boolean; items: Array<Record<string, any>>; error: string | null; called: boolean }

/** The run seam: the SDK adapter by default; a proof injects a counting fake. */
export type ApifyRunner = (token: string, actor: string, input: Record<string, unknown>) => Promise<{ ok: boolean; data: any[] | null; error?: string | null }>
const defaultRunner: ApifyRunner = (token, actor, input) => runActorSyncGetDatasetItems(token, actor, input, { timeoutSecs: 60 })

/**
 * Run an actor synchronously (run-sync-get-dataset-items semantics, 60 s bound) and return its items IN MEMORY (≤ 50).
 * No token → no call (`called: false`). The items are untrusted and are never stored as returned.
 */
export async function runApifyScrape(args: ApifyRunInput, deps: { runner?: ApifyRunner; token?: string | null } = {}): Promise<ApifyRunResult> {
  const token = deps.token === undefined ? apifyToken() : deps.token
  if (!token) return { ok: false, items: [], error: "APIFY_API_TOKEN not configured — connect Apify in the integrations settings", called: false }
  const res = await (deps.runner ?? defaultRunner)(token, args.actor, args.input)
  if (!res.ok || !Array.isArray(res.data)) return { ok: false, items: [], error: res.error ?? "actor run failed", called: true }
  return { ok: true, items: res.data.slice(0, 50), error: null, called: true }
}

function safeIso(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === "number") {
    // Apify often returns ms-since-epoch; sometimes seconds.
    const ms = v < 10_000_000_000 ? v * 1000 : v
    return new Date(ms).toISOString()
  }
  if (typeof v === "string") {
    const t = Date.parse(v)
    return isNaN(t) ? null : new Date(t).toISOString()
  }
  return null
}

/**
 * Generic social-handle / hashtag items → REWORDED TopicIdeas (kind apify_social). The caption is fenced, reworded (rule-
 * derived unless a rewording seam is wired) and discarded; the configured engagement fields, when present, are MEASURED public
 * counts in their own unit. An item with no real-estate theme is held, never stored.
 */
export async function apifySocialIdeas(items: readonly Record<string, any>[], cfg: { title_field?: string; url_field?: string; engagement_fields?: string[]; geo?: TopicIdea["geo"]; sourceId: string; now: Date; reword?: Rewording | null }): Promise<{ ideas: TopicIdea[]; held: number; excluded: number }> {
  const out = { ideas: [] as TopicIdea[], held: 0, excluded: 0 }
  const geoLabel = cfg.geo?.label ?? cfg.geo?.city ?? null
  for (const item of items) {
    const fenced = fenceUntrusted(`${item[cfg.title_field ?? "caption"] ?? ""} ${item.caption ?? item.text ?? item.description ?? ""}`)
    const url = String(item[cfg.url_field ?? "url"] ?? "").trim() || null
    if (!fenced.text) { out.held++; continue }
    const d = await deriveRewordedTopic(fenced, { geoLabel, reword: cfg.reword ?? null, sourceKind: "apify_social" })
    if (d.status === "excluded") { out.excluded++; continue }
    if (d.status === "held") { out.held++; continue }
    let raw = 0, any = false
    for (const f of cfg.engagement_fields ?? ["likesCount", "viewsCount", "commentsCount", "shareCount"]) {
      const v = item[f]
      if (typeof v === "number" && v >= 0) { raw += v; any = true }
    }
    out.ideas.push({
      sourceKind: "apify_social", sourceId: cfg.sourceId, title: d.title, angle: d.angle, categories: d.categories, geo: cfg.geo ?? null,
      sourceUrl: url, publishedAt: safeIso(item.timestamp ?? item.takenAt ?? item.publishedTime ?? item.uploadDate ?? null), observedAt: cfg.now.toISOString(),
      evidence: any ? { kind: "measured", metric: (cfg.engagement_fields ?? ["likesCount", "viewsCount", "commentsCount", "shareCount"]).join("+"), value: raw, unit: "count", note: "platform-reported public counts" } : { kind: "unknown", note: "no public count reported" },
      rights: "public_read_reworded",
      brief: { observation_key: observationDigest(fenced), transport: "apify", consumer_question: d.consumerQuestion, topic_concept: d.title, theme_keys: d.themeKeys, rewording: d.status, apify_item_id: String(item.id ?? url ?? "") || null },
    })
  }
  return out
}
