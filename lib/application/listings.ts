/**
 * lib/application/listings.ts
 * Listing CRUD — canonical lib-layer home.
 * app/actions/listings.ts re-exports from here and adds "use server" + revalidatePath.
 */

import { createClient } from "@/lib/supabase/server"
import { handleError } from "@/lib/errors"

export async function getListingsService(params?: {
  agentId?: string
  /** Tenant anchor. app/actions/listings.ts:getListings resolves this from the
   *  SESSION and always supplies it; it exists as a parameter only because this
   *  layer takes no session of its own. */
  brokerageId?: string
  status?: string
  stage?: string
  limit?: number
}) {
  try {
    const supabase = await createClient()

    let query = supabase
      .from("listings")
      // seller_contact_id is the live FK to contacts (not seller_id). `contacts`
      // genuinely HAS first_name/last_name, so that half was always fine.
      //
      // `agents` does NOT: it has no first_name / last_name (verified against
      // information_schema). A person's name lives on `users`, reached through
      // agents_user_id_fkey — the only FK from agents to users, so an OBJECT
      // embed. Naming them on `agents` made PostgREST reject the ENTIRE query,
      // so getListingsService returned an error for every listing read.
      .select(
        `*,
         seller:seller_contact_id(first_name, last_name),
         agent:agent_id(id, users:user_id(first_name, last_name))`,
      )
      .order("created_at", { ascending: false })

    if (params?.brokerageId) query = query.eq("brokerage_id", params.brokerageId)
    if (params?.agentId) query = query.eq("agent_id", params.agentId)
    if (params?.status) query = query.eq("status", params.status)
    if (params?.stage) query = query.eq("lifecycle_stage", params.stage)
    if (params?.limit) query = query.limit(params.limit)

    const { data, error } = await query
    if (error) throw error

    // Flattened to the {first_name, last_name} shape every agent-name reader in
    // the app already consumes, so no caller changes.
    const listings = (data ?? []).map((l: any) => {
      const a = l?.agent ?? null
      const u = a?.users ?? null
      return {
        ...l,
        agent: a
          ? { id: a.id, first_name: u?.first_name ?? null, last_name: u?.last_name ?? null }
          : null,
      }
    })

    return { success: true, listings }
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
        lifecycle_stage:    "LISTING_AGREEMENT_INITIATED",
        // DRAFT, not active — same rule as the kernel's createListingRecord, which
        // carries the full note. A listing is only taken on once the agreement is
        // SIGNED and compliance has cleared every required document, initial and
        // signature; the compliance-listing-auto-create chain does the promotion.
        // Opening this row `active` published an unsigned listing to buyer search.
        status:             "draft",
      })
      .select()
      .single()

    if (error) throw error
    return { success: true, listing: data }
  } catch (error) {
    return handleError(error, "createListingService")
  }
}
