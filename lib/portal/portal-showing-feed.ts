// lib/portal/portal-showing-feed.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE SHAPE the portal's showings/feedback surfaces render — and the merge
// that fills it from the two tables that actually hold the facts.
//
// ── THE ORPHAN THIS CLOSES (CLAUDE.md §1: a reader whose writer is a different
//    table entirely) ─────────────────────────────────────────────────────────
// app/components/portal/PersonaPropertiesDashboard.tsx renders three tabs off a
// `showings` prop — "Showings", "My Showings" (seller) and "Buyer Feedback" —
// and reads FIVE fields off each row:
//
//     showing.confirmed_date · showing.buyer_name · showing.buyer_feedback
//     showing.buyer_concerns · showing.buyer_interest_level
//
// app/portal/[contactId]/properties/page.tsx fed that prop from
// `showing_requests`, whose live columns are the REQUEST (buyer agent contact
// details, requested_date/start/end, seller_approved, status, property_*). It has
// none of those five. So every one of them was `undefined` on every row:
//
//   · the interest badge (line ~2374) never rendered — the named finding
//   · "With Feedback" counted 0 forever, and both feedback tabs showed the
//     "No Feedback Yet" empty state on every listing, for every seller
//   · "Upcoming"/"Completed" filtered status against `scheduled`/`confirmed`/
//     `completed`, which are `showings.status` values — showing_requests.status
//     admits approved|cancelled|denied|needs_reschedule|pending, so those
//     buckets were structurally empty too
//   · buyer name and date fell through to "Prospective Buyer" / "Time TBD"
//
// The verdict fields are real, they just live on `showings`
// (feedback, rating, buyer_interest_level, buyer_agent_name, scheduled_at,
// completed_at, notes, status). `showing_requests.converted_showing_id` is the
// FK that joins the two. So: no duplicate to merge and the capability is plainly
// wanted → BUILD the missing half, once, here, rather than in three JSX blocks.
//
// PURE. No client, no session — the caller does the two queries and hands the
// rows in, so this is unit-testable (scripts/portal-showing-feed-simulator.ts).
//
// VOCABULARY (§6). `showings.buyer_interest_level` carries the live CHECK
// love_it | like_it | maybe | no. The dashboard compared it against
// "high"/"medium" — a FOURTH spelling of the per-showing verdict, and one no
// column has ever held. The band below is DERIVED from the single owner of that
// ladder, lib/behavior-learning/signal-mapping.ts::tourInterestToRating, so a
// widened CHECK fails that module's proof instead of silently leaving a rung
// unmapped here.

import { tourInterestToRating } from "@/lib/behavior-learning/signal-mapping"

/** A `showing_requests` row, as much of it as the merge reads. */
export interface ShowingRequestRow {
  id: string
  listing_id?: string | null
  contact_id?: string | null
  property_address?: string | null
  requested_date?: string | null
  requested_start_time?: string | null
  status?: string | null
  converted_showing_id?: string | null
  buyer_agent_name?: string | null
  [k: string]: unknown
}

/** A `showings` row, as much of it as the merge reads. */
export interface ShowingRow {
  id: string
  listing_id?: string | null
  contact_id?: string | null
  scheduled_at?: string | null
  completed_at?: string | null
  status?: string | null
  feedback?: string | null
  notes?: string | null
  rating?: number | null
  buyer_interest_level?: string | null
  buyer_agent_name?: string | null
  external_address?: string | null
  [k: string]: unknown
}

/**
 * The coarse lifecycle word the portal renders. `showings.status` has NO CHECK;
 * its writers use scheduled | confirmed | completed | cancelled | rescheduled |
 * requested | error (scanned over comment-stripped source, 2026-08-26), and
 * `showing_requests.status` admits approved | cancelled | denied |
 * needs_reschedule | pending. Both are folded onto these five so the UI has ONE
 * set to branch on.
 */
export const PORTAL_SHOWING_STATUSES = ["pending", "scheduled", "confirmed", "completed", "cancelled"] as const
export type PortalShowingStatus = (typeof PORTAL_SHOWING_STATUSES)[number]

/** The interest band a badge renders. `maybe` is deliberately neither high nor low. */
export type PortalInterestBand = "high" | "medium" | "low"

/** THE ONE ROW SHAPE the portal showings/feedback tabs render. */
export interface PortalShowingRow {
  id: string
  listingId: string | null
  propertyAddress: string | null
  /** When the showing actually happens/happened — ISO, or null if not yet set. */
  showingAt: string | null
  status: PortalShowingStatus
  /** Who walked the home. The buyer's own agent, never the buyer's PII. */
  buyerName: string | null
  /** Free-text verdict the showing agent left. */
  buyerFeedback: string | null
  /** Concerns raised at the showing, when recorded separately from the verdict. */
  buyerConcerns: string | null
  /** The canonical love_it|like_it|maybe|no value, untranslated. */
  buyerInterestLevel: string | null
  /** Derived badge band — null when nobody recorded a verdict. */
  interestBand: PortalInterestBand | null
  /** 1-5, when the showing agent left a star rating. */
  rating: number | null
}

/**
 * PURE — the badge band for a per-showing verdict, on the ONE ladder.
 * love_it/like_it → high · maybe → medium · no/not_for_us → low · unrated → null.
 * "We never asked" is not "they disliked it", so an unrated showing gets no badge.
 */
export function showingInterestBand(interestLevel: string | null | undefined): PortalInterestBand | null {
  const rating = tourInterestToRating(interestLevel)
  if (rating === null) return null
  if (rating >= 4) return "high"
  if (rating <= 2) return "low"
  return "medium"
}

/** PURE — the human words a band renders as. */
export function interestBandLabel(band: PortalInterestBand | null): string | null {
  switch (band) {
    case "high":   return "Very Interested"
    case "medium": return "Interested"
    case "low":    return "Not For Them"
    default:       return null
  }
}

/**
 * PURE — fold the two status vocabularies onto PORTAL_SHOWING_STATUSES.
 * The SHOWING wins when one exists: a request that was approved and then walked
 * is "completed", not "approved".
 */
export function foldShowingStatus(
  requestStatus: string | null | undefined,
  showingStatus: string | null | undefined,
  hasCompletedAt: boolean,
): PortalShowingStatus {
  if (hasCompletedAt) return "completed"
  switch (showingStatus) {
    case "completed":                return "completed"
    case "cancelled":                return "cancelled"
    case "confirmed":                return "confirmed"
    case "scheduled":
    case "rescheduled":              return "scheduled"
    case "requested":                return "pending"
  }
  switch (requestStatus) {
    case "approved":                 return "scheduled"
    case "cancelled":
    case "denied":                   return "cancelled"
    case "needs_reschedule":
    case "pending":                  return "pending"
  }
  return "pending"
}

/** PURE — the request's own requested slot as an ISO string, when there is one. */
function requestedAtIso(req: ShowingRequestRow): string | null {
  if (!req.requested_date) return null
  const time = req.requested_start_time ?? "00:00:00"
  const iso = `${req.requested_date}T${time}`
  return Number.isNaN(Date.parse(iso)) ? null : iso
}

/**
 * PURE — merge showing REQUESTS with the SHOWINGS they became into the one shape
 * the portal renders.
 *
 * A showing with no request (booked by the agent, synced from ShowingTime) is a
 * first-class row too: the seller's board must not hide a walk-through just
 * because no portal request preceded it. Requests are keyed by
 * `converted_showing_id` so a showing is never listed twice.
 */
export function buildPortalShowingFeed(
  requests: ShowingRequestRow[],
  showings: ShowingRow[],
): PortalShowingRow[] {
  const showingById = new Map<string, ShowingRow>()
  for (const s of showings) if (s?.id) showingById.set(s.id, s)

  const claimed = new Set<string>()
  const rows: PortalShowingRow[] = []

  for (const req of requests ?? []) {
    if (!req?.id) continue
    const showing = req.converted_showing_id ? showingById.get(req.converted_showing_id) ?? null : null
    if (showing) claimed.add(showing.id)
    rows.push({
      id: req.id,
      listingId: req.listing_id ?? showing?.listing_id ?? null,
      propertyAddress: req.property_address ?? showing?.external_address ?? null,
      showingAt: showing?.completed_at ?? showing?.scheduled_at ?? requestedAtIso(req),
      status: foldShowingStatus(req.status, showing?.status, !!showing?.completed_at),
      buyerName: showing?.buyer_agent_name ?? req.buyer_agent_name ?? null,
      buyerFeedback: showing?.feedback ?? null,
      buyerConcerns: showing?.notes ?? null,
      buyerInterestLevel: showing?.buyer_interest_level ?? null,
      interestBand: showingInterestBand(showing?.buyer_interest_level),
      rating: showing?.rating ?? null,
    })
  }

  for (const s of showings ?? []) {
    if (!s?.id || claimed.has(s.id)) continue
    rows.push({
      id: s.id,
      listingId: s.listing_id ?? null,
      propertyAddress: s.external_address ?? null,
      showingAt: s.completed_at ?? s.scheduled_at ?? null,
      status: foldShowingStatus(null, s.status, !!s.completed_at),
      buyerName: s.buyer_agent_name ?? null,
      buyerFeedback: s.feedback ?? null,
      buyerConcerns: s.notes ?? null,
      buyerInterestLevel: s.buyer_interest_level ?? null,
      interestBand: showingInterestBand(s.buyer_interest_level),
      rating: s.rating ?? null,
    })
  }

  // Newest first — an absent date sorts last rather than crashing the compare.
  return rows.sort((a, b) => {
    const at = a.showingAt ? Date.parse(a.showingAt) : -Infinity
    const bt = b.showingAt ? Date.parse(b.showingAt) : -Infinity
    return bt - at
  })
}

/** PURE — the rows a seller's feedback tab is about: somebody left a verdict. */
export function withFeedback(rows: PortalShowingRow[]): PortalShowingRow[] {
  return rows.filter((r) => !!r.buyerFeedback || r.interestBand !== null)
}
