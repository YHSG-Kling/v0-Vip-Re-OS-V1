"use server"

/**
 * System 5.3: CMA & Listing Presentation Engine
 * CMA Generator
 * 
 * Generates seller-ready CMA with quality enforcement and mandatory disclaimer.
 * DOES NOT advance journey state - only emits completion signals.
 */

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"

export interface CMAGenerationInput {
  listingId: string
  contactId: string
  agentId: string
  brokerageId?: string
  
  // CMA parameters
  targetAddress?: string
  propertyType?: string
  bedrooms?: number
  bathrooms?: number
  squareFeet?: number
  
  // Search parameters (optional - will derive from listing if not provided)
  radiusMiles?: number
  maxAgeDays?: number
  minComparables?: number
}

export interface CMAResult {
  success: boolean
  cmaId?: string
  qualityScore?: number
  comparableCount?: number
  error?: string
  warnings?: string[]
}

/**
 * MANDATORY CMA DISCLAIMER (REQUIRED IN EVERY CMA)
 */
export const CMA_DISCLAIMER = `This Comparative Market Analysis (CMA) is provided for informational purposes only and is not an appraisal. An appraisal can only be performed by a licensed appraiser.`

/**
 * Generate CMA for seller
 */
export async function generateCMA(input: CMAGenerationInput): Promise<CMAResult> {
  try {
    // Validation
    if (!isValidUUID(input.listingId)) {
      return { success: false, error: "Invalid listing ID" }
    }
    if (!isValidUUID(input.contactId)) {
      return { success: false, error: "Invalid contact ID" }
    }
    if (!isValidUUID(input.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    const supabase = await createClient()

    // Emit start event
    await supabase.from("activities").insert({
      type: "seller.cma.started",
      listing_id: input.listingId,
      contact_id: input.contactId,
      user_id: input.agentId,
      metadata: {
        radius_miles: input.radiusMiles || 2.0,
        max_age_days: input.maxAgeDays || 90,
        min_comparables: input.minComparables || 5
      }
    })

    // Get listing data
    const { data: listing, error: listingError } = await supabase
      .from("listings")
      .select("*")
      .eq("id", input.listingId)
      .single()

    if (listingError || !listing) {
      await emitCMAFailed(input.listingId, input.contactId, input.agentId, "Listing not found")
      return { success: false, error: "Listing not found" }
    }

    // Get contact data for personalization
    const { data: contact } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", input.contactId)
      .single()

    // Fetch comparables (simulated - in production this would call MLS/IDX API)
    const comparables = await fetchComparables({
      address: listing.address || input.targetAddress || "",
      city: listing.city || "",
      state: listing.state || "",
      zip: listing.zip || "",
      propertyType: input.propertyType || listing.property_type || "Single Family",
      bedrooms: input.bedrooms || listing.bedrooms || 0,
      bathrooms: input.bathrooms || listing.bathrooms || 0,
      squareFeet: input.squareFeet || listing.square_feet || 0,
      radiusMiles: input.radiusMiles || 2.0,
      maxAgeDays: input.maxAgeDays || 90,
      minComparables: input.minComparables || 5
    })

    // Quality check
    if (comparables.length < (input.minComparables || 5)) {
      const warnings = [`Only found ${comparables.length} comparables, minimum ${input.minComparables || 5} recommended`]
      await emitCMAFailed(
        input.listingId,
        input.contactId,
        input.agentId,
        `Insufficient comparables: ${comparables.length}`
      )
      return { 
        success: false, 
        error: "Insufficient comparables found",
        warnings,
        comparableCount: comparables.length
      }
    }

    // Calculate quality metrics
    const oldestComparableMonths = Math.max(
      ...comparables.map(c => 
        Math.floor((Date.now() - new Date(c.soldDate).getTime()) / (1000 * 60 * 60 * 24 * 30))
      )
    )
    
    const maxRadiusMiles = Math.max(...comparables.map(c => c.distanceMiles))

    // Generate CMA content with seller personalization
    const cmaContent = generateCMAContent({
      listing,
      contact,
      comparables,
      disclaimer: CMA_DISCLAIMER
    })

    // Calculate quality score
    const qualityScore = calculateQualityScore({
      comparableCount: comparables.length,
      oldestComparableMonths,
      maxRadiusMiles,
      minComparables: input.minComparables || 5
    })

    // Store CMA (using activities as temporary storage per constraints)
    const cmaId = crypto.randomUUID()

    // Emit completion event with quality metadata
    await supabase.from("activities").insert({
      type: "seller.cma.completed",
      listing_id: input.listingId,
      contact_id: input.contactId,
      user_id: input.agentId,
      metadata: {
        cma_id: cmaId,
        comparable_count: comparables.length,
        oldest_comparable_months: oldestComparableMonths,
        max_radius_miles: maxRadiusMiles,
        quality_score: qualityScore,
        content_preview: cmaContent.substring(0, 500),
        disclaimer_included: true
      }
    })

    return {
      success: true,
      cmaId,
      qualityScore,
      comparableCount: comparables.length,
      warnings: []
    }
  } catch (error: any) {
    console.error("[System 5.3] CMA generation error:", error)
    return {
      success: false,
      error: error.message || "Failed to generate CMA"
    }
  }
}

/**
 * Fetch comparable properties — priority chain:
 *   1. BatchData /comparable-sales (real MLS comps via API key)
 *   2. HouseCanary /property/sales_history (if BatchData unconfigured)
 *   3. Empty array — amber banner in UI instructs agent to review manually
 */
async function fetchComparables(params: {
  address: string
  city: string
  state: string
  zip: string
  propertyType: string
  bedrooms: number
  bathrooms: number
  squareFeet: number
  radiusMiles: number
  maxAgeDays: number
  minComparables: number
}) {
  const { fetchComparableSales } = await import("@/lib/external/batchdata-client")
  const { fetchHouseCanaryComps } = await import("@/lib/external/housecanary-client")

  // ── 1. BatchData ─────────────────────────────────────────────────────────
  const bdComps = await fetchComparableSales({
    address: params.address,
    city: params.city,
    state: params.state,
    zip: params.zip,
    bedrooms: params.bedrooms,
    bathrooms: params.bathrooms,
    squareFeet: params.squareFeet,
    radiusMiles: params.radiusMiles,
    maxAgeDays: params.maxAgeDays,
    limit: params.minComparables,
  })

  if (bdComps.length > 0) {
    return bdComps.map((c) => ({
      address: c.address,
      city: c.city,
      state: c.state,
      zip: c.zip,
      bedrooms: c.bedrooms,
      bathrooms: c.bathrooms,
      squareFeet: c.square_feet,
      soldPrice: c.sale_price,
      listPrice: c.list_price,
      soldDate: c.sale_date,
      daysOnMarket: c.days_on_market,
      pricePerSqFt: c.price_per_sqft,
      distanceMiles: c.distance_miles,
      yearBuilt: c.year_built,
      source: "BatchData",
    }))
  }

  // ── 2. HouseCanary ───────────────────────────────────────────────────────
  const hcComps = await fetchHouseCanaryComps({
    address: params.address,
    zipCode: params.zip,
    bedrooms: params.bedrooms,
    squareFeet: params.squareFeet,
    maxAgeDays: params.maxAgeDays,
    limit: params.minComparables,
  })

  if (hcComps.length > 0) {
    return hcComps.map((c) => ({
      address: c.address,
      city: c.city || params.city,
      state: c.state || params.state,
      zip: c.zip,
      bedrooms: c.bedrooms,
      bathrooms: c.bathrooms,
      squareFeet: c.square_feet,
      soldPrice: c.sale_price,
      listPrice: c.list_price,
      soldDate: c.sale_date,
      daysOnMarket: c.days_on_market,
      pricePerSqFt: c.price_per_sqft,
      distanceMiles: c.distance_miles,
      yearBuilt: c.year_built,
      source: "HouseCanary",
    }))
  }

  // ── 3. No API configured — return empty, amber banner shows in UI ────────
  return []
}

/**
 * Generate seller-personalized CMA content
 */
function generateCMAContent(params: {
  listing: any
  contact: any
  comparables: any[]
  disclaimer: string
}) {
  const { listing, contact, comparables, disclaimer } = params
  
  const avgPrice = comparables.reduce((sum, c) => sum + c.soldPrice, 0) / comparables.length
  const pricePerSqFt = avgPrice / (listing.square_feet || 1)
  
  const contactName = contact?.first_name ? `${contact.first_name} ${contact.last_name || ''}`.trim() : "Valued Client"
  
  return `
# Comparative Market Analysis
## Prepared for ${contactName}
### Property: ${listing.address}, ${listing.city}, ${listing.state} ${listing.zip}

---

## Market Analysis Summary

Based on ${comparables.length} comparable properties sold within the last 90 days in your area:

**Average Sold Price:** $${Math.round(avgPrice).toLocaleString()}
**Price Per Square Foot:** $${Math.round(pricePerSqFt)}
**Recommended List Price Range:** $${Math.round(avgPrice * 0.95).toLocaleString()} - $${Math.round(avgPrice * 1.05).toLocaleString()}

## Comparable Properties

${comparables.map((c, i) => `
### Comparable ${i + 1}
- **Address:** ${c.address}, ${c.city}, ${c.state}
- **Sold Price:** $${c.soldPrice.toLocaleString()}
- **Sold Date:** ${new Date(c.soldDate).toLocaleDateString()}
- **Bedrooms:** ${c.bedrooms} | **Bathrooms:** ${c.bathrooms}
- **Square Feet:** ${Math.round(c.squareFeet).toLocaleString()}
- **Distance:** ${c.distanceMiles.toFixed(2)} miles
`).join('\n')}

---

## Important Disclaimer

${disclaimer}

---

*This CMA was prepared by your real estate professional to help you make an informed decision about listing your property. Market conditions may change, and this analysis reflects data as of ${new Date().toLocaleDateString()}.*
`.trim()
}

/**
 * Calculate CMA quality score (0-100)
 */
function calculateQualityScore(params: {
  comparableCount: number
  oldestComparableMonths: number
  maxRadiusMiles: number
  minComparables: number
}) {
  let score = 100
  
  // Penalize if below minimum comparables
  if (params.comparableCount < params.minComparables) {
    score -= (params.minComparables - params.comparableCount) * 10
  }
  
  // Penalize if comparables are too old (> 6 months)
  if (params.oldestComparableMonths > 6) {
    score -= (params.oldestComparableMonths - 6) * 5
  }
  
  // Penalize if radius is too wide (> 2 miles)
  if (params.maxRadiusMiles > 2.0) {
    score -= (params.maxRadiusMiles - 2.0) * 10
  }
  
  return Math.max(0, Math.min(100, score))
}

/**
 * Emit CMA failed event
 */
async function emitCMAFailed(
  listingId: string,
  contactId: string,
  agentId: string,
  reason: string
) {
  const supabase = await createClient()
  
  await supabase.from("activities").insert({
    type: "seller.cma.failed",
    listing_id: listingId,
    contact_id: contactId,
    user_id: agentId,
    metadata: { reason }
  })
}
