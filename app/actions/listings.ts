"use server"

import { revalidatePath } from "next/cache"
import { getListingsService, createListingService } from "@/lib/application/listings"

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

export async function getListingById(listingId: string) {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("listings")
      .select("*, seller:seller_id(*), agent:agent_id(*)")
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
  const result = await createListingService(params)
  if (result.success) {
    revalidatePath("/listings")
    revalidatePath("/dashboard")
  }
  return result
}

export async function updateListing(listingId: string, updates: any) {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("listings")
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq("id", listingId)
      .select()
      .single()

    if (error) throw error

    revalidatePath("/listings")
    revalidatePath(`/listings/${listingId}`)

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
