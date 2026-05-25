// ─── CLASS ALIAS (backward compat for callers using `new ApifyClient()`) ──────
export class ApifyClient {
  async scrapeZillow(location: string, filters?: { minPrice?: number; maxPrice?: number }) {
    return runApifyActor('compass~zillow-scraper', { location, ...filters }).then(r => r.data)
  }
  async scrapeRealtorDotCom(location: string, filters?: { minPrice?: number; maxPrice?: number }) {
    return runApifyActor('compass~realtor-scraper', { location, ...filters }).then(r => r.data)
  }
  async scrapeRedfin(location: string, filters?: { minPrice?: number; maxPrice?: number }) {
    return runApifyActor('compass~redfin-scraper', { location, ...filters }).then(r => r.data)
  }
  async scrapeSocialMedia(platform: 'facebook' | 'nextdoor' | 'reddit', searchQuery: string) {
    const actorMap = { facebook: 'apify~facebook-posts-scraper', reddit: 'trudax~reddit-scraper', nextdoor: 'compass~nextdoor-scraper' }
    return runApifyActor(actorMap[platform], { searchQuery, maxPosts: 50 }).then(r => r.data)
  }
  async scrapeGoogleMaps(location: string, searchQuery: string) {
    return runApifyActor('compass~google-maps-scraper', { searchQuery, location, maxResults: 100 }).then(r => r.data)
  }
  async scrapeYelp(location: string, category: string) {
    return runApifyActor('compass~yelp-scraper', { location, searchTerm: category, maxResults: 50 }).then(r => r.data)
  }
}

const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN!
const APIFY_API_URL = 'https://api.apify.com/v2'

export async function runApifyActor(
  actorId: string,
  input: Record<string, any>
): Promise<{
  data: any[]
  cost: number
}> {
  const runResponse = await fetch(`${APIFY_API_URL}/acts/${actorId}/runs`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${APIFY_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  })

  if (!runResponse.ok) {
    throw new Error(`Apify actor start error: ${runResponse.status} ${runResponse.statusText}`)
  }

  const runData = await runResponse.json()
  const runId = runData.data.id

  let status = 'RUNNING'
  let attempts = 0
  const maxAttempts = 40

  while (status === 'RUNNING' && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 3000))

    const statusResponse = await fetch(`${APIFY_API_URL}/acts/${actorId}/runs/${runId}`, {
      headers: {
        'Authorization': `Bearer ${APIFY_API_TOKEN}`,
      },
    })

    const statusData = await statusResponse.json()
    status = statusData.data.status
    attempts++
  }

  if (status !== 'SUCCEEDED') {
    throw new Error(`Apify actor failed with status: ${status}`)
  }

  const resultsResponse = await fetch(`${APIFY_API_URL}/acts/${actorId}/runs/${runId}/dataset/items`, {
    headers: {
      'Authorization': `Bearer ${APIFY_API_TOKEN}`,
    },
  })

  const results = await resultsResponse.json()

  return {
    data: results || [],
    cost: 0.50,
  }
}

export async function scrapeFacebookGroupPosts(params: {
  groupUrl: string
  keywords?: string[]
  limit?: number
}): Promise<{
  posts: any[]
  cost: number
}> {
  const result = await runApifyActor('apify/facebook-pages-scraper', {
    startUrls: [{ url: params.groupUrl }],
    maxPosts: params.limit || 100,
    searchKeywords: params.keywords,
  })

  return {
    posts: result.data,
    cost: result.cost,
  }
}

export async function scrapeRedditPosts(params: {
  subreddits: string[]
  keywords?: string[]
  limit?: number
}): Promise<{
  posts: any[]
  cost: number
}> {
  const result = await runApifyActor('trudax/reddit-scraper', {
    subreddits: params.subreddits,
    searchTerms: params.keywords,
    maxPosts: params.limit || 100,
  })

  return {
    posts: result.data,
    cost: result.cost,
  }
}

export async function scrapeInstagramPosts(params: {
  hashtags?: string[]
  searchTerms?: string[]
  limit?: number
}): Promise<{ posts: any[]; cost: number }> {
  const result = await runApifyActor('apify/instagram-scraper', {
    search: (params.searchTerms ?? params.hashtags ?? []).join(' '),
    searchType: 'hashtag',
    resultsLimit: params.limit || 100,
  })
  return { posts: result.data, cost: result.cost }
}

export async function scrapeCraigslistPosts(params: {
  city: string
  query?: string
  limit?: number
  /** Craigslist search section: 'rea' = real estate for sale (seller), 'hhh' = housing (buyer "wanted"/ISO posts live here). */
  section?: string
}): Promise<{ posts: any[]; cost: number }> {
  const section = params.section || 'rea'
  const result = await runApifyActor('epctex/craigslist-scraper', {
    startUrls: [
      { url: `https://${params.city.toLowerCase().replace(/ /g, '')}.craigslist.org/search/${section}?query=${encodeURIComponent(params.query ?? '')}` },
    ],
    maxItems: params.limit || 100,
  })
  return { posts: result.data, cost: result.cost }
}

export async function scrapeGoogleSearchResults(params: {
  queries: string[]
  resultsPerQuery?: number
}): Promise<{ results: any[]; cost: number }> {
  const result = await runApifyActor('apify/google-search-scraper', {
    queries: params.queries.join('\n'),
    resultsPerPage: params.resultsPerQuery || 10,
    maxPagesPerQuery: 1,
  })
  return { results: result.data, cost: result.cost }
}
