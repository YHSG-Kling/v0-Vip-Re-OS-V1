import {
NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { ZenrowsClient, BatchDataClient, batchDataTriggersFor } from "@/lib/external"
import { processRawRecord } from "@/lib/lead-pipeline"
import { escalateScraperFailureIfNeeded, setScraperHealer } from "@/lib/lead-pipeline/scraper-health"
import { MAX_PROMOTION_ATTEMPTS, STRANDED_STATUSES, reportStuckRawLeads } from "@/lib/lead-pipeline/promotion-gate-health"
import {
  buildPropertySearchUrl,
  parsePropertySearchResults,
  parseBuyerSavedSearches,
  normalizeBatchDataRecord,
} from "@/lib/lead-pipeline/scraper-parsers"
import {
  sourceReddit,
  sourceFacebook,
  sourceInstagram,
  sourceCraigslist,
  sourceCraigslistWanted,
  sourceGoogle,
  sourceRentalListings,
  sourceLinkedInRelocation,
} from "@/lib/lead-pipeline/social-sourcer"
import { resolveActiveScrapeTerritories } from "@/lib/lead-pipeline/scrape-territories"
import { sourceOsintRecords } from "@/lib/lead-pipeline/osint-sourcer"
import { sourceExaBuyerIntent } from "@/lib/lead-pipeline/exa-sourcer"
import { sourceTavilyIntent } from "@/lib/lead-pipeline/tavily-sourcer"
import { sourceRecruitProspects } from "@/lib/recruit-pipeline/recruit-sourcer"
import { processRawRecruit } from "@/lib/recruit-pipeline/recruit-processor"
import { createScrapingJob, updateScrapingJob } from "@/app/actions/lead-scraping-config"
import {
  type NormalizedScrapedRecord,
  isViableRecord,
} from "@/lib/lead-pipeline/raw-record-types"
import { verifyCronAuth } from "@/lib/cron-auth"
import { buildTerritoryPhrases, expandEnabledSources } from "@/lib/lead-pipeline/source-intent-map"
import { meterVendorSpend, scraperTypeToVendor } from "@/lib/vendor-governance/meter-vendor"
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

// SCRAPER SELF-HEALER REGISTRATION (module scope — runs once per cold start, not
// per-request). scraper-health.ts's escalateScraperFailureIfNeeded already falls
// back to the real proposeConnectorHealing when no healer is registered, but that
// default path never records onto the self-healing ledger (lib/kernel/self-heal-
// ledger.ts) — only the AUTO-APPLIER's own "healed" writes did, so a scraper outage
// that got escalated into a proposal was invisible on the "the OS repairs itself"
// panel until someone applied it. This registration closes that gap: every
// escalation this cron triggers now also ledgers onto the SAME domain: "connector"
// spine connector-auto-applier.ts writes onto — outcome "escalated" (a proposal was
// raised for review/auto-apply, not yet applied) or "failed" (the healer itself
// could not even raise one, e.g. connector missing from the registry).
setScraperHealer(async ({ connector, failures }) => {
  const { proposeConnectorHealing } = await import("@/lib/agentic-os/connector-healer")
  const res = await proposeConnectorHealing({ connector, failures })
  try {
    const { recordSelfHeal } = await import("@/lib/kernel/self-heal-ledger")
    await recordSelfHeal(createServiceClient(), {
      brokerageId: null,
      domain:      "connector",
      subject:     connector,
      action:      "propose_connector_healing",
      outcome:     res.proposal ? "escalated" : "failed",
      detail:      { proposalId: res.proposal?.id ?? null, failureCount: failures.length, triggeredBy: "lead-scraping-cron" },
    })
  } catch { /* ledger is additive — never blocks the heal */ }
  return { proposalId: res.proposal?.id ?? null }
})

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
    // STEP 1.5 + 2 — SHARED PRE-SCRAPE TERRITORY RESOLVER (canonical): before
    // ANY scrape, resolve the active tenants (live subscription) and their
    // territories (set up in settings at onboarding). Only those areas are ever
    // scraped. No active tenants / no territories → honest no-op with the
    // stated reason — the platform never scrapes fixed/global geography.
    const territoryResolution = await resolveActiveScrapeTerritories(supabase)
    if (territoryResolution.noOp) {
      const reason = territoryResolution.reason === "no_active_subscribers"
        ? "No active-subscription brokerages — nothing to scrape"
        : "No active territories configured for active-subscription brokerages"
      console.log(`[Lead Scraping Cron] ${reason} (${territoryResolution.reason})`)
      await recordCronSuccessAction({
        context_id: contextId,
        records_processed: 0,
        output_count: 0,
        metadata: { no_op_reason: territoryResolution.reason },
      })
      return NextResponse.json({ message: reason, no_op_reason: territoryResolution.reason, results })
    }
    const markets = territoryResolution.territories

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

      // STEP 4 — Resolve the set of enabled sources for this territory. Expanded
      // through GATE_TOKEN so the gate matches whether the DB stored short names
      // ("facebook"), canonical keys ("facebook_group"), or aliases ("zillow").
      const enabledSources = expandEnabledSources(market.enabled_sources ?? ["batchdata_motivated"])

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

            // ZenRows is for BOTH buyer-intent profile pages (saved-search / property-alert) AND
            // seller-intent pages (FSBO posts, motivated-seller forums) on forums / social /
            // personal sites — NOT MLS listings (RentCast is the canonical MLS source for listing
            // data). Zillow / Realtor / Redfin do not expose either as scrapable profile pages; the
            // default list below remains for back-compat but those sites should be replaced in
            // brokerage `propertyParams.target_sites` configs with intent-rich sources (Reddit
            // communities, BiggerPockets, Craigslist "wanted: home" + "FSBO" posts, agent blogs,
            // local-classifieds / neighborhood forums). The page-level ZenRows normalizer now
            // scores buyer + seller + investor + agent + generic intent so the same page can yield
            // a buyer record OR a seller record depending on which scored highest.
            for (const site of propertyParams.target_sites || ["zillow", "realtor", "redfin"]) {
              const searchUrl = buildPropertySearchUrl(site, market, propertyParams)
              const scraped = await zenrows.scrape(searchUrl, { js_render: true, premium_proxy: true })
              sourceCostUsd += scraped.cost ?? 0

              if (scraped.success && scraped.html) {
                // Same page yields BOTH online behaviors: FSBO sellers
                // (parsePropertySearchResults) AND saved-search/favorited buyers
                // (parseBuyerSavedSearches). Both are filtered by the viability gate.
                const sellerRecords = parsePropertySearchResults(scraped.html, site, market)
                const buyerRecords = parseBuyerSavedSearches(scraped.html, site, market)
                // Expired listings are sourced from BatchData (the 'expired' motivation trigger),
                // not scraped from portal HTML — see the BatchData block below.
                const siteRecords = [...sellerRecords, ...buyerRecords]
                sourceItemsFound += siteRecords.length

                // Rich page-level normalization (buyer + seller + investor intent, FSBO marker,
                // property-alert profile, page meta). Computed ONCE per page and attached to every
                // record produced from it so downstream lead-gate + AI-ISA scripts see the same
                // intent signal whether the record came from the FSBO parser or the buyer-search
                // parser. The per-record parsers still set the canonical intentType; this adds
                // structured persona + matched phrases without overriding.
                const { normalizeZenRowsHtml } = await import("@/lib/external/zenrows-normalizer")
                const zen = normalizeZenRowsHtml(scraped.html)
                for (const r of siteRecords) {
                  if (!r.intent) {
                    r.intent = {
                      winner:            zen.intent.winner,
                      persona:           zen.intent.persona,
                      scores:            { buyer: zen.intent.buyer, seller: zen.intent.seller, investor: zen.intent.investor, agent: zen.intent.agent, generic: zen.intent.generic },
                      matched:           zen.intent.matched,
                      buyerAlertProfile: zen.intent.buyerAlertProfile,
                      propertyAddresses: zen.addresses,
                      prices:            zen.prices,
                    }
                  }
                  // Preserve the full structured normalization in rawPayload for audit + AI-ISA.
                  ;(r.rawPayload as any).zenrowsNormalized = zen
                }

                // Write raw records only — enrichment and promotion happen in pipeline-processor.
                // Routed through the kernel's canonical batch writer (lib/kernel/scraping.ts
                // ingestRawSourceBatch) — see insertRawBatch below.
                const { inserted: siteInserted } = await insertRawBatch({
                  records:     siteRecords,
                  marketId:    market.id,
                  marketGeo: { city: market.city, state: market.state, zip_codes: market.zip_codes },
                  executionId: execRecord?.id ?? null,
                  source:       "zillow_behavior",
                  sourceFamily: "property_search",
                  sourceChannel: site,
                })
                sourceLeadsCreated += siteInserted
                results.total_leads_created += siteInserted
                results.total_leads_found += siteRecords.length
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

          // Data Steward owns scraping health: a sustained source outage escalates to the broker.
          if (sourceErr) {
            await escalateScraperFailureIfNeeded(supabase, { scraperType: "zillow_behavior", errorMessage: sourceErr.message })
          }

          // Unified vendor-spend ledger (one gateway for all data-vendor cost).
          await meterVendorSpend({
            vendorName: scraperTypeToVendor("zillow_behavior"),
            usageType: "property_scrape",
            cost: sourceCostUsd,
            brokerageId: market.brokerage_id,
            metadata: { market_id: market.id, scraper_type: "zillow_behavior" },
          })

          territorySpendUsd += sourceCostUsd
        }
      }

      // ============================================
      // 2. SCRAPE MOTIVATED SELLERS (BatchData)
      // ============================================
      // STEP 4 gate
      if ((enabledSources.has("batchdata_motivated") || enabledSources.has("expired_listing")) && market.lead_scraping_motivated_params?.length > 0) {
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
            // Motivated-seller scrapes (probate, foreclosure, pre_foreclosure, tax_lien, vacant,
            // tired_landlord, high_equity, absentee) come from BatchData FIRST — the market's CONFIGURED
            // signal types map to real BatchData quickLists, pulled TRIGGER-BY-TRIGGER (BatchData labels
            // every record in a search with the first trigger, so each must be its own call). Types
            // BatchData can't serve (divorce/bankruptcy/eviction) fall to OSINT. Expired is its own call.
            const motivatedTriggers = enabledSources.has("batchdata_motivated")
              ? batchDataTriggersFor(motivatedParams.signal_types)
              : []
            const rawSellers = [
              ...(await Promise.all(motivatedTriggers.map((t) => batchdata.getMotivatedSellerData(location, [t])))).flat(),
              ...(enabledSources.has("expired_listing") ? await batchdata.getMotivatedSellerData(location, ["expired"]) : []),
            ]
            // Normalize to canonical shape and filter by viability gate
            const sellers = rawSellers
              .map((r) => normalizeBatchDataRecord(r as Record<string, unknown>, market))
              .filter(isViableRecord)
            sourceItemsFound = rawSellers.length

            // All BatchData records were pulled by an EXPLICIT configured trigger (expired or a
            // mapped motivated-seller type), so they're all wanted — the signal_types filter is
            // obsolete for them (and alias-safe, since we pulled canonical triggers).
            const sellersToInsert = sellers.filter((seller) => {
              const isBatchData = seller.source === "expired_listing" || seller.source === "batchdata_motivated"
              const matchesType = isBatchData || motivatedParams.signal_types?.some((type: string) =>
                seller.intentSignals?.includes(type),
              )
              return matchesType || !motivatedParams.signal_types?.length
            })

            // Write raw records only — enrichment and promotion run in pipeline-processor.
            // Routed through the kernel's canonical batch writer (insertRawBatch).
            const { inserted: batchInserted } = await insertRawBatch({
              records:     sellersToInsert,
              marketId:    market.id,
              marketGeo: { city: market.city, state: market.state, zip_codes: market.zip_codes },
              executionId: execRecord?.id ?? null,
              source:       "batchdata_motivated",
              sourceFamily: "motivated_seller",
              sourceChannel: "batchdata",
            })
            leadsCreated = batchInserted

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

          // Data Steward owns scraping health: a sustained source outage escalates to the broker.
          if (sourceErr) {
            await escalateScraperFailureIfNeeded(supabase, { scraperType: "batchdata_motivated", errorMessage: sourceErr.message })
          }
        }
      }

      // ============================================
      // 3. SCRAPE SOCIAL PLATFORMS (ZenRows + Keywords)
      // ============================================
      const socialSourcesEnabled =
        enabledSources.has("nextdoor") ||
        enabledSources.has("facebook") ||
        enabledSources.has("instagram") ||
        enabledSources.has("reddit") ||
        enabledSources.has("craigslist") ||
        enabledSources.has("google_phrase_intent") ||
        enabledSources.has("rental") ||
        enabledSources.has("linkedin") ||
        enabledSources.has("exa") ||
        enabledSources.has("tavily")

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
              const ndRecords: NormalizedScrapedRecord[] = []
              for (const post of scraped.posts) {
                const matchedKeyword = keywords.find(
                  (kw) =>
                    kw.sources?.includes("nextdoor") && post.content?.toLowerCase().includes(kw.keyword.toLowerCase()),
                )
                if (matchedKeyword && matchedKeyword.weight >= 3) {
                  const nameParts = ((post as any).author_name ?? "").split(" ")
                  ndRecords.push({
                    sourceRecordId:  `nextdoor-${(post as any).post_id ?? `${Date.now()}-${Math.random()}`}`,
                    source:          "nextdoor",
                    behaviorType:    "social_intent",
                    intentType:      matchedKeyword.keyword_type === "buying_intent" ? "buyer" : "seller",
                    intentSignals:   [matchedKeyword.keyword],
                    firstName:       nameParts[0] || null,
                    lastName:        nameParts.slice(1).join(" ") || null,
                    city:            market.city,
                    state:           market.state,
                    motivationScore: matchedKeyword.weight * 20,
                    sourceUrl:       nextdoorUrl,
                    rawPayload:      { post, matched_keyword: matchedKeyword.keyword },
                  })
                }
              }
              const { inserted: ndInserted } = await insertRawBatch({
                records: ndRecords, marketId: market.id,
                marketGeo: { city: market.city, state: market.state, zip_codes: market.zip_codes },
                executionId: execRecord?.id ?? null,
                source: "nextdoor", sourceFamily: "social_intent", sourceChannel: "nextdoor",
              })
              socialLeadsCreated += ndInserted
            }
          }

          const socialMarket = { city: market.city, state: market.state }
          // ONE batch call per sub-source — routes through the kernel's canonical writer
          // (ingestRawSourceBatch) instead of one insert per record.
          const insertSocial = async (records: NormalizedScrapedRecord[], channel: string, sourceFamily = "social_intent") => {
            const { inserted } = await insertRawBatch({
              records, marketId: market.id,
              marketGeo: { city: market.city, state: market.state, zip_codes: market.zip_codes },
              executionId: execRecord?.id ?? null,
              source: channel, sourceFamily, sourceChannel: channel,
            })
            socialLeadsCreated += inserted
          }

          // ── Facebook groups (Apify) ──────────────────────────────────────────
          if (enabledSources.has("facebook") && keywordsBySource["facebook"]) {
            const groupUrls: string[] = motivatedParams?.facebook_group_urls?.length
              ? motivatedParams.facebook_group_urls
              : [`https://www.facebook.com/groups/${market.city.toLowerCase().replace(/\s+/g, "")}realestate`]
            for (const groupUrl of groupUrls) {
              const { records, cost } = await sourceFacebook(groupUrl, keywordsBySource["facebook"], socialMarket)
              sourceCostUsd += cost
              await insertSocial(records, "facebook")
            }
          }

          // ── Instagram (Apify) — real-estate hashtags, buyer + seller intent ──
          if (enabledSources.has("instagram") && keywordsBySource["instagram"]) {
            const { records, cost } = await sourceInstagram(keywordsBySource["instagram"], socialMarket)
            sourceCostUsd += cost
            await insertSocial(records, "instagram")
          }

          // ── Reddit communities (Apify) ───────────────────────────────────────
          if (enabledSources.has("reddit") && keywordsBySource["reddit"]) {
            const subreddits: string[] = motivatedParams?.reddit_subreddits?.length
              ? motivatedParams.reddit_subreddits
              : [`${market.city.toLowerCase().replace(/\s+/g, "")}realestate`, "FirstTimeHomeBuyer", "moving"]
            const { records, cost } = await sourceReddit(subreddits, keywordsBySource["reddit"], socialMarket)
            sourceCostUsd += cost
            await insertSocial(records, "reddit")
          }

          // ── Craigslist (Apify) — for-sale (seller FSBO) + housing-wanted (buyer) ─
          // Two DISTINCT capabilities (owner ruling: never fold two sources into one) —
          // separate channels so each keeps its own attribution downstream.
          if (enabledSources.has("craigslist") && keywordsBySource["craigslist"] && market.city) {
            const forSale = await sourceCraigslist(
              market.city, keywordsBySource["craigslist"].slice(0, 3).join(" "), socialMarket,
            )
            sourceCostUsd += forSale.cost
            await insertSocial(forSale.records, "craigslist")
            // Buyer intent: "housing wanted" / ISO posts.
            const wanted = await sourceCraigslistWanted(market.city, socialMarket)
            sourceCostUsd += wanted.cost
            await insertSocial(wanted.records, "craigslist_wanted")
          }

          // ── Google phrase intent (Apify) — buyer + seller searches ───────────
          // buildTerritoryPhrases() derives buyer+seller search queries from the territory.
          if (enabledSources.has("google_phrase_intent")) {
            const { buyerPhrases, sellerPhrases } = buildTerritoryPhrases({
              city: market.city, state: market.state, zip_codes: market.zip_codes, counties: market.counties,
            })
            const queries = [...sellerPhrases.slice(0, 3), ...buyerPhrases.slice(0, 2)]
            const { records, cost } = await sourceGoogle(queries, socialMarket)
            sourceCostUsd += cost
            await insertSocial(records, "google_phrase_intent", "search_signal")
          }

          // ── Rental listings (Apify Craigslist 'apa') — landlord/investor sellers ─
          // Craigslist 'apa' carries a reply email (real landlord contact);
          // RentCast is property-data only (no owner contact) so it is NOT used
          // for seller leads — motivated-seller DETAILS come from BatchData /
          // OSINT / PropertyRadar.
          if (enabledSources.has("rental") && market.city) {
            const { records, cost } = await sourceRentalListings(market.city, socialMarket)
            sourceCostUsd += cost
            await insertSocial(records, "rental")
          }

          // Expired / off-market sellers: addresses are scraped via
          // parseExpiredListings (property block) and owner DETAILS come from
          // BatchData (motivated block) / OSINT distress filings / PropertyRadar.

          // ── LinkedIn relocation posts (Apify) — inbound relocating buyers ──────
          if (enabledSources.has("linkedin")) {
            const { records, cost } = await sourceLinkedInRelocation(socialMarket)
            sourceCostUsd += cost
            await insertSocial(records, "linkedin")
          }

          // ── Exa neural search (AI-native) — buyer-intent content across the web ─
          if (enabledSources.has("exa")) {
            const { records, cost } = await sourceExaBuyerIntent(socialMarket)
            sourceCostUsd += cost
            await insertSocial(records, "exa")
          }

          // ── Tavily agentic search (AI-native) — buyer / seller / investor intent ─
          if (enabledSources.has("tavily")) {
            const { records, cost } = await sourceTavilyIntent(socialMarket)
            sourceCostUsd += cost
            await insertSocial(records, "tavily")
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

        // Data Steward owns scraping health: a sustained source outage escalates to the broker.
        if (sourceErr) {
          await escalateScraperFailureIfNeeded(supabase, { scraperType: "social_intent", errorMessage: sourceErr.message })
        }

        // Unified vendor-spend ledger (Apify + Exa + Tavily social scrape).
        await meterVendorSpend({
          vendorName: scraperTypeToVendor("social_intent"),
          usageType: "social_scrape",
          cost: sourceCostUsd,
          brokerageId: market.brokerage_id,
          metadata: { market_id: market.id, scraper_type: "social_intent" },
        })

        territorySpendUsd += sourceCostUsd
      }

      // ── OSINT public-records source — distressed-seller filings ─────────────
      // Divorce / probate / foreclosure / tax-lien / eviction / bankruptcy court
      // filings in the territory → motivated-seller raw records (platform-owned).
      if (enabledSources.has("osint_signal")) {
        try {
          const { records, cost } = await sourceOsintRecords({
            city: market.city,
            state: market.state,
            county: market.counties?.[0] ?? null,
          })
          territorySpendUsd += cost
          await meterVendorSpend({
            vendorName: scraperTypeToVendor("osint_signal"),
            usageType: "public_records",
            cost,
            brokerageId: market.brokerage_id,
            metadata: { market_id: market.id, scraper_type: "osint_signal" },
          })
          const { inserted: osintInserted } = await insertRawBatch({
            records, marketId: market.id,
            marketGeo: { city: market.city, state: market.state, zip_codes: market.zip_codes },
            executionId: null,
            source: "osint_signal", sourceFamily: "distressed_signal", sourceChannel: "osint_signal",
          })
          results.total_leads_created += osintInserted
        } catch (err) {
          results.errors.push(`OSINT source error for ${market.name}: ${err instanceof Error ? err.message : String(err)}`)
        }
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

    // ── DAILY RE-ENRICH SWEEP — give failed-gate raw records another chance ───
    // Canonical business rule: when a raw record fails the lead-creation gate
    // (insufficient identity / contact / mailing-address-verification), enrichment should KEEP
    // trying — the info may become available later (PDL surfaces a new email, mailing address
    // verifies, etc.). We reset stranded rows to 'pending' so the promotion loop above re-runs
    // the full territory → identity → dedup → enrichment → eligibility flow on the next daily
    // cron tick. Capped at 100 rows/run and MAX_PROMOTION_ATTEMPTS attempts/row so a
    // permanently-unenrichable record never burns the budget forever. The cap +
    // stranded-status vocabulary live in promotion-gate-health so the sweep and the
    // stuck-record monitor below can't drift.
    const { data: stranded } = await supabase
      .from('raw_scraped_leads')
      .select('id, promotion_attempts')
      .in('processing_status', STRANDED_STATUSES as unknown as string[])
      .lt('promotion_attempts', MAX_PROMOTION_ATTEMPTS)
      .order('updated_at', { ascending: true })
      .limit(100)
    for (const r of stranded ?? []) {
      await supabase
        .from('raw_scraped_leads')
        .update({
          processing_status:         'pending',
          promotion_attempts:        (r.promotion_attempts ?? 0) + 1,
          last_promotion_attempt_at: new Date().toISOString(),
          updated_at:                new Date().toISOString(),
        })
        .eq('id', r.id)
      try {
        const promo = await processRawRecord(r.id)
        if (promo.action === 'created') {
          results.leads_promoted++
          // CONTINUITY LEDGER: a previously-STRANDED record recovering on retry
          // is a self-heal — scraped data that was stuck now flowed to where it
          // belongs. Same unified ledger as the flow + connector heals.
          const { recordSelfHeal } = await import('@/lib/kernel/self-heal-ledger')
          await recordSelfHeal(supabase, {
            brokerageId: null, domain: 'data_flow', subject: r.id,
            action: 'reenrich_promote', outcome: 'healed',
            detail: { flow: 'scraped_lead_stranded', attempt: (r.promotion_attempts ?? 0) + 1 },
          })
        }
      } catch (err) {
        results.errors.push(`Re-enrich error for ${r.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // ── STUCK-RECORD WATCH — Data Steward surfaces permanently-unpromotable raws ──
    // Records that exhausted the promotion cap (or territory_mismatch) are dropped by
    // the sweep above and would accumulate silently. The Steward reports them to
    // platform staff once/day so the platform fixes enrichment/territory config.
    await reportStuckRawLeads(supabase)

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

    // RELIST DETECTION — a property de-listed (expired/withdrawn) and back on the
    // market is a textbook motivated-seller signal. The detector joins this run's
    // fresh active-listing raw records against the expired rows we already hold
    // and emits LISTING_RELISTED kernel events for the standard reactor fan-out.
    // Read-only over raw_scraped_leads; best-effort.
    let relistMatches = 0
    try {
      const { detectRelistedListings } = await import("@/lib/lead-pipeline/relisting-detector")
      const relist = await detectRelistedListings()
      relistMatches = relist.matches.length
      if (relist.error) results.errors.push(`relist-detector: ${relist.error}`)
    } catch (e) {
      console.error("[lead-scraping] relist detection failed (non-fatal):", e)
    }

    // THE PLATFORM HUNTS ITS OWN CUSTOMERS — same scraping heartbeat, pointed
    // at OS-BUYING intent (agents/teams/brokerages shopping for tech). Weekly
    // ISO-gated inside the sourcer; provider-gated; staff digest only, never
    // automated outreach to the prospect. Best-effort.
    let platformProspects = 0
    try {
      const { sourcePlatformProspects } = await import("@/lib/platform/prospect-sourcer")
      const { createServiceClient } = await import("@/lib/supabase/service")
      const r = await sourcePlatformProspects(createServiceClient() as any)
      platformProspects = r.captured
    } catch (e) {
      console.error("[lead-scraping] platform prospect hunt failed (non-fatal):", e)
    }

    return NextResponse.json({ message: "Lead scraping completed", platformProspects, relistMatches, results })
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
// insertRawBatch — Kernel OS canonical raw-record writer
// ALL scraping paths funnel through this, which is a thin cron-side wrapper over
// lib/kernel/scraping.ts::ingestRawSourceBatch (THE canonical writer — its own
// header declares "raw records enter via ingestRawSourceBatch() ONLY"). Zero
// createLead() calls in this file, and zero direct raw_scraped_leads inserts —
// this used to hand-roll its own insert (a duplicate of ingestRawSourceBatch's
// viability + territory gate + dedup + attribution), which left the kernel
// function imported and never called (dead-import / hidden-wire). Every scrape
// phase below batches its records and calls this once per sub-source, so the
// kernel writer's per-record lifecycle events (RAW_RECORD_CREATED) and
// scraper_executions bookkeeping stay batch-shaped, not per-record chatter.
//
// Raw records here are always PLATFORM-owned (brokerage_id NULL) — this cron
// is the scheduled, territory-driven sweep; ingestRawSourceBatch derives
// raw_scraped_leads.source_origin = 'platform' from brokerageId: null. An
// explicit brokerage-triggered scrape (none exists yet — see report) would
// pass a real brokerageId and get source_origin = 'brokerage' instead.
interface InsertRawBatchParams {
  records: NormalizedScrapedRecord[]
  marketId: string
  /** The scraped market's geography — passed straight through to the kernel
   *  writer so it skips its own per-call DB lookup (this cron already loaded
   *  it once per territory). */
  marketGeo?: { city?: string | null; state?: string | null; zip_codes?: string[] | null }
  /** A scraper_executions row already opened for this phase; reused instead of
   *  opening (and closing) a second row per sub-source batch. */
  executionId?: string | null
  /** Batch label for scraper_executions.scraper_type + lifecycle metadata,
   *  e.g. "facebook", "batchdata_motivated", "osint_signal" — kept DISTINCT
   *  per source (owner ruling: never fold two scraping capabilities into one). */
  source: string
  sourceFamily: string
  sourceChannel: string
  sourceSubtype?: string
}

async function insertRawBatch(params: InsertRawBatchParams): Promise<{ inserted: number; rawIds: string[] }> {
  if (params.records.length === 0) return { inserted: 0, rawIds: [] }

  const res = await ingestRawSourceBatch({
    brokerageId:   null,
    marketId:      params.marketId,
    source:        params.source,
    sourceFamily:  params.sourceFamily,
    sourceChannel: params.sourceChannel,
    sourceSubtype: params.sourceSubtype,
    records:       params.records,
    executionId:   params.executionId ?? null,
    marketGeo:     params.marketGeo ?? null,
  })

  return { inserted: res.inserted, rawIds: res.rawIds }
}
