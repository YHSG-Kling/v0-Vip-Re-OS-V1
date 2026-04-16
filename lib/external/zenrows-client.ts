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
   * Extracts post text nodes from the rendered HTML and returns up to 30 posts.
   */
  async scrapeNextdoor(url: string): Promise<{ success: boolean; posts: { content: string }[]; cost: number }> {
    try {
      const result = await scrapeWithZenRows(url, { jsRender: true, premiumProxy: true })
      if (!result.body) return { success: false, posts: [], cost: result.cost }
      const posts: { content: string }[] = []
      const matches = result.body.match(/class="[^"]*post[^"]*"[^>]*>([\s\S]*?)<\/div>/g) ?? []
      for (const match of matches.slice(0, 30)) {
        const text = match.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        if (text.length > 30) posts.push({ content: text.slice(0, 500) })
      }
      return { success: true, posts, cost: result.cost }
    } catch {
      return { success: false, posts: [], cost: 0 }
    }
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
  const params = new URLSearchParams({
    url,
    apikey: ZENROWS_API_KEY,
    js_render: options.jsRender !== false ? 'true' : 'false',
    wait_for: options.loadingWait || 'networkidle',
    premium_proxy: options.premiumProxy ? 'true' : 'false',
  })

  if (options.customHeaders) {
    params.append('custom_headers', 'true')
  }

  const response = await fetch(`${ZENROWS_API_URL}?${params}`, {
    method: 'GET',
    headers: options.customHeaders || {},
  })

  if (!response.ok) {
    throw new Error(`ZenRows API error: ${response.status} ${response.statusText}`)
  }

  const body = await response.text()

  return {
    statusCode: response.status,
    body,
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
