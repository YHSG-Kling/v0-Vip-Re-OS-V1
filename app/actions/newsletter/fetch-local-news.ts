'use server'

import { createClient } from '@/lib/supabase/server'

const NEWSAPI_KEY = process.env.NEWSAPI_KEY

/**
 * NewsAPI key cascade (owner directive): the tenant's OWN connected key wins
 * (integration_credentials provider 'newsapi' — free/dev keys are licensed to
 * the tenant themselves), falling back to the PLATFORM key only when one is
 * configured — which requires a NewsAPI plan that permits SaaS redistribution
 * (their Business tier); the free tier does NOT, so the platform env key must
 * only ever hold a commercially-licensed key.
 */
async function resolveNewsApiKey(supabase: Awaited<ReturnType<typeof createClient>>, brokerageId: string): Promise<string | null> {
  const { data: cred } = await supabase
    .from('integration_credentials')
    .select('api_key')
    .eq('brokerage_id', brokerageId)
    .eq('provider_name', 'newsapi')
    .eq('is_active', true)
    .maybeSingle()
  return (cred?.api_key as string | undefined) || NEWSAPI_KEY || null
}

export async function fetchLocalNews(zipCodes: string[], limit: number = 10) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: userData } = await supabase
    .from('users')
    .select('brokerage_id')
    .eq('id', user.id)
    .single()

  if (!userData?.brokerage_id) throw new Error('User has no brokerage assigned')

  // Tenant key first, licensed platform key as fallback. No key at all →
  // the pool still works (honest degradation, no hard error at page load).
  const apiKey = await resolveNewsApiKey(supabase, userData.brokerage_id)

  // Fetch existing local content
  const { data: existingContent, error: fetchError } = await supabase
    .from('newsletter_local_content')
    .select()
    .eq('brokerage_id', userData.brokerage_id)
    .in('zip_code', zipCodes)
    .eq('included_in_last_newsletter', false)
    .order('relevance_score', { ascending: false })
    .limit(limit)

  if (fetchError) throw new Error(`Failed to fetch local content: ${fetchError.message}`)

  const pool = existingContent || []
  if (pool.length >= limit) return pool

  // LIVE NEWSAPI FETCH (burn-down round 5): the pool used to be the only
  // source and NOTHING filled it — this fetches real local headlines through
  // the connector gateway (the one egress choke) when the pool runs thin.
  // Live rows are returned UNPERSISTED (newsletter_local_content.newsletter_id
  // is NOT NULL — rows are recorded when the newsletter that USES them is
  // created, via recordNewsletterLocalContent below).
  if (!apiKey) return pool // no tenant key + no licensed platform key — pool only
  try {
    const { data: source } = await supabase
      .from('local_news_sources')
      .select('market_name, market_zip_codes')
      .eq('brokerage_id', userData.brokerage_id)
      .eq('enabled', true)
      .overlaps('market_zip_codes', zipCodes)
      .limit(1)
      .maybeSingle()
    const market = source?.market_name || zipCodes[0]

    const { callConnector } = await import('@/lib/agentic-os/connector-gateway')
    const res = await callConnector<{ articles?: Array<{ title?: string; description?: string; url?: string; publishedAt?: string }> }>({
      connector: 'newsapi',
      baseUrl: 'https://newsapi.org',
      path: `/v2/everything?q=${encodeURIComponent(`"${market}" AND (real estate OR housing OR home prices)`)}&language=en&sortBy=publishedAt&pageSize=${Math.min(limit, 20)}`,
      method: 'GET',
      auth: { style: 'header', name: 'X-Api-Key', value: apiKey },
    })
    const articles = res.ok ? (res.data?.articles ?? []) : []
    const live = articles
      .filter((a) => a.title && a.url)
      .slice(0, limit - pool.length)
      .map((a, i) => ({
        id: `live:${i}`,
        brokerage_id: userData.brokerage_id,
        newsletter_id: null, // persisted only when a newsletter uses it
        local_news_source_id: null,
        zip_code: zipCodes[0],
        content: JSON.stringify({ title: a.title, summary: a.description ?? '', url: a.url, published_at: a.publishedAt ?? null }),
        relevance_score: Math.max(1, 100 - i * 5),
        included_in_last_newsletter: false,
        created_at: new Date().toISOString(),
      }))
    return [...pool, ...live]
  } catch {
    return pool // live fetch is best-effort — the pool is still honest
  }
}

/**
 * Persist the local headlines a CREATED newsletter actually used.
 * newsletter_local_content.newsletter_id is NOT NULL (live FK →
 * newsletter_campaigns) — content rows exist only attached to the campaign
 * that ran them, which is also what makes included_in_last_newsletter honest.
 */
export async function recordNewsletterLocalContent(
  newsletterId: string,
  items: Array<{ title: string; content: string; ctaUrl?: string; zipCode?: string }>,
) {
  if (!newsletterId || items.length === 0) return { success: true, recorded: 0 }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  const { data: userData } = await supabase.from('users').select('brokerage_id').eq('id', user.id).single()
  if (!userData?.brokerage_id) throw new Error('User has no brokerage assigned')

  // Tenant check on the campaign the rows attach to.
  const { data: campaign } = await supabase
    .from('newsletter_campaigns').select('id, brokerage_id').eq('id', newsletterId).maybeSingle()
  if (!campaign || campaign.brokerage_id !== userData.brokerage_id) throw new Error('Campaign not in your brokerage')

  const rows = items.map((it) => ({
    newsletter_id: newsletterId,
    brokerage_id: userData.brokerage_id,
    zip_code: it.zipCode ?? null,
    content: JSON.stringify({ title: it.title, summary: it.content, url: it.ctaUrl ?? null }),
    relevance_score: null,
    included_in_last_newsletter: true,
  }))
  const { error } = await supabase.from('newsletter_local_content').insert(rows)
  if (error) throw new Error(`Failed to record local content: ${error.message}`)
  return { success: true, recorded: rows.length }
}

export async function setupLocalNewsSource(
  zipCodes: string[],
  marketName?: string,
  refreshFrequency: 'hourly' | 'daily' | 'weekly' = 'daily',
) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: userData } = await supabase
    .from('users')
    .select('brokerage_id')
    .eq('id', user.id)
    .single()

  if (!userData?.brokerage_id) throw new Error('User has no brokerage assigned')

  // Check if news source exists
  const { data: existing } = await supabase
    .from('local_news_sources')
    .select('id')
    .eq('brokerage_id', userData.brokerage_id)
    .eq('market_name', marketName || zipCodes.join(','))
    .single()

  if (existing) {
    // Update existing
    const { error } = await supabase
      .from('local_news_sources')
      .update({
        market_zip_codes: zipCodes,
        refresh_frequency: refreshFrequency,
        enabled: true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)

    if (error) throw new Error(`Failed to update news source: ${error.message}`)

    return {
      success: true,
      newsSourceId: existing.id,
      message: 'News source updated',
    }
  }

  // Create new
  const { data: newSource, error } = await supabase
    .from('local_news_sources')
    .insert({
      brokerage_id: userData.brokerage_id,
      name: marketName || zipCodes.join(','), // NOT NULL on local_news_sources
      market_zip_codes: zipCodes,
      market_name: marketName,
      refresh_frequency: refreshFrequency,
      enabled: true,
    })
    .select()
    .single()

  if (error) throw new Error(`Failed to create news source: ${error.message}`)

  return {
    success: true,
    newsSourceId: newSource.id,
    message: 'News source created',
  }
}
