import {
NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { ZenrowsClient, BatchDataClient, batchDataTriggersFor } from "@/lib/external"
import {
  createSmartSearchSubscription,
  deleteSmartSearchSubscription,
  listSmartSearchSubscriptions,
  buildSmartSearchSubscriptionPlan,
  BATCHDATA_SMART_SEARCH_SUBSCRIPTION_ACCOUNT_CAP,
  quickListSlugsFor,
} from "@/lib/external/batchdata-client"
import { runIncrementalPropertySearchForMarket, runActiveListingDiscoveryForMarket, runBuyBoxMatchingForMarket } from "@/lib/kernel/listings-batchdata-feed"
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
  sourceRedditRelocation,
  sourceFacebookRecommendRealtor,
  sourceAgentSeekingPhraseIntent,
  sourceRealtySiteChatter,
  sourceNewConstructionIntent,
  sourceFacebookMarketplace,
  sourceTikTokIntent,
  normalizeNextdoorPost,
} from "@/lib/lead-pipeline/social-sourcer"
// Lane 83A — the ONE keyword resolver: code defaults per population per territory + the market's own
// brokerage's lead_scraping_keywords rows (scrape-keywords.ts).
import { resolveSourceKeywords, renderKeywordQuery, type ScrapeKeywordRow } from "@/lib/lead-pipeline/scrape-keywords"
import { sourcePermitPrelistingIntent, routePermitPrelistingHits } from "@/lib/lead-pipeline/permit-sourcer"
import { resolveActiveScrapeTerritories } from "@/lib/lead-pipeline/scrape-territories"
import { sourceOsintRecords } from "@/lib/lead-pipeline/osint-sourcer"
import { sourceSiteVisitorIntent } from "@/lib/lead-pipeline/site-visitor-sourcer"
import { sourceEmailEngagementIntent } from "@/lib/lead-pipeline/email-engagement-sourcer"
import { sourceRentalToBuyerGraduation } from "@/lib/lead-pipeline/rental-graduation-sourcer"
import { sourceReviewAcquisitionIntent, routeReviewAcquisitionHits } from "@/lib/lead-pipeline/review-acquisition-sourcer"
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
import { buildTerritoryPhrases, expandEnabledSources, DEFAULT_MARKET_SOURCES } from "@/lib/lead-pipeline/source-intent-map"
// Lane 82B — every scrape's spend books PER SOURCE on the platform ledger through the ONE
// source→vendor contract (source-intent-map.ts::SOURCE_VENDOR via source-cost-ledger.ts), which
// itself rides meterVendorSpend. The composite "apify_social" row is gone (see the social block).
import { bookSourceSpend } from "@/lib/lead-pipeline/source-cost-ledger"
import { scrapeSiteWithBestProvider } from "@/lib/external/zenrows-client"
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

    // Brokerage keyword rows (lane 83A). Each territory reads ONLY its own brokerage's rows, ON TOP of
    // the code defaults (scrape-keywords.ts::resolveSourceKeywords) — so a platform with zero rows
    // (measured live 2026-09-26: 0) still runs every keyword lane with a correct, intent-specific set.
    // A refused read is reported, never read as "no keywords" silently; the defaults still run.
    const { data: keywordRows, error: keywordReadError } = await supabase
      .from("lead_scraping_keywords")
      .select("brokerage_id, keyword, keyword_type, sources, weight, is_active")
      .eq("is_active", true)
    if (keywordReadError) results.errors.push(`lead_scraping_keywords read refused (code defaults still run): ${keywordReadError.message}`)
    const keywords = (keywordRows ?? []) as ScrapeKeywordRow[]

    // ── SMART SEARCH ACCOUNT-WIDE CAP (wave 66 fix) ───────────────────────────
    // BatchData caps Property Subscription at 5 PER ACCOUNT, not per market — the
    // wave-65B reconcile checked only the current market's own rows, so two
    // priority-1 markets could each "successfully" create a subscription and the
    // 6th call across the account would simply refuse. `markets` above is already
    // ordered by `priority DESC` (lib/lead-pipeline/scrape-territories.ts), so
    // walking it in order and decrementing one shared counter is what turns that
    // ordering into an actual admission PLAN: the highest-priority territories'
    // wants are tried first, everything the cap has no room for is recorded
    // `deferred`. `smartSearchAccountLiveCount` starts from BatchData's own live
    // count (never our local table alone — a subscription cancelled by a human on
    // BatchData's dashboard would otherwise silently look like a free slot) and is
    // reconciled up by one for every `create` this run actually admits.
    let smartSearchAccountLiveCount = 0
    let smartSearchAccountCountKnown = false
    try {
      const liveList = await listSmartSearchSubscriptions()
      if (liveList.ok) {
        smartSearchAccountLiveCount = liveList.subscriptionIds.length
        smartSearchAccountCountKnown = true
      } else {
        results.errors.push(`Smart Search account list read failed (proceeding conservatively, cap treated as already full): ${liveList.error}`)
        smartSearchAccountLiveCount = BATCHDATA_SMART_SEARCH_SUBSCRIPTION_ACCOUNT_CAP
      }
    } catch (e) {
      results.errors.push(`Smart Search account list read threw (proceeding conservatively): ${e}`)
      smartSearchAccountLiveCount = BATCHDATA_SMART_SEARCH_SUBSCRIPTION_ACCOUNT_CAP
    }

    // Wave 70 — site-visitor-intent lane runs ONCE per BROKERAGE, not once per market row.
    // Website traffic is a brokerage-wide signal (one site, one set of website_visitors rows);
    // a brokerage with several territories would otherwise re-source the exact same unidentified
    // sessions once per territory, producing duplicate raw records the identity-key dedup would
    // then have to absorb for no reason. `markets` is priority-ordered
    // (lib/lead-pipeline/scrape-territories.ts), so the first market row this loop sees for a
    // brokerage is its highest-priority territory — the natural "run it once, on the best row" spot.
    const siteVisitorBrokeragesRun = new Set<string>()

    // Lane 71C — email-engagement-intent lane runs ONCE per BROKERAGE, same reasoning as
    // siteVisitorBrokeragesRun immediately above: email_tracking is a brokerage-wide signal
    // (one set of outbound sends, one engagement stream), not a per-territory one.
    const emailEngagementBrokeragesRun = new Set<string>()

    // Lane 74D — rental-to-buyer-graduation lane runs ONCE per BROKERAGE, same reasoning as
    // emailEngagementBrokeragesRun immediately above: `contacts` is a brokerage-wide table, not a
    // per-territory one — a renter contact does not belong to any one market row.
    const rentalGraduationBrokeragesRun = new Set<string>()

    for (const market of markets) {
      results.markets_processed++
      console.log(`[Lead Scraping Cron] Processing market: ${market.name} (${market.city}, ${market.state})`)

      // STEP 4 — Resolve the set of enabled sources for this territory. Expanded
      // through GATE_TOKEN so the gate matches whether the DB stored short names
      // ("facebook"), canonical keys ("facebook_group"), or aliases ("zillow").
      const enabledSources = expandEnabledSources(market.enabled_sources ?? [...DEFAULT_MARKET_SOURCES])

      // ── FREE RUNGS FIRST (wave 82 lane A) ───────────────────────────────────
      // Owner verbatim (wave 82): "osint is supposed to be a free provider for intent behavior
      // acquisition". The three $0 first-party intent lanes (site visitor, email engagement,
      // rental graduation) used to sit AFTER every paid lane and BEHIND the territory budget
      // gate — so a territory whose paid budget was spent (or a run that hit maxDuration in a
      // slow paid scraper) never read its own free behaviour signals at all. They now run
      // BEFORE the budget gate and before any paid rung: a spent budget stops the SPEND, never
      // the free lanes. Each still runs once per brokerage (the *BrokeragesRun sets above).
      // ── SITE VISITOR INTENT — wave 70 behavioral lane, $0 marginal cost ─────
      // Own first-party website/portal traffic (website_visitors, already written by the
      // pixel/dwell beacons) — an unidentified, high-dwell visitor is buyer-intent this repo
      // already collected and never read for acquisition. Runs ONCE per brokerage (see the
      // siteVisitorBrokeragesRun set above this loop) — brokerage_id passed EXPLICITLY
      // (never platform pool: this is the tenant's own site, not a scraped third-party page),
      // so it lands as source_origin='brokerage' immediately, the same shape a
      // brokerage-triggered scrape would.
      if (enabledSources.has("site_visitor_intent") && market.brokerage_id && !siteVisitorBrokeragesRun.has(market.brokerage_id)) {
        siteVisitorBrokeragesRun.add(market.brokerage_id)
        try {
          const { records, rowsExamined } = await sourceSiteVisitorIntent(supabase, market.brokerage_id)
          const { inserted: siteVisitorInserted } = await insertRawBatch({
            records, marketId: market.id,
            marketGeo: { city: market.city, state: market.state, zip_codes: market.zip_codes },
            executionId: null,
            source: "site_visitor_intent", sourceFamily: "site_behavior", sourceChannel: "site_visitor_intent",
            brokerageId: market.brokerage_id,
            // Always 0 — first-party data, no vendor call. Passed explicitly (never omitted) so
            // the kernel writer's cost_per_record stays null-not-fabricated per its own contract
            // rather than silently inheriting a stale estimate.
            batchCostUsd: 0,
          })
          results.total_leads_created += siteVisitorInserted
          if (rowsExamined > 0) {
            console.log(`[Lead Scraping Cron] Site visitor intent ${market.brokerage_id.slice(0, 8)}…: examined=${rowsExamined} inserted=${siteVisitorInserted}`)
          }
        } catch (err) {
          results.errors.push(`Site visitor intent error for brokerage ${market.brokerage_id}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      // ── EMAIL ENGAGEMENT INTENT — lane 71C behavioral lane, $0 marginal cost ─
      // Own first-party outbound-email engagement (email_tracking, already written by the
      // SendGrid events webhook) — a contact who repeatedly opens/clicks the brokerage's own
      // mail is a renewed-intent signal this repo already collected and never read for
      // acquisition. Runs ONCE per brokerage (see emailEngagementBrokeragesRun above this
      // loop), same shape as site_visitor_intent immediately above: brokerage_id passed
      // EXPLICITLY (never platform pool — this is the tenant's own send history), so it lands
      // as source_origin='brokerage' immediately.
      if (enabledSources.has("email_engagement_intent") && market.brokerage_id && !emailEngagementBrokeragesRun.has(market.brokerage_id)) {
        emailEngagementBrokeragesRun.add(market.brokerage_id)
        try {
          // WAVE 72A (owner: "contacts coming in from the tenants website or email
          // come in as contacts not raw leads."): `records` is now ALWAYS empty —
          // every email_tracking row is already a CONTACT (see the sourcer's header)
          // — so this never mints a raw lead. `contactsNotified` counts the manager
          // signals (campaign_orchestrator → ai_isa) sent directly onto those
          // contacts instead. `insertRawBatch` still no-ops safely on the empty array.
          const { records, rowsExamined, contactsNotified } = await sourceEmailEngagementIntent(supabase, market.brokerage_id)
          const { inserted: emailEngagementInserted } = await insertRawBatch({
            records, marketId: market.id,
            marketGeo: { city: market.city, state: market.state, zip_codes: market.zip_codes },
            executionId: null,
            source: "email_engagement_intent", sourceFamily: "email_behavior", sourceChannel: "email_engagement_intent",
            brokerageId: market.brokerage_id,
            // Always 0 — first-party data, no vendor call. Passed explicitly (never omitted) so
            // the kernel writer's cost_per_record stays null-not-fabricated per its own contract
            // rather than silently inheriting a stale estimate.
            batchCostUsd: 0,
          })
          results.total_leads_created += emailEngagementInserted
          if (rowsExamined > 0) {
            console.log(`[Lead Scraping Cron] Email engagement intent ${market.brokerage_id.slice(0, 8)}…: examined=${rowsExamined} inserted=${emailEngagementInserted} contactsNotified=${contactsNotified}`)
          }
        } catch (err) {
          results.errors.push(`Email engagement intent error for brokerage ${market.brokerage_id}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      // ── RENTAL-TO-BUYER GRADUATION (tenant side) — lane 74D, $0 marginal cost ─
      // A renter already in this brokerage's own `contacts` whose tenure crosses the
      // graduation bar (lib/lead-pipeline/rental-graduation-sourcer.ts). NEVER a raw lead —
      // the person is already a contact — a manager signal (shopping_agent, who owns the buyer
      // journey → ai_isa) carries the buy-vs-renew moment instead. Runs ONCE per brokerage (see
      // rentalGraduationBrokeragesRun above this loop), same shape as email_engagement_intent
      // immediately above.
      if (enabledSources.has("rental_to_buyer_graduation") && market.brokerage_id && !rentalGraduationBrokeragesRun.has(market.brokerage_id)) {
        rentalGraduationBrokeragesRun.add(market.brokerage_id)
        try {
          const { rowsExamined, contactsNotified } = await sourceRentalToBuyerGraduation(supabase, market.brokerage_id)
          if (rowsExamined > 0) {
            console.log(`[Lead Scraping Cron] Rental-to-buyer graduation ${market.brokerage_id.slice(0, 8)}…: examined=${rowsExamined} notified=${contactsNotified}`)
          }
        } catch (err) {
          results.errors.push(`Rental-to-buyer graduation error for brokerage ${market.brokerage_id}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      // STEP 3 — Budget gate: skip this territory if monthly budget is exhausted.
      if ((market.spend_this_month ?? 0) >= (market.monthly_budget_usd ?? 100)) {
        const reason = `Skipped ${market.name}: monthly budget reached ($${market.spend_this_month ?? 0} / $${market.monthly_budget_usd ?? 100})`
        console.warn(`[Lead Scraping Cron] ${reason}`)
        results.errors.push(reason)
        continue
      }


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
              // Lane 82B — the portal hosts go through the ONE provider picker (Zyte first on
              // zillow/realtor/homes/redfin per the 2026 benchmarks, ZenRows fallback) instead of a
              // hard-wired ZenRows call, and each site's spend books under its OWN source.
              const scraped = await scrapeSiteWithBestProvider(searchUrl, { jsRender: true, premiumProxy: true })
              sourceCostUsd += scraped.cost ?? 0
              await bookSourceSpend({
                source: site, cost: scraped.cost ?? 0, brokerageId: market.brokerage_id,
                marketId: market.id, providerOverride: scraped.provider,
              })

              if (scraped.ok && scraped.html) {
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
                  // ZenRows returns a per-scrape cost (scraped.cost, metered above into
                  // sourceCostUsd); the kernel spreads it across this site's records as
                  // raw_scraped_leads.cost_per_record, same as the nextdoor/social call sites.
                  batchCostUsd: scraped.cost ?? null,
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

          // Platform ledger: booked PER SITE inside the loop above (bookSourceSpend) — one row per
          // source with the provider that actually served it, never one lump "zenrows" row.
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
          let motivatedCostUsd = 0
          let expiredCostUsd = 0

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
            // Lane 82B — the cost-carrying pull: each trigger's records × the per-record search
            // price, booked per SOURCE below (batchdata_motivated vs expired_listing) and spread
            // across the batch as raw_scraped_leads.cost_per_record — both were missing (null / no
            // ledger row), so a BatchData lead's cost-per-lead read $0 and the wallet reconcile's
            // estimate for 'batchdata' never included the platform's biggest scrape.
            const motivatedPulls = await Promise.all(motivatedTriggers.map((t) => batchdata.getMotivatedSellerDataWithCost(location, [t])))
            const expiredPull = enabledSources.has("expired_listing")
              ? await batchdata.getMotivatedSellerDataWithCost(location, ["expired"])
              : { records: [], cost: 0 }
            motivatedCostUsd = motivatedPulls.reduce((sum, r) => sum + (r.cost ?? 0), 0)
            expiredCostUsd = expiredPull.cost ?? 0
            const rawSellers = [...motivatedPulls.flatMap((r) => r.records), ...expiredPull.records]
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
              // Lane 82B — the pulls' own cost (records × BATCHDATA_PROPERTY_SEARCH_RECORD_COST_USD),
              // spread per record by the kernel writer. The wallet reconcile at the end of the tick
              // still compares the ledger total against BatchData's own consumption report.
              batchCostUsd: motivatedCostUsd + expiredCostUsd,
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
            api_cost: motivatedCostUsd + expiredCostUsd,
            error_message: sourceErr?.message ?? null,
          }).eq("id", execRecord?.id)

          // Platform ledger, per source (lane 82B).
          await bookSourceSpend({ source: "batchdata_motivated", cost: motivatedCostUsd, brokerageId: market.brokerage_id, marketId: market.id })
          await bookSourceSpend({ source: "expired_listing", cost: expiredCostUsd, brokerageId: market.brokerage_id, marketId: market.id })
          territorySpendUsd += motivatedCostUsd + expiredCostUsd

          // Data Steward owns scraping health: a sustained source outage escalates to the broker.
          if (sourceErr) {
            await escalateScraperFailureIfNeeded(supabase, { scraperType: "batchdata_motivated", errorMessage: sourceErr.message })
          }

          // 2b. SMART SEARCH RECONCILE moved OUT of the per-market loop (wave 67 —
          // see the POOLED reconcile step right after this `for` loop closes). Pooling
          // by quicklist needs every active territory's want gathered FIRST so the
          // union query and the cap plan are computed once, not market-by-market.

          // ============================================
          // 2c. INCREMENTAL PROPERTY SEARCH (wave 66, task 2) — OPT-IN per market
          // ============================================
          // DISTINCT from the flat V1 pull above: cursor + Search Session so this
          // lane delivers ONLY NEW matches per (market, quicklist) lane and resumes
          // after a failed run instead of re-walking the whole result set. A market
          // must explicitly name `batchdata_incremental` in enabled_sources — this
          // never silently doubles the existing polled pull above for a market that
          // has not opted in.
          if (enabledSources.has("batchdata_incremental")) {
            try {
              const lanes = quickListSlugsFor(batchDataTriggersFor(motivatedParams.signal_types))
              for (const quicklist of lanes) {
                const r = await runIncrementalPropertySearchForMarket(supabase, market, { quicklist, lane: quicklist })
                results.total_leads_created += r.inserted
                results.errors.push(...r.errors)
              }
            } catch (e) {
              results.errors.push(`Incremental property search error for ${market.name}: ${e}`)
            }
          }
        }
      }

      // ============================================
      // 2d. ACTIVE-LISTING DISCOVERY (wave 66, task 3) — a market-wide listings feed
      // ============================================
      // Independent of the motivated-seller gate above — a territory may want
      // on-market inventory awareness without running seller-signal triggers.
      if (enabledSources.has("batchdata_active_listings")) {
        try {
          const r = await runActiveListingDiscoveryForMarket(supabase, market)
          results.errors.push(...r.errors)
          if (r.transitions > 0 || r.signalsWritten > 0) {
            console.log(`[Lead Scraping Cron] Active-listing feed ${market.name}: observed=${r.observed} transitions=${r.transitions} signals=${r.signalsWritten}`)
          }
        } catch (e) {
          results.errors.push(`Active-listing discovery error for ${market.name}: ${e}`)
        }
      }

      // ============================================
      // 2d'. CASH BUYERS (lane 82B) — INVESTOR buyers on BatchData's 'cash-buyer' quickList
      // ============================================
      // Territory-centric (the market's own city/state), buyer-side, its OWN gate token. The owner
      // on each record is the investor (mailing address = where they live/operate); records keep
      // their batch cost and book per source like every other lane.
      if (enabledSources.has("batchdata_cash_buyer") && market.city && market.state) {
        try {
          const pull = await batchdata.getMotivatedSellerDataWithCost(`${market.city}, ${market.state}`, ["cash_buyer"])
          const buyers = pull.records
            .map((r) => normalizeBatchDataRecord(r as Record<string, unknown>, market))
            .map((r) => ({ ...r, source: "batchdata_cash_buyer", intentType: "buyer" as const, behaviorType: "investor_cash_purchase", intentSignals: ["cash_buyer", "investor"] }))
            .filter(isViableRecord)
          const { inserted } = await insertRawBatch({
            records: buyers, marketId: market.id,
            marketGeo: { city: market.city, state: market.state, zip_codes: market.zip_codes },
            executionId: null,
            source: "batchdata_cash_buyer", sourceFamily: "investor_demand", sourceChannel: "batchdata_cash_buyer",
            batchCostUsd: pull.cost,
          })
          results.total_leads_created += inserted
          await bookSourceSpend({ source: "batchdata_cash_buyer", cost: pull.cost, brokerageId: market.brokerage_id, marketId: market.id })
          territorySpendUsd += pull.cost
        } catch (e) {
          results.errors.push(`Cash-buyer pull error for ${market.name}: ${e}`)
        }
      }

      // ============================================
      // 2e. BUY BOX MATCHING (wave 66, task 4) — investor demand per active listing
      // ============================================
      if (enabledSources.has("batchdata_buybox")) {
        try {
          const r = await runBuyBoxMatchingForMarket(supabase, market)
          results.total_leads_created += r.investorLeadsCreated
          results.errors.push(...r.errors)
        } catch (e) {
          results.errors.push(`Buy Box matching error for ${market.name}: ${e}`)
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
        enabledSources.has("tavily") ||
        enabledSources.has("reddit_relocation") ||
        enabledSources.has("facebook_recommend_realtor") ||
        enabledSources.has("agent_seeking_phrase_intent") ||
        enabledSources.has("realty_chatter") ||
        enabledSources.has("new_construction_intent") ||
        enabledSources.has("permit_prelisting_intent") ||
        enabledSources.has("review_acquisition_intent") ||
        enabledSources.has("facebook_marketplace") ||
        enabledSources.has("tiktok")

      // Lane 82B — AUTONOMY FIX: this block used to require configured lead_scraping_keywords, so a
      // platform with no keyword rows silently ran NONE of the territory-derived lanes below that
      // never read a keyword (Exa, Tavily, reddit_relocation, agent_seeking, new_construction,
      // permit, review, realty_chatter, LinkedIn, Google, rental, Marketplace). Keyword lanes still
      // gate on their own resolved keyword set (lane 83A: code defaults per territory — scrape-keywords.ts); everything else runs on the territory alone.
      if (socialSourcesEnabled) {
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
        // Realty-chatter (ZenRows/Zyte) spend is metered per-provider inline below, so it is
        // tracked SEPARATELY from sourceCostUsd (which feeds the single composite "apify_social"
        // ledger entry after this block) — see the realty_chatter block for why.
        let realtyChatterCostUsd = 0
        // Exa spend (buyer-intent + permit/pre-listing lanes). Wave 82 integration: lanes 82A and
        // 82B both fixed Exa being filed under Apify's name — 82A with a per-call meter here,
        // 82B through the per-source ledger (insertSocial → addSocialSpend → bookSourceSpend,
        // where SOURCE_VENDOR maps exa_buyer_intent / permit_prelisting_intent → exa). The
        // per-source ledger is the survivor (the lead-cost reconcile reads it); this only COUNTS
        // Exa spend for the execution row and the territory budget, so it is never booked twice.
        let exaCostUsd = 0
        const meterExa = async (cost: number, _usageType: string) => {
          if (cost > 0) exaCostUsd += cost
        }
        // Review-acquisition (ZenRows/Zyte) spend, same reason realtyChatterCostUsd is tracked
        // separately: metered per-provider inline in that block, not folded into sourceCostUsd's
        // composite "apify_social" ledger entry.
        let reviewAcquisitionCostUsd = 0
        // Lane 82B — spend PER SOURCE for the platform ledger (booked after the block through
        // bookSourceSpend → SOURCE_VENDOR). Replaces the composite "apify_social" row.
        const socialSpendBySource = new Map<string, number>()
        const addSocialSpend = (source: string, cost: number) => {
          if (cost > 0) socialSpendBySource.set(source, (socialSpendBySource.get(source) ?? 0) + cost)
        }
        let sourceErr: Error | null = null

        try {
          await updateScrapingJob(job.job?.id, {
            status: "running",
            started_at: new Date().toISOString(),
          })

          // Lane 83A — per-territory keyword sets (defaults ∪ this brokerage's rows), one per
          // keyword-reading source. Replaces `keywordsBySource`, which grouped EVERY brokerage's rows
          // and gated each lane on a row existing (0 rows live ⇒ none of these lanes ever ran).
          const kwMarket = { city: market.city, state: market.state, brokerage_id: market.brokerage_id }
          const kw = {
            nextdoor:    resolveSourceKeywords("nextdoor_intent", kwMarket, keywords),
            facebook:    resolveSourceKeywords("facebook_group", kwMarket, keywords),
            marketplace: resolveSourceKeywords("facebook_marketplace", kwMarket, keywords),
            instagram:   resolveSourceKeywords("instagram_intent", kwMarket, keywords),
            reddit:      resolveSourceKeywords("reddit_intent", kwMarket, keywords),
            clForSale:   resolveSourceKeywords("craigslist_fsbo", kwMarket, keywords),
            clWanted:    resolveSourceKeywords("craigslist_wanted", kwMarket, keywords),
            tiktok:      resolveSourceKeywords("tiktok_intent", kwMarket, keywords),
          }

          // motivatedParams carries facebook_group_urls and reddit_subreddits from DB
          const motivatedParams = market.lead_scraping_motivated_params?.[0]

          // STEP 4 gate + STEP 7 geography from market record
          if (enabledSources.has("nextdoor") && kw.nextdoor.terms.length > 0) {
            const nextdoorUrl = `https://nextdoor.com/search/?query=${encodeURIComponent(
              renderKeywordQuery("nextdoor_intent", kw.nextdoor.terms),
            )}&location=${encodeURIComponent(`${market.city}, ${market.state}`)}`

            const scraped = await zenrows.scrapeNextdoor(nextdoorUrl)
            sourceCostUsd += scraped.cost ?? 0
            addSocialSpend("nextdoor", scraped.cost ?? 0)
            if (scraped.success && scraped.posts) {
              // The population comes from the MATCHED keyword (social-sourcer.ts::normalizeNextdoorPost);
              // was `keyword_type === "buying_intent" ? "buyer" : "seller"` — a value the CHECK refuses.
              const ndRecords: NormalizedScrapedRecord[] = []
              for (const post of scraped.posts) {
                const rec = normalizeNextdoorPost(post as Record<string, any>, { city: market.city, state: market.state }, kw.nextdoor, nextdoorUrl)
                if (rec) ndRecords.push(rec)
              }
              const { inserted: ndInserted } = await insertRawBatch({
                records: ndRecords, marketId: market.id,
                marketGeo: { city: market.city, state: market.state, zip_codes: market.zip_codes },
                executionId: execRecord?.id ?? null,
                source: "nextdoor", sourceFamily: "social_intent", sourceChannel: "nextdoor",
                batchCostUsd: scraped.cost ?? null,
              })
              socialLeadsCreated += ndInserted
            }
          }

          const socialMarket = { city: market.city, state: market.state }
          // ONE batch call per sub-source — routes through the kernel's canonical writer
          // (ingestRawSourceBatch) instead of one insert per record.
          const insertSocial = async (records: NormalizedScrapedRecord[], channel: string, sourceFamily = "social_intent", batchCostUsd: number | null = null, bookedInline = false) => {
            // Every sub-source's spend reaches the per-source ledger map unless the caller already
            // booked it inline with the provider that served it (realty chatter / review lanes).
            if (!bookedInline) addSocialSpend(channel, batchCostUsd ?? 0)
            const { inserted } = await insertRawBatch({
              records, marketId: market.id,
              marketGeo: { city: market.city, state: market.state, zip_codes: market.zip_codes },
              executionId: execRecord?.id ?? null,
              source: channel, sourceFamily, sourceChannel: channel,
              // Wave 66C seam: the sub-source's metered cost, spread by the kernel
              // across the records as raw_scraped_leads.cost_per_record.
              batchCostUsd,
              })
            socialLeadsCreated += inserted
          }

          // ── Facebook groups (Apify) ──────────────────────────────────────────
          if (enabledSources.has("facebook") && kw.facebook.terms.length > 0) {
            const groupUrls: string[] = motivatedParams?.facebook_group_urls?.length
              ? motivatedParams.facebook_group_urls
              : [`https://www.facebook.com/groups/${market.city.toLowerCase().replace(/\s+/g, "")}realestate`]
            for (const groupUrl of groupUrls) {
              const { records, cost } = await sourceFacebook(groupUrl, kw.facebook.terms, socialMarket)
              sourceCostUsd += cost
              await insertSocial(records, "facebook", "social_intent", cost)
            }
          }

          // ── Facebook Marketplace property-for-sale (Apify) — FSBO sellers, lane 82B ──
          // Territory-centric by construction: the actor is handed the market city's own
          // Marketplace category URL; no city ⇒ no scrape.
          if (enabledSources.has("facebook_marketplace") && market.city) {
            // Lane 83A — property-for-sale category (FSBO sellers) + the territory's buyer / relocation /
            // realtor-seeking Marketplace searches in the SAME actor run.
            const { records, cost } = await sourceFacebookMarketplace(market.city, socialMarket, kw.marketplace.terms)
            sourceCostUsd += cost
            await insertSocial(records, "facebook_marketplace", "social_intent", cost)
          }

          // ── Instagram (Apify) — real-estate hashtags, buyer + seller intent ──
          if (enabledSources.has("instagram") && kw.instagram.terms.length > 0) {
            const { records, cost } = await sourceInstagram(kw.instagram.terms, socialMarket)
            sourceCostUsd += cost
            await insertSocial(records, "instagram", "social_intent", cost)
          }

          // ── Reddit communities (Apify) ───────────────────────────────────────
          if (enabledSources.has("reddit") && kw.reddit.terms.length > 0) {
            const subreddits: string[] = motivatedParams?.reddit_subreddits?.length
              ? motivatedParams.reddit_subreddits
              : [`${market.city.toLowerCase().replace(/\s+/g, "")}realestate`, "FirstTimeHomeBuyer", "moving"]
            const { records, cost } = await sourceReddit(subreddits, kw.reddit.terms, socialMarket)
            sourceCostUsd += cost
            await insertSocial(records, "reddit", "social_intent", cost)
          }

          // ── Craigslist (Apify) — for-sale (seller FSBO) + housing-wanted (buyer) ─
          // Two DISTINCT capabilities (owner ruling: never fold two sources into one) —
          // separate channels so each keeps its own attribution downstream.
          if (enabledSources.has("craigslist") && market.city) {
            // Lane 83A — Craigslist ANDs space-joined words; each lane now sends its own OR query
            // (`"by owner" | "fsbo" | …`) built from its resolved per-population keyword set.
            const forSale = await sourceCraigslist(
              market.city, renderKeywordQuery("craigslist_fsbo", kw.clForSale.terms), socialMarket,
            )
            sourceCostUsd += forSale.cost
            await insertSocial(forSale.records, "craigslist", "social_intent", forSale.cost)
            // Buyer intent: "housing wanted" / ISO posts.
            const wanted = await sourceCraigslistWanted(market.city, socialMarket, renderKeywordQuery("craigslist_wanted", kw.clWanted.terms))
            sourceCostUsd += wanted.cost
            await insertSocial(wanted.records, "craigslist_wanted", "social_intent", wanted.cost)
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
            await insertSocial(records, "google_phrase_intent", "search_signal", cost)
          }

          // ── Rental listings (Apify Craigslist 'apa') — landlord/investor sellers ─
          // Craigslist 'apa' carries a reply email (real landlord contact);
          // RentCast is property-data only (no owner contact) so it is NOT used
          // for seller leads — motivated-seller DETAILS come from BatchData /
          // OSINT / PropertyRadar.
          if (enabledSources.has("rental") && market.city) {
            const { records, cost } = await sourceRentalListings(market.city, socialMarket)
            sourceCostUsd += cost
            await insertSocial(records, "rental", "social_intent", cost)
          }

          // Expired / off-market sellers: addresses are scraped via
          // parseExpiredListings (property block) and owner DETAILS come from
          // BatchData (motivated block) / OSINT distress filings / PropertyRadar.

          // ── LinkedIn relocation posts (Apify) — inbound relocating buyers ──────
          if (enabledSources.has("linkedin")) {
            const { records, cost } = await sourceLinkedInRelocation(socialMarket)
            sourceCostUsd += cost
            await insertSocial(records, "linkedin", "social_intent", cost)
          }

          // ── Exa neural search (AI-native) — buyer-intent content across the web ─
          if (enabledSources.has("exa")) {
            const { records, cost } = await sourceExaBuyerIntent(socialMarket)
            await meterExa(cost, "exa_buyer_intent")
            await insertSocial(records, "exa", "social_intent", cost)
          }

          // ── Tavily agentic search (AI-native) — buyer / seller / investor intent ─
          if (enabledSources.has("tavily")) {
            const { records, cost } = await sourceTavilyIntent(socialMarket)
            sourceCostUsd += cost
            await insertSocial(records, "tavily", "social_intent", cost)
          }

          // ── TikTok intent (Apify, lane 83A) — territory video search → comment intent ──────
          // Two hops (social-sourcer.ts::sourceTikTokIntent), territory keyword set only; spend
          // books per source (insertSocial → addSocialSpend → bookSourceSpend, SOURCE_VENDOR apify).
          if (enabledSources.has("tiktok") && market.city && kw.tiktok.terms.length > 0) {
            const { records, cost } = await sourceTikTokIntent(socialMarket, kw.tiktok.terms)
            sourceCostUsd += cost
            await insertSocial(records, "tiktok_intent", "social_intent", cost)
          }

          // ── WAVE 65 LANES (owner ruling 2026-09-15) — each a DISTINCT capability with its
          // own sourceChannel; never merged with the look-alike lanes above. ────────────────

          // ── Reddit relocation lane — "moving to <city>" / "looking for a realtor in <city>" ─
          if (enabledSources.has("reddit_relocation")) {
            const { records, cost } = await sourceRedditRelocation(socialMarket)
            sourceCostUsd += cost
            await insertSocial(records, "reddit_relocation", "social_intent", cost)
          }

          // ── Facebook "recommend a realtor" lane ──────────────────────────────────
          if (enabledSources.has("facebook_recommend_realtor")) {
            const groupUrls: string[] = motivatedParams?.facebook_group_urls?.length
              ? motivatedParams.facebook_group_urls
              : market.city ? [`https://www.facebook.com/groups/${market.city.toLowerCase().replace(/\s+/g, "")}buysell`] : []
            const { records, cost } = await sourceFacebookRecommendRealtor(groupUrls, socialMarket)
            sourceCostUsd += cost
            await insertSocial(records, "facebook_recommend_realtor", "social_intent", cost)
          }

          // ── Agent-seeking phrase intent — cross-source (Google/Apify today) ──────
          if (enabledSources.has("agent_seeking_phrase_intent")) {
            const { records, cost } = await sourceAgentSeekingPhraseIntent(socialMarket)
            sourceCostUsd += cost
            await insertSocial(records, "agent_seeking_phrase_intent", "social_intent", cost)
          }

          // ── New-construction / builder intent — cross-source (Google/Apify today) — lane 72C ──
          // docs/lead-acquisition-coverage-2026-09.md item #23, the next coverage lane after
          // site_visitor_intent (wave 70) / email_engagement_intent (lane 71C).
          if (enabledSources.has("new_construction_intent")) {
            const { records, cost } = await sourceNewConstructionIntent(socialMarket)
            sourceCostUsd += cost
            await insertSocial(records, "new_construction_intent", "social_intent", cost)
          }

          // ── Permit / pre-listing intent (Exa) — lane 73D, owner ruling wave 73 ──────
          // "exa is good at looking for leads like permit." Territory-centric Exa search
          // for recent permits, probate/estate notices, "coming soon" chatter and
          // contractor-bid posts (lib/lead-pipeline/permit-sourcer.ts). A hit whose
          // address matches a lead/contact THIS BROKERAGE already owns is routed to the
          // existing permit-signals ATTACH path (motivated_seller_signals) instead of
          // minting a duplicate raw lead — routePermitPrelistingHits does that split
          // BEFORE insertSocial ever sees the matched records.
          if (enabledSources.has("permit_prelisting_intent")) {
            const { records, cost } = await sourcePermitPrelistingIntent(socialMarket)
            await meterExa(cost, "exa_permit_prelisting")
            const routed = await routePermitPrelistingHits({
              supabase, brokerageId: market.brokerage_id, records,
            })
            if (routed.errors.length > 0) {
              results.errors.push(...routed.errors.map((e) => `Permit attach routing error for ${market.name}: ${e}`))
            }
            if (routed.attached > 0 || routed.alreadyRecorded > 0) {
              console.log(`[Lead Scraping Cron] Permit/pre-listing ${market.name}: attached=${routed.attached} (lead=${routed.attachedByEntity.lead} contact=${routed.attachedByEntity.contact}) alreadyRecorded=${routed.alreadyRecorded} minting=${routed.toMint.length}`)
            }
            await insertSocial(routed.toMint, "permit_prelisting_intent", "search_signal", cost)
          }

          // ── Review-as-acquisition (ZenRows→Zyte + schema extraction) — lane 74D ──────
          // docs/lead-acquisition-coverage-2026-09.md item #31, the second-to-last "Missing" row.
          // Territory-honest: no configured `review_source_urls` (m652) ⇒
          // sourceReviewAcquisitionIntent returns zero records before any network call — see that
          // file's header for why this lane never guesses a profile URL the way facebook_group
          // guesses a group URL. A reviewer whose name matches a contact this brokerage already
          // owns is routed to a manager signal (contact_review_intent_reengage) BEFORE
          // insertSocial ever sees it — an owned name never mints a duplicate person.
          if (enabledSources.has("review_acquisition_intent")) {
            const reviewUrls: string[] = motivatedParams?.review_source_urls?.length
              ? motivatedParams.review_source_urls
              : []
            const { records, cost, provider } = await sourceReviewAcquisitionIntent(socialMarket, reviewUrls)
            reviewAcquisitionCostUsd += cost
            const routed = await routeReviewAcquisitionHits({ supabase, brokerageId: market.brokerage_id }, records)
            if (routed.errors.length > 0) {
              results.errors.push(...routed.errors.map((e) => `Review acquisition routing error for ${market.name}: ${e}`))
            }
            if (routed.signaled > 0 || routed.toMint.length > 0) {
              console.log(`[Lead Scraping Cron] Review acquisition ${market.name}: signaled=${routed.signaled} minting=${routed.toMint.length}`)
            }
            if (cost > 0 && provider) {
              await bookSourceSpend({
                source: "review_acquisition_intent", cost, brokerageId: market.brokerage_id,
                marketId: market.id, providerOverride: provider,
              })
            }
            await insertSocial(routed.toMint, "review_acquisition_intent", "social_intent", cost, true)
          }

          // ── Zillow/Realtor/Homes.com saved-search + "contact agent" chatter ──────
          // (ZenRows primary, Zyte fallback — lib/external/zenrows-client.ts::
          // scrapeSiteWithBestProvider). Homes.com is NEW coverage this wave. Each site keeps
          // its OWN sourceChannel (owner ruling: never merge look-alike lanes). Metered
          // SEPARATELY per real provider below (not folded into sourceCostUsd) so the "apify_social"
          // composite ledger entry after this block never double-counts ZenRows/Zyte spend.
          if (enabledSources.has("realty_chatter") && market.city && market.state) {
            for (const site of ["zillow", "realtor", "homes"] as const) {
              const chatter = await sourceRealtySiteChatter(site, { city: market.city, state: market.state })
              realtyChatterCostUsd += chatter.cost
              await insertSocial(chatter.records, `${site}_chatter`, "social_intent", chatter.cost, true)
              if (chatter.cost > 0) {
                await bookSourceSpend({
                  source: `${site}_chatter`, cost: chatter.cost, brokerageId: market.brokerage_id,
                  marketId: market.id, providerOverride: chatter.provider ?? "zenrows",
                })
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
          api_cost: sourceCostUsd + realtyChatterCostUsd + reviewAcquisitionCostUsd + exaCostUsd,
          error_message: sourceErr?.message ?? null,
        }).eq("id", execRecord?.id).then(() => {}, () => {})

        // Data Steward owns scraping health: a sustained source outage escalates to the broker.
        if (sourceErr) {
          await escalateScraperFailureIfNeeded(supabase, { scraperType: "social_intent", errorMessage: sourceErr.message })
        }

        // Platform ledger, PER SOURCE (lane 82B): each sub-source books under the vendor
        // SOURCE_VENDOR names for it (Apify / Exa / Tavily / ZenRows-Nextdoor) with usage_type =
        // its SourceKey. Was ONE composite "apify_social" row that no lead-cost report could split.
        for (const [source, cost] of socialSpendBySource) {
          await bookSourceSpend({ source, cost, brokerageId: market.brokerage_id, marketId: market.id })
        }

        // realtyChatterCostUsd / reviewAcquisitionCostUsd were already metered per-provider above
        // (ZenRows/Zyte, not Apify) — add them to the territory total here so budget tracking
        // still sees the full spend.
        territorySpendUsd += sourceCostUsd + realtyChatterCostUsd + reviewAcquisitionCostUsd + exaCostUsd
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
          await bookSourceSpend({ source: "osint_signal", cost, brokerageId: market.brokerage_id, marketId: market.id })
          const { inserted: osintInserted } = await insertRawBatch({
            records, marketId: market.id,
            marketGeo: { city: market.city, state: market.state, zip_codes: market.zip_codes },
            executionId: null,
            source: "osint_signal", sourceFamily: "distressed_signal", sourceChannel: "osint_signal",
            // Lane 82B — the public-records call's cost reaches cost_per_record (was left null).
            batchCostUsd: cost,
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

    // ============================================
    // 2b. SMART SEARCH RECONCILE (V2 Property Subscription) — POOLED BY QUICKLIST
    // ============================================
    // WAVE 67 REBUILD of wave 66's per-market reconcile (moved out of the market
    // loop above — pooling needs every active territory's want gathered FIRST).
    // Owner ruling ("how can we get around the caps"): BatchData caps Property
    // Subscription at 5 PER ACCOUNT — pooling by market×quicklist wastes the cap on
    // territory count; pooling by QUICKLIST spends it on the number of DISTINCT
    // quicklists instead; 5 slots then cover 5 quicklists PLATFORM-WIDE no matter how
    // many territories want each one. searchCriteria.query becomes the UNION of every
    // contributing territory's geography (buildPooledSmartSearchQuery — syntax
    // unresolved, see that function's own comment). The per-market row in
    // batchdata_smart_search_subscriptions survives as a MEMBERSHIP row: every
    // territory that contributed to a pooled subscription gets its own row sharing
    // that subscription's id, with pool_key/pooled/geography_count (m637) recording
    // which pool it belongs to and how many territories are in it.
    //
    // Best-effort: a subscription failure never blocks or fails the poll-based scrape
    // above, which is the capability that actually produces leads today.
    //
    // SUBSCRIPTIONS ARE IMMUTABLE (documented) — an `active` pooled row is left alone
    // indefinitely UNLESS its membership changed (a territory joined or left the pool
    // since the last reconcile, detected by comparing `geography_count`) or NO
    // territory wants it anymore, either of which forces a delete-then-recreate
    // (burning no extra slot — the old id frees its slot before the new one claims it).
    try {
      const geosByQuicklist = new Map<string, Array<{ marketId: string; priority: number; city: string | null; state: string; zip: string | null }>>()
      for (const m of markets) {
        if ((m.spend_this_month ?? 0) >= (m.monthly_budget_usd ?? 100)) continue
        const mSources = expandEnabledSources(m.enabled_sources ?? [...DEFAULT_MARKET_SOURCES])
        if (!mSources.has("batchdata_motivated")) continue
        const mMotivated = m.lead_scraping_motivated_params?.[0]
        if (!mMotivated?.is_active) continue
        const quicklists = quickListSlugsFor(batchDataTriggersFor(mMotivated.signal_types))
        for (const quicklist of quicklists) {
          const list = geosByQuicklist.get(quicklist) ?? []
          list.push({ marketId: m.id, priority: m.priority ?? 0, city: m.city ?? null, state: m.state, zip: null })
          geosByQuicklist.set(quicklist, list)
        }
      }
      const wants = Array.from(geosByQuicklist.entries()).map(([quicklist, geographies]) => ({ quicklist, geographies }))

      const { data: existingSubs, error: existingSubsErr } = await supabase
        .from("batchdata_smart_search_subscriptions")
        .select("market_id, quicklist, status, subscription_id, geography_count")
      if (existingSubsErr) {
        // Table not yet applied (m633/m635/m637) or another read refusal — never treat
        // "couldn't read" as "nothing subscribed"; skip the whole pooled reconcile pass
        // this run rather than risk a duplicate registration.
        throw new Error(`smart-search subscription read refused: ${existingSubsErr.message}`)
      }
      const rows = (existingSubs ?? []) as Array<{ market_id: string; quicklist: string; status: string; subscription_id: string | null; geography_count: number | null }>

      // One representative row per quicklist tells us the pooled subscription's id
      // and how many territories it currently claims to cover.
      const activeByQuicklist = new Map<string, { subscriptionId: string; geographyCount: number }>()
      for (const r of rows) {
        if (r.status === "active" && r.subscription_id) {
          activeByQuicklist.set(r.quicklist, { subscriptionId: r.subscription_id, geographyCount: r.geography_count ?? 1 })
        }
      }

      // Membership drift (geography count changed) → delete first, subscriptions are
      // immutable. Freed slot is picked up by the plan below under the SAME quicklist.
      for (const w of wants) {
        const active = activeByQuicklist.get(w.quicklist)
        if (active && active.geographyCount !== w.geographies.length) {
          const del = await deleteSmartSearchSubscription(active.subscriptionId)
          if (del.ok) smartSearchAccountLiveCount = Math.max(0, smartSearchAccountLiveCount - 1)
          await supabase.from("batchdata_smart_search_subscriptions")
            .update({ status: "cancelled", last_error: del.ok ? "superseded by pooled membership change" : `delete failed: ${del.error}`, updated_at: new Date().toISOString() })
            .eq("quicklist", w.quicklist).eq("status", "active")
          activeByQuicklist.delete(w.quicklist)
        }
      }
      // No territory wants this quicklist anymore → delete + cancel every membership row.
      for (const [quicklist, active] of activeByQuicklist) {
        if (!wants.some((w) => w.quicklist === quicklist)) {
          const del = await deleteSmartSearchSubscription(active.subscriptionId)
          if (del.ok) smartSearchAccountLiveCount = Math.max(0, smartSearchAccountLiveCount - 1)
          await supabase.from("batchdata_smart_search_subscriptions")
            .update({ status: "cancelled", last_error: del.ok ? "no active territory wants this quicklist anymore" : `delete failed: ${del.error}`, updated_at: new Date().toISOString() })
            .eq("quicklist", quicklist).eq("status", "active")
        }
      }

      const alreadyActive = new Set(
        wants.filter((w) => {
          const active = activeByQuicklist.get(w.quicklist)
          return !!active && active.geographyCount === w.geographies.length
        }).map((w) => w.quicklist),
      )

      const plan = buildSmartSearchSubscriptionPlan({ wants, alreadyActive, accountLiveCount: smartSearchAccountLiveCount })

      for (const entry of plan) {
        if (entry.action === "keep") continue
        if (entry.action === "defer") {
          for (const g of entry.geographies) {
            await supabase.from("batchdata_smart_search_subscriptions").upsert(
              {
                market_id: g.marketId, quicklist: entry.quicklist, status: "deferred",
                webhook_url: process.env.BATCHDATA_SMART_SEARCH_WEBHOOK_URL ?? "",
                last_error: entry.reason, priority: g.priority,
                pool_key: entry.quicklist, pooled: true, geography_count: entry.geographies.length,
                last_reconciled_at: new Date().toISOString(), updated_at: new Date().toISOString(),
              },
              { onConflict: "market_id,quicklist" },
            )
          }
          continue
        }
        // action === "create" — only reached when the plan already confirmed a slot is
        // free. ONE provider call for the whole pool; every contributing territory
        // then gets its own membership row against the same subscription id.
        const result = await createSmartSearchSubscription({
          quicklist: entry.quicklist,
          geographies: entry.geographies.map((g) => ({ city: g.city, state: g.state, zip: g.zip })),
        })
        if (result.ok) smartSearchAccountLiveCount++
        const status = result.ok ? "active" : result.provisioningRequired ? "provisioning_required" : "error"
        for (const g of entry.geographies) {
          const { error: upsertErr } = await supabase
            .from("batchdata_smart_search_subscriptions")
            .upsert(
              {
                market_id: g.marketId, quicklist: entry.quicklist,
                subscription_id: result.subscriptionId, status,
                webhook_url: process.env.BATCHDATA_SMART_SEARCH_WEBHOOK_URL ?? "",
                last_error: result.error, priority: g.priority,
                pool_key: entry.quicklist, pooled: true, geography_count: entry.geographies.length,
                last_reconciled_at: new Date().toISOString(),
                ...(result.ok ? { renewed_at: new Date().toISOString() } : {}),
                updated_at: new Date().toISOString(),
              },
              { onConflict: "market_id,quicklist" },
            )
          if (upsertErr) {
            results.errors.push(`Smart Search pooled subscription write failed for ${entry.quicklist}/${g.marketId}: ${upsertErr.message}`)
          }
        }
      }
    } catch (smartSearchErr) {
      // Best-effort side-channel — logged, never fails the cron run.
      results.errors.push(`Smart Search pooled reconcile error: ${smartSearchErr}`)
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

    // ── WALLET RECONCILE (wave 66, task 6) — spend MEASURED, not estimated ──
    // Once per run (not per market/brokerage — BatchData's wallet is ONE
    // account-wide balance): sums this month's own vendor_usage_tracking
    // estimate for vendor 'batchdata' and compares it to BatchData's own
    // wallet consumption report, filing a low-severity ops row when the two
    // drift past a noise threshold. Best-effort — never fails the cron.
    try {
      const startOfMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString()
      const { data: spendRows } = await supabase
        .from("vendor_usage_tracking")
        .select("total_cost")
        .eq("vendor_name", "batchdata")
        .gte("created_at", startOfMonth)
      const estimatedSpendThisMonthUsd = (spendRows ?? []).reduce((s: number, r: any) => s + (Number(r.total_cost) || 0), 0)
      const { reconcileBatchDataWalletSpend } = await import("@/lib/external/batchdata-client")
      const reconcile = await reconcileBatchDataWalletSpend({ brokerageId: null, estimatedSpendThisMonthUsd })
      if (reconcile.flagged) {
        results.errors.push(`BatchData wallet drift flagged: wallet=$${reconcile.walletTotalUsd} estimate=$${reconcile.estimatedTotalUsd.toFixed(2)}`)
      }
    } catch (e) {
      results.errors.push(`BatchData wallet reconcile skipped: ${e}`)
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
  /** Metered vendor cost of THIS batch (wave 66C seam) — the kernel spreads it
   *  across the records as raw_scraped_leads.cost_per_record. Never a body value. */
  batchCostUsd?: number | null
  /** Batch label for scraper_executions.scraper_type + lifecycle metadata,
   *  e.g. "facebook", "batchdata_motivated", "osint_signal" — kept DISTINCT
   *  per source (owner ruling: never fold two scraping capabilities into one). */
  source: string
  sourceFamily: string
  sourceChannel: string
  sourceSubtype?: string
  /** Wave 70 seam: every source here is PLATFORM-owned (brokerage_id null) by default — see the
   *  header above. A source whose signal is INHERENTLY brokerage-specific (site_visitor_intent —
   *  the tenant's own website traffic; nobody else's site produced it) passes its market's
   *  brokerage_id explicitly instead, which ingestRawSourceBatch resolves to
   *  raw_scraped_leads.source_origin = 'brokerage'. Omit (undefined) to keep the platform-pool
   *  default every other call site here already relies on. */
  brokerageId?: string | null
}

async function insertRawBatch(params: InsertRawBatchParams): Promise<{ inserted: number; rawIds: string[] }> {
  if (params.records.length === 0) return { inserted: 0, rawIds: [] }

  const res = await ingestRawSourceBatch({
    brokerageId:   params.brokerageId ?? null,
    marketId:      params.marketId,
    source:        params.source,
    sourceFamily:  params.sourceFamily,
    sourceChannel: params.sourceChannel,
    sourceSubtype: params.sourceSubtype,
    records:       params.records,
    executionId:   params.executionId ?? null,
    batchCostUsd:  params.batchCostUsd ?? null,
    marketGeo:     params.marketGeo ?? null,
  })

  return { inserted: res.inserted, rawIds: res.rawIds }
}
