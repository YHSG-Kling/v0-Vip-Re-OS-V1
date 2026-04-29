"use server"

// app/actions/portal-seller.ts
// Server actions for seller portal data fetching.
// All queries scoped to contactId for security.

import { createClient } from "@/lib/supabase/server"
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

// ─── SELLER CONTEXT ───────────────────────────────────────────────────────────

export async function getSellerDashboardData(contactId: string) {
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
  const supabase = await createClient()

  // Get listing with all details
  const { data: listings } = await supabase
    .from("listings")
    .select(`
      id, contact_id, address, property_address, list_price, status, listing_status,
      listing_date, dom, bedrooms, bathrooms, square_feet, description, primary_photo_url,
      lot_size, year_built, property_type, listing_type
    `)
    .eq("seller_contact_id", contactId)
    .order("listing_date", { ascending: false })
    .limit(1)

  const listing = listings?.[0] ?? null

  if (!listing) {
    return { listing: null, metrics: null, engagement: [], priceHistory: [] }
  }

  // Parallel fetches
  const [metricsResult, engagementResult, priceHistoryResult] = await Promise.all([
    supabase
      .from("listing_metrics")
      .select("*")
      .eq("listing_id", listing.id)
      .maybeSingle(),
    supabase
      .from("listing_engagement")
      .select("id, event_type, event_date, source")
      .eq("listing_id", listing.id)
      .order("event_date", { ascending: false })
      .limit(100),
    supabase
      .from("listing_price_changes")
      .select("id, old_price, new_price, change_date, reason")
      .eq("listing_id", listing.id)
      .order("change_date", { ascending: false }),
  ])

  return {
    listing,
    metrics: metricsResult.data,
    engagement: engagementResult.data ?? [],
    priceHistory: priceHistoryResult.data ?? [],
  }
}

// ─── SHOWING DATA ─────────────────────────────────────────────────────────────

export async function getShowingInsights(contactId: string) {
  const supabase = await createClient()

  // Get listing first
  const { data: listings } = await supabase
    .from("listings")
    .select("id")
    .eq("seller_contact_id", contactId)
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
      id, showing_date, status, notes,
      contact:contacts(id, first_name, last_name),
      showing_feedback(id, feedback_text, sentiment, rating, created_at)
    `)
    .eq("listing_id", listingId)
    .order("showing_date", { ascending: false })

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
  const sentimentBreakdown = { positive: 0, neutral: 0, negative: 0 }
  for (const fb of allFeedback) {
    if ((fb as any).sentiment === "positive") sentimentBreakdown.positive++
    else if ((fb as any).sentiment === "neutral") sentimentBreakdown.neutral++
    else if ((fb as any).sentiment === "negative") sentimentBreakdown.negative++
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
  const supabase = await createClient()

  // Get listing first
  const { data: listings } = await supabase
    .from("listings")
    .select("id, list_price")
    .eq("seller_contact_id", contactId)
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
      id, listing_id, contact_id, offer_amount, status, offer_date, expiration_date,
      earnest_money, down_payment_percent, contingencies, notes,
      buyer:contacts(id, first_name, last_name, email, phone)
    `)
    .eq("listing_id", listing.id)
    .order("offer_date", { ascending: false })

  return {
    offers: offers ?? [],
    listPrice: listing.list_price,
  }
}

// ─── MARKET DATA ──────────────────────────────────────────────────────────────

export async function getMarketPosition(contactId: string) {
  const supabase = await createClient()

  // Get listing first
  const { data: listings } = await supabase
    .from("listings")
    .select("id, list_price")
    .eq("seller_contact_id", contactId)
    .order("listing_date", { ascending: false })
    .limit(1)

  const listing = listings?.[0]

  if (!listing) {
    return { report: null, comparison: null }
  }

  // Get neighborhood report if available
  const { data: report } = await supabase
    .from("neighborhood_reports")
    .select("id, listing_id, median_home_price, ai_summary, generated_at, comparable_count")
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
  const supabase = await createClient()

  if (!transactionId) {
    return { assignments: [] }
  }

  const { data: assignments } = await supabase
    .from("vendor_assignments")
    .select(`
      id, assignment_type, status, scheduled_date, notes,
      vendor:vendors(id, business_name, vendor_type, phone, email, rating_avg)
    `)
    .eq("transaction_id", transactionId)

  return { assignments: assignments ?? [] }
}

// ─── DOCUMENT DATA ────────────────────────────────────────────────────────────

export async function getSellerDocuments(contactId: string, transactionId: string | null) {
  const supabase = await createClient()

  // Get client documents
  const { data: clientDocs } = await supabase
    .from("client_documents")
    .select("id, document_type, file_name, file_url, created_at, status")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })

  // Get transaction documents if we have a transaction
  let transactionDocs: any[] = []
  if (transactionId) {
    const { data: txDocs } = await supabase
      .from("transaction_documents")
      .select("id, document_type, file_name, file_url, created_at, status")
      .eq("transaction_id", transactionId)
      .order("created_at", { ascending: false })

    transactionDocs = txDocs ?? []
  }

  return {
    clientDocuments: clientDocs ?? [],
    transactionDocuments: transactionDocs,
  }
}

// ─── KERNEL EVENT EMISSION ────────────────────────────────────────────────────

export async function emitSellerPortalViewed(contactId: string, moduleName?: string) {
  const supabase = await createClient()

  const { data: contact } = await supabase
    .from("contacts")
    .select("brokerage_id")
    .eq("id", contactId)
    .maybeSingle()
  const brokerageId = contact?.brokerage_id
  if (!brokerageId) return

  // Track which module was viewed in client_portal_activity for analytics
  if (moduleName) {
    supabase.from("client_portal_activity").insert({
      contact_id: contactId,
      activity_type: "portal_module_viewed",
      activity_data: { module: moduleName, viewed_at: new Date().toISOString() },
    }).then(() => {}, (err) => console.error("[portal-seller] activity tracking failed:", err))
  }

  await processKernelEvent({
    event: KernelEvent.PORTAL_MODULE_VIEWED,
    brokerageId,
    entityType: "contact",
    entityId: contactId,
  }).then(() => {}, (err) => { console.error("[portal-seller] kernel event failed:", err) })
}
