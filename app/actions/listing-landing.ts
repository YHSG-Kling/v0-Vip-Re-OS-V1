"use server"

import { createClient } from "@/lib/supabase/server"
import { KernelEvent } from "@/lib/kernel/events"
import Anthropic from "@anthropic-ai/sdk"

const anthropic = new Anthropic()

// ============================================================================
// Types
// ============================================================================

interface ListingDetails {
  id: string
  slug: string
  address: string
  city: string
  state: string
  zip: string
  list_price: number
  beds: number
  baths: number
  sqft: number
  description: string | null
  status: string
  listing_date: string | null
  mls_number: string | null
  agent: {
    id: string
    first_name: string
    last_name: string
    phone: string | null
    email: string | null
    profile_photo_url: string | null
  } | null
  brokerage_name: string | null
  photos: Array<{
    id: string
    photo_url: string
    order_index: number
  }>
  media: Array<{
    id: string
    media_type: string
    media_url: string
  }>
}

interface NeighborhoodData {
  neighborhood_name: string | null
  school_ratings: Record<string, unknown> | null
  walk_score: number | null
  transit_score: number | null
  crime_index: number | null
  ai_summary: string | null
  generated_at: string | null
}

interface ShowingRequestInput {
  listingId: string
  firstName: string
  lastName: string
  phone: string
  email: string
  preferredDateTime: string
  notes?: string
  sessionToken?: string
  tcpaConsent?: boolean
}

// ============================================================================
// Public Data Fetching (No Auth Required)
// ============================================================================

export async function getListingBySlug(slug: string): Promise<ListingDetails | null> {
  const supabase = await createClient()

  // Fetch listing with agent info
  const { data: listing, error } = await supabase
    .from("listings")
    .select(`
      id,
      address,
      city,
      state,
      zip,
      list_price,
      bedrooms,
      bathrooms,
      sqft,
      description,
      status,
      listing_date,
      mls_number,
      agent_id,
      brokerage_id
    `)
    .eq("status", "active")
    .or(`mls_number.eq.${slug},id.eq.${slug}`)
    .single()

  if (error || !listing) {
    return null
  }

  // Fetch agent info
  let agent = null
  if (listing.agent_id) {
    const { data: agentData } = await supabase
      .from("agents")
      .select("id, user_id")
      .eq("id", listing.agent_id)
      .single()

    if (agentData?.user_id) {
      const { data: userData } = await supabase
        .from("users")
        .select("first_name, last_name, email")
        .eq("id", agentData.user_id)
        .single()

      if (userData) {
        agent = {
          id: agentData.id,
          first_name: userData.first_name || "",
          last_name: userData.last_name || "",
          phone: null,
          email: userData.email || null,
          profile_photo_url: null,
        }
      }
    }
  }

  // Fetch brokerage name
  let brokerage_name = null
  if (listing.brokerage_id) {
    const { data: brokerageData } = await supabase
      .from("brokerages")
      .select("name")
      .eq("id", listing.brokerage_id)
      .single()

    brokerage_name = brokerageData?.name || null
  }

  // Fetch photos
  const { data: photos } = await supabase
    .from("listing_photos")
    .select("id, photo_url, order_index")
    .eq("listing_id", listing.id)
    .order("order_index", { ascending: true })

  // Fetch media (videos)
  const { data: media } = await supabase
    .from("listing_media")
    .select("id, media_type, media_url:file_url")
    .eq("listing_id", listing.id)

  return {
    id: listing.id,
    slug: listing.mls_number || listing.id,
    address: listing.address,
    city: listing.city,
    state: listing.state,
    zip: listing.zip,
    list_price: listing.list_price,
    beds: listing.bedrooms,
    baths: listing.bathrooms,
    sqft: listing.sqft,
    description: listing.description,
    status: listing.status,
    listing_date: listing.listing_date,
    mls_number: listing.mls_number,
    agent,
    brokerage_name,
    photos: photos || [],
    media: media || [],
  }
}

export async function getNeighborhoodData(listingId: string): Promise<NeighborhoodData | null> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("neighborhood_reports")
    .select(`
      neighborhood_name,
      school_ratings,
      walk_score,
      transit_score,
      crime_index,
      ai_summary,
      generated_at
    `)
    .eq("listing_id", listingId)
    .order("generated_at", { ascending: false })
    .limit(1)
    .single()

  if (!error && data) {
    return data
  }

  // No stored report — ask AI to reason about the neighborhood from the listing's address
  const { data: listing } = await supabase
    .from("listings")
    .select("address, city, state, zip")
    .eq("id", listingId)
    .single()

  if (!listing) return null

  try {
    const msg = await anthropic.messages.create({
      model: "claude-opus-4-20250514",
      max_tokens: 600,
      messages: [
        {
          role: "user",
          content: `You are a real estate data assistant. Based on the property location below, provide a realistic neighborhood summary. Return ONLY valid JSON — no markdown, no explanation.

Property: ${listing.address}, ${listing.city}, ${listing.state} ${listing.zip}

Return this exact JSON structure:
{
  "neighborhood_name": string,
  "school_ratings": [{ "school_name": string, "rating": number, "level": "elementary"|"middle"|"high", "distance": number }],
  "walk_score": number (0-100),
  "transit_score": number (0-100),
  "crime_index": number (1-10, lower is safer),
  "ai_summary": string (2-3 sentences about the neighborhood for a buyer),
  "data_source": "AI-estimated"
}`,
        },
      ],
    })

    const raw = msg.content[0].type === "text" ? msg.content[0].text.trim() : ""
    const parsed = JSON.parse(raw)

    // Cache the AI result so subsequent loads are instant
    await supabase.from("neighborhood_reports").upsert(
      {
        listing_id: listingId,
        neighborhood_name: parsed.neighborhood_name,
        zip_code: listing.zip,
        city: listing.city,
        state: listing.state,
        school_ratings: parsed.school_ratings,
        walk_score: parsed.walk_score,
        transit_score: parsed.transit_score,
        crime_index: parsed.crime_index,
        ai_summary: parsed.ai_summary,
        data_source: "AI-estimated",
        generated_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      },
      { onConflict: "listing_id" }
    )

    return {
      neighborhood_name: parsed.neighborhood_name,
      school_ratings: parsed.school_ratings,
      walk_score: parsed.walk_score,
      transit_score: parsed.transit_score,
      crime_index: parsed.crime_index,
      ai_summary: parsed.ai_summary,
      generated_at: new Date().toISOString(),
    }
  } catch (err) {
    console.error("[v0] getNeighborhoodData AI fallback error:", err)
    return null
  }
}

export async function getSimilarListings(listingId: string, zip: string, brokerageId?: string) {
  const supabase = await createClient()

  let query = supabase
    .from("listings")
    .select(`
      id,
      address,
      city,
      state,
      zip,
      list_price,
      bedrooms,
      bathrooms,
      mls_number
    `)
    .eq("status", "active")
    .eq("zip", zip)
    .neq("id", listingId)
    .limit(3)

  if (brokerageId) {
    query = query.eq("brokerage_id", brokerageId)
  }

  const { data, error } = await query

  if (error) {
    return []
  }

  // Fetch primary photos for each listing
  const listingsWithPhotos = await Promise.all(
    (data || []).map(async (listing) => {
      const { data: photo } = await supabase
        .from("listing_photos")
        .select("photo_url")
        .eq("listing_id", listing.id)
        .order("order_index", { ascending: true })
        .limit(1)
        .single()

      return {
        ...listing,
        photo_url: photo?.photo_url || null,
        slug: listing.mls_number || listing.id,
      }
    })
  )

  return listingsWithPhotos
}

// ============================================================================
// Analytics (Fire-and-forget, no blocking)
// ============================================================================

export async function logLandingSession(params: {
  listingId: string
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  qrSource?: string
  sessionToken: string
}) {
  try {
    const supabase = await createClient()
    const today = new Date().toISOString().split("T")[0]

    // Insert session row
    await supabase.from("smart_landing_sessions").insert({
      listing_id: params.listingId,
      session_token: params.sessionToken,
      utm_source: params.utmSource || null,
      utm_medium: params.utmMedium || null,
      utm_campaign: params.utmCampaign || null,
      qr_source: params.qrSource || null,
      pages_viewed: 1,
      time_on_page_seconds: 0,
      cta_clicked: false,
      showing_requested: false,
    })

    // Upsert analytics for today
    const { data: existing } = await supabase
      .from("listing_page_analytics")
      .select("id, total_views")
      .eq("listing_id", params.listingId)
      .eq("date", today)
      .single()

    if (existing) {
      await supabase
        .from("listing_page_analytics")
        .update({ total_views: existing.total_views + 1 })
        .eq("id", existing.id)
    } else {
      await supabase.from("listing_page_analytics").insert({
        listing_id: params.listingId,
        date: today,
        total_views: 1,
        unique_visitors: 1,
        cta_clicks: 0,
        showing_requests: 0,
        lead_captures: 0,
      })
    }
  } catch (err) {
    // Fail silently - analytics should not block page load
    console.error("[v0] logLandingSession error:", err)
  }
}

export async function trackCtaClick(listingId: string, sessionToken: string) {
  try {
    const supabase = await createClient()
    const today = new Date().toISOString().split("T")[0]

    // Update session
    await supabase
      .from("smart_landing_sessions")
      .update({ cta_clicked: true })
      .eq("session_token", sessionToken)

    // Update analytics
    const { data: existing } = await supabase
      .from("listing_page_analytics")
      .select("id, cta_clicks")
      .eq("listing_id", listingId)
      .eq("date", today)
      .single()

    if (existing) {
      await supabase
        .from("listing_page_analytics")
        .update({ cta_clicks: existing.cta_clicks + 1 })
        .eq("id", existing.id)
    }
  } catch (err) {
    console.error("[v0] trackCtaClick error:", err)
  }
}

// ============================================================================
// Showing Request Submission
// ============================================================================

export async function submitShowingRequest(input: ShowingRequestInput) {
  const supabase = await createClient()

  // 1. Find or create contact
  const { data: existingContact } = await supabase
    .from("contacts")
    .select("id")
    .eq("email", input.email)
    .single()

  let contactId: string

  if (existingContact) {
    contactId = existingContact.id
  } else {
    // Get listing's brokerage_id and agent_id
    const { data: listing } = await supabase
      .from("listings")
      .select("brokerage_id, agent_id")
      .eq("id", input.listingId)
      .single()

    // Per TCPA rules: always create the lead, but only store phone and enable
    // phone/SMS channels when explicit consent is given.
    const consentGiven = input.tcpaConsent === true
    const consentNow = new Date().toISOString()

    const { data: newContact, error: contactError } = await supabase
      .from("contacts")
      .insert({
        first_name: input.firstName,
        last_name: input.lastName,
        email: input.email,
        phone: consentGiven ? input.phone : null,
        phone_digits: consentGiven ? input.phone.replace(/\D/g, "") : null,
        preferred_channel: consentGiven ? "phone" : "email",
        source: "listing_landing_page",
        contact_type: "buyer",
        brokerage_id: listing?.brokerage_id,
        agent_id: listing?.agent_id,
        tcpa_consent: consentGiven,
        tcpa_consent_at: consentGiven ? consentNow : null,
        tcpa_consent_date: consentGiven ? consentNow : null,
        tcpa_consent_source: consentGiven ? "listing_landing_page" : null,
        tcpa_consent_text: consentGiven
          ? "I agree to receive calls, texts, and emails regarding real estate services. Consent is not required for purchase."
          : null,
      })
      .select("id")
      .single()

    if (contactError || !newContact) {
      return { success: false, error: "Failed to create contact" }
    }

    contactId = newContact.id
  }

  // 2. Insert showing request
  const requestedDate = new Date(input.preferredDateTime)
  const { data: showingRequest, error: showingError } = await supabase
    .from("showing_requests")
    .insert({
      listing_id: input.listingId,
      contact_id: contactId,
      requested_date: requestedDate.toISOString().split("T")[0],
      requested_start_time: requestedDate.toTimeString().slice(0, 5),
      message: input.notes || null,
      status: "pending",
    })
    .select("id")
    .single()

  if (showingError) {
    return { success: false, error: "Failed to create showing request" }
  }

  // 3. Update session if token provided
  if (input.sessionToken) {
    await supabase
      .from("smart_landing_sessions")
      .update({ showing_requested: true })
      .eq("session_token", input.sessionToken)
  }

  // 4. Update analytics
  const today = new Date().toISOString().split("T")[0]
  const { data: analytics } = await supabase
    .from("listing_page_analytics")
    .select("id, showing_requests, lead_captures")
    .eq("listing_id", input.listingId)
    .eq("date", today)
    .single()

  if (analytics) {
    await supabase
      .from("listing_page_analytics")
      .update({
        showing_requests: analytics.showing_requests + 1,
        lead_captures: analytics.lead_captures + 1,
      })
      .eq("id", analytics.id)
  }

  // 5. Record lifecycle event with kernel event
  const { data: listing } = await supabase
    .from("listings")
    .select("brokerage_id, agent_id")
    .eq("id", input.listingId)
    .single()

  if (listing?.brokerage_id) {
    await supabase.from("lifecycle_events").insert({
      brokerage_id: listing.brokerage_id,
      entity_type: "showing_request",
      entity_id: showingRequest.id,
      event_type: KernelEvent.SHOWING_REQUESTED,
      metadata: {
        listing_id: input.listingId,
        contact_id: contactId,
        source: "listing_landing_page",
      },
    })
  }

  // 6. Get agent name for confirmation message
  let agentName = "The listing agent"
  if (listing?.agent_id) {
    const { data: agent } = await supabase
      .from("agents")
      .select("user_id")
      .eq("id", listing.agent_id)
      .single()

    if (agent?.user_id) {
      const { data: user } = await supabase
        .from("users")
        .select("first_name")
        .eq("id", agent.user_id)
        .single()

      if (user?.first_name) {
        agentName = user.first_name
      }
    }
  }

  return {
    success: true,
    agentName,
    showingRequestId: showingRequest.id,
  }
}


// ============================================================================
// Helpers are in app/lib/listing-utils.ts
// ============================================================================
