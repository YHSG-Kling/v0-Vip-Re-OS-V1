"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"

// ── AUTH GATE ────────────────────────────────────────────────────────────────
// 🚨 Every AI export in this file was reachable with NO session at all.
// `transitionBookingStatus` below does `auth.getUser()` and refuses — that is the
// file's own house pattern — but `getVendorRecommendations`,
// `analyzeVendorPerformance`, `coordinateVendors` and `requestVendorReview` all
// skipped it. Each of the four is a `"use server"` export, i.e. a public HTTP
// endpoint, and each one calls a model on the platform's key. `isValidUUID()` is
// input validation, not authorization.
//
// NOT exported — a "use server" module may only export async functions, and this
// is an internal gate, not an endpoint.
async function requireVendorCaller(): Promise<
  { ok: true; userId: string; brokerageId: string } | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }
  if (!ctx.brokerageId) return { ok: false, error: "No brokerage on this account" }
  return { ok: true, userId: ctx.userId, brokerageId: ctx.brokerageId }
}

// ── Vendor booking lifecycle ─────────────────────────────────────────────────

export type VendorBookingStatus =
  | "booked"
  | "confirmed"
  | "completed"
  | "cancelled"
  | "no_show"

/**
 * Transition a vendor booking to a new lifecycle status.
 * Appends a completed_at timestamp when moving to "completed".
 */
export async function transitionBookingStatus(params: {
  bookingId: string
  toStatus: VendorBookingStatus
  notes?: string
}): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) return { success: false, error: "Unauthorized" }

  const { error } = await supabase
    .from("vendor_bookings")
    .update({
      status: params.toStatus,
      notes: params.notes ?? null,
      ...(params.toStatus === "completed"
        ? { completed_at: new Date().toISOString() }
        : {}),
    })
    .eq("id", params.bookingId)

  if (error) return { success: false, error: error.message }
  return { success: true }
}
import { generateObject } from "@/lib/ai/generate"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { z } from "zod"

// ============================================================================
// AI VENDOR MANAGEMENT SYSTEM
// Smart vendor recommendations, performance tracking, and coordination
// ============================================================================

/**
 * Get AI-powered vendor recommendations based on job requirements
 */
export async function getVendorRecommendations(params: {
  agentId: string
  serviceType: "photography" | "staging" | "inspection" | "appraisal" | "cleaning" | "landscaping" | "repairs" | "moving" | "title" | "escrow"
  propertyId?: string
  budget?: number
  urgency?: "standard" | "rush" | "emergency"
  requirements?: string[]
}) {
  // Not an orphan, but the same hole: anonymous AI spend plus a cross-tenant read
  // of every vendor's email and phone. Gate added; `agentId` is still used as the
  // data filter it has always been (booked_by), only the anonymity is closed.
  const auth = await requireVendorCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    // Get available vendors for the service type — use vendors table (not vendor_directory)
    const { data: vendors } = await supabase
      .from("vendors")
      .select("id, name, category, email, phone, website, rating, notes, brokerage_id")
      .ilike("category", `%${params.serviceType}%`)
      // The row already carried brokerage_id and it was selected but never used
      // to filter — so this returned every brokerage's vendor contact list.
      .eq("brokerage_id", auth.brokerageId)

    // Get agent's past vendor usage via vendor_assignments
    const { data: pastJobs } = await supabase
      .from("vendor_bookings")
      .select("id, vendor_id, service_type, agent_rating, client_rating, status, vendors:vendor_id(name, category)")
      .eq("booked_by", params.agentId)
      .eq("status", "completed")
      .order("completed_at", { ascending: false })
      .limit(50)

    // Get property details if provided
    let propertyData = null
    if (params.propertyId && isValidUUID(params.propertyId)) {
      const { data } = await supabase
        .from("listings")
        .select("*")
        .eq("id", params.propertyId)
        .single()
      propertyData = data
    }

    const { object: recommendations } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        topRecommendations: z.array(z.object({
          vendorId: z.string(),
          vendorName: z.string(),
          matchScore: z.number(),
          reasoning: z.string(),
          strengths: z.array(z.string()),
          considerations: z.array(z.string()),
          estimatedCost: z.number(),
          estimatedTimeline: z.string(),
          availability: z.enum(["available", "limited", "booked"]),
          pastPerformance: z.object({
            jobsCompleted: z.number(),
            avgRating: z.number(),
            onTimeRate: z.number()
          }).optional()
        })),
        alternativeOptions: z.array(z.object({
          vendorId: z.string(),
          vendorName: z.string(),
          reason: z.string()
        })),
        budgetAnalysis: z.object({
          estimatedTotal: z.number(),
          budgetFit: z.enum(["under_budget", "at_budget", "over_budget"]),
          costSavingTips: z.array(z.string())
        }),
        schedulingRecommendation: z.object({
          optimalTimeframe: z.string(),
          peakAvoidance: z.string(),
          coordinationTips: z.array(z.string())
        })
      }),
      prompt: `Recommend vendors for this job:

Service Type: ${params.serviceType}
Budget: ${params.budget ? `$${params.budget}` : "Not specified"}
Urgency: ${params.urgency || "standard"}
Special Requirements: ${params.requirements?.join(", ") || "None"}

Property Details:
${JSON.stringify(propertyData || {}, null, 2)}

Available Vendors:
${JSON.stringify(vendors?.map(v => ({
  id: v.id,
  name: v.name,
  category: v.category,
  rating: v.rating,
  phone: v.phone,
  email: v.email,
})) || [], null, 2)}

Agent's Past Vendor Usage:
${JSON.stringify(pastJobs?.slice(0, 10).map((j: any) => ({
  vendor: j.vendors?.name,
  serviceType: j.service_type,
  agentRating: j.agent_rating,
  clientRating: j.client_rating,
})) || [], null, 2)}

Provide:
1. Top 3 vendor recommendations with match scores
2. Alternative options
3. Budget analysis
4. Scheduling recommendations`
    })

    return {
      success: true,
      recommendations
    }
  } catch (error) {
    console.error("[v0] Get vendor recommendations error:", error)
    return handleError(error, "getVendorRecommendations")
  }
}

/**
 * Analyze vendor performance and generate insights
 */
export async function analyzeVendorPerformance(params: {
  agentId: string
  vendorId?: string
  timeframe?: "30_days" | "90_days" | "6_months" | "1_year"
}) {
  // Not an orphan; gated for the same reason as its siblings above — it was an
  // anonymous gpt-4o call over another agent's booking history and spend.
  const auth = await requireVendorCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    // Get vendor bookings using vendor_bookings table (agent-linked via booked_by)
    let query = supabase
      .from("vendor_bookings")
      .select("id, vendor_id, service_type, status, agent_rating, client_rating, cost, completed_at, vendors:vendor_id(name, category, rating)")
      .eq("booked_by", params.agentId)

    if (params.vendorId && isValidUUID(params.vendorId)) {
      query = query.eq("vendor_id", params.vendorId)
    }

    const { data: jobs } = await query.order("created_at", { ascending: false }).limit(100)

    const { object: analysis } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        overallPerformance: z.object({
          totalJobs: z.number(),
          avgRating: z.number(),
          onTimeDeliveryRate: z.number(),
          budgetAdherenceRate: z.number(),
          issueRate: z.number()
        }),
        vendorRankings: z.array(z.object({
          vendorId: z.string(),
          vendorName: z.string(),
          overallScore: z.number(),
          jobsCompleted: z.number(),
          avgRating: z.number(),
          reliability: z.enum(["excellent", "good", "fair", "poor"]),
          valueForMoney: z.enum(["excellent", "good", "fair", "poor"]),
          recommendation: z.string()
        })),
        costAnalysis: z.object({
          totalSpent: z.number(),
          avgCostPerJob: z.number(),
          costByServiceType: z.array(z.object({
            serviceType: z.string(),
            totalSpent: z.number(),
            avgCost: z.number()
          })),
          savingsOpportunities: z.array(z.string())
        }),
        qualityTrends: z.object({
          improving: z.array(z.string()),
          declining: z.array(z.string()),
          consistent: z.array(z.string())
        }),
        recommendations: z.array(z.object({
          type: z.enum(["continue", "increase_usage", "decrease_usage", "replace", "negotiate"]),
          vendorName: z.string(),
          reasoning: z.string(),
          action: z.string()
        })),
        redFlags: z.array(z.object({
          vendorName: z.string(),
          issue: z.string(),
          severity: z.enum(["high", "medium", "low"]),
          suggestedAction: z.string()
        }))
      }),
      prompt: `Analyze vendor performance:

Timeframe: ${params.timeframe || "90 days"}

Job History:
${JSON.stringify(jobs?.map((j: any) => ({
  vendor: j.vendors?.name,
  category: j.vendors?.category,
  serviceType: j.service_type,
  cost: j.cost,
  agentRating: j.agent_rating,
  clientRating: j.client_rating,
  status: j.status,
  completedAt: j.completed_at,
})) || [], null, 2)}

Provide comprehensive analysis:
1. Overall performance metrics
2. Vendor rankings
3. Cost analysis and savings opportunities
4. Quality trends
5. Recommendations for each vendor
6. Red flags to watch`
    })

    return {
      success: true,
      analysis
    }
  } catch (error) {
    console.error("[v0] Analyze vendor performance error:", error)
    return handleError(error, "analyzeVendorPerformance")
  }
}

/**
 * Coordinate multiple vendors for a listing
 */
export async function coordinateVendors(params: {
  agentId: string
  listingId: string
  services: {
    serviceType: string
    vendorId?: string
    preferredDate?: string
    notes?: string
  }[]
}) {
  // 🚨 Was an ANONYMOUS gpt-4o endpoint. `params.services` is caller-authored free
  // text (`serviceType`, `notes`) that gets JSON.stringify'd straight into the
  // prompt below — so before this gate, anyone on the internet had an unmetered
  // gpt-4o proxy on the platform's key, plus a cross-tenant read of any listing's
  // address and any vendor's phone and email on the way past.
  const auth = await requireVendorCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!isValidUUID(params.agentId) || !isValidUUID(params.listingId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    // Get listing details. `error` is destructured: supabase-js resolves a refused
    // query, and the old code interpolated `listing?.address || "N/A"` into the
    // prompt — so a refused or cross-tenant read still SPENT the gpt-4o call,
    // planning against "N/A".
    const { data: listing, error: listingErr } = await supabase
      .from("listings")
      .select("id, address, city, state, brokerage_id")
      .eq("id", params.listingId)
      .maybeSingle()

    if (listingErr) return { success: false, error: "Could not load that listing." }
    // listings.brokerage_id is nullable, so compare explicitly and refuse an
    // untenanted row rather than filtering on it — an unprovable owner fails closed.
    if (!listing || listing.brokerage_id !== auth.brokerageId) {
      return { success: false, error: "Listing not found" }
    }

    // Get vendor details (use vendors table)
    const vendorIds = params.services
      .filter(s => s.vendorId && isValidUUID(s.vendorId))
      .map(s => s.vendorId as string)

    const { data: vendors } = await supabase
      .from("vendors")
      .select("id, name, category, phone, email")
      .in("id", vendorIds)
      // Vendor phone/email is contact PII — never return another tenant's.
      .eq("brokerage_id", auth.brokerageId)

    const { object: coordination } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        schedulePlan: z.array(z.object({
          serviceType: z.string(),
          vendorName: z.string(),
          suggestedDate: z.string(),
          suggestedTime: z.string(),
          duration: z.string(),
          prerequisites: z.array(z.string()),
          conflictsWith: z.array(z.string())
        })),
        timeline: z.object({
          startDate: z.string(),
          completionDate: z.string(),
          totalDays: z.number(),
          criticalPath: z.array(z.string())
        }),
        coordinationNotes: z.array(z.object({
          service: z.string(),
          note: z.string(),
          priority: z.enum(["high", "medium", "low"])
        })),
        potentialConflicts: z.array(z.object({
          services: z.array(z.string()),
          issue: z.string(),
          resolution: z.string()
        })),
        communicationPlan: z.object({
          vendorMessages: z.array(z.object({
            vendorName: z.string(),
            subject: z.string(),
            message: z.string()
          })),
          sellerUpdate: z.string()
        }),
        budgetSummary: z.object({
          estimatedTotal: z.number(),
          breakdown: z.array(z.object({
            service: z.string(),
            cost: z.number()
          }))
        })
      }),
      prompt: `Create a vendor coordination plan:

Listing: ${listing?.address || "N/A"}
City: ${listing?.city || "N/A"}

Services Needed:
${JSON.stringify(params.services, null, 2)}

Available Vendors:
${JSON.stringify(vendors || [], null, 2)}

Create:
1. Optimal scheduling plan avoiding conflicts
2. Timeline with critical path
3. Coordination notes and tips
4. Potential conflicts and resolutions
5. Communication templates for vendors
6. Budget summary`
    })

    // Return coordination plan (vendor_coordination_plans table doesn't exist — return in-memory)
    return {
      success: true,
      coordination,
    }
  } catch (error) {
    console.error("[v0] Coordinate vendors error:", error)
    return handleError(error, "coordinateVendors")
  }
}

/**
 * Generate vendor review request with AI-crafted message
 */
export async function requestVendorReview(params: {
  agentId: string
  jobId: string
}) {
  // 🚨 Was anonymous: a bare job uuid returned another tenant's vendor name and
  // the transaction's PROPERTY ADDRESS, and spent a model call doing it.
  const auth = await requireVendorCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!isValidUUID(params.agentId) || !isValidUUID(params.jobId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    const { data: job, error: jobErr } = await supabase
      .from("vendor_jobs")
      .select(`
        id, job_title, status, brokerage_id,
        vendor_id,
        vendors:vendor_id(name, category),
        vendor_assignments:assignment_id(
          transaction_id,
          transactions:transaction_id(property_address)
        )
      `)
      .eq("id", params.jobId)
      .maybeSingle()

    // A refused read is not "no rows" — both fail closed, before any spend.
    if (jobErr) {
      return { success: false, error: "Could not load that job." }
    }
    // vendor_jobs.brokerage_id is nullable, so this compares explicitly and
    // refuses an untenanted row instead of filtering on a column that may be NULL.
    if (!job || (job as any).brokerage_id !== auth.brokerageId) {
      return { success: false, error: "Job not found" }
    }

    const vendorName = (job as any).vendors?.name || "the vendor"
    const propertyAddress = (job as any).vendor_assignments?.transactions?.property_address || "N/A"

    const { text: reviewRequest } = await generateText({
      // Was `feature: "unspecified"` with no userId/brokerageId, so this model
      // call was logged against nobody. generateTextRouted takes all three for
      // usage logging; routing behaviour is unchanged (an unknown feature key
      // falls back to the same default row "unspecified" resolved to).
      feature: "vendor_review_request",
      userId: auth.userId,
      brokerageId: auth.brokerageId,
      prompt: `Generate a professional review request for a vendor:

Vendor: ${vendorName}
Service: ${(job as any).job_title}
Property: ${propertyAddress}
Completion Date: recently

Create a friendly, professional message asking for feedback on the vendor's service.
Include:
1. Thank them for their service
2. Ask specific questions about quality, timeliness, communication
3. Request a 1-5 star rating
4. Keep it brief and easy to respond to`
    })

    return {
      success: true,
      reviewRequest,
      vendorName,
    }
  } catch (error) {
    console.error("[v0] Request vendor review error:", error)
    return handleError(error, "requestVendorReview")
  }
}
