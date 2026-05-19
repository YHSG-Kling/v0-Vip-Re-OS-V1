'use server'

import { createClient } from '@/lib/supabase/server'
import { scrapeFacebookGroupPosts, scrapeRedditPosts } from '@/lib/external'
import { trackVendorUsage } from '@/lib/vendor-tracking'
import { analyzeLead } from '@/lib/ai'
import { processRawRecord } from '@/lib/lead-pipeline'
import { getAgentContext } from '@/lib/identity/get-agent-context'

const FACEBOOK_GROUP_TEMPLATES = [
  '{city} Homeowners',
  '{city} Real Estate',
  '{city} Buy Sell Trade',
  '{city} Moms',
  '{city} Neighbors',
  'First Time Home Buyers {state}'
]

const REDDIT_SUBREDDITS_BASE = [
  'RealEstate',
  'FirstTimeHomeBuyer',
  'Mortgages',
  'personalfinance',
  'RealEstateAdvice'
]

const SEARCH_KEYWORDS = [
  'need to sell ASAP',
  'moving to',
  'relocating',
  'need a bigger home',
  'ready to buy',
  'looking for house',
  'selling',
  'need realtor',
  'must sell',
  'FSBO',
  'for sale by owner'
]

export async function scrapeSocialMedia(params: {
  /** ignored — derived from session */
  brokerageId?: string | undefined
  targetCity: string
  targetState: string
}) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: 'Unauthorized' }
  }

  const supabase = await createClient()

  // Admin-only: social-media scraping burns AI + scraper credits.
  const { data: u } = await supabase
    .from('users')
    .select('user_type')
    .eq('id', ctx.userId)
    .maybeSingle()
  const isAdmin = ['admin', 'broker', 'broker_owner', 'superadmin', 'super_admin'].includes(
    u?.user_type ?? ''
  )
  if (!isAdmin) return { success: false, error: 'Forbidden: admin only' }

  const brokerageId = ctx.brokerageId
  const { targetCity, targetState } = params

  const results = {
    facebookPosts: 0,
    redditPosts: 0,
    leadsCreated: 0,
    totalCost: 0,
    errors: [] as string[]
  }

  const facebookGroups = FACEBOOK_GROUP_TEMPLATES.map(template =>
    template.replace('{city}', targetCity).replace('{state}', targetState)
  )

  for (const groupName of facebookGroups) {
    try {
      const groupUrl = `https://www.facebook.com/groups/${groupName.toLowerCase().replace(/\s/g, '')}`

      const fbResult = await scrapeFacebookGroupPosts({
        groupUrl,
        keywords: SEARCH_KEYWORDS,
        limit: 100
      })

      results.totalCost += fbResult.cost
      results.facebookPosts += fbResult.posts.length

      for (const post of fbResult.posts) {
        const analysis = await analyzeLead({
          content: post.text || post.message || '',
          authorName: post.from?.name
        })

        if (analysis.confidence < 0.70) continue

        const { data: rawRecord } = await supabase
          .from('batchdata_motivated_sellers_raw')
          .insert({
            first_name: null,
            last_name: null,
            email: null,
            phone: null,
            residential_city: targetCity,
            residential_state: targetState,
            motivation_type: analysis.intent,
            motivation_confidence: Math.round(analysis.confidence * 100),
            raw_json: post,
            created_at: new Date().toISOString()
          })
          .select('id')
          .single()

        if (rawRecord?.id) {
          const pipelineResult = await processRawRecord(rawRecord.id, brokerageId)

          if (pipelineResult.action === 'created') {
            results.leadsCreated++
          }

          await trackVendorUsage({
            vendorName: 'apify',
            usageType: 'facebook_group_scrape',
            unitsUsed: 1,
            costPerUnit: fbResult.cost / fbResult.posts.length,
            totalCost: fbResult.cost / fbResult.posts.length,
            leadId: pipelineResult.leadId,
            brokerageId,
            requestMetadata: { groupName }
          })
        }
      }

    } catch (error) {
      console.error(`[v0] Failed to scrape Facebook group ${groupName}:`, error)
      results.errors.push(`Facebook-${groupName}: ${String(error)}`)
    }
  }

  const redditSubreddits = [
    targetCity.toLowerCase(),
    targetState.toLowerCase(),
    ...REDDIT_SUBREDDITS_BASE.map(s => s.toLowerCase())
  ]

  try {
    const redditResult = await scrapeRedditPosts({
      subreddits: redditSubreddits,
      keywords: SEARCH_KEYWORDS,
      limit: 100
    })

    results.totalCost += redditResult.cost
    results.redditPosts += redditResult.posts.length

    for (const post of redditResult.posts) {
      const analysis = await analyzeLead({
        content: `${post.title || ''}\n\n${post.selftext || ''}`,
        authorName: post.author
      })

      if (analysis.confidence < 0.70) continue

      const { data: rawRecord } = await supabase
        .from('batchdata_motivated_sellers_raw')
        .insert({
          first_name: null,
          last_name: null,
          email: null,
          phone: null,
          residential_city: post.subreddit === targetCity || post.subreddit === targetState ? targetCity : null,
          residential_state: targetState,
          motivation_type: analysis.intent,
          motivation_confidence: Math.round(analysis.confidence * 100),
          raw_json: post,
          created_at: new Date().toISOString()
        })
        .select('id')
        .single()

      if (rawRecord?.id) {
        const pipelineResult = await processRawRecord(rawRecord.id, brokerageId)

        if (pipelineResult.action === 'created') {
          results.leadsCreated++
        }

        await trackVendorUsage({
          vendorName: 'apify',
          usageType: 'reddit_scrape',
          unitsUsed: 1,
          costPerUnit: redditResult.cost / redditResult.posts.length,
          totalCost: redditResult.cost / redditResult.posts.length,
          leadId: pipelineResult.leadId,
          brokerageId,
          requestMetadata: { subreddit: post.subreddit }
        })
      }
    }

  } catch (error) {
    console.error('[v0] Failed to scrape Reddit:', error)
    results.errors.push(`Reddit: ${String(error)}`)
  }

  return {
    success: true,
    ...results
  }
}
