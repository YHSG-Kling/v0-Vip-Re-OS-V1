"use server"

import { createClient } from "@/lib/supabase/server"
import { generateText } from "ai"
import { revalidatePath } from "next/cache"

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

    const response = await fetch(`${IDX_API_BASE}/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${IDX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...filters,
        limit: 50,
      }),
    })

    if (!response.ok) {
      throw new Error(`IDX API error: ${response.statusText}`)
    }

    const data = await response.json()
    return { success: true, properties: data.results || [] }
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
      natural_query: data.naturalLanguageQuery,
      extracted_filters: filters,
      results_count: searchResult.properties?.length || 0,
      intent: filters.intent || "browsing",
    })

    return {
      success: true,
      properties: searchResult.properties,
      filters: filters,
      interpretation: `I found ${searchResult.properties?.length || 0} properties matching: ${data.naturalLanguageQuery}`,
      isMockData: searchResult.isMockData,
    }
  } catch (error: any) {
    console.error("Smart Search error:", error)
    return { success: false, error: error.message, properties: [] }
  }
}

// Save property to favorites
export async function saveProperty(data: {
  contactId: string
  mlsNumber: string
  propertyData: any
}) {
  try {
    const supabase = await createClient()

    const { data: existing } = await supabase
      .from("saved_properties")
      .select("id")
      .eq("contact_id", data.contactId)
      .eq("mls_number", data.mlsNumber)
      .single()

    if (existing) {
      return { success: true, message: "Property already saved", alreadySaved: true }
    }

    await supabase.from("saved_properties").insert({
      contact_id: data.contactId,
      mls_number: data.mlsNumber,
      property_address: data.propertyData.address,
      list_price: data.propertyData.price,
      beds: data.propertyData.beds,
      baths: data.propertyData.baths,
      sqft: data.propertyData.sqft,
      property_type: data.propertyData.propertyType,
      listing_photos: data.propertyData.photos,
      listing_url: data.propertyData.url,
    })

    await supabase.from("events").insert({
      event_type: "property_saved",
      brokerage_id: data.propertyData.brokerageId,
      user_id: data.contactId,
      payload: { mls_number: data.mlsNumber },
      source: "ui",
    })

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
      .order("created_at", { ascending: false })

    if (error) throw error

    return { success: true, properties: data || [] }
  } catch (error: any) {
    return { success: false, error: error.message, properties: [] }
  }
}

// IDX API must be configured for property search
// Set IDX_API_BASE and IDX_API_KEY environment variables to enable
