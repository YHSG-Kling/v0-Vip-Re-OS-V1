'use server'

import { createClient } from '@/lib/supabase/server'
import { scrapeFacebookGroupPosts, scrapeRedditPosts } from '@/lib/external'
import { meterVendorSpend } from '@/lib/vendor-governance/meter-vendor'
import { analyzeLead } from '@/lib/ai'
import { processRawRecord } from '@/lib/lead-pipeline'
import { ingestRawSourceBatch } from '@/lib/kernel/scraping'
import type { NormalizedScrapedRecord } from '@/lib/lead-pipeline/raw-record-types'
import { getAgentContext } from '@/lib/identity/get-agent-context'

// ─────────────────────────────────────────────────────────────────────────────
// THE SCRAPE'S COST GOES THROUGH THE ONE VENDOR GATEWAY — meterVendorSpend (lib/vendor-governance/meter-vendor.ts).
//
// TOMBSTONE (CLAUDE.md §1, wave 155): lib/vendor-tracking.ts `trackVendorUsage` is DELETED. It was a second writer of
// vendor_usage_tracking with a caller-typed price and none of the survivor's price state, cost basis, replay fingerprint or
// person attribution — and it booked a share ONLY for a post that was banked, so the rest of a billed run (every post under
// the 0.70 confidence floor) never reached the ledger. SURVIVOR: lib/vendor-governance/meter-vendor.ts meterVendorSpend.
// What the duplicate had that the survivor lacked was nothing: `usageType`, the lead and the metadata are all survivor
// fields. What changes here is the amount — the run's whole cost is booked: a share per banked post, and the remainder once.
// The actor's cost is the client's flat per-run figure (lib/external/apify-client.ts), so it is booked as an ESTIMATE of a
// variable price; the invoice reconciles. meterVendorSpend never throws and answers false when nothing was booked — a false
// here is reported in results.errors, never read as booked.
// ─────────────────────────────────────────────────────────────────────────────
async function bookScrapeShare(a: { usageType: string; share: number; brokerageId: string; leadId?: string | null; rawRecordId?: string | null; metadata: Record<string, unknown> }): Promise<boolean> {
  if (!(a.share > 0)) return false
  return meterVendorSpend({ vendorName: 'apify', usageType: a.usageType, cost: a.share, unitCount: 1, brokerageId: a.brokerageId, priceState: 'variable', costBasis: 'estimated', systemSource: 'lead_scraping', attribution: { leadId: a.leadId ?? null, rawRecordId: a.rawRecordId ?? null }, metadata: a.metadata })
}
/** The part of a billed run no banked post carried. True when there was nothing left to book, or it was booked. */
async function bookScrapeRemainder(a: { usageType: string; runCost: number; booked: number; brokerageId: string; metadata: Record<string, unknown> }): Promise<boolean> {
  const remainder = Math.round((a.runCost - a.booked) * 1e6) / 1e6
  if (!(remainder > 0)) return true
  return meterVendorSpend({ vendorName: 'apify', usageType: a.usageType, cost: remainder, unitCount: 1, brokerageId: a.brokerageId, priceState: 'variable', costBasis: 'estimated', systemSource: 'lead_scraping', metadata: { ...a.metadata, unattributed_remainder: true } })
}

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
  const isAdmin = ['admin', 'broker', 'broker_owner'].includes(
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

  /** Scraper invocations that actually left the building this run — the unit
   *  `billing_usage.scraper_calls` is denominated in. Counted at the call, not
   *  derived from post counts: a scrape that returns nothing still burns a
   *  credit, and a scrape that throws burned one before it threw. */
  let scraperCalls = 0

  const facebookGroups = FACEBOOK_GROUP_TEMPLATES.map(template =>
    template.replace('{city}', targetCity).replace('{state}', targetState)
  )

  for (const groupName of facebookGroups) {
    try {
      const groupUrl = `https://www.facebook.com/groups/${groupName.toLowerCase().replace(/\s/g, '')}`

      scraperCalls += 1
      const fbResult = await scrapeFacebookGroupPosts({
        groupUrl,
        keywords: SEARCH_KEYWORDS,
        limit: 100
      })

      results.totalCost += fbResult.cost
      results.facebookPosts += fbResult.posts.length
      // THE RUN IS BILLED WHETHER OR NOT A POST QUALIFIES. Each banked post books its share against the person it became
      // (cost-per-lead reads vendor_usage_tracking by lead_id); what is left — the posts that did not qualify — is booked
      // once after the loop, so the ledger sums to the run's cost. See bookScrapeRemainder below.
      const fbShare = fbResult.posts.length > 0 ? fbResult.cost / fbResult.posts.length : 0
      let fbBooked = 0

      for (const post of fbResult.posts) {
        const analysis = await analyzeLead({
          content: post.text || post.message || '',
          authorName: post.from?.name
        })

        if (analysis.confidence < 0.70) continue

        // TENANCY: brokerage_id is deliberately left NULL here. This is the
        // PLATFORM raw-lead pool, not tenant data — the owner's rule is that
        // raw leads are platform-viewable and feed deduping/enrichment, and a
        // tenant only ever sees its own leads. The tenant-scoped artifact is
        // produced below by processRawRecord(rawRecord.id, brokerageId), which
        // is what carries the brokerage. Every reader agrees: getMotivatedSellers
        // and getIntelligenceDashboardStats (app/actions/lead-intelligence.ts)
        // query this table unscoped on purpose while scoping their sibling
        // queries by brokerage, and the neighborhood report reads property
        // history across a whole zip. Stamping a tenant here would fragment the
        // dedup pool. Same call as platform_credentials in m273.
        const banked = await bankSocialPost(supabase, {
          channel: 'facebook_group',
          sourceRecordId: `fb-${post.id ?? post.post_id ?? post.url ?? `${groupName}-${String(post.text || post.message || '').slice(0, 60)}`}`,
          post,
          text: post.text || post.message || '',
          username: post.from?.name ?? null,
          city: targetCity,
          state: targetState,
          intent: analysis.intent,
          confidence: analysis.confidence,
          brokerageId,
        })
        if (banked.error) results.errors.push(`Facebook-${groupName}: ${banked.error}`)

        if (banked.rawLeadId) {
          const pipelineResult = await processRawRecord(banked.rawLeadId, brokerageId)

          if (pipelineResult.action === 'created') {
            results.leadsCreated++
          }

          if (await bookScrapeShare({ usageType: 'facebook_group_scrape', share: fbShare, brokerageId, leadId: pipelineResult.leadId, rawRecordId: banked.rawLeadId, metadata: { groupName } })) fbBooked += fbShare
          else if (fbShare > 0) results.errors.push(`Facebook-${groupName}: a post's share of the scrape cost was not booked`)
        }
      }
      if (!(await bookScrapeRemainder({ usageType: 'facebook_group_scrape', runCost: fbResult.cost, booked: fbBooked, brokerageId, metadata: { groupName, posts: fbResult.posts.length } }))) {
        results.errors.push(`Facebook-${groupName}: the unattributed part of the scrape cost was not booked`)
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
    scraperCalls += 1
    const redditResult = await scrapeRedditPosts({
      subreddits: redditSubreddits,
      keywords: SEARCH_KEYWORDS,
      limit: 100
    })

    results.totalCost += redditResult.cost
    results.redditPosts += redditResult.posts.length
    const redditShare = redditResult.posts.length > 0 ? redditResult.cost / redditResult.posts.length : 0
    let redditBooked = 0

    for (const post of redditResult.posts) {
      const analysis = await analyzeLead({
        content: `${post.title || ''}\n\n${post.selftext || ''}`,
        authorName: post.author
      })

      if (analysis.confidence < 0.70) continue

      // TENANCY: brokerage_id deliberately NULL — platform raw-lead pool, not
      // tenant data. See the matching note on the Facebook insert above; the
      // tenant-scoped artifact is created by processRawRecord(..., brokerageId).
      const banked = await bankSocialPost(supabase, {
        channel: 'reddit',
        sourceRecordId: `reddit-${post.id ?? post.url ?? `${post.subreddit}-${post.author}-${String(post.title || '').slice(0, 60)}`}`,
        post,
        text: `${post.title || ''}\n\n${post.selftext || ''}`,
        username: post.author ?? null,
        city: post.subreddit === targetCity || post.subreddit === targetState ? targetCity : null,
        state: targetState,
        intent: analysis.intent,
        confidence: analysis.confidence,
        brokerageId,
      })
      if (banked.error) results.errors.push(`Reddit: ${banked.error}`)

      if (banked.rawLeadId) {
        const pipelineResult = await processRawRecord(banked.rawLeadId, brokerageId)

        if (pipelineResult.action === 'created') {
          results.leadsCreated++
        }

        if (await bookScrapeShare({ usageType: 'reddit_scrape', share: redditShare, brokerageId, leadId: pipelineResult.leadId, rawRecordId: banked.rawLeadId, metadata: { subreddit: post.subreddit } })) redditBooked += redditShare
        else if (redditShare > 0) results.errors.push(`Reddit: a post's share of the scrape cost was not booked`)
      }
    }
    if (!(await bookScrapeRemainder({ usageType: 'reddit_scrape', runCost: redditResult.cost, booked: redditBooked, brokerageId, metadata: { posts: redditResult.posts.length } }))) {
      results.errors.push('Reddit: the unattributed part of the scrape cost was not booked')
    }

  } catch (error) {
    console.error('[v0] Failed to scrape Reddit:', error)
    results.errors.push(`Reddit: ${String(error)}`)
  }

  // THE BILLING METER — `billing_usage.scraper_calls`.
  //
  // Recorded HERE, server-side, and NOT from the client that invoked this
  // action. The client (app/dashboard/admin/lead-intake/social-scrape-trigger.tsx)
  // is the wrong place for three reasons: it cannot see how many scraper calls
  // were actually made (only how many posts came back), a tab closed mid-run
  // records nothing while the credits are already spent, and a client-callable
  // usage writer is a `"use server"` endpoint that lets any authenticated caller
  // move their own tenant's billing meter in either direction. This is the
  // authoritative point — it is where the credits are consumed.
  //
  // Until this call `billing_usage` HAD NO WRITER AT ALL, so the tenant usage
  // bars (app/settings/billing/usage-section.tsx) and the overage projection
  // (app/components/features/admin/overage-calculator.tsx) read zero for every
  // tenant on every day. `units` is a DELTA — this run's calls, not a total.
  if (scraperCalls > 0) {
    const { recordUsageEvent } = await import('@/lib/kernel/billing')
    const metered = await recordUsageEvent({
      brokerageId,
      metric: 'scraper_calls',
      units: scraperCalls,
      actorContext: { userId: ctx.userId },
    })
    if (!metered.success) {
      // Metering must not fail the scrape (the leads are already banked), but
      // the refusal is REPORTED rather than dropped — a meter that quietly
      // stops recording is exactly the defect this write exists to end.
      console.warn('[scrape-social-media] billing_usage scraper_calls not recorded:', metered.error)
      results.errors.push(`usage metering: ${metered.error ?? 'unknown error'}`)
    }
  }

  return {
    success: true,
    ...results
  }
}

/**
 * BANK ONE SOCIAL POST — both halves, READ (lane 88F, hidden wire).
 *
 * This action inserted each post into batchdata_motivated_sellers_raw (read by the
 * motivated-seller list and the neighborhood report — kept) and then handed THAT row's
 * id to processRawRecord, which reads raw_scraped_leads (pipeline-processor.ts STEP 3:
 * "Read from raw_scraped_leads (not batchdata_motivated_sellers_raw)"). The id could never
 * be found, so no post from this door ever became a lead — and the insert's own refusal
 * was dropped too (swallowed-refusal census). The raw record now enters through THE raw
 * writer (lib/kernel/scraping.ts::ingestRawSourceBatch — viability, territory, dedup,
 * source attribution) and it is THAT row the pipeline promotes.
 */
async function bankSocialPost(
  supabase: Awaited<ReturnType<typeof createClient>>,
  args: {
    channel: 'facebook_group' | 'reddit'
    sourceRecordId: string
    post: unknown
    text: string
    username: string | null
    city: string | null
    state: string
    intent: string
    confidence: number
    brokerageId: string
  },
): Promise<{ rawLeadId: string | null; error: string | null }> {
  // TENANCY: brokerage_id deliberately NULL on the motivated-seller pool row (see the
  // note at the Facebook call site below); the raw LEAD carries the brokerage because
  // this is an explicit brokerage-triggered scrape (ingestRawSourceBatch's own rule).
  const { error: poolErr } = await supabase
    .from('batchdata_motivated_sellers_raw')
    .insert({
      first_name: null,
      last_name: null,
      email: null,
      phone: null,
      residential_city: args.city,
      residential_state: args.state,
      motivation_type: args.intent,
      motivation_confidence: Math.round(args.confidence * 100),
      raw_json: args.post,
      created_at: new Date().toISOString()
    })
  if (poolErr) console.error(`[scrape-social-media] motivated-seller pool insert refused (${args.channel}):`, poolErr.message)

  const intent = args.intent.toLowerCase()
  const intentType: NormalizedScrapedRecord['intentType'] =
    /sell|fsbo|distress|motivated/.test(intent) ? 'seller'
    : /buy|relocat/.test(intent) ? 'buyer'
    : 'unknown'
  const record: NormalizedScrapedRecord = {
    sourceRecordId: args.sourceRecordId,
    source: args.channel,
    behaviorType: 'social_intent',
    intentType,
    intentSignals: intentType === 'seller' ? ['selling'] : intentType === 'buyer' ? ['looking_to_buy'] : [],
    username: args.username,
    city: args.city,
    state: args.state,
    motivationScore: Math.round(args.confidence * 100),
    rawPayload: { text: args.text.slice(0, 2000), analyzed_intent: args.intent },
  } as NormalizedScrapedRecord
  try {
    const batch = await ingestRawSourceBatch({
      brokerageId: args.brokerageId,
      marketId: null,
      source: 'social_intent',
      sourceFamily: 'social_intent',
      sourceChannel: args.channel,
      records: [record],
      executionId: null,
    })
    return { rawLeadId: batch.rawIds[0] ?? null, error: batch.skipped_refused > 0 ? 'raw_scraped_leads insert refused' : null }
  } catch (err) {
    return { rawLeadId: null, error: err instanceof Error ? err.message : String(err) }
  }
}
