"use server"

/**
 * Lead-intelligence actions — visitor-session + scraped-signal model.
 *
 * SCHEMA: verified column-for-column against the live Supabase schema
 * (project hrvaqgvukzxfskkcrwbt) on 2026-06-23. The session/scoring tables this
 * file writes were migrated forward to match this code, so the writes persist:
 *   behavioral_signals   → visitor_id, ip_address, user_agent, city/state/zip,
 *                          total_sessions, last_seen_date, intent_type,
 *                          intent_confidence_score, unified_profile_id, identified
 *   site_activity        → behavioral_signal_id, page_visited,
 *                          time_on_page_seconds, action_taken, search_terms
 *   external_behavior    → behavioral_signal_id, source, activity_type,
 *                          property_addresses_viewed, location,
 *                          detected_interest_level, detected_via_zenrows, scraped_at
 *   social_intelligence  → source, post_url, post_content, author_name,
 *                          posted_date, location_city/state/zip, ai_intent_score,
 *                          intent_summary, urgency_level, keywords
 *   google_search_intelligence → search_query, detected_location,
 *                          related_searches, trend, potential_leads_count, scraped_at
 *   property_intelligence → property_address, city/state/zip + attribute columns
 *   motivated_seller_signals → lead_id, signal_type, signal_strength,
 *                          signal_details, detected_via
 *   intelligence_signals_log / intelligent_outreach_log / unified_lead_profile →
 *                          all match live.
 *
 * (An earlier header here warned these writes were drifted; that warning was
 *  stale — the migrations had since landed. Re-verify against live before
 *  changing any column name here, not against that old note.)
 *
 * Every function is auth-gated (requireCaller / requirePermission) and stamps
 * brokerage_id from the session so a caller can never burn paid AI/scraper
 * budget unauthenticated or write across tenants.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { STANDARD_TIMELINES, type StandardTimeline } from "@/constants/crm-standards"
import { requirePermission } from "@/lib/security"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { revalidatePath } from "next/cache"
import { ZenrowsClient, BatchDataClient, PeopleDataClient } from "@/lib/external"
import { IDXBrokerClient } from "@/lib/idxbroker-client"
import { OSINTClient } from "@/lib/osint-client"
import { calculateLeadScore } from "@/lib/services/lead-management.service"
import { isValidUUID } from "@/lib/validations"

// Previously every function in this file (except `trackBehavior`, which is
// a legitimate public visitor-tracking pixel) was unauthenticated. Some
// returned brokerage-scoped lead intelligence (unified_lead_profile,
// social_intelligence) cross-tenant; others ran paid scrapers (ZenRows,
// BatchData) on caller-supplied locations, draining budget.
//
// trackBehavior + scrapeSocialSignalsWithZenRows / scrapeExternalBehavior /
// fetchMotivatedSellers / analyzeGoogleSearchIntent / enrichPropertyIntelligence
// (cron / system data-augmentation functions) need only an auth gate to
// prevent unauthenticated triggering. The dashboard-facing reads also need
// brokerage scoping on the two tables that carry a brokerage_id column
// (unified_lead_profile, social_intelligence).
async function requireCaller(): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const { data: u } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: "Unauthorized" }
  return { ok: true, userId: user.id, brokerageId: u.brokerage_id }
}

export async function trackBehavior(sessionData: {
  visitor_id: string
  page_visited: string
  time_spent: number
  action_taken?: string
  search_terms?: string[]
  calculator_inputs?: any
  ip_address?: string
  user_agent?: string
  brokerage_id?: string  // REQUIRED — see the tenancy note below
}) {
  // ── TENANCY IS NOT OPTIONAL ON THIS TABLE ───────────────────────────────
  // behavioral_signals / site_activity / intelligence_signals_log all carry a
  // NULLABLE brokerage_id, and their RLS policy is
  //     (brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id())
  // (verified live). A row written with brokerage_id NULL is therefore
  // readable by EVERY brokerage on the platform — and the rows this function
  // writes are a named visitor's IP address, user agent and inferred intent.
  // The previous `?? null` stamped exactly that. Refuse instead: an untenanted
  // behavioural row is a cross-tenant PII leak, not a slightly worse row.
  if (!isValidUUID(sessionData.brokerage_id)) {
    return {
      success: false,
      error:
        "brokerage_id is required. An untenanted behavioural signal is readable by every brokerage under this table's RLS policy.",
    }
  }
  const brokerageId = sessionData.brokerage_id

  try {
    const supabase = createServiceClient()
    const { generateAIJSON } = await import("./ai-generate")

    // Detect location from IP (simplified - would use IP geolocation service)
    const location = { city: "Unknown", state: "Unknown", zip: "" }

    // Get or create behavioral signal.
    // Scoped by brokerage: visitor_id is a caller-minted cookie value with no
    // uniqueness guarantee, so an unscoped lookup could attach one brokerage's
    // visitor to another brokerage's signal row.
    const { data: signal, error: signalError } = await supabase
      .from("behavioral_signals")
      .select("*")
      .eq("visitor_id", sessionData.visitor_id)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()

    if (signalError && signalError.code !== "PGRST116") {
      throw signalError
    }

    let signalId: string
    let totalSessions = 1

    if (signal) {
      totalSessions = (signal.total_sessions || 0) + 1
      // Update existing signal
      await supabase
        .from("behavioral_signals")
        .update({
          last_seen_date: new Date().toISOString(),
          total_sessions: totalSessions,
          ip_address: sessionData.ip_address,
          user_agent: sessionData.user_agent,
        })
        .eq("id", signal.id)

      signalId = signal.id
    } else {
      // Create new signal — brokerage_id is stamped AT THE INSERT, never null.
      const { data: newSignal, error: newSignalError } = await supabase
        .from("behavioral_signals")
        .insert({
          visitor_id: sessionData.visitor_id,
          brokerage_id: brokerageId,
          ip_address: sessionData.ip_address,
          user_agent: sessionData.user_agent,
          city: location.city,
          state: location.state,
          zip: location.zip,
        })
        .select()
        .maybeSingle()

      // Was `newSignal!.id` on an undestructured result: a refused insert came
      // back as null and threw a TypeError instead of reporting the refusal.
      if (newSignalError) {
        console.error("[lead-intelligence] Behavioral signal insert error:", newSignalError)
        return { success: false, error: newSignalError.message }
      }
      if (!newSignal) return { success: false, error: "Behavioral signal was not created" }

      signalId = newSignal.id
    }

    // Log site activity — inherits brokerage from the signal
    await supabase.from("site_activity").insert({
      behavioral_signal_id: signalId,
      brokerage_id: brokerageId,
      page_visited: sessionData.page_visited,
      time_on_page_seconds: sessionData.time_spent,
      action_taken: sessionData.action_taken,
      search_terms: sessionData.search_terms || [],
    })

    // Get page history for AI analysis if multiple sessions
    if (totalSessions >= 2) {
      const { data: pageHistory } = await supabase
        .from("site_activity")
        .select("*")
        .eq("behavioral_signal_id", signalId)
        .order("timestamp", { ascending: false })
        .limit(20)

      const promptPageList = pageHistory?.map((p: Record<string, unknown>) => p.page_visited).join(", ") || "None"
      const calculatorList = pageHistory?.filter((p: Record<string, unknown>) => (p.action_taken as string | null)?.includes("calculator")).map((p: Record<string, unknown>) => p.action_taken).join(", ") || "None"

      const prompt = `Analyze user behavior to determine real estate intent:

Behavior Data:
- Pages viewed: ${promptPageList}
- Calculators used: ${calculatorList}
- Search terms: ${sessionData.search_terms?.join(", ") || "None"}
- Time spent: ${sessionData.time_spent} seconds
- Total sessions: ${totalSessions}
- Location: ${location.city}, ${location.state}

Determine:
{
  "intent_type": "buyer|seller|investor|researcher|unknown",
  "confidence": 0-100,
  "urgency": "low|medium|high",
  "price_range": "estimate or null",
  "timeline_indicator": "immediate|1-3_months|3-6_months|6-12_months|12+_months|researching",
  "ready_for_contact": boolean,
  "key_indicators": ["list of signals that led to this conclusion"]
}

Buyer signals: affordability calculator, mortgage calculator, neighborhood research, multiple listing views
Seller signals: home value tool, seller net calculator, CMA requests, listing timeline research
Investor signals: ROI calculators, rental income tools, market analysis pages`

      try {
        const intentData = await generateAIJSON(prompt)
        const intent = intentData.data as Record<string, unknown> | null

        if (!intent) {
          return { success: true, signalId }
        }

        // Update behavioral signal with AI insights
        await supabase
          .from("behavioral_signals")
          .update({
            intent_type: intent.intent_type as string | null,
            intent_confidence_score: intent.confidence as number | null,
          })
          .eq("id", signalId)

        // Flag for enrichment if high intent and multiple sessions
        if ((intent.confidence as number) >= 70 && totalSessions >= 3) {
          await supabase.from("intelligence_signals_log").insert({
            lead_profile_id: signalId,
            brokerage_id: brokerageId,
            signal_type: "high_intent_behavioral",
            signal_data_json: intent,
            signal_strength: 10,
            detected_at: new Date().toISOString(),
          })
        }

        return { success: true, signalId, intent }
      } catch (aiError) {
        console.error("[v0] AI intent analysis error:", aiError)
        return { success: true, signalId }
      }
    }

    return { success: true, signalId }
  } catch (error) {
    console.error("[v0] Error tracking behavior:", error)
    return { success: false, error: String(error) }
  }
}

export async function getUnifiedLeadProfiles(filters?: {
  temperature?: string
  intent_type?: string
  min_confidence?: number
  ready_for_outreach?: boolean
  contact_id?: string
}) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error, profiles: [] }

  try {
    const supabase = createServiceClient()

    let query = supabase
      .from("unified_lead_profile")
      .select(`
        *,
        contact:contacts(id, first_name, last_name, email, phone)
      `)
      .eq("brokerage_id", auth.brokerageId)
      .order("confidence_score", { ascending: false })

    if (filters?.contact_id) {
      query = query.eq("contact_id", filters.contact_id)
    }
    if (filters?.temperature) {
      query = query.eq("temperature", filters.temperature)
    }
    if (filters?.intent_type) {
      query = query.eq("intent_type", filters.intent_type)
    }
    if (filters?.min_confidence) {
      query = query.gte("confidence_score", filters.min_confidence)
    }
    if (filters?.ready_for_outreach !== undefined) {
      query = query.eq("ready_for_outreach", filters.ready_for_outreach)
    }

    const { data, error } = await query

    if (error) throw error

    return { success: true, profiles: data || [] }
  } catch (error) {
    console.error("[v0] Error getting lead profiles:", error)
    return { success: false, error: String(error), profiles: [] }
  }
}

export async function getMotivatedSellers(filters?: {
  min_score?: number
  timeframe?: string
  location?: string
}) {
  // batchdata_motivated_sellers_raw is platform-wide (no brokerage_id), but
  // it's not visitor-trackable data — at minimum require an authenticated
  // brokerage user.
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error, sellers: [] }

  try {
    const supabase = createServiceClient()

  let query = supabase
    .from("batchdata_motivated_sellers_raw")
    .select("*")
    .gte("motivation_confidence", 0.7)
    .order("motivation_confidence", { ascending: false })

    if (filters?.min_score) {
      query = query.gte("motivation_confidence", filters.min_score / 100)
    }
    if (filters?.timeframe) {
      query = query.eq("predicted_timeframe", filters.timeframe)
    }

    const { data, error } = await query

    if (error) throw error

    return { success: true, sellers: data || [] }
  } catch (error) {
    console.error("[v0] Error getting motivated sellers:", error)
    return { success: false, error: String(error), sellers: [] }
  }
}

export async function getSocialIntelligence(filters?: {
  source?: string
  min_score?: number
  urgency?: string
}) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error, signals: [] }

  try {
    const supabase = createServiceClient()

    let query = supabase
      .from("social_intelligence")
      .select("*")
      .eq("brokerage_id", auth.brokerageId)
      .order("ai_intent_score", { ascending: false })
      .limit(100)

    if (filters?.source) {
      query = query.eq("source", filters.source)
    }
    if (filters?.min_score) {
      query = query.gte("ai_intent_score", filters.min_score)
    }
    if (filters?.urgency) {
      query = query.eq("urgency_level", filters.urgency)
    }

    const { data, error } = await query

    if (error) throw error

    return { success: true, signals: data || [] }
  } catch (error) {
    console.error("[v0] Error getting social intelligence:", error)
    return { success: false, error: String(error), signals: [] }
  }
}

export async function getIntelligenceDashboardStats() {
  const auth = await requireCaller()
  if (!auth.ok) {
    return {
      success: false,
      error: auth.error,
      stats: { totalLeads: 0, hotLeads: 0, readyForOutreach: 0, motivatedSellers: 0 },
    }
  }

  try {
    const supabase = createServiceClient()

    // Get counts for dashboard — scoped to caller's brokerage on tables that have brokerage_id
    const [{ count: totalLeads }, { count: hotLeads }, { count: readyForOutreach }, { count: motivatedSellers }] =
      await Promise.all([
        supabase.from("unified_lead_profile").select("*", { count: "exact", head: true }).eq("brokerage_id", auth.brokerageId),
        supabase.from("unified_lead_profile").select("*", { count: "exact", head: true }).eq("brokerage_id", auth.brokerageId).eq("temperature", "hot"),
        supabase
          .from("unified_lead_profile")
          .select("*", { count: "exact", head: true })
          .eq("brokerage_id", auth.brokerageId)
          .eq("ready_for_outreach", true),
        supabase
          .from("batchdata_motivated_sellers_raw")
          .select("*", { count: "exact", head: true })
          .gte("motivation_confidence", 0.7),
      ])

    return {
      success: true,
      stats: {
        totalLeads: totalLeads || 0,
        hotLeads: hotLeads || 0,
        readyForOutreach: readyForOutreach || 0,
        motivatedSellers: motivatedSellers || 0,
      },
    }
  } catch (error) {
    console.error("[v0] Error getting dashboard stats:", error)
    return {
      success: false,
      error: String(error),
      stats: { totalLeads: 0, hotLeads: 0, readyForOutreach: 0, motivatedSellers: 0 },
    }
  }
}

/**
 * DELIBERATELY NOT WIRED TO ANY SURFACE. Two independent reasons, either of
 * which is sufficient:
 *
 * 1. THE PARSER IS A STUB. parseNextdoorPosts (below) unconditionally returns
 *    [] and logs "not configured". This function would therefore pay for a
 *    premium-proxy, JS-rendered ZenRows fetch and then persist ZERO rows —
 *    every single call, forever. The paid call is now refused up front rather
 *    than made and thrown away.
 * 2. NAMED, WIRED, MORE COMPLETE RIVAL: the social/forum collect lane is
 *    lib/lead-pipeline/social-sourcer.ts (sourceReddit / sourceFacebook /
 *    sourceInstagram / sourceCraigslist / sourceGoogle / sourceLinkedInRelocation),
 *    driven by app/api/cron/lead-scraping/route.ts with territory resolution
 *    (lib/lead-pipeline/scrape-territories.ts), per-vendor spend metering
 *    (lib/vendor-governance/meter-vendor.ts:meterVendorSpend), scraper-health
 *    escalation and the promotion gate. That lane has real normalizers and
 *    real intent detection; this one has a `return []`.
 *
 * NOT DELETED. It writes social_intelligence (author_name, post_content,
 * post_url, ai_intent_score) which the rival lane does not produce in that
 * shape, so it is an independent twin rather than a proven port. It stays,
 * hardened, unwired, and honest about being dark.
 *
 * COMPLIANCE: even with a working parser this collects named individuals'
 * neighbourhood posts. There is no lawful-basis record for that anywhere in
 * this codebase — no consent artifact, no legitimate-interest assessment, and
 * social_intelligence has no subject-rights linkage. Wiring it would create
 * profiles of people who have never transacted with the brokerage.
 */
export async function scrapeSocialSignalsWithZenRows(location: {
  city: string
  state: string
  zip?: string
}) {
  // Paid scraper — requires auth to prevent budget drain
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error, signals: [], count: 0 }

  const brokerageId = auth.brokerageId

  // DARK CAPABILITY GATE — refuse BEFORE spending. parseNextdoorPosts returns
  // [] unconditionally, so there is no outcome in which this call produces a
  // row. Charging for a fetch whose parser is a stub is pure budget burn.
  if (!NEXTDOOR_PARSER_IMPLEMENTED) {
    return {
      success: false,
      error:
        "Nextdoor scraping is not implemented — parseNextdoorPosts has no extraction logic, so a ZenRows fetch would cost money and yield zero signals. Use the lead-scraping pipeline (lib/lead-pipeline/social-sourcer.ts) instead.",
      signals: [],
      count: 0,
      dark: true as const,
    }
  }

  try {
    const supabase = createServiceClient()

    // ZenRows API configuration
    const zenrowsApiKey = process.env.ZENROWS_API_KEY

    if (!zenrowsApiKey) {
      console.log("[v0] ZenRows API key not configured")
      return { success: false, error: "ZenRows API key not configured" }
    }

    // Construct Nextdoor URL for the location
    const nextdoorUrl = `https://nextdoor.com/city/${location.state.toLowerCase()}/${location.city.toLowerCase().replace(/\s+/g, "-")}/`

    console.log("[v0] Scraping Nextdoor via ZenRows for:", location)

    const response = await callConnector<string>({
      connector: "zenrows", baseUrl: "https://api.zenrows.com", path: "/v1/", method: "GET",
      query: { url: nextdoorUrl, apikey: zenrowsApiKey, js_render: "true", premium_proxy: "true" },
      auth: { style: "none" }, responseType: "text",
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      timeoutMs: 60_000,
    })

    if (!response.ok || response.data == null) {
      throw new Error(`ZenRows API error: ${response.status} ${response.error ?? ""}`)
    }

    const html = response.data

    // Parse HTML to extract Nextdoor posts (simplified - would use cheerio or similar)
    const posts = parseNextdoorPosts(html, location)

    // Save social intelligence signals to database
    const signals = []

    for (const post of posts) {
      const { data: signal } = await supabase
        .from("social_intelligence")
        .insert({
          brokerage_id: brokerageId,
          source: "nextdoor",
          post_url: post.url,
          post_content: post.content,
          author_name: post.author,
          posted_date: post.date,
          location_city: location.city,
          location_state: location.state,
          location_zip: location.zip,
          ai_intent_score: post.intentScore,
          intent_summary: post.intentSummary,
          urgency_level: post.urgencyLevel,
          keywords: post.keywords,
        })
        .select()
        .single()

      if (signal) {
        signals.push(signal)
      }
    }

    console.log("[v0] Successfully scraped", signals.length, "signals from Nextdoor")

    return { success: true, signals, count: signals.length }
  } catch (error) {
    console.error("[v0] Error scraping Nextdoor with ZenRows:", error)
    return { success: false, error: String(error), signals: [], count: 0 }
  }
}

/**
 * Flip this to true ONLY when parseNextdoorPosts actually extracts posts.
 * It gates the paid ZenRows fetch above. Keeping the switch next to the stub
 * means the two cannot drift apart.
 */
const NEXTDOOR_PARSER_IMPLEMENTED = false

function parseNextdoorPosts(html: string, location: { city: string; state: string }): any[] {
  // Simplified parser - in production would use cheerio or similar
  const posts: any[] = []

  // Extract real estate related keywords
  const realEstateKeywords = [
    "moving",
    "selling home",
    "buy house",
    "realtor",
    "agent",
    "property",
    "listing",
    "foreclosure",
    "rent",
    "lease",
    "downsizing",
    "relocating",
    "just sold",
    "need to sell",
  ]

  // Production: Use HTML parsing to extract and score posts
  // This function requires implementation of actual scraping/parsing logic
  // Returns empty array until Nextdoor API integration is configured
  console.warn("[lead-intelligence] Nextdoor scraping not configured - requires API integration")
  return []
}

function firstNumber(...values: unknown[]): number | null {
  for (const v of values) {
    const n = Number(v)
    if (v !== null && v !== undefined && v !== "" && Number.isFinite(n)) return n
  }
  return null
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v.trim()
  }
  return null
}

/**
 * Enrich ONE property address from public property records.
 *
 * ── WHAT WAS WRONG ────────────────────────────────────────────────────────
 * This claimed in its own comment to "use BatchData API or similar" and then
 * inserted a row of LITERAL NULLS — every attribute column hard-coded null —
 * stamped `data_sources: ["manual_entry"]`. It was a provenance lie in both
 * directions: nothing was entered manually and nothing was enriched. It now
 * actually calls BatchData, and if BatchData is not configured or returns no
 * match it writes NOTHING and says so, rather than manufacturing a row.
 *
 * ── WHAT IT DELIBERATELY DOES NOT WRITE ───────────────────────────────────
 * property_intelligence carries owner_name / owner_occupied. BatchData returns
 * them. They are NOT persisted here. Enriching a property address with public
 * record attributes is ordinary real-estate practice; attaching a named human
 * being to it is profiling a person who has no relationship with this
 * brokerage and for whom no lawful basis is recorded anywhere in this
 * codebase. If owner data is ever needed it must go through the contact-scoped
 * path (enrichWithPropertyOwnership, below) where a contact record — and its
 * consent flags — already exist.
 *
 * ── STILL NOT WIRED TO A SURFACE ──────────────────────────────────────────
 * The only reader of property_intelligence is getAllSignalsForProfile. Until
 * an address-entry surface exists that also records why the brokerage is
 * enriching that address, this stays callable-but-unwired. See the report.
 */
export async function enrichPropertyIntelligence(propertyData: {
  address: string
  city: string
  state: string
  zip: string
  contactId?: string
  profileId?: string
}) {
  // Calls paid BatchData API; require auth
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!propertyData?.address?.trim()) {
    return { success: false, error: "A property address is required" }
  }

  // DARK PROVIDER GATE — never present an unconfigured vendor as a live one.
  if (!process.env.BATCHDATA_API_KEY) {
    return {
      success: false,
      error: "BATCHDATA_API_KEY is not configured — property enrichment is dark.",
      dark: true as const,
    }
  }

  try {
    const supabase = createServiceClient()

    const batchData = new BatchDataClient()
    const matches = await batchData.searchByAddress(
      propertyData.address,
      propertyData.city,
      propertyData.state
    )
    const match = (matches ?? [])[0] as Record<string, any> | undefined

    if (!match) {
      return {
        success: false,
        error: "No public property record matched that address — nothing was written.",
      }
    }

    const building = (match.building ?? {}) as Record<string, any>
    const lot = (match.lot ?? {}) as Record<string, any>
    const valuation = (match.valuation ?? {}) as Record<string, any>
    const sale = (match.sale ?? match.lastSale ?? {}) as Record<string, any>

    const row: Record<string, unknown> = {
      brokerage_id: auth.brokerageId, // stamped AT THE INSERT
      property_address: propertyData.address,
      city: propertyData.city,
      state: propertyData.state,
      zip: propertyData.zip,
      // Property attributes only. Owner identity is deliberately absent.
      property_type: firstString(building.propertyType, match.propertyType),
      bedrooms: firstNumber(building.bedroomCount, match.bedrooms),
      bathrooms: firstNumber(building.bathroomCount, match.bathrooms),
      square_feet: firstNumber(building.totalBuildingAreaSquareFeet, match.squareFeet),
      lot_size: firstNumber(lot.lotSizeSquareFeet, match.lotSize),
      year_built: firstNumber(building.yearBuilt, match.yearBuilt),
      estimated_value: firstNumber(valuation.estimatedValue, match.estimatedValue),
      last_sale_price: firstNumber(sale.lastSaleAmount, match.lastSalePrice),
      last_sale_date: firstString(sale.lastSaleDate, match.lastSaleDate),
      data_sources: ["batchdata"], // honest: this is where the values came from
    }
    // Link the row to the reader's resolving keys when the caller has them,
    // so it is not written into a lane nothing queries.
    if (isValidUUID(propertyData.contactId)) row.contact_id = propertyData.contactId
    if (isValidUUID(propertyData.profileId)) row.profile_id = propertyData.profileId

    const { data: property, error: insertError } = await supabase
      .from("property_intelligence")
      .insert(row)
      .select()
      .maybeSingle()

    if (insertError) {
      console.error("[lead-intelligence] Property intelligence insert error:", insertError)
      return { success: false, error: insertError.message }
    }
    if (!property) return { success: false, error: "Property intelligence was not saved" }

    return { success: true, property }
  } catch (error) {
    console.error("[v0] Error enriching property intelligence:", error)
    return { success: false, error: String(error) }
  }
}

export async function enrichLeadData(leadId: string) {
  const supabase = await createClient()

  // Check permission using RBAC
  await requirePermission("edit", "contact", leadId)

  // Get lead basic info
  const { data: lead } = await supabase.from("contacts").select("*").eq("id", leadId).single()

  if (!lead) throw new Error("Lead not found")

  // ── THE TENANT, RESOLVED ONCE, THROUGH THE RECORD ─────────────────────────
  //
  // Every table this enrichment writes carries the same live policy:
  // `FOR ALL … USING ((brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id()))`
  // — so a row written with a NULL tenant is not merely orphaned, it is READABLE
  // AND WRITABLE by every brokerage on the platform. These are OSINT profiles,
  // people-data, property ownership and search history about a named person, so
  // an unstamped row is that person's dossier published to every competitor.
  //
  // WHERE IT COMES FROM, AND WHY IT CANNOT BE WRONG: the contact row above — the
  // record these rows hang off, resolved by primary key and refused on absence
  // two lines up. Not the caller's session, which would stamp whoever happened to
  // press the button; not `lead.agent_id`, which is an `agents.id` and not a
  // tenant at all. Resolved ONCE here and threaded down, so the seven writers
  // below agree by construction instead of by seven repeated lookups that could
  // drift apart.
  const contactBrokerageId = ((lead as { brokerage_id?: string | null }).brokerage_id) ?? null
  if (!contactBrokerageId) {
    // Said out loud rather than swallowed: the parent contact carries no tenant,
    // so every derived row below inherits that exposure. Widening the contact's
    // own tenancy is not this function's decision to make.
    console.error(
      `[v0] enrichLeadData: contact ${leadId} carries no brokerage — enrichment rows will be written untenanted and are visible platform-wide`,
    )
  }

  const dataSources: string[] = []

  try {
    // 1. Enrich with people data
    if (lead.email || lead.phone) {
      await enrichWithPeopleData(leadId, lead, contactBrokerageId)
      dataSources.push("peopledata")
    }

    // 2. Get property ownership data
    if (lead.address || lead.city) {
      await enrichWithPropertyOwnership(leadId, lead, contactBrokerageId)
      dataSources.push("batchdata_property")
    }

    // 3. Search for online activity
    await searchOnlineActivity(leadId, lead, contactBrokerageId)
    dataSources.push("osint")

    // 4. Get IDX Broker interactions. The source is recorded only when the sync
    //    actually ran against a resolved tenant's IDX account — an unreachable
    //    credential must not be filed as a consulted source, which is how an
    //    outage becomes "we looked and this lead has done nothing".
    const idxSync = await syncIDXBrokerActivity(leadId, lead)
    if (idxSync.synced) dataSources.push("idx_broker")
    else console.error("[v0] enrichLeadData: IDX Broker source not recorded:", idxSync.reason)

    // 5. Calculate engagement scores using consolidated service
    // Determine which table this lead is in
    const { data: contact } = await supabase.from("contacts").select("id, agent_id").eq("id", leadId).maybeSingle()
    const { data: externalLead } = contact ? { data: null } : await supabase.from("leads").select("id, agent_id").eq("id", leadId).maybeSingle()
    
    const tableType = contact ? "contacts" : externalLead ? "leads" : null
    const agentId = contact?.agent_id || externalLead?.agent_id || "system"
    
    if (tableType) {
      await calculateLeadScore({
        id: leadId,
        agentId,
        table: tableType,
        recalculate: true
      })
    }

    // 6. Detect motivated seller signals
    await detectMotivatedSellerSignals(leadId)

    // 7. Update intelligence profile
    await updateIntelligenceProfile(leadId, dataSources, contactBrokerageId)

    revalidatePath("/intelligence")
    return { success: true, dataSources }
  } catch (error) {
    console.error("[v0] Enrichment error:", error)
    return { success: false, error: String(error) }
  }
}

async function enrichWithPeopleData(
  leadId: string,
  lead: Record<string, unknown>,
  brokerageId: string | null,
) {
  const supabase = createServiceClient()
  const peopleData = new PeopleDataClient()

  try {
    const enrichedData = await peopleData.enrich({
      email: lead.email as string | undefined,
      phone: lead.phone as string | undefined,
      firstName: lead.first_name as string | undefined,
      lastName: lead.last_name as string | undefined,
    })

    if (enrichedData) {
      const { error: peopleError } = await supabase.from("lead_people_data").insert({
        lead_id: leadId,
        brokerage_id: brokerageId,
        demographic_data: enrichedData.demographics as Record<string, unknown> | null,
        employment_data: enrichedData.employment as Record<string, unknown> | null,
        financial_indicators: enrichedData.financial as Record<string, unknown> | null,
        life_events: enrichedData.lifeEvents as Record<string, unknown>[] | null,
        social_presence: enrichedData.social as unknown as Record<string, unknown> | null,
        contact_enrichment: enrichedData.additionalContacts as Record<string, unknown>[] | null,
        data_source: "peopledata",
      })
      // supabase-js RESOLVES a refused or failed write, so an undestructured
      // `error` is indistinguishable from a success. Say it.
      if (peopleError) console.error("[v0] lead_people_data insert error:", peopleError)

      // Collect OSINT data from social profiles
      const socialProfiles = enrichedData.social as unknown as Record<string, unknown> | null
      if (socialProfiles?.profiles) {
        for (const profile of (socialProfiles.profiles as Record<string, unknown>[])) {
          const { error: osintError } = await supabase.from("lead_osint_data").insert({
            lead_id: leadId,
            brokerage_id: brokerageId,
            data_type: "social_profile",
            data_source: (profile.platform as string) || "unknown",
            data_content: profile,
            confidence_score: 0.85,
          })
          if (osintError) console.error("[v0] lead_osint_data insert error:", osintError)
        }
      }
    }
  } catch (error) {
    console.error("[v0] PeopleData enrichment error:", error)
  }
}

async function enrichWithPropertyOwnership(
  leadId: string,
  lead: Record<string, unknown>,
  brokerageId: string | null,
) {
  const supabase = createServiceClient()
  const batchData = new BatchDataClient()

  try {
    let properties: Record<string, unknown>[] = []

    if (lead.address) {
      properties = await batchData.searchByAddress(
        lead.address as string,
        lead.city as string,
        lead.state as string
      )
    } else if (lead.first_name && lead.last_name && lead.city) {
      properties = await batchData.searchByName(
        lead.first_name as string,
        lead.last_name as string,
        lead.city as string,
        lead.state as string
      )
    }

    for (const property of properties) {
      const purchaseDate = new Date(property.purchase_date as string)
      const now = new Date()
      const ownershipMonths = Math.floor((now.getTime() - purchaseDate.getTime()) / (1000 * 60 * 60 * 24 * 30))

      const { error: ownershipError } = await supabase.from("lead_property_ownership").insert({
        lead_id: leadId,
        brokerage_id: brokerageId,
        property_address: property.address as string,
        property_details: {
          bedrooms: property.bedrooms,
          bathrooms: property.bathrooms,
          sqft: property.square_feet,
          year_built: property.year_built,
          lot_size: property.lot_size,
        } as Record<string, unknown>,
        estimated_value: property.estimated_value as number,
        equity_estimate: ((property.estimated_value as number) - ((property.mortgage_balance as number) || 0)),
        mortgage_data: property.mortgage,
        purchase_date: property.purchase_date as string,
        ownership_length_months: ownershipMonths,
        property_tax: property.annual_tax as number,
        is_primary_residence: property.owner_occupied as boolean,
        motivation_indicators: {} as Record<string, unknown>,
        data_source: "batchdata",
      })
      if (ownershipError) console.error("[v0] lead_property_ownership insert error:", ownershipError)
    }
  } catch (error) {
    console.error("[v0] Property ownership enrichment error:", error)
  }
}

async function searchOnlineActivity(leadId: string, lead: any, brokerageId: string | null) {
  const supabase = createServiceClient()
  const zenrows = new ZenrowsClient()

  try {
    const searchQueries = [
      `"${lead.first_name} ${lead.last_name}" ${lead.city} real estate`,
      `"${lead.first_name} ${lead.last_name}" ${lead.city} moving`,
      `"${lead.first_name} ${lead.last_name}" ${lead.city} selling home`,
    ]

    for (const query of searchQueries) {
      const results = await zenrows.googleSearch(query, {
        location: `${lead.city}, ${lead.state}`,
        num: 20,
      })

      const detectedIntent = analyzeSearchIntent(results as unknown as any[])

      if (detectedIntent) {
        const { error: searchActivityError } = await supabase.from("google_search_activity").insert({
          lead_id: leadId,
          brokerage_id: brokerageId,
          search_location: `${lead.city}, ${lead.state}`,
          search_terms: [query],
          detected_intent: detectedIntent,
          search_patterns: { results_count: results.length },
          scraped_via: "zenrows",
        })
        if (searchActivityError) console.error("[v0] google_search_activity insert error:", searchActivityError)
      }
    }

    if (lead.city && lead.state) {
      await searchNextdoorActivity(leadId, lead, brokerageId)
    }

    await searchRealEstateSites(leadId, lead, brokerageId)
  } catch (error) {
    console.error("[v0] Online activity search error:", error)
  }
}

async function searchNextdoorActivity(leadId: string, lead: any, brokerageId: string | null) {
  const supabase = createServiceClient()
  const zenrows = new ZenrowsClient()

  try {
    const nextdoorUrl = `https://nextdoor.com/search/?q=${encodeURIComponent(`${lead.city} ${lead.state} moving selling home`)}`
    const { posts: nextdoorResults } = await zenrows.scrapeNextdoor(nextdoorUrl)

    for (const activity of nextdoorResults as any[]) {
      const nameMatch = activity.content.toLowerCase().includes(`${lead.first_name} ${lead.last_name}`.toLowerCase())

      if (nameMatch || activity.relevance_score > 70) {
        const { error: nextdoorError } = await supabase.from("nextdoor_activity").insert({
          lead_id: leadId,
          brokerage_id: brokerageId,
          activity_type: activity.type,
          content_snippet: activity.content.substring(0, 500),
          neighborhood: activity.neighborhood,
          detected_keywords: activity.matched_keywords,
          activity_url: activity.url,
          relevance_score: activity.relevance_score,
        })
        if (nextdoorError) console.error("[v0] nextdoor_activity insert error:", nextdoorError)
      }
    }
  } catch (error) {
    console.error("[v0] Nextdoor search error:", error)
  }
}

async function searchRealEstateSites(leadId: string, lead: any, brokerageId: string | null) {
  const supabase = createServiceClient()
  const zenrows = new ZenrowsClient()

  const sites = ["zillow", "realtor.com", "redfin"]

  for (const site of sites) {
    try {
      const siteUrl = `https://www.${site === "realtor.com" ? "realtor.com" : site + ".com"}/homes-for-sale/${encodeURIComponent(lead.city + "-" + lead.state)}`
      const searchResults = await zenrows.scrape(siteUrl) as any

      if (searchResults.properties?.length > 0) {
        const { error: propertySearchError } = await supabase.from("lead_property_searches").insert({
          lead_id: leadId,
          brokerage_id: brokerageId,
          search_source: site,
          search_location: `${lead.city}, ${lead.state}`,
          properties_viewed: searchResults.properties,
          search_criteria: searchResults.filters,
          detected_via: "zenrows_scrape",
        })
        if (propertySearchError) console.error(`[v0] lead_property_searches insert error (${site}):`, propertySearchError)
      }
    } catch (error) {
      console.error(`[v0] ${site} scraping error:`, error)
    }
  }
}

/**
 * Resolve THE CONTACT'S OWN BROKERAGE'S IDX Broker account, and report honestly
 * that this contact's browsing history has nowhere to be recorded. See the body:
 * the only interaction table in this schema is keyed to the other identity class,
 * so the write was removed rather than repointed at a column that does not exist.
 *
 * The client resolution below used to be `new IDXBrokerClient()` — no argument, so
 * the platform's IDXBROKER_API_KEY every time. That was worse here than on a search
 * surface: the rows this used to write claimed to be what THIS person did on THIS
 * brokerage's IDX site, and they were being read out of a feed belonging to whoever
 * owns the platform key. A brokerage that connected its own IDX Broker account —
 * the only way this lookup can find anything, since IDX enquiries live in the
 * account that captured them — got nothing back and no indication why.
 *
 * NO EXTRA READ IS NEEDED: the caller already holds the contact row (`select("*")`
 * on the contact being enriched), so `lead.brokerage_id` is the tenant, resolved
 * from a record rather than accepted from a parameter.
 *
 * NO AGENT TIER, DELIBERATELY. The obvious candidate — `lead.agent_id` — is an
 * `agents.id`; `forBrokerage`'s `actor.agentUserId` is a `users.id`. They are
 * DISJOINT id spaces, and handing one to the other would file the credential
 * lookup under a scope no row can ever match, which resolves to null and falls
 * onward exactly like "no connection" — a lie that reads as a fact. Brokerage
 * tier is the honest tier for a record-driven enrichment.
 *
 * RETURNS ITS OUTCOME rather than swallowing it: the caller stamps an
 * "idx_broker" data source, and an unreachable tenant, an unconfigured cascade or
 * an absent storage lane must not be recorded as a source that produced data.
 */
async function syncIDXBrokerActivity(
  leadId: string,
  lead: any,
): Promise<{ synced: boolean; reason?: string }> {
  const ownerBrokerageId = (lead?.brokerage_id as string | null | undefined) ?? null
  if (!ownerBrokerageId) {
    // Refuse rather than fall through to the platform feed: with no owner there is
    // no account whose browsing history this could honestly be.
    console.error("[v0] IDX sync skipped: the contact carries no brokerage, so no IDX account can be resolved")
    return { synced: false, reason: "no_brokerage_on_contact" }
  }

  const idx = await IDXBrokerClient.forBrokerage(ownerBrokerageId)
  if (!idx.isConfigured()) {
    console.error("[v0] IDX sync skipped: no IDX Broker credential at any tier for this brokerage")
    return { synced: false, reason: "no_idx_credential" }
  }

  // ── THE WRITE IS GONE, AND NOTHING REPLACES IT. STATED PLAINLY. ────────────
  //
  // This function's caller PROVES, before it is ever reached, that `leadId` is a
  // contacts.id: the enrichment entry point resolves the id against the contacts
  // table and throws when it is absent, so nothing of the other class survives to
  // get here. The row this used to write set `lead_id` to that value.
  //
  // `lead_id` on the destination table is `REFERENCES leads(id)`
  // (scripts/320-*.sql:187), and the table has NO contacts-keyed column at all —
  // scripts/schema-snapshot.ts lists `lead_id` and no `contact_id`. So EVERY row
  // this writer produced put a contacts.id into the other class's foreign key,
  // and there is no other column to move it to. There is no correct write here,
  // only a wrong one, and recording nothing beats recording a row that violates a
  // foreign key and misattributes one person's browsing to another record.
  //
  // THE FETCH IS NOT MADE EITHER. Calling the provider to discard the answer is
  // the same defect this wave is removing elsewhere — spending before deciding.
  // Resolving the credential above is a database read, not a vendor call, and it
  // still tells the caller honestly whether this tenant has an IDX account.
  //
  // WHAT THIS COSTS, SAID OUT LOUD: IDX browsing history is not recorded for a
  // contact anywhere in this system. `synced: false` means the caller does not
  // stamp "idx_broker" as a consulted source, which is the truth — an absent lane
  // must never read as "we looked and this person has done nothing". Giving
  // contacts a browsing-history lane is a schema decision and belongs to the wave
  // that owns this relationship, not to a guess made here.
  return { synced: false, reason: "no_contacts_keyed_idx_interaction_lane" }
}

/**
 * @deprecated This function is replaced by calculateLeadScore from lib/services/lead-management.service.ts
 * Kept for backward compatibility but internally calls the consolidated service
 */
async function calculateEngagementScores(leadId: string) {
  // This function has been replaced by the consolidated lead scoring service
  // which handles both contacts and leads tables with more comprehensive scoring
  console.log("[v0] calculateEngagementScores called - redirecting to consolidated service")
  
  const supabase = createServiceClient()
  const { data: contact } = await supabase.from("contacts").select("id, agent_id").eq("id", leadId).maybeSingle()
  const { data: externalLead } = contact ? { data: null } : await supabase.from("leads").select("id, agent_id").eq("id", leadId).maybeSingle()
  
  const tableType = contact ? "contacts" : externalLead ? "leads" : null
  const agentId = contact?.agent_id || externalLead?.agent_id || "system"
  
  if (tableType) {
    await calculateLeadScore({
      id: leadId,
      agentId,
      table: tableType,
      recalculate: true
    })
  }
}

function calculateAverageDaysBetween(behaviors: any[]): number {
  if (behaviors.length < 2) return 999

  const dates = behaviors.map((b) => new Date(b.occurred_at).getTime()).sort()
  const gaps = []

  for (let i = 1; i < dates.length; i++) {
    gaps.push((dates[i] - dates[i - 1]) / (1000 * 60 * 60 * 24))
  }

  return gaps.reduce((a, b) => a + b, 0) / gaps.length
}

async function detectMotivatedSellerSignals(leadId: string) {
  const supabase = createServiceClient()

  // Resolve the contact's brokerage so we can stamp signal rows correctly
  const { data: contact } = await supabase
    .from("contacts")
    .select("brokerage_id")
    .eq("id", leadId)
    .maybeSingle()
  const contactBrokerageId = contact?.brokerage_id ?? null

  const { data: properties } = await supabase.from("lead_property_ownership").select("*").eq("lead_id", leadId)

  if (!properties || properties.length === 0) return

  const { data: peopleData } = await supabase
    .from("lead_people_data")
    .select("*")
    .eq("lead_id", leadId)
    .order("enriched_at", { ascending: false })
    .limit(1)
    .single()

  const signals: any[] = []

  for (const property of properties) {
    if (property.ownership_length_months >= 120) {
      signals.push({
        lead_id: leadId,
        signal_type: "market_timing",
        signal_details: {
          reason: "Long-term ownership",
          months: property.ownership_length_months,
          property: property.property_address,
        },
        signal_strength: "moderate",
        detected_via: "batchdata",
      })
    }

    const equityPercent = property.equity_estimate / property.estimated_value
    if (equityPercent > 0.5) {
      signals.push({
        lead_id: leadId,
        signal_type: "high_equity",
        signal_details: {
          reason: "High equity position",
          equity_percent: Math.round(equityPercent * 100),
          equity_amount: property.equity_estimate,
          property: property.property_address,
        },
        signal_strength: equityPercent > 0.75 ? "strong" : "moderate",
        detected_via: "batchdata",
      })
    }

    const propertyAge = new Date().getFullYear() - (property.property_details?.year_built || 0)
    if (propertyAge > 40) {
      signals.push({
        lead_id: leadId,
        signal_type: "property_condition",
        signal_details: {
          reason: "Older property may need updates",
          age: propertyAge,
          property: property.property_address,
        },
        signal_strength: "weak",
        detected_via: "batchdata",
      })
    }

    if (peopleData?.life_events) {
      const motivatingEvents = ["divorce", "retirement", "job_change", "marriage", "new_baby"]
      const recentEvents = peopleData.life_events.filter((event: any) => motivatingEvents.includes(event.type))

      for (const event of recentEvents) {
        signals.push({
          lead_id: leadId,
          signal_type: "life_event",
          signal_details: {
            reason: `Life event: ${event.type}`,
            event: event,
            property: property.property_address,
          },
          signal_strength: event.type === "divorce" ? "strong" : "moderate",
          detected_via: "peopledata",
        })
      }
    }
  }

  if (signals.length > 0) {
    // Stamp brokerage_id on every batch-inserted signal row
    const signalsWithBrokerage = signals.map(s => ({ ...s, brokerage_id: contactBrokerageId }))
    await supabase.from("motivated_seller_signals").insert(signalsWithBrokerage)
  }

  return signals
}

async function updateIntelligenceProfile(
  leadId: string,
  dataSources: string[],
  brokerageId: string | null,
) {
  const supabase = createServiceClient()

  const { data: propertySearches } = await supabase.from("lead_property_searches").select("*").eq("lead_id", leadId)

  // IDX property interactions are NOT read here any more (wave 18). Property
  // search is a CONTACTS capability by owner ruling; lead_idx_property_interactions,
  // the only table that carried this signal, is keyed on the pre-conversion id
  // (its `lead_id` is REFERENCES leads(id)) with no contacts column at all, and
  // its writer was removed because it was filing a contacts id in that column.
  // The lane cannot be fed, so reading it could only ever return an empty set —
  // and folding that into a profile presents "no property interest" as an
  // observation instead of an absence of instrumentation.

  const { data: engagementScores } = await supabase
    .from("lead_engagement_scores")
    .select("*")
    .eq("lead_id", leadId)
    .single()

  const { data: sellerSignals } = await supabase.from("motivated_seller_signals").select("*").eq("lead_id", leadId)

  const { data: propertyOwnership } = await supabase.from("lead_property_ownership").select("*").eq("lead_id", leadId)

  let buyerSellerType = "buyer"
  if (propertyOwnership && propertyOwnership.length > 0) {
    buyerSellerType = sellerSignals && sellerSignals.length > 2 ? "seller" : "both"
  }

  const propertyTypes: string[] = []
  const locations: string[] = []
  let minPrice = Number.POSITIVE_INFINITY
  let maxPrice = 0

  propertySearches?.forEach((search: any) => {
    if (search.search_criteria?.propertyType) {
      propertyTypes.push(search.search_criteria.propertyType)
    }
    if (search.search_criteria?.minPrice) {
      minPrice = Math.min(minPrice, search.search_criteria.minPrice)
    }
    if (search.search_criteria?.maxPrice) {
      maxPrice = Math.max(maxPrice, search.search_criteria.maxPrice)
    }
    if (search.search_location) {
      locations.push(search.search_location)
    }
  })


  const priceRange =
    minPrice !== Number.POSITIVE_INFINITY ? `$${minPrice.toLocaleString()} - $${maxPrice.toLocaleString()}` : null

  // `lead_intelligence.timeline`. TYPED against the one vocabulary
  // (constants/crm-standards.ts:STANDARD_TIMELINES) — this writer already spoke
  // it and is the reason `researching` survives into the shared list, since it
  // is the value every row is initialised to. A `let` of type string could drift
  // off the vocabulary silently; annotated, it cannot.
  let timeline: StandardTimeline = "researching"
  if (engagementScores) {
    if (engagementScores.overall_score > 70 && engagementScores.recency_score > 80) {
      timeline = "immediate"
    } else if (engagementScores.overall_score > 50) {
      timeline = "1-3_months"
    } else if (engagementScores.overall_score > 30) {
      timeline = "3-6_months"
    }
  }

  const motivationScore = calculateMotivationScore({
    engagementScore: engagementScores?.overall_score || 0,
    sellerSignals: sellerSignals?.length || 0,
    // propertyViews removed with its source — see the note above. A literal 0
    // would be indistinguishable from a person who genuinely viewed nothing.
    searches: propertySearches?.length || 0,
  })

  const qualificationScore = calculateQualificationScore({
    hasPropertyOwnership: (propertyOwnership && propertyOwnership.length > 0) ?? false,
    engagementScore: engagementScores?.overall_score || 0,
    hasFinancialData: !!propertyOwnership?.[0]?.equity_estimate,
  })

  const { error: intelligenceError } = await supabase.from("lead_intelligence").upsert({
    lead_id: leadId,
    brokerage_id: brokerageId,
    buyer_seller_type: buyerSellerType,
    identified_interests: [],
    property_preferences: {},
    price_range: priceRange,
    property_type: [...new Set(propertyTypes)],
    location_preferences: [...new Set(locations)],
    timeline,
    motivation_score: motivationScore,
    qualification_score: qualificationScore,
    data_sources: dataSources,
    last_enriched_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })
  if (intelligenceError) console.error("[v0] lead_intelligence upsert error:", intelligenceError)
}

/**
 * WAVE 18 — `propertyViews` is gone from this score, parameter and all.
 *
 * It was worth up to 20 of the 100 points and its only source was the IDX
 * property-interaction table, which is keyed on the pre-conversion id, has no
 * contacts column, and now has no writer (property search is a CONTACTS
 * capability by owner ruling). Left in the signature it would have contributed a
 * permanent zero — so every pre-conversion record would score up to 20 points
 * lower than the scale implies, for a signal the product does not collect about
 * them. A missing input silently depressing a score is worse than a smaller,
 * honest scale: the number still LOOKS like it is out of 100.
 *
 * The remaining weights are deliberately NOT rescaled to refill the gap. Doing
 * that would invent motivation the evidence never showed; the ceiling is simply
 * lower now, and that is the truthful shape.
 */
function calculateMotivationScore(data: {
  engagementScore: number
  sellerSignals: number
  searches: number
}): number {
  let score = 0
  score += data.engagementScore * 0.4
  score += Math.min(30, data.sellerSignals * 10)
  score += Math.min(10, data.searches * 3)
  return Math.round(Math.min(100, score))
}

function calculateQualificationScore(data: {
  hasPropertyOwnership: boolean
  engagementScore: number
  hasFinancialData: boolean
}): number {
  let score = 0
  if (data.hasPropertyOwnership) score += 40
  if (data.hasFinancialData) score += 30
  score += data.engagementScore * 0.3
  return Math.round(Math.min(100, score))
}

function analyzeSearchIntent(results: any[]): string | null {
  const keywords = results
    .map((r) => r.title + " " + r.snippet)
    .join(" ")
    .toLowerCase()

  if (keywords.includes("buy") || keywords.includes("buying") || keywords.includes("purchase")) {
    return "buying"
  }
  if (keywords.includes("sell") || keywords.includes("selling") || keywords.includes("list")) {
    return "selling"
  }
  if (keywords.includes("value") || keywords.includes("appraisal") || keywords.includes("worth")) {
    return "valuation"
  }
  if (keywords.includes("agent") || keywords.includes("realtor")) {
    return "agent_search"
  }

  return "market_research"
}

/** The only unified_lead_profile fields an agent may set by hand. */
export interface LeadProfileTriage {
  temperature?: "hot" | "warm" | "cold"
  intent_type?: "buyer" | "seller" | "both" | "investor" | "researcher" | "unknown"
  intent_strength?: "browsing" | "researching" | "active"
  /**
   * REPOINTED to the one timeline vocabulary — constants/crm-standards.ts:
   * STANDARD_TIMELINES. This was `"immediate" | "1-3months" | "3-6months"`, the
   * NO-SEPARATOR spelling, and it was the live gate below: it refused every
   * other spelling of the same concept onto
   * `unified_lead_profile.estimated_timeline`, including the one the rest of
   * this very file writes to `lead_intelligence.timeline` (`1-3_months`).
   */
  estimated_timeline?: StandardTimeline
  ready_for_outreach?: boolean
  ai_summary?: string
  /**
   * agents.id, or the string "me". unified_lead_profile.assigned_agent_id has
   * NO declared foreign key (verified live — the table's only FKs are
   * brokerage_id and contact_id), so nothing in the database catches a users.id
   * written here; the check has to happen in code. "me" is resolved through the
   * canonical resolver rather than defaulted with `??`.
   */
  assigned_agent_id?: string | "me" | null
}

const TEMPERATURES = ["hot", "warm", "cold"] as const
const INTENT_TYPES = ["buyer", "seller", "both", "investor", "researcher", "unknown"] as const
const INTENT_STRENGTHS = ["browsing", "researching", "active"] as const
/**
 * The gate over `unified_lead_profile.estimated_timeline`. It is now the ONE
 * vocabulary (constants/crm-standards.ts:STANDARD_TIMELINES) rather than a
 * third private spelling, and it is the same list the live CHECK admits (m487)
 * — so a value this gate accepts is a value the column can store, and vice
 * versa. Aliased rather than redeclared: two lists is how this started.
 */
const TIMELINES = STANDARD_TIMELINES

/**
 * Hand-triage one unified lead profile.
 *
 * THIS WAS `updates: any` SPREAD STRAIGHT INTO AN UPDATE, over a SERVICE
 * client, with no tenant filter. requirePermission defers everything that is
 * not a broker/admin to RLS (lib/security/rbac.ts step 7) — and the service
 * client is precisely the client RLS does not apply to. So any signed-in agent
 * could rewrite any brokerage's profile row, including its brokerage_id, by
 * naming the id. The columns are now an allow-list, the row is anchored to the
 * caller's brokerage, and the update is confirmed to have matched something.
 */
export async function updateLeadProfile(profileId: string, updates: LeadProfileTriage) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  await requirePermission("edit", "lead_intelligence", profileId)

  const supabase = createServiceClient()
  const patch: Record<string, unknown> = {}

  if (updates.temperature !== undefined) {
    if (!TEMPERATURES.includes(updates.temperature)) {
      return { success: false, error: "Unsupported temperature" }
    }
    patch.temperature = updates.temperature
  }
  if (updates.intent_type !== undefined) {
    if (!INTENT_TYPES.includes(updates.intent_type)) {
      return { success: false, error: "Unsupported intent type" }
    }
    patch.intent_type = updates.intent_type
  }
  if (updates.intent_strength !== undefined) {
    if (!INTENT_STRENGTHS.includes(updates.intent_strength)) {
      return { success: false, error: "Unsupported intent strength" }
    }
    patch.intent_strength = updates.intent_strength
  }
  if (updates.estimated_timeline !== undefined) {
    if (!TIMELINES.includes(updates.estimated_timeline)) {
      return { success: false, error: "Unsupported timeline" }
    }
    patch.estimated_timeline = updates.estimated_timeline
  }
  if (updates.ready_for_outreach !== undefined) {
    patch.ready_for_outreach = Boolean(updates.ready_for_outreach)
  }
  if (updates.ai_summary !== undefined) {
    patch.ai_summary = String(updates.ai_summary).slice(0, 4000)
  }

  if (updates.assigned_agent_id !== undefined) {
    if (updates.assigned_agent_id === null) {
      patch.assigned_agent_id = null
    } else if (updates.assigned_agent_id === "me") {
      // users.id → agents.id. NOT `?? auth.userId`: a users.id in an
      // agents-class column reads back as an unknown agent and the profile
      // silently belongs to nobody.
      const { resolveUserIdToAgentRecord } = await import("@/lib/kernel/agent-identity-resolver")
      const agentId = await resolveUserIdToAgentRecord(auth.userId, auth.brokerageId)
      if (!agentId) {
        return { success: false, error: "No agent profile is linked to this account yet" }
      }
      patch.assigned_agent_id = agentId
    } else {
      // A raw agents.id from the browser — confirm it is an agent of THIS
      // brokerage before it lands in a column with no foreign key to catch it.
      const { data: agent, error: agentError } = await supabase
        .from("agents")
        .select("id")
        .eq("id", updates.assigned_agent_id)
        .eq("brokerage_id", auth.brokerageId)
        .maybeSingle()
      if (agentError) return { success: false, error: agentError.message }
      if (!agent) return { success: false, error: "That agent is not in this brokerage" }
      patch.assigned_agent_id = agent.id
    }
  }

  if (Object.keys(patch).length === 0) {
    return { success: false, error: "Nothing to update" }
  }
  patch.updated_at = new Date().toISOString()

  const { data, error } = await supabase
    .from("unified_lead_profile")
    .update(patch)
    .eq("id", profileId)
    .eq("brokerage_id", auth.brokerageId)
    .select()
    .maybeSingle()

  if (error) {
    console.error("[v0] Error updating lead profile:", error)
    return { success: false, error: error.message }
  }
  // A filtered update that matches nothing is not an error to PostgREST. Saying
  // "saved" over zero rows is how a cross-tenant id looks like success.
  if (!data) return { success: false, error: "That profile was not found" }

  // /leads is where the triage controls live; /intelligence kept from the
  // original so nothing that page renders goes stale.
  revalidatePath("/leads")
  revalidatePath("/intelligence")
  return { success: true, profile: data }
}

export interface AgentWorkloadRow {
  agentId: string
  agentName: string
  total: number
  hot: number
  warm: number
  cold: number
  ready: number
}

export async function getAgentWorkloadStats() {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error, workload: [] as AgentWorkloadRow[] }

  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("unified_lead_profile")
    .select("assigned_agent_id, temperature, ready_for_outreach")
    .eq("brokerage_id", auth.brokerageId)

  if (error) {
    console.error("[v0] Error getting agent workload:", error)
    return { success: false, error: error.message, workload: [] as AgentWorkloadRow[] }
  }

  // Aggregate by agent
  const byAgent = new Map<string, AgentWorkloadRow>()
  for (const profile of data ?? []) {
    const agentId = profile.assigned_agent_id as string | null
    if (!agentId) continue

    let row = byAgent.get(agentId)
    if (!row) {
      row = { agentId, agentName: "Unknown agent", total: 0, hot: 0, warm: 0, cold: 0, ready: 0 }
      byAgent.set(agentId, row)
    }

    row.total++
    // `workload[id][profile.temperature]++` produced NaN the moment temperature
    // was null or anything outside the three buckets — and temperature is a
    // nullable free-text column, so an unscored profile poisoned the whole row.
    const t = profile.temperature as string | null
    if (t === "hot" || t === "warm" || t === "cold") row[t]++
    if (profile.ready_for_outreach) row.ready++
  }

  // A count with no name is not something a broker can act on.
  //
  // THE NAME IS NOT ON `agents`. That table carries licence, fee and profile
  // columns but no first_name / last_name / email — those live on `users`, one
  // hop away through agents.user_id. Selecting them off `agents` is a phantom
  // column, and PostgREST answers a phantom column by failing the whole select.
  // The embed below is backed by a DECLARED foreign key (agents_user_id_fkey →
  // users(id), verified live), which is what makes it resolvable.
  const agentIds = [...byAgent.keys()]
  if (agentIds.length > 0) {
    const { data: agents, error: agentsError } = await supabase
      .from("agents")
      .select("id, users:user_id(first_name, last_name, email)")
      .in("id", agentIds)
      .eq("brokerage_id", auth.brokerageId)
    if (agentsError) {
      console.error("[v0] Agent name lookup failed:", agentsError.message)
    } else {
      for (const a of agents ?? []) {
        const row = byAgent.get(a.id as string)
        const u = (a as { users?: { first_name?: string | null; last_name?: string | null; email?: string | null } | null }).users
        if (row && u) {
          row.agentName =
            `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || u.email || "Unnamed agent"
        }
      }
    }
  }

  const workload = [...byAgent.values()].sort((a, b) => b.total - a.total)
  return { success: true, workload }
}

// ============================================
// GOOGLE SEARCH INTENT ANALYSIS
// ============================================

/**
 * Aggregate search-demand sampling for one market.
 *
 * This is the LEAST privacy-sensitive function in this file: it records search
 * PHRASES and result counts, never a person. It is nonetheless NOT WIRED, for
 * two product reasons rather than a compliance one:
 *
 *  1. google_search_intelligence HAS NO READER. Nothing in the codebase
 *     queries that table (verified by search) — only this insert touches it.
 *     Surfacing a paid scrape whose output no screen can display is not
 *     finishing a feature, it is spending money into a void. It needs a
 *     market-demand panel built first.
 *  2. ZENROWS_API_KEY is not configured in this environment (the superadmin
 *     provider board at app/dashboard/superadmin/env-providers already reports
 *     zenrows as dark). A dark provider must be shown as dark.
 *
 * Hardened meanwhile: the paid loop is refused when the provider is dark, and
 * every insert error is read instead of discarded (a whole run could fail
 * silently and still return `{ success: true }`).
 *
 * SCHEMA GAP, NOT FIXED HERE: `targetLocation.id` is accepted and cannot be
 * stored — google_search_intelligence has no market/territory column (verified
 * live: id, brokerage_id, search_query, detected_location, related_searches,
 * trend, potential_leads_count, scraped_at). So a sampled row cannot be traced
 * back to the market that requested it. That needs a migration, which is out
 * of scope for this pass; it is reported rather than papered over.
 */
export async function analyzeGoogleSearchIntent(targetLocation: { id: string; city: string; state: string; zip?: string }) {
  // Paid ZenRows scraping — require auth
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  // DARK PROVIDER GATE — refuse before spending, never fake a live vendor.
  if (!process.env.ZENROWS_API_KEY) {
    return {
      success: false,
      error: "ZENROWS_API_KEY is not configured — Google search-intent sampling is dark.",
      dark: true as const,
    }
  }

  const supabase = createServiceClient()
  const zenrows = new ZenrowsClient()

  const buyerSearches = [
    `homes for sale in ${targetLocation.city}`,
    `${targetLocation.city} real estate`,
    `buy house ${targetLocation.city}`,
    `first time home buyer ${targetLocation.city}`,
  ]

  const sellerSearches = [
    `home value ${targetLocation.city}`,
    `sell my house ${targetLocation.city}`,
    `real estate agents ${targetLocation.city}`,
  ]

  try {
    for (const query of [...buyerSearches, ...sellerSearches]) {
      const searchData = await zenrows.googleSearch(query, {
        location: `${targetLocation.city}, ${targetLocation.state}`,
        num: 20,
      }) as any

      const { error: insertError } = await supabase.from("google_search_intelligence").insert({
        brokerage_id: auth.brokerageId,
        search_query: query,
        detected_location: targetLocation.city,
        related_searches: searchData.relatedSearches || [],
        trend: searchData.results?.length > 15 ? "high" : "moderate",
        potential_leads_count: searchData.results?.length || 0,
        scraped_at: new Date().toISOString(),
      })

      // The result was discarded: a run that paid ZenRows for seven searches
      // and persisted none of them still reported success.
      if (insertError) {
        console.error("[lead-intelligence] Search intelligence insert error:", insertError)
        return { success: false, error: insertError.message, sampled: query }
      }
    }

    return { success: true }
  } catch (error) {
    console.error("[v0] Google search intent error:", error)
    return { success: false, error: String(error) }
  }
}

// ============================================
// UNIFIED LEAD PROFILE CREATION
// ============================================

/**
 * Build (or refresh) the unified intelligence profile for ONE CONTACT the
 * brokerage already holds.
 *
 * ── LAWFUL BASIS ──────────────────────────────────────────────────────────
 * This used to take `{ source, email, phone }` straight from the caller,
 * which made it an unbounded profiling endpoint: type any stranger's email
 * into a "use server" action and the OS would open a behavioural profile on
 * them. It now takes a contactId and resolves the subject FROM the contacts
 * table INSIDE the caller's brokerage — so the only people who can be profiled
 * are people the brokerage already lawfully holds a record for, and the
 * subject's own consent flags travel with them (below). A contactId from
 * another tenant is refused, not silently profiled.
 *
 * ── CONSENT ───────────────────────────────────────────────────────────────
 * `ready_for_outreach` is an outbound RECOMMENDATION. It is forced to false
 * for a contact on the global DNC list or opted out of every channel, so the
 * profile can never advertise a contactable lead that the existing consent
 * rail (lib/kernel/compliance.ts:evaluateOutbound) would block. Profiling does
 * not bypass that gate — the gate still runs at send time; this just stops the
 * UI recommending an outreach that will be refused.
 *
 * ── PROVENANCE ────────────────────────────────────────────────────────────
 * Every run writes one intelligence_signals_log row (the rail's own signal
 * ledger, brokerage-stamped) recording that an AI inference was made, on which
 * contact, from which sources. No parallel ledger is invented.
 *
 * ── SCALE ─────────────────────────────────────────────────────────────────
 * Both wired readers of confidence_score (app/crm/page.tsx and
 * app/leads/page.tsx) render `score * 100`, i.e. they expect a 0–1 fraction.
 * The model is asked for 0–100, so it is normalised on the way in. Writing the
 * raw 0–100 would have rendered a 75%-confidence profile as "7500%".
 */
export async function createUnifiedLeadProfile(input: { contactId: string; source?: string }) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!isValidUUID(input?.contactId)) {
    return { success: false, error: "A contact id is required" }
  }

  await requirePermission("edit", "lead_intelligence", input.contactId)

  const supabase = createServiceClient()
  const { generateAIJSON } = await import("./ai-generate")

  // Resolve the SUBJECT from the caller's own tenant. contacts.id — not
  // leads.id, not users.id, not agents.id — is what unified_lead_profile
  // .contact_id references and what the CRM drawer passes.
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    // ONE STRING LITERAL, deliberately. supabase-js derives the row type by
    // parsing this argument at compile time, so a runtime concatenation
    // ("a, b, " + "c") defeats the inference and the row silently degrades to
    // GenericStringError — every field access on it then fails to typecheck.
    .select("id, brokerage_id, email, phone, first_name, last_name, source, dnc_status, email_opt_out, sms_opt_out, phone_opt_out")
    .eq("id", input.contactId)
    .eq("brokerage_id", auth.brokerageId)
    .maybeSingle()

  if (contactError) {
    console.error("[lead-intelligence] Contact read error:", contactError)
    return { success: false, error: contactError.message }
  }
  if (!contact) return { success: false, error: "That contact is not in this brokerage" }

  const leadSource = input.source ?? (contact.source as string | null) ?? "crm_contact"

  // Existing profile for this contact, in this brokerage.
  const { data: existing, error: existingError } = await supabase
    .from("unified_lead_profile")
    .select("*")
    .eq("contact_id", contact.id)
    .eq("brokerage_id", auth.brokerageId)
    .maybeSingle()

  if (existingError) {
    console.error("[lead-intelligence] Profile lookup error:", existingError)
    return { success: false, error: existingError.message }
  }

  let profile = existing

  if (!profile) {
    // DESTRUCTURE THE ERROR. This was `const { data: newProfile } = …` followed
    // by `profile.id` — an RLS/constraint refusal came back as data:null and
    // the next line threw a TypeError instead of reporting the refusal.
    const { data: newProfile, error: insertError } = await supabase
      .from("unified_lead_profile")
      .insert({
        brokerage_id: auth.brokerageId,
        contact_id: contact.id,
        lead_source: leadSource,
        confidence_score: 0,
        intent_type: "unknown",
        intent_strength: "researching",
        first_detected_date: new Date().toISOString(),
        contact_email: contact.email,
        contact_phone: contact.phone,
        enrichment_sources: ["crm_contact"],
      })
      .select()
      .maybeSingle()

    if (insertError) {
      console.error("[lead-intelligence] Profile insert error:", insertError)
      return { success: false, error: insertError.message }
    }
    if (!newProfile) return { success: false, error: "Profile was not created" }
    profile = newProfile
  }

  const allSignals = await getAllSignalsForProfile(profile.id, auth.brokerageId, contact.id)

  const prompt = `Analyze signals to determine real estate intent:

BEHAVIORAL DATA: ${JSON.stringify(allSignals.behavioral)}
PROPERTY DATA: ${JSON.stringify(allSignals.property)}

{
  "unified_intent": "buyer|seller|both",
  "confidence_score": 0-100,
  "intent_strength": "browsing|researching|active",
  "estimated_timeline": "immediate|1-3_months|3-6_months|6-12_months|12+_months|researching",
  "motivation_summary": "Why they're looking",
  "key_signals": ["top signals"],
  "ready_for_outreach": boolean
}`

  try {
    const intelligenceData = await generateAIJSON(prompt)
    const intelligence = intelligenceData.data

    if (!intelligence) return { success: false, error: "No intelligence data returned" }

    const intelligenceAny = intelligence as Record<string, unknown>

    // The model returns free text. Anything outside the vocabulary the rest of
    // this rail uses (see TEMPERATURES / INTENT_TYPES / … above) is dropped
    // rather than written, so a hallucinated "very_hot" can never reach a
    // column the triage UI then cannot round-trip.
    const rawScore = Number(intelligenceAny.confidence_score)
    const score100 = Number.isFinite(rawScore) ? Math.min(Math.max(rawScore, 0), 100) : 0
    const intentType = intelligenceAny.unified_intent
    const intentStrength = intelligenceAny.intent_strength
    const timeline = intelligenceAny.estimated_timeline

    // Consent: never RECOMMEND outreach the consent rail would refuse outright.
    const allChannelsClosed =
      contact.dnc_status === true ||
      (contact.email_opt_out === true &&
        contact.sms_opt_out === true &&
        contact.phone_opt_out === true)

    const patch: Record<string, unknown> = {
      confidence_score: score100 / 100, // 0–1, matching both wired readers
      temperature: score100 > 70 ? "hot" : score100 > 40 ? "warm" : "cold",
      ready_for_outreach: allChannelsClosed ? false : Boolean(intelligenceAny.ready_for_outreach),
      ai_summary:
        typeof intelligenceAny.motivation_summary === "string"
          ? intelligenceAny.motivation_summary.slice(0, 4000)
          : null,
      motivation_signals: Array.isArray(intelligenceAny.key_signals)
        ? intelligenceAny.key_signals
        : [],
      enrichment_sources: ["crm_contact", "ai_inference"],
      last_analyzed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    if (typeof intentType === "string" && (INTENT_TYPES as readonly string[]).includes(intentType)) {
      patch.intent_type = intentType
    }
    if (
      typeof intentStrength === "string" &&
      (INTENT_STRENGTHS as readonly string[]).includes(intentStrength)
    ) {
      patch.intent_strength = intentStrength
    }
    if (typeof timeline === "string" && (TIMELINES as readonly string[]).includes(timeline)) {
      patch.estimated_timeline = timeline
    }

    const { data: updated, error: updateError } = await supabase
      .from("unified_lead_profile")
      .update(patch)
      .eq("id", profile.id)
      .eq("brokerage_id", auth.brokerageId)
      .select()
      .maybeSingle()

    if (updateError) {
      console.error("[lead-intelligence] Profile update error:", updateError)
      return { success: false, error: updateError.message }
    }
    // A filtered update matching nothing is not an error to PostgREST.
    if (!updated) return { success: false, error: "That profile was not found" }

    // PROVENANCE — the rail's own signal ledger, brokerage-stamped at insert.
    const { error: ledgerError } = await supabase.from("intelligence_signals_log").insert({
      brokerage_id: auth.brokerageId,
      contact_id: contact.id,
      lead_profile_id: updated.id,
      signal_type: "ai_unified_profile",
      signal_data_json: {
        lead_source: leadSource,
        sources: ["crm_contact", "ai_inference"],
        behavioral_rows: allSignals.behavioral.length,
        property_rows: allSignals.property.length,
        confidence_0_1: patch.confidence_score,
        outreach_suppressed_by_consent: allChannelsClosed,
        actor_user_id: auth.userId,
      },
      signal_strength: Math.round(score100 / 10),
      detected_at: new Date().toISOString(),
    })
    if (ledgerError) {
      // Provenance is not optional on this rail — an inference we cannot
      // account for is reported, not quietly kept.
      console.error("[lead-intelligence] Provenance ledger write failed:", ledgerError)
      return { success: false, error: `Profile saved but provenance failed: ${ledgerError.message}` }
    }

    revalidatePath("/crm")
    revalidatePath("/leads")
    return { success: true, profile: updated, intelligence }
  } catch (error) {
    console.error("[v0] Unified profile error:", error)
    return { success: false, error: String(error) }
  }
}

/**
 * Signals feeding the unified profile.
 *
 * COLUMN WITH NO WRITER: this read used to filter behavioral_signals on
 * `unified_profile_id` and property_intelligence on `profile_id`. Nothing in
 * the codebase has ever written either column (verified by search), so both
 * reads returned a permanent empty set and the AI prompt above was always fed
 * "[] / []" — the profile scored on nothing while looking like it scored on
 * evidence. Both tables also carry contact_id, which IS written, so the
 * contact is used as the resolving key and the legacy profile keys are kept
 * as a second lane for any row that does get stamped later.
 */
async function getAllSignalsForProfile(profileId: string, brokerageId: string, contactId?: string) {
  // SERVICE CLIENT — RLS does not apply, so the tenant filter has to be here
  // explicitly. Both tables carry a NULLABLE brokerage_id whose policy is
  // `IS NULL OR = current_user_brokerage_id()`, which is not a boundary even
  // for a user client.
  const supabase = createServiceClient()

  const behavioralQuery = (
    contactId
      ? supabase
          .from("behavioral_signals")
          .select("*")
          .or(`contact_id.eq.${contactId},unified_profile_id.eq.${profileId}`)
      : supabase.from("behavioral_signals").select("*").eq("unified_profile_id", profileId)
  ).eq("brokerage_id", brokerageId)

  const propertyQuery = (
    contactId
      ? supabase
          .from("property_intelligence")
          .select("*")
          .or(`contact_id.eq.${contactId},profile_id.eq.${profileId}`)
      : supabase.from("property_intelligence").select("*").eq("profile_id", profileId)
  ).eq("brokerage_id", brokerageId)

  const [{ data: behavioral, error: behavioralError }, { data: property, error: propertyError }] =
    await Promise.all([behavioralQuery, propertyQuery])

  if (behavioralError) console.error("[lead-intelligence] Behavioral signal read error:", behavioralError)
  if (propertyError) console.error("[lead-intelligence] Property signal read error:", propertyError)

  return {
    behavioral: behavioral || [],
    property: property || [],
    total_count: (behavioral?.length || 0) + (property?.length || 0),
  }
}

// ============================================
// IDENTITY RESOLUTION
// ============================================

export async function resolveIdentity(behavioralSignalId: string) {
  // Reads contact PII via email match — require auth
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = createServiceClient()

  const { data: signal } = await supabase.from("behavioral_signals").select("*").eq("id", behavioralSignalId).single()

  if (!signal) return { success: false, error: "Signal not found" }

  try {
    if (signal.email_captured) {
      // Only match within caller's brokerage
      const { data: contact } = await supabase
        .from("contacts")
        .select("*")
        .eq("email", signal.email_captured)
        .eq("brokerage_id", auth.brokerageId)
        .maybeSingle()

      if (contact) {
        await supabase.from("behavioral_signals").update({ identified: true, contact_id: contact.id }).eq("id", signal.id)
        return { success: true, contact, method: "email_match" }
      }
    }

    return { success: false, message: "Unable to resolve identity" }
  } catch (error) {
    console.error("[v0] Identity resolution error:", error)
    return { success: false, error: String(error) }
  }
}

// ============================================
// INTELLIGENT VALUE DELIVERY
// ============================================

export async function deliverIntelligentValue(leadProfileId: string) {
  // Paid AI inference + writes to outreach log — require auth
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = createServiceClient()
  const { generateAIJSON } = await import("./ai-generate")

  const { data: profile } = await supabase
    .from("unified_lead_profile")
    .select("*")
    .eq("id", leadProfileId)
    .eq("brokerage_id", auth.brokerageId)
    .single()

  if (!profile || !profile.contact_email) {
    return { success: false, error: "No email available" }
  }

  const prompt = `Create value-first email:

Intent: ${profile.intent_type}
Timeline: ${profile.estimated_timeline}

{
  "subject": "Email subject",
  "emailBody": "Helpful email content with value",
  "valueOffer": "Free resource to provide"
}`

  try {
    const emailData = await generateAIJSON(prompt)

    const valueOffer = profile.intent_type === "seller" ? {
      type: "cma_report",
      link: `/home-value?ref=${profile.id}`,
    } : {
      type: "neighborhood_tool",
      link: `/tools/neighborhood-compare?ref=${profile.id}`,
    }

    // intelligent_outreach_log schema: id, contact_id, outreach_type, channel,
    // content, result, created_at, brokerage_id. The previous code wrote
    // `lead_profile_id` (column doesn't exist — insert was silently failing).
    // Map the unified_lead_profile.id → contacts.id via the contact_email
    // captured on the profile, falling back to NULL if the profile isn't
    // linked to a contact yet.
    const { data: profileRow } = await supabase
      .from("unified_lead_profile")
      .select("contact_id")
      .eq("id", leadProfileId)
      .maybeSingle()
    await supabase.from("intelligent_outreach_log").insert({
      brokerage_id: auth.brokerageId,
      contact_id:   profileRow?.contact_id ?? null,
      outreach_type: "value_first_email",
      channel:       "email",
      content:       JSON.stringify({ subject: (emailData.data as any)?.subject, body: (emailData.data as any)?.emailBody, value_offer: valueOffer }),
      created_at:    new Date().toISOString(),
    })

    return { success: true, email: emailData.data, valueOffer }
  } catch (error) {
    console.error("[v0] Intelligent value delivery error:", error)
    return { success: false, error: String(error) }
  }
}

// ============================================
// EXTERNAL BEHAVIOR TRACKING (Zillow, Realtor.com, etc.)
// ============================================

/**
 * DELIBERATELY NOT WIRED TO ANY SURFACE.
 *
 * NAMED, WIRED, MORE COMPLETE RIVAL: the real-estate-site collect lane in
 * app/api/cron/lead-scraping/route.ts —
 * lib/lead-pipeline/scraper-parsers.ts (buildPropertySearchUrl /
 * parsePropertySearchResults / parseBuyerSavedSearches /
 * normalizeBatchDataRecord) feeding lib/lead-pipeline:processRawRecord, with
 * territory resolution, per-vendor spend metering and the promotion gate. That
 * lane is governed; this one is a bare for-loop over three scrapers.
 *
 * NOT DELETED — it writes external_behavior, which the rival lane does not, so
 * it is an independent twin, not a proven port.
 *
 * COMPLIANCE — WHY IT MUST NOT BE WIRED AS WRITTEN: the property_intelligence
 * insert below persists owner_name, owner_occupied, years_owned and
 * equity_estimate. That is a financial profile of a NAMED HOMEOWNER who has no
 * relationship with the brokerage, assembled from a location string typed into
 * a form. There is no consent record, no legitimate-interest assessment and no
 * subject-rights linkage for those rows anywhere in this codebase. Reporting
 * this rather than surfacing it is the correct outcome.
 */
export async function scrapeExternalBehavior(targetLocation: { city: string; state: string; zip?: string }) {
  // Paid Apify + BatchData scrapers — require auth to prevent budget drain
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = createServiceClient()
  const { ApifyClient } = await import("@/lib/apify-client")
  const { BatchDataClient } = await import("@/lib/batchdata-client")
  const { generateAIJSON } = await import("./ai-generate")

  const apify = new ApifyClient()
  const batchData = new BatchDataClient()

  try {
    // Scrape Zillow using Apify
    const zillowData = await apify.scrapeZillow(`${targetLocation.city}, ${targetLocation.state}`)

    // Scrape Realtor.com using Apify
    const realtorData = await apify.scrapeRealtorDotCom(`${targetLocation.city}, ${targetLocation.state}`)

    // Scrape Redfin using Apify
    const redfinData = await apify.scrapeRedfin(`${targetLocation.city}, ${targetLocation.state}`)

    // Track most viewed properties across all sites
    const allProperties = [...(zillowData || []), ...(realtorData || []), ...(redfinData || [])]

    for (const property of allProperties.slice(0, 20)) {
      // Enrich property data with BatchData
      const enrichedData = await batchData.searchByAddress(property.address || "", targetLocation.city, targetLocation.state)

      const propertyDetails = enrichedData[0] || {}

      await supabase.from("external_behavior").insert({
        brokerage_id: auth.brokerageId,
        source: property.source || "zillow",
        activity_type: "property_view",
        property_addresses_viewed: property.address ? [property.address] : [],
        location: targetLocation.city,
        detected_interest_level: "researching",
        // PROVENANCE, NOT DECORATION. This lane calls Apify (scrapeZillow /
        // scrapeRealtorDotCom / scrapeRedfin), never ZenRows. The column was
        // hard-coded true, which mislabelled every row's collection vendor —
        // exactly the field a vendor audit or a subject-access request reads.
        detected_via_zenrows: false,
        scraped_at: new Date().toISOString(),
      })

      // Store enriched property intelligence
      await supabase.from("property_intelligence").insert({
        brokerage_id: auth.brokerageId,
        property_address: property.address,
        city: targetLocation.city,
        state: targetLocation.state,
        estimated_value: property.price || propertyDetails.estimatedValue,
        property_type: property.propertyType || propertyDetails.propertyType,
        bedrooms: property.bedrooms || propertyDetails.bedrooms,
        bathrooms: property.bathrooms || propertyDetails.bathrooms,
        square_feet: property.sqft || propertyDetails.squareFeet,
        owner_name: propertyDetails.ownerName,
        owner_occupied: propertyDetails.ownerOccupied,
        years_owned: propertyDetails.yearsOwned,
        equity_estimate: propertyDetails.equity,
      })
    }

    return { success: true, propertiesTracked: allProperties.length }
  } catch (error) {
    console.error("[v0] External behavior scraping error:", error)
    return { success: false, error: String(error) }
  }
}

/**
 * Attach one observed off-site activity to an EXISTING tracked visitor.
 *
 * NOT WIRED, AND CANNOT MEANINGFULLY BE: it requires a behavioral_signals row
 * for the visitor, and the only producer of those rows is trackBehavior, which
 * is itself unwired (no visitor-consent artifact — see its header). Wiring a
 * consumer whose producer is dark would surface a control that always answers
 * "No behavioral signal found for visitor". It is hardened and left honest.
 *
 * @param data.detectedViaZenrows Which vendor observed this. It is the caller's
 * to state — it used to be hard-coded `true` regardless of who actually
 * collected it, which is a provenance lie in a subject-access-request column.
 */
export async function trackExternalActivity(data: {
  visitorId: string
  source: string
  behaviorType: string
  propertyAddress?: string
  searchCriteria?: Record<string, unknown> | null
  location: string
  detectedViaZenrows?: boolean
}) {
  // Behavioral signal write — require auth. Visitors don't call this directly;
  // it's called from authenticated server flows that know a visitor's UUID.
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = createServiceClient()

  try {
    // Resolve the visitor's signal INSIDE the caller's tenant. This is a
    // service client, so RLS is not in play and the filter has to be explicit;
    // without it a visitor_id guessed from another tenant would be updated.
    const { data: signal, error: signalError } = await supabase
      .from("behavioral_signals")
      .select("*")
      .eq("visitor_id", data.visitorId)
      .eq("brokerage_id", auth.brokerageId)
      .maybeSingle()

    if (signalError) {
      console.error("[lead-intelligence] Behavioral signal read error:", signalError)
      return { success: false, error: signalError.message }
    }
    if (!signal) {
      return { success: false, error: "No behavioral signal found for visitor" }
    }

    // Log external behavior — stamp brokerage from caller's session
    const { error: behaviorError } = await supabase.from("external_behavior").insert({
      behavioral_signal_id: signal.id,
      brokerage_id: auth.brokerageId,
      source: data.source,
      activity_type: data.behaviorType,
      property_addresses_viewed: data.propertyAddress ? [data.propertyAddress] : [],
      // COLUMN WITH NO WRITER: external_behavior.search_criteria_json existed
      // and nothing in the codebase ever filled it, while this function
      // accepted a `searchCriteria` argument and silently dropped it on the
      // floor. The caller's criteria are persisted now.
      search_criteria_json: data.searchCriteria ?? null,
      location: data.location,
      detected_interest_level: "active",
      detected_via_zenrows: data.detectedViaZenrows === true,
      scraped_at: new Date().toISOString(),
    })

    if (behaviorError) {
      console.error("[lead-intelligence] External behavior insert error:", behaviorError)
      return { success: false, error: behaviorError.message }
    }

    // Update signal strength based on external activity
    const { error: bumpError } = await supabase
      .from("behavioral_signals")
      .update({
        intent_confidence_score: Math.min((signal.intent_confidence_score || 0) + 10, 100),
      })
      .eq("id", signal.id)
      .eq("brokerage_id", auth.brokerageId)

    if (bumpError) {
      console.error("[lead-intelligence] Signal score update error:", bumpError)
      return { success: false, error: bumpError.message }
    }

    return { success: true, signalId: signal.id }
  } catch (error) {
    console.error("[v0] External activity tracking error:", error)
    return { success: false, error: String(error) }
  }
}

// ============================================
// MOTIVATED SELLER DETECTION (Public Records + OSINT)
// ============================================

export async function fetchMotivatedSellers(targetLocation: { city: string; state: string }) {
  // Paid OSINT + Apify + BatchData scrapers — require auth to prevent budget drain
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = createServiceClient()
  const osint = new OSINTClient()
  const { ApifyClient } = await import("@/lib/apify-client")
  const { BatchDataClient } = await import("@/lib/batchdata-client")
  const { generateAIJSON } = await import("./ai-generate")

  const apify = new ApifyClient()
  const batchData = new BatchDataClient()

  try {
    // Get motivated sellers from BatchData (public records, high equity, etc.)
    const batchDataSellers = await batchData.getMotivatedSellers({
      city: targetLocation.city,
      state: targetLocation.state,
      minEquity: 50000,
    })

    // Search for foreclosure filings
    const foreclosures = await (osint as any).searchCourtRecords("", targetLocation.state)

    // Scrape Nextdoor using Apify
    const nextdoorPosts = await apify.scrapeSocialMedia("nextdoor", `${targetLocation.city} moving selling house`)

    // Scrape Reddit using Apify
    const redditPosts = await apify.scrapeSocialMedia("reddit", `${targetLocation.city} selling house need to sell`)

    // Scrape Facebook using Apify
    const fbPosts = await apify.scrapeSocialMedia("facebook", `${targetLocation.city} selling house`)

    // Combine all sources
    const allSignals = [...batchDataSellers, ...nextdoorPosts, ...redditPosts, ...fbPosts]

    for (const signal of allSignals) {
      const prompt = `Analyze this post for seller motivation:

Post: ${signal.content || signal.text}
Source: ${signal.source || "unknown"}
Location: ${targetLocation.city}

Determine:
{
  "is_motivated_seller": boolean,
  "motivation_level": "low|medium|high|urgent",
  "motivation_factors": ["list of reasons"],
  "urgency_timeline": "immediate|1month|3months|unknown",
  "estimated_property_value": number or null,
  "contact_method": "How to reach out"
}`

      const analysis = await generateAIJSON(prompt)

      if (analysis.data?.is_motivated_seller) {
        await supabase.from("motivated_seller_signals").insert({
          brokerage_id: auth.brokerageId,
          lead_id: signal.contact_id || null,
          signal_type: "social_media",
          signal_details: {
            property_address: signal.property_address || "Unknown",
            motivation_factors: analysis.data.motivation_factors,
            urgency_level: analysis.data.motivation_level,
            timeframe: analysis.data.urgency_timeline,
          },
          signal_strength: analysis.data.motivation_level === "urgent" ? "urgent" : analysis.data.motivation_level === "high" ? "strong" : "moderate",
          detected_via: signal.source,
        })

        // Create social intelligence record
        await supabase.from("social_intelligence").insert({
          brokerage_id: auth.brokerageId,
          source: signal.source,
          post_content: signal.content || signal.text,
          post_url: signal.url,
          detected_location: targetLocation.city,
          intent_keywords_matched: analysis.data.motivation_factors,
          ai_intent_score: analysis.data.motivation_level === "urgent" ? 95 : 70,
          urgency_level: analysis.data.motivation_level,
        })
      }
    }

    return { success: true, motivatedSellers: allSignals.length }
  } catch (error) {
    console.error("[v0] Motivated seller detection error:", error)
    return { success: false, error: String(error) }
  }
}
