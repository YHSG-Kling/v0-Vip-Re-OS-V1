import type { NextdoorPost } from "./nextdoor-extract"

// ─── CLASS ALIAS (backward compat for callers using `new ZenrowsClient()`) ────
export class ZenrowsClient {
  async scrape(url: string, options: { js_render?: boolean; premium_proxy?: boolean } = {}) {
    try {
      const result = await scrapeWithZenRows(url, {
        jsRender: options.js_render,
        premiumProxy: options.premium_proxy,
      })
      return { success: true, html: result.body, cost: result.cost }
    } catch (err) {
      return { success: false, html: '', cost: 0 }
    }
  }
  async googleSearch(query: string, options: { location?: string; num?: number } = {}) {
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}${options.num ? `&num=${options.num}` : ''}`
    const result = await scrapeWithZenRows(url, { jsRender: true, premiumProxy: true })
    return result.body
  }

  /**
   * Scrapes Nextdoor search results for a given URL.
   *
   * Nextdoor has NO structured actor — not in lib/external/apify-actors.ts, not at ZenRows. All
   * either provider can hand back is raw HTML. So this is the lane
   * `lib/external/llm-html-extractor.ts :: extractFromHtml` exists for: a schema-bound HTML→JSON
   * pass that produces the post fields the callers of this method have always read.
   *
   * WHAT CHANGED AND WHY. The previous body was one block-level regex that produced `{ content }`
   * and nothing else, while its two live consumers read six other fields:
   *   · app/api/cron/lead-scraping/route.ts → post.author_name, post.post_id
   *   · app/actions/lead-intelligence.ts    → type, neighborhood, matched_keywords, url,
   *                                           relevance_score (written into `nextdoor_activity`)
   * Every one of those was `undefined` on every run, so nextdoor_activity's activity_type /
   * neighborhood / detected_keywords / activity_url / relevance_score columns were written NULL,
   * and its `relevance_score > 70` gate — `undefined > 70` — could never be true. The contract
   * existed; the implementation did not.
   *
   * HONESTY. The model extracts only text that is on the page. `type`, `matched_keywords` and
   * `relevance_score` are computed deterministically in lib/external/nextdoor-extract.ts from the
   * extracted text — a generative model is never asked to author a score that then gets stored as
   * an observation. When extraction is unavailable (no AI_GATEWAY_API_KEY, gateway refusal,
   * unparseable output) the old regex path still runs, but each record is stamped
   * `extraction: "regex_fallback"` with `relevance_score: null` — degraded, and visibly so, never
   * a fabricated score.
   *
   * The return shape is a SUPERSET of the old one, so both existing callers work unchanged.
   */
  async scrapeNextdoor(
    url: string,
    options: { keywords?: string[]; limit?: number } = {},
  ): Promise<{
    success: boolean
    posts: NextdoorPost[]
    cost: number
    /** Which path produced `posts` — null when nothing was produced at all. */
    extraction: "llm_schema" | "regex_fallback" | null
    /** Present when the schema extraction was refused; the regex result (if any) still ships. */
    extractionError: string | null
    error: string | null
  }> {
    let result: ZenRowsResponse
    try {
      result = await scrapeWithZenRows(url, { jsRender: true, premiumProxy: true })
    } catch (err) {
      // A scrape that could not run is a FAILURE, not an empty neighborhood.
      return {
        success: false, posts: [], cost: 0, extraction: null, extractionError: null,
        error: err instanceof Error ? err.message : String(err),
      }
    }
    if (!result.body) {
      return {
        success: false, posts: [], cost: result.cost, extraction: null, extractionError: null,
        error: "ZenRows returned an empty body",
      }
    }

    const { extractFromHtml } = await import("./llm-html-extractor")
    const {
      NEXTDOOR_POST_SCHEMA, NEXTDOOR_EXTRACT_INSTRUCTIONS, normalizeExtractedPosts, regexFallbackPosts,
    } = await import("./nextdoor-extract")

    const extracted = await extractFromHtml({
      html:         result.body,
      schema:       NEXTDOOR_POST_SCHEMA,
      instructions: NEXTDOOR_EXTRACT_INSTRUCTIONS,
    })

    if (extracted.error) {
      const posts = regexFallbackPosts(result.body, { keywords: options.keywords, sourceUrl: url, limit: options.limit })
      return {
        success: posts.length > 0,
        posts,
        cost: result.cost,
        extraction: posts.length > 0 ? "regex_fallback" : null,
        extractionError: extracted.error,
        error: posts.length > 0 ? null : `html extraction refused (${extracted.error}) and the fallback recovered no posts`,
      }
    }

    const posts = normalizeExtractedPosts(extracted.records, {
      keywords:  options.keywords,
      sourceUrl: url,
      limit:     options.limit ?? 30,
    })
    // Zero posts from a SUCCESSFUL extraction is a real answer (a search with no results), not a
    // failure — so success stays true and the caller sees an honestly empty neighborhood.
    return { success: true, posts, cost: result.cost, extraction: "llm_schema", extractionError: null, error: null }
  }

  /**
   * Scrapes Facebook group posts by delegating to the Apify Facebook scraper,
   * since Facebook requires auth that ZenRows alone cannot provide.
   */
  async scrapeFacebookGroups(params: { groupUrls: string[]; keywords: string[] }): Promise<{ success: boolean; posts: any[]; cost: number }> {
    try {
      const { scrapeFacebookGroupPosts } = await import('./apify-client')
      const result = await scrapeFacebookGroupPosts({ groupUrl: params.groupUrls[0], keywords: params.keywords, limit: 50 })
      return { success: true, posts: result.posts ?? [], cost: result.cost ?? 0 }
    } catch {
      return { success: false, posts: [], cost: 0 }
    }
  }
}

const ZENROWS_API_KEY = process.env.ZENROWS_API_KEY!
const ZENROWS_API_URL = 'https://api.zenrows.com/v1/'

export interface ZenRowsResponse {
  statusCode: number
  body: string
  cost: number
}

export async function scrapeWithZenRows(
  url: string,
  options: {
    loadingWait?: 'networkidle' | 'domcontentloaded'
    customHeaders?: Record<string, string>
    premiumProxy?: boolean
    jsRender?: boolean
  } = {}
): Promise<ZenRowsResponse> {
  const query: Record<string, string> = {
    url,
    js_render: options.jsRender !== false ? 'true' : 'false',
    wait_for: options.loadingWait || 'networkidle',
    premium_proxy: options.premiumProxy ? 'true' : 'false',
  }
  if (options.customHeaders) query.custom_headers = 'true'

  // Single egress: route through the connector-gateway (one way in/out). ZenRows returns
  // raw HTML, so we request a text response (no JSON parse / shape adaptation).
  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const res = await callConnector<string>({
    connector: "zenrows",
    baseUrl: ZENROWS_API_URL,
    path: "",
    method: "GET",
    query,
    auth: { style: "query", name: "apikey", value: ZENROWS_API_KEY },
    headers: options.customHeaders || undefined,
    responseType: "text",
  })

  if (!res.ok) {
    throw new Error(`ZenRows API error: ${res.status ?? "network"} ${res.error ?? ""}`.trim())
  }

  return {
    statusCode: res.status ?? 200,
    body: res.data ?? "",
    cost: 0.01,
  }
}

export async function retryWithApifyFallback(
  url: string,
  context: 'facebook' | 'reddit' | 'craigslist'
): Promise<{ html: string; source: 'zenrows' | 'apify'; cost: number }> {
  try {
    const result = await scrapeWithZenRows(url, { premiumProxy: true })
    return {
      html: result.body,
      source: 'zenrows',
      cost: result.cost,
    }
  } catch (error) {
    console.warn('[v0] ZenRows failed, falling back to Apify:', error)
    
    const { runApifyActor } = await import('./apify-client')
    
    let actorId = ''
    if (context === 'facebook') actorId = 'apify/facebook-pages-scraper'
    if (context === 'reddit') actorId = 'trudax/reddit-scraper'
    if (context === 'craigslist') actorId = 'lukaskrivka/craigslist-scraper'

    const apifyResult = await runApifyActor(actorId, {
      startUrls: [{ url }],
      maxItems: 100,
    })

    return {
      html: JSON.stringify(apifyResult.data),
      source: 'apify',
      cost: apifyResult.cost,
    }
  }
}

export async function extractContactsFromHtml(html: string): Promise<{
  emails: string[]
  phones: string[]
}> {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
  const phoneRegex = /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g

  const emails = html.match(emailRegex) || []
  const phones = html.match(phoneRegex) || []

  return {
    emails: [...new Set(emails)],
    phones: [...new Set(phones)],
  }
}
