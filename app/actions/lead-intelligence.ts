"use server"

/**
 * ⚠️ SCHEMA-DRIFT WARNING
 *
 * Most of the INSERT/UPDATE statements in this file write to columns that
 * DO NOT EXIST on the current live schema. The code was written against an
 * older table design (visitor-session model) but the schema is now a lean
 * scoring model. Concrete drifts observed against live Supabase
 * (project hrvaqgvukzxfskkcrwbt):
 *
 *   behavioral_signals      — code writes visitor_id, total_sessions,
 *                             last_seen_date, ip_address, user_agent, city,
 *                             state, zip, intent_type,
 *                             intent_confidence_score, email_captured,
 *                             identified, unified_profile_id.
 *                             Live cols: contact_id, signal_type,
 *                             signal_value, weight, detected_at,
 *                             brokerage_id.
 *
 *   site_activity           — code writes behavioral_signal_id, page_visited,
 *                             time_on_page_seconds, action_taken,
 *                             search_terms, timestamp.
 *                             Live cols: contact_id, page_url,
 *                             duration_seconds, occurred_at, brokerage_id.
 *
 *   external_behavior       — code writes behavioral_signal_id,
 *                             behavior_type, property_address, location,
 *                             detected_interest_level, timestamp.
 *                             Live cols: contact_id, source, event_type,
 *                             event_data, occurred_at, brokerage_id.
 *
 *   google_search_intel.    — code writes search_query, detected_location,
 *                             related_searches, trend,
 *                             potential_leads_count, scraped_at.
 *                             Live cols: contact_id, intent_summary,
 *                             high_value_keywords, intent_score,
 *                             analyzed_at, brokerage_id.
 *
 *   social_intelligence     — code writes source, post_url, post_content,
 *                             author, post_date, location_*,
 *                             ai_intent_score, intent_summary, urgency_level,
 *                             keywords. Live cols: contact_id, platform,
 *                             signal_type, signal_data, detected_at,
 *                             brokerage_id.
 *
 *   property_intelligence   — code writes city/state/zip + property
 *                             attributes as columns. Live design folds these
 *                             into a single jsonb `data` column.
 *
 *   motivated_seller_signals — code uses lead_id + signal_details + detected_via.
 *                             Live: contact_id + signal_data, no detected_via.
 *
 *   intelligent_outreach_log — code wrote lead_profile_id + value_offer.
 *                              Live: contact_id + channel + content. (Fixed
 *                              for deliverIntelligentValue; the column-name
 *                              bug there was rewritten in commit b6cd0b48.)
 *
 * IMPACT: every insert above fails silently at runtime (Postgres rejects
 * the row with "column does not exist") UNLESS the code path explicitly
 * catches the error. Reads against these tables return shapes the calling
 * code doesn't recognize, so downstream UI shows empty results.
 *
 * The auth gates + brokerage_id stamping added in this session are still
 * valuable — they block unauthenticated callers from burning paid AI/
 * scraper budget — but the lead-intelligence flow does NOT currently
 * persist what it claims to persist.
 *
 * RESOLUTION (future work, not in this commit):
 *   Pick one of:
 *     (a) Migrate the schema forward: add visitor_id, ip_address, etc.
 *         columns to behavioral_signals + site_activity + external_behavior
 *         to support the code's session-tracking model.
 *     (b) Rewrite this file to use the existing schema's scoring model
 *         (one row per signal observation, with signal_value + weight).
 *     (c) Move visitor-tracking writes to the website_visitors table
 *         (which already exists and has the right shape — see
 *         app/api/track/identify/route.ts), and use behavioral_signals
 *         only for derived per-contact signals.
 *
 * In the meantime the file ships with explicit auth gates so the
 * security audit is satisfied even if the functional behavior is degraded.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requirePermission } from "@/lib/security"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { revalidatePath } from "next/cache"
import { ZenrowsClient, BatchDataClient, PeopleDataClient } from "@/lib/external"
import { IDXBrokerClient } from "@/lib/idxbroker-client"
import { OSINTClient } from "@/lib/osint-client"
import { calculateLeadScore } from "@/lib/services/lead-management.service"

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
  brokerage_id?: string  // optional — set by widget bootstrap on agent sites
}) {
  try {
    const supabase = createServiceClient()
    const { generateAIJSON } = await import("./ai-generate")

    // Detect location from IP (simplified - would use IP geolocation service)
    const location = { city: "Unknown", state: "Unknown", zip: "" }

    // Get or create behavioral signal
    const { data: signal, error: signalError } = await supabase
      .from("behavioral_signals")
      .select("*")
      .eq("visitor_id", sessionData.visitor_id)
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
      // Create new signal — stamp brokerage_id when supplied (from widget on agent site)
      const { data: newSignal } = await supabase
        .from("behavioral_signals")
        .insert({
          visitor_id: sessionData.visitor_id,
          brokerage_id: sessionData.brokerage_id ?? null,
          ip_address: sessionData.ip_address,
          user_agent: sessionData.user_agent,
          city: location.city,
          state: location.state,
          zip: location.zip,
        })
        .select()
        .single()

      signalId = newSignal!.id
    }

    // Log site activity — inherits brokerage from the signal
    await supabase.from("site_activity").insert({
      behavioral_signal_id: signalId,
      brokerage_id: sessionData.brokerage_id ?? signal?.brokerage_id ?? null,
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
  "timeline_indicator": "immediate|3-6months|exploring|unknown",
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
            brokerage_id: sessionData.brokerage_id ?? signal?.brokerage_id ?? null,
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

export async function scrapeSocialSignalsWithZenRows(location: {
  city: string
  state: string
  zip?: string
}) {
  // Paid scraper — requires auth to prevent budget drain
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error, signals: [], count: 0 }

  const brokerageId = auth.brokerageId

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

export async function enrichPropertyIntelligence(propertyData: {
  address: string
  city: string
  state: string
  zip: string
}) {
  // Calls paid BatchData API; require auth
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  try {
    const supabase = createServiceClient()

    // Use BatchData API or similar to get property intelligence
    // For now, creating a placeholder
    console.log("[v0] Enriching property intelligence for:", propertyData.address)

    const { data: property } = await supabase
      .from("property_intelligence")
      .insert({
        brokerage_id: auth.brokerageId,
        property_address: propertyData.address,
        city: propertyData.city,
        state: propertyData.state,
        zip: propertyData.zip,
        last_sale_date: null,
        last_sale_price: null,
        estimated_value: null,
        ownership_duration_years: null,
        property_type: null,
        bedrooms: null,
        bathrooms: null,
        square_feet: null,
        lot_size: null,
        year_built: null,
        data_sources: ["manual_entry"],
      })
      .select()
      .single()

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

  const dataSources: string[] = []

  try {
    // 1. Enrich with people data
    if (lead.email || lead.phone) {
      await enrichWithPeopleData(leadId, lead)
      dataSources.push("peopledata")
    }

    // 2. Get property ownership data
    if (lead.address || lead.city) {
      await enrichWithPropertyOwnership(leadId, lead)
      dataSources.push("batchdata_property")
    }

    // 3. Search for online activity
    await searchOnlineActivity(leadId, lead)
    dataSources.push("osint")

    // 4. Get IDX Broker interactions
    await syncIDXBrokerActivity(leadId, lead)
    dataSources.push("idx_broker")

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
    await updateIntelligenceProfile(leadId, dataSources)

    revalidatePath("/intelligence")
    return { success: true, dataSources }
  } catch (error) {
    console.error("[v0] Enrichment error:", error)
    return { success: false, error: String(error) }
  }
}

async function enrichWithPeopleData(leadId: string, lead: Record<string, unknown>) {
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
      await supabase.from("lead_people_data").insert({
        lead_id: leadId,
        demographic_data: enrichedData.demographics as Record<string, unknown> | null,
        employment_data: enrichedData.employment as Record<string, unknown> | null,
        financial_indicators: enrichedData.financial as Record<string, unknown> | null,
        life_events: enrichedData.lifeEvents as Record<string, unknown>[] | null,
        social_presence: enrichedData.social as unknown as Record<string, unknown> | null,
        contact_enrichment: enrichedData.additionalContacts as Record<string, unknown>[] | null,
        data_source: "peopledata",
      })

      // Collect OSINT data from social profiles
      const socialProfiles = enrichedData.social as unknown as Record<string, unknown> | null
      if (socialProfiles?.profiles) {
        for (const profile of (socialProfiles.profiles as Record<string, unknown>[])) {
          await supabase.from("lead_osint_data").insert({
            lead_id: leadId,
            data_type: "social_profile",
            data_source: (profile.platform as string) || "unknown",
            data_content: profile,
            confidence_score: 0.85,
          })
        }
      }
    }
  } catch (error) {
    console.error("[v0] PeopleData enrichment error:", error)
  }
}

async function enrichWithPropertyOwnership(leadId: string, lead: Record<string, unknown>) {
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

      await supabase.from("lead_property_ownership").insert({
        lead_id: leadId,
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
    }
  } catch (error) {
    console.error("[v0] Property ownership enrichment error:", error)
  }
}

async function searchOnlineActivity(leadId: string, lead: any) {
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
        await supabase.from("google_search_activity").insert({
          lead_id: leadId,
          search_location: `${lead.city}, ${lead.state}`,
          search_terms: [query],
          detected_intent: detectedIntent,
          search_patterns: { results_count: results.length },
          scraped_via: "zenrows",
        })
      }
    }

    if (lead.city && lead.state) {
      await searchNextdoorActivity(leadId, lead)
    }

    await searchRealEstateSites(leadId, lead)
  } catch (error) {
    console.error("[v0] Online activity search error:", error)
  }
}

async function searchNextdoorActivity(leadId: string, lead: any) {
  const supabase = createServiceClient()
  const zenrows = new ZenrowsClient()

  try {
    const nextdoorUrl = `https://nextdoor.com/search/?q=${encodeURIComponent(`${lead.city} ${lead.state} moving selling home`)}`
    const { posts: nextdoorResults } = await zenrows.scrapeNextdoor(nextdoorUrl)

    for (const activity of nextdoorResults as any[]) {
      const nameMatch = activity.content.toLowerCase().includes(`${lead.first_name} ${lead.last_name}`.toLowerCase())

      if (nameMatch || activity.relevance_score > 70) {
        await supabase.from("nextdoor_activity").insert({
          lead_id: leadId,
          activity_type: activity.type,
          content_snippet: activity.content.substring(0, 500),
          neighborhood: activity.neighborhood,
          detected_keywords: activity.matched_keywords,
          activity_url: activity.url,
          relevance_score: activity.relevance_score,
        })
      }
    }
  } catch (error) {
    console.error("[v0] Nextdoor search error:", error)
  }
}

async function searchRealEstateSites(leadId: string, lead: any) {
  const supabase = createServiceClient()
  const zenrows = new ZenrowsClient()

  const sites = ["zillow", "realtor.com", "redfin"]

  for (const site of sites) {
    try {
      const siteUrl = `https://www.${site === "realtor.com" ? "realtor.com" : site + ".com"}/homes-for-sale/${encodeURIComponent(lead.city + "-" + lead.state)}`
      const searchResults = await zenrows.scrape(siteUrl) as any

      if (searchResults.properties?.length > 0) {
        await supabase.from("lead_property_searches").insert({
          lead_id: leadId,
          search_source: site,
          search_location: `${lead.city}, ${lead.state}`,
          properties_viewed: searchResults.properties,
          search_criteria: searchResults.filters,
          detected_via: "zenrows_scrape",
        })
      }
    } catch (error) {
      console.error(`[v0] ${site} scraping error:`, error)
    }
  }
}

async function syncIDXBrokerActivity(leadId: string, lead: any) {
  const supabase = createServiceClient()
  const idx = new IDXBrokerClient()

  try {
    const activity = await idx.getLeadActivity(lead.email)

    for (const interaction of activity) {
      await supabase.from("idx_property_interactions").insert({
        lead_id: leadId,
        property_mls_id: interaction.mlsID,
        property_address: interaction.address,
        property_details: {
          price: interaction.listPrice,
          beds: interaction.bedrooms,
          baths: interaction.bathrooms,
          sqft: interaction.sqft,
          propertyType: interaction.propType,
        },
        interaction_type: interaction.type,
        time_spent_seconds: interaction.timeSpent,
        interaction_metadata: interaction.metadata,
        interacted_at: interaction.timestamp,
      })
    }
  } catch (error) {
    console.error("[v0] IDX sync error:", error)
  }
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

async function updateIntelligenceProfile(leadId: string, dataSources: string[]) {
  const supabase = createServiceClient()

  const { data: propertySearches } = await supabase.from("lead_property_searches").select("*").eq("lead_id", leadId)

  const { data: idxInteractions } = await supabase.from("idx_property_interactions").select("*").eq("lead_id", leadId)

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

  idxInteractions?.forEach((interaction: any) => {
    if (
      interaction.property_details?.propertyType &&
      !propertyTypes.includes(interaction.property_details.propertyType)
    ) {
      propertyTypes.push(interaction.property_details.propertyType)
    }
    if (interaction.property_details?.price) {
      minPrice = Math.min(minPrice, interaction.property_details.price)
      maxPrice = Math.max(maxPrice, interaction.property_details.price)
    }
  })

  const priceRange =
    minPrice !== Number.POSITIVE_INFINITY ? `$${minPrice.toLocaleString()} - $${maxPrice.toLocaleString()}` : null

  let timeline = "researching"
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
    propertyViews: idxInteractions?.length || 0,
    searches: propertySearches?.length || 0,
  })

  const qualificationScore = calculateQualificationScore({
    hasPropertyOwnership: (propertyOwnership && propertyOwnership.length > 0) ?? false,
    engagementScore: engagementScores?.overall_score || 0,
    hasFinancialData: !!propertyOwnership?.[0]?.equity_estimate,
  })

  await supabase.from("lead_intelligence").upsert({
    lead_id: leadId,
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
}

function calculateMotivationScore(data: {
  engagementScore: number
  sellerSignals: number
  propertyViews: number
  searches: number
}): number {
  let score = 0
  score += data.engagementScore * 0.4
  score += Math.min(30, data.sellerSignals * 10)
  score += Math.min(20, data.propertyViews * 2)
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

export async function updateLeadProfile(profileId: string, updates: any) {
  try {
    await requirePermission("edit", "lead_intelligence", profileId)
    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from("unified_lead_profile")
      .update(updates)
      .eq("id", profileId)
      .select()
      .single()

    if (error) throw error

    revalidatePath("/intelligence")
    return { success: true, profile: data }
  } catch (error) {
    console.error("[v0] Error updating lead profile:", error)
    return { success: false, error: String(error) }
  }
}

export async function getAgentWorkloadStats() {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error, workload: {} }

  try {
    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from("unified_lead_profile")
      .select("assigned_agent_id, temperature, ready_for_outreach")
      .eq("brokerage_id", auth.brokerageId)

    if (error) throw error

    // Aggregate by agent
    const workload: Record<string, any> = {}
    data?.forEach((profile) => {
      if (!profile.assigned_agent_id) return

      if (!workload[profile.assigned_agent_id]) {
        workload[profile.assigned_agent_id] = {
          total: 0,
          hot: 0,
          warm: 0,
          cold: 0,
          ready: 0,
        }
      }

      workload[profile.assigned_agent_id].total++
      workload[profile.assigned_agent_id][profile.temperature]++
      if (profile.ready_for_outreach) {
        workload[profile.assigned_agent_id].ready++
      }
    })

    return { success: true, workload }
  } catch (error) {
    console.error("[v0] Error getting agent workload:", error)
    return { success: false, error: String(error), workload: {} }
  }
}

// ============================================
// GOOGLE SEARCH INTENT ANALYSIS
// ============================================

export async function analyzeGoogleSearchIntent(targetLocation: { id: string; city: string; state: string; zip?: string }) {
  // Paid ZenRows scraping — require auth
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

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

      await supabase.from("google_search_intelligence").insert({
        brokerage_id: auth.brokerageId,
        search_query: query,
        detected_location: targetLocation.city,
        related_searches: searchData.relatedSearches || [],
        trend: searchData.results?.length > 15 ? "high" : "moderate",
        potential_leads_count: searchData.results?.length || 0,
        scraped_at: new Date().toISOString(),
      })
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

export async function createUnifiedLeadProfile(leadData: { source: string; email?: string; phone?: string }) {
  // Inserts to a brokerage-scoped table — require auth and stamp brokerage_id
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = createServiceClient()
  const { generateAIJSON } = await import("./ai-generate")

  let profile = await findExistingProfile(leadData, auth.brokerageId)

  if (!profile) {
    const { data: newProfile } = await supabase
      .from("unified_lead_profile")
      .insert({
        brokerage_id: auth.brokerageId,
        lead_source: leadData.source,
        confidence_score: 0,
        intent_type: "unknown",
        intent_strength: "researching",
        first_detected_date: new Date().toISOString(),
        contact_email: leadData.email,
        contact_phone: leadData.phone,
      })
      .select()
      .single()

    profile = newProfile
  }

  const allSignals = await getAllSignalsForProfile(profile.id)

  const prompt = `Analyze signals to determine real estate intent:

BEHAVIORAL DATA: ${JSON.stringify(allSignals.behavioral)}
PROPERTY DATA: ${JSON.stringify(allSignals.property)}

{
  "unified_intent": "buyer|seller|both",
  "confidence_score": 0-100,
  "intent_strength": "browsing|researching|active",
  "estimated_timeline": "immediate|1-3months|3-6months",
  "motivation_summary": "Why they're looking",
  "key_signals": ["top signals"],
  "ready_for_outreach": boolean
}`

  try {
    const intelligenceData = await generateAIJSON(prompt)
    const intelligence = intelligenceData.data

    if (!intelligence) return { success: false, error: "No intelligence data returned" }

    const intelligenceAny = intelligence as any
    await supabase
      .from("unified_lead_profile")
      .update({
        confidence_score: intelligenceAny.confidence_score,
        intent_type: intelligenceAny.unified_intent,
        intent_strength: intelligenceAny.intent_strength,
        estimated_timeline: intelligenceAny.estimated_timeline,
        ready_for_outreach: intelligenceAny.ready_for_outreach,
        temperature: intelligenceAny.confidence_score > 70 ? "hot" : intelligenceAny.confidence_score > 40 ? "warm" : "cold",
      })
      .eq("id", profile.id)
      .eq("brokerage_id", auth.brokerageId)

    return { success: true, profile, intelligence }
  } catch (error) {
    console.error("[v0] Unified profile error:", error)
    return { success: false, error: String(error) }
  }
}

async function findExistingProfile(leadData: any, brokerageId: string) {
  const supabase = createServiceClient()

  if (leadData.email) {
    const { data } = await supabase
      .from("unified_lead_profile")
      .select("*")
      .eq("contact_email", leadData.email)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    if (data) return data
  }

  return null
}

async function getAllSignalsForProfile(profileId: string) {
  const supabase = createServiceClient()

  const { data: behavioral } = await supabase.from("behavioral_signals").select("*").eq("unified_profile_id", profileId)
  const { data: property } = await supabase.from("property_intelligence").select("*").eq("profile_id", profileId)

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
        behavior_type: "property_view",
        property_address: property.address,
        location: targetLocation.city,
        detected_interest_level: "researching",
        timestamp: new Date().toISOString(),
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

// Track specific user behavior on external sites (when identifiable)
export async function trackExternalActivity(data: {
  visitorId: string
  source: string
  behaviorType: string
  propertyAddress?: string
  searchCriteria?: any
  location: string
}) {
  // Behavioral signal write — require auth. Visitors don't call this directly;
  // it's called from authenticated server flows that know a visitor's UUID.
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = createServiceClient()

  try {
    // Find or create behavioral signal
    const { data: signal } = await supabase
      .from("behavioral_signals")
      .select("*")
      .eq("visitor_id", data.visitorId)
      .maybeSingle()

    if (!signal) {
      return { success: false, error: "No behavioral signal found for visitor" }
    }

    // Log external behavior — stamp brokerage from caller's session
    await supabase.from("external_behavior").insert({
      behavioral_signal_id: signal.id,
      brokerage_id: auth.brokerageId,
      source: data.source,
      behavior_type: data.behaviorType,
      property_address: data.propertyAddress,
      location: data.location,
      detected_interest_level: "active",
      timestamp: new Date().toISOString(),
    })

    // Update signal strength based on external activity
    await supabase
      .from("behavioral_signals")
      .update({
        intent_confidence_score: Math.min((signal.intent_confidence_score || 0) + 10, 100),
      })
      .eq("id", signal.id)

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
