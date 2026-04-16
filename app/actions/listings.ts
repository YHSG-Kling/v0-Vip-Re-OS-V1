"use server"

import { revalidatePath } from "next/cache"
import { getListingsService, createListingService } from "@/lib/application/listings"
import { createClient } from "@/lib/supabase/server"
import { handleError } from "@/lib/errors"
import { assignTierToListing } from "@/lib/listings/tier-assigner"

/**
 * CRUD operations for listings
 * Re-exported through index.ts
 */

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

    const supabase = await createClient()

    const { data, error } = await supabase
      .from("listings")
      .select("*, seller_contact:seller_contact_id(id, first_name, last_name, email, phone), agent:agents!listings_agent_id_fkey(id, user_id)")
      .eq("id", listingId)
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

export async function updateListing(listingId: string, updates: any, actorUserId?: string) {
  try {
    const supabase = await createClient()

    // Check if price is being updated (for tier assignment)
    const priceUpdated = updates.list_price !== undefined || updates.price !== undefined

    // Get current listing to check brokerage and current price
    let brokerageId: string | null = null
    let currentPrice: number | null = null

    if (priceUpdated && actorUserId) {
      const { data: currentListing } = await supabase
        .from("listings")
        .select("brokerage_id, list_price")
        .eq("id", listingId)
        .single()

      if (currentListing) {
        brokerageId = currentListing.brokerage_id
        currentPrice = currentListing.list_price
      }
    }

    const { data, error } = await supabase
      .from("listings")
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq("id", listingId)
      .select()
      .single()

    if (error) throw error

    // Trigger tier assignment ONLY when price changes
    const newPrice = updates.list_price ?? updates.price
    if (priceUpdated && actorUserId && brokerageId && newPrice !== currentPrice) {
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
    const supabase = await createClient()

    const { error } = await supabase.from("listings").delete().eq("id", listingId)

    if (error) throw error

    revalidatePath("/listings")
    revalidatePath("/dashboard")

    return { success: true }
  } catch (error) {
    return handleError(error, "deleteListing")
  }
}

export async function updateListingStatus(listingId: string, status: string) {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("listings")
      .update({ 
        status,
        current_stage: status === "sold" ? "closed" : status === "withdrawn" ? "cancelled" : undefined,
        updated_at: new Date().toISOString() 
      })
      .eq("id", listingId)
      .select()
      .single()

    if (error) throw error

    revalidatePath("/listings")
    revalidatePath(`/listings/${listingId}`)

    return { success: true, listing: data }
  } catch (error) {
    return handleError(error, "updateListingStatus")
  }
}

export async function getSellerReports(listingId: string) {
  try {
    const supabase = await createClient()

    // Get weekly activity reports for seller
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
    const supabase = await createClient()

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
