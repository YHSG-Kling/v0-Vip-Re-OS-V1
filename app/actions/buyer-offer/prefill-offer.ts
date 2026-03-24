"use server"

/**
 * System 7.1A - Buyer Offer Execution Engine
 * Domain 3: AI Prefill
 * 
 * AI-prefills offer data from buyer profile, property, and market data
 */

import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { generateTextRouted as generateText } from "@/lib/ai/models"

// ─── Property Data AI Fill ────────────────────────────────────────────────────

export interface PropertyFillData {
  property_address: string
  property_city: string
  property_state: string
  property_zip: string
  bedrooms: number | null
  bathrooms: number | null
  sqft: number | null
  year_built: number | null
  property_type: string
  property_address_ai_filled: true
  ai_confidence: "high" | "medium" | "low"
}

/**
 * When an offer form lacks property data, attempt to fill it from:
 *  1. The linked listing record (if listingId is provided)
 *  2. The buyer's property_interests / saved searches
 *  3. AI reasoning from any address fragment provided
 * Sets property_address_ai_filled = true so the UI can show a disclosure badge.
 */
export async function fillPropertyDataWithAI(params: {
  listingId?: string | null
  buyerId?: string | null
  addressFragment?: string | null
}): Promise<PropertyFillData | null> {
  const supabase = createServiceClient()

  // ── 1. Try the listing record first ────────────────────────────────────────
  if (params.listingId && isValidUUID(params.listingId)) {
    const { data: listing } = await supabase
      .from("listings")
      .select("address, city, state, zip, bedrooms, bathrooms, sqft")
      .eq("id", params.listingId)
      .single()

    if (listing?.address) {
      return {
        property_address:        listing.address,
        property_city:           listing.city ?? "",
        property_state:          listing.state ?? "",
        property_zip:            listing.zip ?? "",
        bedrooms:                listing.bedrooms ?? null,
        bathrooms:               listing.bathrooms ?? null,
        sqft:                    listing.sqft ?? null,
        year_built:              null,
        property_type:           "Single Family",
        property_address_ai_filled: true,
        ai_confidence:           "high",
      }
    }
  }

  // ── 2. Pull buyer's property interests for context ─────────────────────────
  let buyerContext = ""
  if (params.buyerId && isValidUUID(params.buyerId)) {
    const { data: interests } = await supabase
      .from("property_interests")
      .select("preferred_locations, zip_codes, property_type, bedrooms, bathrooms, min_price, max_price")
      .eq("contact_id", params.buyerId)
      .limit(1)
      .maybeSingle()

    if (interests) {
      buyerContext = `
Buyer preferences:
- Preferred locations: ${(interests.preferred_locations ?? []).join(", ") || "not specified"}
- Zip codes: ${(interests.zip_codes ?? []).join(", ") || "not specified"}
- Property type: ${interests.property_type ?? "not specified"}
- Bedrooms: ${interests.bedrooms ?? "not specified"}
- Bathrooms: ${interests.bathrooms ?? "not specified"}
- Price range: $${interests.min_price?.toLocaleString() ?? "?"} – $${interests.max_price?.toLocaleString() ?? "?"}`
    }
  }

  // ── 3. Ask AI to fill in property details ──────────────────────────────────
  const addressHint = params.addressFragment?.trim()
  if (!addressHint && !buyerContext) return null

  try {
    const { text } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `You are a real estate data assistant helping fill in missing property information for an offer form.

${addressHint ? `Address fragment provided: "${addressHint}"` : "No specific address provided."}
${buyerContext || ""}

Based on the above context, provide your best estimate of the property details. Return ONLY valid JSON — no markdown, no explanation.

{
  "property_address": string (full street address, or best guess),
  "property_city": string,
  "property_state": string (2-letter code),
  "property_zip": string,
  "bedrooms": number | null,
  "bathrooms": number | null,
  "sqft": number | null,
  "year_built": number | null,
  "property_type": "Single Family" | "Condo" | "Townhome" | "Multi-Family" | "Land" | "Commercial",
  "ai_confidence": "high" | "medium" | "low"
}`,
    })

    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null

    const parsed = JSON.parse(jsonMatch[0])

    return {
      property_address:            parsed.property_address ?? addressHint ?? "",
      property_city:               parsed.property_city ?? "",
      property_state:              parsed.property_state ?? "",
      property_zip:                parsed.property_zip ?? "",
      bedrooms:                    parsed.bedrooms ?? null,
      bathrooms:                   parsed.bathrooms ?? null,
      sqft:                        parsed.sqft ?? null,
      year_built:                  parsed.year_built ?? null,
      property_type:               parsed.property_type ?? "Single Family",
      property_address_ai_filled:  true,
      ai_confidence:               parsed.ai_confidence ?? "low",
    }
  } catch (err) {
    console.error("[buyer-offer] fillPropertyDataWithAI error:", err)
    return null
  }
}

export interface PrefillOfferParams {
  offerId: string
  buyerId: string
  propertyAddress: string
  propertyMlsId?: string
  userId: string
}

export interface PrefillOfferResult {
  success: boolean
  prefillData?: OfferPrefillData
  error?: string
}

export interface OfferPrefillData {
  offerPrice?: number
  earnestMoney?: number
  earnestMoneyPercent?: number
  closingDays?: number
  contingencies: string[]
  financingType?: string
  downPaymentPercent?: number
  template: string
  confidence: number
}

/**
 * AI prefill offer data
 */
export async function prefillOfferWithAI(
  params: PrefillOfferParams
): Promise<PrefillOfferResult> {
  const { offerId, buyerId, propertyAddress, propertyMlsId, userId } = params

  if (!isValidUUID(buyerId)) {
    return { success: false, error: "Invalid buyer ID" }
  }

  const supabase = createServiceClient()

  // Get buyer profile
  const { data: buyer } = await supabase
    .from("contacts")
    .select("name, notes, metadata")
    .eq("id", buyerId)
    .single()

  if (!buyer) {
    return { success: false, error: "Buyer not found" }
  }

  // Get financial verification details
  const { data: financialEvents } = await supabase
    .from("activities")
    .select("type, metadata, created_at")
    .eq("entity_type", "contact")
    .eq("entity_id", buyerId)
    .in("type", [
      "buyer.pre_approval.uploaded",
      "buyer.proof_of_funds.uploaded",
      "buyer.lender.introduced",
    ])
    .order("created_at", { ascending: false })
    .limit(1)

  // Get buyer search preferences
  const { data: searchConfig } = await supabase
    .from("activities")
    .select("metadata")
    .eq("entity_type", "contact")
    .eq("entity_id", buyerId)
    .eq("type", "buyer.search.configured")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  // Determine property type and template
  const propertyType = determinePropertyType(propertyAddress)
  const template = getOfferTemplate(propertyType)

  // Build AI context
  const context = {
    buyer: {
      name: buyer.name,
      notes: buyer.notes,
      metadata: buyer.metadata,
    },
    financial: financialEvents?.[0]?.metadata || {},
    searchPreferences: searchConfig?.metadata || {},
    property: {
      address: propertyAddress,
      mlsId: propertyMlsId,
      type: propertyType,
    },
    template,
  }

  // Generate AI prefill
  try {
    const prompt = buildPrefillPrompt(context)

    const { text } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt,
    })

    const prefillData = parsePrefillResponse(text, template)

    // Emit prefill event
    await supabase.from("activities").insert({
      type: "buyer.offer.forms.prefilled",
      entity_type: "contact",
      entity_id: buyerId,
      user_id: userId,
      metadata: {
        offer_id: offerId,
        prefill_source: "ai",
        confidence_score: prefillData.confidence,
        template_used: template,
        prefill_data: prefillData,
      },
    })

    return {
      success: true,
      prefillData,
    }
  } catch (error: any) {
    console.error("[buyer-offer] AI prefill error:", error)
    return {
      success: false,
      error: error.message,
    }
  }
}

function determinePropertyType(address: string): string {
  // Simple heuristic - can be enhanced
  if (address.toLowerCase().includes("unit") || address.toLowerCase().includes("#")) {
    return "condo"
  }
  if (address.toLowerCase().includes("luxury") || address.toLowerCase().includes("estate")) {
    return "luxury"
  }
  return "single_family"
}

function getOfferTemplate(propertyType: string): string {
  const templates: Record<string, string> = {
    single_family: "Standard Residential Purchase",
    condo: "Condo/Townhome Purchase",
    luxury: "Luxury Home Purchase",
    investment: "Investment Property Purchase",
  }
  return templates[propertyType] || templates.single_family
}

function buildPrefillPrompt(context: any): string {
  return `You are a real estate AI assistant helping prefill a buyer offer form.

Buyer Context:
- Name: ${context.buyer.name}
- Financial: ${JSON.stringify(context.financial)}
- Search Preferences: ${JSON.stringify(context.searchPreferences)}

Property:
- Address: ${context.property.address}
- Type: ${context.property.type}

Template: ${context.template}

Generate typical offer terms for this buyer and property. Return JSON with:
{
  "offerPrice": number (estimated),
  "earnestMoneyPercent": number (1-3%),
  "closingDays": number (30-60),
  "contingencies": string[] (inspection, financing, appraisal),
  "financingType": string (conventional, fha, cash),
  "downPaymentPercent": number
}

Be conservative and buyer-friendly. Include standard contingencies for protection.`
}

function parsePrefillResponse(text: string, template: string): OfferPrefillData {
  try {
    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      throw new Error("No JSON found in response")
    }

    const parsed = JSON.parse(jsonMatch[0])

    return {
      offerPrice: parsed.offerPrice,
      earnestMoney: parsed.offerPrice
        ? Math.round(parsed.offerPrice * (parsed.earnestMoneyPercent / 100))
        : undefined,
      earnestMoneyPercent: parsed.earnestMoneyPercent || 2,
      closingDays: parsed.closingDays || 45,
      contingencies: parsed.contingencies || ["inspection", "financing", "appraisal"],
      financingType: parsed.financingType || "conventional",
      downPaymentPercent: parsed.downPaymentPercent || 20,
      template,
      confidence: 0.8,
    }
  } catch (error) {
    console.error("[buyer-offer] Error parsing AI response:", error)
    // Return defaults
    return {
      earnestMoneyPercent: 2,
      closingDays: 45,
      contingencies: ["inspection", "financing", "appraisal"],
      financingType: "conventional",
      downPaymentPercent: 20,
      template,
      confidence: 0.5,
    }
  }
}
