"use server"

import { createClient } from "@/lib/supabase/server"
import { gatewayChatJSON } from "@/lib/ai/gateway-chat"
import {
  estimateMonthlyRentFromComps,
  rentSourceCaption,
  type ProviderRentEstimate,
} from "@/lib/property/rent-estimate"

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

  // The tenant this contact belongs to. Needed BEFORE the investment block: the
  // rental-comp provider is platform-gated and metered per tenant, so with no
  // brokerage there is no rent lookup — and the block says so rather than
  // inventing one. Read from the contact rather than accepted from the caller:
  // this is a "use server" endpoint, so every argument is attacker-controlled
  // and a caller-supplied brokerage id would let anyone spend another tenant's
  // RentCast budget.
  const { data: contactRow, error: contactErr } = await supabase
    .from("contacts")
    .select("brokerage_id")
    .eq("id", contactId)
    .maybeSingle()
  if (contactErr) {
    console.error("[v0] smart-insights: could not read contact brokerage:", contactErr.message)
  }
  const brokerageId = (contactRow as { brokerage_id: string | null } | null)?.brokerage_id ?? null

  // Generate investment insights
  const investmentInsights = await generateInvestmentInsights(propertyData, preferences?.investmentGoals, {
    brokerageId,
    contactId,
  })

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
        // The column exists on contact_property_insights and was never written,
        // so every insight row was tenant-less. It is resolved above anyway.
        brokerage_id: brokerageId,
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
  const propertyAddress = propertyData.address || propertyData.full_address || ""
  const city = propertyData.city || ""
  const state = propertyData.state || ""

  if (!destinations || destinations.length === 0) {
    // No places to commute to yet — invite the buyer to add one (the UI captures it).
    return {
      status: "no_destinations",
      message: "Add a place you go often — work, the gym, family — to see honest drive and transit times.",
    }
  }

  // AI-estimated commute times (same trusted gateway source as our school/neighborhood data).
  // Honest: we label these as estimates and never present them as live traffic readings.
  const destList = destinations
    .map((d, i) => `${i + 1}. ${d.name} (${d.type}) at ${d.address}`)
    .join("\n")
  try {
    const result = await gatewayChatJSON<Record<string, any>>({
      model:     "anthropic/claude-opus-4-20250514",
      maxTokens: 600,
      messages: [
        { role: "user", content: `You are a real estate data assistant. Estimate realistic commute times FROM the home TO each destination. Return ONLY valid JSON — no markdown, no explanation.

Home: ${propertyAddress}, ${city}, ${state}
Destinations:
${destList}

Return this exact JSON structure (minutes as integers):
{
  "destinations": [
    { "destination": string, "type": string, "drivingPeakMin": number, "drivingOffPeakMin": number, "transitMin": number|null, "distanceMiles": number }
  ],
  "dataSource": "AI-estimated"
}` },
      ],
    })
    if (!result.ok || !result.data) throw new Error(result.error ?? "No JSON from AI")
    const rows: any[] = Array.isArray(result.data.destinations) ? result.data.destinations : []
    if (rows.length === 0) throw new Error("No commute rows")

    const best = rows.reduce((b, c) => (c.drivingPeakMin < b.drivingPeakMin ? c : b), rows[0])
    return {
      status: "calculated",
      destinations: rows,
      summary: {
        avgDrivingPeak: Math.round(rows.reduce((acc, c) => acc + (c.drivingPeakMin || 0), 0) / rows.length),
        bestCommute: best?.destination ?? null,
      },
      dataSource: "AI-estimated",
    }
  } catch (err) {
    console.error("[v0] generateCommuteInsights AI error:", err)
    // Honest failure — show the destinations the buyer added, no fabricated times.
    return {
      status: "unavailable",
      destinations: destinations.map((d) => ({ destination: d.name, type: d.type })),
      message: "We couldn't estimate times right now — your agent can pull exact drive times for you.",
    }
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

/**
 * THE INVESTMENT SNAPSHOT ON THE BUYER PORTAL — and the fabrication that used to
 * be its foundation.
 *
 * WHAT THIS USED TO DO, and why every number below it was worthless:
 *
 *     const price = propertyData.price || propertyData.listPrice || 500000
 *     const estimatedMonthlyRent = Math.round(price * 0.0085)
 *
 * Two inventions in two lines. A property record carrying no price fell back to
 * a HARD-CODED $500,000 — not a marker, not a null, a plausible number — and the
 * rent was then 0.85% of it. A home with no price on file therefore displayed
 * "$4,250/mo" to a client, in a card headed "Investment Snapshot", derived from
 * nothing whatsoever. And the fabrication did not stop at the rent tile: annual
 * rent, operating expenses, NOI, CAP RATE, CASH-ON-CASH, monthly and annual cash
 * flow, `meetsGoals` and the plain-English `recommendation` were ALL computed
 * from it. Deleting only the rent line would have left every derived figure
 * standing on the same guess with the evidence removed.
 *
 * WHAT IT DOES NOW:
 *   · The rent comes from RentCast's long-term rental listings — the median
 *     ASKING rent of comparable homes actually published nearby — through
 *     lib/property/rent-estimate.ts, which gates on eligibility before spending
 *     and meters the call to THIS lane. Nothing here estimates a rent.
 *   · No price on the record → no snapshot. `price: null`, every derived block
 *     null, and a sentence saying which input was missing.
 *   · No rent from the provider → the rent-derived half is null (returns,
 *     rentalAnalysis.estimatedMonthlyRent, meetsGoals, recommendation) and
 *     `rentSource.unavailableNote` says why in plain words. The price-derived
 *     half (price per sqft, appreciation) still stands, because it never
 *     depended on the rent.
 *   · MISSING READS AS MISSING. Null and a note — never 0, never a substituted
 *     figure, never a silently dropped line.
 *
 * The 45% expense ratio, the 25%-down/7%/30-year financing and the 4.5%
 * appreciation rate are ASSUMPTIONS, not measurements, and they are named as
 * such on `assumptions` so a surface can show them beside anything derived from
 * them. They were unlabelled before. See the report for the appreciation rate,
 * which is still a hard-coded constant and is reported rather than fixed here.
 */
async function generateInvestmentInsights(
  propertyData: Record<string, any>,
  goals: ContactPreferences["investmentGoals"] | undefined,
  tenant: { brokerageId: string | null; contactId: string | null },
): Promise<Record<string, any>> {
  const rawPrice = propertyData.price ?? propertyData.listPrice ?? null
  const price = typeof rawPrice === "number" && Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice : null
  const rawSqft = propertyData.sqft ?? propertyData.squareFeet ?? null
  const sqft = typeof rawSqft === "number" && Number.isFinite(rawSqft) && rawSqft > 0 ? rawSqft : null

  // The one rent figure, from a data provider or not at all. Issued even when
  // the price is missing: "what do comparable homes rent for here?" is a real,
  // answerable question that does not depend on this property's list price.
  const rentSource: ProviderRentEstimate = await estimateMonthlyRentFromComps({
    brokerageId: tenant.brokerageId,
    contactId: tenant.contactId,
    city: propertyData.city ?? null,
    state: propertyData.state ?? null,
    zip: propertyData.zip ?? propertyData.zip_code ?? null,
    bedrooms: propertyData.bedrooms ?? propertyData.beds ?? null,
    bathroomsMin: null,
    propertyType: propertyData.property_type ?? propertyData.propertyType ?? null,
    // The lane that spent, named truthfully. This is a buyer-portal property
    // page, not the buyer LISTING search that `buyer_search` means.
    systemSource: "portal_investment_snapshot",
  })

  const estimatedMonthlyRent = rentSource.monthlyRent

  const assumptions = {
    operatingExpenseRatio: 0.45,
    downPaymentPct: 0.25,
    mortgageRatePct: 7,
    mortgageTermYears: 30,
    note:
      "Cap rate, cash-on-cash and cash flow are computed from the provider-sourced median asking rent above using these standing assumptions — a 45% operating-expense ratio and 25% down at 7% over 30 years. They are assumptions, not quotes, and not this property's actual expenses or financing.",
  }

  // ── The price-derived half. Null when there is no price, never defaulted. ──
  const appreciationRate = 4.5 // Standing assumption — see `assumptions`, and the lane report.
  const downPayment = price != null ? price * 0.25 : null
  const appreciation =
    price != null
      ? {
          estimatedAnnualRate: appreciationRate,
          fiveYearProjectedValue: Math.round(price * Math.pow(1 + appreciationRate / 100, 5)),
          fiveYearEquityGain:
            Math.round(price * Math.pow(1 + appreciationRate / 100, 5)) - price + (downPayment ?? 0),
        }
      : null

  const rentalAnalysis = {
    estimatedMonthlyRent,
    rentSourceLabel: rentSource.label,
    rentSourceCaption: rentSourceCaption(rentSource),
    pricePerSqft: price != null && sqft != null ? Math.round(price / sqft) : null,
    rentPerSqft:
      estimatedMonthlyRent != null && sqft != null
        ? Number((estimatedMonthlyRent / sqft).toFixed(2))
        : null,
  }

  // ── The rent-derived half. Needs BOTH a provider rent and a price. ─────────
  if (estimatedMonthlyRent == null || price == null) {
    const missing: string[] = []
    if (price == null) missing.push("this property record carries no list price")
    if (estimatedMonthlyRent == null) missing.push(rentSource.unavailableNote ?? "no rental comparables were available")
    return {
      price,
      rentalAnalysis,
      rentSource,
      assumptions,
      // Every rent-derived figure is ABSENT, not zero and not omitted. A reader
      // who sees a snapshot with no cap rate and this sentence knows exactly
      // what is missing; a reader shown a cap rate computed from a guess does
      // not know anything at all.
      returns: null,
      appreciation,
      meetsGoals: null,
      recommendation: null,
      unavailableNote: `No return figures (cap rate, cash-on-cash, cash flow) are shown for this property: ${missing.join("; and ")}. Nothing was estimated in their place.`,
    }
  }

  const annualRent = estimatedMonthlyRent * 12
  const netOperatingIncome = annualRent - Math.round(annualRent * assumptions.operatingExpenseRatio)
  const capRate = (netOperatingIncome / price) * 100

  const loanAmount = price * (1 - assumptions.downPaymentPct)
  const monthlyMortgage = calculateMortgage(loanAmount, assumptions.mortgageRatePct, assumptions.mortgageTermYears)
  const cashFlow = netOperatingIncome - monthlyMortgage * 12
  const cashOnCash = (cashFlow / (price * assumptions.downPaymentPct)) * 100

  return {
    price,
    rentalAnalysis,
    rentSource,
    assumptions,
    returns: {
      capRate: Number(capRate.toFixed(2)),
      cashOnCash: Number(cashOnCash.toFixed(2)),
      monthlyNetCashFlow: Math.round(cashFlow / 12),
      annualCashFlow: Math.round(cashFlow),
    },
    appreciation,
    meetsGoals:
      goals?.strategy === "cashflow" ? cashOnCash >= (goals?.targetCapRate || 6) : capRate >= 5,
    recommendation:
      capRate >= 6
        ? "Strong investment potential"
        : capRate >= 4
          ? "Moderate investment potential"
          : "Better suited for owner occupancy",
    unavailableNote: null,
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

function calculateMortgage(principal: number, annualRate: number, years: number): number {
  const monthlyRate = annualRate / 100 / 12
  const numPayments = years * 12
  return Math.round(
    (principal * monthlyRate * Math.pow(1 + monthlyRate, numPayments)) / (Math.pow(1 + monthlyRate, numPayments) - 1),
  )
}

// ==================== COMMUTE DESTINATIONS ====================
// The buyer's saved places (work, gym, family) live on contacts.metadata.commute_destinations
// so every property they view can show honest, personalized drive/transit estimates.

function readMetadata(raw: any): Record<string, any> {
  if (!raw) return {}
  if (typeof raw === "string") { try { return JSON.parse(raw) } catch { return {} } }
  return raw
}

export async function getCommuteDestinations(contactId: string): Promise<CommuteDestination[]> {
  const supabase = await createClient()
  const { data } = await supabase.from("contacts").select("metadata").eq("id", contactId).maybeSingle()
  const cf = readMetadata(data?.metadata)
  const list = cf.commute_destinations
  return Array.isArray(list) ? (list as CommuteDestination[]) : []
}

/** Add (or update) a saved place, then refresh commute on the given property. Idempotent by name. */
export async function saveCommuteDestination(
  contactId: string,
  dest: CommuteDestination,
  refresh?: { propertyId: string; propertyData: Record<string, any> },
): Promise<{ success: boolean; destinations?: CommuteDestination[]; commute?: Record<string, any> | null; error?: string }> {
  if (!dest?.name?.trim() || !dest?.address?.trim()) return { success: false, error: "Name and address are required" }
  const supabase = await createClient()
  const { data } = await supabase.from("contacts").select("metadata").eq("id", contactId).maybeSingle()
  const cf = readMetadata(data?.metadata)
  const existing: CommuteDestination[] = Array.isArray(cf.commute_destinations) ? cf.commute_destinations : []
  const cleaned: CommuteDestination = {
    name: dest.name.trim().slice(0, 60),
    address: dest.address.trim().slice(0, 200),
    type: (["work", "school", "family", "other"].includes(dest.type) ? dest.type : "other") as CommuteDestination["type"],
  }
  const next = [...existing.filter((d) => d.name.toLowerCase() !== cleaned.name.toLowerCase()), cleaned].slice(0, 5)
  const { error } = await supabase
    .from("contacts")
    .update({ metadata: { ...cf, commute_destinations: next } })
    .eq("id", contactId)
  if (error) return { success: false, error: error.message }
  let commute: Record<string, any> | null = null
  if (refresh) commute = await regeneratePropertyCommute(refresh.propertyId, contactId, refresh.propertyData, next).catch(() => null)
  return { success: true, destinations: next, commute }
}

export async function removeCommuteDestination(
  contactId: string,
  name: string,
  refresh?: { propertyId: string; propertyData: Record<string, any> },
): Promise<{ success: boolean; destinations?: CommuteDestination[]; commute?: Record<string, any> | null }> {
  const supabase = await createClient()
  const { data } = await supabase.from("contacts").select("metadata").eq("id", contactId).maybeSingle()
  const cf = readMetadata(data?.metadata)
  const existing: CommuteDestination[] = Array.isArray(cf.commute_destinations) ? cf.commute_destinations : []
  const next = existing.filter((d) => d.name.toLowerCase() !== name.toLowerCase())
  // The error is READ. This returns `{ success: true, destinations: next }` and
  // the UI redraws from `next`, so a refused write showed the destination gone
  // while the row still held it — the list reappears on the next load with no
  // trace of why. Not failed over (the caller's contract is unchanged and this is
  // a display preference, not consent), but the loss is no longer invisible.
  const { error: removeError } = await supabase.from("contacts").update({ metadata: { ...cf, commute_destinations: next } }).eq("id", contactId)
  if (removeError) {
    console.error(`[smart-insights] commute destination removal REFUSED for contact ${contactId}:`, removeError.message)
  }
  let commute: Record<string, any> | null = null
  if (refresh) commute = await regeneratePropertyCommute(refresh.propertyId, contactId, refresh.propertyData, next).catch(() => null)
  return { success: true, destinations: next, commute }
}

/** Recompute ONLY the commute column for one property+contact (cheap, no full-insight invalidation). */
export async function regeneratePropertyCommute(
  propertyId: string,
  contactId: string,
  propertyData: Record<string, any>,
  destinations: CommuteDestination[],
): Promise<Record<string, any> | null> {
  const supabase = await createClient()
  const commute_insights = await generateCommuteInsights(propertyData, destinations)
  const { data, error } = await supabase
    .from("contact_property_insights")
    .update({ commute_insights })
    .eq("property_id", propertyId)
    .eq("contact_id", contactId)
    .select("commute_insights")
    .maybeSingle()
  if (error) { console.error("[v0] regeneratePropertyCommute error:", error); return null }
  return (data?.commute_insights as Record<string, any>) ?? commute_insights
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

  // Feedback lives on `showings` (rating/feedback/buyer_interest_level), not
  // showing_requests (a scheduling request with no feedback columns + a status
  // CHECK that excludes "completed").
  // The portal speaks human (very_interested/...) but the column's CHECK only accepts the canonical
  // love_it/like_it/maybe/no — map BEFORE writing so the feedback actually persists (it had been
  // silently rejected by the CHECK on every portal submission).
  const { portalInterestToShowingLevel } = await import("@/lib/behavior-learning/signal-mapping")
  const canonicalInterest = portalInterestToShowingLevel(interestedLevel) ?? "maybe"
  const { error } = await supabase
    .from("showings")
    .update({
      rating: rating,
      feedback: notes,
      buyer_interest_level: canonicalInterest,
      status: "completed",
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", showingId)

  if (error) {
    console.error("[v0] Error updating showing feedback:", error)
    return { error: error.message }
  }

  // BUYER GRAPH LOOP — the post-tour verdict is the STRONGEST taste signal we get (they stood in
  // the home). Feed it into the learner so the buyer's criteria self-tune after every tour, with
  // ZERO manual filter editing (exactly the "smarter alert relevance" buyers ask for). Best-effort;
  // never blocks the feedback save. Only fires when we can resolve the toured listing's attributes.
  try {
    const { showingInterestToLearningSignal } = await import("@/lib/behavior-learning/signal-mapping")
    const learnSignal = showingInterestToLearningSignal(interestedLevel)
    if (learnSignal) {
      const { data: sh } = await supabase
        .from("showings").select("contact_id, listing_id, brokerage_id, agent_id").eq("id", showingId).maybeSingle()
      const showing = sh as { contact_id: string | null; listing_id: string | null; brokerage_id: string | null; agent_id: string | null } | null
      if (showing?.contact_id && showing?.brokerage_id && showing?.listing_id) {
        const { data: lst } = await supabase
          .from("listings").select("list_price, bedrooms, bathrooms, sqft, city, property_type").eq("id", showing.listing_id).maybeSingle()
        const l = lst as Record<string, any> | null
        if (l) {
          const { updatePreferencesFromSignal } = await import("@/lib/behavior-learning/preference-updater")
          await updatePreferencesFromSignal({
            contactId: showing.contact_id, agentId: showing.agent_id ?? "system", brokerageId: showing.brokerage_id,
            signal: learnSignal,
            property: {
              price: Number(l.list_price ?? 0), bedrooms: Number(l.bedrooms ?? 0), bathrooms: Number(l.bathrooms ?? 0),
              sqft: Number(l.sqft ?? 0), city: l.city ?? "", features: [], property_type: l.property_type ?? "",
            },
          })
        }
      }
    }
  } catch (e) {
    console.error("[v0] showing-feedback preference learning best-effort failed:", e)
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

/**
 * Remove a saved property.
 *
 * savedPropertyId is a `saved_properties.id` — NOT a `listings.id`. Both callers
 * are the portal detail route, which resolves its row with `.eq("id", propertyId)`
 * and then passed the very same value into a `listing_id` filter. listing_id FKs
 * listings(id) (verified live) and is NULL for every IDX/RentCast save, so the
 * delete matched nothing, `error` was null, and the caller was told "Removed from
 * saved" while the property stayed put. Two ids of different classes, one
 * variable name.
 */
export async function unsaveProperty(contactId: string, savedPropertyId: string) {
  const supabase = await createClient()

  // .select() so the delete reports what it actually removed. Without it a
  // no-match and a success are the same value.
  const { data: removed, error } = await supabase
    .from("saved_properties")
    .delete()
    .eq("contact_id", contactId)
    .eq("id", savedPropertyId)
    .select("id")

  if (error) {
    console.error("[saved-properties] Error unsaving property:", error)
    return { success: false, error: error.message }
  }
  if (!removed?.length) {
    return { success: false, error: "That property is not in your saved list" }
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

/** Same class correction as unsaveProperty: the caller holds a saved_properties.id.
 *  Filtering listing_id with it always returned false, so the heart rendered
 *  UNSAVED on a property the client had opened from their own saved list — and
 *  the toggle then took the save branch, which FK-threw. Dead in both directions. */
export async function isPropertySaved(contactId: string, savedPropertyId: string) {
  const supabase = await createClient()

  const { data } = await supabase
    .from("saved_properties")
    .select("id")
    .eq("contact_id", contactId)
    .eq("id", savedPropertyId)
    .maybeSingle()

  return !!data
}
