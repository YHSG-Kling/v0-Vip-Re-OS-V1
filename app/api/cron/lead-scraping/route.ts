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
    // Get active markets with their parameters
    const { data: markets } = await supabase
      .from("lead_scraping_markets")
      .select(`
        *,
        lead_scraping_property_params(*),
        lead_scraping_motivated_params(*)
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
      console.log(`[Lead Scraping Cron] Processing market: ${market.name}`)

      // ============================================
      // 1. SCRAPE PROPERTY SEARCH SITES (ZenRows - find buyers)
      // ============================================
      if (market.lead_scraping_property_params?.length > 0) {
        const propertyParams = market.lead_scraping_property_params[0]
        if (propertyParams.is_active) {
          const job = await createScrapingJob({
            job_type: "property_search",
            market_id: market.id,
            source: "zenrows_property",
          })

          try {
            await updateScrapingJob(job.job?.id, {
              status: "running",
              started_at: new Date().toISOString(),
            })

            for (const site of propertyParams.target_sites || ["zillow", "realtor", "redfin"]) {
              const searchUrl = buildPropertySearchUrl(site, market, propertyParams)
              const scraped = await zenrows.scrape(searchUrl, { js_render: true, premium_proxy: true })

              if (scraped.success && scraped.html) {
                const buyers = parsePropertySearchResults(scraped.html, site, market)

                for (const buyer of buyers) {
                  // Run enrichment pipeline for each lead
                  const enrichedLead = await enrichLeadPipeline(buyer, { peopledata, osint, validation }, results)

                  if (enrichedLead) {
                    const leadResult = await createLead({
                      ...enrichedLead,
                      lead_source: site,
                      scraped_from: searchUrl,
                      intent_type: "buyer",
                      temperature: "warm",
                    })
                    if (leadResult.success) results.total_leads_created++
                  }
                }
                results.total_leads_found += buyers.length
              }
            }

            await updateScrapingJob(job.job?.id, {
              status: "completed",
              leads_found: results.total_leads_found,
              leads_created: results.total_leads_created,
              completed_at: new Date().toISOString(),
            })
          } catch (error) {
            await updateScrapingJob(job.job?.id, {
              status: "failed",
              error_message: String(error),
              completed_at: new Date().toISOString(),
            })
            results.errors.push(`Property search error for ${market.name}: ${error}`)
          }
        }
      }

      // ============================================
      // 2. SCRAPE MOTIVATED SELLERS (BatchData)
      // ============================================
      if (market.lead_scraping_motivated_params?.length > 0) {
        const motivatedParams = market.lead_scraping_motivated_params[0]
        if (motivatedParams.is_active) {
          const job = await createScrapingJob({
            job_type: "motivated_sellers",
            market_id: market.id,
            source: "batchdata",
          })

          try {
            await updateScrapingJob(job.job?.id, {
              status: "running",
              started_at: new Date().toISOString(),
            })

            const location = `${market.city}, ${market.state}`
            const sellers = await batchdata.getMotivatedSellerData(location)

            let leadsCreated = 0
            for (const seller of sellers) {
              const matchesType = motivatedParams.motivation_types?.some((type: string) =>
                seller.motivation_indicators?.includes(type),
              )

              if (matchesType || !motivatedParams.motivation_types?.length) {
                // Extract name parts
                const nameParts = seller.owner_name?.split(" ") || []
                const firstName = nameParts[0] || ""
                const lastName = nameParts.slice(1).join(" ") || ""

                // Run enrichment pipeline
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

            results.total_leads_found += sellers.length
            results.total_leads_created += leadsCreated

            await updateScrapingJob(job.job?.id, {
              status: "completed",
              leads_found: sellers.length,
              leads_created: leadsCreated,
              completed_at: new Date().toISOString(),
            })
          } catch (error) {
            await updateScrapingJob(job.job?.id, {
              status: "failed",
              error_message: String(error),
              completed_at: new Date().toISOString(),
            })
            results.errors.push(`BatchData error for ${market.name}: ${error}`)
          }
        }
      }

      // ============================================
      // 3. SCRAPE SOCIAL PLATFORMS (ZenRows + Keywords)
      // ============================================
      if (keywords && keywords.length > 0) {
        const job = await createScrapingJob({
          job_type: "social_scrape",
          market_id: market.id,
          source: "social_platforms",
        })

        try {
          await updateScrapingJob(job.job?.id, {
            status: "running",
            started_at: new Date().toISOString(),
          })

          let socialLeadsCreated = 0

          // Group keywords by source
          const keywordsBySource: Record<string, string[]> = {}
          for (const kw of keywords) {
            for (const source of kw.sources || []) {
              if (!keywordsBySource[source]) keywordsBySource[source] = []
              keywordsBySource[source].push(kw.keyword)
            }
          }

          // Resolve motivatedParams for this market (used by Facebook group URLs and Reddit subreddits)
          const motivatedParams = market.lead_scraping_motivated_params?.[0]

          // Scrape Nextdoor
          if (keywordsBySource["nextdoor"]) {
            const nextdoorUrl = `https://nextdoor.com/search/?query=${encodeURIComponent(
              keywordsBySource["nextdoor"].slice(0, 3).join(" OR "),
            )}&location=${encodeURIComponent(market.city + ", " + market.state)}`

            const scraped = await zenrows.scrapeNextdoor(nextdoorUrl)
            if (scraped.success && scraped.posts) {
              for (const post of scraped.posts) {
                const matchedKeyword = keywords.find(
                  (kw) =>
                    kw.sources?.includes("nextdoor") && post.content?.toLowerCase().includes(kw.keyword.toLowerCase()),
                )

                if (matchedKeyword && matchedKeyword.weight >= 3) {
                  const nameParts = post.author_name?.split(" ") || []

                  // Run enrichment pipeline
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

          // Scrape Facebook Groups
          if (keywordsBySource["facebook"]) {
            const groupUrls: string[] = motivatedParams?.facebook_group_urls?.length
              ? motivatedParams.facebook_group_urls
              : [`https://www.facebook.com/groups/${market.city.toLowerCase().replace(/\s+/g, '')}realestate`]

            const fbResult = await zenrows.scrapeFacebookGroups({ groupUrls, keywords: keywordsBySource["facebook"] })
              .catch(() => ({ success: false, posts: [], cost: 0 }))

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

          // Scrape Reddit
          if (keywordsBySource["reddit"]) {
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

          // Scrape Craigslist
          if (keywordsBySource["craigslist"]) {
            const craigslistUrl = `https://${market.city.toLowerCase().replace(/ /g, "")}.craigslist.org/search/rea?query=${encodeURIComponent(
              keywordsBySource["craigslist"].slice(0, 3).join(" "),
            )}`

            const scraped = await zenrows.scrape(craigslistUrl, { js_render: false })
            if (scraped.success && scraped.html) {
              const listings = parseCraigslistHtml(scraped.html)
              for (const listing of listings) {
                // Run enrichment pipeline
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
          await updateScrapingJob(job.job?.id, {
            status: "failed",
            error_message: String(error),
            completed_at: new Date().toISOString(),
          })
          results.errors.push(`Social scrape error for ${market.name}: ${error}`)
        }
      }

      // Update market's last_scraped_at
      await supabase
        .from("lead_scraping_markets")
        .update({ last_scraped_at: new Date().toISOString() })
        .eq("id", market.id)
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
