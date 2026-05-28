/**
 * Market Insight Generator
 * 4-tier data provider waterfall: RentCast → BatchData → OSINT/ZenRows → CMA aggregate
 * Generates AI-powered market analysis for agents
 */

import { generateObject } from 'ai'
import { resolveModel } from '@/lib/ai/resolve-model'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/service'
import { KernelEvent } from '@/lib/kernel/events'
import { getRentcastMarketStats } from '@/lib/property/rentcast'

// Minimal shape for the free OSINT (ZenRows/Zillow) market-stats fallback.
interface ScrapedMarketStats {
  median_sale_price?: number
  avg_days_on_market?: number
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MarketInsightRequest {
  brokerageId: string
  agentId?: string
  marketArea: string
  zipCode?: string
  forceRegenerate?: boolean
}

export interface MarketInsightResult {
  insightId: string
  cached: boolean
}

export interface MarketDataRow {
  id: string
  brokerage_id: string
  market_area: string
  city: string | null
  state: string | null
  zip_code: string | null
  data_date: string
  active_listings: number
  new_listings_30d: number
  sold_listings_30d: number
  median_sale_price: number
  avg_days_on_market: number
  list_to_sale_ratio: number
  months_of_inventory: number
  market_type: 'seller' | 'buyer' | 'balanced'
  price_trend_pct_30d: number
  price_trend_pct_1yr: number
  source_type: string
  updated_at: string
}

export interface MarketTrendRow {
  id: string
  snapshot_month: string
  median_price: number
  avg_dom: number
  active_inventory: number
  sale_price_pct_list: number
}

const MarketInsightSchema = z.object({
  headline: z.string().describe('10 words max — agent-facing headline'),
  summary: z.string().describe('2-3 sentence overview'),
  price_trend: z.enum(['up', 'flat', 'down']),
  dom_trend: z.enum(['decreasing', 'stable', 'increasing']),
  inventory_level: z.enum(['tight', 'balanced', 'oversupplied']),
  seasonal_pattern: z.string().describe('1 sentence observation'),
  competition_alert: z.string().nullable().describe('New listings or competitor activity'),
  buyer_indicators: z.array(z.string()).max(3),
  seller_indicators: z.array(z.string()).max(3),
  key_stats: z.object({
    median_price: z.number(),
    dom: z.number(),
    months_supply: z.number(),
    list_to_sale_ratio: z.number(),
  }),
})

type MarketInsight = z.infer<typeof MarketInsightSchema>

// ─── OSINT Scraper (inline — do not modify lib/osint-client.ts) ──────────────

async function scrapeZillowNeighborhoodData(
  city: string,
  state: string
): Promise<ScrapedMarketStats> {
  if (!process.env.ZENROWS_API_KEY) return {}

  try {
    const { ZenrowsClient } = await import('@/lib/external/zenrows-client')
    const zenrows = new ZenrowsClient()
    const url = `https://www.zillow.com/homes/${encodeURIComponent(city)}-${state}_rb/`
    const result = await zenrows.scrape(url, { js_render: true })

    if (!result.success || !result.html) return {}

    // Parse Zillow neighborhood stats from HTML using string matching
    const html = result.html
    const stats: ScrapedMarketStats = {}

    // Look for median price patterns
    if (html.includes('Median listing price')) {
      const priceMatch = html.split('Median listing price')[1]?.split('$')[1]?.split('<')[0]
      if (priceMatch) {
        const cleaned = priceMatch.replace(/[^0-9]/g, '')
        stats.median_sale_price = parseInt(cleaned, 10) || 0
      }
    }

    // Look for DOM stats
    if (html.includes('days on Zillow') || html.includes('Median days on market')) {
      const domSection = html.split(/days on Zillow|Median days on market/)[0]
      const domMatch = domSection?.match(/(\d+)\s*$/)?.[1]
      if (domMatch) {
        stats.avg_days_on_market = parseInt(domMatch, 10) || 0
      }
    }

    return stats
  } catch (error) {
    console.error('[OSINT] Zillow scrape error:', error)
    return {}
  }
}

// ─── Data Refresh (4-tier waterfall) ─────────────────────────────────────────

export async function refreshMarketData(
  brokerageId: string,
  marketArea: string,
  zipCode?: string,
  city?: string,
  state?: string
): Promise<{ source: string; success: boolean }> {
  const supabase = createServiceClient()
  let stats: any = null
  let source = 'none'

  // TIER 1: RentCast (chosen property-data provider) — zip-level market stats.
  if (zipCode) {
    const rcStats = await getRentcastMarketStats({ brokerageId, zipCode })
    if (rcStats) {
      stats = {
        active_listings: rcStats.active_listings,
        new_listings_30d: rcStats.new_listings_30d,
        sold_listings_30d: 0, // RentCast /markets does not expose sold counts
        median_sale_price: rcStats.median_sale_price,
        avg_days_on_market: rcStats.avg_days_on_market,
        list_to_sale_ratio: 0,
        months_of_inventory: 0,
        price_trend_pct_1yr: rcStats.price_trend_yoy_pct,
      }
      source = 'rentcast'
    }
  }

  // TIER 2: OSINT/ZenRows (free scraping fallback)
  if (!stats && process.env.ZENROWS_API_KEY && city && state) {
    const osintStats = await scrapeZillowNeighborhoodData(city, state)
    if (Object.keys(osintStats).length > 0) {
      stats = {
        active_listings: 0,
        new_listings_30d: 0,
        sold_listings_30d: 0,
        median_sale_price: osintStats.median_sale_price || 0,
        avg_days_on_market: osintStats.avg_days_on_market || 0,
        list_to_sale_ratio: 0,
        months_of_inventory: 0,
        price_trend_pct_1yr: 0,
      }
      source = 'osint_scrape'
    }
  }

  // TIER 4: CMA Aggregate (always available)
  if (!stats) {
    const { data: cmaData } = await supabase
      .from('cma_reports')
      .select('market_analysis, estimated_value, created_at')
      .eq('brokerage_id', brokerageId)
      .ilike('property_address', `%${marketArea}%`)
      .gte('created_at', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString())
      .limit(50)

    if (cmaData && cmaData.length > 0) {
      const avgDom =
        cmaData.reduce((sum, r) => {
          const dom = r.market_analysis?.days_on_market
          return sum + (typeof dom === 'number' ? dom : 0)
        }, 0) / cmaData.length

      const avgPrice =
        cmaData.reduce((sum, r) => sum + (r.estimated_value || 0), 0) / cmaData.length

      const sold30d = cmaData.filter(
        (r) => new Date(r.created_at) > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      ).length

      stats = {
        active_listings: 0,
        new_listings_30d: 0,
        sold_listings_30d: sold30d,
        median_sale_price: Math.round(avgPrice),
        avg_days_on_market: Math.round(avgDom),
        list_to_sale_ratio: 0,
        months_of_inventory: 0,
        price_trend_pct_1yr: 0,
      }
      source = 'cma_aggregate'
    }
  }

  if (!stats) {
    return { source: 'none', success: false }
  }

  // Determine market type
  const monthsSupply = stats.months_of_inventory || 0
  const marketType: 'seller' | 'buyer' | 'balanced' =
    monthsSupply < 3 ? 'seller' : monthsSupply > 6 ? 'buyer' : 'balanced'

  const today = new Date().toISOString().split('T')[0]

  // UPSERT market_data
  const { error: mdError } = await supabase.from('market_data').upsert(
    {
      brokerage_id: brokerageId,
      market_area: marketArea,
      city: city || null,
      state: state || null,
      zip_code: zipCode || null,
      data_date: today,
      active_listings: stats.active_listings,
      new_listings_30d: stats.new_listings_30d,
      sold_listings_30d: stats.sold_listings_30d,
      median_sale_price: stats.median_sale_price,
      avg_days_on_market: stats.avg_days_on_market,
      list_to_sale_ratio: stats.list_to_sale_ratio,
      months_of_inventory: stats.months_of_inventory,
      market_type: marketType,
      price_trend_pct_30d: 0,
      price_trend_pct_1yr: stats.price_trend_pct_1yr,
      source_type: source,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'brokerage_id,market_area,data_date' }
  )

  if (mdError) {
    console.error('[MarketData] Upsert error:', mdError.message)
  }

  // UPSERT market_trends
  const snapshotMonth = new Date().toISOString().slice(0, 7) + '-01'
  const { error: mtError } = await supabase.from('market_trends').upsert(
    {
      brokerage_id: brokerageId,
      market_area: marketArea,
      zip_code: zipCode || null,
      snapshot_month: snapshotMonth,
      median_price: stats.median_sale_price,
      avg_dom: stats.avg_days_on_market,
      active_inventory: stats.active_listings,
      sale_price_pct_list: stats.list_to_sale_ratio,
    },
    { onConflict: 'brokerage_id,market_area,zip_code,snapshot_month' }
  )

  if (mtError) {
    console.error('[MarketTrends] Upsert error:', mtError.message)
  }

  // Emit kernel event
  await supabase.from('lifecycle_events').insert({
    brokerage_id: brokerageId,
    event_type: KernelEvent.MARKET_DATA_REFRESHED,
    entity_type: 'market_data',
    entity_id: marketArea,
    event_data: { source_tier: source, market_area: marketArea },
  })

  return { source, success: true }
}

// ─── Insight Generation ──────────────────────────────────────────────────────

export async function generateMarketInsight(
  req: MarketInsightRequest
): Promise<MarketInsightResult> {
  const supabase = createServiceClient()
  const today = new Date().toISOString().split('T')[0]

  // STEP 1: Check cache
  if (!req.forceRegenerate) {
    const { data: cached } = await supabase
      .from('market_insights')
      .select('id')
      .eq('brokerage_id', req.brokerageId)
      .eq('market_area', req.marketArea)
      .eq('insight_date', today)
      .single()

    if (cached) {
      return { insightId: cached.id, cached: true }
    }
  }

  // STEP 2: Fetch data sources in parallel
  const [marketDataResult, trendsResult, cmaResult] = await Promise.all([
    // Current market_data row
    supabase
      .from('market_data')
      .select('*')
      .eq('brokerage_id', req.brokerageId)
      .eq('market_area', req.marketArea)
      .order('data_date', { ascending: false })
      .limit(1)
      .single(),

    // Last 6 market_trends snapshots
    supabase
      .from('market_trends')
      .select('*')
      .eq('brokerage_id', req.brokerageId)
      .eq('market_area', req.marketArea)
      .order('snapshot_month', { ascending: false })
      .limit(6),

    // Recent CMA reports
    supabase
      .from('cma_reports')
      .select('city, estimated_value, created_at')
      .eq('brokerage_id', req.brokerageId)
      .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
      .limit(20),
  ])

  const marketData = marketDataResult.data as MarketDataRow | null
  const trends = (trendsResult.data || []) as MarketTrendRow[]
  const cmaReports = cmaResult.data || []

  // If no market data, refresh it first
  if (!marketData) {
    await refreshMarketData(req.brokerageId, req.marketArea, req.zipCode)
    // Re-fetch
    const { data: freshData } = await supabase
      .from('market_data')
      .select('*')
      .eq('brokerage_id', req.brokerageId)
      .eq('market_area', req.marketArea)
      .order('data_date', { ascending: false })
      .limit(1)
      .single()

    if (!freshData) {
      throw new Error('Unable to fetch market data for insight generation')
    }
  }

  const data = marketData || ({} as MarketDataRow)

  // STEP 3: Compute derived stats
  const currentPrice = data.median_sale_price || 0
  const currentDom = data.avg_days_on_market || 0

  let priceTrend: 'up' | 'flat' | 'down' = 'flat'
  let domTrend: 'decreasing' | 'stable' | 'increasing' = 'stable'

  if (trends.length >= 2) {
    const prev = trends[1]
    const priceDiff = ((currentPrice - prev.median_price) / prev.median_price) * 100
    const domDiff = currentDom - prev.avg_dom

    priceTrend = priceDiff > 2 ? 'up' : priceDiff < -2 ? 'down' : 'flat'
    domTrend = domDiff > 3 ? 'increasing' : domDiff < -3 ? 'decreasing' : 'stable'
  }

  const inventoryLevel: 'tight' | 'balanced' | 'oversupplied' =
    data.months_of_inventory < 3
      ? 'tight'
      : data.months_of_inventory > 6
        ? 'oversupplied'
        : 'balanced'

  // STEP 4: Generate AI insight
  const { object: insight } = await generateObject({
    model: resolveModel('anthropic/claude-sonnet-4-20250514'),
    schema: MarketInsightSchema,
    maxOutputTokens: 600,
    system:
      'You are a real estate market analyst. Generate a concise market insight report for an agent. Be specific and actionable.',
    prompt: `Generate a market insight for ${req.marketArea}.

Current Market Stats:
- Median Price: $${currentPrice.toLocaleString()}
- Avg Days on Market: ${currentDom}
- Months of Inventory: ${data.months_of_inventory || 'N/A'}
- List-to-Sale Ratio: ${data.list_to_sale_ratio ? (data.list_to_sale_ratio * 100).toFixed(1) + '%' : 'N/A'}
- Active Listings: ${data.active_listings || 'N/A'}
- Market Type: ${data.market_type || 'balanced'}
- Price Trend YoY: ${data.price_trend_pct_1yr ? data.price_trend_pct_1yr.toFixed(1) + '%' : 'N/A'}

6-Month Trend Data:
${trends.map((t) => `- ${t.snapshot_month}: $${t.median_price?.toLocaleString() || 'N/A'}, ${t.avg_dom || 'N/A'} DOM`).join('\n')}

Recent CMA Activity: ${cmaReports.length} reports in last 30 days
Avg CMA Value: $${cmaReports.length > 0 ? Math.round(cmaReports.reduce((s, r) => s + (r.estimated_value || 0), 0) / cmaReports.length).toLocaleString() : 'N/A'}`,
  })

  // STEP 5: Insert market_insights row
  const { data: inserted, error: insertError } = await supabase
    .from('market_insights')
    .insert({
      brokerage_id: req.brokerageId,
      agent_id: req.agentId || null,
      market_area: req.marketArea,
      zip_code: req.zipCode || null,
      insight_date: today,
      headline: insight.headline,
      summary: insight.summary,
      price_trend: insight.price_trend,
      dom_trend: insight.dom_trend,
      inventory_level: insight.inventory_level,
      seasonal_pattern: insight.seasonal_pattern,
      competition_alert: insight.competition_alert,
      buyer_indicators: insight.buyer_indicators,
      seller_indicators: insight.seller_indicators,
      key_stats: insight.key_stats,
      source_data: {
        market_data_id: data.id,
        trends_count: trends.length,
        cma_count: cmaReports.length,
      },
    })
    .select('id')
    .single()

  if (insertError) {
    console.error('[MarketInsight] Insert error:', insertError.message)
    throw new Error('Failed to save market insight')
  }

  // STEP 6: Emit kernel event
  await supabase.from('lifecycle_events').insert({
    brokerage_id: req.brokerageId,
    agent_id: req.agentId || null,
    event_type: KernelEvent.MARKET_INSIGHT_GENERATED,
    entity_type: 'market_insights',
    entity_id: inserted.id,
    event_data: { market_area: req.marketArea, headline: insight.headline },
  })

  return { insightId: inserted.id, cached: false }
}

// ─── Getters ─────────────────────────────────────────────────────────────────

export async function getLatestMarketInsight(
  brokerageId: string,
  marketArea: string
): Promise<any | null> {
  const supabase = createServiceClient()

  const { data } = await supabase
    .from('market_insights')
    .select('*')
    .eq('brokerage_id', brokerageId)
    .eq('market_area', marketArea)
    .order('insight_date', { ascending: false })
    .limit(1)
    .single()

  return data
}

export async function getMarketData(
  brokerageId: string,
  marketArea: string
): Promise<MarketDataRow | null> {
  const supabase = createServiceClient()

  const { data } = await supabase
    .from('market_data')
    .select('*')
    .eq('brokerage_id', brokerageId)
    .eq('market_area', marketArea)
    .order('data_date', { ascending: false })
    .limit(1)
    .single()

  return data as MarketDataRow | null
}

export async function getMarketTrends(
  brokerageId: string,
  marketArea: string,
  limit = 6
): Promise<MarketTrendRow[]> {
  const supabase = createServiceClient()

  const { data } = await supabase
    .from('market_trends')
    .select('*')
    .eq('brokerage_id', brokerageId)
    .eq('market_area', marketArea)
    .order('snapshot_month', { ascending: false })
    .limit(limit)

  return (data || []) as MarketTrendRow[]
}

export async function getMarketDataSources(brokerageId: string): Promise<any[]> {
  const supabase = createServiceClient()

  const { data } = await supabase
    .from('market_data_sources')
    .select('*')
    .eq('brokerage_id', brokerageId)
    .eq('is_active', true)
    .order('market_area', { ascending: true })

  return data || []
}
