"use server"

/**
 * System 7.1A - Buyer Offer Execution Engine
 * Domain 3: AI Prefill
 * 
 * AI-prefills offer data from buyer profile, property, and market data
 */

import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { generateText } from "ai"

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
