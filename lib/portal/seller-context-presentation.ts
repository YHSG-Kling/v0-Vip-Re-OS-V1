// lib/portal/seller-context-presentation.ts
//
// THE PRESENTATION HALF OF THE SELLER PORTAL — pure, and deliberately kernel-free.
//
// These types, status/sentiment maps and formatters are rendered by CLIENT components
// (ListingStatsCard, MarketPositionCard, SellerOfferCard, ShowingsFeedCard). They used to
// live in resolve-seller-context.ts alongside the async resolvers, which statically import
// @/lib/kernel/portal → notification-engine → event-reactor, and event-reactor carries
// `import "server-only"`. So importing a colour map dragged the whole kernel into the
// browser bundle and broke `next build` — a failure tsc cannot see, because TypeScript has
// no opinion about which half of a module graph is allowed in a client chunk.
//
// Nothing here may import the kernel, a Supabase client, or anything server-only. The
// async resolvers stay in resolve-seller-context.ts and re-export this module, so every
// existing server caller keeps its single import site and nothing is lost.
//
// Guarded by scripts/client-server-only-guard.ts.

// signal-mapping is a PURE leaf (no kernel, no Supabase, no server-only) — safe here.
import { isPositiveShowingInterest, isNegativeShowingInterest } from "@/lib/behavior-learning/signal-mapping"
import { computeDaysOnMarket } from "@/lib/listings/compute-dom"

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
  // m568: the ONE showing-verdict vocabulary, shared with showings.buyer_interest_level
  overall_impression: 'love_it' | 'like_it' | 'maybe' | 'no' | null
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
 *
 * m568: the column speaks the ONE showing-verdict vocabulary
 * (love_it | like_it | maybe | no), so the split is owned by the ladder's two
 * set-helpers rather than a private spelling of the same ends here.
 */
export function deriveOverallSentiment(
  feedback: Pick<ShowingFeedback, 'overall_impression'>
): 'positive' | 'neutral' | 'negative' {
  if (isPositiveShowingInterest(feedback.overall_impression)) return 'positive'
  if (isNegativeShowingInterest(feedback.overall_impression)) return 'negative'
  return 'neutral'
}

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

