import { runApifyTask } from './apify-actors'
import { runActorSyncGetDatasetItems } from "@/lib/providers/apify/client"
import { apifyToken } from "@/lib/env/aliases"

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

// ONE SPELLING (§6, 2026-09-03): APIFY_API_TOKEN is the survivor (connector
// registry, launch checklist, tenancy matrix); the content-intel lane's
// APIFY_TOKEN is accepted for one release through lib/env/aliases.ts. Resolved
// per call rather than at module load so a token set after import is seen.

export async function runApifyActor(
  actorId: string,
  input: Record<string, any>
): Promise<{
  data: any[]
  cost: number
}> {
  // Official Apify SDK adapter (lib/providers/apify/client.ts) — same
  // run-sync-get-dataset-items semantics (starts the actor, waits for it to
  // finish, returns the default dataset items), same price (Apify bills
  // compute-unit usage, not request shape). The adapter normalizes the
  // "owner/actor" vs "owner~actor" spelling itself.
  const runResponse = await runActorSyncGetDatasetItems(apifyToken() ?? "", actorId, input, { timeoutSecs: 60 })

  // 200/201 = finished with dataset items; 408 = run timed out (actor too slow).
  if (!runResponse.ok) {
    throw new Error(`Apify actor run error: ${runResponse.status} ${runResponse.error ?? ""}`)
  }

  const results = runResponse.data

  return {
    data: Array.isArray(results) ? results : [],
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
  const result = await runApifyTask('facebook', {
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
  const result = await runApifyTask('reddit', {
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
  const result = await runApifyTask('instagram', {
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
  const result = await runApifyTask('craigslist', {
    startUrls: [
      { url: `https://${params.city.toLowerCase().replace(/ /g, '')}.craigslist.org/search/${section}?query=${encodeURIComponent(params.query ?? '')}` },
    ],
    maxItems: params.limit || 100,
  })
  return { posts: result.data, cost: result.cost }
}

export async function scrapeLinkedInPosts(params: {
  keywords: string[]
  location?: string
  limit?: number
}): Promise<{ posts: any[]; cost: number }> {
  const result = await runApifyTask('linkedin', {
    keywords: params.keywords.join(' '),
    location: params.location,
    maxItems: params.limit || 50,
  })
  return { posts: result.data, cost: result.cost }
}

/**
 * Lane 82B — Facebook Marketplace property-for-sale listings for ONE territory city. The URL is
 * the location-scoped Marketplace category page (`/marketplace/<city>/propertyforsale`), so the
 * actor never sweeps outside the active territory. Input carries both candidates' field names
 * (`startUrls` + `resultsLimit` for apify/facebook-marketplace-scraper, `forSaleOnly` for the
 * vivid-softwares fallback) — runApifyTask hands every candidate the same input.
 */
export async function scrapeFacebookMarketplaceListings(params: {
  city: string
  /** Lane 83A — territory searches (buyer / relocation / realtor-seeking terms), same city slug. */
  queries?: readonly string[]
  limit?: number
}): Promise<{ listings: any[]; cost: number }> {
  const slug = params.city.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!slug) return { listings: [], cost: 0 }
  const searchUrls = (params.queries ?? [])
    .map((q) => q.trim()).filter(Boolean)
    .map((q) => ({ url: `https://www.facebook.com/marketplace/${slug}/search?query=${encodeURIComponent(q)}` }))
  const result = await runApifyTask('facebook_marketplace', {
    startUrls: [{ url: `https://www.facebook.com/marketplace/${slug}/propertyforsale` }, ...searchUrls],
    resultsLimit: params.limit || 50,
    includeListingDetails: true,
    forSaleOnly: true,
  })
  return { listings: result.data, cost: result.cost }
}

// TOMBSTONE — scrapeTikTokSearch / scrapeTikTokComments (lane 83A's two Apify hops) retired by
// lane 84C. Owner, 2026-09-26: "don't need tiktok." Their only caller was
// lib/lead-pipeline/social-sourcer.ts::sourceTikTokIntent, retired in the same edit.

export async function scrapeGoogleSearchResults(params: {
  queries: string[]
  resultsPerQuery?: number
}): Promise<{ results: any[]; cost: number }> {
  const result = await runApifyTask('google', {
    queries: params.queries.join('\n'),
    resultsPerPage: params.resultsPerQuery || 10,
    maxPagesPerQuery: 1,
  })
  return { results: result.data, cost: result.cost }
}
