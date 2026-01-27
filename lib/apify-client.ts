// Apify API Client for web scraping real estate sites
// Scrapes Zillow, Realtor.com, Redfin, social media, and forums

export class ApifyClient {
  private apiKey: string
  private baseUrl = "https://api.apify.com/v2"

  constructor() {
    this.apiKey = process.env.APIFY_API_KEY || ""
    if (!this.apiKey) {
      console.warn("[Apify] API key not configured")
    }
  }

  async scrapeZillow(location: string, filters?: { minPrice?: number; maxPrice?: number }) {
    if (!this.apiKey) throw new Error("Apify API key not configured")

    try {
      const actorId = "compass~zillow-scraper"
      const input = {
        location,
        ...filters,
      }

      const run = await this.runActor(actorId, input)
      return await this.getDataset(run.defaultDatasetId)
    } catch (error) {
      console.error("[Apify] Zillow scrape error:", error)
      return []
    }
  }

  async scrapeRealtorDotCom(location: string, filters?: { minPrice?: number; maxPrice?: number }) {
    if (!this.apiKey) throw new Error("Apify API key not configured")

    try {
      const actorId = "compass~realtor-scraper"
      const input = {
        location,
        ...filters,
      }

      const run = await this.runActor(actorId, input)
      return await this.getDataset(run.defaultDatasetId)
    } catch (error) {
      console.error("[Apify] Realtor.com scrape error:", error)
      return []
    }
  }

  async scrapeRedfin(location: string, filters?: { minPrice?: number; maxPrice?: number }) {
    if (!this.apiKey) throw new Error("Apify API key not configured")

    try {
      const actorId = "compass~redfin-scraper"
      const input = {
        location,
        ...filters,
      }

      const run = await this.runActor(actorId, input)
      return await this.getDataset(run.defaultDatasetId)
    } catch (error) {
      console.error("[Apify] Redfin scrape error:", error)
      return []
    }
  }

  async scrapeSocialMedia(platform: "facebook" | "nextdoor" | "reddit", searchQuery: string) {
    if (!this.apiKey) throw new Error("Apify API key not configured")

    try {
      let actorId = ""
      if (platform === "facebook") actorId = "apify~facebook-posts-scraper"
      if (platform === "reddit") actorId = "trudax~reddit-scraper"
      if (platform === "nextdoor") actorId = "compass~nextdoor-scraper"

      const input = {
        searchQuery,
        maxPosts: 50,
      }

      const run = await this.runActor(actorId, input)
      return await this.getDataset(run.defaultDatasetId)
    } catch (error) {
      console.error(`[Apify] ${platform} scrape error:`, error)
      return []
    }
  }

  async scrapeGoogleMaps(location: string, searchQuery: string) {
    if (!this.apiKey) throw new Error("Apify API key not configured")

    try {
      const actorId = "compass~google-maps-scraper"
      const input = {
        searchQuery,
        location,
        maxResults: 100,
      }

      const run = await this.runActor(actorId, input)
      return await this.getDataset(run.defaultDatasetId)
    } catch (error) {
      console.error("[Apify] Google Maps scrape error:", error)
      return []
    }
  }

  async scrapeYelp(location: string, category: string) {
    if (!this.apiKey) throw new Error("Apify API key not configured")

    try {
      const actorId = "compass~yelp-scraper"
      const input = {
        location,
        searchTerm: category,
        maxResults: 50,
      }

      const run = await this.runActor(actorId, input)
      return await this.getDataset(run.defaultDatasetId)
    } catch (error) {
      console.error("[Apify] Yelp scrape error:", error)
      return []
    }
  }

  private async runActor(actorId: string, input: any) {
    const response = await fetch(`${this.baseUrl}/acts/${actorId}/runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input }),
    })

    if (!response.ok) throw new Error(`Apify error: ${response.status}`)

    const data = await response.json()
    return data.data
  }

  private async getDataset(datasetId: string) {
    const response = await fetch(`${this.baseUrl}/datasets/${datasetId}/items`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    })

    if (!response.ok) throw new Error(`Apify dataset error: ${response.status}`)

    return await response.json()
  }
}
