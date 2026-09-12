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
  // 🚨 CROSS-TENANT WRITE. This proved only that SOMEBODY was logged in
  // (`auth.getUser()`), then updated on `id` ALONE. A bare booking uuid let any
  // authenticated user mark any other brokerage's booking completed, cancelled
  // or no_show — and `no_show` feeds the vendor no-show autopilot
  // (lib/kernel/vendor-no-show-autopilot.ts), so this could drive another
  // tenant's vendor penalties. Found by this file's own tenancy guard while it
  // was being written for the two READS below; it is the same missing predicate,
  // on the more damaging verb.
  const auth = await requireVendorCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = await createClient()

  // §3 — an UPDATE that matches NOTHING also resolves: `error` is null and the
  // result is empty, byte-identical to an update that worked. So a wrong-tenant
  // booking would report SUCCESS and the panel would redraw the new status that
  // was never written. `.select()` the update and COUNT what came back.
  //
  // brokerage_id is nullable on this table, so an untenanted row is excluded by
  // this predicate and refused — an unprovable owner fails closed (§4).
  const { data: updated, error } = await supabase
    .from("vendor_bookings")
    .update({
      status: params.toStatus,
      notes: params.notes ?? null,
      ...(params.toStatus === "completed"
        ? { completed_at: new Date().toISOString() }
        : {}),
    })
    .eq("id", params.bookingId)
    .eq("brokerage_id", auth.brokerageId)
    .select("id")

  if (error) return { success: false, error: error.message }
  if (!updated || updated.length === 0) {
    return { success: false, error: "Booking not found" }
  }
  return { success: true }
}
import { generateObject } from "@/lib/ai/generate"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { modelAuthoredToVendorVerdict } from "@/lib/vendors/appraiser-independence"
import { benchCategoryFilter, type VendorCategory } from "@/lib/kernel/vendor-categories"
import { z } from "zod"

// ============================================================================
// AI VENDOR MANAGEMENT SYSTEM
// Smart vendor recommendations, performance tracking, and coordination
// ============================================================================

/**
 * Get AI-powered vendor recommendations based on job requirements
 */
export async function getVendorRecommendations(params: {
  /**
   * Ignored — the actor is the SESSION (see BOOKING HISTORY IS SELF-SCOPED
   * below). Kept optional so existing call sites type-check; it is NOT
   * validated, because validating an identity the function never uses only
   * forces callers to invent a uuid to get past the door. Same shape as
   * `requestVendorReview` in this file.
   */
  agentId?: string
  /**
   * ── §6, m561: THE SECOND SPELLING IS GONE. ─────────────────────────────────
   *
   * 🚨 THIS WAS A TEN-VALUE UNION OF ITS OWN:
   *
   *     "photography" | "staging" | "inspection" | "appraisal" | "cleaning"
   *   | "landscaping" | "repairs" | "moving" | "title" | "escrow"
   *
   * …filtered with `.ilike("category", '%${serviceType}%')` against
   * `vendors.category`, whose live CHECK admits a DIFFERENT 39-value spelling of
   * the same taxonomy. Measured live against that CHECK (project
   * hrvaqgvukzxfskkcrwbt, 2026-08-25): EIGHT OF THE TEN MATCHED NOTHING —
   * photography/photographer, staging/stager, inspection/inspector,
   * appraisal/appraiser, cleaning/cleaner, repairs/contractor, moving/mover, and
   * `escrow`, which has no member at all. Only `landscaping` and `title`
   * matched. So this action answered "who should I hire?" from an EMPTY BENCH
   * for 8 of its 10 inputs — and still spent the gpt-4o call below doing it.
   *
   * The type is now the vocabulary the column actually admits. It is widened,
   * not narrowed: all 39 trades are reachable where 2 were, and the old
   * spellings still resolve through VENDOR_CATEGORY_SYNONYMS at
   * lib/kernel/vendor-categories.ts, so a caller that has not been updated is
   * translated rather than silently answered with nothing. `string` is accepted
   * at the door for exactly that reason; benchCategoryFilter REFUSES anything it
   * cannot place, rather than falling through to a query that cannot match.
   */
  serviceType: VendorCategory | (string & {})
  propertyId?: string
  budget?: number
  urgency?: "standard" | "rush" | "emergency"
  requirements?: string[]
}) {
  // Not an orphan, but the same hole as its siblings: anonymous AI spend plus a
  // cross-tenant read of every vendor's email and phone.
  const auth = await requireVendorCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  // REFUSE AN UNPLACEABLE TRADE BEFORE ANY READ OR ANY SPEND. A service type the
  // vocabulary cannot express is not a thin bench — it is a question this
  // platform cannot ask, and it used to render as "no vendors available".
  const filter = benchCategoryFilter(params.serviceType)
  if (!filter.ok) return { success: false, error: filter.error }

  const supabase = await createClient()

  try {
    // Get available vendors for the service type — use vendors table (not vendor_directory)
    //
    // `.eq`, NOT `.ilike('%…%')`. Over a CLOSED vocabulary a substring match has
    // two failure modes and both were live: it missed (8 of 10 above), and it
    // over-matched — `%lender%` also returns every `refinance_lender`, which is
    // a separate member of the CHECK on purpose. Verified live against the
    // 39-value vocabulary. See benchCategoryFilter's header.
    const { data: vendors, error: benchErr } = await supabase
      .from("vendors")
      .select("id, name, category, email, phone, website, rating, notes, brokerage_id")
      .eq("category", filter.category)
      // The row already carried brokerage_id and it was selected but never used
      // to filter — so this returned every brokerage's vendor contact list.
      .eq("brokerage_id", auth.brokerageId)

    // ── DO NOT SPEND ON AN EMPTY BENCH (CLAUDE.md §5) ────────────────────────
    // supabase-js RESOLVES a refusal (§3), so `vendors` being empty had two
    // causes that were indistinguishable here — a refused read and a genuinely
    // empty bench — and BOTH used to fall through to gpt-4o. There is no product
    // in recommending three vendors from a list of zero: the model either
    // returns an empty array (a paid no-op booked against the tenant) or invents
    // vendor names and ids that no bench row backs. Both fail closed, before the
    // call.
    if (benchErr) {
      return { success: false, error: "Could not read your vendor bench." }
    }
    if (!vendors || vendors.length === 0) {
      return {
        success: false,
        error: `No ${filter.category} is on your brokerage's vendor bench yet — add one before asking for a recommendation.`,
      }
    }

    // ── BOOKING HISTORY IS SELF-SCOPED — TENANT AND ACTOR FROM THE SESSION ────
    // 🚨 This filtered `booked_by` on params.agentId — a REQUEST-BODY identity —
    // with NO brokerage predicate. `requireVendorCaller()` proves the caller is
    // authenticated SOMEWHERE; it did not constrain WHOSE history was read. So
    // any authenticated user read any agent's booking history, spend and vendor
    // ratings in ANY tenant. That is the body-supplied-identity IDOR shape
    // CLAUDE.md §4 names.
    //
    // TWO corrections, not one:
    //   • The actor is `auth.userId`, NOT an agents.id. vendor_bookings.booked_by
    //     holds a users.id — every writer stamps one (vendor-marketplace.ts:338
    //     and :1386 `booked_by: user.id`; lib/kernel/vendors.ts:552
    //     `booked_by: agentUserId`). agents.id and users.id are DISJOINT (§3), so
    //     "fixing" this with ctx.agentId would have matched zero rows and read as
    //     an empty history rather than as a refusal.
    //   • The brokerage predicate is added, so the row must ALSO be ours.
    //
    // `error` is destructured because a refused read still SPENDS the gpt-4o call
    // below, recommending against a history it never saw (§3: supabase-js
    // RESOLVES refusals). Fails closed BEFORE the spend.
    const { data: pastJobs, error: pastJobsErr } = await supabase
      .from("vendor_bookings")
      .select("id, vendor_id, service_type, agent_rating, client_rating, status, vendors:vendor_id(name, category)")
      .eq("booked_by", auth.userId)
      .eq("brokerage_id", auth.brokerageId)
      .eq("status", "completed")
      .order("completed_at", { ascending: false })
      .limit(50)

    if (pastJobsErr) {
      return { success: false, error: "Could not load your booking history." }
    }

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

Service Type: ${filter.category}
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
  /**
   * Ignored — the actor is the SESSION. Kept optional so existing call sites
   * type-check; it is NOT validated, because validating an identity the
   * function never uses only forces callers to invent a uuid to get past the
   * door. Same shape as `requestVendorReview` in this file.
   */
  agentId?: string
  vendorId?: string
  timeframe?: "30_days" | "90_days" | "6_months" | "1_year"
} = {}) {
  // Not an orphan; gated for the same reason as its siblings above — it was an
  // anonymous gpt-4o call over another agent's booking history and spend.
  const auth = await requireVendorCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = await createClient()

  try {
    // ── TENANT AND ACTOR FROM THE SESSION (CLAUDE.md §4) ─────────────────────
    // 🚨 This read `booked_by = params.agentId` — an identity taken from the
    // REQUEST BODY — with NO brokerage predicate. The gate above proves only
    // that the caller is authenticated SOMEWHERE, so any authenticated user
    // could name any agent's uuid and receive that agent's whole booking
    // history, per-job COST, spend totals and vendor ratings, across tenants —
    // and this endpoint's own output is a cost analysis, i.e. another
    // brokerage's financials (§5: contacts, lenders and vendors see no
    // financials; neither does another tenant).
    //
    // The actor is `auth.userId`, NOT an agents.id: vendor_bookings.booked_by
    // holds a users.id (writers at vendor-marketplace.ts:338/:1386 and
    // lib/kernel/vendors.ts:552). agents.id and users.id are DISJOINT (§3) —
    // filtering with an agents.id would return zero rows and read as "this
    // agent has no history" instead of as a refusal.
    let query = supabase
      .from("vendor_bookings")
      .select("id, vendor_id, service_type, status, agent_rating, client_rating, cost, completed_at, vendors:vendor_id(name, category, rating)")
      .eq("booked_by", auth.userId)
      .eq("brokerage_id", auth.brokerageId)

    if (params.vendorId && isValidUUID(params.vendorId)) {
      query = query.eq("vendor_id", params.vendorId)
    }

    // `error` is read for the same reason as in getVendorRecommendations: a
    // refused read resolves, and the gpt-4o call below would then bill the
    // tenant for an "analysis" of an empty history. Fail closed BEFORE spend.
    const { data: jobs, error: jobsErr } = await query.order("created_at", { ascending: false }).limit(100)

    if (jobsErr) {
      return { success: false, error: "Could not load your booking history." }
    }

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

    // `error` is destructured for the same reason it is above AND for a new one:
    // the appraiser-independence gate below is computed FROM this read, so a
    // refused read is a gate that could not run. supabase-js resolves refusals,
    // so discarding `error` here would have turned "we could not see the bench"
    // into "there is no appraiser on it" (CLAUDE.md §3, §4).
    const { data: vendors, error: vendorsErr } = await supabase
      .from("vendors")
      .select("id, name, category, phone, email")
      .in("id", vendorIds)
      // Vendor phone/email is contact PII — never return another tenant's.
      .eq("brokerage_id", auth.brokerageId)

    // ── CLAUDE.md §5 — NOTHING MODEL-AUTHORED MAY REACH A LICENSED APPRAISER ──
    //
    // This is the one surface m554's widening put at risk. The schema below asks
    // the model for `communicationPlan.vendorMessages[]` — messages ADDRESSED TO
    // a named vendor, which the panel renders with a Copy button for the agent to
    // send. Since m554 `appraiser` is a bench category, so an appraiser can now be
    // one of those named vendors, and a model writing to an appraiser about a
    // specific listing is exactly what appraiser-independence rules exist to stop.
    //
    // The check runs BEFORE the model call, not after: refusing afterwards would
    // still have produced the text and spent the platform's key producing it. The
    // rule itself lives once, at lib/vendors/appraiser-independence.ts — this is a
    // call site, not a second copy of the rule.
    const reach = modelAuthoredToVendorVerdict({
      resolved: !vendorsErr,
      vendorCategories: (vendors ?? []).map((v: { category?: string | null }) => v.category),
      // A request can ask for appraisal work without naming a bench row, and the
      // model would then write to an appraiser who has no id here to check.
      serviceLabels: params.services.flatMap((s) => [s.serviceType, s.notes]),
    })
    if (!reach.ok) return { success: false, error: reach.message }

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
  /**
   * Ignored — the actor is the session. Kept optional so existing call sites
   * type-check; it is NOT validated, because validating an identity the function
   * never uses only forces callers to invent a uuid to get past the door.
   */
  agentId?: string
  jobId: string
}) {
  // 🚨 Was anonymous: a bare job uuid returned another tenant's vendor name and
  // the transaction's PROPERTY ADDRESS, and spent a model call doing it.
  const auth = await requireVendorCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!isValidUUID(params.jobId)) {
    return { success: false, error: "Invalid job ID" }
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
