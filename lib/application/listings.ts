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
      // seller_contact_id is the live FK to contacts (not seller_id)
      .select("*, seller:seller_contact_id(first_name, last_name), agent:agent_id(first_name, last_name)")
      .order("created_at", { ascending: false })

    if (params?.agentId) query = query.eq("agent_id", params.agentId)
    if (params?.status) query = query.eq("status", params.status)
    if (params?.stage) query = query.eq("lifecycle_stage", params.stage)
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
  /** FK to contacts.id — live schema column is seller_contact_id */
  sellerContactId: string
  brokerageId?: string
  address: string
  city: string
  state: string
  zip: string
  listPrice?: number
  bedrooms?: number
  bathrooms?: number
  sqft?: number
  propertyType?: string
}) {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("listings")
      .insert({
        agent_id:           params.agentId,
        seller_contact_id:  params.sellerContactId,   // correct FK column
        brokerage_id:       params.brokerageId,
        address:            params.address,
        city:               params.city,
        state:              params.state,
        zip:                params.zip,               // correct column (not zip_code)
        list_price:         params.listPrice,         // correct column (not price)
        bedrooms:           params.bedrooms,
        bathrooms:          params.bathrooms,
        sqft:               params.sqft,              // correct column (not square_footage)
        property_type:      params.propertyType || "residential",
        current_stage:      "LEAD",
        lifecycle_stage:    "LEAD",
        status:             "active",
      })
      .select()
      .single()

    if (error) throw error
    return { success: true, listing: data }
  } catch (error) {
    return handleError(error, "createListingService")
  }
}
