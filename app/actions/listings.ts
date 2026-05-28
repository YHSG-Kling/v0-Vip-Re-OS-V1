"use server"

import { revalidatePath } from "next/cache"
import { getListingsService, createListingService } from "@/lib/application/listings"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { handleError } from "@/lib/errors"
import { assignTierToListing } from "@/lib/listings/tier-assigner"

/**
 * CRUD operations for listings
 * Re-exported through index.ts
 *
 * Every read + write previously skipped the auth.getUser() check. Reads
 * leaned on RLS policies (which work for authed users but tell anonymous
 * callers that listings exist by responding with empty arrays vs. errors),
 * but every write (update/delete) ran without verifying the caller had
 * any relationship to the listing's brokerage. updateListing also accepted
 * an actorUserId param which was used for tier-assignment audit — caller
 * could spoof anyone.
 */

async function requireCaller(): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const { data: u } = await supabase
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: "Unauthorized" }
  return { ok: true, userId: user.id, brokerageId: u.brokerage_id }
}

export async function getListings(params?: {
  agentId?: string
  status?: string
  stage?: string
  limit?: number
}) {
  return getListingsService(params)
}

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function getListingById(listingId: string) {
  try {
    // Validate listingId is a proper UUID (not "new" or other invalid values)
    if (!listingId || !UUID_REGEX.test(listingId)) {
      return { success: false, error: "Invalid listing ID" }
    }

    const auth = await requireCaller()
    if (!auth.ok) return { success: false, error: auth.error }

    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from("listings")
      .select("*, seller_contact:seller_contact_id(id, first_name, last_name, email, phone), agent:agents!listings_agent_id_fkey(id, user_id)")
      .eq("id", listingId)
      .eq("brokerage_id", auth.brokerageId)
      .single()

    if (error) throw error

    return { success: true, listing: data }
  } catch (error) {
    return handleError(error, "getListingById")
  }
}

export async function createListing(params: {
  agentId: string
  sellerId: string
  address: string
  city: string
  state: string
  zip: string
  price?: number
  bedrooms?: number
  bathrooms?: number
  squareFootage?: number
  propertyType?: string
  listingType?: string
}) {
  const result = await createListingService({
    agentId: params.agentId,
    sellerContactId: params.sellerId,
    address: params.address,
    city: params.city,
    state: params.state,
    zip: params.zip,
    listPrice: params.price,
    bedrooms: params.bedrooms,
    bathrooms: params.bathrooms,
    sqft: params.squareFootage,
    propertyType: params.propertyType,
  })
  if (result.success) {
    revalidatePath("/listings")
    revalidatePath("/dashboard")
  }
  return result
}

export async function updateListing(listingId: string, updates: any, _actorUserId?: string) {
  try {
    if (!UUID_REGEX.test(listingId)) return { success: false, error: "Invalid listing ID" }

    const auth = await requireCaller()
    if (!auth.ok) return { success: false, error: auth.error }
    const actorUserId = auth.userId

    const supabase = createServiceClient()

    // Load current listing to verify ownership + capture pre-update price
    const { data: currentListing } = await supabase
      .from("listings")
      .select("brokerage_id, list_price")
      .eq("id", listingId)
      .maybeSingle()
    if (!currentListing) return { success: false, error: "Listing not found" }
    if (currentListing.brokerage_id !== auth.brokerageId) {
      return { success: false, error: "Forbidden" }
    }
    const brokerageId = currentListing.brokerage_id as string
    const currentPrice = currentListing.list_price as number | null

    const priceUpdated = updates.list_price !== undefined || updates.price !== undefined

    // Never let caller-supplied updates change tenant ownership
    const safeUpdates = { ...updates }
    delete safeUpdates.brokerage_id
    delete safeUpdates.id

    const { data, error } = await supabase
      .from("listings")
      .update({ ...safeUpdates, updated_at: new Date().toISOString() })
      .eq("id", listingId)
      .eq("brokerage_id", brokerageId)
      .select()
      .single()

    if (error) throw error

    // Trigger tier assignment ONLY when price changes
    const newPrice = updates.list_price ?? updates.price
    if (priceUpdated && newPrice !== currentPrice) {
      await assignTierToListing(listingId, brokerageId, actorUserId).catch((err) => {
        console.error("[updateListing] Tier assignment failed (non-blocking):", err)
      })
    }

    revalidatePath("/listings")
    revalidatePath(`/listings/${listingId}`)
    revalidatePath(`/dashboard/listings/${listingId}/marketing-tier`)

    return { success: true, listing: data }
  } catch (error) {
    return handleError(error, "updateListing")
  }
}

export async function deleteListing(listingId: string) {
  try {
    if (!UUID_REGEX.test(listingId)) return { success: false, error: "Invalid listing ID" }

    const auth = await requireCaller()
    if (!auth.ok) return { success: false, error: auth.error }

    const supabase = createServiceClient()

    const { error } = await supabase
      .from("listings")
      .delete()
      .eq("id", listingId)
      .eq("brokerage_id", auth.brokerageId)

    if (error) throw error

    revalidatePath("/listings")
    revalidatePath("/dashboard")

    return { success: true }
  } catch (error) {
    return handleError(error, "deleteListing")
  }
}

// updateListingStatus was migrated to app/actions/listings-kernel.ts
// Import it from there: import { updateListingStatus } from "@/app/actions/listings-kernel"

export async function getSellerReports(listingId: string) {
  try {
    if (!UUID_REGEX.test(listingId)) return { success: false, error: "Invalid listing ID" }

    const auth = await requireCaller()
    if (!auth.ok) return { success: false, error: auth.error }

    const supabase = createServiceClient()

    // Verify the listing is in caller's brokerage before reading reports
    const { data: listing } = await supabase
      .from("listings").select("brokerage_id").eq("id", listingId).maybeSingle()
    if (!listing || listing.brokerage_id !== auth.brokerageId) {
      return { success: false, error: "Forbidden" }
    }

    const { data: reports, error } = await supabase
      .from("seller_weekly_reports")
      .select("*")
      .eq("listing_id", listingId)
      .order("report_week_start", { ascending: false })

    if (error) throw error

    return { success: true, reports: reports || [] }
  } catch (error) {
    return handleError(error, "getSellerReports")
  }
}

export async function getListingTimeline(listingId: string) {
  try {
    if (!UUID_REGEX.test(listingId)) return { success: false, error: "Invalid listing ID" }

    const auth = await requireCaller()
    if (!auth.ok) return { success: false, error: auth.error }

    const supabase = createServiceClient()

    // Verify the listing is in caller's brokerage
    const { data: listing } = await supabase
      .from("listings").select("brokerage_id").eq("id", listingId).maybeSingle()
    if (!listing || listing.brokerage_id !== auth.brokerageId) {
      return { success: false, error: "Forbidden" }
    }

    const { data: history, error } = await supabase
      .from("listing_stage_history")
      .select("*, completed_by:profiles(first_name, last_name)")
      .eq("listing_id", listingId)
      .order("entered_at", { ascending: true })

    if (error) throw error

    return { success: true, timeline: history || [] }
  } catch (error) {
    return handleError(error, "getListingTimeline")
  }
}
