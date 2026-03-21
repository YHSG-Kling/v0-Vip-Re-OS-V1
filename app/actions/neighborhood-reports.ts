"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { KernelEvent } from "@/lib/kernel/events"
import Anthropic from "@anthropic-ai/sdk"

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
  const { agentId, brokerageId } = await getAgentContext()
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
      .select("user_type, role")
      .eq("id", (await supabase.auth.getUser()).data.user?.id)
      .single()

    if (user?.role !== "broker" && user?.role !== "admin") {
      return { success: false, error: "Only brokers or admins can refresh non-expired reports" }
    }
  }

  // Try HouseCanary API if key is set
  const houseCanaryKey = process.env.HOUSECANARY_API_KEY
  let reportData: Partial<NeighborhoodReport> = {}

  if (houseCanaryKey) {
    try {
      // Call HouseCanary API for real data
      const address = encodeURIComponent(`${listing.address}, ${listing.city}, ${listing.state} ${listing.zip}`)
      const response = await fetch(`https://api.housecanary.com/v2/property/neighborhood?address=${address}`, {
        headers: {
          Authorization: `Bearer ${houseCanaryKey}`,
        },
      })

      if (response.ok) {
        const data = await response.json()
        reportData = {
          median_home_price: data.median_home_price,
          price_per_sqft: data.price_per_sqft,
          avg_days_on_market: data.avg_days_on_market,
          list_to_sale_ratio: data.list_to_sale_ratio,
          school_ratings: data.schools,
          walk_score: data.walk_score,
          transit_score: data.transit_score,
          crime_index: data.crime_index,
          amenities_json: data.amenities,
          market_trend: data.market_trend,
          data_source: "HouseCanary",
        }

        // Update data source sync time
        await supabase
          .from("neighborhood_data_sources")
          .update({ last_synced_at: new Date().toISOString() })
          .eq("brokerage_id", brokerageId)
          .eq("source_name", "HouseCanary")
      }
    } catch (err) {
      console.error("HouseCanary API error:", err)
    }
  }

  // Generate AI summary using Claude
  const anthropic = new Anthropic()
  const aiSummaryPrompt = `Generate a concise 2-3 paragraph neighborhood market analysis for a property listing at:
Address: ${listing.address}, ${listing.city}, ${listing.state} ${listing.zip}
List Price: $${listing.list_price?.toLocaleString() || "N/A"}
Beds/Baths: ${listing.bedrooms || "N/A"}/${listing.bathrooms || "N/A"}
Sqft: ${listing.sqft?.toLocaleString() || "N/A"}

${reportData.median_home_price ? `Median Home Price: $${reportData.median_home_price.toLocaleString()}` : ""}
${reportData.avg_days_on_market ? `Avg Days on Market: ${reportData.avg_days_on_market}` : ""}
${reportData.walk_score ? `Walk Score: ${reportData.walk_score}` : ""}
${reportData.market_trend ? `Market Trend: ${reportData.market_trend}` : ""}

Focus on buyer appeal, market positioning, and neighborhood highlights. Keep it professional and informative.`

  let aiSummary = ""
  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      messages: [{ role: "user", content: aiSummaryPrompt }],
    })
    aiSummary = message.content[0].type === "text" ? message.content[0].text : ""
  } catch (err) {
    console.error("AI summary generation error:", err)
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
    actor_user_id: agentId,
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
