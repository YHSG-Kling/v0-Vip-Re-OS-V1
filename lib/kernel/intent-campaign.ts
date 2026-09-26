// lib/kernel/intent-campaign.ts
//
// THE INTENT CAMPAIGN — the Data Steward leads the outbound growth engine. Instead of
// blasting a generic farm, the Steward SCRAPES who's actually about to move and the
// bench writes to their SITUATION:
//
//   · SELLERS — BatchData motivated-seller signals (high-equity / pre-foreclosure /
//     absentee / vacant) in the brokerage's active markets → a situation-specific
//     direct-mail + email ("homes like yours in {area} with {situation} are selling
//     fast — here's what yours could fetch")
//   · BUYERS — the brokerage's own high-intent buyer contacts (intent_score hot, active
//     recently) → an email to their search ("still looking in {area}? new matches this
//     week, here's what's moving")
//   · Campaign Orchestrator proposes ONE agent summary tying it together.
//
// The seller scrape is an injectable seam (real BatchData in prod; no spend in tests).
// Everything lands gated in its channel; nothing sends. NOT server-only.

import { createServiceClient } from "@/lib/supabase/service"
import { collectError } from "@/lib/errors/collect-error"

type Svc = ReturnType<typeof createServiceClient>

/** Injectable seam: how many motivated sellers in this market (BatchData). */
export type SellerScraper = (params: { city: string; state: string | null; motivationTypes: string[] })
  => Promise<{ recordsFound: number }>

export const realSellerScraper: SellerScraper = async (params) => {
  const { fetchMotivatedSellers } = await import("@/lib/external/batchdata-client")
  const r = await fetchMotivatedSellers({
    state: params.state ?? "", city: params.city, motivationTypes: params.motivationTypes,
  }).catch(() => ({ recordsFound: 0 }))
  return { recordsFound: (r as { recordsFound?: number }).recordsFound ?? 0 }
}

/** Injectable seam: NEW buyers showing online intent (Exa neural search), distinct from
 *  the brokerage's own contacts — this is buyer ACQUISITION. */
export type BuyerIntentScraper = (params: { city: string; state: string | null })
  => Promise<{ recordsFound: number }>

export const realBuyerIntentScraper: BuyerIntentScraper = async (params) => {
  const { sourceExaBuyerIntent } = await import("@/lib/lead-pipeline/exa-sourcer")
  const r = await sourceExaBuyerIntent({ city: params.city, state: params.state ?? "" } as any).catch(() => ({ records: [] as unknown[] }))
  return { recordsFound: ((r as { records?: unknown[] }).records ?? []).length }
}

/** Below this intent_score a buyer is not "showing intent" enough for outbound. */
export const BUYER_INTENT_THRESHOLD = 70

/** Pure: the seller situation copy — names the area + the motivation, no fabrication. */
export function composeSellerIntent(area: string, count: number, motivationTypes: string[]): { subject: string; body: string } {
  const sit = motivationTypes.includes("high_equity") ? "with strong equity"
    : motivationTypes.includes("absentee") ? "owned by out-of-area landlords"
    : "in changing circumstances"
  return {
    subject: `${count} homes in ${area} like yours are moving`,
    body: `We're tracking ${count} homes in ${area} ${sit} that are positioned to sell well right now. If you've thought about what yours could fetch in today's market, we'll put together a no-pressure valuation and a plan — no obligation.`,
  }
}

/** Pure: the buyer intent copy — speaks to an active searcher. */
export function composeBuyerIntent(area: string | null, count: number): { subject: string; body: string } {
  return {
    subject: `Still looking${area ? ` in ${area}` : ""}? Here's what's moving`,
    body: `You've been active in your search lately, so here's a quick pulse: ${count > 0 ? `${count} new or improved matches` : "fresh inventory"} just came up${area ? ` around ${area}` : ""}. Reply and I'll line up private tours on the ones worth your time.`,
  }
}

export interface IntentCampaignResult {
  markets: number
  sellersFound: number
  sellerChannels: number
  /** NEW buyers discovered via Exa online-intent search (acquisition). */
  newBuyersFound: number
  buyerSegments: number
  buyerChannels: number
  summariesProposed: number
}

const DEFAULT_MOTIVATIONS = ["high_equity", "absentee", "pre_foreclosure"]

/**
 * One intent-campaign pass for a brokerage: scrape motivated sellers in active markets +
 * find high-intent buyers, stage situation-specific multi-channel drafts (gated), and
 * propose one agent summary. Idempotent per market per week (campaign_name keyed).
 */
export async function runIntentCampaign(
  brokerageId: string,
  opts: { now?: Date; sellerScraper?: SellerScraper; buyerIntentScraper?: BuyerIntentScraper; copyGenerator?: import("@/lib/kernel/ai-copy").CopyGenerator; maxMarkets?: number } = {},
  client?: Svc,
): Promise<IntentCampaignResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const scraper = opts.sellerScraper ?? realSellerScraper
  const buyerScraper = opts.buyerIntentScraper ?? realBuyerIntentScraper
  const maxMarkets = opts.maxMarkets ?? 2
  const result: IntentCampaignResult = {
    markets: 0, sellersFound: 0, sellerChannels: 0, newBuyersFound: 0, buyerSegments: 0, buyerChannels: 0, summariesProposed: 0,
  }
  const weekStamp = now.toISOString().slice(0, 10)
  const { stageBenchDrafts } = await import("@/lib/kernel/marketing-bench")
  const { generatePersonaCopy } = await import("@/lib/kernel/ai-copy")

  // A representative agent for the bench rows (brokerage-level campaign).
  const { data: anyAgent } = await supabase.from("agents").select("id, user_id")
    .eq("brokerage_id", brokerageId).not("user_id", "is", null).limit(1).maybeSingle()
  const agentRowId = (anyAgent as any)?.id ?? null
  const agentUserId = (anyAgent as any)?.user_id ?? null

  // The brokerage's active markets — distinct cities/states from active listings.
  const { data: listings } = await supabase.from("listings")
    .select("city, state").eq("brokerage_id", brokerageId).in("status", ["active", "coming_soon"]).limit(500)
  const markets = Array.from(new Map(((listings ?? []) as any[])
    .filter((l) => l.city).map((l) => [String(l.city).toLowerCase(), { city: l.city as string, state: (l.state ?? null) as string | null }])).values()).slice(0, maxMarkets)

  // ── SELLER side: scrape motivated sellers per market → situation-specific drafts. ──
  for (const m of markets) {
    result.markets += 1
    const found = await scraper({ city: m.city, state: m.state, motivationTypes: DEFAULT_MOTIVATIONS }).catch(() => ({ recordsFound: 0 }))
    if (found.recordsFound <= 0) continue
    result.sellersFound += found.recordsFound
    const fb = composeSellerIntent(m.city, found.recordsFound, DEFAULT_MOTIVATIONS)
    const copy = await generatePersonaCopy(
      { goal: "outreach to a motivated homeowner about selling", channel: "direct_mail",
        facts: [`${found.recordsFound} homes like theirs in ${m.city} are positioned to sell well now`, "We offer a no-pressure valuation and plan"],
        persona: { audience: "seller", situation: "a motivated homeowner (equity / circumstances)" }, words: 55 },
      fb, { generator: opts.copyGenerator })
    const b = await stageBenchDrafts({ brokerageId, agentRowId, agentUserId, listingId: null }, [
      { channel: "direct_mail", idemName: `Intent Sellers ${m.city} ${weekStamp}`, subject: copy.subject ?? fb.subject, body: copy.body, mailAudience: "motivated_sellers", brief: `INTENT CAMPAIGN — ${found.recordsFound} motivated sellers scraped in ${m.city}` },
      { channel: "email", idemName: `Intent Sellers Email ${m.city} ${weekStamp}`, subject: copy.subject ?? fb.subject, body: copy.body, brief: `INTENT CAMPAIGN — motivated sellers in ${m.city}` },
    ], supabase)
    result.sellerChannels += b.staged.length

    // NEW BUYERS — Exa online-intent search finds buyers NOT yet in our CRM (acquisition).
    const newBuyers = await buyerScraper({ city: m.city, state: m.state }).catch(() => ({ recordsFound: 0 }))
    result.newBuyersFound += newBuyers.recordsFound
  }

  // ── BUYER side: the brokerage's own high-intent buyers → an email to their search. ──
  const { data: buyers } = await supabase.from("contacts")
    .select("id, buyer_stage, intent_score, updated_at, nurture_status").eq("brokerage_id", brokerageId)
    .eq("contact_type", "buyer").gte("intent_score", BUYER_INTENT_THRESHOLD)
    .gte("updated_at", new Date(now.getTime() - 30 * 86_400_000).toISOString()).limit(500)
  const hotBuyers = ((buyers ?? []) as any[]).filter((b) => b.nurture_status !== "withdrawn")
  if (hotBuyers.length > 0) {
    result.buyerSegments += 1
    const area = markets[0]?.city ?? null
    const fb = composeBuyerIntent(area, hotBuyers.length)
    const copy = await generatePersonaCopy(
      { goal: "an email to an active buyer about fresh inventory in their search area", channel: "email",
        facts: [`${hotBuyers.length > 0 ? "New or improved matches" : "Fresh inventory"} just came up${area ? ` around ${area}` : ""}`, "We can line up private tours"],
        persona: { audience: "buyer", situation: "actively searching, showing recent intent" }, words: 55 },
      fb, { generator: opts.copyGenerator })
    const b = await stageBenchDrafts({ brokerageId, agentRowId, agentUserId, listingId: null }, [
      { channel: "email", idemName: `Intent Buyers ${area ?? "all"} ${weekStamp}`, subject: copy.subject ?? fb.subject, body: copy.body, brief: `INTENT CAMPAIGN — ${hotBuyers.length} high-intent buyers (score ≥ ${BUYER_INTENT_THRESHOLD})` },
    ], supabase)
    result.buyerChannels += b.staged.length
  }

  // ── Campaign Orchestrator: one agent summary into the gate. ──
  if ((result.sellerChannels + result.buyerChannels) > 0 && agentUserId) {
    const { data: existing } = await supabase.from("agent_client_messages").select("id")
      .eq("brokerage_id", brokerageId).ilike("rationale", "INTENT CAMPAIGN%")
      .gte("proposed_at", new Date(now.getTime() - 6 * 86_400_000).toISOString()).limit(1).maybeSingle()
    if (!existing) {
      const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
      const res = await proposeClientMessage({
        brokerageId, agentKind: "data_steward", entityType: "contact", audience: "agent",
        subject: `🎯 Intent campaign staged — ${result.sellersFound} motivated sellers, ${result.newBuyersFound} new buyers, ${hotBuyers.length} hot buyers`,
        body: `The Data Steward scraped your markets: ${result.sellersFound} motivated-seller signals + ${result.newBuyersFound} NEW buyers showing online intent (Exa) across ${result.markets} area${result.markets === 1 ? "" : "s"}, plus ${hotBuyers.length} of your own buyers active recently. Situation-specific, persona-written email + direct mail are drafted across the channels — review and approve.`,
        rationale: `INTENT CAMPAIGN — Data Steward scraped motivated sellers (BatchData) + new buyers (Exa) + high-intent contacts; bench staged persona-written multi-channel drafts; all gated.`,
        channel: "portal",
      }, supabase)
      if (res.ok) result.summariesProposed += 1
    }
  }

  return result
}

// ────────────────────────────────────────────────────────────────────────────
// TERRITORY-CENTRIC INTELLIGENCE PHASE (wave 65A)
//
// BUILT (orphan doctrine §1.2): the five lead-intelligence scrapers in
// app/actions/lead-intelligence.ts (scrapeSocialSignalsWithZenRows,
// scrapeExternalBehavior, analyzeGoogleSearchIntent, trackExternalActivity,
// enrichPropertyIntelligence) were orphan exports — reachable only from a
// browser session that never called them. Owner ruling (2026-09-15): "this OS
// runs autonomous loops; every capability should run autonomously… rather than
// waiting for a button." This is that loop, folded into the EXISTING daily
// intent-campaign tick per the wave-65 instruction ("no new cron") rather than
// a sixth scraping cron. Owner: data_steward (the same manager that already
// runs runIntentCampaign, above).
//
// TERRITORY-CENTRIC (wave 65 ruling): the ONLY areas ever touched are the
// active-subscriber territories resolveActiveScrapeTerritories returns — no
// active subscribers / no active territories → an honest no-op, never a
// fallback to fixed geography.
// ────────────────────────────────────────────────────────────────────────────

/** Bounds spend per tick — mirrors runIntentCampaign's own maxMarkets default (2) above. */
const MAX_TERRITORIES_PER_TICK = 3

export interface TerritoryIntelligenceResult {
  territoriesProcessed: number
  nextdoorRawIngested: number
  externalBehaviorRawIngested: number
  googleSearchesSampled: number
  propertiesEnriched: number
  visitorActivitiesLinked: number
  errors: number
  noOpReason: string | null
}

/**
 * One pass of the territory-centric intelligence phase: for each ACTIVE tenant
 * territory, run the five lead-intelligence scrapers as the AUTONOMOUS CRON
 * ACTOR (never a body-supplied brokerage — each call is scoped to the
 * territory's own owning brokerage, proven by CRON_SECRET, CLAUDE.md §4).
 * Every call goes through app/actions/lead-intelligence.ts's own territory +
 * vendor-budget gates a second time (defense in depth — this phase does not
 * bypass them by calling a private helper).
 */
export async function runTerritoryIntelligencePhase(
  client?: Svc,
): Promise<TerritoryIntelligenceResult> {
  const supabase = client ?? createServiceClient()
  const result: TerritoryIntelligenceResult = {
    territoriesProcessed: 0, nextdoorRawIngested: 0, externalBehaviorRawIngested: 0,
    googleSearchesSampled: 0, propertiesEnriched: 0, visitorActivitiesLinked: 0, errors: 0,
    noOpReason: null,
  }

  // FAIL CLOSED (CLAUDE.md §4): without CRON_SECRET the cron actor cannot prove
  // itself to app/actions/lead-intelligence.ts's requireCallerOrCron, and this
  // phase must not silently do nothing while looking like it ran.
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    result.noOpReason = "cron_secret_not_configured"
    await collectError({
      workflowName: "intent_campaign_territory_intelligence",
      errorMessage: "CRON_SECRET is not configured — the territory-intelligence phase refused to run rather than call the scrapers unauthenticated.",
      severity: "medium",
    })
    return result
  }

  const { resolveActiveScrapeTerritories } = await import("@/lib/lead-pipeline/scrape-territories")
  const resolution = await resolveActiveScrapeTerritories(supabase)
  if (resolution.noOp) {
    result.noOpReason = resolution.reason
    return result
  }

  const {
    scrapeSocialSignalsWithZenRows, scrapeExternalBehavior, analyzeGoogleSearchIntent,
    trackExternalActivity, enrichPropertyIntelligence,
  } = await import("@/app/actions/lead-intelligence")

  for (const territory of (resolution.territories as any[]).slice(0, MAX_TERRITORIES_PER_TICK)) {
    if (!territory.brokerage_id || !territory.city) continue
    result.territoriesProcessed += 1
    const location = { city: territory.city as string, state: (territory.state as string) ?? "", zip: territory.zip_codes?.[0] as string | undefined }
    const opts = { internalSecret: cronSecret, brokerageId: territory.brokerage_id as string }

    try {
      const nextdoor = await scrapeSocialSignalsWithZenRows(location, opts)
      result.nextdoorRawIngested += (nextdoor as any)?.rawIngested ?? 0
    } catch (e) {
      result.errors += 1
      await collectError({ workflowName: "intent_campaign_territory_intelligence", errorMessage: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined, severity: "low", brokerageId: territory.brokerage_id, context: { phase: "nextdoor", territoryId: territory.id } })
    }

    let discoveredAddresses: string[] = []
    try {
      const external = await scrapeExternalBehavior(location, opts)
      result.externalBehaviorRawIngested += (external as any)?.rawIngested ?? 0
      discoveredAddresses = ((external as any)?.discoveredAddresses ?? []) as string[]
    } catch (e) {
      result.errors += 1
      await collectError({ workflowName: "intent_campaign_territory_intelligence", errorMessage: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined, severity: "low", brokerageId: territory.brokerage_id, context: { phase: "external_behavior", territoryId: territory.id } })
    }

    // Enrich ONE newly-discovered address per territory per tick (bounds spend;
    // BatchData already ran once per address inside scrapeExternalBehavior —
    // this adds the vision/street-view pass enrichPropertyIntelligence alone does).
    const firstAddress = discoveredAddresses[0]
    if (firstAddress) {
      try {
        const enrich = await enrichPropertyIntelligence(
          { address: firstAddress, city: location.city, state: location.state, zip: location.zip ?? "" },
          opts,
        )
        if ((enrich as any)?.success) result.propertiesEnriched += 1
      } catch (e) {
        result.errors += 1
        await collectError({ workflowName: "intent_campaign_territory_intelligence", errorMessage: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined, severity: "low", brokerageId: territory.brokerage_id, context: { phase: "enrich_property", territoryId: territory.id, address: firstAddress } })
      }

      // Attach the newly-discovered off-site listing to visitors this brokerage
      // ALREADY has a behavioral_signals row for, located in the SAME territory —
      // connecting on-site browsing to off-site inventory without inventing a
      // new identity (trackExternalActivity's own contract: an EXISTING visitor).
      try {
        const { data: signals } = await supabase
          .from("behavioral_signals")
          .select("visitor_id")
          .eq("brokerage_id", territory.brokerage_id)
          .ilike("city", location.city)
          .limit(5)
        for (const s of (signals ?? []) as Array<{ visitor_id: string }>) {
          const track = await trackExternalActivity(
            { visitorId: s.visitor_id, source: "zillow", behaviorType: "off_site_listing_match", propertyAddress: firstAddress, location: location.city, detectedViaZenrows: false },
            opts,
          )
          if ((track as any)?.success) result.visitorActivitiesLinked += 1
        }
      } catch (e) {
        result.errors += 1
        await collectError({ workflowName: "intent_campaign_territory_intelligence", errorMessage: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined, severity: "low", brokerageId: territory.brokerage_id, context: { phase: "track_external_activity", territoryId: territory.id } })
      }
    }

    try {
      const google = await analyzeGoogleSearchIntent({ id: territory.id, city: location.city, state: location.state, zip: location.zip }, opts)
      if ((google as any)?.success) result.googleSearchesSampled += 1
    } catch (e) {
      result.errors += 1
      await collectError({ workflowName: "intent_campaign_territory_intelligence", errorMessage: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined, severity: "low", brokerageId: territory.brokerage_id, context: { phase: "google_intent", territoryId: territory.id } })
    }
  }

  return result
}
