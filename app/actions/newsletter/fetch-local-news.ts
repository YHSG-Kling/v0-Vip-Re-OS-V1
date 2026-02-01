'use server'

import { createClient } from '@/lib/supabase/server'

const NEWSAPI_KEY = process.env.NEWSAPI_KEY

export async function fetchLocalNews(zipCodes: string[], limit: number = 10) {
  if (!NEWSAPI_KEY) {
    throw new Error('NewsAPI key not configured')
  }

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

  // If no local content in DB, could fetch from NewsAPI here
  // For now, return what we have
  return existingContent || []
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
