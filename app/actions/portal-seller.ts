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
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import {
  resolveSellerContext,
  getShowingStats,
  getRecentFeedback,
  getOfferSummary,
  type SellerContext,
  type ShowingFeedback,
  type OfferData,
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
  if (callerRow?.brokerage_id === contact.brokerage_id && ["agent","team_lead","tc","admin","broker","superadmin"].includes(((callerRow as any)?.user_type) ?? "")) {
    return { ok: true, userId: authUser.id, brokerageId: contact.brokerage_id, isContactSelf: false }
  }

  return { ok: false }
}

// ─── SELLER CONTEXT ───────────────────────────────────────────────────────────

export async function getSellerDashboardData(contactId: string) {
  const access = await requireContactAccess(contactId)
  if (!access.ok) {
    return {
      listing: null,
      transaction: null,
      contact: null,
      agent: null,
      showingStats: { thisWeek: 0, total: 0, avgRating: null },
      recentFeedback: [],
      offerSummary: { total: 0, highest: null, accepted: null, pending: 0 },
    }
  }

  const supabase = await createClient()

  // Get base seller context
  const context = await resolveSellerContext(supabase, contactId)

  if (!context.listing) {
    return {
      ...context,
      showingStats: { thisWeek: 0, total: 0, avgRating: null },
      recentFeedback: [],
      offerSummary: { total: 0, highest: null, accepted: null, pending: 0 },
    }
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
  // vocabulary is fixed by a CHECK constraint: loved_it | liked_it | neutral |
  // not_interested. The old select also named `feedback_text` and `rating`, neither of
  // which exists, so PostgREST rejected the WHOLE showings query and this page's
  // feedback was empty by construction rather than by absence of feedback.
  const POSITIVE = new Set(["loved_it", "liked_it"])
  const NEGATIVE = new Set(["not_interested"])
  const sentimentBreakdown = { positive: 0, neutral: 0, negative: 0 }
  for (const fb of allFeedback) {
    const impression = (fb as any).overall_impression as string | null
    if (!impression) continue
    if (POSITIVE.has(impression)) sentimentBreakdown.positive++
    else if (NEGATIVE.has(impression)) sentimentBreakdown.negative++
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

export async function getSellerOffers(contactId: string) {
  const access = await requireContactAccess(contactId)
  if (!access.ok) return { offers: [], listPrice: null }

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
    return { offers: [], listPrice: null }
  }

  // Get all offers for this listing
  const { data: offers } = await supabase
    .from("offers")
    .select(`
      id, listing_id, contact_id, offer_amount:offer_price, status, offer_date:submitted_at, expiration_date:response_deadline,
      earnest_money, down_payment_percent, contingencies, notes,
      buyer:contacts(id, first_name, last_name, email, phone)
    `)
    .eq("listing_id", listing.id)
    .order("submitted_at", { ascending: false })

  return {
    offers: offers ?? [],
    listPrice: listing.list_price,
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

export async function getSellerVendors(contactId: string, transactionId: string | null) {
  const access = await requireContactAccess(contactId)
  if (!access.ok) return { assignments: [] }

  if (!transactionId) {
    return { assignments: [] }
  }

  const supabase = createServiceClient()

  // Verify the transaction belongs to caller's brokerage AND involves this contact
  const { data: tx } = await supabase
    .from("transactions")
    .select("brokerage_id, buyer_contact_id, seller_contact_id, contact_id")
    .eq("id", transactionId)
    .maybeSingle()
  if (!tx || tx.brokerage_id !== access.brokerageId) {
    return { assignments: [] }
  }
  const contactOnTx =
    tx.buyer_contact_id === contactId ||
    tx.seller_contact_id === contactId ||
    tx.contact_id === contactId
  // If caller is the contact themselves, require contact-on-transaction.
  // Agents in the same brokerage can already see the transaction.
  if (access.isContactSelf && !contactOnTx) {
    return { assignments: [] }
  }

  const { data: assignments } = await supabase
    .from("vendor_assignments")
    .select(`
      id, assignment_type, status, scheduled_date, notes,
      vendor:vendors(id, business_name, vendor_type, phone, email, rating_avg)
    `)
    .eq("transaction_id", transactionId)
    .eq("brokerage_id", access.brokerageId)

  return { assignments: assignments ?? [] }
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
    supabase.from("client_portal_activity").insert({
      contact_id: contactId,
      brokerage_id: access.brokerageId,
      activity_type: "portal_module_viewed",
      metadata: { module: moduleName, viewed_at: new Date().toISOString() },
    }).then(() => {}, (err) => console.error("[portal-seller] activity tracking failed:", err))
  }

  await processKernelEvent({
    event: KernelEvent.PORTAL_MODULE_VIEWED,
    brokerageId: access.brokerageId,
    entityType: "contact",
    entityId: contactId,
  }).then(() => {}, (err) => { console.error("[portal-seller] kernel event failed:", err) })
}
