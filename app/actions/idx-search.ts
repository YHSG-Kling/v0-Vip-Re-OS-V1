"use server"

import { createClient } from "@/lib/supabase/server"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { revalidatePath } from "next/cache"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

const IDX_API_BASE = process.env.IDXBROKER_API_URL || "https://api.idxbroker.com"
const IDX_API_KEY = process.env.IDXBROKER_API_KEY

interface PropertyFilters {
  minPrice?: number
  maxPrice?: number
  beds?: number
  baths?: number
  sqft?: number
  propertyType?: string[]
  city?: string
  zip?: string
  mlsStatus?: string[]
  keywords?: string
}

// Standard property search via IDX API
export async function searchProperties(filters: PropertyFilters) {
  try {
    if (!IDX_API_BASE || !IDX_API_KEY) {
      console.warn("[Production] IDX API not configured. Set IDX_API_BASE and IDX_API_KEY environment variables.")
      return {
        success: false,
        error: "IDX API not configured. Please set IDX_API_BASE and IDX_API_KEY environment variables.",
        properties: [],
        requiresConfiguration: true,
      }
    }

    const response = await callConnector<{ results?: any[] }>({
      connector: "idxbroker", baseUrl: IDX_API_BASE, path: "/search", method: "POST",
      auth: { style: "bearer", token: IDX_API_KEY! },
      body: { ...filters, limit: 50 },
    })

    if (!response.ok) {
      throw new Error(`IDX API error: ${response.error ?? response.status}`)
    }

    return { success: true, properties: response.data?.results || [] }
  } catch (error: any) {
    console.error("IDX Search error:", error)
    return { success: false, error: error.message, properties: [] }
  }
}

// AI-Powered Smart Search
export async function smartSearch(data: {
  naturalLanguageQuery: string
  contactId: string
}) {
  try {
    const supabase = await createClient()

    // Get contact details
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", data.contactId)
      .single()

    if (contactError) throw contactError

    // Get contact's search history
    const { data: searchHistory } = await supabase
      .from("property_search_log")
      .select("*")
      .eq("contact_id", data.contactId)
      .order("created_at", { ascending: false })
      .limit(10)

    const interpretPrompt = `Convert this natural language property search into structured filters:

Query: "${data.naturalLanguageQuery}"

Buyer context:
- Persona: ${contact.persona || "not specified"}
- Budget: ${contact.budget || "not specified"}
- Timeline: ${contact.timeline || "not specified"}
- Previous searches: ${searchHistory?.map((s) => JSON.stringify(s.extracted_filters)).join(", ") || "none"}

Extract:
- Price range (min/max in dollars)
- Beds (minimum number)
- Baths (minimum number)
- Property types (array: single_family, condo, townhouse, multi_family)
- Location (city, zip, neighborhood)
- Special requirements (pool, garage, schools, etc.)
- Keywords for description search
- Intent level: "serious" | "browsing" | "researching"

Output ONLY valid JSON with this exact structure:
{
  "minPrice": number or null,
  "maxPrice": number or null,
  "beds": number or null,
  "baths": number or null,
  "propertyType": ["single_family"] or null,
  "city": "string" or null,
  "keywords": "string" or null,
  "intent": "serious"
}`

    const interpretation = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: interpretPrompt,
    })

    let filters: PropertyFilters & { intent?: string }
    try {
      filters = JSON.parse(interpretation.text)
    } catch (parseError) {
      // Fallback to basic filter extraction
      filters = {
        keywords: data.naturalLanguageQuery,
        intent: "browsing",
      }
    }

    // Search using extracted filters
    const searchResult = await searchProperties(filters)

    await supabase.from("property_search_log").insert({
      contact_id: data.contactId,
      query_text: data.naturalLanguageQuery,
      extracted_filters: filters,
      result_count: searchResult.properties?.length || 0,
      metadata: { intent: filters.intent || "browsing" },
    })

    return {
      success: true,
      properties: searchResult.properties,
      filters: filters,
      interpretation: `I found ${searchResult.properties?.length || 0} properties matching: ${data.naturalLanguageQuery}`,
      isMockData: (searchResult as any)?.isMockData,
    }
  } catch (error: any) {
    console.error("Smart Search error:", error)
    return { success: false, error: error.message, properties: [] }
  }
}

// Save property to favorites — supports brokerage listings AND external
// (Rentcast / IDX / MLS-lookup) properties. Source is recorded so downstream
// surfaces (alerts, tour planner) can route correctly.
export async function saveProperty(data: {
  contactId: string
  mlsNumber?: string
  /** When the property is an in-house brokerage listing, pass its UUID. */
  listingId?: string
  /** Where this property came from. Defaults to 'idx' since this action
   *  lives in idx-search; pass 'rentcast' / 'mls' / 'manual' as appropriate. */
  source?: 'brokerage_listing' | 'rentcast' | 'idx' | 'mls' | 'manual'
  /** Provider-side ID (Rentcast property id, IDX listing id, etc.) */
  externalPropertyId?: string
  propertyData: {
    address?: string
    price?: number
    bedrooms?: number
    bathrooms?: number
    sqft?: number
    propertyType?: string
    primaryPhotoUrl?: string
    url?: string
    city?: string
    state?: string
    brokerageId?: string
  }
}) {
  try {
    const supabase = await createClient()

    // Dedup — same contact already saved this property?
    const dedupQuery = supabase
      .from("saved_properties")
      .select("id")
      .eq("contact_id", data.contactId)
    const { data: existing } = data.listingId
      ? await dedupQuery.eq("listing_id", data.listingId).maybeSingle()
      : data.mlsNumber
        ? await dedupQuery.eq("mls_number", data.mlsNumber).maybeSingle()
        : { data: null }

    if (existing) {
      return { success: true, message: "Property already saved", alreadySaved: true }
    }

    const resolvedSource =
      data.source ?? (data.listingId ? "brokerage_listing" : "idx")

    // Resolve user_id (text column, NOT NULL on the table). For portal saves
    // the contact may not have a linked auth user — use contact_id as a
    // stable fallback identifier so the row can be inserted.
    const { data: contactRow } = await supabase
      .from("contacts")
      .select("user_id, brokerage_id")
      .eq("id", data.contactId)
      .maybeSingle()
    const userIdValue = contactRow?.user_id ?? data.contactId

    const { error: insertErr } = await supabase.from("saved_properties").insert({
      contact_id:           data.contactId,
      user_id:              userIdValue,
      brokerage_id:         contactRow?.brokerage_id ?? data.propertyData.brokerageId ?? null,
      listing_id:           data.listingId ?? null,
      mls_number:           data.mlsNumber ?? null,
      external_property_id: data.externalPropertyId ?? null,
      source:               resolvedSource,
      property_address:     data.propertyData.address ?? null,
      list_price:           data.propertyData.price ?? null,
      bedrooms:             data.propertyData.bedrooms ?? null,
      bathrooms:            data.propertyData.bathrooms ?? null,
      sqft:                 data.propertyData.sqft ?? null,
      property_type:        data.propertyData.propertyType ?? null,
      primary_photo_url:    data.propertyData.primaryPhotoUrl ?? null,
      listing_url:          data.propertyData.url ?? null,
      city:                 data.propertyData.city ?? null,
      state:                data.propertyData.state ?? null,
      saved_at:             new Date().toISOString(),
      dismissed:            false,
    })

    if (insertErr) {
      return { success: false, error: insertErr.message }
    }

    revalidatePath("/properties/saved")
    return { success: true, message: "Property saved successfully" }
  } catch (error: any) {
    console.error("Save property error:", error)
    return { success: false, error: error.message }
  }
}

// Remove saved property
export async function unsaveProperty(data: {
  contactId: string
  mlsNumber: string
}) {
  try {
    const supabase = await createClient()

    await supabase.from("saved_properties").delete().eq("contact_id", data.contactId).eq("mls_number", data.mlsNumber)

    revalidatePath("/properties/saved")
    return { success: true, message: "Property removed from saved" }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

// Track property view for engagement scoring
export async function trackPropertyView(data: {
  contactId: string
  mlsNumber: string
  timeSpent: number
}) {
  try {
    const supabase = await createClient()

    await supabase.from("property_views").insert({
      contact_id: data.contactId,
      mls_number: data.mlsNumber,
      time_spent_seconds: data.timeSpent,
    })

    if (data.timeSpent > 120) {
      const { data: contact } = await supabase.from("contacts").select("intent_score").eq("id", data.contactId).single()

      const newScore = Math.min((contact?.intent_score || 0) + 5, 100)

      await supabase.from("contacts").update({ intent_score: newScore }).eq("id", data.contactId)
    }

    return { success: true }
  } catch (error: any) {
    console.error("Track view error:", error)
    return { success: false, error: error.message }
  }
}

// Get saved properties for a contact
export async function getSavedProperties(contactId: string) {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("saved_properties")
      .select("*")
      .eq("contact_id", contactId)
      .order("saved_at", { ascending: false })

    if (error) throw error

    return { success: true, properties: data || [] }
  } catch (error: any) {
    return { success: false, error: error.message, properties: [] }
  }
}

// IDX API must be configured for property search
// Set IDX_API_BASE and IDX_API_KEY environment variables to enable
