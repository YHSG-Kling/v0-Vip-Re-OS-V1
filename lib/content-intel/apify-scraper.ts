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
 * The scraper runs the actor synchronously (Apify has a run-sync endpoint
 * for short crawls), normalizes the items into our TopicCandidate shape,
 * and the cron upserts them into content_topic_bank.
 *
 * Routes through callConnector for canonical egress; auth via the existing
 * 'apify' connector registry entry (Bearer APIFY_TOKEN).
 */
import "server-only"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

export interface ApifyTopicItem {
  item_id:          string
  title:            string
  url:              string
  summary:          string
  engagement_score: number
  published_date:   string | null
  categories:       string[]
}

interface ApifyRunInput {
  actor:              string
  input:              Record<string, unknown>
  title_field:        string
  url_field:          string
  engagement_fields?: string[]
}

interface ApifyDatasetItem {
  [key: string]: unknown
}

export async function runApifyScrape(args: ApifyRunInput): Promise<ApifyTopicItem[]> {
  const token = process.env.APIFY_TOKEN
  if (!token) return [] // graceful no-op when not configured

  // Apify's run-sync-get-dataset-items returns the dataset directly when the
  // run finishes within the timeout. We bound it tight (60s) — anything
  // longer we re-queue as async in a future cron.
  const path = `acts/${encodeURIComponent(args.actor)}/run-sync-get-dataset-items`
  const res = await callConnector<ApifyDatasetItem[]>({
    connector: "apify",
    baseUrl:   "https://api.apify.com/v2",
    path,
    method:    "POST",
    auth:      { style: "bearer", token },
    query:     { timeout: "60", format: "json" },
    body:      args.input,
    responseType: "json",
    timeoutMs: 80_000,
  })
  if (!res.ok || !Array.isArray(res.data)) return []

  const out: ApifyTopicItem[] = []
  for (const item of res.data.slice(0, 50)) {
    const title = String(item[args.title_field] ?? "").trim()
    const url   = String(item[args.url_field] ?? "").trim()
    if (!title || !url) continue

    // Normalize engagement across actors — sum the configured fields,
    // log-compress to a 0-100 score so a viral post (100k likes) lands
    // in the 80-95 band and a typical top post in the 50-70 band.
    let raw = 0
    for (const f of args.engagement_fields ?? ["likesCount", "viewsCount", "commentsCount", "shareCount"]) {
      const v = item[f]
      if (typeof v === "number" && v > 0) raw += v
    }
    const score = Math.min(95, Math.max(20, Math.round(15 * Math.log10(raw + 10))))

    // Date when available — Apify actors expose either timestamp (ms),
    // takenAt (ISO), publishedTime (Date), etc. Best-effort.
    const dateRaw = item.timestamp ?? item.takenAt ?? item.publishedTime ?? item.uploadDate ?? null
    const published_date = dateRaw ? safeIso(dateRaw) : null

    out.push({
      item_id:          String(item.id ?? url),
      title:            title.slice(0, 240),
      url,
      summary:          (String(item.caption ?? item.text ?? item.description ?? "")).slice(0, 4000),
      engagement_score: score,
      published_date,
      categories:       inferCategories(`${title} ${item.caption ?? ""} ${item.description ?? ""}`),
    })
  }
  return out
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

function inferCategories(text: string): string[] {
  const t = text.toLowerCase()
  const cats: string[] = []
  const add = (c: string) => { if (!cats.includes(c)) cats.push(c) }
  if (/\b(just listed|new listing|just sold|coming soon|open house)\b/.test(t)) add("market_education")
  if (/\b(buyer|first[- ]time|down payment|closing cost)\b/.test(t)) add("buyer_advice")
  if (/\b(seller|cma|listing agreement|stage|stag)\b/.test(t)) add("seller_advice")
  if (/\b(rate|mortgage|interest|fha|va loan)\b/.test(t)) add("finance")
  if (/\b(neighborhood|school|walkable|downtown|hoa)\b/.test(t)) add("neighborhood")
  if (/\b(renovation|remodel|home improvement|diy|inspection)\b/.test(t)) add("home_improvement")
  if (cats.length === 0) add("market_education")
  return cats
}
