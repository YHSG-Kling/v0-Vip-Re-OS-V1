"use server"

import { createClient } from "@/lib/supabase/server"
import { KernelEvent } from "@/lib/kernel/events"
import { dispatchEmail } from "@/lib/providers/dispatch"
import { compareVendors, pickBestVendor } from "@/lib/vendors/rank"

// ============================================
// VENDOR DIRECTORY & SEARCH
// ============================================

export async function searchVendors(filters: {
  serviceType?: string
  name?: string
  city?: string
  minRating?: number
  limit?: number
}) {
  const supabase = await createClient()

  // Get current user's brokerage
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  const brokerageId = profile?.brokerage_id

  // Build query - show brokerage vendors + global vendors (brokerage_id IS NULL)
  let query = supabase
    .from("vendors")
    .select(`
      id,
      name,
      email,
      phone,
      website,
      category,
      notes,
      rating,
      brokerage_id,
      created_at
    `)

  // Filter: brokerage vendors OR global vendors
  if (brokerageId) {
    query = query.or(`brokerage_id.eq.${brokerageId},brokerage_id.is.null`)
  } else {
    query = query.is("brokerage_id", null)
  }

  // Apply filters
  if (filters.serviceType) {
    query = query.ilike("category", `%${filters.serviceType}%`)
  }

  if (filters.name) {
    query = query.ilike("name", `%${filters.name}%`)
  }

  if (filters.minRating) {
    query = query.gte("rating", filters.minRating)
  }

  const { data: vendors, error } = await query
    .order("rating", { ascending: false, nullsFirst: false })
    .limit(filters.limit || 50)

  if (error) throw error

  // Get vendor ratings for each vendor
  const vendorIds = vendors?.map(v => v.id) || []
  
  const { data: ratings } = await supabase
    .from("vendor_ratings")
    .select("*")
    .in("vendor_id", vendorIds)

  const ratingsMap = new Map(ratings?.map(r => [r.vendor_id, r]))

  return (vendors || []).map(v => ({
    ...v,
    vendor_rating: ratingsMap.get(v.id) || null
  }))
}

// ─── MATCHING & AVAILABILITY ────────────────────────────────────────────────
// Moved here from multi-persona.ts, which was a grab-bag: these two are the
// only things in the app that answer "who is actually free" and "who is the
// right one", and they belong on the rail that owns vendors.

/** The brokerage of the signed-in caller. Never taken from the client — a
 *  caller-supplied brokerageId is a tenant boundary the caller controls. */
async function callerBrokerageId(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")
  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!profile?.brokerage_id) {
    throw new Error("Your account is not linked to a brokerage yet — ask an admin to assign you one.")
  }
  return profile.brokerage_id as string
}

export interface VendorAvailability {
  /** Bench considered: active vendors of this category on the caller's bench. */
  consideredCount: number
  availableCount: number
  availableVendors: Array<{
    id: string
    name: string
    category: string | null
    rating: number | null
    preferred: boolean | null
    estimated_turnaround_days: number | null
  }>
  /** Ids already committed that day, so the UI can say WHY someone is missing. */
  busyVendorIds: string[]
}

/**
 * Who on the bench is free on a given date.
 *
 * scheduled_date is a DATE column, so an exact match on YYYY-MM-DD is right.
 * Two fixes over the version this replaces:
 *   · the existing-bookings read was not brokerage-scoped, so ANOTHER tenant's
 *     booking of the same vendor marked your vendor busy;
 *   · brokerageId arrived as a parameter from the caller.
 */
export async function checkVendorAvailability(input: {
  serviceType: string
  preferredDate: string
}): Promise<VendorAvailability> {
  const supabase = await createClient()
  const brokerageId = await callerBrokerageId(supabase)

  const { data: vendors, error } = await supabase
    .from("vendors")
    .select("id, name, category, rating, preferred, display_priority, estimated_turnaround_days")
    .eq("brokerage_id", brokerageId)
    .eq("status", "active")
    .ilike("category", `%${input.serviceType}%`)

  if (error) throw error
  const bench = vendors ?? []
  if (bench.length === 0) {
    return { consideredCount: 0, availableCount: 0, availableVendors: [], busyVendorIds: [] }
  }

  const { data: existingBookings, error: bookingsError } = await supabase
    .from("vendor_bookings")
    .select("vendor_id")
    .eq("brokerage_id", brokerageId)
    .in("vendor_id", bench.map((v) => v.id))
    .eq("scheduled_date", input.preferredDate)
    .in("status", ["booked", "confirmed"])

  // A failed read here would silently report the whole bench as free and let an
  // agent double-book. Refuse instead of guessing.
  if (bookingsError) throw bookingsError

  const busyVendorIds = Array.from(new Set((existingBookings ?? []).map((b) => b.vendor_id as string)))
  const available = bench
    .filter((v) => !busyVendorIds.includes(v.id))
    .sort(compareVendors)

  return {
    consideredCount: bench.length,
    availableCount: available.length,
    availableVendors: available.map(({ display_priority: _dp, ...v }) => v),
    busyVendorIds,
  }
}

/**
 * The single best vendor for a job — the one the form pre-selects.
 *
 * `urgency: "urgent"` prefers the fastest turnaround the bench offers, then
 * falls back to normal ranking; a routine job just takes the best-ranked.
 *
 * NOTE ON SCOPE: the version this replaces also took a `propertyCity` and
 * ranked by it. `vendors` has no city column — it never could have, and the
 * parameter was accepted and dropped on the floor. Geography is not something
 * this table can answer, so it is not claimed here.
 */
export async function matchVendorToTransaction(input: {
  serviceType: string
  urgency?: "routine" | "urgent"
  /** Optional: exclude anyone already booked that day. */
  neededOn?: string
}) {
  const supabase = await createClient()
  const brokerageId = await callerBrokerageId(supabase)

  const { data: vendors, error } = await supabase
    .from("vendors")
    .select("id, name, category, rating, preferred, display_priority, estimated_turnaround_days, phone, email")
    .eq("brokerage_id", brokerageId)
    .eq("status", "active")
    .ilike("category", `%${input.serviceType}%`)

  if (error) throw error
  let bench = vendors ?? []
  if (bench.length === 0) return null

  if (input.neededOn) {
    const { data: booked, error: bookedError } = await supabase
      .from("vendor_bookings")
      .select("vendor_id")
      .eq("brokerage_id", brokerageId)
      .in("vendor_id", bench.map((v) => v.id))
      .eq("scheduled_date", input.neededOn)
      .in("status", ["booked", "confirmed"])
    if (bookedError) throw bookedError
    const busy = new Set((booked ?? []).map((b) => b.vendor_id as string))
    const free = bench.filter((v) => !busy.has(v.id))
    // Everyone booked that day → recommend the best one anyway rather than
    // returning null; the availability panel already says they are committed.
    if (free.length > 0) bench = free
  }

  return pickBestVendor(bench, input.urgency ?? "routine")
}

export async function getSuggestedVendorsByStage(stage: string) {
  const supabase = await createClient()

  // Get current user's brokerage
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  const brokerageId = profile?.brokerage_id

  // Map transaction stages to vendor service types
  const stageToServiceType: Record<string, string[]> = {
    INSPECTION: ["inspector", "home_inspector", "inspection"],
    APPRAISAL: ["appraiser", "appraisal"],
    FINANCING_PENDING: ["lender", "mortgage", "loan_officer", "financing"],
  }

  const serviceTypes = stageToServiceType[stage]
  if (!serviceTypes) return []

  // Build OR condition for matching any of the service types
  const serviceTypeConditions = serviceTypes.map(st => `category.ilike.%${st}%`).join(",")

  let query = supabase
    .from("vendors")
    .select(`
      id,
      name,
      email,
      phone,
      category,
      rating,
      brokerage_id
    `)
    .or(serviceTypeConditions)

  // Filter: brokerage vendors OR global vendors
  if (brokerageId) {
    query = query.or(`brokerage_id.eq.${brokerageId},brokerage_id.is.null`)
  } else {
    query = query.is("brokerage_id", null)
  }

  const { data: vendors } = await query
    .order("rating", { ascending: false, nullsFirst: false })
    .limit(5)

  return vendors || []
}

// ============================================
// VENDOR BOOKINGS
// ============================================

export async function createVendorBooking(data: {
  vendorId: string
  transactionId: string
  serviceType: string
  scheduledDate: string
  cost?: number
  notes?: string
}) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  const { data: booking, error } = await supabase
    .from("vendor_bookings")
    .insert({
      vendor_id: data.vendorId,
      transaction_id: data.transactionId,
      brokerage_id: profile?.brokerage_id,
      service_type: data.serviceType,
      scheduled_date: data.scheduledDate,
      cost: data.cost,
      notes: data.notes,
      status: "booked",
      booked_by: user.id,
      booked_at: new Date().toISOString(),
    })
    .select()
    .maybeSingle()

  if (error) throw error

  // Add timeline entry
  await supabase.from("transaction_timeline").insert({
    transaction_id: data.transactionId,
    brokerage_id: profile?.brokerage_id,
    activity_type: "vendor_booked",
    description: `Vendor booked for ${data.serviceType}`,
    performed_by: user.id,
    metadata: { vendor_id: data.vendorId, service_type: data.serviceType }
  })

  const { revalidatePath } = await import("next/cache")
  revalidatePath(`/dashboard/transactions/${data.transactionId}`)
  revalidatePath("/dashboard/vendors")
  return booking
}

export async function getVendorBookingsForTransaction(transactionId: string) {
  const supabase = await createClient()

  // Auth gate — was previously open, so any caller could enumerate any
  // transaction's vendor bookings (vendor names, emails, phones, costs).
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []
  const { data: u } = await supabase
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (!u?.brokerage_id) return []

  // Verify the transaction belongs to caller's brokerage
  const { data: tx } = await supabase
    .from("transactions").select("brokerage_id").eq("id", transactionId).maybeSingle()
  if (!tx || tx.brokerage_id !== u.brokerage_id) return []

  const { data: bookings, error } = await supabase
    .from("vendor_bookings")
    .select(`
      *,
      vendors:vendor_id(id, name, email, phone, category, rating)
    `)
    .eq("transaction_id", transactionId)
    .eq("brokerage_id", u.brokerage_id)
    .order("scheduled_date", { ascending: false })

  if (error) throw error
  return bookings || []
}

export async function getCompletedBookingsForRating() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  const { data: bookings } = await supabase
    .from("vendor_bookings")
    .select(`
      *,
      vendors:vendor_id(id, name, category),
      transactions:transaction_id(id, property_address)
    `)
    .eq("brokerage_id", profile?.brokerage_id)
    .eq("status", "completed")
    .is("agent_rating", null)
    .order("completed_at", { ascending: false })
    .limit(20)

  return bookings || []
}

export async function markBookingComplete(bookingId: string) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")
  const { data: u } = await supabase
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (!u?.brokerage_id) throw new Error("Your account is not linked to a brokerage yet — ask an admin to assign you one.")

  // Scope the UPDATE by brokerage_id so caller can't complete bookings
  // outside their tenant.
  const { data: booking, error } = await supabase
    .from("vendor_bookings")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
    })
    .eq("id", bookingId)
    .eq("brokerage_id", u.brokerage_id)
    .select("*, transactions:transaction_id(id)")
    .maybeSingle()

  if (error) throw error
  if (!booking) throw new Error("Booking not found in your scope")

  // Fan-out via the transaction kernel so the agent, buyer + seller portals
  // and any post-vendor-completion sequences fire. Previously only revalidate
  // ran — the other deal parties had no signal.
  if (booking.transaction_id) {
    try {
      const { emitTransactionEvent } = await import("@/lib/kernel/transactions")
      const { KernelEvent } = await import("@/lib/kernel/events")
      await emitTransactionEvent({
        event:       KernelEvent.VENDOR_BOOKING_COMPLETED,
        brokerageId: booking.brokerage_id,
        entityId:    booking.transaction_id,
        actorUserId: user.id,
        metadata: {
          booking_id:    bookingId,
          vendor_id:     booking.vendor_id,
          service_type:  booking.service_type,
        },
      })
    } catch (err) {
      console.error("[markBookingComplete] fan-out failed (non-blocking)", err)
    }
  }

  // VENDOR LOOP — service complete → propose a client review request into the gate
  // (Sphere Manager). Best-effort, idempotent. Needs a client contact on the booking.
  if ((booking as any).contact_id) {
    try {
      const { produceVendorReviewRequest } = await import("@/lib/agents/vendor-loop-producer")
      await produceVendorReviewRequest(booking.brokerage_id, bookingId, supabase)
    } catch (err) {
      console.error("[markBookingComplete] vendor review request failed:", err)
    }
  }

  // Revalidate inside function to avoid module-level server dependency
  const { revalidatePath } = await import("next/cache")
  revalidatePath("/dashboard/vendors")
  revalidatePath(`/dashboard/transactions/${booking.transactions.id}`)
  revalidatePath("/vendor/jobs")
  return booking
}

// ============================================
// VENDOR RATINGS & REVIEWS
// ============================================

export async function rateVendorBooking(data: {
  bookingId: string
  rating: number
  review?: string
  headline?: string
  subRatings?: { communication?: number; timeliness?: number; quality?: number; value?: number }
}) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!profile?.brokerage_id) throw new Error("Your account is not linked to a brokerage yet — ask an admin to assign you one.")

  // Get booking to find vendor — scoped by caller's brokerage so an
  // attacker can't 1-star vendors in another tenant's marketplace.
  const { data: booking } = await supabase
    .from("vendor_bookings")
    .select("vendor_id, transaction_id, brokerage_id, booked_by, contact_id")
    .eq("id", data.bookingId)
    .eq("brokerage_id", profile.brokerage_id)
    .maybeSingle()

  if (!booking) throw new Error("Booking not found in your brokerage")

  // Update booking with rating — scoped
  const { error: updateError } = await supabase
    .from("vendor_bookings")
    .update({
      agent_rating: data.rating,
    })
    .eq("id", data.bookingId)
    .eq("brokerage_id", profile.brokerage_id)

  if (updateError) throw updateError

  // Verification is SERVER-computed: the rater is the booking's requester → a verified booking party.
  const { verificationMethod } = await import("@/lib/kernel/vendor-review-moderation")
  const verdict = verificationMethod({
    reviewerUserId: user.id,
    booking: { requestedBy: (booking as any).booked_by, contactId: (booking as any).contact_id },
  })

  // Insert vendor review (agent booking rating — a verified, in-house review; auto-approved).
  const { error: reviewError } = await supabase
    .from("vendor_reviews")
    .insert({
      vendor_id: booking.vendor_id,
      user_id: user.id,
      brokerage_id: booking.brokerage_id,
      booking_id: data.bookingId,
      transaction_id: (booking as any).transaction_id ?? null,
      rating: data.rating,
      review: data.review,
      headline: data.headline ?? null,
      sub_ratings: data.subRatings ?? null,
      is_verified: verdict.isVerified,
      verification_method: verdict.method,
      moderation_status: "approved",
    })

  if (reviewError) throw reviewError

  // Recalculate vendor_ratings aggregate (booking rollup) + the weighted review rollup.
  await recalculateVendorRatings(booking.vendor_id, booking.brokerage_id)
  await recomputeVendorReviewStats(booking.vendor_id, booking.brokerage_id)

  // Revalidate inside function to avoid module-level server dependency
  const { revalidatePath } = await import("next/cache")
  revalidatePath("/dashboard/vendors")
  return { success: true }
}

export async function recalculateVendorRatings(vendorId: string, brokerageId: string) {
  const supabase = await createClient()

  // Get all bookings with ratings for this vendor in this brokerage
  const { data: bookings } = await supabase
    .from("vendor_bookings")
    .select("agent_rating, client_rating")
    .eq("vendor_id", vendorId)
    .eq("brokerage_id", brokerageId)

  if (!bookings || bookings.length === 0) return

  // Calculate aggregates
  const agentRatings = bookings.filter(b => b.agent_rating != null).map(b => b.agent_rating)
  const clientRatings = bookings.filter(b => b.client_rating != null).map(b => b.client_rating)
  const fiveStars = agentRatings.filter(r => r === 5).length
  const oneStars = agentRatings.filter(r => r === 1).length
  
  const avgAgentRating = agentRatings.length > 0 
    ? agentRatings.reduce((a, b) => a + b, 0) / agentRatings.length 
    : null
  const avgClientRating = clientRatings.length > 0 
    ? clientRatings.reduce((a, b) => a + b, 0) / clientRatings.length 
    : null

  // Upsert vendor_ratings
  const { error } = await supabase
    .from("vendor_ratings")
    .upsert({
      vendor_id: vendorId,
      brokerage_id: brokerageId,
      avg_agent_rating: avgAgentRating,
      avg_client_rating: avgClientRating,
      total_bookings: bookings.length,
      five_star_count: fiveStars,
      one_star_count: oneStars,
      last_updated: new Date().toISOString(),
    }, { onConflict: "vendor_id" })

  if (error) {
    // If unique constraint doesn't exist, insert new record
    await supabase
      .from("vendor_ratings")
      .insert({
        vendor_id: vendorId,
        brokerage_id: brokerageId,
        avg_agent_rating: avgAgentRating,
        avg_client_rating: avgClientRating,
        total_bookings: bookings.length,
        five_star_count: fiveStars,
        one_star_count: oneStars,
        last_updated: new Date().toISOString(),
      })
  }

  // Also update the main vendors table rating
  if (avgAgentRating) {
    await supabase
      .from("vendors")
      .update({ rating: avgAgentRating })
      .eq("id", vendorId)
  }
}

export async function getVendorReviews(vendorId: string) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id, user_type, role")
    .eq("id", user.id)
    .maybeSingle()

  // Only show reviews to agents in brokerage, not to clients
  if (!profile?.brokerage_id) return []

  const { data: reviews, error } = await supabase
    .from("vendor_reviews")
    .select(`
      id,
      rating,
      review,
      headline,
      sub_ratings,
      is_verified,
      verification_method,
      moderation_status,
      flag_count,
      vendor_response,
      vendor_response_at,
      created_at,
      users:user_id(first_name, last_name)
    `)
    .eq("vendor_id", vendorId)
    .eq("brokerage_id", profile.brokerage_id)
    // A rejected review is a moderation decision that has been made. It was
    // still being rendered here, so a review an admin had thrown out kept
    // arguing its case on the vendor's card while counting for nothing in the
    // weighted average.
    .neq("moderation_status", "rejected")
    .order("created_at", { ascending: false })
    .limit(20)

  if (error) {
    console.error("[vendor-marketplace] getVendorReviews failed:", error.message)
    return []
  }
  return reviews || []
}

/**
 * The reviews of the vendor the CALLER OWNS — the vendor portal's side of the
 * marketplace. Canonical vendor linkage is user_role_assignments.vendor_id
 * (`vendors` has no user_id column), the same link /vendor/invoices and
 * /vendor/connections resolve through.
 *
 * Rejected reviews are withheld: a vendor should not be answering a review the
 * brokerage has already removed.
 */
export async function getMyVendorReviews(): Promise<{
  vendorId: string | null
  reviews: Array<Record<string, unknown>>
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { vendorId: null, reviews: [] }

  const vendorId = await resolveCallerVendorId(supabase, user.id)
  if (!vendorId) return { vendorId: null, reviews: [] }

  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()

  const { data, error } = await svc
    .from("vendor_reviews")
    .select("id, rating, review, headline, sub_ratings, is_verified, verification_method, moderation_status, flag_count, vendor_response, vendor_response_at, created_at")
    .eq("vendor_id", vendorId)
    .neq("moderation_status", "rejected")
    .order("created_at", { ascending: false })
    .limit(100)

  if (error) {
    console.error("[vendor-marketplace] getMyVendorReviews failed:", error.message)
    return { vendorId, reviews: [] }
  }
  return { vendorId, reviews: (data ?? []) as Array<Record<string, unknown>> }
}

/**
 * The vendors row a signed-in VENDOR user owns, or null for anyone else.
 * `vendors` has no user_id — user_role_assignments.vendor_id is the link.
 */
async function resolveCallerVendorId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("user_role_assignments")
    .select("vendor_id")
    .eq("user_id", userId)
    .not("vendor_id", "is", null)
    .maybeSingle()
  if (error) {
    console.error("[vendor-marketplace] vendor linkage read failed:", error.message)
    return null
  }
  return (data?.vendor_id as string | undefined) ?? null
}

/**
 * The brokerage's review moderation queue — everything screenReview or a
 * community flag routed to a human. Admin/broker only; without this reader
 * moderateVendorReview had nothing to moderate.
 */
export async function getVendorReviewModerationQueue(): Promise<Array<{
  id: string
  vendor_id: string
  vendor_name: string | null
  rating: number | null
  review: string | null
  headline: string | null
  is_verified: boolean
  verification_method: string | null
  moderation_status: string
  flag_count: number
  created_at: string | null
  reviewer_name: string | null
}>> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()

  const { data: profile, error: profileError } = await svc
    .from("users").select("brokerage_id, user_type, role").eq("id", user.id).maybeSingle()
  if (profileError) {
    console.error("[vendor-marketplace] moderation queue profile read failed:", profileError.message)
    return []
  }
  const brokerageId = (profile as any)?.brokerage_id
  const isAdmin =
    ["broker", "admin", "broker_admin", "superadmin"].includes(String((profile as any)?.user_type)) ||
    ["broker", "admin", "owner"].includes(String((profile as any)?.role))
  if (!brokerageId || !isAdmin) return []

  const { data, error } = await svc
    .from("vendor_reviews")
    .select(`
      id, vendor_id, rating, review, headline, is_verified, verification_method,
      moderation_status, flag_count, created_at,
      vendors:vendor_id(name),
      users:user_id(first_name, last_name)
    `)
    .eq("brokerage_id", brokerageId)
    .in("moderation_status", ["pending", "under_review"])
    .order("flag_count", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(200)

  if (error) {
    console.error("[vendor-marketplace] moderation queue read failed:", error.message)
    return []
  }

  return (data ?? []).map((r: any) => ({
    id: r.id,
    vendor_id: r.vendor_id,
    vendor_name: r.vendors?.name ?? null,
    rating: r.rating,
    review: r.review,
    headline: r.headline,
    is_verified: !!r.is_verified,
    verification_method: r.verification_method ?? null,
    moderation_status: r.moderation_status,
    flag_count: r.flag_count ?? 0,
    created_at: r.created_at,
    reviewer_name: [r.users?.first_name, r.users?.last_name].filter(Boolean).join(" ") || null,
  }))
}

/**
 * Recompute the WEIGHTED review rollup for a vendor (verified reviews at 1.5×) over its APPROVED reviews,
 * and write review_avg / review_count / verified_review_count onto vendor_ratings. Runs after any review
 * insert / moderation decision. Uses the service client so it isn't blocked by the reviewer's RLS scope.
 */
export async function recomputeVendorReviewStats(vendorId: string, brokerageId: string) {
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()
  const { weightedReviewAverage } = await import("@/lib/kernel/vendor-review-moderation")

  const { data: rows } = await svc
    .from("vendor_reviews")
    .select("rating, is_verified")
    .eq("vendor_id", vendorId)
    .eq("brokerage_id", brokerageId)
    .eq("moderation_status", "approved")
    .limit(5000)

  const stats = weightedReviewAverage(((rows ?? []) as Array<{ rating: number | null; is_verified: boolean }>).map((r) => ({ rating: r.rating, isVerified: !!r.is_verified })))

  // vendor_ratings is unique on vendor_id — upsert the review columns without disturbing the booking rollup.
  const { data: existing } = await svc.from("vendor_ratings").select("id").eq("vendor_id", vendorId).maybeSingle()
  if (existing) {
    await svc.from("vendor_ratings").update({
      review_avg: stats.avg, review_count: stats.count, verified_review_count: stats.verifiedCount, last_updated: new Date().toISOString(),
    }).eq("id", (existing as any).id)
  } else {
    await svc.from("vendor_ratings").insert({
      vendor_id: vendorId, brokerage_id: brokerageId,
      review_avg: stats.avg, review_count: stats.count, verified_review_count: stats.verifiedCount, total_bookings: 0, last_updated: new Date().toISOString(),
    })
  }
  return stats
}

/**
 * Submit a vendor review from a CLIENT (transaction-linked or organic homeowner). Verification is
 * SERVER-enforced — the client cannot self-assert it: the reviewer must be a party to the referenced
 * transaction/booking. The review is screened (screenReview) and either auto-approved or queued for a
 * human. Scoped to the caller's brokerage.
 */
export async function submitVendorReview(data: {
  vendorId: string
  rating: number
  body: string
  headline?: string
  subRatings?: { communication?: number; timeliness?: number; quality?: number; value?: number }
  transactionId?: string
  bookingId?: string
}): Promise<{ id: string; moderationStatus: string; isVerified: boolean }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()

  const { data: profile } = await svc.from("users").select("brokerage_id, created_at").eq("id", user.id).maybeSingle()
  const brokerageId = (profile as any)?.brokerage_id
  if (!brokerageId) throw new Error("Your account is not linked to a brokerage yet — ask an admin to assign you one.")

  const { verificationMethod, screenReview } = await import("@/lib/kernel/vendor-review-moderation")

  // Load the referenced transaction / booking parties (brokerage-scoped) for server-side verification.
  let transaction: any = null, booking: any = null
  if (data.transactionId) {
    const { data: t } = await svc.from("transactions").select("id, agent_id, buyer_contact_id, contact_id, brokerage_id").eq("id", data.transactionId).eq("brokerage_id", brokerageId).maybeSingle()
    transaction = t ? { agentId: t.agent_id, buyerContactId: t.buyer_contact_id, contactId: t.contact_id } : null
  }
  if (data.bookingId) {
    const { data: b } = await svc.from("vendor_bookings").select("id, booked_by, contact_id, brokerage_id").eq("id", data.bookingId).eq("brokerage_id", brokerageId).maybeSingle()
    booking = b ? { requestedBy: b.booked_by, contactId: b.contact_id } : null
  }

  // The reviewer may be a staff user OR a contact — resolve their contact id if any (portal reviewers).
  const { data: asContact } = await svc.from("contacts").select("id").eq("user_id", user.id).eq("brokerage_id", brokerageId).maybeSingle()
  const verdict = verificationMethod({
    reviewerUserId: user.id, reviewerContactId: (asContact as any)?.id ?? null, transaction, booking,
  })

  const accountAgeDays = (profile as any)?.created_at ? Math.floor((Date.now() - new Date((profile as any).created_at).getTime()) / 86_400_000) : null
  const screen = screenReview({ rating: data.rating, body: data.body, accountAgeDays })

  const { data: inserted, error } = await svc.from("vendor_reviews").insert({
    vendor_id: data.vendorId, user_id: user.id, brokerage_id: brokerageId,
    transaction_id: data.transactionId ?? null, booking_id: data.bookingId ?? null,
    rating: data.rating, review: data.body, headline: data.headline ?? null, sub_ratings: data.subRatings ?? null,
    is_verified: verdict.isVerified, verification_method: verdict.method,
    moderation_status: screen.moderationStatus,
  }).select("id").single()
  if (error || !inserted) throw new Error(`Failed to submit review: ${error?.message ?? "no row"}`)

  // Only approved reviews affect the vendor's public average.
  if (screen.moderationStatus === "approved") await recomputeVendorReviewStats(data.vendorId, brokerageId)
  return { id: (inserted as any).id, moderationStatus: screen.moderationStatus, isVerified: verdict.isVerified }
}

/**
 * A vendor posts its ONE public response to a review. Immutable — a response can be set once and never
 * edited or deleted by the vendor (only auto-screened for profanity/PII). Vendor-scoped by ownership.
 */
export async function respondToVendorReview(reviewId: string, response: string): Promise<{ ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()

  // The caller must own the REVIEWED vendor — a vendor can only respond to reviews of itself.
  //
  // The check this replaces was `if (!profileVendor && !ownsVendor)`, where
  // `ownsVendor` was `vendors.select(id).eq("id", review.vendor_id)` — i.e. "does
  // the reviewed vendor exist". For any real review that is always true, so the
  // gate passed for EVERY authenticated user and anyone could post the vendor's
  // one immutable public reply. `vendors` has no user_id column;
  // user_role_assignments.vendor_id is the canonical linkage (same one
  // /vendor/invoices and getAllVendorBookings resolve through).
  const { data: review } = await svc.from("vendor_reviews").select("id, vendor_id, vendor_response").eq("id", reviewId).maybeSingle()
  if (!review) throw new Error("Review not found")
  if ((review as any).vendor_response) throw new Error("A response has already been submitted (responses are immutable).")

  const callerVendorId = await resolveCallerVendorId(supabase, user.id)
  if (!callerVendorId || callerVendorId !== (review as any).vendor_id) {
    throw new Error("Not authorized to respond to this review")
  }

  const { screenReview } = await import("@/lib/kernel/vendor-review-moderation")
  const screen = screenReview({ rating: 5, body: response.length < 50 ? response.padEnd(50, " ") : response, accountAgeDays: 999 })
  if (screen.reasons.includes("profanity") || screen.reasons.includes("pii")) {
    throw new Error("Response contains profanity or personal information and was not posted.")
  }

  const { error } = await svc.from("vendor_reviews").update({ vendor_response: response, vendor_response_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", reviewId)
  if (error) throw error

  const { revalidatePath } = await import("next/cache")
  revalidatePath("/vendor/reviews")
  return { ok: true }
}

/**
 * Any authenticated user (except the vendor) can flag a review. Flags dedupe per (review, user); at
 * FLAG_UNDER_REVIEW the review moves to `under_review` for a human. Returns the new flag count.
 */
export async function flagVendorReview(reviewId: string, reason: string): Promise<{ flagCount: number; status: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()

  const { data: review } = await svc.from("vendor_reviews").select("id, vendor_id, brokerage_id, moderation_status, flag_count").eq("id", reviewId).maybeSingle()
  if (!review) throw new Error("Review not found")

  // "Any authenticated user EXCEPT the vendor" — the reviewed vendor cannot flag
  // its own bad review into the human queue. The docstring claimed this; the code
  // did not enforce it.
  const callerVendorId = await resolveCallerVendorId(supabase, user.id)
  if (callerVendorId && callerVendorId === (review as any).vendor_id) {
    throw new Error("A vendor cannot flag a review of itself — respond to it instead.")
  }

  const allowed = ["inappropriate", "fake", "competitor", "pii", "irrelevant"]
  const reasonCode = allowed.includes(reason) ? reason : "inappropriate"

  // Dedupe per (review, user) via the unique constraint — a repeat flag is a no-op.
  const { error: flagErr } = await svc.from("vendor_review_flags").insert({
    review_id: reviewId, flagged_by: user.id, brokerage_id: (review as any).brokerage_id, reason: reasonCode,
  })
  // Unique-violation (already flagged) is not an error for the caller.
  if (flagErr && !/duplicate key|unique/i.test(flagErr.message)) throw flagErr

  const { count } = await svc.from("vendor_review_flags").select("id", { count: "exact", head: true }).eq("review_id", reviewId)
  const flagCount = count ?? 0

  const { moderationAfterFlag } = await import("@/lib/kernel/vendor-review-moderation")
  const newStatus = moderationAfterFlag((review as any).moderation_status, flagCount)
  await svc.from("vendor_reviews").update({ flag_count: flagCount, moderation_status: newStatus, updated_at: new Date().toISOString() }).eq("id", reviewId)
  return { flagCount, status: newStatus }
}

/**
 * Admin moderation decision on a review (approve / reject). Only brokerage admins/brokers. On a status
 * change the vendor's weighted review rollup is recomputed so a rejected review stops counting.
 */
export async function moderateVendorReview(reviewId: string, decision: "approve" | "reject"): Promise<{ ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()
  const { data: profile } = await svc.from("users").select("brokerage_id, user_type, role").eq("id", user.id).maybeSingle()
  const brokerageId = (profile as any)?.brokerage_id
  const isAdmin = ["broker", "admin", "broker_admin", "superadmin"].includes(String((profile as any)?.user_type)) || ["broker", "admin", "owner"].includes(String((profile as any)?.role))
  if (!brokerageId || !isAdmin) throw new Error("Not authorized")

  const { data: review } = await svc.from("vendor_reviews").select("id, vendor_id, brokerage_id").eq("id", reviewId).eq("brokerage_id", brokerageId).maybeSingle()
  if (!review) throw new Error("Review not found in your brokerage")

  const { error: decisionError } = await svc.from("vendor_reviews")
    .update({ moderation_status: decision === "approve" ? "approved" : "rejected", updated_at: new Date().toISOString() })
    .eq("id", reviewId)
  // A refused UPDATE resolves rather than throwing — reporting ok:true here
  // would tell an admin the review was decided while it sat in the queue.
  if (decisionError) throw decisionError

  await recomputeVendorReviewStats((review as any).vendor_id, brokerageId)

  const { revalidatePath } = await import("next/cache")
  revalidatePath("/dashboard/admin/vendor-approvals")
  revalidatePath("/dashboard/vendors")
  return { ok: true }
}

// ============================================
// VENDOR COST COMPARISON
// ============================================

export async function getVendorCostComparison(serviceType: string) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) return []

  // Get vendors matching the service type
  const { data: vendors } = await supabase
    .from("vendors")
    .select("id, name, category, rating")
    .or(`brokerage_id.eq.${profile.brokerage_id},brokerage_id.is.null`)
    .ilike("category", `%${serviceType}%`)

  if (!vendors || vendors.length === 0) return []

  const vendorIds = vendors.map(v => v.id)

  // Get past bookings with costs for these vendors in this brokerage
  const { data: bookings } = await supabase
    .from("vendor_bookings")
    .select("vendor_id, cost, service_type, completed_at")
    .eq("brokerage_id", profile.brokerage_id)
    .in("vendor_id", vendorIds)
    .eq("status", "completed")
    .not("cost", "is", null)
    .order("completed_at", { ascending: false })
    .limit(100)

  // Aggregate costs per vendor
  const costMap = new Map<string, { total: number, count: number, costs: number[] }>()
  
  for (const booking of bookings || []) {
    const existing = costMap.get(booking.vendor_id) || { total: 0, count: 0, costs: [] }
    existing.total += booking.cost
    existing.count += 1
    existing.costs.push(booking.cost)
    costMap.set(booking.vendor_id, existing)
  }

  return vendors.map(vendor => {
    const stats = costMap.get(vendor.id)
    return {
      ...vendor,
      avg_cost: stats ? stats.total / stats.count : null,
      min_cost: stats ? Math.min(...stats.costs) : null,
      max_cost: stats ? Math.max(...stats.costs) : null,
      booking_count: stats?.count || 0,
    }
  }).sort((a, b) => {
    // Sort by rating first, then by avg cost
    if (b.rating !== a.rating) return (b.rating || 0) - (a.rating || 0)
    return (a.avg_cost || Infinity) - (b.avg_cost || Infinity)
  })
}

export async function getAllVendorBookings(limit: number = 50) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) return []

  // Vendor user_type → restrict to bookings for THIS vendor's vendor_id only.
  // Without this guard, any vendor sees every other vendor's bookings in the brokerage.
  // For brokerage members (broker/admin/agent/tc/isa) the brokerage-wide read is correct.
  let vendorIdFilter: string | null = null
  if (profile.user_type === "vendor") {
    const { data: roleRow } = await supabase
      .from("user_role_assignments")
      .select("vendor_id")
      .eq("user_id", user.id)
      .not("vendor_id", "is", null)
      .maybeSingle()
    if (!roleRow?.vendor_id) return []
    vendorIdFilter = roleRow.vendor_id as string
  }

  let query = supabase
    .from("vendor_bookings")
    .select(`
      *,
      vendors:vendor_id(id, name, category, rating),
      transactions:transaction_id(id, property_address)
    `)
    .eq("brokerage_id", profile.brokerage_id)
    .order("created_at", { ascending: false })
    .limit(limit)

  if (vendorIdFilter) query = query.eq("vendor_id", vendorIdFilter)

  const { data: bookings } = await query
  return bookings || []
}

// ============================================
// VENDOR ASSIGNMENTS (Task 1: Kernel Wiring)
// ============================================

export async function assignVendorToTransaction(data: {
  vendorId: string
  transactionId: string
  assignmentType: string
  scheduledDate?: string
  notes?: string
}) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!profile?.brokerage_id) throw new Error("Your account is not linked to a brokerage yet — ask an admin to assign you one.")

  // Verify vendor + transaction belong to caller's brokerage before any
  // inserts. Without this, caller could attach any vendor to any deal +
  // trigger an auto-email to that vendor's address fan-out.
  const [{ data: vendorRow }, { data: txRow }] = await Promise.all([
    supabase.from("vendors").select("brokerage_id").eq("id", data.vendorId).maybeSingle(),
    supabase.from("transactions").select("brokerage_id").eq("id", data.transactionId).maybeSingle(),
  ])
  if (!vendorRow || vendorRow.brokerage_id !== profile.brokerage_id) {
    throw new Error("Forbidden: vendor not in your brokerage")
  }
  if (!txRow || txRow.brokerage_id !== profile.brokerage_id) {
    throw new Error("Forbidden: transaction not in your brokerage")
  }

  // Get agent ID from user
  const { data: agent } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle()

  // The comment that used to be here said "agent may not have agents row — use
  // user.id as fallback". The INTENT was right and the code was the opposite of
  // it (m349): vendor_assignments.assigned_by_agent_id FKs agents and is
  // NULLABLE, so the users id was FK-rejected, assignError threw, and the whole
  // vendor assignment failed for exactly the user the fallback was written to
  // accommodate. NULL is how this column expresses "no agent row" — it was
  // designed for this case and the code reached past it.
  const agentRowId = agent?.id ?? null

  const { data: assignment, error: assignError } = await supabase
    .from("vendor_assignments")
    .insert({
      transaction_id: data.transactionId,
      vendor_id: data.vendorId,
      brokerage_id: profile?.brokerage_id,
      assignment_type: data.assignmentType,
      scheduled_date: data.scheduledDate ? new Date(data.scheduledDate).toISOString() : null,
      notes: data.notes,
      assigned_by_agent_id: agentRowId,
      status: "pending",
      created_at: new Date().toISOString(),
    })
    .select()
    .maybeSingle()

  if (assignError) throw assignError

  // Create vendor job
  const { error: jobError } = await supabase
    .from("vendor_jobs")
    .insert({
      assignment_id: assignment.id,
      vendor_id: data.vendorId,
      job_title: data.assignmentType,
      status: "pending",
      created_at: new Date().toISOString(),
    })

  if (jobError) throw jobError

  // Emit kernel event
  await supabase.from("lifecycle_events").insert({
    brokerage_id: profile?.brokerage_id,
    event_type: KernelEvent.VENDOR_ASSIGNED_TO_TRANSACTION,
    entity_type: "vendor_assignment",
    entity_id: assignment.id,
    actor_user_id: user.id,
    metadata: {
      vendor_id: data.vendorId,
      transaction_id: data.transactionId,
      assignment_type: data.assignmentType,
      // Same class rule as the row this event describes — the metadata must
      // not disagree with the assignment it is reporting on.
      assigned_by_agent_id: agentRowId,
    },
    created_at: new Date().toISOString(),
  })

  // Auto-email the vendor with job details (fire and forget — must not
  // block the assignment if email fails).
  ;(async () => {
    try {
      const { data: vendor } = await supabase
        .from("vendors")
        .select("name, email, category")
        .eq("id", data.vendorId)
        .maybeSingle()

      if (!vendor?.email) return

      const { data: txn } = await supabase
        .from("transactions")
        .select("id, property_address, city:property_city, state:property_state, close_date")
        .eq("id", data.transactionId)
        .maybeSingle()

      const propertyLine = txn?.property_address
        ? `${txn.property_address}${txn.city ? `, ${txn.city}` : ""}${txn.state ? `, ${txn.state}` : ""}`
        : "(property address pending)"
      const closeDateLine = txn?.close_date
        ? new Date(txn.close_date).toLocaleDateString()
        : "TBD"
      const scheduledLine = data.scheduledDate
        ? new Date(data.scheduledDate).toLocaleString()
        : "Will be coordinated separately"

      const subject = `New ${data.assignmentType} job assigned for ${propertyLine}`
      const html = `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;background:#f9fafb;padding:32px 0">
        <table width="560" style="margin:0 auto;background:#fff;border-radius:8px;overflow:hidden">
          <tr><td style="padding:20px;background:#1f2937;color:#fff">
            <h2 style="margin:0">New job assigned</h2>
            <p style="margin:4px 0 0;opacity:.85;font-size:13px">Hi ${vendor.name ?? "there"},</p>
          </td></tr>
          <tr><td style="padding:20px">
            <p style="margin:0 0 12px;font-size:14px">You've been assigned a new <strong>${data.assignmentType}</strong> job.</p>
            <table style="width:100%;font-size:13px">
              <tr><td style="padding:6px 0;color:#6b7280;width:140px">Property</td><td>${propertyLine}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280">Scheduled</td><td>${scheduledLine}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280">Close date</td><td>${closeDateLine}</td></tr>
              ${data.notes ? `<tr><td style="padding:6px 0;color:#6b7280;vertical-align:top">Notes</td><td>${data.notes.replace(/</g, "&lt;")}</td></tr>` : ""}
            </table>
            <p style="margin:16px 0 0;font-size:13px">Confirm the assignment in your vendor portal so the agent knows you're on it.</p>
          </td></tr>
        </table></body></html>`

      const fromEmail = process.env.SENDGRID_FROM_EMAIL ?? "noreply@vip-re.com"
      await dispatchEmail({
        brokerageId: profile?.brokerage_id ?? "",
        // dispatchEmail takes `agentId?: string` — an absent agent is `undefined`
        // here for the same reason it is NULL in the row above.
        agentId: agentRowId ?? undefined,
        userId: user.id,
        systemSource: "vendor_assignment",
        from: `${(await import("@/lib/platform/product-brand")).DEFAULT_PRODUCT_BRAND.name} <${fromEmail}>`,
        to: vendor.email,
        subject,
        html,
        channelPurpose: "transactional",
      })
    } catch (err: any) {
      console.error("[vendor-marketplace] auto-email failed:", err?.message)
    }
  })()

  // Revalidate inside function to avoid module-level server dependency
  const { revalidatePath } = await import("next/cache")
  revalidatePath(`/dashboard/transactions/${data.transactionId}`)
  revalidatePath("/dashboard/vendors")
  return assignment
}

export async function createVendorBookingWithKernelEvent(data: {
  vendorId: string
  transactionId: string
  serviceType: string
  scheduledDate: string
  cost?: number
  notes?: string
}) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!profile?.brokerage_id) throw new Error("Your account is not linked to a brokerage yet — ask an admin to assign you one.")

  // Verify vendor + transaction belong to caller's brokerage before any
  // inserts or vendor-email fan-out.
  const [{ data: vendorRow }, { data: txRow }] = await Promise.all([
    supabase.from("vendors").select("brokerage_id").eq("id", data.vendorId).maybeSingle(),
    supabase.from("transactions").select("brokerage_id").eq("id", data.transactionId).maybeSingle(),
  ])
  if (!vendorRow || vendorRow.brokerage_id !== profile.brokerage_id) {
    throw new Error("Forbidden: vendor not in your brokerage")
  }
  if (!txRow || txRow.brokerage_id !== profile.brokerage_id) {
    throw new Error("Forbidden: transaction not in your brokerage")
  }

  // Create booking
  const { data: booking, error } = await supabase
    .from("vendor_bookings")
    .insert({
      vendor_id: data.vendorId,
      transaction_id: data.transactionId,
      brokerage_id: profile?.brokerage_id,
      service_type: data.serviceType,
      scheduled_date: data.scheduledDate,
      cost: data.cost,
      notes: data.notes,
      status: "booked",
      booked_by: user.id,
      booked_at: new Date().toISOString(),
    })
    .select()
    .maybeSingle()

  if (error) throw error

  // Emit kernel event
  await supabase.from("lifecycle_events").insert({
    brokerage_id: profile?.brokerage_id,
    event_type: KernelEvent.VENDOR_BOOKING_CREATED,
    entity_type: "vendor_booking",
    entity_id: booking.id,
    actor_user_id: user.id,
    metadata: {
      vendor_id: data.vendorId,
      transaction_id: data.transactionId,
      service_type: data.serviceType,
      scheduled_date: data.scheduledDate,
    },
    created_at: new Date().toISOString(),
  })

  // Auto-email vendor with booking details (fire and forget).
  ;(async () => {
    try {
      const { data: vendor } = await supabase
        .from("vendors")
        .select("name, email")
        .eq("id", data.vendorId)
        .maybeSingle()

      if (!vendor?.email) return

      const { data: txn } = await supabase
        .from("transactions")
        .select("property_address, city:property_city, state:property_state, close_date")
        .eq("id", data.transactionId)
        .maybeSingle()

      const propertyLine = txn?.property_address
        ? `${txn.property_address}${txn.city ? `, ${txn.city}` : ""}${txn.state ? `, ${txn.state}` : ""}`
        : "(property address pending)"
      const closeDateLine = txn?.close_date
        ? new Date(txn.close_date).toLocaleDateString()
        : "TBD"
      const scheduledLine = data.scheduledDate
        ? new Date(data.scheduledDate).toLocaleString()
        : "Will be coordinated separately"
      const costLine = typeof data.cost === "number"
        ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(data.cost)
        : "Quote pending"

      const subject = `New booking: ${data.serviceType} for ${propertyLine}`
      const html = `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;background:#f9fafb;padding:32px 0">
        <table width="560" style="margin:0 auto;background:#fff;border-radius:8px;overflow:hidden">
          <tr><td style="padding:20px;background:#1f2937;color:#fff">
            <h2 style="margin:0">New booking confirmed</h2>
            <p style="margin:4px 0 0;opacity:.85;font-size:13px">Hi ${vendor.name ?? "there"},</p>
          </td></tr>
          <tr><td style="padding:20px">
            <p style="margin:0 0 12px;font-size:14px">A new <strong>${data.serviceType}</strong> booking has been created for you.</p>
            <table style="width:100%;font-size:13px">
              <tr><td style="padding:6px 0;color:#6b7280;width:140px">Property</td><td>${propertyLine}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280">Scheduled</td><td>${scheduledLine}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280">Close date</td><td>${closeDateLine}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280">Cost</td><td>${costLine}</td></tr>
              ${data.notes ? `<tr><td style="padding:6px 0;color:#6b7280;vertical-align:top">Notes</td><td>${data.notes.replace(/</g, "&lt;")}</td></tr>` : ""}
            </table>
            <p style="margin:16px 0 0;font-size:13px">View and confirm in your vendor portal.</p>
          </td></tr>
        </table></body></html>`

      const fromEmail = process.env.SENDGRID_FROM_EMAIL ?? "noreply@vip-re.com"
      await dispatchEmail({
        brokerageId: profile?.brokerage_id ?? "",
        userId: user.id,
        systemSource: "vendor_booking",
        from: `${(await import("@/lib/platform/product-brand")).DEFAULT_PRODUCT_BRAND.name} <${fromEmail}>`,
        to: vendor.email,
        subject,
        html,
        channelPurpose: "transactional",
      })
    } catch (err: any) {
      console.error("[vendor-marketplace] booking auto-email failed:", err?.message)
    }
  })()

  // Revalidate inside function to avoid module-level server dependency
  const { revalidatePath } = await import("next/cache")
  revalidatePath(`/dashboard/transactions/${data.transactionId}`)
  revalidatePath("/dashboard/vendors")
  return booking
}

export async function getAssignedVendorsForTransaction(transactionId: string) {
  const supabase = await createClient()

  // Auth gate — was previously open and leaked vendor contact info +
  // job costs for any transaction.
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []
  const { data: u } = await supabase
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (!u?.brokerage_id) return []

  const { data: tx } = await supabase
    .from("transactions").select("brokerage_id").eq("id", transactionId).maybeSingle()
  if (!tx || tx.brokerage_id !== u.brokerage_id) return []

  const { data: assignments, error } = await supabase
    .from("vendor_assignments")
    .select(`
      id,
      vendor_id,
      assignment_type,
      scheduled_date,
      status,
      vendors:vendor_id(id, name, category, phone, email),
      vendor_jobs!vendor_jobs_assignment_id_fkey(id, job_title, status, cost_estimate, cost_actual)
    `)
    .eq("transaction_id", transactionId)
    .eq("brokerage_id", u.brokerage_id)
    .order("scheduled_date", { ascending: false, nullsFirst: false })

  if (error) throw error
  return assignments || []
}

export async function getAgentAssignedVendors(limit: number = 50) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const { data: agent } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle()

  let query = supabase
    .from("vendor_assignments")
    .select(`
      id,
      transaction_id,
      vendor_id,
      assignment_type,
      scheduled_date,
      status,
      transactions:transaction_id(id, property_address),
      vendors:vendor_id(id, name, category)
    `)

  if (agent) {
    query = query.eq("assigned_by_agent_id", agent.id)
  } else {
    // Fallback: return empty if no agent row found
    return []
  }

  const { data: assignments } = await query
    .order("scheduled_date", { ascending: false, nullsFirst: false })
    .limit(limit)

  return assignments || []
}
