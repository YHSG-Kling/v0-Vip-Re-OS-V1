import {
NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { ZenrowsClient, BatchDataClient } from "@/lib/external"
import { processRawRecord } from "@/lib/lead-pipeline"
import {
  buildPropertySearchUrl,
  parsePropertySearchResults,
  parseCraigslistHtml,
  normalizeBatchDataRecord,
} from "@/lib/lead-pipeline/scraper-parsers"
import { sourceRecruitProspects } from "@/lib/recruit-pipeline/recruit-sourcer"
import { processRawRecruit } from "@/lib/recruit-pipeline/recruit-processor"
import { createScrapingJob, updateScrapingJob } from "@/app/actions/lead-scraping-config"
import {
  type NormalizedScrapedRecord,
  isViableRecord,
  buildLeadIdentityKey,
} from "@/lib/lead-pipeline/raw-record-types"
import { verifyCronAuth } from "@/lib/cron-auth"
import * as cheerio from "cheerio"
import { buildTerritoryPhrases } from "@/lib/lead-pipeline/source-intent-map"
import { ingestRawSourceBatch } from "@/lib/kernel/scraping"
import { KernelEvent } from "@/lib/kernel/events"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"

export const dynamic = "force-dynamic"
export const maxDuration = 300

// Runs every 6 hours to scrape leads from all configured sources.
// Kernel OS: cron_execution_logs are opened at entry and closed at every exit path.
export async function GET(request: Request) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const serviceClient = createServiceClient()
  const cronStartedAt = Date.now()

  // Kernel OS: open cron context via canonical action
  const contextResult = await createCronRunContextAction({
    cron_name: "lead-scraping",
    cron_path: "/app/api/cron/lead-scraping/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  // cronLogId doubles as entity_id for lifecycle_events; use contextId as stable identifier
  const cronLogId: string = contextId

  await recordCronStartAction({ context_id: contextId })

  // Emit SCRAPING_CRON_STARTED lifecycle event
  void serviceClient.from("lifecycle_events").insert({
    entity_type:  "system",
    entity_id:    cronLogId ?? "00000000-0000-0000-0000-000000000000",
    event_type:   KernelEvent.SCRAPING_CRON_STARTED,
    brokerage_id: null,
    metadata:     { triggered_by: "cron", context_id: contextId },
    created_at:   new Date().toISOString(),
  })

  console.log("[Lead Scraping Cron] Starting scheduled scraping with full enrichment pipeline...")

  const supabase = await createClient()

  // ── Instantiate the scraper clients used below ────────────────────────────
  // Enrichment (PeopleData/OSINT/validation) runs inside processRawRecord during
  // the promotion pass — not here — so only the scrape clients are needed.
  const zenrows   = new ZenrowsClient()
  const batchdata = new BatchDataClient()

  const results = {
    markets_processed: 0,
    total_leads_found: 0,
    total_leads_created: 0,
    leads_promoted: 0,
    recruits_sourced: 0,
    recruits_promoted: 0,
    errors: [] as string[],
  }

  try {
    // STEP 2 — Load all active territories with their full config from DB only.
    // Zero hardcoded geography — city, state, brokerage_id all come from the record.
    const { data: markets } = await supabase
      .from("lead_scraping_markets")
      .select(`
        id, brokerage_id, team_id, agent_id, territory_scope, name, city, state,
        zip_codes, counties, enabled_sources, monthly_budget_usd, spend_this_month,
        max_records_per_run, priority, last_scraped_at,
        lead_scraping_property_params (id, is_active, target_sites, min_price, max_price),
        lead_scraping_motivated_params (id, is_active, signal_types, lookback_days,
          facebook_group_urls, reddit_subreddits)
      `)
      .eq("is_active", true)
      .order("priority", { ascending: false })

    if (!markets || markets.length === 0) {
      console.log("[Lead Scraping Cron] No active markets configured")
      return NextResponse.json({ message: "No active markets configured", results })
    }

    // Get active keywords
    const { data: keywords } = await supabase.from("lead_scraping_keywords").select("*").eq("is_active", true)

    for (const market of markets) {
      results.markets_processed++
      console.log(`[Lead Scraping Cron] Processing market: ${market.name} (${market.city}, ${market.state})`)

      // STEP 3 — Budget gate: skip this territory if monthly budget is exhausted.
      if ((market.spend_this_month ?? 0) >= (market.monthly_budget_usd ?? 100)) {
        const reason = `Skipped ${market.name}: monthly budget reached ($${market.spend_this_month ?? 0} / $${market.monthly_budget_usd ?? 100})`
        console.warn(`[Lead Scraping Cron] ${reason}`)
        results.errors.push(reason)
        continue
      }

      // STEP 4 — Resolve the set of enabled sources for this territory.
      const enabledSources = new Set<string>(market.enabled_sources ?? ["batchdata_motivated"])

      // Track spend accumulated across all sources in this territory run.
      let territorySpendUsd = 0

      // ============================================
      // 1. SCRAPE PROPERTY SEARCH SITES (ZenRows - find buyers)
      // ============================================
      // STEP 4 gate
      if (enabledSources.has("zillow_behavior") && market.lead_scraping_property_params?.length > 0) {
        const propertyParams = market.lead_scraping_property_params[0]
        if (propertyParams.is_active) {
          // STEP 5 — open scraper_executions record
          const { data: execRecord } = await supabase
            .from("scraper_executions")
            .insert({
              brokerage_id: market.brokerage_id,
              scraper_type: "zillow_behavior",
              status: "running",
              started_at: new Date().toISOString(),
            })
            .select("id")
            .single()

          const job = await createScrapingJob({
            job_type: "property_search",
            market_id: market.id,
            source: "zenrows_property",
          })

          let sourceItemsFound = 0
          let sourceLeadsCreated = 0
          let sourceErr: Error | null = null
          let sourceCostUsd = 0

          try {
            await updateScrapingJob(job.job?.id, {
              status: "running",
              started_at: new Date().toISOString(),
            })

            for (const site of propertyParams.target_sites || ["zillow", "realtor", "redfin"]) {
              const searchUrl = buildPropertySearchUrl(site, market, propertyParams)
              const scraped = await zenrows.scrape(searchUrl, { js_render: true, premium_proxy: true })
              sourceCostUsd += scraped.cost ?? 0

              if (scraped.success && scraped.html) {
                // parsePropertySearchResults returns NormalizedScrapedRecord[] filtered by isViableRecord
                const buyers = parsePropertySearchResults(scraped.html, site, market)
                sourceItemsFound += buyers.length

                for (const buyer of buyers) {
                  // Write raw record only — enrichment and promotion happen in pipeline-processor
                  const { inserted } = await insertRawRecord({
                    supabase,
                    record:      buyer,
                    brokerageId: market.brokerage_id,
                    marketId:    market.id,
                    executionId: execRecord?.id ?? null,
                  })
                  if (inserted) { sourceLeadsCreated++; results.total_leads_created++ }
                }
                results.total_leads_found += buyers.length
              }
            }

            await updateScrapingJob(job.job?.id, {
              status: "completed",
              leads_found: sourceItemsFound,
              leads_created: sourceLeadsCreated,
              completed_at: new Date().toISOString(),
            })
          } catch (error) {
            sourceErr = error as Error
            await updateScrapingJob(job.job?.id, {
              status: "failed",
              error_message: String(error),
              completed_at: new Date().toISOString(),
            })
            results.errors.push(`Property search error for ${market.name}: ${error}`)
          }

          // STEP 5 — close scraper_executions record
          await supabase.from("scraper_executions").update({
            status: sourceErr ? "failed" : "completed",
            completed_at: new Date().toISOString(),
            total_items_found: sourceItemsFound,
            leads_created: sourceLeadsCreated,
            api_cost: sourceCostUsd,
            error_message: sourceErr?.message ?? null,
          }).eq("id", execRecord?.id)

          territorySpendUsd += sourceCostUsd
        }
      }

      // ============================================
      // 2. SCRAPE MOTIVATED SELLERS (BatchData)
      // ============================================
      // STEP 4 gate
      if (enabledSources.has("batchdata_motivated") && market.lead_scraping_motivated_params?.length > 0) {
        const motivatedParams = market.lead_scraping_motivated_params[0]
        if (motivatedParams.is_active) {
          // STEP 5 — open scraper_executions record
          const { data: execRecord } = await supabase
            .from("scraper_executions")
            .insert({
              brokerage_id: market.brokerage_id,
              scraper_type: "batchdata_motivated",
              status: "running",
              started_at: new Date().toISOString(),
            })
            .select("id")
            .single()

          const job = await createScrapingJob({
            job_type: "motivated_sellers",
            market_id: market.id,
            source: "batchdata",
          })

          let sourceItemsFound = 0
          let leadsCreated = 0
          let sourceErr: Error | null = null

          try {
            await updateScrapingJob(job.job?.id, {
              status: "running",
              started_at: new Date().toISOString(),
            })

            // STEP 7 — geography comes entirely from market record, never hardcoded
            const location = `${market.city}, ${market.state}`
            const rawSellers = await batchdata.getMotivatedSellerData(location)
            // Normalize to canonical shape and filter by viability gate
            const sellers = rawSellers
              .map((r) => normalizeBatchDataRecord(r as Record<string, unknown>, market))
              .filter(isViableRecord)
            sourceItemsFound = rawSellers.length

            for (const seller of sellers) {
              const matchesType = motivatedParams.signal_types?.some((type: string) =>
                seller.intentSignals?.includes(type),
              )

              if (matchesType || !motivatedParams.signal_types?.length) {
                // Write raw record only — enrichment and promotion run in pipeline-processor
                const { inserted } = await insertRawRecord({
                  supabase,
                  record:      seller,
                  brokerageId: market.brokerage_id,
                  marketId:    market.id,
                  executionId: execRecord?.id ?? null,
                })
                if (inserted) leadsCreated++
              }
            }

            results.total_leads_found += sourceItemsFound
            results.total_leads_created += leadsCreated

            await updateScrapingJob(job.job?.id, {
              status: "completed",
              leads_found: sourceItemsFound,
              leads_created: leadsCreated,
              completed_at: new Date().toISOString(),
            })
          } catch (error) {
            sourceErr = error as Error
            await updateScrapingJob(job.job?.id, {
              status: "failed",
              error_message: String(error),
              completed_at: new Date().toISOString(),
            })
            results.errors.push(`BatchData error for ${market.name}: ${error}`)
          }

          // STEP 5 — close scraper_executions record
          await supabase.from("scraper_executions").update({
            status: sourceErr ? "failed" : "completed",
            completed_at: new Date().toISOString(),
            total_items_found: sourceItemsFound,
            leads_created: leadsCreated,
            api_cost: 0, // BatchData cost tracked separately via vendor_usage_tracking
            error_message: sourceErr?.message ?? null,
          }).eq("id", execRecord?.id)
        }
      }

      // ============================================
      // 3. SCRAPE SOCIAL PLATFORMS (ZenRows + Keywords)
      // ============================================
      const socialSourcesEnabled =
        enabledSources.has("nextdoor") ||
        enabledSources.has("facebook") ||
        enabledSources.has("reddit") ||
        enabledSources.has("craigslist")

      if (socialSourcesEnabled && keywords && keywords.length > 0) {
        // STEP 5 — open scraper_executions record
        const { data: execRecord } = await supabase
          .from("scraper_executions")
          .insert({
            brokerage_id: market.brokerage_id,
            scraper_type: "social_intent",
            status: "running",
            started_at: new Date().toISOString(),
          })
            .select("id")
            .maybeSingle()

        const job = await createScrapingJob({
          job_type: "social_scrape",
          market_id: market.id,
          source: "social_platforms",
        })

        let socialLeadsCreated = 0
        let sourceCostUsd = 0
        let sourceErr: Error | null = null

        try {
          await updateScrapingJob(job.job?.id, {
            status: "running",
            started_at: new Date().toISOString(),
          })

          // Group keywords by source
          const keywordsBySource: Record<string, string[]> = {}
          for (const kw of keywords) {
            for (const source of kw.sources || []) {
              if (!keywordsBySource[source]) keywordsBySource[source] = []
              keywordsBySource[source].push(kw.keyword)
            }
          }

          // motivatedParams carries facebook_group_urls and reddit_subreddits from DB
          const motivatedParams = market.lead_scraping_motivated_params?.[0]

          // STEP 4 gate + STEP 7 geography from market record
          if (enabledSources.has("nextdoor") && keywordsBySource["nextdoor"]) {
            const nextdoorUrl = `https://nextdoor.com/search/?query=${encodeURIComponent(
              keywordsBySource["nextdoor"].slice(0, 3).join(" OR "),
            )}&location=${encodeURIComponent(`${market.city}, ${market.state}`)}`

            const scraped = await zenrows.scrapeNextdoor(nextdoorUrl)
            sourceCostUsd += scraped.cost ?? 0
            if (scraped.success && scraped.posts) {
              for (const post of scraped.posts) {
                const matchedKeyword = keywords.find(
                  (kw) =>
                    kw.sources?.includes("nextdoor") && post.content?.toLowerCase().includes(kw.keyword.toLowerCase()),
                )
                if (matchedKeyword && matchedKeyword.weight >= 3) {
                  const nameParts = ((post as any).author_name ?? "").split(" ")
                  const ndRecord: NormalizedScrapedRecord = {
                    sourceRecordId:  `nextdoor-${(post as any).post_id ?? `${Date.now()}-${Math.random()}`}`,
                    source:          "nextdoor",
                    behaviorType:    "social_intent",
                    intentType:      matchedKeyword.category === "buying_intent" ? "buyer" : "seller",
                    intentSignals:   [matchedKeyword.keyword],
                    firstName:       nameParts[0] || null,
                    lastName:        nameParts.slice(1).join(" ") || null,
                    city:            market.city,
                    state:           market.state,
                    motivationScore: matchedKeyword.weight * 20,
                    sourceUrl:       nextdoorUrl,
                    rawPayload:      { post, matched_keyword: matchedKeyword.keyword },
                  }
                  const { inserted } = await insertRawRecord({
                    supabase,
                    record:      ndRecord,
                    brokerageId: market.brokerage_id,
                    marketId:    market.id,
                    executionId: execRecord?.id ?? null,
                  })
                  if (inserted) socialLeadsCreated++
                }
              }
            }
          }

          // STEP 4 gate
          if (enabledSources.has("facebook") && keywordsBySource["facebook"]) {
            const groupUrls: string[] = motivatedParams?.facebook_group_urls?.length
              ? motivatedParams.facebook_group_urls
              : [`https://www.facebook.com/groups/${market.city.toLowerCase().replace(/\s+/g, "")}realestate`]

            const fbResult = await zenrows.scrapeFacebookGroups({ groupUrls, keywords: keywordsBySource["facebook"] })
              .catch(() => ({ success: false, posts: [], cost: 0 }))
            sourceCostUsd += (fbResult as any).cost ?? 0

            for (const post of fbResult.posts) {
              const matched = keywords.find(
                (kw) =>
                  kw.sources?.includes("facebook") &&
                  post.content?.toLowerCase().includes(kw.keyword.toLowerCase()),
              )
              if (matched && (matched.weight ?? 1) >= 3) {
                const fbRecord: NormalizedScrapedRecord = {
                  sourceRecordId:  `fb-${post.post_id ?? `${Date.now()}-${Math.random()}`}`,
                  source:          "facebook_group",
                  behaviorType:    "social_intent",
                  intentType:      "seller",
                  intentSignals:   [matched.keyword],
                  city:            market.city,
                  state:           market.state,
                  motivationScore: (matched.weight ?? 1) * 15,
                  rawPayload:      { post, matched_keyword: matched.keyword },
                }
                const { inserted } = await insertRawRecord({
                  supabase,
                  record:      fbRecord,
                  brokerageId: market.brokerage_id,
                  marketId:    market.id,
                  executionId: execRecord?.id ?? null,
                })
                if (inserted) socialLeadsCreated++
              }
            }
          }

          // STEP 4 gate
          if (enabledSources.has("reddit") && keywordsBySource["reddit"]) {
            const { scrapeRedditPosts } = await import("@/lib/external/apify-client")
            const subreddits: string[] = motivatedParams?.reddit_subreddits?.length
              ? motivatedParams.reddit_subreddits
              : [
                  `${market.city.toLowerCase().replace(/\s+/g, "")}realestate`,
                  "FirstTimeHomeBuyer",
                  "moving",
                ]

            const redditResult = await scrapeRedditPosts({
              subreddits,
              keywords: keywordsBySource["reddit"],
              limit: 50,
            }).catch(() => ({ posts: [], cost: 0 }))

            for (const post of redditResult.posts) {
              const matched = keywords.find(
                (kw) =>
                  kw.sources?.includes("reddit") &&
                  `${post.title ?? ""} ${post.body ?? ""}`.toLowerCase().includes(kw.keyword.toLowerCase()),
              )
              if (matched && (matched.weight ?? 1) >= 2) {
                const redditRecord: NormalizedScrapedRecord = {
                  sourceRecordId:  `reddit-${post.post_id ?? post.url ?? `${Date.now()}-${Math.random()}`}`,
                  source:          "reddit_intent",
                  behaviorType:    "social_intent",
                  intentType:      "buyer",
                  intentSignals:   [matched.keyword],
                  city:            market.city,
                  state:           market.state,
                  motivationScore: (matched.weight ?? 1) * 15,
                  sourceUrl:       post.url ?? null,
                  rawPayload:      { post, matched_keyword: matched.keyword },
                }
                const { inserted } = await insertRawRecord({
                  supabase,
                  record:      redditRecord,
                  brokerageId: market.brokerage_id,
                  marketId:    market.id,
                  executionId: execRecord?.id ?? null,
                })
                if (inserted) socialLeadsCreated++
              }
            }
          }

          // STEP 4 gate
          if (enabledSources.has("craigslist") && keywordsBySource["craigslist"]) {
            // STEP 7 — city from market record
            const craigslistUrl = `https://${market.city.toLowerCase().replace(/ /g, "")}.craigslist.org/search/rea?query=${encodeURIComponent(
              keywordsBySource["craigslist"].slice(0, 3).join(" "),
            )}`
            const scraped = await zenrows.scrape(craigslistUrl, { js_render: false })
            sourceCostUsd += scraped.cost ?? 0

            if (scraped.success && scraped.html) {
              // parseCraigslistHtml returns NormalizedScrapedRecord[] filtered by isViableRecord
              const listings = parseCraigslistHtml(scraped.html)
              for (const listing of listings) {
                // listing already has city/state from market; ensure they're set
                listing.city  = listing.city  ?? market.city
                listing.state = listing.state ?? market.state
                const { inserted } = await insertRawRecord({
                  supabase,
                  record:      listing,
                  brokerageId: market.brokerage_id,
                  marketId:    market.id,
                  executionId: execRecord?.id ?? null,
                })
                if (inserted) socialLeadsCreated++
              }
            }
          }

          // STEP 4 gate — G-5: Google phrase intent
          // buildTerritoryPhrases() derives buyer+seller search queries from city, state, zip_codes, counties.
          if (enabledSources.has("google_phrase_intent")) {
            const { buyerPhrases, sellerPhrases } = buildTerritoryPhrases({
              city:      market.city,
              state:     market.state,
              zip_codes: market.zip_codes,
              counties:  market.counties,
            })

            // Sample 3 seller phrases and 2 buyer phrases per run to stay within cost envelope
            const phrases = [
              ...sellerPhrases.slice(0, 3).map(p => ({ phrase: p, intentType: 'seller' as const })),
              ...buyerPhrases.slice(0, 2).map(p => ({ phrase: p, intentType: 'buyer' as const })),
            ]

            for (const { phrase, intentType } of phrases) {
              const result = await zenrows.googleSearch(phrase, { num: 5 }).catch(() => null)
              sourceCostUsd += 0.002 // Google SERP costs ~$0.002/call via ZenRows

              if (!result) continue

              // Parse organic result snippets from raw HTML
              const $g = cheerio.load(result)
              $g('.g, [data-sokoban-container]').each((_, el) => {
                const title   = $g(el).find('h3').first().text().trim()
                const snippet = $g(el).find('.VwiC3b, span.st, .IsZvec').first().text().trim()
                const link    = $g(el).find('a').first().attr('href') ?? null

                if (!title || title.length < 5) return

                const gRecord: NormalizedScrapedRecord = {
                  sourceRecordId:  `google-${Buffer.from(`${phrase}|${link ?? title}`).toString('base64').slice(0, 32)}`,
                  source:          'google_phrase_intent',
                  behaviorType:    'search_signal',
                  intentType,
                  intentSignals:   [phrase],
                  city:            market.city,
                  state:           market.state,
                  motivationScore: intentType === 'seller' ? 42 : 38,
                  sourceUrl:       link,
                  rawPayload:      { phrase, title, snippet, link, market_id: market.id },
                }

                // Fire and forget — analytics_only identity policy means no enrichment spend
                insertRawRecord({
                  supabase,
                  record:      gRecord,
                  brokerageId: market.brokerage_id,
                  marketId:    market.id,
                  executionId: execRecord?.id ?? null,
                }).then(({ inserted }) => { if (inserted) socialLeadsCreated++ }).catch(() => {})
              })
            }
          }

          results.total_leads_created += socialLeadsCreated

          await updateScrapingJob(job.job?.id, {
            status: "completed",
            leads_created: socialLeadsCreated,
            completed_at: new Date().toISOString(),
          })
        } catch (error) {
          sourceErr = error as Error
          await updateScrapingJob(job.job?.id, {
            status: "failed",
            error_message: String(error),
            completed_at: new Date().toISOString(),
          })
          results.errors.push(`Social scrape error for ${market.name}: ${error}`)
        }

        // STEP 5 — close scraper_executions record
        await supabase.from("scraper_executions").update({
          status: sourceErr ? "failed" : "completed",
          completed_at: new Date().toISOString(),
          total_items_found: socialLeadsCreated,
          leads_created: socialLeadsCreated,
          api_cost: sourceCostUsd,
          error_message: sourceErr?.message ?? null,
        }).eq("id", execRecord?.id).then(() => {}, () => {})

        territorySpendUsd += sourceCostUsd
      }

      // ── RECRUITING SOURCE — agents/teams looking to switch brokerages ───────
      // Platform-owned raw_recruit_prospects (brokerage_id NULL, market_id set);
      // promoted to brokerage-owned `recruits` in the recruit promotion pass.
      if (enabledSources.has("recruiting_intent")) {
        try {
          const reviewUrls = (market.lead_scraping_motivated_params?.[0] as { brokerage_review_urls?: string[] } | undefined)
            ?.brokerage_review_urls ?? []
          const recruitRes = await sourceRecruitProspects({
            supabase,
            marketId: market.id,
            state: market.state,
            reviewUrls,
          })
          results.recruits_sourced += recruitRes.inserted
          if (recruitRes.errors.length) results.errors.push(...recruitRes.errors)
        } catch (err) {
          results.errors.push(`Recruit sourcing error for ${market.name}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      // STEP 6 — Update territory spend and last_scraped_at after all sources run.
      await supabase
        .from("lead_scraping_markets")
        .update({
          spend_this_month: (market.spend_this_month ?? 0) + territorySpendUsd,
          last_scraped_at: new Date().toISOString(),
        })
        .eq("id", market.id)
        .then(() => {}, () => {})
    }

    // ── PROMOTION PASS — run scraped raw records through the pipeline ──────────
    // Scraping above only writes raw_scraped_leads (pending). Promote them to
    // leads here so the scrape → lead → AI-ISA flow completes in the same
    // scheduled run. Bounded per run; records that fail a gate stay 'pending'
    // (the pipeline is retry-safe) and are picked up on the next run.
    const { data: pendingRaws } = await supabase
      .from("raw_scraped_leads")
      .select("id")
      .eq("processing_status", "pending")
      .order("created_at", { ascending: true })
      .limit(100)

    for (const raw of pendingRaws ?? []) {
      try {
        // brokerage_id is NULL on platform-scraped raw records; processRawRecord
        // resolves the owning brokerage from the record's market_id territory.
        const promo = await processRawRecord(raw.id)
        if (promo.action === "created") results.leads_promoted++
      } catch (err) {
        results.errors.push(`Promotion error for ${raw.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // ── RECRUIT PROMOTION PASS — promote pending raw recruiting prospects ─────
    // Mirrors the lead promotion pass: brokerage_id is NULL on platform-sourced
    // raw_recruit_prospects; processRawRecruit resolves the owning brokerage from
    // the record's market_id territory and promotes into `recruits`.
    const { data: pendingRecruits } = await supabase
      .from("raw_recruit_prospects")
      .select("id")
      .eq("processing_status", "pending")
      .order("created_at", { ascending: true })
      .limit(100)

    for (const raw of pendingRecruits ?? []) {
      try {
        const promo = await processRawRecruit(raw.id)
        if (promo.action === "created") results.recruits_promoted++
      } catch (err) {
        results.errors.push(`Recruit promotion error for ${raw.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    const durationMs = Date.now() - cronStartedAt
    console.log("[Lead Scraping Cron] Completed:", results)

    // Close cron context — success
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: results.total_leads_created,
      output_count: results.total_leads_created,
      metadata: { ...results, duration_ms: durationMs },
    })

    await serviceClient.from("lifecycle_events").insert({
      entity_type:  "system",
      entity_id:    cronLogId ?? "00000000-0000-0000-0000-000000000000",
      event_type:   KernelEvent.SCRAPING_CRON_COMPLETED,
      brokerage_id: null,
      metadata:     { ...results, duration_ms: durationMs, context_id: contextId },
      created_at:   new Date().toISOString(),
    }).then(() => {}, () => {})

    return NextResponse.json({ message: "Lead scraping completed", results })
  } catch (error) {
    const durationMs = Date.now() - cronStartedAt
    console.error("[Lead Scraping Cron] Fatal error:", error)

    // Close cron context — failure
    await recordCronFailureAction({ context_id: contextId, error: error as Error | string, stage: "main-processing" })

    await serviceClient.from("lifecycle_events").insert({
      entity_type:  "system",
      entity_id:    cronLogId ?? "00000000-0000-0000-0000-000000000000",
      event_type:   KernelEvent.SCRAPING_CRON_FAILED,
      brokerage_id: null,
      metadata:     { error: String(error), duration_ms: durationMs, context_id: contextId },
      created_at:   new Date().toISOString(),
    }).then(() => {}, () => {})

    return NextResponse.json({ error: String(error), results, context_id: contextId }, { status: 500 })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// insertRawRecord — Kernel OS canonical raw-record writer
// ALL scraping paths funnel through this. Zero createLead() calls in this file.
// ─────────────────────────────────────────────────────────────────────────────
interface InsertRawRecordParams {
  supabase: Awaited<ReturnType<typeof import('@/lib/supabase/server').createClient>>
  record: NormalizedScrapedRecord
  brokerageId: string
  marketId: string
  executionId?: string | null
}

async function insertRawRecord(params: InsertRawRecordParams): Promise<{ inserted: boolean; rawId?: string }> {
  if (!isViableRecord(params.record)) return { inserted: false }

  const identityKey = buildLeadIdentityKey(params.record)

  const { data, error } = await params.supabase
    .from('raw_scraped_leads')
    .insert({
      // Platform-owned until promotion: leave brokerage_id NULL. The owning
      // brokerage is resolved from market_id (the active-subscriber territory
      // this record was scraped for) when it passes the promotion gate.
      brokerage_id:         null,
      market_id:            params.marketId,
      source:               params.record.source,
      source_record_id:     params.record.sourceRecordId,
      raw_data:             params.record.rawPayload ?? null,
      normalized_preview: {
        firstName:       params.record.firstName    ?? null,
        lastName:        params.record.lastName     ?? null,
        email:           params.record.email        ?? null,
        phone:           params.record.phone        ?? null,
        city:            params.record.city         ?? null,
        state:           params.record.state        ?? null,
        intentType:      params.record.intentType,
        behaviorType:    params.record.behaviorType,
        motivationScore: params.record.motivationScore ?? null,
        intentSignals:   params.record.intentSignals   ?? [],
        propertyAddress: params.record.propertyAddress ?? null,
        sourceUrl:       params.record.sourceUrl       ?? null,
        leadIdentityKey: identityKey,
      },
      processing_status:    'pending',
      scraper_execution_id: params.executionId ?? null,
    })
    .select('id')
    .single()

  // 23505 = unique_violation — duplicate from same source, skip silently
  if (error?.code === '23505') return { inserted: false }
  if (error) {
    console.error('[Scraping] raw_scraped_leads insert failed:', error.message)
    return { inserted: false }
  }
  return { inserted: true, rawId: data?.id }
}
