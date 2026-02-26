/**
 * lib/application/listings.ts
 * Listing CRUD — canonical lib-layer home.
 * app/actions/listings.ts re-exports from here and adds "use server" + revalidatePath.
 */

import { createClient } from "@/lib/supabase/server"
import { handleError } from "@/lib/errors"

export async function getListingsService(params?: {
  agentId?: string
  status?: string
  stage?: string
  limit?: number
}) {
  try {
    const supabase = await createClient()

    let query = supabase
      .from("listings")
      .select("*, seller:seller_id(first_name, last_name), agent:agent_id(first_name, last_name)")
      .order("created_at", { ascending: false })

    if (params?.agentId) query = query.eq("agent_id", params.agentId)
    if (params?.status) query = query.eq("status", params.status)
    if (params?.stage) query = query.eq("current_stage", params.stage)
    if (params?.limit) query = query.limit(params.limit)

    const { data, error } = await query
    if (error) throw error
    return { success: true, listings: data || [] }
  } catch (error) {
    return handleError(error, "getListingsService")
  }
}

export async function createListingService(params: {
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
  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("listings")
      .insert({
        agent_id: params.agentId,
        seller_id: params.sellerId,
        address: params.address,
        city: params.city,
        state: params.state,
        zip: params.zip,
        price: params.price,
        bedrooms: params.bedrooms,
        bathrooms: params.bathrooms,
        square_footage: params.squareFootage,
        property_type: params.propertyType || "residential",
        listing_type: params.listingType || "sale",
        current_stage: "lead",
        status: "active",
      })
      .select()
      .single()

    if (error) throw error
    return { success: true, listing: data }
  } catch (error) {
    return handleError(error, "createListingService")
  }
}
