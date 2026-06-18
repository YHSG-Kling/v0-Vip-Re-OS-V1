// lib/portal/resolve-seller-context.ts
// Resolves seller-specific context for portal views.
// Uses kernel functions for portal view determination.

import type { SupabaseClient } from "@supabase/supabase-js"
import { determinePortalView } from "@/lib/kernel/portal"
import { computeDaysOnMarket } from "@/lib/listings/compute-dom"

// ─── SELLER CONTEXT TYPES ─────────────────────────────────────────────────────

export interface ListingData {
  id: string
  seller_contact_id: string
  address: string | null
  /** Not a real listings column — kept optional for consumers that fall back
   *  to it. Always absent from hydrated rows; `address` is canonical. */
  property_address?: string | null
  city: string | null
  state: string | null
  list_price: number | null
  status: string | null
  listing_status: string | null
  listing_date: string | null
  go_live_date: string | null
  /** Computed DOM (days on market) — derived from go_live_date when this
   *  row is hydrated. Materialized here so consumers can read it directly
   *  without re-computing. NULL when go_live_date is unset. */
  dom: number | null
  bedrooms: number | null
  bathrooms: number | null
  square_feet: number | null
  description: string | null
  primary_photo_url: string | null
}

export interface ListingMetrics {
  id: string
  listing_id: string
  total_views: number
  showing_count: number
  inquiry_count: number
  favorite_count: number
}

export interface ShowingFeedback {
  id: string
  showing_id: string
  created_at: string
  presentation_rating: number | null
  cleanliness_rating: number | null
  price_opinion: 'too_high' | 'priced_right' | 'good_value' | null
  meets_buyer_needs: 'yes' | 'partially' | 'no' | null
  offer_interest: 'very_likely' | 'possible' | 'unlikely' | 'no' | null
  overall_impression: 'loved_it' | 'liked_it' | 'neutral' | 'not_interested' | null
  buyer_interest_level: 'hot' | 'warm' | 'cool' | 'cold' | null
  buyer_favorite_features: string | null
  specific_concerns: string | null
  additional_notes: string | null
  ai_summary: string | null
  sentiment_score: number | null
  showing?: {
    scheduled_at: string
    contact?: {
      first_name: string | null
    }
  }
}

export interface OfferData {
  id: string
  listing_id: string
  contact_id: string
  offer_amount: number | null
  status: string
  offer_date: string | null
  expiration_date: string | null
  buyer?: {
    id: string
    first_name: string | null
    last_name: string | null
  }
}

export interface SellerContext {
  contactId: string
  contactName: string
  listing: ListingData | null
  metrics: ListingMetrics | null
  transactionId: string | null
  agentId: string | null
}

// ─── LISTING STATUS HELPERS ───────────────────────────────────────────────────

export const LISTING_STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  active: { label: "Active", color: "bg-green-100 text-green-800" },
  pending: { label: "Pending", color: "bg-amber-100 text-amber-800" },
  under_contract: { label: "Under Contract", color: "bg-blue-100 text-blue-800" },
  coming_soon: { label: "Coming Soon", color: "bg-purple-100 text-purple-800" },
  sold: { label: "Sold", color: "bg-slate-100 text-slate-600" },
  closed: { label: "Closed", color: "bg-slate-100 text-slate-600" },
  withdrawn: { label: "Withdrawn", color: "bg-red-100 text-red-800" },
  expired: { label: "Expired", color: "bg-slate-100 text-slate-600" },
}

export const SENTIMENT_CONFIG: Record<string, { label: string; color: string }> = {
  positive: { label: "Positive", color: "bg-green-100 text-green-700" },
  neutral: { label: "Neutral", color: "bg-amber-100 text-amber-700" },
  negative: { label: "Needs Attention", color: "bg-red-100 text-red-700" },
}

export const OFFER_STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  pending: { label: "Pending", color: "bg-amber-100 text-amber-800" },
  submitted: { label: "Submitted", color: "bg-blue-100 text-blue-800" },
  under_review: { label: "Under Review", color: "bg-purple-100 text-purple-800" },
  countered: { label: "Countered", color: "bg-purple-100 text-purple-800" },
  accepted: { label: "Accepted", color: "bg-green-100 text-green-800" },
  rejected: { label: "Rejected", color: "bg-red-100 text-red-800" },
  expired: { label: "Expired", color: "bg-slate-100 text-slate-600" },
  withdrawn: { label: "Withdrawn", color: "bg-slate-100 text-slate-600" },
}

// ─── SENTIMENT DERIVATION HELPER ──────────────────────────────────────────────

/**
 * Derives overall sentiment from showing_feedback.overall_impression
 * Since there is no direct 'sentiment' column, we map overall_impression values.
 */
export function deriveOverallSentiment(
  feedback: Pick<ShowingFeedback, 'overall_impression'>
): 'positive' | 'neutral' | 'negative' {
  if (feedback.overall_impression === 'loved_it' || feedback.overall_impression === 'liked_it') {
    return 'positive'
  }
  if (feedback.overall_impression === 'not_interested') {
    return 'negative'
  }
  return 'neutral'
}

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
export function calculateDOM(listingDate: string | null): number {
  return computeDaysOnMarket(listingDate) ?? 0
}

/**
 * Formats price for display.
 */
export function formatPrice(price: number | null): string {
  if (price === null || price === undefined) return "N/A"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(price)
}

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
