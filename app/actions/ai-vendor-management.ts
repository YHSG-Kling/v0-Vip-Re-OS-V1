"use server"

import { createClient } from "@/lib/supabase/server"

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
import { generateObject } from "ai"
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
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    // Get available vendors for the service type
    const { data: vendors } = await supabase
      .from("vendor_directory")
      .select("*, vendor_reviews(*), vendor_jobs(*)")
      .eq("service_type", params.serviceType)
      .eq("status", "active")

    // Get agent's past vendor usage
    const { data: pastJobs } = await supabase
      .from("vendor_jobs")
      .select("*, vendor_directory(*)")
      .eq("agent_id", params.agentId)
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
  name: v.company_name,
  rating: v.avg_rating,
  reviews: v.vendor_reviews?.length || 0,
  pricing: v.pricing_tier,
  specializations: v.specializations
})) || [], null, 2)}

Agent's Past Vendor Usage:
${JSON.stringify(pastJobs?.slice(0, 10).map(j => ({
  vendor: j.vendor_directory?.company_name,
  rating: j.rating,
  feedback: j.feedback
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
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    // Get vendor jobs
    let query = supabase
      .from("vendor_jobs")
      .select("*, vendor_directory(*)")
      .eq("agent_id", params.agentId)

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
${JSON.stringify(jobs?.map(j => ({
  vendor: j.vendor_directory?.company_name,
  serviceType: j.service_type,
  cost: j.cost,
  rating: j.rating,
  onTime: j.completed_on_time,
  issues: j.issues_reported,
  feedback: j.feedback
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
  if (!isValidUUID(params.agentId) || !isValidUUID(params.listingId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    // Get listing details
    const { data: listing } = await supabase
      .from("listings")
      .select("*")
      .eq("id", params.listingId)
      .single()

    // Get vendor availability
    const vendorIds = params.services
      .filter(s => s.vendorId && isValidUUID(s.vendorId))
      .map(s => s.vendorId)

    const { data: vendors } = await supabase
      .from("vendor_directory")
      .select("*")
      .in("id", vendorIds)

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

    // Save coordination plan
    const { data: plan, error } = await supabase
      .from("vendor_coordination_plans")
      .insert({
        agent_id: params.agentId,
        listing_id: params.listingId,
        services: params.services,
        coordination_plan: coordination,
        status: "pending",
        created_at: new Date().toISOString()
      })
      .select()
      .single()

    return {
      success: true,
      coordination,
      planId: plan?.id
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
  if (!isValidUUID(params.agentId) || !isValidUUID(params.jobId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    const { data: job } = await supabase
      .from("vendor_jobs")
      .select("*, vendor_directory(*), listings(*)")
      .eq("id", params.jobId)
      .single()

    if (!job) {
      return { success: false, error: "Job not found" }
    }

    const { text: reviewRequest } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `Generate a professional review request for a vendor:

Vendor: ${job.vendor_directory?.company_name}
Service: ${job.service_type}
Property: ${job.listings?.address || "N/A"}
Completion Date: ${job.completed_at || "Recently"}

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
      vendorName: job.vendor_directory?.company_name
    }
  } catch (error) {
    console.error("[v0] Request vendor review error:", error)
    return handleError(error, "requestVendorReview")
  }
}
