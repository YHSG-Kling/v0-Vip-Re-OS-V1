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

    // Step 9: Notify the assigned agent via the notifications table.
    // We need the agent's user_id (auth uid) to target the in-app notification.
    if (resolvedAgentId) {
      const { data: agentRow } = await supabase
        .from("agents")
        .select("user_id")
        .eq("id", resolvedAgentId)
        .maybeSingle()

      if (agentRow?.user_id) {
        await supabase.from("notifications").insert({
          user_id: agentRow.user_id,
          brokerage_id: resolvedBrokerageId,
          type: "home_value_lead",
          title: "New Home Value Request",
          body: `${firstName} ${lastName} requested a home value for ${propertyAddress}, ${city}. Review and start a drip campaign.`,
          entity_type: "contact",
          entity_id: contactId,
          priority: "high",
          is_read: false,
          channel: "in_app",
        })
      }
    }

    // Step 10: Enroll the contact in the seller nurture drip sequence if one
    // exists for this brokerage. We look for an active sequence triggered by
    // 'home_value_submitted' or typed as 'seller_nurture'.
    const { data: dripSequence } = await supabase
      .from("campaign_sequences")
      .select("id")
      .eq("brokerage_id", resolvedBrokerageId)
      .eq("is_active", true)
      .or("trigger_event.eq.home_value_submitted,sequence_type.eq.seller_nurture")
      .limit(1)
      .maybeSingle()

    if (dripSequence?.id) {
      // Only enroll if not already enrolled
      const { data: existingEnrollment } = await supabase
        .from("sequence_enrollments")
        .select("id")
        .eq("contact_id", contactId)
        .eq("sequence_id", dripSequence.id)
        .maybeSingle()

      if (!existingEnrollment) {
        await supabase.from("sequence_enrollments").insert({
          contact_id: contactId,
          sequence_id: dripSequence.id,
          brokerage_id: resolvedBrokerageId,
          enrolled_by: resolvedAgentId ?? undefined,
          status: "active",
          current_step: 1,
          next_step_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // start in 24h
        })
      }
    }

    // Step 11: Return requestId for redirect
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
        ref_agent_slug,
        brokerage_id,
        contact_id
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

  const vr = estimate.valuation_requests as any

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
    brokerageId: vr?.brokerage_id ?? null,
    contactId: estimate.contact_id ?? vr?.contact_id ?? null,
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
// getAvailableAgentSlots
// Returns active listing agents + their open 1-hour time slots for the next
// 7 business days (Mon–Fri, 9am–5pm local). Conflicts are checked against
// existing calendar_events for each agent.
// ============================================================================

export async function getAvailableAgentSlots(brokerageId: string): Promise<{
  success: boolean
  agents?: Array<{
    id: string
    userId: string
    firstName: string
    lastName: string
    phone: string | null
    email: string | null
    profileImageUrl: string | null
    slots: Array<{ startAt: string; endAt: string; label: string }>
  }>
  error?: string
}> {
  const supabase = await createClient()

  // Fetch all active agents for this brokerage
  const { data: agents, error: agentsError } = await supabase
    .from("agents")
    .select("id, user_id, phone_mobile, profile_image_url, brokerage_id, users(first_name, last_name, email)")
    .eq("brokerage_id", brokerageId)
    .eq("is_active", true)
    .limit(10)

  if (agentsError || !agents?.length) {
    return { success: false, error: "No agents available" }
  }

  const now = new Date()
  const windowEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

  // Fetch all calendar_events in the next 7 days for all agents in one query
  const agentIds = agents.map((a) => a.id)
  const { data: existingEvents } = await supabase
    .from("calendar_events")
    .select("entity_id, start_at, end_at")
    .in("entity_id", agentIds)
    .eq("entity_type", "agent")
    .gte("start_at", now.toISOString())
    .lte("start_at", windowEnd.toISOString())

  const bookedByAgent: Record<string, Array<{ start: Date; end: Date }>> = {}
  for (const ev of existingEvents ?? []) {
    if (!bookedByAgent[ev.entity_id]) bookedByAgent[ev.entity_id] = []
    bookedByAgent[ev.entity_id].push({ start: new Date(ev.start_at), end: new Date(ev.end_at) })
  }

  // Generate 1-hour slots Mon–Fri 9am–5pm for next 7 days
  function generateSlots(agentId: string): Array<{ startAt: string; endAt: string; label: string }> {
    const slots: Array<{ startAt: string; endAt: string; label: string }> = []
    const booked = bookedByAgent[agentId] ?? []
    const cursor = new Date(now)
    cursor.setMinutes(0, 0, 0)
    cursor.setHours(cursor.getHours() + 1) // start from next full hour

    for (let day = 0; day < 7; day++) {
      const d = new Date(cursor)
      d.setDate(cursor.getDate() + day)
      const dow = d.getDay()
      if (dow === 0 || dow === 6) continue // skip weekends

      for (let h = 9; h < 17; h++) {
        const slotStart = new Date(d)
        slotStart.setHours(h, 0, 0, 0)
        const slotEnd = new Date(slotStart)
        slotEnd.setHours(h + 1)

        if (slotStart <= now) continue // no past slots

        const conflict = booked.some(
          (b) => slotStart < b.end && slotEnd > b.start,
        )
        if (!conflict) {
          slots.push({
            startAt: slotStart.toISOString(),
            endAt: slotEnd.toISOString(),
            label: slotStart.toLocaleString("en-US", {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
              hour12: true,
            }),
          })
        }
        if (slots.length >= 14) break // cap per agent
      }
      if (slots.length >= 14) break
    }
    return slots
  }

  const result = agents.map((agent) => {
    const user = Array.isArray(agent.users) ? agent.users[0] : (agent.users as any)
    return {
      id: agent.id,
      userId: agent.user_id,
      firstName: user?.first_name ?? "",
      lastName: user?.last_name ?? "",
      phone: agent.phone_mobile ?? null,
      email: user?.email ?? null,
      profileImageUrl: agent.profile_image_url ?? null,
      slots: generateSlots(agent.id),
    }
  }).filter((a) => a.slots.length > 0)

  return { success: true, agents: result }
}

// ============================================================================
// scheduleHomeValuationAppt
// Books a home valuation appointment: writes to calendar_events (agent entity)
// and activities (agent + contact). Notifies the agent via notifications table.
// ============================================================================

export async function scheduleHomeValuationAppt(params: {
  contactId: string
  agentId: string
  brokerageId: string
  startAt: string // ISO
  endAt: string // ISO
  propertyAddress: string
  contactName: string
}): Promise<{ success: boolean; calendarEventId?: string; error?: string }> {
  const supabase = await createClient()

  // Double-check the slot is still free
  const { data: conflict } = await supabase
    .from("calendar_events")
    .select("id")
    .eq("entity_type", "agent")
    .eq("entity_id", params.agentId)
    .lt("start_at", params.endAt)
    .gt("end_at", params.startAt)
    .maybeSingle()

  if (conflict) {
    return { success: false, error: "That time slot is no longer available. Please select another." }
  }

  // Insert calendar event
  const { data: calEvent, error: calError } = await supabase
    .from("calendar_events")
    .insert({
      brokerage_id: params.brokerageId,
      entity_type: "agent",
      entity_id: params.agentId,
      event_type: "home_valuation_appointment",
      start_at: params.startAt,
      end_at: params.endAt,
      is_system_generated: false,
      metadata: {
        contact_id: params.contactId,
        property_address: params.propertyAddress,
        contact_name: params.contactName,
        source: "home_value_page",
      },
    })
    .select("id")
    .single()

  if (calError || !calEvent) {
    return { success: false, error: "Failed to book appointment. Please try again." }
  }

  // Insert activity record
  await supabase.from("activities").insert({
    brokerage_id: params.brokerageId,
    agent_id: params.agentId,
    contact_id: params.contactId,
    activity_type: "home_valuation_appointment",
    title: `Home Valuation Appointment — ${params.propertyAddress}`,
    description: `Scheduled by ${params.contactName} via the home value tool.`,
    scheduled_at: params.startAt,
    status: "scheduled",
    priority: "high",
  })

  // Notify the agent
  const { data: agentRow } = await supabase
    .from("agents")
    .select("user_id")
    .eq("id", params.agentId)
    .maybeSingle()

  if (agentRow?.user_id) {
    await supabase.from("notifications").insert({
      user_id: agentRow.user_id,
      brokerage_id: params.brokerageId,
      type: "appointment_scheduled",
      title: "Home Valuation Appointment Booked",
      body: `${params.contactName} booked a valuation appointment for ${params.propertyAddress} on ${new Date(params.startAt).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })}.`,
      entity_type: "contact",
      entity_id: params.contactId,
      priority: "high",
      is_read: false,
      channel: "in_app",
    })
  }

  return { success: true, calendarEventId: calEvent.id }
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
