"use server"

// app/actions/portal-seller.ts
// Server actions for seller portal data fetching.
//
// Previously every function in this file was unauthenticated — any caller
// could pass an arbitrary contactId and pull a seller's listing details,
// market position, offers, showing feedback, vendor assignments, and
// client documents. The contactId was treated as the scope key but never
// verified against the caller's identity.
//
// All functions now go through requireContactAccess() which allows EITHER:
//   - The contact themselves (portal session — contact_user_id matches
//     auth.uid OR contact.email matches authed user's email)
//   - An agent / admin in the contact's brokerage (dashboard session)

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isPositiveShowingInterest, isNegativeShowingInterest } from "@/lib/behavior-learning/signal-mapping"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import {
  defaultSellerCosts,
  resolveAgreedCommission,
  type OfferNetInput,
  type SellerCosts,
} from "@/lib/offers/net-sheet-calc"
import {
  deriveNetSheetClosingCostSection,
  type NetSheetClosingCostSection,
} from "@/lib/offers/seller-closing-costs"
import {
  resolveSellerContext,
  getShowingStats,
  getRecentFeedback,
  getOfferSummary,
  type SellerContext,
  type ShowingFeedback,
} from "@/lib/portal/resolve-seller-context"

// ─── Auth helper ──────────────────────────────────────────────────────────────
// Returns ok=true only if the authed caller is either the contact themselves
// or an agent/admin in the contact's brokerage. Also returns the contact's
// brokerage_id so downstream queries can scope safely.
async function requireContactAccess(contactId: string): Promise<
  | { ok: true; userId: string; brokerageId: string; isContactSelf: boolean }
  | { ok: false }
> {
  const authClient = await createClient()
  const { data: { user: authUser } } = await authClient.auth.getUser()
  if (!authUser) return { ok: false }

  const svc = createServiceClient()
  const { data: contact } = await svc
    .from("contacts")
    .select("brokerage_id, contact_user_id, email")
    .eq("id", contactId)
    .maybeSingle()
  if (!contact || !contact.brokerage_id) return { ok: false }

  const isContactSelf =
    contact.contact_user_id === authUser.id ||
    !!(contact.email && authUser.email && contact.email.toLowerCase() === authUser.email.toLowerCase())

  if (isContactSelf) {
    return { ok: true, userId: authUser.id, brokerageId: contact.brokerage_id, isContactSelf: true }
  }

  // Otherwise must be an agent/admin in the same brokerage
  const { data: callerRow } = await svc
    .from("users").select("brokerage_id, user_type").eq("id", authUser.id).maybeSingle()
  // SCOPE LADDER (staff roster): 'superadmin' removed — dead as users.user_type
  // (0 live rows); broker_owner added — storable same-tenant seat that owns the brokerage.
  if (callerRow?.brokerage_id === contact.brokerage_id && ["agent","team_lead","tc","admin","broker","broker_owner"].includes(((callerRow as any)?.user_type) ?? "")) {
    return { ok: true, userId: authUser.id, brokerageId: contact.brokerage_id, isContactSelf: false }
  }

  return { ok: false }
}

// ─── SELLER CONTEXT ───────────────────────────────────────────────────────────

export interface SellerDashboardData extends SellerContext {
  showingStats:   Awaited<ReturnType<typeof getShowingStats>>
  recentFeedback: ShowingFeedback[]
  offerSummary:   Awaited<ReturnType<typeof getOfferSummary>>
  /** True when the caller is not entitled to this contact's seller data. The
   *  fields above are then empty because access was REFUSED, which is not the
   *  same statement as "this seller has no listing". */
  accessDenied:   boolean
}

/**
 * The seller portal's whole home-screen payload behind ONE authorization check.
 *
 * The denial branch used to return `{listing, transaction, contact, agent, …}` —
 * four keys that are not fields of `SellerContext` at all, and none of the five
 * that are (`contactId`, `contactName`, `metrics`, `transactionId`, `agentId`).
 * A caller that destructured the success shape got `undefined` for every one of
 * them the moment access was denied. That mismatch is why this aggregator was
 * never wired to the surface it was written for: it could not be consumed
 * safely. It now returns ONE shape, with `accessDenied` saying which case it is.
 */
export async function getSellerDashboardData(contactId: string): Promise<SellerDashboardData> {
  const emptyExtras = {
    showingStats:   { thisWeek: 0, total: 0, avgRating: null },
    recentFeedback: [] as ShowingFeedback[],
    offerSummary:   { total: 0, highest: null, accepted: null, pending: 0 },
  }

  const access = await requireContactAccess(contactId)
  if (!access.ok) {
    return {
      contactId,
      contactName:   "there",
      listing:       null,
      metrics:       null,
      transactionId: null,
      agentId:       null,
      ...emptyExtras,
      accessDenied:  true,
    }
  }

  const supabase = await createClient()

  // Get base seller context
  const context = await resolveSellerContext(supabase, contactId)

  if (!context.listing) {
    return { ...context, ...emptyExtras, accessDenied: false }
  }

  // Parallel data fetches
  const [showingStats, recentFeedback, offerSummary] = await Promise.all([
    getShowingStats(supabase, context.listing.id),
    getRecentFeedback(supabase, context.listing.id, 3),
    getOfferSummary(supabase, context.listing.id),
  ])

  return {
    ...context,
    showingStats,
    recentFeedback,
    offerSummary,
    accessDenied: false,
  }
}

// ─── LISTING DATA ─────────────────────────────────────────────────────────────

export async function getListingDetails(contactId: string) {
  const access = await requireContactAccess(contactId)
  if (!access.ok) {
    return { listing: null, metrics: null, engagement: [], priceHistory: [] }
  }

  const supabase = createServiceClient()

  // Get listing with all details — scoped to caller's brokerage to defend
  // against contact_id collisions across tenants
  const { data: listings } = await supabase
    .from("listings")
    .select(`
      id, contact_id, address, property_address:address, list_price, status, listing_status:status,
      listing_date, bedrooms, bathrooms, square_feet:sqft, description:public_remarks, primary_photo_url,
      lot_size, year_built, property_type
    `)
    .eq("seller_contact_id", contactId)
    .eq("brokerage_id", access.brokerageId)
    .order("listing_date", { ascending: false })
    .limit(1)

  const listingRow = listings?.[0] ?? null
  // dom (days on market) has no backing column — compute from listing_date
  const listing = listingRow
    ? {
        ...listingRow,
        dom: listingRow.listing_date
          ? Math.floor((Date.now() - new Date(listingRow.listing_date).getTime()) / 86400000)
          : null,
      }
    : null

  if (!listing) {
    return { listing: null, metrics: null, engagement: [], priceHistory: [] }
  }

  // Parallel fetches
  // listing_engagement was a writer-less legacy table (burn-down round 6 repoint) — the feed is
  // assembled from the WRITTEN engagement primitives (column usage mirrors lib/listings/listing-metrics-rollup.ts).
  const [metricsResult, viewsResult, savesResult, inquiriesResult, showingsResult, priceHistoryResult] = await Promise.all([
    supabase
      .from("listing_metrics")
      .select("*")
      .eq("listing_id", listing.id)
      .maybeSingle(),
    supabase
      .from("property_views")
      .select("id, first_viewed_at, last_viewed_at")
      .eq("brokerage_id", access.brokerageId)
      .eq("property_id", listing.id)
      .order("last_viewed_at", { ascending: false })
      .limit(100),
    supabase
      .from("saved_properties")
      .select("id, saved_at")
      .eq("brokerage_id", access.brokerageId)
      .eq("listing_id", listing.id)
      .eq("dismissed", false)
      .order("saved_at", { ascending: false })
      .limit(100),
    supabase
      .from("listing_inquiries")
      .select("id, created_at")
      .eq("brokerage_id", access.brokerageId)
      .eq("listing_id", listing.id)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("showings")
      .select("id, created_at, scheduled_at")
      .eq("brokerage_id", access.brokerageId)
      .eq("listing_id", listing.id)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("listing_price_changes")
      .select("id, old_price, new_price, change_date:created_at, reason:change_reason")
      .eq("listing_id", listing.id)
      .order("created_at", { ascending: false }),
  ])

  // Merged chronological feed in the legacy {id, event_type, event_date} shape.
  const engagement = [
    ...(viewsResult.data ?? []).map((v: any) => ({ id: v.id, event_type: "view", event_date: v.last_viewed_at ?? v.first_viewed_at })),
    ...(savesResult.data ?? []).map((s: any) => ({ id: s.id, event_type: "save", event_date: s.saved_at })),
    ...(inquiriesResult.data ?? []).map((i: any) => ({ id: i.id, event_type: "inquiry", event_date: i.created_at })),
    ...(showingsResult.data ?? []).map((s: any) => ({ id: s.id, event_type: "showing", event_date: s.scheduled_at ?? s.created_at })),
  ]
    .sort((a, b) => new Date(b.event_date ?? 0).getTime() - new Date(a.event_date ?? 0).getTime())
    .slice(0, 100)

  return {
    listing,
    metrics: metricsResult.data,
    engagement,
    priceHistory: priceHistoryResult.data ?? [],
  }
}

// ─── SHOWING DATA ─────────────────────────────────────────────────────────────

export async function getShowingInsights(contactId: string) {
  const access = await requireContactAccess(contactId)
  if (!access.ok) {
    return {
      showings: [],
      feedback: [],
      weeklyStats: [],
      sentimentBreakdown: { positive: 0, neutral: 0, negative: 0 },
    }
  }

  const supabase = createServiceClient()

  // Get listing first — scoped to caller's brokerage
  const { data: listings } = await supabase
    .from("listings")
    .select("id")
    .eq("seller_contact_id", contactId)
    .eq("brokerage_id", access.brokerageId)
    .order("listing_date", { ascending: false })
    .limit(1)

  const listingId = listings?.[0]?.id

  if (!listingId) {
    return {
      showings: [],
      feedback: [],
      weeklyStats: [],
      sentimentBreakdown: { positive: 0, neutral: 0, negative: 0 },
    }
  }

  // Get all showings with feedback
  const { data: showings } = await supabase
    .from("showings")
    .select(`
      id, showing_date:scheduled_at, status, notes,
      contact:contacts(id, first_name, last_name),
      showing_feedback(id, additional_notes, overall_impression, presentation_rating, created_at)
    `)
    .eq("listing_id", listingId)
    .order("scheduled_at", { ascending: false })

  const allShowings = showings ?? []

  // Extract all feedback
  const allFeedback: ShowingFeedback[] = []
  for (const showing of allShowings) {
    const feedbackList = (showing as any).showing_feedback ?? []
    for (const fb of feedbackList) {
      allFeedback.push({
        ...fb,
        showing: {
          showing_date: showing.showing_date,
          contact: showing.contact as any,
        },
      })
    }
  }

  // Calculate sentiment breakdown
  // showing_feedback has no `sentiment` column — it records `overall_impression`, whose
  // vocabulary is fixed by a CHECK constraint: love_it | like_it | maybe | no
  // (m568 — the ONE showing-verdict vocabulary, shared with
  // showings.buyer_interest_level and tour_stops.buyer_interest_level). The old
  // select also named `feedback_text` and `rating`, neither of which exists, so
  // PostgREST rejected the WHOLE showings query and this page's feedback was
  // empty by construction rather than by absence of feedback.
  // TOMBSTONE (m568 wave): the private POSITIVE/NEGATIVE sets that lived here
  // spelled the ladder's two ends locally; survivor:
  // lib/behavior-learning/signal-mapping.ts:148 isPositiveShowingInterest /
  // isNegativeShowingInterest.
  const sentimentBreakdown = { positive: 0, neutral: 0, negative: 0 }
  for (const fb of allFeedback) {
    const impression = (fb as any).overall_impression as string | null
    if (!impression) continue
    if (isPositiveShowingInterest(impression)) sentimentBreakdown.positive++
    else if (isNegativeShowingInterest(impression)) sentimentBreakdown.negative++
    else sentimentBreakdown.neutral++
  }

  // Calculate weekly showing stats (last 8 weeks)
  const weeklyStats: { week: string; count: number }[] = []
  const now = new Date()
  for (let i = 0; i < 8; i++) {
    const weekStart = new Date(now.getTime() - (i + 1) * 7 * 24 * 60 * 60 * 1000)
    const weekEnd = new Date(now.getTime() - i * 7 * 24 * 60 * 60 * 1000)
    const count = allShowings.filter((s) => {
      const date = new Date(s.showing_date)
      return date >= weekStart && date < weekEnd
    }).length
    weeklyStats.unshift({
      week: weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      count,
    })
  }

  return {
    showings: allShowings,
    feedback: allFeedback,
    weeklyStats,
    sentimentBreakdown,
  }
}

// ─── OFFER DATA ───────────────────────────────────────────────────────────────

// Column list hoisted out of the query chain so the tenant + release filters on
// the query itself stay auditable.
const SELLER_OFFER_COLUMNS = `
      id, listing_id, contact_id, transaction_id,
      offer_price, offer_amount:offer_price, status,
      created_at, submitted_at, offer_date:submitted_at,
      expiration_date:response_deadline, expires_at:response_deadline,
      close_date:closing_date, closing_date,
      earnest_money, down_payment_percent, financing_type, contingencies,
      closing_cost_contribution, seller_net_estimate, notes,
      presented_to_seller_at, seller_presentation_note,
      esign_status, esign_provider, esign_sent_at, esign_completed_at, buyer_signed_at,
      buyer:contacts(id, first_name, last_name, email, phone)
    `

/** The seller's own listing, matched on either seller key, tenant-anchored. */
async function resolveSellerListingRow(
  svc: ReturnType<typeof createServiceClient>,
  contactId: string,
  brokerageId: string,
): Promise<{ listing: any | null; error: string | null }> {
  const { data, error } = await svc
    .from("listings")
    .select("id, list_price, address, city, state, brokerage_id, hoa_dues, commission_rate")
    .or(`seller_contact_id.eq.${contactId},contact_id.eq.${contactId}`)
    .eq("brokerage_id", brokerageId)
    .order("listing_date", { ascending: false })
    .limit(1)
  if (error) return { listing: null, error: error.message }
  return { listing: data?.[0] ?? null, error: null }
}

/** First name + last initial — what a portal seller may know about a buyer. */
function redactBuyerName(buyer: { first_name?: string | null; last_name?: string | null } | null): string {
  if (!buyer) return "Buyer"
  const first = (buyer.first_name ?? "").trim() || "Buyer"
  const initial = buyer.last_name ? ` ${buyer.last_name.trim().charAt(0).toUpperCase()}.` : ""
  return `${first}${initial}`
}

/**
 * Every offer on the seller's listing — THE reader for the seller portal's
 * Offers screen (`app/portal/[contactId]/offers/page.tsx`).
 *
 * THE RELEASE GATE (wave 12, R4a). `offers.presented_to_seller_at` is NULL until
 * the listing agent releases the offer through
 * `app/actions/offers/present-to-seller.ts:presentOfferToSeller`. NULL means the
 * seller must not see it, and the filter below is applied ONLY for the seller's
 * own session: this same reader serves brokerage staff, who are working the deal
 * and must see everything on the listing, released or not. Status is deliberately
 * NOT the gate — `offers.status` carries no CHECK constraint, so an inbound row
 * written as "submitted" would otherwise land on the seller's screen the instant
 * the webhook returned.
 *
 * BUYER PII IS SCOPED BY WHO IS ASKING. `requireContactAccess` admits two very
 * different callers: the SELLER themselves in their portal, and staff of the
 * brokerage. The seller is entitled to know an offer exists and on what terms;
 * they are not entitled to the buyer's email address and phone number, which
 * belong to the buyer and (routinely) to a different brokerage. The previous
 * shape selected `contacts(id, first_name, last_name, email, phone)` and handed
 * it to whoever asked — including a portal session — and the page this replaces
 * did worse, selecting `contacts(*)`, the buyer's entire record.
 *
 * A seller gets first name + last initial. Staff get the full contact detail
 * they need to work the deal.
 *
 * Column names are explicit and verified against the live schema. The page's
 * `select("*")` hid three mismatches that rendered as missing data with no
 * error: `offers.close_date` and `offers.expires_at` do not exist (they are
 * `closing_date` / `response_deadline`) and `listings.price` does not exist
 * (it is `list_price`), so the seller's offer card showed "TBD" for the closing
 * date, never showed an expiry, and computed NaN% against the asking price.
 * The aliases below keep the existing render code working against real columns.
 */
export async function getSellerOffers(contactId: string) {
  const access = await requireContactAccess(contactId)
  if (!access.ok) return { offers: [], listPrice: null, error: "Forbidden" as string | null }

  const supabase = createServiceClient()

  // Get listing first — scoped to the contact's brokerage. Matched on EITHER
  // seller key: `seller_contact_id` is the canonical one, but portal surfaces
  // have historically resolved a seller's listing through `contact_id`, and a
  // listing keyed only the other way must not read back as "no listing".
  // supabase-js resolves a refused query — an empty list must not be reported
  // as "you have no offers" when the read was actually denied.
  const { listing, error: listingErr } = await resolveSellerListingRow(supabase, contactId, access.brokerageId)
  if (listingErr) return { offers: [], listPrice: null, error: listingErr }

  if (!listing) {
    return { offers: [], listPrice: null, error: null }
  }

  let offersQuery = supabase
    .from("offers")
    .select(SELLER_OFFER_COLUMNS)
    .eq("listing_id", listing.id)
  if (access.isContactSelf) {
    offersQuery = offersQuery.not("presented_to_seller_at", "is", null)
  }
  const { data: offers, error: offersErr } = await offersQuery.order("offer_price", { ascending: false })
  if (offersErr) return { offers: [], listPrice: listing.list_price, error: offersErr.message }

  const scoped = (offers ?? []).map((o: any) => {
    const buyer = o.buyer as { id?: string; first_name?: string | null; last_name?: string | null; email?: string | null; phone?: string | null } | null
    if (!buyer) return o
    if (access.isContactSelf) {
      const lastInitial = buyer.last_name ? `${buyer.last_name.trim().charAt(0).toUpperCase()}.` : ""
      return {
        ...o,
        buyer: {
          id:         buyer.id,
          first_name: buyer.first_name ?? "Buyer",
          last_name:  lastInitial,
          // email / phone deliberately absent — the seller's agent brokers
          // contact between the parties; the portal is not a directory of the
          // other side's clients.
        },
      }
    }
    return o
  })

  return {
    offers: scoped,
    listPrice: listing.list_price,
    error: null as string | null,
  }
}

// ─── INTERACTIVE NET SHEET INPUTS (R4b) ───────────────────────────────────────

export interface SellerNetSheetInputs {
  listingAddress: string | null
  /** Only RELEASED offers. An offer the agent has not approved is not an input. */
  offers: OfferNetInput[]
  costs: Omit<SellerCosts, "buyerClosingCredit"> | null
  closingCostSection: NetSheetClosingCostSection | null
  /** Commission provenance — never present a default as the agreed rate. */
  commission: { label: string; isEstimate: boolean; rate: number; isFlatFee: boolean } | null
  error: string | null
}

/**
 * Everything `app/components/features/offers/interactive-net-sheet.tsx` needs to
 * render on the SELLER's screen in read-only mode.
 *
 * That component's own header has always said it is "reusable by the seller
 * portal (read-only mode via `readOnly`)" — and until this wave its only importer
 * was the agent's offer view. This is the missing wire. It is NOT a replacement
 * for `NetSheetCalculator`: that one is the seller's single-offer what-if they
 * edit; this one RANKS the released offers by what the seller actually keeps.
 *
 * The cost assumptions carry the same honesty the agent's page carries. The
 * seller pays BOTH sides of the commission, so a listing-side-only rate
 * understates the commission and overstates the net — on the screen where the
 * seller forms an opinion about which offer to take. `resolveAgreedCommission`
 * is the one resolver, and it flags anything below an executed agreement as an
 * estimate so the label can say so.
 */
export async function getSellerNetSheetInputs(contactId: string): Promise<SellerNetSheetInputs> {
  const empty: SellerNetSheetInputs = {
    listingAddress: null, offers: [], costs: null, closingCostSection: null, commission: null, error: null,
  }

  const access = await requireContactAccess(contactId)
  if (!access.ok) return { ...empty, error: "Forbidden" }

  const svc = createServiceClient()
  const { listing, error: listingErr } = await resolveSellerListingRow(svc, contactId, access.brokerageId)
  if (listingErr) return { ...empty, error: listingErr }
  if (!listing) return empty

  const { data: released, error: releasedErr } = await svc
    .from("offers")
    .select("id, offer_price, financing_type, closing_cost_contribution, status, contact_id, buyer:contacts(first_name, last_name)")
    .eq("listing_id", listing.id)
    .eq("brokerage_id", access.brokerageId)
    .not("presented_to_seller_at", "is", null)
    .order("offer_price", { ascending: false })
  if (releasedErr) return { ...empty, listingAddress: listing.address ?? null, error: releasedErr.message }

  // The net sheet is a seller-facing artifact even when staff are previewing it,
  // so the buyer label is the redacted one on both paths.
  const netInputs: OfferNetInput[] = (released ?? []).map((o: any) => ({
    offerId: o.id,
    buyerName: redactBuyerName(o.buyer ?? null),
    offerPrice: Number(o.offer_price ?? 0),
    financingType: o.financing_type ?? null,
    buyerClosingCredit: o.closing_cost_contribution != null ? Number(o.closing_cost_contribution) : 0,
  }))

  const { data: agreement, error: agreementErr } = await svc
    .from("listing_agreements")
    .select("listing_commission_rate, buyer_commission_rate, total_commission_rate, commission_is_flat_fee, commission_flat_amount, seller_transaction_fee, fully_executed_at")
    .eq("listing_id", listing.id)
    .eq("brokerage_id", access.brokerageId)
    .order("fully_executed_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle()
  if (agreementErr) {
    return { ...empty, listingAddress: listing.address ?? null, error: agreementErr.message }
  }

  const listPrice = listing.list_price != null ? Number(listing.list_price) : null
  const agreed = resolveAgreedCommission({
    agreement: agreement as any,
    listingCommissionRatePercent: listing.commission_rate ?? null,
    referencePrice: listPrice,
  })

  const costs = defaultSellerCosts({
    listPrice,
    commissionRateDecimal: agreed.rate,
    hoaDuesMonthly: listing.hoa_dues != null ? Number(listing.hoa_dues) : null,
    transactionFee: (agreement as any)?.seller_transaction_fee ?? null,
  })
  const closingCostSection = deriveNetSheetClosingCostSection(listPrice, listing.state ?? null)
  if (closingCostSection) costs.otherProratedFees = closingCostSection.midpoint

  return {
    listingAddress: listing.address ?? null,
    offers: netInputs,
    costs,
    closingCostSection,
    commission: { label: agreed.label, isEstimate: agreed.isEstimate, rate: agreed.rate, isFlatFee: agreed.isFlatFee },
    error: null,
  }
}

// ─── THE PERSISTED MULTI-OFFER COMPARISON (R4c) ───────────────────────────────

export type SellerComparisonCoverage = "exact" | "stale" | "withheld" | "none"

export interface SellerOfferComparison {
  coverage: SellerComparisonCoverage
  generatedAt: string | null
  /** Per-offer rows, buyer identity redacted to what a seller may know. */
  rows: Array<{
    offerId: string
    buyerLabel: string
    offerPrice: number | null
    netToSeller: number | null
    financingType: string | null
    downPaymentPercent: number | null
    contingenciesCount: number | null
    daysToClose: number | null
    isRecommended: boolean
  }>
  recommendation: string | null
  /** Released offers this comparison does not cover (coverage === "stale"). */
  missingOfferCount: number
  error: string | null
}

/**
 * The SELLER's door onto the comparison the agent already generated and PERSISTED
 * (`offer_comparison`, written by lib/offers/offer-analyzer.ts:analyzeAndCompareOffers
 * — the one analyzer seller-offers.ts:triggerOfferComparison delegates to — and by
 * kernel/offers.ts:compareOffersForListing).
 *
 * `ai_recommendation` reached this reader as a permanent NULL until wave 13: the
 * analyzer produced the recommendation, handed it back to its caller, and
 * persisted nothing. The column now carries the verdict the model actually gave.
 *
 * This does NOT build a fourth comparison and does NOT re-run inference. The
 * portal used to call `analyzeMultipleOffers` on EVERY page load, which both
 * re-burned paid AI and could never have worked for an actual seller — that
 * action authenticates through a brokerage-staff gate a portal contact cannot
 * pass. `loadLatestOfferComparison` is its agent-side twin; this is the same read
 * behind the portal's own authorization, with two rules the agent's copy does not
 * need:
 *
 *  1. A comparison that covers an offer the agent has NOT released must not leak
 *     it. If the persisted row names any offer outside the released set, nothing
 *     is rendered and the seller is told a comparison exists but is not theirs to
 *     see yet.
 *  2. The persisted matrix carries the buyer's FULL name (the analyzer builds it
 *     from first_name + last_name). A portal seller gets first name + last
 *     initial here, exactly as they do on the offer cards.
 */
export async function getSellerOfferComparison(contactId: string): Promise<SellerOfferComparison> {
  const empty: SellerOfferComparison = {
    coverage: "none", generatedAt: null, rows: [], recommendation: null, missingOfferCount: 0, error: null,
  }

  const access = await requireContactAccess(contactId)
  if (!access.ok) return { ...empty, error: "Forbidden" }

  const svc = createServiceClient()
  const { listing, error: listingErr } = await resolveSellerListingRow(svc, contactId, access.brokerageId)
  if (listingErr) return { ...empty, error: listingErr }
  if (!listing) return empty

  const { data: released, error: releasedErr } = await svc
    .from("offers")
    .select("id, offer_price, buyer:contacts(first_name, last_name)")
    .eq("listing_id", listing.id)
    .eq("brokerage_id", access.brokerageId)
    .not("presented_to_seller_at", "is", null)
  if (releasedErr) return { ...empty, error: releasedErr.message }

  const releasedIds = new Set((released ?? []).map((o: any) => o.id))
  const labelById = new Map<string, string>()
  ;(released ?? []).forEach((o: any) => {
    labelById.set(o.id, redactBuyerName(o.buyer ?? null))
  })
  if (releasedIds.size === 0) return empty

  const { data: comparison, error: compErr } = await svc
    .from("offer_comparison")
    .select("id, offer_ids, comparison_matrix, net_to_seller_by_offer, ai_recommendation, recommended_offer_id, created_at")
    .eq("listing_id", listing.id)
    .eq("brokerage_id", access.brokerageId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (compErr) return { ...empty, error: compErr.message }
  if (!comparison) return empty

  const comparedIds: string[] = Array.isArray(comparison.offer_ids) ? comparison.offer_ids.filter(Boolean) : []
  if (comparedIds.length === 0) return empty

  // RULE 1 — a comparison that reaches beyond what the seller may see is withheld
  // whole. Filtering it down would still tell the seller how many other offers
  // exist and how theirs rank against them.
  const coversUnreleased = comparedIds.some((id) => !releasedIds.has(id))
  if (coversUnreleased) {
    return { ...empty, coverage: "withheld", generatedAt: comparison.created_at ?? null }
  }

  const matrix: any[] = Array.isArray(comparison.comparison_matrix) ? comparison.comparison_matrix : []
  const netByOffer: Record<string, number> = (comparison.net_to_seller_by_offer ?? {}) as Record<string, number>

  const rows = comparedIds.map((offerId) => {
    const m = matrix.find((row: any) => row?.offer_id === offerId) ?? {}
    const net = netByOffer[offerId]
    return {
      offerId,
      // RULE 2 — the persisted buyer_name is discarded, not trusted.
      buyerLabel: labelById.get(offerId) ?? "Buyer",
      offerPrice: m.offer_price != null ? Number(m.offer_price) : null,
      netToSeller: net != null ? Number(net) : (m.net_to_seller != null ? Number(m.net_to_seller) : null),
      financingType: m.financing_type ?? null,
      downPaymentPercent: m.down_payment_percent != null ? Number(m.down_payment_percent) : null,
      contingenciesCount: m.contingencies_count != null ? Number(m.contingencies_count) : null,
      daysToClose: m.days_to_close != null ? Number(m.days_to_close) : null,
      isRecommended: comparison.recommended_offer_id === offerId,
    }
  })
  rows.sort((a, b) => (b.netToSeller ?? b.offerPrice ?? 0) - (a.netToSeller ?? a.offerPrice ?? 0))

  const missingOfferCount = [...releasedIds].filter((id) => !comparedIds.includes(id as string)).length

  return {
    coverage: missingOfferCount > 0 ? "stale" : "exact",
    generatedAt: comparison.created_at ?? null,
    rows,
    recommendation: comparison.ai_recommendation ?? null,
    missingOfferCount,
    error: null,
  }
}

// ─── MARKET DATA ──────────────────────────────────────────────────────────────

export async function getMarketPosition(contactId: string) {
  const access = await requireContactAccess(contactId)
  if (!access.ok) return { report: null, comparison: null }

  const supabase = createServiceClient()

  // Get listing first — scoped to caller's brokerage
  const { data: listings } = await supabase
    .from("listings")
    .select("id, list_price")
    .eq("seller_contact_id", contactId)
    .eq("brokerage_id", access.brokerageId)
    .order("listing_date", { ascending: false })
    .limit(1)

  const listing = listings?.[0]

  if (!listing) {
    return { report: null, comparison: null }
  }

  // Get neighborhood report if available
  const { data: report } = await supabase
    .from("neighborhood_reports")
    .select("id, listing_id, median_home_price, ai_summary, generated_at")
    .eq("listing_id", listing.id)
    .order("generated_at", { ascending: false })
    .maybeSingle()

  let comparison: "above" | "below" | "at" | null = null
  if (report?.median_home_price && listing.list_price) {
    const diff = listing.list_price - report.median_home_price
    const pctDiff = (diff / report.median_home_price) * 100
    if (pctDiff > 5) comparison = "above"
    else if (pctDiff < -5) comparison = "below"
    else comparison = "at"
  }

  return { report, comparison }
}

// ─── VENDOR DATA ──────────────────────────────────────────────────────────────

/**
 * Vendor assignments on the seller's transaction.
 *
 * Every branch returns the SAME `{ assignments, error }` shape so the caller can
 * tell "there are no vendors on this deal" apart from "we could not find out".
 * An empty list rendered without that distinction is an assertion the data does
 * not support.
 */
export async function getSellerVendors(contactId: string, transactionId: string | null) {
  const access = await requireContactAccess(contactId)
  if (!access.ok) return { assignments: [], error: "Forbidden" as string | null }

  if (!transactionId) {
    return { assignments: [], error: null as string | null }
  }

  const supabase = createServiceClient()

  // Verify the transaction belongs to caller's brokerage AND involves this contact
  const { data: tx, error: txError } = await supabase
    .from("transactions")
    .select("brokerage_id, buyer_contact_id, seller_contact_id, contact_id")
    .eq("id", transactionId)
    .maybeSingle()
  if (txError) {
    console.error(`[portal-seller] transaction lookup failed for ${transactionId}: ${txError.message}`)
    return { assignments: [], error: txError.message as string | null }
  }
  if (!tx || tx.brokerage_id !== access.brokerageId) {
    return { assignments: [], error: null as string | null }
  }
  const contactOnTx =
    tx.buyer_contact_id === contactId ||
    tx.seller_contact_id === contactId ||
    tx.contact_id === contactId
  // If caller is the contact themselves, require contact-on-transaction.
  // Agents in the same brokerage can already see the transaction.
  if (access.isContactSelf && !contactOnTx) {
    return { assignments: [], error: null as string | null }
  }

  // `vendors` HAS NO business_name / vendor_type / rating_avg. The live columns
  // are `name`, `category` and `rating` — m355 ("one vendor system") absorbed
  // vendor_directory INTO vendors, so there is no second relation these names
  // could have belonged to; they are simply wrong. PostgREST rejected the WHOLE
  // query, and because the result was destructured without `error`, the seller
  // portal's Vendors card rendered "Vendor assignments will appear here" —
  // telling a seller they have no vendors when the read had in fact failed.
  //
  // Aliased rather than renamed: app/portal/[contactId]/seller-home.tsx reads
  // `va.vendor?.business_name` / `va.vendor?.vendor_type` on the rendered card,
  // and buyer-home.tsx selects the same pair, so keeping the consumed keys makes
  // both portals return an identical vendor shape with no consumer rewrite.
  const { data: assignments, error: assignmentsError } = await supabase
    .from("vendor_assignments")
    .select(`
      id, assignment_type, status, scheduled_date, notes,
      vendor:vendors(id, business_name:name, vendor_type:category, phone, email, rating_avg:rating)
    `)
    .eq("transaction_id", transactionId)
    .eq("brokerage_id", access.brokerageId)

  if (assignmentsError) {
    console.error(`[portal-seller] vendor assignments read failed for transaction ${transactionId}: ${assignmentsError.message}`)
    return { assignments: [], error: assignmentsError.message }
  }

  return { assignments: assignments ?? [], error: null as string | null }
}

// ─── DOCUMENT DATA ────────────────────────────────────────────────────────────

export async function getSellerDocuments(contactId: string, transactionId: string | null) {
  const access = await requireContactAccess(contactId)
  if (!access.ok) return { clientDocuments: [], transactionDocuments: [] }

  const supabase = createServiceClient()

  // Get client documents — scoped to caller's brokerage
  const { data: clientDocs } = await supabase
    .from("client_documents")
    .select("id, document_type, file_name:document_name, file_url:document_url, created_at, status")
    .eq("contact_id", contactId)
    .eq("brokerage_id", access.brokerageId)
    .order("created_at", { ascending: false })

  // Get transaction documents if we have a transaction; verify ownership first
  let transactionDocs: any[] = []
  if (transactionId) {
    const { data: tx } = await supabase
      .from("transactions")
      .select("brokerage_id, buyer_contact_id, seller_contact_id, contact_id")
      .eq("id", transactionId)
      .maybeSingle()
    const txValid =
      !!tx &&
      tx.brokerage_id === access.brokerageId &&
      (!access.isContactSelf ||
        tx.buyer_contact_id === contactId ||
        tx.seller_contact_id === contactId ||
        tx.contact_id === contactId)
    if (txValid) {
      const { data: txDocs } = await supabase
        .from("transaction_documents")
        .select("id, document_type:doc_type, file_name:doc_label, file_url:storage_url, created_at, status")
        .eq("transaction_id", transactionId)
        .eq("brokerage_id", access.brokerageId)
        .order("created_at", { ascending: false })

      transactionDocs = txDocs ?? []
    }
  }

  return {
    clientDocuments: clientDocs ?? [],
    transactionDocuments: transactionDocs,
  }
}

// ─── KERNEL EVENT EMISSION ────────────────────────────────────────────────────

export async function emitSellerPortalViewed(contactId: string, moduleName?: string) {
  const access = await requireContactAccess(contactId)
  if (!access.ok) return

  const supabase = createServiceClient()

  // Track which module was viewed in client_portal_activity for analytics
  if (moduleName) {
    // `.then(ok, err)` CANNOT REPORT THIS. supabase-js RESOLVES a refused write
    // rather than rejecting, so the rejection arm never ran and a denied insert
    // left no trace anywhere — the one thing an analytics row exists to avoid.
    // Awaited and destructured; still non-fatal, because a lost view-count must
    // not stop a seller seeing their own portal.
    const viewRow = {
      contact_id: contactId,
      brokerage_id: access.brokerageId,
      activity_type: "portal_module_viewed",
      metadata: { module: moduleName, viewed_at: new Date().toISOString() },
    }
    const { error: viewError } = await supabase.from("client_portal_activity").insert(viewRow)
    if (viewError) {
      console.error(`[portal-seller] module-view activity NOT recorded for contact ${contactId}: ${viewError.message}`)
    }
  }

  await processKernelEvent({
    event: KernelEvent.PORTAL_MODULE_VIEWED,
    brokerageId: access.brokerageId,
    entityType: "contact",
    entityId: contactId,
  }).then(() => {}, (err) => { console.error("[portal-seller] kernel event failed:", err) })
}
