/**
 * lib/content-intel/reddit-scraper.ts
 *
 * Reddit JSON API scraper — public, unauthenticated, free. Returns the top
 * threads in a subreddit over a time window. We score each thread for
 * audience-value signal (upvote count + comment count + freshness) and
 * normalize to the 0-100 engagement score the topic_bank uses.
 *
 * Endpoint shape:
 *   GET https://www.reddit.com/r/<subreddit>/top.json?t=<window>&limit=25
 *
 * Routes through callConnector (single egress) so the egress audit log
 * captures every external request, same as every other connector.
 */
import "server-only"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

export type RedditWindow = "day" | "week" | "month"

export interface RedditTopThread {
  thread_id:        string
  title:            string
  permalink:        string
  url:              string
  selftext:         string
  upvotes:          number
  comments:         number
  created_utc:      number
  subreddit:        string
  /** Our normalized 0-100 engagement score. */
  engagement_score: number
  /** Heuristic category tags derived from the title. */
  categories:       string[]
}

interface RedditListingItem {
  data: {
    id:           string
    title:        string
    permalink:    string
    url:          string
    selftext?:    string
    ups:          number
    num_comments: number
    created_utc:  number
    subreddit:    string
    over_18?:     boolean
    stickied?:    boolean
  }
}

interface RedditListing {
  data?: {
    children?: RedditListingItem[]
  }
}

export async function fetchTopThreads(args: {
  subreddit: string
  window:    RedditWindow
  limit?:    number
}): Promise<RedditTopThread[]> {
  const limit = Math.min(args.limit ?? 25, 100)
  const res = await callConnector<RedditListing>({
    connector: "reddit",
    baseUrl:   "https://www.reddit.com",
    path:      `r/${encodeURIComponent(args.subreddit)}/top.json`,
    method:    "GET",
    auth:      { style: "none" },
    query:     { t: args.window, limit: String(limit) },
    headers:   { "User-Agent": "VipReOS-ContentIntel/1.0 (real-estate topic intelligence)" },
    responseType: "json",
    timeoutMs:    20_000,
  })
  if (!res.ok || !res.data) return []

  const items = res.data.data?.children ?? []
  const now = Date.now() / 1000
  const out: RedditTopThread[] = []
  for (const it of items) {
    const d = it.data
    if (!d?.id || !d.title) continue
    if (d.over_18) continue  // skip NSFW
    if (d.stickied) continue // skip sticky/mod posts
    const ageHours = Math.max(1, (now - d.created_utc) / 3600)

    // Score: a logarithmic mix of upvotes + comments weighted higher when
    // recent. Normalized to 0-100. The constants are tuned for real-estate
    // subreddits where top threads typically land 200-3000 upvotes / week.
    const upScore   = Math.min(60, 12 * Math.log10(d.ups + 1))
    const cmtScore  = Math.min(30, 9  * Math.log10(d.num_comments + 1))
    const freshness = Math.max(0, 10 - Math.log2(ageHours))
    const score     = Math.max(0, Math.min(100, Math.round(upScore + cmtScore + freshness)))

    out.push({
      thread_id:        d.id,
      title:            d.title,
      permalink:        `https://www.reddit.com${d.permalink}`,
      url:              d.url,
      selftext:         (d.selftext ?? "").slice(0, 4000),
      upvotes:          d.ups,
      comments:         d.num_comments,
      created_utc:      d.created_utc,
      subreddit:        d.subreddit,
      engagement_score: score,
      categories:       inferCategories(d.title, d.selftext ?? ""),
    })
  }
  return out
}

/**
 * Derive category tags from the title+body. Used by the topic-bank picker
 * so the podcast/newsletter can pull "buyer_advice" + "finance" themed
 * content without re-running an LLM call per topic.
 */
function inferCategories(title: string, body: string): string[] {
  const text = `${title} ${body}`.toLowerCase()
  const cats: string[] = []
  const add = (c: string) => { if (!cats.includes(c)) cats.push(c) }
  if (/\b(rate|mortgage|interest|refi|refinance|points|apr|fha|va loan)\b/.test(text)) add("finance")
  if (/\b(first time|firsttime|down payment|closing cost|escrow|earnest)\b/.test(text)) add("buyer_advice")
  if (/\b(sell|seller|listing agreement|asking price|cma|home prep|stag)\b/.test(text)) add("seller_advice")
  if (/\b(market|inventory|home prices|appreciation|trend|crash|housing market)\b/.test(text)) add("market_education")
  if (/\b(neighborhood|school district|hoa|gated|walkable|commute)\b/.test(text)) add("neighborhood")
  if (/\b(renovation|remodel|fix and flip|diy|home improvement|inspection)\b/.test(text)) add("home_improvement")
  if (/\b(law|regulation|tcpa|fair housing|disclosure|article 16|nar)\b/.test(text)) add("regulation")
  if (/\b(tip|advice|how to|what to know|guide|q&a)\b/.test(text)) add("buyer_advice")
  if (cats.length === 0) add("market_education") // safest default for real-estate threads
  return cats
}
