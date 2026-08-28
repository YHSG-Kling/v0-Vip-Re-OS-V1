"use server"

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { isValidUUID } from "@/lib/validations"
import { sendVendorBookingConfirmation } from "@/lib/communications"
// The full syndication lifecycle, not just the first push: publish, reconcile
// changes, and WITHDRAW when the home is no longer being marketed.
import { syncToPlatform, updatePlatformListing, removePlatformListing } from "@/lib/platform-sync"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import {
  getPackageServices,
  calculatePackageCost,
  getPackageDisplayName,
} from "@/lib/marketing/package-catalog"
import {
  MIN_AUTO_BOOK_RATING,
  isAutoBookable,
  pickBestVendor,
  rankVendors,
  vendorCategoryForService,
  type RankableVendor,
  type ScoredVendor,
} from "@/lib/marketing/vendor-ranking"

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
    // Find optimal vendor. The result is a discriminated outcome, not a nullable
    // vendor: a REFUSED read and an EMPTY bench are different facts and the agent
    // is told which one happened instead of both surfacing as "none available".
    const pick = await selectOptimalVendor(params.serviceType, params.transactionId)

    if (!pick.ok) {
      return { success: false, error: pick.error }
    }
    const vendor = pick.vendor

    // Create service booking.
    // estimated_cost is deliberately omitted (stays NULL): the bench carries no
    // price for a vendor and the package catalog prices a whole TIER, not one
    // service, so there is no honest per-service figure to persist here. A number
    // invented at booking time would be indistinguishable from a quote.
    const { data: service, error } = await supabase
      .from("listing_marketing_services")
      .insert({
        package_id: params.packageId,
        transaction_id: params.transactionId,
        service_type: params.serviceType,
        vendor_id: vendor.id,
        scheduled_date: params.preferredDate || null,
        status: "scheduled",
      })
      .select()
      .single()

    if (error) throw error

    // Send booking confirmation to vendor. email is nullable on the bench, so a
    // vendor with no address is booked and reported rather than crashing the
    // booking on a notification that was never deliverable.
    if (vendor.email) {
      await sendVendorBookingConfirmation({
        vendorId: vendor.id,
        vendorEmail: vendor.email,
        serviceType: params.serviceType,
        transactionId: params.transactionId,
        serviceId: service.id,
        scheduledDate: service.scheduled_date,
      })
    }

    revalidatePath("/dashboard/listings")
    return {
      success: true,
      serviceId: service.id,
      vendorName: vendor.name,
      vendorNotified: !!vendor.email,
      // What the auto-pick could NOT weigh, carried forward so the surface can be
      // honest about the basis of the choice.
      unmeasuredRankingInputs: vendor.unmeasured,
    }
  } catch (error) {
    console.error("Book marketing service error:", error)
    return { success: false, error: "Failed to book service" }
  }
}

/** The outcome of the auto-pick. A refusal is never collapsed into "no vendors". */
type VendorPick =
  | { ok: true; vendor: ScoredVendor & { email: string | null } }
  | { ok: false; error: string }

/**
 * Pick the bench vendor that should fulfil one marketing service.
 *
 * The bench is filtered by CATEGORY, which is a CHECK'd vocabulary on the vendor
 * table (photographer / videographer / drone_pilot / 3d_tour / stager / …). A
 * package service type ("professional_photos", "drone_video") is a different
 * vocabulary and matches no category, so the service is translated through
 * lib/marketing/vendor-ranking.ts:vendorCategoryForService first. Services with
 * no bench category are fulfilled in-house and say so.
 *
 * The ordering itself is pure and lives in vendor-ranking.ts:rankVendors — it
 * weighs only columns the bench actually has (rating, preferred, display
 * priority, turnaround days) and publishes what it could not weigh.
 */
async function selectOptimalVendor(serviceType: string, transactionId: string): Promise<VendorPick> {
  const supabase = await createClient()

  try {
    const category = vendorCategoryForService(serviceType)
    if (!category) {
      return { ok: false, error: `"${serviceType}" is fulfilled in-house — there is no vendor bench for it` }
    }

    // Only the tenant anchor is needed from the deal; the ranking reads nothing
    // off the listing (the bench carries no location to compare it against).
    const { data: transaction, error: txError } = await supabase
      .from("transactions")
      .select("id, brokerage_id")
      .eq("id", transactionId)
      .single()

    if (txError) {
      console.error("Select optimal vendor — transaction read refused:", txError)
      return { ok: false, error: "Could not read the transaction" }
    }
    if (!transaction?.brokerage_id) {
      return { ok: false, error: "Transaction has no brokerage — cannot scope a vendor bench" }
    }

    const { data: vendors, error: benchError } = await supabase
      .from("vendors")
      .select("id, name, email, rating, preferred, display_priority, estimated_turnaround_days")
      .eq("brokerage_id", transaction.brokerage_id) // tenant anchor — never rank another brokerage's bench
      .eq("category", category)
      .eq("status", "active") // broker approval — the real surfacing flag on the bench
      .gte("rating", MIN_AUTO_BOOK_RATING) // shared with getVendorRecommendations so the two paths cannot disagree

    if (benchError) {
      console.error("Select optimal vendor — bench read refused:", benchError)
      return { ok: false, error: "Could not read the vendor bench" }
    }
    if (!vendors || vendors.length === 0) {
      return { ok: false, error: `No approved ${category} on this brokerage's bench` }
    }

    const best = pickBestVendor(vendors as RankableVendor[])
    if (!best) return { ok: false, error: `No approved ${category} on this brokerage's bench` }

    const email = (vendors.find((v) => v.id === best.id)?.email ?? null) as string | null
    return { ok: true, vendor: { ...best, email } }
  } catch (error) {
    console.error("Select optimal vendor error:", error)
    return { ok: false, error: "Failed to select a vendor" }
  }
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

  // Same category translation as the auto-pick: a package service type is not a
  // bench category, so the raw service type would match no row.
  const category = vendorCategoryForService(serviceType)
  if (!category) return []

  const { data: vendors, error } = await supabase
    .from("vendors")
    .select("id, name, email, phone, rating, preferred, display_priority, estimated_turnaround_days")
    .eq("brokerage_id", auth.brokerageId) // tenant anchor — caller's brokerage only
    .eq("category", category)
    .eq("status", "active") // broker approval — the real surfacing flag on the bench
    .limit(25)

  // A refused read must not read as "this brokerage has no vendors".
  if (error) {
    console.error("getVendorRecommendations — bench read refused:", error)
    return []
  }

  // Ordered by the same published ranking the auto-pick uses, so the list an
  // agent sees is the order the automation would actually book in.
  //
  // The bench is NOT filtered by MIN_AUTO_BOOK_RATING here, deliberately. These
  // vendors are all on the broker's approved bench; the threshold governs what
  // the automation picks UNPROMPTED, not what an agent may choose. Hiding the
  // rest would answer "who could do this job?" with the answer to a different
  // question. Instead each row SAYS whether the automation would take it, so
  // the list and the auto-pick can no longer disagree silently — which they did
  // before, the auto-pick filtering on this number while the list did not.
  return rankVendors((vendors ?? []) as RankableVendor[])
    .slice(0, 5)
    .map((v) => ({
      ...v,
      /** True when bookMarketingService would pick this vendor on its own. */
      autoBookable: isAutoBookable(v),
      /**
       * Why not, in words an agent can act on — null when it would be booked.
       * An unrated vendor and a low-rated one are different situations and are
       * not collapsed into one sentence.
       */
      autoBookBlockedReason:
        isAutoBookable(v)
          ? null
          : typeof v.rating === "number"
            ? `Rated ${v.rating.toFixed(1)} — below the ${MIN_AUTO_BOOK_RATING} the automation books at. You can still book them.`
            : "No rating yet, so the automation will not pick them on its own. You can still book them.",
    }))
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
    // Pending AND already-active rows. The 'active' half is new: see the
    // reconcile block below.
    const { data: syndicationRecords, error: recordsError } = await supabase
      .from("listing_syndication_tracking")
      .select("*")
      .eq("transaction_id", transactionId)
      .in("syndication_status", ["pending", "active"])

    // supabase-js RESOLVES a refused read — an RLS refusal here would otherwise
    // read as "nothing to syndicate" and report success over work never done.
    if (recordsError) {
      return { success: false, error: `Could not read syndication records: ${recordsError.message}` }
    }
    if (!syndicationRecords || syndicationRecords.length === 0) {
      return { success: true, message: "No pending syndications" }
    }

    // Fetched ONCE. This used to be re-read from the database inside the loop,
    // once per platform, for a value that cannot change between iterations.
    const listing = await getListingDetails(transactionId)

    // ── The withdrawal vocabulary, from the LIVE listings_status_check ────────
    // CHECK admits: draft, listing_signed, coming_soon, active, pending,
    // withdrawn, cancelled, off_market, expired, sold. These five mean the home
    // is no longer being marketed to buyers and must come DOWN off the portals.
    // 'pending' is deliberately NOT here — under contract is a status the portals
    // display, not a reason to delist; pulling it would erase the listing's own
    // "sale pending" signal.
    const OFF_PORTAL_STATUSES = new Set(["withdrawn", "cancelled", "off_market", "expired", "sold"])

    let successCount = 0
    let removedCount = 0
    let updatedCount = 0

    for (const record of syndicationRecords) {
      // ── Already live on the platform: reconcile it ─────────────────────────
      //
      // THE HOLE THIS CLOSES (orphan burn-down, lane E). Nothing in this repo
      // had ever written syndication_status 'removed', even though the live
      // CHECK on listing_syndication_tracking admits it. A listing was pushed to
      // Zillow / realtor.com / Redfin / Trulia once, at 'pending' → 'active',
      // and then NOTHING ever touched it again: sold, withdrawn, expired or
      // repriced, it stayed up on the portal exactly as first published, and the
      // tracking row kept saying 'active' forever. The two functions that fix
      // that — removePlatformListing and updatePlatformListing in
      // lib/platform-sync.ts — existed the whole time with zero callers.
      if (record.syndication_status === "active") {
        if (!record.listing_url) continue // never published anywhere to reconcile against

        if (!listing || OFF_PORTAL_STATUSES.has(String(listing.status ?? ""))) {
          const removal = await removePlatformListing(record.platform_name, record.listing_url)
          if (!removal.success) {
            // Recorded, never swallowed: a failed withdrawal means the home is
            // still advertised to buyers. The row stays 'active' so the next run
            // tries again — marking it 'removed' here would be the exact lie the
            // honesty fix in lib/platform-sync.ts exists to prevent.
            console.warn(`[v0] Failed to withdraw from ${record.platform_name}:`, removal.error)
            continue
          }
          const { error: remErr } = await supabase
            .from("listing_syndication_tracking")
            .update({ syndication_status: "removed", last_synced_at: new Date().toISOString() })
            .eq("id", record.id)
          if (remErr) console.warn(`[v0] Withdrew from ${record.platform_name} but could not record it:`, remErr.message)
          else removedCount++
          continue
        }

        // Still on the market — push changes only when the listing has actually
        // moved since we last synced it, so a re-run does not re-POST unchanged
        // rows to every portal.
        const changedSince =
          !record.last_synced_at ||
          (listing.updated_at && new Date(listing.updated_at) > new Date(record.last_synced_at))
        if (!changedSince) continue

        const update = await updatePlatformListing(record.platform_name, record.listing_url, listing)
        if (!update.success) {
          console.warn(`[v0] Failed to update on ${record.platform_name}:`, update.error)
          continue
        }
        const { error: updErr } = await supabase
          .from("listing_syndication_tracking")
          .update({ last_synced_at: new Date().toISOString() })
          .eq("id", record.id)
        if (updErr) console.warn(`[v0] Updated ${record.platform_name} but could not record it:`, updErr.message)
        else updatedCount++
        continue
      }

      // ── First publish ──────────────────────────────────────────────────────
      const platformResult = await syncToPlatform(record.platform_name, transactionId, listing)

      if (!platformResult.success) {
        console.warn(`[v0] Failed to sync to ${record.platform_name}:`, platformResult.error)
        continue
      }

      // The URL THE PLATFORM RETURNED, never one we compose. This line used to
      // build `https://<platform>.com/listing/<transactionId>` out of thin air
      // — a URL that resolves to nothing on any of these portals, stored as if
      // it were the live listing, and then handed to the withdrawal call above
      // as the thing to delete. syncToPlatform already returns the real
      // `listingUrl`; when it comes back empty we store NULL and say so rather
      // than inventing an address.
      const publishedUrl = platformResult.listingUrl ?? null
      if (!publishedUrl) {
        console.warn(`[v0] ${record.platform_name} accepted the listing but returned no URL — storing none rather than fabricating one`)
      }

      const { error: syncErr } = await supabase
        .from("listing_syndication_tracking")
        .update({
          syndication_status: "active",
          last_synced_at: new Date().toISOString(),
          listing_url: publishedUrl,
        })
        .eq("id", record.id)

      if (syncErr) {
        console.warn(`[v0] Synced to ${record.platform_name} but could not record it:`, syncErr.message)
        continue
      }

      successCount++
    }

    revalidatePath("/dashboard/listings")
    return { success: true, synced: successCount, updated: updatedCount, removed: removedCount }
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

  // This read had NO tenant guard while every sibling in this file had one —
  // any signed-in caller could enumerate another brokerage's syndication rows
  // (and their portal listing URLs) by transaction id. Same gate as the rest.
  const auth = await requireBrokerage()
  if (!auth.ok) return []

  const ownsTx = await verifyTransactionInBrokerage(transactionId, auth.brokerageId)
  if (!ownsTx) return []

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
    // Only `listings` is embedded here, and only because a real FK joins the
    // two. Two other tables were embedded off this same select in the past —
    // listing photos and AI content — and neither has a foreign key to a
    // transaction, so PostgREST rejected the whole select: `transaction` came
    // back null and every call answered "Transaction not found". Photos are read
    // separately below, from the listing they actually hang off. The AI-content
    // rows had no reader at all once fetched, so nothing replaces them.
    const { data: transaction, error: transactionError } = await supabase
      .from("transactions")
      .select("*, listings(*)")
      .eq("id", transactionId)
      .eq("brokerage_id", auth.brokerageId)
      .maybeSingle()

    if (transactionError) {
      console.error("[marketing-package] transaction read failed:", transactionError.message)
      return { success: false, error: transactionError.message }
    }
    if (!transaction || !transaction.listings) {
      return { success: false, error: "Transaction not found" }
    }

    const listing = transaction.listings

    // media_type pinned to 'photo' — the photo count and the average quality
    // score below are advice the agent acts on. Counting floorplans and
    // disclosure PDFs as photos would tell them their gallery is complete when
    // it is not.
    const { data: photoRows, error: photoError } = await supabase
      .from("listing_media")
      .select("id, ai_quality_score")
      .eq("listing_id", listing.id)
      .eq("media_type", "photo")
    if (photoError) {
      console.error("[marketing-package] listing photo read failed:", photoError.message)
      return { success: false, error: photoError.message }
    }
    const photos = photoRows ?? []

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
      brokerageId: auth.brokerageId,
      userId: auth.userId,
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

  // Columns are NAMED, not starred. A starred embed hides which vendor columns
  // the panel reads, so a column that is not on the bench reads as undefined
  // forever instead of failing loudly. `company_name` is aliased onto the real
  // `name` column because that is the key the panel renders
  // (app/dashboard/listings/[id]/marketing-tier/marketing-package-panel.tsx).
  const { data, error } = await supabase
    .from("listing_marketing_services")
    .select(
      "id, package_id, transaction_id, service_type, vendor_id, scheduled_date, status, estimated_cost, actual_cost, completed_at, vendor:vendors(id, company_name:name, email, phone, category, rating, estimated_turnaround_days)",
    )
    .eq("package_id", packageId)
    .order("scheduled_date")

  // A refused read must not read as "this package has no booked services".
  if (error) {
    console.error("getMarketingPackageServices — read refused:", error)
    return []
  }

  return data || []
}

/**
 * CLOSE OUT one booked marketing service — the missing half of the booking above.
 *
 * `bookMarketingService` opened the row at status `scheduled`, and NOTHING in
 * the tree ever closed it. Two consequences, both visible to an agent every day:
 *
 *   · `completed_at` gated the "Remind vendor" button
 *     (marketing-tier/marketing-package-panel.tsx:361 — `!s.completed_at`), so a
 *     finished service kept offering to nudge its vendor about a job already
 *     done, forever.
 *   · `actual_cost` is the MONEY this lane spends, read back by
 *     getMarketingPackageServices (this file) — and written by nobody, so the
 *     per-listing marketing spend was structurally $0/NULL no matter how much
 *     the brokerage actually paid its bench.
 *
 * This is the point in the process where both facts become true: the vendor has
 * delivered and the invoice is known. `actualCost` is optional — a completion
 * with no invoice to hand still closes the row honestly and leaves the money
 * column NULL rather than stamping a guess (the same reasoning that keeps
 * `estimated_cost` NULL at booking time, recorded above).
 *
 * Tenant comes from the SESSION and is applied as a PREDICATE on the update, and
 * the update is COUNTED: an UPDATE that matched no row resolves with error null
 * and data [] (CLAUDE.md §3), which would otherwise report another brokerage's
 * refusal as a successful completion.
 */
export async function completeMarketingService(params: {
  serviceId: string
  actualCost?: number | null
}): Promise<{ success: boolean; error?: string; completedAt?: string }> {
  if (!isValidUUID(params.serviceId)) return { success: false, error: "Invalid service ID" }

  const auth = await requireBrokerage()
  if (!auth.ok) return { success: false, error: auth.error }

  const completedAt = new Date().toISOString()
  const patch: Record<string, unknown> = {
    status: "completed",
    completed_at: completedAt,
    updated_at: completedAt,
  }
  if (params.actualCost !== undefined && params.actualCost !== null) {
    const paid = Number(params.actualCost)
    if (!Number.isFinite(paid) || paid < 0) {
      return { success: false, error: "Actual cost must be a non-negative number." }
    }
    patch.actual_cost = paid
  }

  const svc = createServiceClient()
  const { data, error } = await svc
    .from("listing_marketing_services")
    .update(patch)
    .eq("id", params.serviceId)
    .eq("brokerage_id", auth.brokerageId)
    .select("id")

  if (error) return { success: false, error: error.message }
  if ((data ?? []).length === 0) {
    return { success: false, error: "That service is not in your brokerage." }
  }

  revalidatePath("/dashboard/listings")
  return { success: true, completedAt }
}

/**
 * Nudge a booked service's vendor about its upcoming date. Delegates to the
 * canonical reminder (lib/communications/vendor-communications:
 * sendVendorServiceReminder — real dispatchEmail + vendor_communications
 * delivery ledger, tenant read from the service row itself). This wrapper only
 * verifies the caller may act on the service and derives daysUntilDue from the
 * stored scheduled_date — never from the client.
 */
export async function sendServiceReminderToVendor(params: { serviceId: string }) {
  if (!isValidUUID(params.serviceId)) return { success: false as const, error: "Invalid service ID" }
  const auth = await requireBrokerage()
  if (!auth.ok) return { success: false as const, error: auth.error }

  const svc = createServiceClient()
  const { data: service, error: readError } = await svc
    .from("listing_marketing_services")
    .select("id, vendor_id, scheduled_date, brokerage_id")
    .eq("id", params.serviceId)
    .eq("brokerage_id", auth.brokerageId)
    .maybeSingle()
  if (readError) return { success: false as const, error: readError.message }
  if (!service?.vendor_id) return { success: false as const, error: "No vendor booked on this service" }
  if (!service.scheduled_date) return { success: false as const, error: "This service has no scheduled date to remind about" }

  const daysUntilDue = Math.max(
    0,
    Math.ceil((new Date(service.scheduled_date as string).getTime() - Date.now()) / 86_400_000),
  )
  const { sendVendorServiceReminder } = await import("@/lib/communications/vendor-communications")
  return sendVendorServiceReminder({
    vendorId: service.vendor_id as string,
    serviceId: params.serviceId,
    daysUntilDue,
  })
}
