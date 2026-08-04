// lib/portal/resolve-seller-context.ts
// Resolves seller-specific context for portal views.
// Uses kernel functions for portal view determination.

import type { SupabaseClient } from "@supabase/supabase-js"
import { determinePortalView } from "@/lib/kernel/portal"

// The presentation half moved to a kernel-free leaf so CLIENT components can import a
// status colour map without dragging server-only code into the browser bundle. It is
// re-exported here so every existing server-side caller keeps its single import site —
// nothing was removed, only relocated.
export * from "./seller-context-presentation"
// `export *` re-exports for callers but creates no local bindings, so the resolvers
// below still need these by name.
import { computeDaysOnMarket } from "@/lib/listings/compute-dom"
import type {
  SellerContext, ListingData, ListingMetrics, OfferData, ShowingFeedback,
} from "./seller-context-presentation"

// ─── SELLER CONTEXT TYPES ─────────────────────────────────────────────────────

// ─── SELLER CONTEXT RESOLUTION ────────────────────────────────────────────────

/**
 * Resolves the full seller context for a contact.
 * Returns listing, metrics, and transaction info for seller portal views.
 */
export async function resolveSellerContext(
  supabase: SupabaseClient,
  contactId: string
): Promise<SellerContext> {
  // Get contact basic info
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, agent_id")
    .eq("id", contactId)
    .single()

  const contactName = contact?.first_name || "there"

  // Get active or most recent listing for this seller. The `dom` column
  // does NOT exist in the live schema — we select `go_live_date` and
  // compute DOM via the canonical helper.
  const { data: listings } = await supabase
    .from("listings")
    .select("id, seller_contact_id, address, city, state, list_price, status, listing_status:status, listing_date, go_live_date, bedrooms, bathrooms, square_feet:sqft, description:public_remarks, primary_photo_url")
    .eq("seller_contact_id", contactId)
    .order("listing_date", { ascending: false })
    .limit(1)

  const rawListing = listings?.[0] ?? null
  const listing: ListingData | null = rawListing
    ? { ...rawListing, dom: computeDaysOnMarket(rawListing.go_live_date) }
    : null

  // Get listing metrics if listing exists
  let metrics: ListingMetrics | null = null
  if (listing) {
    const { data: metricsData } = await supabase
      .from("listing_metrics")
      .select("id, listing_id, total_views:views, showing_count:showings, inquiry_count:inquiries, favorite_count:saves")
      .eq("listing_id", listing.id)
      .maybeSingle()

    metrics = metricsData ?? null
  }

  // Get seller's active transaction
  let transactionId: string | null = null
  if (listing) {
    const { data: transactions } = await supabase
      .from("transactions")
      .select("id")
      .eq("listing_id", listing.id)
      .not("status", "in", "(cancelled)")
      .order("created_at", { ascending: false })
      .limit(1)

    transactionId = transactions?.[0]?.id ?? null
  }

  return {
    contactId,
    contactName,
    listing,
    metrics,
    transactionId,
    agentId: contact?.agent_id ?? null,
  }
}

/**
 * Calculates days on market from listings.go_live_date.
 *
 * Delegates to the canonical `lib/listings/compute-dom.ts`. Parameter
 * name preserved as `listingDate` for caller back-compat — but the value
 * MUST be `go_live_date`, NOT the listing agreement signature date.
 */
/**
 * Calculates showing activity stats for a listing.
 * Uses scheduled_at column (not showing_date) and presentation_rating/cleanliness_rating for avg.
 */
export async function getShowingStats(
  supabase: SupabaseClient,
  listingId: string
): Promise<{ thisWeek: number; total: number; avgRating: number | null }> {
  const now = new Date()
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

  // Get all showings for this listing - use scheduled_at column
  const { data: showings } = await supabase
    .from("showings")
    .select("id, scheduled_at")
    .eq("listing_id", listingId)

  const total = showings?.length ?? 0
  const thisWeek = showings?.filter(
    (s) => new Date(s.scheduled_at) >= weekAgo
  ).length ?? 0

  // Get average feedback rating from presentation_rating and cleanliness_rating
  const showingIds = showings?.map((s) => s.id) ?? []
  let avgRating: number | null = null

  if (showingIds.length > 0) {
    const { data: feedback } = await supabase
      .from("showing_feedback")
      .select("presentation_rating, cleanliness_rating")
      .in("showing_id", showingIds)
      .not("presentation_rating", "is", null)

    if (feedback && feedback.length > 0) {
      const sum = feedback.reduce((acc, f) => {
        const avg = ((f.presentation_rating ?? 0) + (f.cleanliness_rating ?? 0)) / 2
        return acc + avg
      }, 0)
      avgRating = sum / feedback.length
    }
  }

  return { thisWeek, total, avgRating }
}

/**
 * Gets recent showing feedback for a listing.
 * Uses scheduled_at column and Supabase showing_feedback columns.
 */
export async function getRecentFeedback(
  supabase: SupabaseClient,
  listingId: string,
  limit: number = 3
): Promise<ShowingFeedback[]> {
  // First get showings for this listing - use scheduled_at column
  const { data: showings } = await supabase
    .from("showings")
    .select("id, scheduled_at, contact:contacts(first_name)")
    .eq("listing_id", listingId)
    .order("scheduled_at", { ascending: false })

  if (!showings || showings.length === 0) return []

  const showingIds = showings.map((s) => s.id)

  // Get feedback for these showings - use Supabase columns
  const { data: feedback } = await supabase
    .from("showing_feedback")
    .select(`id, showing_id, created_at,
             presentation_rating, cleanliness_rating,
             price_opinion, meets_buyer_needs, offer_interest,
             overall_impression, buyer_interest_level,
             buyer_favorite_features, specific_concerns,
             additional_notes, ai_summary, sentiment_score`)
    .in("showing_id", showingIds)
    .order("created_at", { ascending: false })
    .limit(limit)

  if (!feedback) return []

  // Attach showing info to each feedback
  return feedback.map((f) => {
    const showing = showings.find((s) => s.id === f.showing_id)
    return {
      ...f,
      showing: showing
        ? {
            scheduled_at: showing.scheduled_at,
            contact: showing.contact as any,
          }
        : undefined,
    }
  })
}

/**
 * Gets offer summary for a listing.
 */
export async function getOfferSummary(
  supabase: SupabaseClient,
  listingId: string
): Promise<{
  total: number
  highest: number | null
  accepted: OfferData | null
  pending: number
}> {
  const { data: offers } = await supabase
    .from("offers")
    .select("id, listing_id, contact_id, offer_amount:offer_price, status, offer_date:submitted_at, expiration_date:response_deadline, buyer:contacts(id, first_name, last_name)")
    .eq("listing_id", listingId)
    .order("offer_price", { ascending: false })

  if (!offers || offers.length === 0) {
    return { total: 0, highest: null, accepted: null, pending: 0 }
  }

  const total = offers.length
  const highest = offers[0]?.offer_amount ?? null
  const accepted = offers.find((o) => o.status === "accepted") as OfferData | undefined ?? null
  const pending = offers.filter((o) =>
    ["pending", "submitted", "under_review", "countered"].includes(o.status)
  ).length

  return { total, highest, accepted, pending }
}
