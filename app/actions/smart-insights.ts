"use server"

import { createClient } from "@/lib/supabase/server"

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
    .from("property_smart_insights")
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
    .from("property_smart_insights")
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
  // Mock school data - in production, integrate with GreatSchools API
  const nearbySchools = [
    {
      name: "Lincoln Elementary",
      type: "public",
      grades: "K-5",
      rating: 8,
      distance: 0.4,
      students: 450,
    },
    {
      name: "Jefferson Middle School",
      type: "public",
      grades: "6-8",
      rating: 7,
      distance: 0.8,
      students: 620,
    },
    {
      name: "Washington High School",
      type: "public",
      grades: "9-12",
      rating: 9,
      distance: 1.2,
      students: 1200,
    },
    {
      name: "St. Mary's Academy",
      type: "private",
      grades: "K-8",
      rating: 9,
      distance: 1.5,
      students: 280,
    },
  ]

  // Filter based on preferences
  let filteredSchools = nearbySchools
  if (preferences?.publicPrivate && preferences.publicPrivate !== "either") {
    filteredSchools = nearbySchools.filter((s) => s.type === preferences.publicPrivate)
  }
  if (preferences?.minRating) {
    filteredSchools = filteredSchools.filter((s) => s.rating >= preferences.minRating!)
  }

  return {
    nearbySchools: filteredSchools,
    summary: {
      avgRating: Math.round((nearbySchools.reduce((acc, s) => acc + s.rating, 0) / nearbySchools.length) * 10) / 10,
      topRated: nearbySchools.reduce((best, s) => (s.rating > best.rating ? s : best)),
      withinWalkingDistance: nearbySchools.filter((s) => s.distance <= 0.5).length,
    },
    districtInfo: {
      name: "Unified School District",
      overallRating: 8,
      studentTeacherRatio: "18:1",
    },
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
  // Mock neighborhood data - in production, integrate with APIs like WalkScore, local data, etc.
  return {
    walkability: {
      walkScore: propertyData.walk_score || 72,
      bikeScore: propertyData.bike_score || 65,
      transitScore: propertyData.transit_score || 55,
      description: "Very Walkable - Most errands can be accomplished on foot",
    },
    safety: {
      crimeIndex: 3.2, // Out of 10, lower is safer
      trend: "improving",
      nearestPolice: "0.8 miles",
      nearestFire: "1.2 miles",
    },
    amenities: {
      restaurants: 24,
      groceryStores: 5,
      parks: 3,
      gyms: 4,
      hospitals: 2,
      withinOneMile: ["Whole Foods", "Starbucks", "CVS", "Planet Fitness", "Central Park"],
    },
    demographics: {
      medianAge: 34,
      medianIncome: 85000,
      ownerOccupied: "62%",
      collegeEducated: "48%",
    },
    marketTrends: {
      medianHomePrice: 525000,
      yoyPriceChange: 5.2,
      avgDaysOnMarket: 28,
      inventoryLevel: "low",
    },
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
  return Math.floor(Math.random() * 30) + 50 // 50-80 range
}

function estimateCommuteTime(from: string, to: string, mode: string, isPeak: boolean): number {
  // Mock calculation - in production use Google Maps API
  const baseTime = Math.floor(Math.random() * 20) + 15 // 15-35 min base
  if (isPeak) return Math.round(baseTime * 1.4)
  if (mode === "transit") return Math.round(baseTime * 1.6)
  return baseTime
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
    .from("property_smart_insights")
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

export async function requestShowing(
  contactId: string,
  propertyId: string,
  propertyAddress: string,
  propertyData: Record<string, any>,
  preferredDates: { date: string; time: string }[],
  notes?: string,
) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("showing_requests")
    .insert({
      contact_id: contactId,
      property_id: propertyId,
      property_address: propertyAddress,
      property_data: propertyData,
      preferred_dates: preferredDates,
      client_notes: notes,
      status: "pending",
    })
    .select()
    .single()

  if (error) {
    console.error("[v0] Error creating showing request:", error)
    return { error: error.message }
  }

  return { data }
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

export async function saveProperty(data: {
  contactId: string
  propertyId: string
  propertyAddress: string
  propertyData?: Record<string, any>
  notes?: string
}) {
  const supabase = await createClient()

  // Check if already saved
  const { data: existing } = await supabase
    .from("saved_properties")
    .select("id")
    .eq("contact_id", data.contactId)
    .eq("property_id", data.propertyId)
    .maybeSingle()

  if (existing) {
    return { success: true, message: "Property already saved", alreadySaved: true }
  }

  const { error } = await supabase.from("saved_properties").insert({
    contact_id: data.contactId,
    property_id: data.propertyId,
    property_address: data.propertyAddress,
    property_data: data.propertyData || {},
    notes: data.notes,
  })

  if (error) {
    console.error("[v0] Error saving property:", error)
    return { success: false, error: error.message }
  }

  return { success: true }
}

export async function unsaveProperty(contactId: string, propertyId: string) {
  const supabase = await createClient()

  const { error } = await supabase
    .from("saved_properties")
    .delete()
    .eq("contact_id", contactId)
    .eq("property_id", propertyId)

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
    .order("created_at", { ascending: false })

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
    .eq("property_id", propertyId)
    .maybeSingle()

  return !!data
}
