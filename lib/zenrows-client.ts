// ZenRows API Client for web scraping with browser rendering
// Used for Google searches, Nextdoor, and real estate site scraping

export class ZenrowsClient {
  private apiKey: string
  private baseUrl = "https://api.zenrows.com/v1/"

  constructor() {
    this.apiKey = process.env.ZENROWS_API_KEY || ""
    if (!this.apiKey) {
      console.warn("[ZenRows] API key not configured")
    }
  }

  async googleSearch(query: string, options: { location?: string; num?: number } = {}) {
    if (!this.apiKey) throw new Error("ZenRows API key not configured")

    const params = new URLSearchParams({
      apikey: this.apiKey,
      url: `https://www.google.com/search?q=${encodeURIComponent(query)}${options.num ? `&num=${options.num}` : ""}`,
      js_render: "true",
      premium_proxy: "true",
      wait: "2000",
    })

    if (options.location) {
      params.append("custom_headers", `true`)
      params.append("headers", JSON.stringify({ "X-Forwarded-For": options.location }))
    }

    try {
      const response = await fetch(`${this.baseUrl}?${params}`)
      if (!response.ok) throw new Error(`ZenRows error: ${response.status}`)

      const html = await response.text()
      return this.parseGoogleResults(html)
    } catch (error) {
      console.error("[ZenRows] Google search error:", error)
      return []
    }
  }

  async scrapeNextdoor(options: { location: string; keywords: string[] }) {
    if (!this.apiKey) throw new Error("ZenRows API key not configured")

    const results = []

    for (const keyword of options.keywords) {
      const searchUrl = `https://nextdoor.com/search/?query=${encodeURIComponent(keyword)}&bounds=${encodeURIComponent(options.location)}`

      const params = new URLSearchParams({
        apikey: this.apiKey,
        url: searchUrl,
        js_render: "true",
        premium_proxy: "true",
        wait: "3000",
        wait_for: ".post-card",
      })

      try {
        const response = await fetch(`${this.baseUrl}?${params}`)
        if (!response.ok) continue

        const html = await response.text()
        const parsed = this.parseNextdoorResults(html, keyword)
        results.push(...parsed)
      } catch (error) {
        console.error(`[ZenRows] Nextdoor scrape error for ${keyword}:`, error)
      }
    }

    return results
  }

  async scrapeRealEstateSite(options: { site: string; location: string; searchType: string }) {
    if (!this.apiKey) throw new Error("ZenRows API key not configured")

    const siteUrls: Record<string, string> = {
      zillow: `https://www.zillow.com/homes/${encodeURIComponent(options.location)}_rb/`,
      "realtor.com": `https://www.realtor.com/realestateandhomes-search/${encodeURIComponent(options.location)}`,
      redfin: `https://www.redfin.com/city/${encodeURIComponent(options.location)}`,
    }

    const url = siteUrls[options.site]
    if (!url) throw new Error(`Unsupported site: ${options.site}`)

    const params = new URLSearchParams({
      apikey: this.apiKey,
      url,
      js_render: "true",
      premium_proxy: "true",
      wait: "3000",
    })

    try {
      const response = await fetch(`${this.baseUrl}?${params}`)
      if (!response.ok) throw new Error(`ZenRows error: ${response.status}`)

      const html = await response.text()
      return this.parseRealEstateResults(html, options.site)
    } catch (error) {
      console.error(`[ZenRows] ${options.site} scrape error:`, error)
      return { properties: [], filters: {} }
    }
  }

  private parseGoogleResults(html: string): any[] {
    const results: any[] = []

    // Extract search result snippets using regex (simplified - use cheerio in production)
    const regex = /<h3[^>]*>([^<]+)<\/h3>[\s\S]{0,500}?<div[^>]*>([^<]+)<\/div>/gi
    let match

    while ((match = regex.exec(html)) !== null && results.length < 20) {
      results.push({
        title: match[1].trim(),
        snippet: match[2].trim(),
        url: "",
      })
    }

    return results
  }

  private parseNextdoorResults(html: string, keyword: string): any[] {
    // Simplified parsing - use cheerio for production
    const results: any[] = []

    // Look for post content
    const postRegex = /<div[^>]*class="[^"]*post-card[^"]*"[^>]*>([\s\S]{0,1000}?)<\/div>/gi
    let match

    while ((match = postRegex.exec(html)) !== null && results.length < 10) {
      const content = match[1].replace(/<[^>]+>/g, " ").trim()

      if (content.toLowerCase().includes(keyword.toLowerCase())) {
        results.push({
          type: "post",
          content: content.substring(0, 500),
          neighborhood: "Unknown",
          matched_keywords: [keyword],
          url: "https://nextdoor.com",
          relevance_score: 75,
        })
      }
    }

    return results
  }

  private parseRealEstateResults(html: string, site: string): any {
    // Simplified - would use proper HTML parsing in production
    return {
      properties: [],
      filters: {},
    }
  }
}
