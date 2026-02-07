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
