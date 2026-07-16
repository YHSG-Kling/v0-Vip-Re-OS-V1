"use server"

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { sendVendorBookingConfirmation } from "@/lib/communications"
import { syncToPlatform } from "@/lib/platform-sync" // Import syncToPlatform function
import { getAgentContext } from "@/lib/identity/get-agent-context"
import {
  getPackageServices,
  calculatePackageCost,
  getPackageDisplayName,
} from "@/lib/marketing/package-catalog"

// ============================================
// TENANT GUARDS
// ============================================

async function requireBrokerage(): Promise<
  | { ok: true; brokerageId: string; userId: string; agentId: string | null }
  | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { ok: false, error: "Unauthorized" }
  }
  return { ok: true, brokerageId: ctx.brokerageId, userId: ctx.userId, agentId: ctx.agentId }
}

/**
 * Verify a transaction row belongs to the caller's brokerage.
 * Uses the service client so the lookup isn't blocked by RLS.
 */
async function verifyTransactionInBrokerage(
  transactionId: string,
  brokerageId: string
): Promise<boolean> {
  const svc = createServiceClient()
  const { data } = await svc
    .from("transactions")
    .select("id, brokerage_id")
    .eq("id", transactionId)
    .maybeSingle()
  return !!data && (data as any).brokerage_id === brokerageId
}

/**
 * Verify a listing_marketing_packages row resolves back to a transaction
 * owned by the caller's brokerage.
 */
async function verifyPackageInBrokerage(
  packageId: string,
  brokerageId: string
): Promise<{ ok: boolean; transactionId?: string }> {
  const svc = createServiceClient()
  const { data: pkg } = await svc
    .from("listing_marketing_packages")
    .select("id, transaction_id")
    .eq("id", packageId)
    .maybeSingle()
  if (!pkg) return { ok: false }
  const txId = (pkg as any).transaction_id as string
  const ok = await verifyTransactionInBrokerage(txId, brokerageId)
  return { ok, transactionId: ok ? txId : undefined }
}

// ============================================
// MARKETING PACKAGE MANAGEMENT
// ============================================

export async function activateMarketingPackage(params: {
  transactionId: string
  packageType: "basic" | "standard" | "premium" | "luxury"
  autoBookServices?: boolean
}) {
  if (!isValidUUID(params.transactionId)) {
    return { success: false, error: "Invalid transaction ID" }
  }

  const auth = await requireBrokerage()
  if (!auth.ok) return { success: false, error: auth.error }

  const ownsTx = await verifyTransactionInBrokerage(params.transactionId, auth.brokerageId)
  if (!ownsTx) return { success: false, error: "Forbidden" }

  const supabase = await createClient()

  try {
    const { data: transaction } = await supabase
      .from("transactions")
      .select("*, listings(*)")
      .eq("id", params.transactionId)
      .eq("brokerage_id", auth.brokerageId)
      .single()

    if (!transaction || !transaction.listings) {
      return { success: false, error: "Transaction not found" }
    }

    const services = getPackageServices(params.packageType)

    // Create marketing package
    const { data: marketingPackage, error } = await supabase
      .from("listing_marketing_packages")
      .insert({
        transaction_id: params.transactionId,
        package_name: getPackageDisplayName(params.packageType),
        package_type: params.packageType,
        included_services: services,
        total_estimated_cost: calculatePackageCost(params.packageType),
        status: "active",
        activated_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (error) throw error

    // Auto-book services if requested
    if (params.autoBookServices) {
      for (const service of services) {
        await bookMarketingService({
          packageId: marketingPackage.id,
          serviceType: service,
          transactionId: params.transactionId,
        })
      }
    }

    // Initialize syndication tracking
    await initializeSyndicationTracking(params.transactionId)

    revalidatePath("/dashboard/listings")
    return { success: true, packageId: marketingPackage.id }
  } catch (error) {
    console.error("Activate marketing package error:", error)
    return { success: false, error: "Failed to activate package" }
  }
}

// ============================================
// VENDOR BOOKING & MANAGEMENT
// ============================================

export async function bookMarketingService(params: {
  packageId: string
  serviceType: string
  transactionId: string
  preferredDate?: string
}) {
  if (!isValidUUID(params.packageId) || !isValidUUID(params.transactionId)) {
    return { success: false, error: "Invalid package or transaction ID" }
  }

  const auth = await requireBrokerage()
  if (!auth.ok) return { success: false, error: auth.error }

  const ownsTx = await verifyTransactionInBrokerage(params.transactionId, auth.brokerageId)
  if (!ownsTx) return { success: false, error: "Forbidden" }

  const pkgCheck = await verifyPackageInBrokerage(params.packageId, auth.brokerageId)
  if (!pkgCheck.ok || pkgCheck.transactionId !== params.transactionId) {
    return { success: false, error: "Forbidden" }
  }

  const supabase = await createClient()

  try {
    // Find optimal vendor
    const vendor = await selectOptimalVendor(params.serviceType, params.transactionId)

    if (!vendor) {
      return { success: false, error: "No available vendors for this service" }
    }

    // Create service booking
    const { data: service, error } = await supabase
      .from("listing_marketing_services")
      .insert({
        package_id: params.packageId,
        transaction_id: params.transactionId,
        service_type: params.serviceType,
        vendor_id: vendor.id,
        scheduled_date: params.preferredDate || null,
        status: "scheduled",
        estimated_cost: vendor.base_price,
      })
      .select()
      .single()

    if (error) throw error

    // Send booking confirmation to vendor
    await sendVendorBookingConfirmation({
      vendorId: vendor.id,
      vendorEmail: vendor.contact_email,
      serviceType: params.serviceType,
      transactionId: params.transactionId,
      serviceId: service.id,
      scheduledDate: service.scheduled_date,
    })

    console.log(`[v0] Booked ${params.serviceType} with vendor ${vendor.company_name}`)

    revalidatePath("/dashboard/listings")
    return { success: true, serviceId: service.id, vendorName: vendor.company_name }
  } catch (error) {
    console.error("Book marketing service error:", error)
    return { success: false, error: "Failed to book service" }
  }
}

async function selectOptimalVendor(serviceType: string, transactionId: string) {
  const supabase = await createClient()

  try {
    const { data: transaction } = await supabase
      .from("transactions")
      .select("*, listings(*)")
      .eq("id", transactionId)
      .single()

    if (!transaction?.listings) return null

    const listing = transaction.listings

    // Find vendors for this service type — vendors replaced vendor_directory —
    // vendor_directory was a writer-less legacy twin (burn-down round 4 repoint).
    // visible_in_portal→status='active' (broker approval, the real surfacing flag on vendors).
    const { data: vendors } = await supabase
      .from("vendors")
      .select("*")
      .eq("category", serviceType)
      .eq("status", "active")
      .gte("rating", 3.75) // rescaled from quality_score>=75 (0-100) → rating>=3.75 (0-5)

    if (!vendors || vendors.length === 0) return null

    // Score vendors based on multiple factors
    const scoredVendors = vendors.map((vendor) => {
      let score = (vendor.rating || 0) * 20 // rating 0-5 → 0-100 to keep downstream bonuses on scale

      // Proximity bonus (if location data available)
      const distance = calculateDistance(listing, vendor)
      if (distance < 10) score += 20
      else if (distance < 25) score += 10

      // Price efficiency
      const avgPrice = 500 // Average market price
      if (vendor.base_price < avgPrice * 0.8) score += 10
      else if (vendor.base_price > avgPrice * 1.2) score -= 10

      // Response time
      if ((vendor.avg_response_hours || 24) < 4) score += 15
      else if ((vendor.avg_response_hours || 24) > 24) score -= 10

      // Completion rate
      if ((vendor.completion_rate || 0) > 0.95) score += 10

      return { ...vendor, finalScore: score }
    })

    // Return highest scoring vendor
    scoredVendors.sort((a, b) => b.finalScore - a.finalScore)
    return scoredVendors[0]
  } catch (error) {
    console.error("Select optimal vendor error:", error)
    return null
  }
}

function calculateDistance(listing: any, vendor: any): number {
  // Simplified distance calculation (would use actual geocoding in production)
  if (listing.city === vendor.service_area) return 5
  return 50 // Default to 50 miles if different cities
}

export async function getVendorRecommendations(serviceType: string, transactionId: string) {
  if (!isValidUUID(transactionId)) {
    return []
  }

  const auth = await requireBrokerage()
  if (!auth.ok) return []

  const ownsTx = await verifyTransactionInBrokerage(transactionId, auth.brokerageId)
  if (!ownsTx) return []

  const supabase = await createClient()

  // vendors replaced vendor_directory — vendor_directory was a writer-less legacy twin (burn-down round 4 repoint)
  const { data: vendors } = await supabase
    .from("vendors")
    .select("*")
    .eq("category", serviceType)
    .eq("status", "active") // visible_in_portal→status='active' (broker approval, the real surfacing flag)
    .order("rating", { ascending: false, nullsFirst: false })
    .limit(5)

  return vendors || []
}

// ============================================
// SYNDICATION TRACKING
// ============================================

async function initializeSyndicationTracking(transactionId: string) {
  const supabase = await createClient()

  const platforms = [
    { name: "Zillow", category: "major_portal" },
    { name: "Realtor.com", category: "major_portal" },
    { name: "Trulia", category: "major_portal" },
    { name: "Redfin", category: "major_portal" },
    { name: "Homes.com", category: "secondary_portal" },
    { name: "Facebook Marketplace", category: "social_media" },
    { name: "Instagram", category: "social_media" },
  ]

  for (const platform of platforms) {
    await supabase.from("listing_syndication_tracking").insert({
      transaction_id: transactionId,
      platform_name: platform.name,
      platform_category: platform.category,
      syndication_status: "pending",
      last_synced_at: new Date().toISOString(),
    })
  }
}

export async function syncListingToPlatforms(transactionId: string) {
  if (!isValidUUID(transactionId)) {
    return { success: false, error: "Invalid transaction ID" }
  }

  const auth = await requireBrokerage()
  if (!auth.ok) return { success: false, error: auth.error }

  const ownsTx = await verifyTransactionInBrokerage(transactionId, auth.brokerageId)
  if (!ownsTx) return { success: false, error: "Forbidden" }

  const supabase = await createClient()

  try {
    const { data: syndicationRecords } = await supabase
      .from("listing_syndication_tracking")
      .select("*")
      .eq("transaction_id", transactionId)
      .eq("syndication_status", "pending")

    if (!syndicationRecords || syndicationRecords.length === 0) {
      return { success: true, message: "No pending syndications" }
    }

    let successCount = 0

    for (const record of syndicationRecords) {
      // Platform-specific API integration
      const listing = await getListingDetails(transactionId) // Fetch listing details
      const platformResult = await syncToPlatform(record.platform_name, transactionId, listing)
      
      if (!platformResult.success) {
        console.warn(`[v0] Failed to sync to ${record.platform_name}:`, platformResult.error)
        continue
      }

      await supabase
        .from("listing_syndication_tracking")
        .update({
          syndication_status: "active",
          last_synced_at: new Date().toISOString(),
          listing_url: `https://${record.platform_name.toLowerCase().replace(/\s/g, "")}.com/listing/${transactionId}`,
        })
        .eq("id", record.id)

      successCount++
    }

    revalidatePath("/dashboard/listings")
    return { success: true, synced: successCount }
  } catch (error) {
    console.error("Sync listing error:", error)
    return { success: false, error: "Failed to sync listings" }
  }
}

async function getListingDetails(transactionId: string) {
  const supabase = await createClient()
  const { data: transaction } = await supabase
    .from("transactions")
    .select("*, listings(*)")
    .eq("id", transactionId)
    .single()
  return transaction?.listings || null
}

export async function getSyndicationStatus(transactionId: string) {
  if (!isValidUUID(transactionId)) {
    return []
  }

  const supabase = await createClient()

  const { data } = await supabase
    .from("listing_syndication_tracking")
    .select("*")
    .eq("transaction_id", transactionId)
    .order("platform_name")

  return data || []
}

// ============================================
// AI OPTIMIZATION RECOMMENDATIONS
// ============================================

export async function generateListingOptimizations(transactionId: string) {
  if (!isValidUUID(transactionId)) {
    return { success: false, error: "Invalid transaction ID" }
  }

  const auth = await requireBrokerage()
  if (!auth.ok) return { success: false, error: auth.error }

  const ownsTx = await verifyTransactionInBrokerage(transactionId, auth.brokerageId)
  if (!ownsTx) return { success: false, error: "Forbidden" }

  const supabase = await createClient()

  try {
    const { data: transaction } = await supabase
      .from("transactions")
      .select("*, listings(*), listing_photos(*), ai_generated_content(*)")
      .eq("id", transactionId)
      .eq("brokerage_id", auth.brokerageId)
      .single()

    if (!transaction || !transaction.listings) {
      return { success: false, error: "Transaction not found" }
    }

    const listing = transaction.listings
    const photos = transaction.listing_photos || []
    const content = transaction.ai_generated_content || []

    const prompt = `Analyze this real estate listing and provide optimization recommendations.

LISTING DETAILS:
- Address: ${listing.address}, ${listing.city}
- Price: $${listing.price}
- Bedrooms: ${listing.bedrooms}
- Bathrooms: ${listing.bathrooms}
- Square Feet: ${listing.square_feet}
- Photos: ${photos.length} (Avg quality: ${(photos.reduce((sum: number, p: any) => sum + (p.ai_quality_score || 0), 0) / photos.length || 0).toFixed(1)}/100)
- Days on Market: ${calculateDaysOnMarket(listing.listing_date)}

MARKET CONTEXT:
- Similar homes in area: $${listing.price * 0.95} - $${listing.price * 1.05}
- Average days on market: 30-45 days

TASK: Provide actionable optimization recommendations across these categories:
1. Pricing Strategy
2. Photo Quality & Quantity
3. Description Improvements
4. Marketing Channels
5. Timing & Urgency

OUTPUT FORMAT (JSON):
{
  "optimizations": [
    {
      "category": "pricing",
      "priority": "high",
      "recommendation": "Consider reducing price by 3% to $XXX,XXX",
      "reasoning": "Price per sqft is 8% above market average",
      "estimated_impact": "Could reduce DOM by 15 days"
    }
  ],
  "overall_health_score": 75,
  "key_strengths": ["Great photos", "Competitive pricing"],
  "critical_issues": ["Missing virtual tour"]
}`

    const { text } = await generateText({
      model: "openai/gpt-4o",
      prompt,
    })

    const optimizations = parseAIJsonResponse(text)

    // Save optimizations
    if (optimizations.optimizations && Array.isArray(optimizations.optimizations)) {
      for (const opt of optimizations.optimizations) {
        await supabase.from("ai_listing_optimizations").insert({
          transaction_id: transactionId,
          optimization_category: opt.category,
          recommendation: opt.recommendation,
          reasoning: opt.reasoning,
          priority: opt.priority,
          estimated_impact: opt.estimated_impact,
          status: "pending",
          generated_at: new Date().toISOString(),
        })
      }
    }

    revalidatePath("/dashboard/listings")
    return { success: true, data: optimizations }
  } catch (error) {
    console.error("Generate optimizations error:", error)
    return { success: false, error: "Failed to generate optimizations" }
  }
}

function parseAIJsonResponse(text: string): any {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0])
    }
    return JSON.parse(text)
  } catch {
    return { optimizations: [] }
  }
}

function calculateDaysOnMarket(listingDate?: string): number {
  if (!listingDate) return 0
  const listed = new Date(listingDate)
  const now = new Date()
  const diffTime = Math.abs(now.getTime() - listed.getTime())
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24))
}

export async function getMarketingPackageStatus(transactionId: string) {
  if (!isValidUUID(transactionId)) {
    return null
  }

  const auth = await requireBrokerage()
  if (!auth.ok) return null

  const ownsTx = await verifyTransactionInBrokerage(transactionId, auth.brokerageId)
  if (!ownsTx) return null

  const supabase = await createClient()

  const { data: pkg } = await supabase
    .from("listing_marketing_packages")
    .select("*, listing_marketing_services(*)")
    .eq("transaction_id", transactionId)
    .order("activated_at", { ascending: false })
    .limit(1)
    .single()

  return pkg
}

// Function renamed to avoid redeclaration
export async function getMarketingPackageServices(packageId: string) {
  if (!isValidUUID(packageId)) {
    return []
  }

  const auth = await requireBrokerage()
  if (!auth.ok) return []

  const pkgCheck = await verifyPackageInBrokerage(packageId, auth.brokerageId)
  if (!pkgCheck.ok) return []

  const supabase = await createClient()

  const { data } = await supabase
    .from("listing_marketing_services")
    // Live FK: listing_marketing_services.vendor_id → vendors(id). The old
    // vendor_directory embed could never resolve (no FK to that legacy twin) —
    // PostgREST errored the whole select. Burn-down round 4 repoint.
    .select("*, vendor:vendors(*)")
    .eq("package_id", packageId)
    .order("scheduled_date")

  return data || []
}
