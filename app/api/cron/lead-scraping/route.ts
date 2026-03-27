import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { ZenrowsClient, BatchDataClient, PeopleDataClient, ApifyClient } from "@/lib/external"
import { processRawRecord } from "@/lib/lead-pipeline"
import { createScrapingJob, updateScrapingJob } from "@/app/actions/lead-scraping-config"
import {
  type NormalizedScrapedRecord,
  isViableRecord,
  buildLeadIdentityKey,
} from "@/lib/lead-pipeline/raw-record-types"
import * as cheerio from "cheerio"

export const dynamic = "force-dynamic"

// Runs every 6 hours to scrape leads from all configured sources
export async function GET(request: Request) {
  // Verify cron secret
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  console.log("[Lead Scraping Cron] Starting scheduled scraping with full enrichment pipeline...")

  const supabase = await createClient()

  // ── Instantiate all provider clients BEFORE the try block ─────────────────
  const zenrows   = new ZenrowsClient()
  const batchdata = new BatchDataClient()
  const peopledata = new PeopleDataClient()
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const apify     = new ApifyClient()

  const validation = {
    validateContact: async (params: { email?: string | null; phone?: string | null }) => {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      const phoneRegex = /^\+?[\d\s\-()\\.]{10,15}$/
      const emailValid  = params.email ? emailRegex.test(params.email) : false
      const phoneValid  = params.phone ? phoneRegex.test(params.phone) : false
      return {
        overall_valid:  emailValid || phoneValid,
        email_valid:    emailValid,
        email_status:   emailValid ? 'valid_format' : 'invalid_format',
        phone_valid:    phoneValid,
        phone_formatted: params.phone?.replace(/\D/g, '').slice(-10) ?? null,
        phone_type:     phoneValid ? 'unknown' : null,
      }
    },
  }

  const osint = {
    searchPerson: async (params: { name?: string; firstName?: string; lastName?: string; city?: string; state?: string; email?: string; phone?: string }) => {
      const { skipTraceWithPeopleData } = await import('@/lib/external/peopledata-client')
      const fullName = params.name ?? `${params.firstName ?? ''} ${params.lastName ?? ''}`.trim()
      return skipTraceWithPeopleData({ name: fullName }).then(r => r.data).catch(() => null)
    },
  }

  const results = {
    markets_processed: 0,
    total_leads_found: 0,
    total_leads_created: 0,
    leads_validated: 0,
    leads_enriched: 0,
    osint_searches: 0,
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
          }).eq("id", execRecord?.id).catch(() => {})

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
          }).eq("id", execRecord?.id).catch(() => {})
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
          .single()

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
                  const nameParts = (post.author_name ?? "").split(" ")
                  const ndRecord: NormalizedScrapedRecord = {
                    sourceRecordId:  `nextdoor-${post.post_id ?? `${Date.now()}-${Math.random()}`}`,
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
        }).eq("id", execRecord?.id).catch(() => {})

        territorySpendUsd += sourceCostUsd
      }

      // STEP 6 — Update territory spend and last_scraped_at after all sources run.
      await supabase
        .from("lead_scraping_markets")
        .update({
          spend_this_month: (market.spend_this_month ?? 0) + territorySpendUsd,
          last_scraped_at: new Date().toISOString(),
        })
        .eq("id", market.id)
        .catch(() => {})
    }

    console.log("[Lead Scraping Cron] Completed:", results)
    return NextResponse.json({ message: "Lead scraping completed", results })
  } catch (error) {
    console.error("[Lead Scraping Cron] Fatal error:", error)
    return NextResponse.json({ error: String(error), results }, { status: 500 })
  }
}

// ============================================
// ENRICHMENT PIPELINE
// Runs OSINT, PeopleData enrichment, and contact validation for each lead
// ============================================
async function enrichLeadPipeline(
  leadData: {
    first_name?: string
    last_name?: string
    email?: string
    phone?: string
    address?: string
    city?: string
    state?: string
  },
  clients: {
    peopledata: PeopleDataClient
    osint: { searchPerson: (params: Record<string, string | undefined>) => Promise<any> }
    validation: { validateContact: (params: { email?: string | null; phone?: string | null }) => Promise<any> }
  },
  results: { leads_validated: number; leads_enriched: number; osint_searches: number },
): Promise<any | null> {
  const enrichedLead = { ...leadData }

  // Step 1: Validate email and phone
  if (leadData.email || leadData.phone) {
    const validationResult = await clients.validation.validateContact({
      email: leadData.email,
      phone: leadData.phone,
    })
    results.leads_validated++

    // Skip if no valid contact method
    if (!validationResult.overall_valid) {
      console.log(`[Enrichment] Skipping lead - no valid contact: ${leadData.first_name} ${leadData.last_name}`)
      return null
    }

    // Use validated/formatted phone
    if (validationResult.phone_valid) {
      enrichedLead.phone = validationResult.phone_formatted
    }
    // Store validation metadata
    ;(enrichedLead as any).validation_data = {
      email_valid: validationResult.email_valid,
      email_status: validationResult.email_status,
      phone_valid: validationResult.phone_valid,
      phone_type: validationResult.phone_type,
    }
  }

  // Step 2: Run OSINT search
  if (leadData.first_name && leadData.last_name) {
    try {
      const osintResult = await clients.osint.searchPerson({
        firstName: leadData.first_name,
        lastName: leadData.last_name,
        city: leadData.city,
        state: leadData.state,
        email: leadData.email,
        phone: leadData.phone,
      })
      results.osint_searches++
      ;(enrichedLead as any).osint_data = {
        social_profiles: osintResult.social_profiles,
        public_records: osintResult.public_records,
        court_records: osintResult.court_records,
        property_records: osintResult.property_records,
        life_events: osintResult.life_events,
        confidence_score: osintResult.confidence_score,
      }

      // Boost motivation score if life events indicate motivated seller
      const motivatedEvents = ["divorce", "bankruptcy", "foreclosure", "death_in_family", "inheritance"]
      const hasMotivatedEvent = osintResult.life_events.some((e) => motivatedEvents.includes(e.event))
      if (hasMotivatedEvent) {
        ;(enrichedLead as any).motivation_boost = 25
      }
    } catch (error) {
      console.error("[Enrichment] OSINT error:", error)
    }
  }

  // Step 3: Enrich with PeopleData
  if (leadData.email || leadData.phone) {
    try {
      const peopleDataResult = await clients.peopledata.enrich({
        email: leadData.email,
        phone: leadData.phone,
        firstName: leadData.first_name,
        lastName: leadData.last_name,
      })
      results.leads_enriched++

      if (peopleDataResult) {
        ;(enrichedLead as any).peopledata = {
          demographics: peopleDataResult.demographics,
          employment: peopleDataResult.employment,
          financial: peopleDataResult.financial,
          life_events: peopleDataResult.lifeEvents,
          social: peopleDataResult.social,
        }

        // Fill in missing contact info from PeopleData
        if (!enrichedLead.email && peopleDataResult.additionalContacts?.email) {
          enrichedLead.email = peopleDataResult.additionalContacts.email
        }
        if (!enrichedLead.phone && peopleDataResult.additionalContacts?.phone) {
          enrichedLead.phone = peopleDataResult.additionalContacts.phone
        }
      }
    } catch (error) {
      console.error("[Enrichment] PeopleData error:", error)
    }
  }

  return enrichedLead
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function buildPropertySearchUrl(site: string, market: any, params: any): string {
  const location = encodeURIComponent(`${market.city}, ${market.state}`)

  switch (site) {
    case "zillow":
      return `https://www.zillow.com/${market.city.toLowerCase().replace(/ /g, "-")}-${market.state.toLowerCase()}/homes/?searchQueryState=${encodeURIComponent(
        JSON.stringify({
          pagination: {},
          mapBounds: {},
          filterState: {
            price: { min: params.min_price, max: params.max_price },
            beds: { min: params.min_beds },
            baths: { min: params.min_baths },
          },
        }),
      )}`

    case "realtor":
      return `https://www.realtor.com/realestateandhomes-search/${market.city.replace(/ /g, "_")}_${market.state}/price-${params.min_price || 0}-${params.max_price || 10000000}/beds-${params.min_beds || 1}`

    case "redfin":
      return `https://www.redfin.com/city/${market.city.replace(/ /g, "-")}/${market.state}/filter/min-price=${params.min_price || 0},max-price=${params.max_price || 10000000},min-beds=${params.min_beds || 1}`

    case "trulia":
      return `https://www.trulia.com/${market.state}/${market.city.replace(/ /g, "_")}/`

    default:
      return `https://www.zillow.com/${location}/`
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
      brokerage_id:         params.brokerageId,
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

/**
 * Parse property search HTML from Zillow, Realtor, Redfin, or Trulia.
 * Returns only records that pass the viability gate.
 */
function parsePropertySearchResults(
  html: string,
  site: string,
  market: { city: string | null; state: string | null },
): NormalizedScrapedRecord[] {
  const $ = cheerio.load(html)
  const records: NormalizedScrapedRecord[] = []

  if (site === "zillow") {
    // Zillow embeds listing data in a <script type="application/json"> containing
    // the key "listResults" (or "cat1.searchResults.listResults" in newer builds).
    $('script[type="application/json"]').each((_, el) => {
      try {
        const raw = $(el).html() ?? ""
        if (!raw.includes("listResults") && !raw.includes("zpid")) return
        const json = JSON.parse(raw)
        // Traverse common nested paths where listResults appears
        const listResults: unknown[] =
          json?.cat1?.searchResults?.listResults ??
          json?.listResults ??
          json?.searchPageState?.cat1?.searchResults?.listResults ??
          []
        for (const item of listResults) {
          const listing = item as Record<string, unknown>
          const address = (listing.address as string | undefined) ?? (listing.streetAddress as string | undefined)
          const zpid   = String(listing.zpid ?? listing.id ?? `zillow-${Date.now()}-${Math.random()}`)
          if (!address) continue
          const record: NormalizedScrapedRecord = {
            sourceRecordId: `zillow-${zpid}`,
            source: "zillow",
            behaviorType: "property_view",
            intentType: "buyer",
            intentSignals: ["zillow_listing"],
            propertyAddress: address,
            city: (listing.city as string | null | undefined) ?? market.city,
            state: (listing.state as string | null | undefined) ?? market.state,
            zip: (listing.zipcode as string | null | undefined) ?? null,
            motivationScore: 40,
            sourceUrl: listing.detailUrl
              ? `https://www.zillow.com${listing.detailUrl}`
              : null,
            rawPayload: listing,
          }
          records.push(record)
        }
      } catch {
        // malformed JSON block — skip silently
      }
    })
  } else if (site === "realtor") {
    // Realtor.com property cards
    $('[data-testid="property-card"]').each((_, el) => {
      const addressEl  = $(el).find('[data-testid="card-address"]')
      const line1      = addressEl.first().text().trim()
      const line2      = addressEl.last().text().trim()
      const address    = line1 ? `${line1}${line2 ? `, ${line2}` : ""}` : null
      const href       = $(el).find('a').first().attr('href') ?? null
      const pid        = href?.split('/').filter(Boolean).pop() ?? `realtor-${Date.now()}-${Math.random()}`
      const priceText  = $(el).find('[data-testid="card-price"]').first().text().replace(/[^0-9]/g, '')
      if (!address) return
      const record: NormalizedScrapedRecord = {
        sourceRecordId: `realtor-${pid}`,
        source: "realtor",
        behaviorType: "property_view",
        intentType: "buyer",
        intentSignals: ["realtor_listing"],
        propertyAddress: address,
        city: market.city,
        state: market.state,
        motivationScore: 40,
        sourceUrl: href ? `https://www.realtor.com${href}` : null,
        rawPayload: { address, href, price: priceText ? Number(priceText) : null },
      }
      records.push(record)
    })
  } else if (site === "redfin") {
    // Redfin uses data-rf-test-name attributes on listing cards
    $('[data-rf-test-name="mapHomeCard"], .HomeCard, .home-card').each((_, el) => {
      const address   = $(el).find('[data-rf-test-name="homecard-address"], .address').first().text().trim() || null
      const href      = $(el).find('a').first().attr('href') ?? null
      const pid       = href?.split('/').filter(Boolean).pop() ?? `redfin-${Date.now()}-${Math.random()}`
      if (!address) return
      const record: NormalizedScrapedRecord = {
        sourceRecordId: `redfin-${pid}`,
        source: "redfin",
        behaviorType: "property_view",
        intentType: "buyer",
        intentSignals: ["redfin_listing"],
        propertyAddress: address,
        city: market.city,
        state: market.state,
        motivationScore: 40,
        sourceUrl: href ? `https://www.redfin.com${href}` : null,
        rawPayload: { address, href },
      }
      records.push(record)
    })
  } else {
    // Generic fallback: grab any element that looks like a property address
    $('[class*="address"], [class*="Address"]').each((_, el) => {
      const address = $(el).text().trim()
      if (address.length < 5 || address.length > 120) return
      const record: NormalizedScrapedRecord = {
        sourceRecordId: `${site}-${Date.now()}-${Math.random()}`,
        source: site,
        behaviorType: "property_view",
        intentType: "buyer",
        intentSignals: [`${site}_listing`],
        propertyAddress: address,
        city: market.city,
        state: market.state,
        motivationScore: 35,
        sourceUrl: null,
        rawPayload: { address },
      }
      records.push(record)
    })
  }

  return records.filter(isViableRecord)
}

/**
 * Parse Craigslist real-estate listing HTML.
 * Returns only FSBO / property listing rows that pass the viability gate.
 */
function parseCraigslistHtml(html: string): NormalizedScrapedRecord[] {
  const $ = cheerio.load(html)
  const records: NormalizedScrapedRecord[] = []

  $('.result-row, .cl-search-result').each((_, el) => {
    const titleEl  = $(el).find('.result-title, .titlestring').first()
    const title    = titleEl.text().trim()
    const listingId = ($(el).attr('data-pid') ?? `cl-${Date.now()}-${Math.random()}`).toString()
    const href     = titleEl.attr('href') ?? $(el).find('a.result-title').first().attr('href') ?? ''
    const priceText = $(el).find('.result-price').first().text().replace(/[^0-9]/g, '')
    const isFsbo   = /\b(by owner|fsbo|for sale by owner)\b/i.test(title)

    if (title.length < 5) return

    const record: NormalizedScrapedRecord = {
      sourceRecordId: listingId,
      source: "craigslist_fsbo",
      behaviorType: isFsbo ? "fsbo_listing" : "property_listing",
      intentType: "seller",
      intentSignals: isFsbo ? ["fsbo_listed"] : ["craigslist_listing"],
      propertyAddress: title.slice(0, 100),
      motivationScore: isFsbo ? 75 : 45,
      sourceUrl: href.startsWith("http") ? href : `https://craigslist.org${href}`,
      rawPayload: {
        title,
        listing_id: listingId,
        price: priceText ? Number(priceText) : null,
      },
    }
    records.push(record)
  })

  return records.filter(isViableRecord)
}

/**
 * Normalize a raw BatchData motivated-seller record into the canonical shape.
 * The motivationScore is clamped to [0, 100].
 */
function normalizeBatchDataRecord(
  record: Record<string, unknown>,
  market: { city: string | null; state: string | null },
): NormalizedScrapedRecord {
  const firstName = (record.firstName ?? record.first_name ?? record.owner_name?.toString().split(' ')[0] ?? '') as string
  const lastName  = (record.lastName  ?? record.last_name  ??
    (record.owner_name?.toString().split(' ').slice(1).join(' ') ?? '')) as string

  const rawScore  = record.motivationConfidence ?? record.motivation_score ?? 0.5
  const score     = Math.min(100, Math.max(0, Math.round(Number(rawScore) * (Number(rawScore) <= 1 ? 100 : 1))))

  const idSlug = `${firstName}-${lastName}-${record.propertyAddress ?? record.property_address ?? ''}`
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')

  return {
    sourceRecordId: `batchdata-${idSlug || Date.now()}`,
    source: "batchdata_motivated",
    behaviorType: "motivated_seller",
    intentType: "seller",
    intentSignals: [(record.motivationType ?? record.motivation_type ?? 'motivated_seller') as string],
    firstName:       firstName || null,
    lastName:        lastName  || null,
    email:           (record.email  as string | null | undefined) ?? null,
    phone:           (record.phone  as string | null | undefined) ?? null,
    city:            (record.city   as string | null | undefined) ?? market.city,
    state:           (record.state  as string | null | undefined) ?? market.state,
    zip:             (record.zip    as string | null | undefined) ?? null,
    mailingAddress:  (record.address as string | null | undefined) ?? null,
    propertyAddress: (record.propertyAddress ?? record.property_address) as string | null | undefined ?? null,
    motivationScore: score,
    rawPayload: record,
  }
}
