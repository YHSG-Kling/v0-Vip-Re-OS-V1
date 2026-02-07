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
