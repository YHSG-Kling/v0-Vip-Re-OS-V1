import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { ZenrowsClient, BatchDataClient, PeopleDataClient, ApifyClient } from "@/lib/external"
import { processRawRecord } from "@/lib/lead-pipeline"
import { createLead } from "@/app/actions/leads"
import { createScrapingJob, updateScrapingJob } from "@/app/actions/lead-scraping-config"

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
                const buyers = parsePropertySearchResults(scraped.html, site, market)
                sourceItemsFound += buyers.length

                for (const buyer of buyers) {
                  const enrichedLead = await enrichLeadPipeline(buyer, { peopledata, osint, validation }, results)
                  if (enrichedLead) {
                    const leadResult = await createLead({
                      ...enrichedLead,
                      lead_source: site,
                      scraped_from: searchUrl,
                      intent_type: "buyer",
                      temperature: "warm",
                    })
                    if (leadResult.success) { sourceLeadsCreated++; results.total_leads_created++ }
                  }
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
            const sellers = await batchdata.getMotivatedSellerData(location)
            sourceItemsFound = sellers.length

            for (const seller of sellers) {
              const matchesType = motivatedParams.signal_types?.some((type: string) =>
                seller.motivation_indicators?.includes(type),
              )

              if (matchesType || !motivatedParams.signal_types?.length) {
                const nameParts = seller.owner_name?.split(" ") || []
                const firstName = nameParts[0] || ""
                const lastName = nameParts.slice(1).join(" ") || ""

                const enrichedLead = await enrichLeadPipeline(
                  {
                    first_name: firstName,
                    last_name: lastName,
                    address: seller.property_address,
                    city: market.city,
                    state: market.state,
                    email: seller.email,
                    phone: seller.phone,
                  },
                  { peopledata, osint, validation },
                  results,
                )

                if (enrichedLead) {
                  const leadResult = await createLead({
                    ...enrichedLead,
                    lead_source: "batchdata",
                    scraped_from: "batchdata_motivated_sellers",
                    intent_type: "seller",
                    motivation_score: seller.motivation_score,
                    temperature: seller.motivation_score > 70 ? "hot" : seller.motivation_score > 40 ? "warm" : "cold",
                    raw_scraped_data: seller,
                  })
                  if (leadResult.success) leadsCreated++
                }
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
                  const nameParts = post.author_name?.split(" ") || []
                  const enrichedLead = await enrichLeadPipeline(
                    {
                      first_name: nameParts[0] || "",
                      last_name: nameParts.slice(1).join(" ") || "",
                      city: market.city,
                      state: market.state,
                    },
                    { peopledata, osint, validation },
                    results,
                  )
                  if (enrichedLead) {
                    const leadResult = await createLead({
                      ...enrichedLead,
                      lead_source: "nextdoor",
                      scraped_from: nextdoorUrl,
                      intent_type: matchedKeyword.category === "buying_intent" ? "buyer" : "seller",
                      motivation_score: matchedKeyword.weight * 20,
                      temperature: matchedKeyword.weight >= 4 ? "hot" : "warm",
                      raw_scraped_data: { post, matched_keyword: matchedKeyword.keyword },
                    })
                    if (leadResult.success) socialLeadsCreated++
                  }
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
                await supabase
                  .from("raw_scraped_leads")
                  .insert({
                    brokerage_id: market.brokerage_id,
                    source: "facebook_group",
                    raw_data: { post, matched_keyword: matched.keyword, market_id: market.id },
                    processing_status: "pending",
                  })
                  .catch(() => {})
                socialLeadsCreated++
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
                await supabase
                  .from("raw_scraped_leads")
                  .insert({
                    brokerage_id: market.brokerage_id,
                    source: "reddit_intent",
                    raw_data: { post, matched_keyword: matched.keyword, market_id: market.id },
                    processing_status: "pending",
                  })
                  .catch(() => {})
                socialLeadsCreated++
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
              const listings = parseCraigslistHtml(scraped.html)
              for (const listing of listings) {
                const enrichedLead = await enrichLeadPipeline(
                  {
                    first_name: listing.contact_name?.split(" ")[0] || "",
                    last_name: listing.contact_name?.split(" ").slice(1).join(" ") || "",
                    email: listing.email,
                    phone: listing.phone,
                    city: market.city,
                    state: market.state,
                  },
                  { peopledata, osint, validation },
                  results,
                )
                if (enrichedLead) {
                  const leadResult = await createLead({
                    ...enrichedLead,
                    lead_source: "craigslist",
                    scraped_from: craigslistUrl,
                    intent_type: "seller",
                    temperature: "warm",
                    raw_scraped_data: listing,
                  })
                  if (leadResult.success) socialLeadsCreated++
                }
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

function parsePropertySearchResults(html: string, site: string, market: any): Array<any> {
  // Simplified parser - real implementation would use cheerio
  return []
}

function parseCraigslistHtml(html: string): Array<{
  contact_name?: string
  email?: string
  phone?: string
  title?: string
  price?: number
}> {
  // Simplified parser - real implementation would use cheerio
  return []
}
