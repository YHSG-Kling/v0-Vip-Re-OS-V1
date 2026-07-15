"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { KernelEvent } from "@/lib/kernel/events"
import { generateAIText } from "@/lib/ai"
import { fetchOSINTNeighborhoodData } from "@/lib/external/osint-neighborhood"
import { getRentcastMarketStats } from "@/lib/property/rentcast"
import { computeLivabilityScore, isNeighborhoodReportAllowed } from "@/lib/property/neighborhood-scoring"
import { detectFairHousingViolations } from "@/lib/compliance-rules/fair-housing-patterns"

// Types
export interface NeighborhoodReport {
  id: string
  brokerage_id: string
  listing_id: string
  neighborhood_name: string
  zip_code: string
  city: string
  state: string
  median_home_price: number | null
  price_per_sqft: number | null
  avg_days_on_market: number | null
  list_to_sale_ratio: number | null
  school_ratings: SchoolRating[] | null
  walk_score: number | null
  transit_score: number | null
  crime_index: number | null
  amenities_json: AmenitiesData | null
  market_trend: string | null
  ai_summary: string | null
  data_source: string | null
  generated_at: string
  expires_at: string | null
}

export interface SchoolRating {
  school_name: string
  rating: number
  level: "elementary" | "middle" | "high"
  distance: number
}

export interface AmenitiesData {
  restaurants?: { name: string; distance: number }[]
  grocery?: { name: string; distance: number }[]
  parks?: { name: string; distance: number }[]
  schools?: { name: string; distance: number }[]
  transit?: { name: string; distance: number }[]
}

export interface DataSource {
  id: string
  source_name: string
  source_type: string
  last_synced_at: string | null
  is_active: boolean
}

export interface PriceHistoryPoint {
  generated_at: string
  price_per_sqft: number
}

// ============================================================================
// Get Neighborhood Report
// ============================================================================

export async function getNeighborhoodReport(listingId: string): Promise<{
  report: NeighborhoodReport | null
  listing: { address: string; city: string; state: string; zip_code: string } | null
  priceHistory: PriceHistoryPoint[]
  dataSources: DataSource[]
}> {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  // Get the listing
  const { data: listing } = await supabase
    .from("listings")
    .select("id, address, city, state, zip")
    .eq("id", listingId)
    .eq("brokerage_id", brokerageId)
    .single()

  if (!listing) {
    return { report: null, listing: null, priceHistory: [], dataSources: [] }
  }

  // Get the most recent neighborhood report for this listing
  const { data: report } = await supabase
    .from("neighborhood_reports")
    .select("*")
    .eq("listing_id", listingId)
    .eq("brokerage_id", brokerageId)
    .order("generated_at", { ascending: false })
    .limit(1)
    .single()

  // Get price history (all reports for this zip code for trend chart)
  const { data: priceHistory } = await supabase
    .from("neighborhood_reports")
    .select("generated_at, price_per_sqft")
    .eq("zip_code", listing.zip)
    .eq("brokerage_id", brokerageId)
    .not("price_per_sqft", "is", null)
    .order("generated_at", { ascending: true })

  // Get data sources
  const { data: dataSources } = await supabase
    .from("neighborhood_data_sources")
    .select("id, source_name, source_type, last_synced_at, is_active")
    .eq("brokerage_id", brokerageId)
    .eq("is_active", true)

  return {
    report: report as NeighborhoodReport | null,
    listing: listing ? { address: listing.address, city: listing.city, state: listing.state, zip_code: listing.zip } : null,
    priceHistory: (priceHistory || []).map(p => ({
      generated_at: p.generated_at,
      price_per_sqft: p.price_per_sqft,
    })),
    dataSources: dataSources || [],
  }
}

// ============================================================================
// Refresh Neighborhood Report
// ============================================================================

export async function refreshNeighborhoodReport(listingId: string): Promise<{
  success: boolean
  report?: NeighborhoodReport
  error?: string
}> {
  const { agentId, brokerageId, userId } = await getAgentContext()
  const supabase = await createClient()

  // Get listing details
  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id, address, city, state, zip, list_price, bedrooms, bathrooms, sqft")
    .eq("id", listingId)
    .eq("brokerage_id", brokerageId)
    .single()

  if (listingError || !listing) {
    return { success: false, error: "Listing not found" }
  }

  // Tier gate — neighborhood intelligence is a premium feature on the most
  // advanced plans (brokerage / multi_location).
  const { data: brokerage } = await supabase
    .from("brokerages")
    .select("plan_tier")
    .eq("id", brokerageId)
    .single()
  if (!isNeighborhoodReportAllowed(brokerage?.plan_tier)) {
    return { success: false, error: "Neighborhood intelligence requires the Brokerage or Multi-Location plan." }
  }

  // Check if user can refresh (broker/admin or if report is expired)
  const { data: existingReport } = await supabase
    .from("neighborhood_reports")
    .select("expires_at")
    .eq("listing_id", listingId)
    .eq("brokerage_id", brokerageId)
    .order("generated_at", { ascending: false })
    .limit(1)
    .single()

  const isExpired = existingReport?.expires_at 
    ? new Date(existingReport.expires_at) < new Date() 
    : true

  // Check user role for non-expired reports
  if (!isExpired) {
    const { data: user } = await supabase
      .from("users")
      .select("user_type")
      .eq("id", (await supabase.auth.getUser()).data.user?.id)
      .single()

    if (!["broker", "broker_owner", "admin", "superadmin"].includes(user?.user_type ?? "")) {
      return { success: false, error: "Only brokers or admins can refresh non-expired reports" }
    }
  }

  // Step 1: Free OSINT data (OpenStreetMap amenities + Census median home value)
  // Always runs — provides real amenities and Census data with no API key required.
  const osint = await fetchOSINTNeighborhoodData(listing.address, listing.city, listing.state, listing.zip)

  let reportData: Partial<NeighborhoodReport> = {}

  // Seed report with OSINT data where available. walk_score is computed
  // deterministically from real OSM amenity proximity (not AI-guessed).
  if (osint.dataSource !== "none") {
    const livability = computeLivabilityScore(osint)
    reportData.amenities_json = osint.amenities
    reportData.data_source = osint.dataSource
    reportData.walk_score = livability.score
    if (osint.censusMedianHomeValue) {
      reportData.median_home_price = osint.censusMedianHomeValue
    }
  }

  // Step 2: RentCast market stats (chosen property-data provider, replacing the
  // retired HouseCanary integration). Enriches the report with real zip-level
  // median price / days-on-market / appreciation trend.
  try {
    const rc = await getRentcastMarketStats({ brokerageId: brokerageId!, zipCode: listing.zip })
    if (rc) {
      reportData.median_home_price = rc.median_sale_price || reportData.median_home_price
      reportData.avg_days_on_market = rc.avg_days_on_market || null
      reportData.market_trend =
        rc.price_trend_yoy_pct > 2 ? "appreciating" : rc.price_trend_yoy_pct < -2 ? "depreciating" : "stable"
      reportData.data_source = reportData.data_source ? `${reportData.data_source}+rentcast` : "rentcast"

      await supabase
        .from("neighborhood_data_sources")
        .update({ last_synced_at: new Date().toISOString() })
        .eq("brokerage_id", brokerageId)
        .eq("source_name", "RentCast")
    }
  } catch (err) {
    console.error("RentCast market-stats error:", err)
  }

  // If HouseCanary returned no market stats, ask AI to fill in the numeric fields.
  // We preserve OSINT amenities — AI only fills missing numeric/market fields.
  const hasMarketStats = reportData.price_per_sqft != null || reportData.avg_days_on_market != null
  if (!hasMarketStats) {
    try {
      const { text: rawStructured } = await generateAIText(
        `You are a real estate data assistant. Provide realistic neighborhood market data for this property. Return ONLY valid JSON — no markdown, no explanation.

Property: ${listing.address}, ${listing.city}, ${listing.state} ${listing.zip}
List Price: $${listing.list_price?.toLocaleString() || "N/A"}
Beds/Baths: ${listing.bedrooms || "N/A"}/${listing.bathrooms || "N/A"}

Return this exact JSON structure:
{
  "median_home_price": number,
  "price_per_sqft": number,
  "avg_days_on_market": number,
  "list_to_sale_ratio": number (e.g. 0.98),
  "walk_score": number (0-100),
  "transit_score": number (0-100),
  "crime_index": number (1-10, lower is safer),
  "market_trend": "appreciating"|"stable"|"depreciating",
  "school_ratings": [{ "school_name": string, "rating": number, "level": "elementary"|"middle"|"high", "distance": number }]
}`,
        { maxTokens: 600, feature: "generate_json" }
      )
      const aiStructured = JSON.parse(rawStructured.trim())

      // Merge: OSINT amenities take precedence; AI fills missing numeric fields
      reportData = {
        median_home_price: reportData.median_home_price ?? aiStructured.median_home_price,
        price_per_sqft: aiStructured.price_per_sqft,
        avg_days_on_market: aiStructured.avg_days_on_market,
        list_to_sale_ratio: aiStructured.list_to_sale_ratio,
        walk_score: aiStructured.walk_score,
        transit_score: aiStructured.transit_score,
        crime_index: aiStructured.crime_index,
        market_trend: aiStructured.market_trend,
        school_ratings: aiStructured.school_ratings,
        // Preserve OSINT amenities if available, otherwise AI doesn't provide them
        amenities_json: reportData.amenities_json ?? null,
        data_source: osint.dataSource !== "none" ? `${osint.dataSource}+AI-estimated` : "AI-estimated",
      }
    } catch (err) {
      console.error("[v0] AI structured neighborhood data error:", err)
    }
  }

  // Generate AI narrative summary
  const aiSummaryPrompt = `Generate a concise 2-3 paragraph neighborhood market analysis for a property listing at:
Address: ${listing.address}, ${listing.city}, ${listing.state} ${listing.zip}
List Price: $${listing.list_price?.toLocaleString() || "N/A"}
Beds/Baths: ${listing.bedrooms || "N/A"}/${listing.bathrooms || "N/A"}
Sqft: ${listing.sqft?.toLocaleString() || "N/A"}

${reportData.median_home_price ? `Median Home Price: $${(reportData.median_home_price as number).toLocaleString()}` : ""}
${reportData.avg_days_on_market ? `Avg Days on Market: ${reportData.avg_days_on_market}` : ""}
${reportData.walk_score ? `Walk Score: ${reportData.walk_score}` : ""}
${reportData.market_trend ? `Market Trend: ${reportData.market_trend}` : ""}
${reportData.data_source === "AI-estimated" ? "Note: Data is AI-estimated. Include that caveat." : ""}

Focus on buyer appeal, market positioning, and neighborhood highlights. Keep it professional and informative.`

  let aiSummary = ""
  try {
    const { text: summaryText } = await generateAIText(aiSummaryPrompt, {
      maxTokens: 500,
      feature: "neighborhood_report",
    })
    // Fair-Housing guard: reject any summary with high-severity steering language
    // (protected-class references, "good/bad area", group targeting) — never persist it.
    const violations = detectFairHousingViolations(summaryText)
    aiSummary = violations.some((v) => v.severity === "high") ? "" : summaryText
  } catch (err) {
    console.error("[v0] AI summary generation error:", err)
  }

  // Determine neighborhood name from address
  const neighborhoodName = `${listing.city} - ${listing.zip}`

  // Calculate expiration (30 days from now)
  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + 30)

  // Upsert the neighborhood report
  const { data: newReport, error: upsertError } = await supabase
    .from("neighborhood_reports")
    .upsert(
      {
        brokerage_id: brokerageId,
        listing_id: listingId,
        neighborhood_name: neighborhoodName,
        zip_code: listing.zip,
        city: listing.city,
        state: listing.state,
        median_home_price: reportData.median_home_price || null,
        price_per_sqft: reportData.price_per_sqft || null,
        avg_days_on_market: reportData.avg_days_on_market || null,
        list_to_sale_ratio: reportData.list_to_sale_ratio || null,
        school_ratings: reportData.school_ratings || null,
        walk_score: reportData.walk_score || null,
        transit_score: reportData.transit_score || null,
        crime_index: reportData.crime_index || null,
        amenities_json: reportData.amenities_json || null,
        market_trend: reportData.market_trend || null,
        ai_summary: aiSummary || null,
        data_source: reportData.data_source || "AI Generated",
        generated_at: new Date().toISOString(),
        expires_at: expiresAt.toISOString(),
      },
      {
        onConflict: "listing_id",
      }
    )
    .select()
    .single()

  if (upsertError) {
    console.error("Error upserting neighborhood report:", upsertError)
    return { success: false, error: upsertError.message }
  }

  // Emit kernel event
  await supabase.from("lifecycle_events").insert({
    brokerage_id: brokerageId,
    entity_type: "listing",
    entity_id: listingId,
    event_type: KernelEvent.NEIGHBORHOOD_REPORT_GENERATED,
    actor_user_id: userId, // lifecycle_events.actor_user_id FKs users(id) — agentId is agents(id)
    metadata: {
      neighborhood_name: neighborhoodName,
      data_source: reportData.data_source || "AI Generated",
    },
  })

  return { success: true, report: newReport as NeighborhoodReport }
}

// ============================================================================
// Generate Embed Snippet
// ============================================================================

export async function generateEmbedSnippet(listingId: string): Promise<string> {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  // Get listing slug
  const { data: listing } = await supabase
    .from("listings")
    .select("mls_number, address")
    .eq("id", listingId)
    .eq("brokerage_id", brokerageId)
    .single()

  if (!listing) {
    return ""
  }

  // Generate slug from MLS number or address
  const slug = listing.mls_number || listing.address?.toLowerCase().replace(/[^a-z0-9]+/g, "-")
  
  return `/listing/${slug}#neighborhood-report`
}
