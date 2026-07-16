'use server'

import { createClient } from '@/lib/supabase/server'

// NEWSAPI.AI (Event Registry) is the news provider (owner directive) — richer
// than plain headlines: social scores, sentiment, semantic concepts. Key
// cascade + licensing rule live in lib/content-intel/newsapi-ai.ts (tenant key
// wins; the platform env key must hold a SaaS-licensed plan).
import { resolveNewsApiAiKey, searchNewsApiAiArticles } from '@/lib/content-intel/newsapi-ai'

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
  const apiKey = await resolveNewsApiAiKey(supabase, userData.brokerage_id)

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

  // LIVE NEWSAPI.AI FETCH: real local coverage with Event Registry's semantic
  // layer — relevance_score comes from the article's REAL cross-network social
  // score (what locals actually shared), not a positional guess. Live rows are
  // returned UNPERSISTED (newsletter_local_content.newsletter_id is NOT NULL —
  // rows are recorded when the newsletter that USES them is created, via
  // recordNewsletterLocalContent below).
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

    const articles = await searchNewsApiAiArticles({
      apiKey,
      keyword: 'real estate housing',
      locationKeyword: market,
      sortBy: 'date',
      count: Math.min(limit, 20),
      sinceDays: 14,
    })
    const maxSocial = Math.max(1, ...articles.map((a) => a.socialScore))
    const live = articles
      .slice(0, limit - pool.length)
      .map((a, i) => ({
        id: `live:${i}`,
        brokerage_id: userData.brokerage_id,
        newsletter_id: null, // persisted only when a newsletter uses it
        local_news_source_id: null,
        zip_code: zipCodes[0],
        content: JSON.stringify({
          title: a.title,
          summary: (a.body ?? '').slice(0, 280),
          url: a.url,
          published_at: a.dateTimePub,
          source: a.source,
          concepts: a.concepts, // Event Registry semantics ride along for the newsletter AI
          sentiment: a.sentiment,
        }),
        relevance_score: Math.max(1, Math.round((a.socialScore / maxSocial) * 100)),
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
