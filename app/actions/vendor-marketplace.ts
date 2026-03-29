import { createClient } from "@/lib/supabase/server"
import { KernelEvent } from "@/lib/kernel/events"

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

  revalidatePath(`/dashboard/transactions/${data.transactionId}`)
  revalidatePath("/dashboard/vendors")
  return booking
}

export async function getVendorBookingsForTransaction(transactionId: string) {
  const supabase = await createClient()

  const { data: bookings, error } = await supabase
    .from("vendor_bookings")
    .select(`
      *,
      vendors:vendor_id(id, name, email, phone, category, rating)
    `)
    .eq("transaction_id", transactionId)
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

  const { data: booking, error } = await supabase
    .from("vendor_bookings")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
    })
    .eq("id", bookingId)
    .select("*, transactions:transaction_id(id)")
    .maybeSingle()

  if (error) throw error
  if (!booking) throw new Error("Booking not found")

  // Revalidate inside function to avoid module-level server dependency
  const { revalidatePath } = await import("next/cache")
  revalidatePath("/dashboard/vendors")
  revalidatePath(`/dashboard/transactions/${booking.transactions.id}`)
  return booking
}

// ============================================
// VENDOR RATINGS & REVIEWS
// ============================================

export async function rateVendorBooking(data: {
  bookingId: string
  rating: number
  review?: string
}) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  // Get booking to find vendor
  const { data: booking } = await supabase
    .from("vendor_bookings")
    .select("vendor_id, transaction_id, brokerage_id")
    .eq("id", data.bookingId)
    .maybeSingle()

  if (!booking) throw new Error("Booking not found")

  // Update booking with rating
  const { error: updateError } = await supabase
    .from("vendor_bookings")
    .update({
      agent_rating: data.rating,
    })
    .eq("id", data.bookingId)

  if (updateError) throw updateError

  // Insert vendor review
  const { error: reviewError } = await supabase
    .from("vendor_reviews")
    .insert({
      vendor_id: booking.vendor_id,
      user_id: user.id,
      brokerage_id: booking.brokerage_id,
      rating: data.rating,
      review: data.review,
    })

  if (reviewError) throw reviewError

  // Recalculate vendor_ratings aggregate
  await recalculateVendorRatings(booking.vendor_id, booking.brokerage_id)

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
    }, { onConflict: "vendor_id,brokerage_id" })

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

  const { data: reviews } = await supabase
    .from("vendor_reviews")
    .select(`
      id,
      rating,
      review,
      created_at,
      users:user_id(first_name, last_name)
    `)
    .eq("vendor_id", vendorId)
    .eq("brokerage_id", profile.brokerage_id)
    .order("created_at", { ascending: false })
    .limit(20)

  return reviews || []
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
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) return []

  const { data: bookings } = await supabase
    .from("vendor_bookings")
    .select(`
      *,
      vendors:vendor_id(id, name, category, rating),
      transactions:transaction_id(id, property_address)
    `)
    .eq("brokerage_id", profile.brokerage_id)
    .order("created_at", { ascending: false })
    .limit(limit)

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

  // Get agent ID from user
  const { data: agent } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle()

  // Create vendor assignment (agent may not have agents row — use user.id as fallback)
  const agentRowId = agent?.id ?? user.id

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
      status: "assigned",
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
      assigned_by_agent_id: agent.id,
    },
    created_at: new Date().toISOString(),
  })

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

  // Revalidate inside function to avoid module-level server dependency
  const { revalidatePath } = await import("next/cache")
  revalidatePath(`/dashboard/transactions/${data.transactionId}`)
  revalidatePath("/dashboard/vendors")
  return booking
}

export async function getAssignedVendorsForTransaction(transactionId: string) {
  const supabase = await createClient()

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
