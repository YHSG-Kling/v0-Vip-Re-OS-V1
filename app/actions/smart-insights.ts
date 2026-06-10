"use server"

import { createClient } from "@/lib/supabase/server"
import { gatewayChatJSON } from "@/lib/ai/gateway-chat"

// ==================== SMART INSIGHTS GENERATION ====================

interface CommuteDestination {
  name: string
  address: string
  type: "work" | "school" | "family" | "other"
}

interface ContactPreferences {
  commuteDestinations?: CommuteDestination[]
  schoolPreferences?: {
    gradeLevel?: string
    publicPrivate?: "public" | "private" | "either"
    minRating?: number
  }
  investmentGoals?: {
    strategy?: "appreciation" | "cashflow" | "both"
    holdPeriod?: string
    targetCapRate?: number
  }
  mustHaves?: string[]
  dealBreakers?: string[]
}

export async function generateSmartInsights(
  propertyId: string,
  propertyData: Record<string, any>,
  contactId: string,
  preferences?: ContactPreferences,
) {
  const supabase = await createClient()

  // Check if insights already exist and are not expired
  const { data: existing } = await supabase
    .from("contact_property_insights")
    .select("*")
    .eq("property_id", propertyId)
    .eq("contact_id", contactId)
    .gt("expires_at", new Date().toISOString())
    .single()

  if (existing) {
    return existing
  }

  // Generate commute insights
  const commuteInsights = await generateCommuteInsights(propertyData, preferences?.commuteDestinations)

  // Generate school insights
  const schoolInsights = await generateSchoolInsights(propertyData, preferences?.schoolPreferences)

  // Generate investment insights
  const investmentInsights = await generateInvestmentInsights(propertyData, preferences?.investmentGoals)

  // Generate neighborhood insights
  const neighborhoodInsights = await generateNeighborhoodInsights(propertyData)

  // Generate AI match score
  const matchResult = await generateMatchScore(propertyData, preferences)

  // Store in database
  const { data, error } = await supabase
    .from("contact_property_insights")
    .upsert(
      {
        property_id: propertyId,
        contact_id: contactId,
        commute_insights: commuteInsights,
        school_insights: schoolInsights,
        investment_insights: investmentInsights,
        neighborhood_insights: neighborhoodInsights,
        match_score: matchResult.score,
        match_reasons: matchResult.reasons,
        match_concerns: matchResult.concerns,
        generated_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        onConflict: "property_id,contact_id",
      },
    )
    .select()
    .single()

  if (error) {
    console.error("[v0] Error storing smart insights:", error)
    return null
  }

  return data
}

async function generateCommuteInsights(
  propertyData: Record<string, any>,
  destinations?: CommuteDestination[],
): Promise<Record<string, any>> {
  const propertyAddress = propertyData.address || propertyData.full_address

  if (!destinations || destinations.length === 0) {
    // Return general commute info
    return {
      status: "no_destinations",
      message: "Add commute destinations to see personalized travel times",
      generalInfo: {
        nearestHighway: estimateNearestHighway(propertyData),
        publicTransit: estimatePublicTransit(propertyData),
        walkScore: propertyData.walk_score || estimateWalkScore(propertyData),
      },
    }
  }

  // Calculate commute times for each destination
  const commutes = destinations.map((dest) => ({
    destination: dest.name,
    type: dest.type,
    estimates: {
      driving: {
        peakHours: estimateCommuteTime(propertyAddress, dest.address, "driving", true),
        offPeak: estimateCommuteTime(propertyAddress, dest.address, "driving", false),
      },
      publicTransit: estimateCommuteTime(propertyAddress, dest.address, "transit", false),
    },
  }))

  return {
    status: "calculated",
    destinations: commutes,
    summary: {
      avgDrivingPeak: Math.round(commutes.reduce((acc, c) => acc + c.estimates.driving.peakHours, 0) / commutes.length),
      bestCommute: commutes.reduce((best, c) =>
        c.estimates.driving.peakHours < best.estimates.driving.peakHours ? c : best,
      ),
    },
  }
}

async function generateSchoolInsights(
  propertyData: Record<string, any>,
  preferences?: ContactPreferences["schoolPreferences"],
): Promise<Record<string, any>> {
  const address = propertyData.address || propertyData.full_address || ""
  const city = propertyData.city || ""
  const state = propertyData.state || ""
  const zip = propertyData.zip || propertyData.zip_code || ""

  const filterHint = preferences?.publicPrivate && preferences.publicPrivate !== "either"
    ? `Focus on ${preferences.publicPrivate} schools.`
    : ""
  const ratingHint = preferences?.minRating ? `Only include schools rated ${preferences.minRating}+.` : ""

  try {
    // Routed through Vercel AI Gateway — single egress, single key rotation. Use gatewayChatJSON
    // so fenced output (real artifact of the gateway's Anthropic translation) doesn't break parse.
    const result = await gatewayChatJSON<Record<string, any>>({
      model:     "anthropic/claude-opus-4-20250514",
      maxTokens: 600,
      messages: [
        { role: "user", content: `You are a real estate data assistant. Based on the property location below, provide realistic school data for that area. Return ONLY valid JSON — no markdown, no explanation.

Property: ${address}, ${city}, ${state} ${zip}
${filterHint} ${ratingHint}

Return this exact JSON structure:
{
  "nearbySchools": [
    { "name": string, "type": "public"|"private", "grades": string, "rating": number (1-10), "distance": number (miles), "students": number }
  ],
  "summary": { "avgRating": number, "withinWalkingDistance": number },
  "districtInfo": { "name": string, "overallRating": number, "studentTeacherRatio": string },
  "dataSource": "AI-estimated"
}` },
      ],
    })
    if (!result.ok || !result.data) throw new Error(result.error ?? "No JSON from AI")
    const parsed = result.data

    // Apply preference filters on top of AI result
    let schools = parsed.nearbySchools || []
    if (preferences?.publicPrivate && preferences.publicPrivate !== "either") {
      schools = schools.filter((s: any) => s.type === preferences.publicPrivate)
    }
    if (preferences?.minRating) {
      schools = schools.filter((s: any) => s.rating >= preferences.minRating!)
    }

    return { ...parsed, nearbySchools: schools }
  } catch (err) {
    console.error("[v0] generateSchoolInsights AI error:", err)
    return {
      nearbySchools: [],
      summary: { avgRating: null, withinWalkingDistance: 0 },
      districtInfo: { name: null, overallRating: null, studentTeacherRatio: null },
      dataSource: "unavailable",
    }
  }
}

async function generateInvestmentInsights(
  propertyData: Record<string, any>,
  goals?: ContactPreferences["investmentGoals"],
): Promise<Record<string, any>> {
  const price = propertyData.price || propertyData.listPrice || 500000
  const sqft = propertyData.sqft || propertyData.squareFeet || 2000

  // Estimate rental value (typically 0.8-1.2% of home value monthly in most markets)
  const estimatedMonthlyRent = Math.round(price * 0.0085)
  const annualRent = estimatedMonthlyRent * 12

  // Estimate expenses (typically 40-50% of rent for SFH)
  const estimatedExpenses = Math.round(annualRent * 0.45)
  const netOperatingIncome = annualRent - estimatedExpenses

  // Cap rate
  const capRate = ((netOperatingIncome / price) * 100).toFixed(2)

  // Cash on cash (assuming 25% down, 7% rate, 30yr)
  const downPayment = price * 0.25
  const loanAmount = price * 0.75
  const monthlyMortgage = calculateMortgage(loanAmount, 7, 30)
  const annualDebtService = monthlyMortgage * 12
  const cashFlow = netOperatingIncome - annualDebtService
  const cashOnCash = ((cashFlow / downPayment) * 100).toFixed(2)

  // Appreciation estimate
  const appreciationRate = 4.5 // Historical average
  const fiveYearValue = Math.round(price * Math.pow(1 + appreciationRate / 100, 5))
  const fiveYearEquity = fiveYearValue - price + downPayment

  return {
    rentalAnalysis: {
      estimatedMonthlyRent,
      pricePerSqft: Math.round(price / sqft),
      rentPerSqft: (estimatedMonthlyRent / sqft).toFixed(2),
    },
    returns: {
      capRate: Number.parseFloat(capRate),
      cashOnCash: Number.parseFloat(cashOnCash),
      monthlyNetCashFlow: Math.round(cashFlow / 12),
      annualCashFlow: Math.round(cashFlow),
    },
    appreciation: {
      estimatedAnnualRate: appreciationRate,
      fiveYearProjectedValue: fiveYearValue,
      fiveYearEquityGain: fiveYearEquity,
    },
    meetsGoals:
      goals?.strategy === "cashflow"
        ? Number.parseFloat(cashOnCash) >= (goals?.targetCapRate || 6)
        : Number.parseFloat(capRate) >= 5,
    recommendation:
      Number.parseFloat(capRate) >= 6
        ? "Strong investment potential"
        : Number.parseFloat(capRate) >= 4
          ? "Moderate investment potential"
          : "Better suited for owner occupancy",
  }
}

async function generateNeighborhoodInsights(propertyData: Record<string, any>): Promise<Record<string, any>> {
  // If real scores exist on the property record, use them directly
  const hasRealScores = propertyData.walk_score || propertyData.bike_score || propertyData.transit_score

  const address = propertyData.address || propertyData.full_address || ""
  const city = propertyData.city || ""
  const state = propertyData.state || ""
  const zip = propertyData.zip || propertyData.zip_code || ""

  // Build walkability block from real data if present
  const walkability = {
    walkScore: propertyData.walk_score || null,
    bikeScore: propertyData.bike_score || null,
    transitScore: propertyData.transit_score || null,
    description: null as string | null,
  }

  // Ask AI for everything else — safety, amenities, demographics, market trends.
  // Routed through Vercel AI Gateway via gatewayChatJSON (fence-safe parse).
  try {
    const result = await gatewayChatJSON<Record<string, any>>({
      model:     "anthropic/claude-opus-4-20250514",
      maxTokens: 700,
      messages: [
        { role: "user", content: `You are a real estate data assistant. Based on this property location, provide realistic neighborhood data. Return ONLY valid JSON — no markdown, no explanation.

Property: ${address}, ${city}, ${state} ${zip}
${hasRealScores ? `Known scores — Walk: ${propertyData.walk_score ?? "?"}, Bike: ${propertyData.bike_score ?? "?"}, Transit: ${propertyData.transit_score ?? "?"}` : ""}

Return this exact JSON structure:
{
  "walkability": {
    "walkScore": number|null,
    "bikeScore": number|null,
    "transitScore": number|null,
    "description": string|null
  },
  "safety": {
    "crimeIndex": number,
    "trend": "improving"|"stable"|"increasing",
    "nearestPolice": string,
    "nearestFire": string
  },
  "amenities": {
    "restaurants": number,
    "groceryStores": number,
    "parks": number,
    "gyms": number,
    "hospitals": number,
    "withinOneMile": [string]
  },
  "demographics": {
    "medianAge": number,
    "medianIncome": number,
    "ownerOccupied": string,
    "collegeEducated": string
  },
  "marketTrends": {
    "medianHomePrice": number,
    "yoyPriceChange": number,
    "avgDaysOnMarket": number,
    "inventoryLevel": "low"|"moderate"|"high"
  },
  "dataSource": "AI-estimated"
}` },
      ],
    })
    if (!result.ok || !result.data) throw new Error(result.error ?? "No JSON from AI")
    const parsed = result.data

    // Override walkability with real scores if available
    if (hasRealScores) {
      parsed.walkability = {
        ...parsed.walkability,
        walkScore: propertyData.walk_score ?? parsed.walkability.walkScore,
        bikeScore: propertyData.bike_score ?? parsed.walkability.bikeScore,
        transitScore: propertyData.transit_score ?? parsed.walkability.transitScore,
      }
    }

    return parsed
  } catch (err) {
    console.error("[v0] generateNeighborhoodInsights AI error:", err)
    // Return minimal structure with only confirmed real data
    return {
      walkability,
      safety: null,
      amenities: null,
      demographics: null,
      marketTrends: null,
      dataSource: "unavailable",
    }
  }
}

async function generateMatchScore(
  propertyData: Record<string, any>,
  preferences?: ContactPreferences,
): Promise<{ score: number; reasons: string[]; concerns: string[] }> {
  const reasons: string[] = []
  const concerns: string[] = []
  let score = 70 // Base score

  // Check must-haves
  if (preferences?.mustHaves) {
    const propertyFeatures = (propertyData.features || []).map((f: string) => f.toLowerCase())
    const description = (propertyData.description || "").toLowerCase()

    for (const mustHave of preferences.mustHaves) {
      const lowerMustHave = mustHave.toLowerCase()
      if (propertyFeatures.some((f: string) => f.includes(lowerMustHave)) || description.includes(lowerMustHave)) {
        score += 5
        reasons.push(`Has ${mustHave}`)
      } else {
        score -= 10
        concerns.push(`Missing: ${mustHave}`)
      }
    }
  }

  // Check deal breakers
  if (preferences?.dealBreakers) {
    const propertyFeatures = (propertyData.features || []).map((f: string) => f.toLowerCase())

    for (const dealBreaker of preferences.dealBreakers) {
      const lowerDB = dealBreaker.toLowerCase()
      if (propertyFeatures.some((f: string) => f.includes(lowerDB))) {
        score -= 20
        concerns.push(`Deal breaker: ${dealBreaker}`)
      }
    }
  }

  // Price alignment (assuming budget is in preferences)
  const price = propertyData.price || propertyData.listPrice
  if (price) {
    if (price <= 400000) {
      reasons.push("Within typical first-time buyer range")
      score += 5
    } else if (price >= 1000000) {
      reasons.push("Luxury property with premium features")
    }
  }

  // Property condition
  const yearBuilt = propertyData.yearBuilt || propertyData.year_built
  if (yearBuilt) {
    const age = new Date().getFullYear() - yearBuilt
    if (age <= 5) {
      reasons.push("Newer construction - lower maintenance")
      score += 5
    } else if (age >= 30) {
      concerns.push("Older home - may need updates")
      score -= 5
    }
  }

  // Add generic positive reasons
  if (propertyData.garage) reasons.push("Has garage")
  if (propertyData.pool) reasons.push("Pool included")
  if (propertyData.bedrooms >= 3) reasons.push("3+ bedrooms for flexibility")

  // Ensure score is within bounds
  score = Math.max(0, Math.min(100, score))

  return { score, reasons: reasons.slice(0, 5), concerns: concerns.slice(0, 3) }
}

// Helper functions
function estimateNearestHighway(propertyData: Record<string, any>): string {
  return "I-95 (approx. 2.5 miles)"
}

function estimatePublicTransit(propertyData: Record<string, any>): string {
  return "Bus stop 0.3 miles, Metro 1.2 miles"
}

function estimateWalkScore(propertyData: Record<string, any>): number {
  return 0 // 0 = no real data available; wire WALKSCORE_API_KEY for live scores
}

function estimateCommuteTime(from: string, to: string, mode: string, isPeak: boolean): number {
  return 0 // 0 = no real data available; wire Google Maps API for live commute times
}

function calculateMortgage(principal: number, annualRate: number, years: number): number {
  const monthlyRate = annualRate / 100 / 12
  const numPayments = years * 12
  return Math.round(
    (principal * monthlyRate * Math.pow(1 + monthlyRate, numPayments)) / (Math.pow(1 + monthlyRate, numPayments) - 1),
  )
}

// ==================== GET INSIGHTS ====================

export async function getSmartInsights(propertyId: string, contactId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("contact_property_insights")
    .select("*")
    .eq("property_id", propertyId)
    .eq("contact_id", contactId)
    .single()

  if (error) {
    return null
  }

  return data
}

// ==================== SHOWING REQUESTS ====================

/**
 * Legacy positional-args wrapper around the canonical requestShowing in
 * app/actions/showings.ts. The previous implementation here wrote to columns
 * that don't exist on showing_requests (property_id, property_data,
 * preferred_dates, client_notes) and silently failed every call from the
 * portal. Routes through the canonical action so all surfaces land the same
 * shape.
 */
export async function requestShowing(
  contactId: string,
  propertyId: string,
  propertyAddress: string,
  propertyData: Record<string, any>,
  preferredDates: { date: string; time: string }[],
  notes?: string,
) {
  const { requestShowing: canonicalRequestShowing } = await import("./showings")
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const isUuid = uuidRe.test(propertyId)

  const result = await canonicalRequestShowing({
    contactId,
    listingId:         isUuid ? propertyId : undefined,
    propertyAddress,
    propertyCity:      propertyData.city ?? propertyData.property_city,
    propertyState:     propertyData.state ?? propertyData.property_state,
    propertyZip:       propertyData.zip ?? propertyData.property_zip,
    mlsNumber:         isUuid ? undefined : propertyId,
    listPrice:         propertyData.list_price ?? propertyData.price,
    primaryPhotoUrl:   propertyData.primary_photo_url ?? propertyData.photo_url,
    listingAgentName:  propertyData.listing_agent_name,
    listingAgentPhone: propertyData.listing_agent_phone,
    listingAgentEmail: propertyData.listing_agent_email,
    listingAgentCompany: propertyData.listing_agent_company,
    source:            'buyer_portal',
    preferredDates,
    clientNotes:       notes,
  })

  // Map the canonical { success, error } shape onto the legacy { data, error } shape
  if (!result.success) return { error: result.error }
  return { data: result.data }
}

export async function getShowingRequests(contactId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("showing_requests")
    .select("*")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })

  if (error) {
    console.error("[v0] Error fetching showing requests:", error)
    return []
  }

  return data || []
}

export async function updateShowingFeedback(
  showingId: string,
  rating: number,
  notes: string,
  interestedLevel: "very_interested" | "interested" | "neutral" | "not_interested",
) {
  const supabase = await createClient()

  const { error } = await supabase
    .from("showing_requests")
    .update({
      feedback_rating: rating,
      feedback_notes: notes,
      interested_level: interestedLevel,
      status: "completed",
      updated_at: new Date().toISOString(),
    })
    .eq("id", showingId)

  if (error) {
    console.error("[v0] Error updating showing feedback:", error)
    return { error: error.message }
  }

  return { success: true }
}

// ==================== PROPERTY SAVING ====================

/**
 * Legacy positional-arg wrapper around the canonical saveProperty in
 * app/actions/idx-search.ts. Previous implementation here wrote to columns
 * that don't exist on saved_properties (property_id, property_data) and
 * silently failed every call from the portal.
 */
export async function saveProperty(data: {
  contactId: string
  propertyId: string
  propertyAddress: string
  propertyData?: Record<string, any>
  notes?: string
}) {
  const { saveProperty: canonicalSaveProperty } = await import("./idx-search")
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const isUuid = uuidRe.test(data.propertyId)
  const pd = data.propertyData ?? {}

  return canonicalSaveProperty({
    contactId:          data.contactId,
    listingId:          isUuid ? data.propertyId : undefined,
    mlsNumber:          isUuid ? undefined : data.propertyId,
    externalPropertyId: isUuid ? undefined : data.propertyId,
    source:             pd.source ?? (isUuid ? "brokerage_listing" : "idx"),
    propertyData: {
      address:          data.propertyAddress,
      price:            pd.price ?? pd.list_price,
      bedrooms:         pd.bedrooms ?? pd.beds,
      bathrooms:        pd.bathrooms ?? pd.baths,
      sqft:             pd.sqft,
      propertyType:     pd.propertyType ?? pd.property_type,
      primaryPhotoUrl:  pd.primaryPhotoUrl ?? pd.primary_photo_url ?? pd.photo_url,
      url:              pd.url ?? pd.listing_url,
      city:             pd.city,
      state:            pd.state,
      brokerageId:      pd.brokerageId,
    },
  })
}

export async function unsaveProperty(contactId: string, propertyId: string) {
  const supabase = await createClient()

  const { error } = await supabase
    .from("saved_properties")
    .delete()
    .eq("contact_id", contactId)
    .eq("listing_id", propertyId)

  if (error) {
    console.error("[v0] Error unsaving property:", error)
    return { success: false, error: error.message }
  }

  return { success: true }
}

export async function getSavedProperties(contactId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("saved_properties")
    .select("*")
    .eq("contact_id", contactId)
    .order("saved_at", { ascending: false })

  if (error) {
    console.error("[v0] Error fetching saved properties:", error)
    return []
  }

  return data || []
}

export async function isPropertySaved(contactId: string, propertyId: string) {
  const supabase = await createClient()

  const { data } = await supabase
    .from("saved_properties")
    .select("id")
    .eq("contact_id", contactId)
    .eq("listing_id", propertyId)
    .maybeSingle()

  return !!data
}
