"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "@/lib/kernel/events"
import { emitKernelEvent } from "@/lib/kernel/emit"
import { gatewayChatJSON } from "@/lib/ai/gateway-chat"
import { captureContact } from "@/lib/contact-pipeline/contact-capture"
import { tenantScope, applyTenantScope } from "@/lib/kernel/tenant-scope"

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
  go_live_date: string | null
  mls_number: string | null
  /**
   * THE LISTING'S TENANT. Read from `listings.brokerage_id` and now SURFACED,
   * because the public page needs it to scope "similar listings" to this
   * brokerage (owner ruling 3, 2026-08-24 — "public landing pages should not
   * show cross brokerage comps"). It was already being read here and dropped on
   * the floor, which is why the page had nothing to pass and the scope silently
   * never applied. NULLABLE, matching the column.
   */
  brokerage_id: string | null
  agent: {
    id: string
    first_name: string
    last_name: string
    phone: string | null
    email: string | null
    profile_photo_url: string | null
  } | null
  brokerage_name: string | null
  // View-model shape for the public page. `photo_url` is the DTO field name the
  // hero/gallery components read; it is sourced from listing_media.file_url
  // (media_type='photo') since the m368/m369 consolidation.
  photos: Array<{
    id: string
    photo_url: string
    sort_order: number
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
  /** NAR Code of Ethics Article 16 disclosure. Captured on the public form; persisted on
   *  the contact's `enrichment_profile.representation_disclosure` JSONB so the conversion
   *  gate (app/actions/convert-outside-inquiry.ts) can refuse promotion when the buyer
   *  has self-disclosed they're already working with another agent. */
  representationStatus?: "unrepresented" | "represented" | "prefer_not_to_say"
}

// ============================================================================
// Public Data Fetching (No Auth Required)
// ============================================================================

export interface GeneratedLandingPage {
  id: string
  listing_id: string | null
  slug: string
  status: string
  content: { headline?: string; subheadline?: string; body?: string } | null
  view_count: number
}

/**
 * AI-generated landing page for a slug (listing_landing_pages — written by
 * generateListingLandingPage and the listing_landing_page workflow adapter).
 * Published pages are public content, but the table's RLS only carries a
 * service_role policy, so the anonymous visitor read goes through the service
 * client scoped to slug + published status.
 */
export async function getLandingPageBySlug(slug: string): Promise<GeneratedLandingPage | null> {
  const supabase = createServiceClient()

  const { data: page } = await supabase
    .from("listing_landing_pages")
    .select("id, listing_id, slug, status, content, view_count")
    .eq("slug", slug)
    .eq("status", "published")
    .maybeSingle()

  return (page as GeneratedLandingPage | null) ?? null
}

/** Fire-and-forget view counter for a generated landing page. */
export async function incrementLandingPageViews(pageId: string, currentViewCount: number) {
  try {
    const supabase = createServiceClient()
    await supabase
      .from("listing_landing_pages")
      .update({ view_count: currentViewCount + 1, updated_at: new Date().toISOString() })
      .eq("id", pageId)
  } catch (err) {
    // Fail silently - analytics should not block page load
    console.error("[v0] incrementLandingPageViews error:", err)
  }
}

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
      public_remarks,
      status,
      listing_date,
      go_live_date,
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

  // Fetch photos — listing_media rows of media_type='photo' (m368/m369
  // consolidation). The pin matters: without it the gallery would render
  // documents, floorplans and video files as photographs.
  const { data: photos, error: photosError } = await supabase
    .from("listing_media")
    .select("id, photo_url:file_url, sort_order")
    .eq("listing_id", listing.id)
    .eq("media_type", "photo")
    .order("sort_order", { ascending: true })
  // A refused read resolves as an empty gallery — a public listing page that
  // silently shows no photos is worse than one that logs why.
  if (photosError) console.error("[listing-landing] photo read failed:", photosError.message)

  // Fetch NON-photo media (video, virtual tour, floorplan, ...) — the photo
  // rows above are the same table, so excluding them here keeps the landing
  // page from listing every photo twice.
  const { data: media, error: mediaError } = await supabase
    .from("listing_media")
    .select("id, media_type, media_url:file_url")
    .eq("listing_id", listing.id)
    .neq("media_type", "photo")
  if (mediaError) console.error("[listing-landing] media read failed:", mediaError.message)

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
    description: (listing as { public_remarks?: string | null }).public_remarks ?? null,  // MLS public remarks
    status: listing.status,
    listing_date: listing.listing_date,
    go_live_date: listing.go_live_date,
    mls_number: listing.mls_number,
    brokerage_id: (listing.brokerage_id as string | null) ?? null,
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
    // Routed through Vercel AI Gateway — single egress, metered, key-rotation safe.
    // Use gatewayChatJSON so a ```json-fenced response (a real artifact of the gateway's OpenAI→
    // Anthropic translation, even with "ONLY valid JSON" instructions) doesn't break the parse.
    const result = await gatewayChatJSON<Record<string, any>>({
      model:     "anthropic/claude-opus-4-20250514",
      maxTokens: 600,
      messages: [
        { role: "user", content: `You are a real estate data assistant. Based on the property location below, provide a realistic neighborhood summary. Return ONLY valid JSON — no markdown, no explanation.

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
}` },
      ],
    })
    if (!result.ok || !result.data) throw new Error(result.error ?? "No JSON from AI")
    const parsed = result.data

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

/**
 * "More homes like this" on the PUBLIC listing landing page.
 *
 * ── OWNER RULING (2026-08-24), verbatim ─────────────────────────────────────
 *   "public landing pages should not show cross brokerage comps. not sure how
 *    that got figured in?"
 *
 * The answer to the question is: NOBODY CHOSE IT. The signature was
 *
 *     getSimilarListings(listingId: string, zip: string, brokerageId?: string)
 *
 * with the predicate applied as `if (brokerageId) query = query.eq(…)`, and its
 * ONE caller — app/listing/[slug]/page.tsx:184 — never passed the third
 * argument. So the filter never once fired, and every public landing page listed
 * similar homes from every brokerage in that ZIP. An optional parameter that no
 * caller passes is indistinguishable from no tenancy at all; the tenant boundary
 * existed only in the signature.
 *
 * ── WHY THE PARAMETER IS NOW REQUIRED, NOT DEFAULTED ────────────────────────
 * A default would have re-created the same failure with a friendlier face: the
 * scope would still be something a caller could decline to think about. Required
 * means the compiler asks the question at every call site, and
 * lib/kernel/tenant-scope.ts:tenantScope REFUSES a blank at runtime — which
 * matters because this file is `"use server"`, so this export is a PUBLIC HTTP
 * ENDPOINT (CLAUDE.md §4) and an empty string is a thing a stranger can send.
 *
 * The caller was already holding the answer: getListingBySlug reads
 * `listings.brokerage_id` and simply did not surface it. It does now
 * (ListingDetails.brokerage_id), and the page passes it.
 *
 * `listings.brokerage_id` IS nullable (verified live 2026-08-24; 0 of 3 rows are
 * null today). A listing with no brokerage cannot ask "show me MY brokerage's
 * other listings", so the page renders no similar-listings section at all rather
 * than falling back to everyone's — the fail-CLOSED direction.
 */
export async function getSimilarListings(listingId: string, zip: string, brokerageId: string) {
  const supabase = await createClient()

  // Refuses a blank/whitespace id. A missing tenant is NOT "every tenant".
  const scope = tenantScope(brokerageId, "getSimilarListings (public landing page)")

  const query = supabase
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

  const { data, error } = await applyTenantScope(query, scope)

  if (error) {
    return []
  }

  // Fetch primary photos for each listing
  const listingsWithPhotos = await Promise.all(
    (data || []).map(async (listing) => {
      const { data: photo } = await supabase
        .from("listing_media")
        .select("file_url")
        .eq("listing_id", listing.id)
        .eq("media_type", "photo")
        .order("sort_order", { ascending: true })
        .limit(1)
        .maybeSingle()

      return {
        ...listing,
        photo_url: photo?.file_url || null,
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

    // Resolve the listing's brokerage so the session row is tenant-attributable.
    // smart_landing_sessions.brokerage_id already exists but was left null here,
    // which made seller-share (and every other utm) visit impossible to scope to
    // a tenant for the monthly intelligence report. One cheap read on an already
    // fire-and-forget path — no new table, no new column.
    const { data: listingRow } = await supabase
      .from("listings")
      .select("brokerage_id")
      .eq("id", params.listingId)
      .maybeSingle()

    // Insert session row — the utm params already carry the attribution source
    // (SellerSharePostsRail appends utm_source=seller-share), now stamped with the
    // owning brokerage so the report can read seller-driven reach per tenant.
    await supabase.from("smart_landing_sessions").insert({
      listing_id: params.listingId,
      brokerage_id: listingRow?.brokerage_id ?? null,
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

    // unique_visitors is DERIVED, not incremented. It used to be written as the
    // literal 1 on the day's first view and never touched again, so it read 1
    // forever no matter how many people visited — a permanently wrong number that
    // looked like a real one. Incrementing it alongside total_views would have
    // been wrong the other way: that is a view count, not a visitor count.
    // The session ledger written just above is the honest source — distinct
    // session_token for this listing on this date. Volume is one row per landing
    // view per listing per day, so the distinct-count is done here rather than in
    // SQL; supabase-js cannot express COUNT(DISTINCT ...) through PostgREST.
    const { data: todaySessions, error: sessionCountError } = await supabase
      .from("smart_landing_sessions")
      .select("session_token")
      .eq("listing_id", params.listingId)
      .gte("created_at", `${today}T00:00:00.000Z`)
      .lt("created_at", `${today}T23:59:59.999Z`)

    // §3: a refused count must not silently become a smaller visitor number.
    // Leave the column alone rather than writing a figure we could not derive.
    const uniqueVisitors =
      sessionCountError || !todaySessions
        ? null
        : new Set(todaySessions.map((s) => s.session_token).filter(Boolean)).size

    // Upsert analytics for today
    const { data: existing } = await supabase
      .from("listing_page_analytics")
      .select("id, total_views")
      .eq("listing_id", params.listingId)
      .eq("date", today)
      .maybeSingle()

    if (existing) {
      await supabase
        .from("listing_page_analytics")
        .update({
          total_views: existing.total_views + 1,
          ...(uniqueVisitors !== null ? { unique_visitors: uniqueVisitors } : {}),
        })
        .eq("id", existing.id)
    } else {
      await supabase.from("listing_page_analytics").insert({
        listing_id: params.listingId,
        // The tenant column exists on this table and was being left null, exactly
        // as smart_landing_sessions.brokerage_id was until the comment above fixed
        // it. The brokerage is already resolved for the session row — stamping it
        // here costs nothing and makes the day's traffic row tenant-attributable.
        brokerage_id: listingRow?.brokerage_id ?? null,
        date: today,
        total_views: 1,
        unique_visitors: uniqueVisitors ?? 1,
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

/**
 * The landing page's traffic ledger, read back per source — the READER half of
 * `smart_landing_sessions`.
 *
 * logLandingSession writes every visit with its attribution (utm_source /
 * utm_medium / utm_campaign / qr_source), and trackCtaClick / submitShowingRequest
 * flip cta_clicked / showing_requested on the SAME row — a real in-row
 * visit→conversion linkage. Until this action only utm_source='seller-share'
 * was ever read (the monthly intelligence report), so the QR codes an agent
 * prints and the campaigns they tag were attributed into rows nobody could
 * see. This is the agent-facing answer to "which of my share channels is
 * actually driving visits and showings for this listing".
 *
 * TENANCY: caller's brokerage from the SESSION, checked against the listing's
 * own brokerage before the service client reads the (publicly-written)
 * session rows.
 */
export async function getLandingSourceBreakdown(listingId: string): Promise<
  | {
      success: true
      totals: { sessions: number; ctaClicks: number; showingRequests: number; avgTimeOnPageSeconds: number | null; pagesViewed: number }
      bySource: Array<{
        source: string
        medium: string | null
        campaign: string | null
        sessions: number
        ctaClicks: number
        showingRequests: number
      }>
    }
  | { success: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  const { data: profile, error: profileError } = await supabase
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (profileError) return { success: false, error: profileError.message }
  if (!profile?.brokerage_id) return { success: false, error: "No brokerage on this account" }

  const { data: listing, error: listingError } = await supabase
    .from("listings").select("id, brokerage_id").eq("id", listingId).maybeSingle()
  if (listingError) return { success: false, error: listingError.message }
  if (!listing || listing.brokerage_id !== profile.brokerage_id) {
    return { success: false, error: "Listing not found" }
  }

  // Gate above, service client below: session rows are written by anonymous
  // public visitors, and the listing_id pin plus the ownership check keep this
  // read inside the caller's own listing.
  const svc = createServiceClient()
  const { data: sessions, error: sessionsError } = await svc
    .from("smart_landing_sessions")
    .select("listing_id, utm_source, utm_medium, utm_campaign, qr_source, pages_viewed, time_on_page_seconds, cta_clicked, showing_requested")
    .eq("listing_id", listingId)
    .limit(5000)
  // supabase-js RESOLVES a refused read — report it, never render "no visits".
  if (sessionsError) {
    console.error("[getLandingSourceBreakdown] session read failed:", sessionsError.message)
    return { success: false, error: sessionsError.message }
  }

  const rows = sessions ?? []
  const bySourceMap = new Map<string, { source: string; medium: string | null; campaign: string | null; sessions: number; ctaClicks: number; showingRequests: number }>()
  let ctaClicks = 0
  let showingRequests = 0
  let pagesViewed = 0
  let timeSum = 0
  let timeCount = 0
  for (const s of rows) {
    // QR scans carry qr_source; tagged links carry utm_*; everything else is direct.
    const source = s.qr_source ? `QR: ${s.qr_source}` : (s.utm_source || "direct")
    const key = `${source}|${s.utm_medium ?? ""}|${s.utm_campaign ?? ""}`
    const entry = bySourceMap.get(key) ?? {
      source, medium: s.utm_medium ?? null, campaign: s.utm_campaign ?? null,
      sessions: 0, ctaClicks: 0, showingRequests: 0,
    }
    entry.sessions++
    if (s.cta_clicked) { entry.ctaClicks++; ctaClicks++ }
    if (s.showing_requested) { entry.showingRequests++; showingRequests++ }
    pagesViewed += s.pages_viewed ?? 0
    if (typeof s.time_on_page_seconds === "number" && s.time_on_page_seconds > 0) {
      timeSum += s.time_on_page_seconds
      timeCount++
    }
    bySourceMap.set(key, entry)
  }

  return {
    success: true,
    totals: {
      sessions: rows.length,
      ctaClicks,
      showingRequests,
      avgTimeOnPageSeconds: timeCount > 0 ? Math.round(timeSum / timeCount) : null,
      pagesViewed,
    },
    bySource: [...bySourceMap.values()].sort((a, b) => b.sessions - a.sessions),
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

  // 1. Resolve the listing (brokerage + agent) once — needed for capture routing,
  //    the lifecycle event, and the confirmation message.
  const { data: listing } = await supabase
    .from("listings")
    .select("brokerage_id, agent_id")
    .eq("id", input.listingId)
    .single()

  if (!listing?.brokerage_id) {
    return { success: false, error: "Listing not found" }
  }

  // Per TCPA rules: always capture, but only store phone and enable phone/SMS channels
  // when explicit consent is given.
  const consentGiven = input.tcpaConsent === true
  const consentNow = new Date().toISOString()

  // NAR Article 16: persist the representation disclosure on enrichment_profile so
  // downstream gates (convert-outside-inquiry) can refuse promotion of a buyer who
  // self-disclosed another agent — and NEVER auto-assign the listing agent to a
  // represented buyer (no silent poaching). The inquiry is still captured for the
  // listing agent's facilitation and the seller's visibility.
  const repStatus = input.representationStatus ?? null
  const isRepresented = repStatus === "represented"
  const enrichmentProfile = repStatus
    ? {
        representation_disclosure: {
          status:     repStatus,
          disclosed_at: consentNow,
          source:     "listing_landing_page",
        },
      }
    : null

  // Route through the canonical capture spine so this inquiry gets the SAME treatment as
  // every other intake path: fuzzy dedup, enrichment queue, and CONTACT_CAPTURED →
  // multi-touch sequence enrollment. A represented buyer is captured with NO owner.
  let contactId: string
  try {
    const { contactId: capturedId } = await captureContact({
      brokerageId:         listing.brokerage_id,
      ownerAgentId:        isRepresented ? null : (listing.agent_id ?? null),
      skipAutoAssign:      isRepresented,
      source:              "listing_landing_page",
      first_name:          input.firstName,
      last_name:           input.lastName,
      email:               input.email,
      phone:               consentGiven && input.phone?.trim() ? input.phone.trim() : null,
      preferred_channel:   consentGiven && input.phone?.trim() ? "phone" : "email",
      contact_type:        "buyer",
      tcpa_consent:        consentGiven,
      tcpa_consent_date:   consentGiven ? consentNow : null,
      tcpa_consent_source: consentGiven ? "listing_landing_page" : null,
      tcpa_consent_text:   consentGiven
        ? "I agree to receive calls, texts, and emails regarding real estate services. Consent is not required for purchase."
        : null,
      enrichmentProfile,
    })
    contactId = capturedId
  } catch {
    return { success: false, error: "Failed to create contact" }
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

  // 5. Record lifecycle event with kernel event (listing resolved at step 1) —
  //    audit row + reactor (staff bell / sequences keyed on showing_requested).
  if (listing?.brokerage_id) {
    await emitKernelEvent({
      brokerageId: listing.brokerage_id,
      entityType: "showing_request",
      entityId: showingRequest.id,
      event: KernelEvent.SHOWING_REQUESTED,
      listingId: input.listingId,
      contactId: contactId ?? undefined,
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
