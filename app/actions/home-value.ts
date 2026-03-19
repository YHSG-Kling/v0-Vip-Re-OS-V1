"use server"

import { createClient } from "@/lib/supabase/server"
import { KernelEvent } from "@/lib/kernel/events"
import Anthropic from "@anthropic-ai/sdk"

// ============================================================================
// Types
// ============================================================================

interface HomeValueFormData {
  propertyAddress: string
  city: string
  state: string
  zipCode: string
  bedrooms: number
  bathrooms: number
  squareFeet: number
  yearBuilt: number
  condition: string
  firstName: string
  lastName: string
  email: string
  phone: string
  agentSlug?: string
  brokerageId?: string
  utmSource?: string
}

interface AIValuationResponse {
  estimated_value_low: number
  estimated_value_mid: number
  estimated_value_high: number
  confidence_score: number
  market_trend: "appreciating" | "stable" | "depreciating"
  ai_narrative: string
  comps: Array<{
    address: string
    sale_price: number
    beds: number
    baths: number
    sqft: number
    price_per_sqft: number
    sale_date: string
    distance_miles: number
  }>
}

// ============================================================================
// submitHomeValueRequest
// ============================================================================

export async function submitHomeValueRequest(formData: HomeValueFormData): Promise<{
  success: boolean
  requestId?: string
  error?: string
}> {
  const supabase = await createClient()

  try {
    const {
      propertyAddress,
      city,
      state,
      zipCode,
      bedrooms,
      bathrooms,
      squareFeet,
      yearBuilt,
      condition,
      firstName,
      lastName,
      email,
      phone,
      agentSlug,
      brokerageId,
      utmSource,
    } = formData

    // Step 1: Resolve agent from slug if provided, else get default brokerage agent
    let resolvedAgentId: string | null = null
    let resolvedBrokerageId = brokerageId

    if (agentSlug) {
      const { data: agentData } = await supabase
        .from("agents")
        .select("id, brokerage_id")
        .eq("slug", agentSlug)
        .single()

      if (agentData) {
        resolvedAgentId = agentData.id
        resolvedBrokerageId = agentData.brokerage_id
      }
    }

    // If no brokerage resolved, get the first active brokerage
    if (!resolvedBrokerageId) {
      const { data: defaultBrokerage } = await supabase
        .from("brokerages")
        .select("id")
        .is("deleted_at", null)
        .limit(1)
        .single()

      resolvedBrokerageId = defaultBrokerage?.id
    }

    if (!resolvedBrokerageId) {
      return { success: false, error: "Unable to determine brokerage" }
    }

    // Step 2: Check for existing contact by email OR phone in this brokerage
    const normalizedPhone = phone.replace(/\D/g, "")

    const { data: existingContact } = await supabase
      .from("contacts")
      .select("id")
      .eq("brokerage_id", resolvedBrokerageId)
      .or(`email.eq.${email},phone_digits.eq.${normalizedPhone}`)
      .maybeSingle()

    let contactId: string

    // Step 3: If no match, INSERT new contact FIRST
    if (!existingContact) {
      const { data: newContact, error: contactError } = await supabase
        .from("contacts")
        .insert({
          first_name: firstName,
          last_name: lastName,
          email,
          phone,
          phone_digits: normalizedPhone,
          contact_type: "seller",
          source: "home_value_tool",
          buyer_stage: "BUYER_CONTACT_CREATED",
          agent_id: resolvedAgentId,
          brokerage_id: resolvedBrokerageId,
        })
        .select("id")
        .single()

      if (contactError || !newContact) {
        console.error("Error creating contact:", contactError)
        return { success: false, error: "Failed to create contact" }
      }
      contactId = newContact.id
    } else {
      contactId = existingContact.id
    }

    // Step 4: INSERT valuation_requests with contact_id attached
    const { data: valuationRequest, error: valuationError } = await supabase
      .from("valuation_requests")
      .insert({
        contact_id: contactId,
        property_address: propertyAddress,
        city,
        state,
        zip_code: zipCode,
        bedrooms,
        bathrooms,
        square_feet: squareFeet,
        year_built: yearBuilt,
        condition,
        agent_id: resolvedAgentId,
        brokerage_id: resolvedBrokerageId,
        utm_source: utmSource,
        ref_agent_slug: agentSlug,
      })
      .select("id")
      .single()

    if (valuationError || !valuationRequest) {
      console.error("Error creating valuation request:", valuationError)
      return { success: false, error: "Failed to create valuation request" }
    }

    // Step 5: Generate AI estimate using Claude
    const aiValuation = await generateAIValuation({
      propertyAddress,
      city,
      state,
      zipCode,
      bedrooms,
      bathrooms,
      squareFeet,
      yearBuilt,
      condition,
    })

    // Step 6: INSERT home_value_estimates
    const estimatedEquity = aiValuation.estimated_value_mid * 0.3 // Default assumption

    const { error: estimateError } = await supabase
      .from("home_value_estimates")
      .insert({
        valuation_request_id: valuationRequest.id,
        contact_id: contactId,
        brokerage_id: resolvedBrokerageId,
        property_address: propertyAddress,
        estimated_value_low: aiValuation.estimated_value_low,
        estimated_value_mid: aiValuation.estimated_value_mid,
        estimated_value_high: aiValuation.estimated_value_high,
        estimated_equity: estimatedEquity,
        confidence_score: aiValuation.confidence_score,
        methodology: "ai_cma",
        comps_json: aiValuation.comps,
        market_trend: aiValuation.market_trend,
        ai_narrative: aiValuation.ai_narrative,
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
      })

    if (estimateError) {
      console.error("Error creating estimate:", estimateError)
      return { success: false, error: "Failed to create estimate" }
    }

    // Step 7: UPDATE contacts.home_value_estimate
    await supabase
      .from("contacts")
      .update({ home_value_estimate: aiValuation.estimated_value_mid })
      .eq("id", contactId)

    // Step 8: EMIT HOME_VALUE_CONTACT_CREATED kernel event
    await supabase.from("lifecycle_events").insert({
      brokerage_id: resolvedBrokerageId,
      entity_type: "contact",
      entity_id: contactId,
      event_type: KernelEvent.HOME_VALUE_CONTACT_CREATED,
      metadata: {
        request_id: valuationRequest.id,
        estimated_value: aiValuation.estimated_value_mid,
        property_address: propertyAddress,
      },
    })

    // Step 9: Return requestId for redirect
    return { success: true, requestId: valuationRequest.id }
  } catch (error) {
    console.error("Error in submitHomeValueRequest:", error)
    return { success: false, error: "An unexpected error occurred" }
  }
}

// ============================================================================
// getHomeValueResult
// ============================================================================

export async function getHomeValueResult(requestId: string) {
  const supabase = await createClient()

  const { data: estimate, error } = await supabase
    .from("home_value_estimates")
    .select(`
      *,
      valuation_requests (
        property_address,
        city,
        state,
        zip_code,
        bedrooms,
        bathrooms,
        square_feet,
        year_built,
        condition,
        ref_agent_slug
      )
    `)
    .eq("valuation_request_id", requestId)
    .single()

  if (error || !estimate) {
    return { success: false, error: "Estimate not found" }
  }

  // If agent slug, fetch agent info
  let agent = null
  const agentSlug = estimate.valuation_requests?.ref_agent_slug

  if (agentSlug) {
    const { data: agentData } = await supabase
      .from("agents")
      .select("id, first_name, last_name, phone_mobile, email, profile_image_url")
      .eq("slug", agentSlug)
      .single()

    agent = agentData
  }

  return {
    success: true,
    estimate: {
      id: estimate.id,
      propertyAddress: estimate.property_address,
      estimatedValueLow: estimate.estimated_value_low,
      estimatedValueMid: estimate.estimated_value_mid,
      estimatedValueHigh: estimate.estimated_value_high,
      estimatedEquity: estimate.estimated_equity,
      confidenceScore: estimate.confidence_score,
      methodology: estimate.methodology,
      comps: estimate.comps_json || [],
      marketTrend: estimate.market_trend,
      aiNarrative: estimate.ai_narrative,
      generatedAt: estimate.generated_at,
      expiresAt: estimate.expires_at,
      propertyDetails: estimate.valuation_requests,
    },
    agent,
  }
}

// ============================================================================
// AI Valuation Generation
// ============================================================================

async function generateAIValuation(propertyData: {
  propertyAddress: string
  city: string
  state: string
  zipCode: string
  bedrooms: number
  bathrooms: number
  squareFeet: number
  yearBuilt: number
  condition: string
}): Promise<AIValuationResponse> {
  const anthropic = new Anthropic()

  const prompt = `Property: ${propertyData.propertyAddress}, ${propertyData.city}, ${propertyData.state} ${propertyData.zipCode}
Beds: ${propertyData.bedrooms}, Baths: ${propertyData.bathrooms}, Sq Ft: ${propertyData.squareFeet}
Year Built: ${propertyData.yearBuilt}, Condition: ${propertyData.condition}

Provide a conservative property valuation estimate based on typical market data for this ZIP code.
Return ONLY valid JSON with this exact structure:
{
  "estimated_value_low": number,
  "estimated_value_mid": number,
  "estimated_value_high": number,
  "confidence_score": number (0-100),
  "market_trend": "appreciating" | "stable" | "depreciating",
  "ai_narrative": "string (2-3 paragraphs analyzing this property's value)",
  "comps": [
    {
      "address": "string",
      "sale_price": number,
      "beds": number,
      "baths": number,
      "sqft": number,
      "price_per_sqft": number,
      "sale_date": "YYYY-MM-DD",
      "distance_miles": number
    }
  ]
}

Provide exactly 3 comparable sales. Be conservative with estimates. The narrative should be professional and informative.`

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      system: "You are a real estate market analyst. Generate conservative property valuation estimates. Respond with ONLY valid JSON, no markdown formatting.",
    })

    const textContent = response.content.find((c) => c.type === "text")
    if (!textContent || textContent.type !== "text") {
      throw new Error("No text response from AI")
    }

    // Parse JSON from response
    const jsonMatch = textContent.text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      throw new Error("No JSON found in response")
    }

    const parsed = JSON.parse(jsonMatch[0]) as AIValuationResponse
    return parsed
  } catch (error) {
    console.error("Error generating AI valuation:", error)
    // Return fallback estimate based on typical price per sqft
    const pricePerSqft = 200 // Conservative default
    const baseValue = propertyData.squareFeet * pricePerSqft

    return {
      estimated_value_low: Math.round(baseValue * 0.9),
      estimated_value_mid: Math.round(baseValue),
      estimated_value_high: Math.round(baseValue * 1.1),
      confidence_score: 60,
      market_trend: "stable",
      ai_narrative:
        "This estimate is based on regional averages. For a more accurate assessment, we recommend scheduling an in-person consultation with a local real estate expert who can evaluate your property's unique features and current market conditions.",
      comps: [],
    }
  }
}

// ============================================================================
// getAgentBySlug (for personalization)
// ============================================================================

export async function getAgentBySlug(slug: string) {
  const supabase = await createClient()

  const { data: agent } = await supabase
    .from("agents")
    .select("id, first_name, last_name, phone_mobile, email, profile_image_url, brokerage_id")
    .eq("slug", slug)
    .single()

  return agent
}
