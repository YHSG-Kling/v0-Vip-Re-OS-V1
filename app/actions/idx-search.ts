"use server"

import { createClient } from "@/lib/supabase/server"
import { generateTextRouted as generateText } from "@/lib/ai/models"
// THE SPEND ACTOR. Every export in this "use server" file is a public HTTP
// endpoint, so the AI cost ledger's tenant can only come from the SESSION
// (CLAUDE.md §4) — never from an id the caller supplied.
import { getAgentContext } from "@/lib/identity/get-agent-context"
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
    // Tenant for the AI cost ledger — SESSION (§4).
    const spendActor = await getAgentContext()
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
- Persona: ${contact.contact_persona || "not specified"}
- Budget: ${contact.budget_min || contact.budget_max ? `$${contact.budget_min ?? "?"}–$${contact.budget_max ?? "?"}` : "not specified"}
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
      brokerageId: spendActor.brokerageId,
      userId: spendActor.userId || null,
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

    // BEHAVIOURAL EVENT LOG — a favorite is a scored intent signal
    // (property_save, 12 points in lib/lead-scoring/behavioral-events). The
    // recorder runs on the service client, so the tenant is NOT taken from the
    // body or the contact row this action read under RLS: it goes through
    // requireContactAccess, which proves the caller is the contact themselves
    // (session/invite) or same-brokerage staff and yields the contact's real
    // brokerage. A caller the gate refuses still saved the property under RLS
    // above — they just don't move a lead score. Best-effort.
    try {
      const { requireContactAccess } = await import("@/lib/portal/require-contact-access")
      const access = await requireContactAccess(data.contactId)
      if (access.ok) {
        const { recordBehavioralEvent } = await import("@/lib/lead-scoring/record-behavioral-event")
        await recordBehavioralEvent({
          brokerageId: access.brokerageId,
          contactId: data.contactId,
          eventType: "property_save",
          eventData: {
            source: resolvedSource,
            mls_number: data.mlsNumber ?? null,
            listing_id: data.listingId ?? null,
          },
        })
      } else {
        console.error("[idx-search] property_save behavioural event NOT recorded — caller is not on this contact:", access.error)
      }
    } catch (e) {
      console.error("[idx-search] property_save behavioural event NOT recorded:", e)
    }

    // Repointed off the DELETED /properties/saved (orphan-route sweep, lane G):
    // the surviving reader is the portal Properties tab. See the tombstone at
    // app/components/portal/PersonaPropertiesDashboard.tsx (Saved tab).
    revalidatePath(`/portal/${data.contactId}/properties`)
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
  const supabase = await createClient()

  // The result of this delete used to be discarded entirely, inside a try/catch
  // that could never fire: supabase-js RESOLVES a rejected write rather than
  // throwing, so an RLS refusal returned normally and the action reported
  // "Property removed from saved" for a row that was still there. The caller
  // dropped the card from local state, and the property reappeared on refresh.
  const { data: removed, error } = await supabase
    .from("saved_properties")
    .delete()
    .eq("contact_id", data.contactId)
    .eq("mls_number", data.mlsNumber)
    .select("id")

  if (error) return { success: false, error: error.message }
  if (!removed?.length) {
    return { success: false, error: "That property is not in your saved list" }
  }

  // Repointed off the DELETED /properties/saved (orphan-route sweep, lane G):
  // the surviving reader — and now this action's only caller — is the portal
  // Properties tab's Saved list.
  revalidatePath(`/portal/${data.contactId}/properties`)
  return { success: true, message: "Property removed from saved" }
}

/**
 * Track property view for engagement scoring.
 *
 * GATED AND TENANT-STAMPED, both of which were missing.
 *
 * All four live `property_views` policies (select / insert-check /
 * update-both-clauses / delete), granted to `authenticated`, read
 * `brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()`. A NULL
 * brokerage_id SATISFIES that predicate for EVERY tenant, so an unstamped view row —
 * which names a buyer and how long they stared at a home — was published to, and
 * editable and deletable by, every signed-in user of every other brokerage.
 *
 * `contactId` arrives from a `?contactId=` QUERY PARAM on a page that needs no
 * session, straight into a `"use server"` export. The tenant is therefore NOT looked
 * up from it and stamped — that would let the caller choose the brokerage. It goes
 * through `requireContactAccess`, which proves the caller is either that contact or
 * staff in the contact's brokerage and only then yields the brokerage id. This also
 * closes the intent_score write below, which previously let any caller move a lead
 * score on any contact in any brokerage.
 *
 * Service client after the gate, matching `trackPortalActivity` in
 * app/actions/collaborative-search.ts: the caller here is often the portal contact
 * themselves, whose `current_user_brokerage_id()` need not be the contact's
 * brokerage, so they may satisfy neither the stamped INSERT check nor the `contacts`
 * update under RLS. Every service-client statement is re-scoped by
 * `access.brokerageId`, so the bypass can only ever touch the tenant the gate proved.
 */
export async function trackPropertyView(data: {
  contactId: string
  mlsNumber: string
  timeSpent: number
}) {
  try {
    const { requireContactAccess } = await import("@/lib/portal/require-contact-access")
    const access = await requireContactAccess(data.contactId)
    if (!access.ok) {
      console.error("Track view NOT recorded — caller is not on this contact:", access.error)
      return { success: false, error: access.error }
    }

    const { createServiceClient } = await import("@/lib/supabase/service")
    const svc = createServiceClient()

    // The result was discarded entirely. supabase-js RESOLVES a refused write rather
    // than throwing, so the surrounding try/catch never saw an RLS denial and the
    // action reported success for a row that was never written.
    const { error: viewError } = await svc.from("property_views").insert({
      brokerage_id: access.brokerageId,
      contact_id: data.contactId,
      time_spent_seconds: data.timeSpent,
    })
    if (viewError) {
      console.error("Track view error:", viewError.message)
      return { success: false, error: viewError.message }
    }

    // BEHAVIOURAL EVENT LOG — the stream the canonical scorer's 30% behavioural
    // refinement actually reads (lead_behavioral_data, folded by
    // lib/lead-scoring/behavioral-events). property_views feeds the analytics
    // surface; without this second write a buyer could view a hundred homes and
    // their lead_score would never move. Identity/tenant are the gate's, never
    // the body's. Best-effort: the recorder logs its own refusals.
    const { recordBehavioralEvent } = await import("@/lib/lead-scoring/record-behavioral-event")
    await recordBehavioralEvent({
      brokerageId: access.brokerageId,
      contactId: data.contactId,
      eventType: "property_view",
      eventData: { mls_number: data.mlsNumber, time_spent_seconds: data.timeSpent },
    })

    if (data.timeSpent > 120) {
      // `error` is destructured: a refused read used to arrive as `data: null`, which
      // `(contact?.intent_score || 0)` then laundered into a score of 0 — and the line
      // below wrote 5 back over whatever the real score was. A failed read must not
      // become a score reset, so it aborts the bump instead.
      const { data: contact, error: contactError } = await svc
        .from("contacts")
        .select("intent_score")
        .eq("id", data.contactId)
        .eq("brokerage_id", access.brokerageId)
        .maybeSingle()

      if (contactError || !contact) {
        console.error(
          "Intent score NOT raised — current score unreadable:",
          contactError?.message ?? "contact not found in this brokerage",
        )
        return { success: true }
      }

      const newScore = Math.min((contact.intent_score || 0) + 5, 100)

      const { error: scoreError } = await svc
        .from("contacts")
        .update({ intent_score: newScore })
        .eq("id", data.contactId)
        .eq("brokerage_id", access.brokerageId)
      if (scoreError) {
        console.error("Intent score NOT raised:", scoreError.message)
      }
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

/**
 * The facts a PUBLIC property page is allowed to show. Deliberately a narrow,
 * hand-picked column list rather than `select("*")` — this is read with the
 * service client on an unauthenticated route, so anything not named here never
 * leaves the server.
 */
export interface PublicPropertyFacts {
  /** OUR listings.id — set only for an in-house listing. Never an MLS number. */
  listingId:        string
  mlsNumber:        string | null
  address:          string | null
  city:             string | null
  state:            string | null
  zip:              string | null
  price:            number | null
  beds:             number | null
  baths:            number | null
  sqft:             number | null
  propertyType:     string | null
  status:           string | null
  description:      string | null
  yearBuilt:        number | null
  lotSize:          number | null
  photos:           string[]
  listingDate:      string | null
  daysOnMarket:     number | null
  listingAgentName: string | null
  /** Present so an anonymous visitor has a real way to reach the listing side. */
  listingAgentEmail: string | null
}

/** Statuses that mean the home is publicly marketed and may be shown to anyone. */
const PUBLICLY_MARKETED_STATUSES = ["active", "coming_soon", "pending"] as const

/**
 * Resolve a property page from the MLS number in the URL.
 *
 * `/properties/<mlsNumber>` is reachable WITHOUT a session — PortalSocialHub
 * hands that exact URL out as a listing's shareable link — so authorization
 * here is the publication state of the row, checked BEFORE the service client
 * returns anything: a listing that is soft-deleted or in a non-public status is
 * reported as not found rather than rendered.
 *
 * Only OUR OWN `listings` rows are resolvable this way. `saved_properties` is
 * per-contact private data and is never served from a public URL, even when it
 * happens to carry the same MLS number.
 */
export async function getPublicPropertyByMlsNumber(mlsNumber: string): Promise<
  { success: true; property: PublicPropertyFacts } | { success: false; error: string }
> {
  const mls = (mlsNumber ?? "").trim()
  if (!mls) return { success: false, error: "No MLS number was supplied." }

  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()

  const { data, error } = await svc
    .from("listings")
    .select("id, mls_number, address, city, state, zip, list_price, bedrooms, bathrooms, sqft, property_type, status, public_remarks, year_built, lot_size, primary_photo_url, photos, listing_date, listing_agent_name, listing_agent_email")
    .eq("mls_number", mls)
    .is("deleted_at", null)
    .in("status", PUBLICLY_MARKETED_STATUSES as unknown as string[])
    .order("listing_date", { ascending: false })
    .limit(1)

  if (error) return { success: false, error: error.message }

  const row = data?.[0]
  if (!row) {
    return {
      success: false,
      error: `No publicly marketed listing was found for MLS #${mls}.`,
    }
  }

  const photoList = Array.isArray(row.photos)
    ? (row.photos as unknown[]).map((p) => (typeof p === "string" ? p : (p as any)?.url)).filter(Boolean)
    : []
  const photos = [row.primary_photo_url, ...photoList].filter(Boolean) as string[]

  const daysOnMarket = row.listing_date
    ? Math.max(0, Math.floor((Date.now() - new Date(row.listing_date).getTime()) / 86_400_000))
    : null

  return {
    success: true,
    property: {
      listingId:         row.id,
      mlsNumber:         row.mls_number,
      address:           row.address,
      city:              row.city,
      state:             row.state,
      zip:               row.zip,
      price:             row.list_price == null ? null : Number(row.list_price),
      beds:              row.bedrooms,
      baths:             row.bathrooms == null ? null : Number(row.bathrooms),
      sqft:              row.sqft,
      propertyType:      row.property_type,
      status:            row.status,
      description:       row.public_remarks,
      yearBuilt:         row.year_built,
      lotSize:           row.lot_size == null ? null : Number(row.lot_size),
      photos:            [...new Set(photos)],
      listingDate:       row.listing_date,
      daysOnMarket,
      listingAgentName:  row.listing_agent_name,
      listingAgentEmail: row.listing_agent_email,
    },
  }
}

// IDX API must be configured for property search
// Set IDX_API_BASE and IDX_API_KEY environment variables to enable
