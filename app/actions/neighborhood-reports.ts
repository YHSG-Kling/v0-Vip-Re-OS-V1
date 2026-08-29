"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { KernelEvent } from "@/lib/kernel/events"
import { generateAIText } from "@/lib/ai"
import { fetchOSINTNeighborhoodData } from "@/lib/external/osint-neighborhood"
import { getRentcastMarketStats } from "@/lib/property/rentcast"
import {
  computeLivabilityScore,
  isNeighborhoodReportAllowed,
  assembleFactsBlock,
  factualNarrative,
} from "@/lib/property/neighborhood-scoring"
import { detectFairHousingViolations } from "@/lib/compliance-rules/fair-housing-patterns"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

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
  listing: {
    address: string
    city: string
    state: string
    zip_code: string
    /**
      * Seller contact — the only structural key into home_value_estimates.
      * listings.seller_contact_id, NOT contact_id: contact_id exists on the table
      * but is not populated for listings, so keying on it made this fallback dead.
      */
    seller_contact_id: string | null
    brokerage_id: string | null
  } | null
  priceHistory: PriceHistoryPoint[]
  dataSources: DataSource[]
}> {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  // Get the listing
  const { data: listing } = await supabase
    .from("listings")
    .select("id, address, city, state, zip, seller_contact_id, brokerage_id")
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
    listing: listing
      ? {
          address: listing.address,
          city: listing.city,
          state: listing.state,
          zip_code: listing.zip,
          seller_contact_id: listing.seller_contact_id ?? null,
          brokerage_id: listing.brokerage_id ?? null,
        }
      : null,
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

    if (!isAdminOrBroker({ user_type: user?.user_type ?? "" })) {
      return { success: false, error: "Only brokers or admins can refresh non-expired reports" }
    }
  }

  // Step 1: Free OSINT data (OpenStreetMap amenities + Census median home value)
  // Always runs — provides real amenities and Census data with no API key required.
  const osint = await fetchOSINTNeighborhoodData(listing.address, listing.city, listing.state, listing.zip)

  let reportData: Partial<NeighborhoodReport> = {}

  // Computed ONCE, unconditionally, and reused below for the AI grounding block
  // and the Fair-Housing-safe fallback narrative. computeLivabilityScore already
  // handles the no-data case itself (dataSource "none" → score 0, label
  // "Limited data"), so hoisting it out of the branch invents nothing.
  const livability = computeLivabilityScore(osint)

  // Seed report with OSINT data where available. walk_score is computed
  // deterministically from real OSM amenity proximity (not AI-guessed).
  if (osint.dataSource !== "none") {
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

      // REGISTER THE SOURCE, DON'T JUST STAMP IT.
      //
      // WHAT WAS BROKEN. This was a bare UPDATE … WHERE brokerage_id AND
      // source_name='RentCast', and NOTHING in the repo has ever INSERTed a
      // `neighborhood_data_sources` row — `source_name` and `source_type` are
      // both NOT NULL with no default, no trigger and no seed, and the live
      // table (project hrvaqgvukzxfskkcrwbt) holds 0 rows. So the update matched
      // nothing on every run. An UPDATE that matches nothing RESOLVES with
      // `error === null` and an empty result, byte-identical to one that worked
      // (CLAUDE.md §3), and the call did not even destructure — so the miss was
      // unreportable. Downstream, getNeighborhoodReport reads this table for the
      // "Data Sources" footer of the seller-facing report, which therefore had
      // no provenance to show: a report that quotes RentCast's median could not
      // say where the number came from.
      //
      // The fact becomes known HERE — RentCast just answered for this tenant —
      // so this is where the registration belongs. Written as a select-then-
      // insert/update pair because the table carries no unique index on
      // (brokerage_id, source_name) to upsert against.
      const { data: existingSource, error: sourceReadError } = await supabase
        .from("neighborhood_data_sources")
        .select("id")
        .eq("brokerage_id", brokerageId)
        .eq("source_name", "RentCast")
        .maybeSingle()
      if (sourceReadError) {
        console.error("[neighborhood-report] data-source lookup was refused:", sourceReadError.message)
      } else if (existingSource) {
        // `.select("id")` so a row RLS hides reports failure instead of a silent
        // success on zero rows — the trap this whole block exists to close.
        const { data: touched, error: sourceUpdateError } = await supabase
          .from("neighborhood_data_sources")
          .update({ last_synced_at: new Date().toISOString(), is_active: true })
          .eq("id", (existingSource as { id: string }).id)
          .select("id")
        if (sourceUpdateError) {
          console.error("[neighborhood-report] data-source sync stamp was refused:", sourceUpdateError.message)
        } else if (!touched?.length) {
          console.error("[neighborhood-report] data-source sync stamp matched no row — the RentCast provenance line will be stale")
        }
      } else if (brokerageId) {
        const { error: sourceInsertError } = await supabase
          .from("neighborhood_data_sources")
          .insert({
            brokerage_id: brokerageId,
            source_name: "RentCast",
            // 'custom' IS THE ONLY ADMITTED VALUE FOR RENTCAST. The live CHECK
            // on source_type is {attom, census, custom, housecanary, walkscore}
            // — written before HouseCanary was retired in favour of RentCast, so
            // the provider this row describes has no name of its own in the
            // vocabulary yet (scripts/check-vocabularies.ts:986). Naming
            // anything else here is a 23514 that refuses the WHOLE insert
            // (CLAUDE.md §3), which is exactly how this registration would have
            // failed silently a second time. source_name carries the provider.
            source_type: "custom",
            api_endpoint: "/markets",
            is_active: true,
            last_synced_at: new Date().toISOString(),
          })
        if (sourceInsertError) {
          console.error("[neighborhood-report] data-source registration was refused:", sourceInsertError.message)
        }
      }
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

VERIFIED NEIGHBORHOOD FACTS (from OpenStreetMap amenities and the US Census — these are measured, not estimated):
${assembleFactsBlock(osint, livability)}

Use ONLY the verified facts above when describing amenities, walkability, schools, parks, transit or dining. Do not introduce any amenity, school, park or business that is not named there, and do not estimate distances.

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

  // GROUNDING + FALLBACK (orphan burn-down, lane E). Two defects closed here,
  // using the two pure helpers in lib/property/neighborhood-scoring.ts that were
  // written for this exact surface and had never been called from it:
  //
  //  1. assembleFactsBlock — the prompt above used to hand the model four
  //     numbers (median price, DOM, walk score, trend) and then ask it for
  //     "neighborhood highlights". The real amenity facts were fetched, scored
  //     and written to amenities_json one screen up, and were never shown to the
  //     model that was being asked to describe them. Asking for highlights while
  //     withholding the amenities is an invitation to invent a grocery store,
  //     a park or a school — in a report a buyer reads about a specific address.
  //     The block now goes in, with an explicit instruction not to go beyond it.
  //
  //  2. factualNarrative — when the Fair-Housing guard rejected the summary
  //     (violations.some(high)), aiSummary was set to "" and the report was
  //     saved with ai_summary NULL. The tenant then saw a neighborhood report
  //     with no narrative and no explanation. factualNarrative is documented in
  //     its own header as "the safe fallback when the AI output fails the
  //     Fair-Housing check": amenity counts and distances only, no
  //     protected-class or steering language possible because it is assembled
  //     from integers. A rejected summary now degrades to the honest, factual
  //     paragraph instead of to silence. Same for a generation that threw.
  //     It lands in `ai_summary` because that is the report's single narrative
  //     slot, and the paragraph never claims to be an analysis — it states
  //     measured counts and distances and nothing else — so the column holding
  //     it cannot mislead a reader the way a blank report already did. When
  //     there is no OSINT data at all there are no facts to state, so the field
  //     stays NULL rather than carrying an empty-sounding sentence.
  if (!aiSummary && osint.dataSource !== "none") {
    aiSummary = factualNarrative(osint, livability)
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
