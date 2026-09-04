// lib/kernel/reputation.ts
//
// REPUTATION / REVIEW / REFERRAL KERNEL — Layer 0 ownership
//
// Canonical commands for all review request creation, inbound review recording,
// review responses, referral creation, referral pipeline advancement, and
// performance analytics.
//
// Rules:
//   - Every mutation emits a KernelEvent via lifecycle_events.
//   - rating must be 1–5; validated here, not in the caller.
//   - respondToReview: reviewId must belong to the acting agentId.
//   - createReviewRequest: no duplicate pending request per contact+platform.
//   - Referral creation and stage advancement live on the wired rail,
//     app/actions/referrals/referral-actions.ts — see the tombstone below.
//   - All functions are pure async — no global state, no module-level DB calls.

import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "./events"
import { processKernelEvent } from "./notification-engine"

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

// TOMBSTONE (§1.1, BURN-C 2026-09-04) — VALID_RATINGS / Rating went with
// recordReview, their only user. The 1–5 rating check now runs on the live
// writer, app/actions/multi-persona.ts:submitClientFeedback.

// THE REVIEW PLATFORM VOCABULARY IS THE CONSTRAINT'S, NOT THE DESIGNER'S.
//
// Verified live against pg_constraint:
//   agent_reviews_platform_check → google | zillow | realtor_com | internal |
//                                  facebook | yelp
//
// This list used to read google|zillow|realtor_com|yelp|facebook|trulia|other.
// `trulia` and `other` are in NO constraint — probed against the live database,
// both are refused with SQLSTATE 23514. recordReview typed them as valid, so a
// caller could pick a platform the column cannot store; and `internal`, the
// value every in-app review actually carries (multi-persona.ts and
// portal-lifetime.ts both write it), was missing, so the ONE platform this
// system produces itself was untypeable.
export const REVIEW_PLATFORMS = [
  "google",
  "zillow",
  "realtor_com",
  "internal",
  "facebook",
  "yelp",
] as const
export type ReviewPlatform = typeof REVIEW_PLATFORMS[number]

// Referral status transition graph — only these transitions are valid.
//
// SAME RULE, SAME DEFECT CLASS. referrals.status is CHECK-constrained:
//   referrals_status_check → received | contacted | qualified | assigned |
//                            under_contract | closed | lost
// (see lib/referrals/referral-status.ts, which is the one vocabulary this graph
// is now expressed in). The previous graph was built from
// new|identified|asked|received|converting|converted|lost — FIVE of those seven
// states are storable nowhere. Only `received` and `lost` were real, so from the
// only status a referral can be created in, the single transition this function
// would permit was `converting`, which the database then refused with 23514
// (probed live). Every other stage change was rejected by the graph before it
// ever reached the column. The pipeline was unadvanceable in both directions.


// ── TOMBSTONE (orphan doctrine §1.1) — BURN-C, 2026-09-04 ────────────────────
// recordReview, createReferralRequest and advanceReferralStatus stood here. Their
// only caller was app/actions/reputation-kernel.ts, whose three thin wrappers had
// no caller of their own, so the whole chain was unreachable. Each capability was
// MERGED ONTO ITS LIVE SURVIVOR FIRST — see the tombstone in
// app/actions/reputation-kernel.ts for the per-function detail:
//   recordReview            → lib/reputation/review-landed.ts:onReviewLanded, called by
//                             app/actions/multi-persona.ts:submitClientFeedback and
//                             app/actions/portal-lifetime.ts:submitClientTestimonial
//   createReferralRequest   → app/actions/referrals/referral-actions.ts:createReferral
//   advanceReferralStatus   → app/actions/referrals/referral-actions.ts:updateReferralStatus
// The private REFERRAL_STATUS_TRANSITIONS graph and REFERRAL_TERMINAL_WON that
// served advanceReferralStatus moved to lib/referrals/referral-status.ts, beside
// the status vocabulary they are written in (§6). createReviewRequest,
// respondToReview and the three loaders below are still reached through
// app/actions/reputation-kernel.ts and stay.

// ─── INPUT / OUTPUT TYPES ─────────────────────────────────────────────────────

export interface ReputationActorContext {
  agentId:    string
  brokerageId: string
}

export interface KernelReputationResult<T = void> {
  success: boolean
  data?:   T
  error?:  string
}

export interface ReviewRow {
  id:           string
  rating:       number
  review_text:  string | null
  platform:     string
  source_url:   string | null
  is_published: boolean
  response_text: string | null
  response_at:  string | null
  created_at:   string
  contact_id:   string | null
  transaction_id: string | null
}

export interface ReviewRequestRow {
  id:           string
  contact_id:   string | null
  contact_name: string | null
  platform:     string
  status:       string
  sent_at:      string | null
  completed_at: string | null
  review_url:   string | null
  created_at:   string
}

export interface ReferralRow {
  id:                  string
  referral_name:       string
  status:              string
  referral_source:     string | null
  value_estimate:      number | null
  commission_potential: number | null
  commission_amount:   number | null
  source_contact_name: string | null
  referred_by:         string | null
  gift_sent:           boolean | null
  thank_you_sent:      boolean | null
  notes:               string | null
  created_at:          string
  converted_at:        string | null
  referred_contact_id: string | null
  referred_lead_id:    string | null
  partner_id:          string | null
}

export interface ReputationPerformance {
  avgRating:      number
  totalReviews:   number
  responseRate:   number            // pct of reviews with response_text set
  byPlatform:     Record<string, { count: number; avgRating: number }>
  recentTrend:    "improving" | "stable" | "declining"
}

export interface ReputationWorkspace {
  reviews:        ReviewRow[]
  reviewRequests: ReviewRequestRow[]
  referrals:      ReferralRow[]
  performance:    ReputationPerformance
}

export interface ReferralPipelineData {
  referrals:  ReferralRow[]
  counts:     Record<string, number>
}

// ─── INPUT TYPES ─────────────────────────────────────────────────────────────

export interface LoadReputationWorkspaceInput  extends ReputationActorContext {}
export interface LoadReviewPerformanceInput    extends ReputationActorContext {}
export interface LoadReferralPipelineInput     extends ReputationActorContext { status?: string }

export interface CreateReviewRequestInput extends ReputationActorContext {
  contactId?:   string
  contactName:  string
  platform:     ReviewPlatform
  reviewUrl?:   string
}

export interface RespondToReviewInput extends ReputationActorContext {
  reviewId:     string
  responseText: string
  publishNow?:  boolean
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

async function emitLifecycleEvent(params: {
  supabase:    ReturnType<typeof createServiceClient>
  brokerageId: string
  agentId:     string
  entityType:  string
  entityId:    string
  event:       KernelEvent
  metadata?:   Record<string, unknown>
}) {
  // The error was not destructured: a refused audit insert resolved with
  // data === null, the `if (data?.id)` below quietly skipped, and every caller
  // reported a clean success with no lifecycle row and no notification fan-out.
  const { data, error } = await params.supabase
    .from("lifecycle_events")
    .insert({
      brokerage_id: params.brokerageId,
      agent_id:     params.agentId,
      entity_type:  params.entityType,
      entity_id:    params.entityId,
      event_type:   params.event,
      metadata:     params.metadata ?? {},
      created_at:   new Date().toISOString(),
    })
    .select("id")
    .single()

  if (error) {
    console.error(
      `[kernel/reputation] lifecycle_events insert refused for ${params.event} on ${params.entityType}:${params.entityId}:`,
      error.message,
    )
    return { emitted: false as const, error: error.message }
  }

  if (data?.id) {
    processKernelEvent({
      event:             params.event,
      brokerageId:       params.brokerageId,
      entityType:        params.entityType,
      entityId:          params.entityId,
      lifecycleEventId:  data.id,
    }).catch(() => { /* non-blocking */ })
  }

  return { emitted: true as const }
}

function computePerformance(reviews: ReviewRow[]): ReputationPerformance {
  if (reviews.length === 0) {
    return {
      avgRating:    0,
      totalReviews: 0,
      responseRate: 0,
      byPlatform:   {},
      recentTrend:  "stable",
    }
  }

  const totalRating  = reviews.reduce((s, r) => s + r.rating, 0)
  const withResponse = reviews.filter(r => !!r.response_text).length
  const byPlatform: Record<string, { count: number; avgRating: number }> = {}

  for (const r of reviews) {
    if (!byPlatform[r.platform]) byPlatform[r.platform] = { count: 0, avgRating: 0 }
    byPlatform[r.platform].count++
    byPlatform[r.platform].avgRating += r.rating
  }
  for (const p of Object.keys(byPlatform)) {
    byPlatform[p].avgRating = byPlatform[p].avgRating / byPlatform[p].count
  }

  // Trend: compare avg rating of last 5 vs prior 5
  const sorted   = [...reviews].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  const recent   = sorted.slice(0, 5)
  const prior    = sorted.slice(5, 10)
  const recentAvg = recent.length  ? recent.reduce((s, r) => s + r.rating, 0) / recent.length  : 0
  const priorAvg  = prior.length   ? prior.reduce((s, r) => s + r.rating, 0)  / prior.length   : recentAvg
  const trend: ReputationPerformance["recentTrend"] =
    priorAvg === 0          ? "stable"
    : recentAvg > priorAvg + 0.2  ? "improving"
    : recentAvg < priorAvg - 0.2  ? "declining"
    : "stable"

  return {
    avgRating:    Math.round((totalRating / reviews.length) * 10) / 10,
    totalReviews: reviews.length,
    responseRate: Math.round((withResponse / reviews.length) * 100),
    byPlatform,
    recentTrend:  trend,
  }
}

// ─── KERNEL COMMANDS ─────────────────────────────────────────────────────────

// Command 1: loadReputationWorkspace
// Reads reviews, review_requests, referrals, and computes performance.
// No writes.
export async function loadReputationWorkspace(
  input: LoadReputationWorkspaceInput,
): Promise<KernelReputationResult<ReputationWorkspace>> {
  try {
    const supabase = createServiceClient()

    // IDENTITY CLASS (m339, INVERTED by m366). input.agentId is an AGENTS id.
    // review_requests.agent_id used to FK users, so m339 resolved agents→users
    // here to stop the insert being a foreign-key violation. m366 re-pointed the
    // column at agents(id) — which turned that very resolve into the violation it
    // was written to prevent, in the same table, with the same symptom: no review
    // request could be created and the workspace read looked like "no requests
    // yet". All three tables here are agents-class now; no hop, no sentinel.

    const [reviewsRes, requestsRes, referralsRes] = await Promise.all([
      // ── `source_url` IS READ HERE AND WRITTEN BY NOBODY, AND THAT IS THE
      //    HONEST STATE (verdict, 2026-09-04) ────────────────────────────────
      //
      // It surfaced as a NEW 1b entry in test:opposite-missing this wave without
      // any line of code touching it — the writer did not disappear, the CENSUS
      // GOT SHARPER. `agent_reviews` had been on that guard's "opaque write
      // object" exclusion list, so its columns were invisible to the 1b sweep;
      // BURN-C's merge left this table with parseable writes only, and the
      // pre-existing pair became visible. §2: a count that moves is the finding,
      // and this one moved because a blind spot shrank.
      //
      // NO CAPABILITY WAS LOST IN THAT MERGE — checked rather than assumed: the
      // deleted `recordReview` did not write `source_url` either. Nothing ever
      // has.
      //
      // THE MISSING HALF IS A FEATURE, NOT A WIRE. `source_url` is where a review
      // lives on the platform it came FROM, so a card can link out to the real
      // Google or Zillow review. Every review this OS holds is FIRST-PARTY — the
      // two writers are app/actions/multi-persona.ts:submitClientFeedback and
      // app/actions/portal-lifetime.ts:submitClientTestimonial, both collecting
      // the review through our own portal, where there is no external URL to
      // record. The writer would be an external-review IMPORTER (Google Business
      // Profile / Zillow), which does not exist in this tree.
      //
      // So the read stays: it is correct, it renders null today, and removing it
      // would mean re-adding it the day the importer lands. Recorded here with
      // its reason instead of deleted to move a number (§1), and carried on the
      // ratchet rather than silently baselined.
      supabase
        .from("agent_reviews")
        .select("id, rating, review_text, platform, source_url, is_published, response_text, response_at, created_at, contact_id, transaction_id")
        .eq("agent_id",     input.agentId)
        .eq("brokerage_id", input.brokerageId)
        .order("created_at", { ascending: false })
        .limit(100),
      supabase
        .from("review_requests")
        .select("id, contact_id, contact_name, platform, status, sent_at, completed_at, review_url, created_at")
        .eq("agent_id",     input.agentId)
        .eq("brokerage_id", input.brokerageId)
        .order("created_at", { ascending: false })
        .limit(100),
      supabase
        .from("referrals")
        .select("id, referral_name, status, referral_source, value_estimate, commission_potential, commission_amount, source_contact_name, referred_by, gift_sent, thank_you_sent, notes, created_at, converted_at, referred_contact_id, referred_lead_id, partner_id")
        .eq("agent_id",     input.agentId)
        .eq("brokerage_id", input.brokerageId)
        .order("created_at", { ascending: false })
        .limit(200),
    ])

    // `data ?? []` on a refused read produces an empty list indistinguishable
    // from a genuinely empty workspace — "you have no reviews" when the truth is
    // "we could not look". All three are checked; any refusal fails the load so
    // the surface can say so.
    const readFailures = [
      reviewsRes.error   ? `reviews: ${reviewsRes.error.message}`   : null,
      requestsRes.error  ? `review requests: ${requestsRes.error.message}`  : null,
      referralsRes.error ? `referrals: ${referralsRes.error.message}` : null,
    ].filter((m): m is string => Boolean(m))

    if (readFailures.length > 0) {
      return { success: false, error: `Reputation workspace could not be loaded — ${readFailures.join("; ")}` }
    }

    const reviews  = (reviewsRes.data  ?? []) as ReviewRow[]
    const requests = (requestsRes.data ?? []) as ReviewRequestRow[]
    const refs     = (referralsRes.data ?? []) as ReferralRow[]

    return {
      success: true,
      data: {
        reviews,
        reviewRequests: requests,
        referrals:      refs,
        performance:    computePerformance(reviews),
      },
    }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

// Command 2: createReviewRequest
// Creates a pending review request for a contact on a platform.
// Rejects duplicate pending request per contact+platform.
export async function createReviewRequest(
  input: CreateReviewRequestInput,
): Promise<KernelReputationResult<{ reviewRequestId: string }>> {
  if (!input.contactName?.trim()) {
    return { success: false, error: "contactName is required." }
  }

  try {
    const supabase = createServiceClient()

    // IDENTITY CLASS (m339, INVERTED by m366). input.agentId is an AGENTS id.
    // review_requests.agent_id used to FK users, so m339 resolved agents→users
    // here to stop the insert being a foreign-key violation. m366 re-pointed the
    // column at agents(id) — which turned that very resolve into the violation it
    // was written to prevent, in the same table, with the same symptom: no review
    // request could be created and the workspace read looked like "no requests
    // yet". All three tables here are agents-class now; no hop, no sentinel.

    // Guard: no duplicate pending request for same contact + platform
    if (input.contactId) {
      const { data: existing, error: dupErr } = await supabase
        .from("review_requests")
        .select("id")
        .eq("agent_id",     input.agentId)
        .eq("brokerage_id", input.brokerageId)
        .eq("contact_id",   input.contactId)
        .eq("platform",     input.platform)
        .eq("status",       "pending")
        .maybeSingle()

      // A refused duplicate check resolved to null and this guard waved the
      // insert through — the one thing the guard exists to stop.
      if (dupErr) {
        return { success: false, error: `Could not check for an existing review request: ${dupErr.message}` }
      }

      if (existing) {
        return { success: false, error: `A pending ${input.platform} review request already exists for this contact.` }
      }
    }

    const { data, error } = await supabase
      .from("review_requests")
      .insert({
        agent_id:     input.agentId,
        brokerage_id: input.brokerageId,
        contact_id:   input.contactId ?? null,
        contact_name: input.contactName.trim(),
        platform:     input.platform,
        status:       "pending",
        review_url:   input.reviewUrl ?? null,
        created_at:   new Date().toISOString(),
      })
      .select("id")
      .single()

    if (error || !data) {
      return { success: false, error: error?.message ?? "Failed to create review request." }
    }

    await emitLifecycleEvent({
      supabase,
      brokerageId: input.brokerageId,
      agentId:     input.agentId,
      entityType:  "review_request",
      entityId:    data.id,
      event:       KernelEvent.REVIEW_REQUEST_SENT,
      metadata:    { platform: input.platform, contactName: input.contactName },
    })

    return { success: true, data: { reviewRequestId: data.id } }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}


// Command 4: respondToReview
// Writes response_text + response_at to agent_reviews.
// Verifies reviewId belongs to agentId before writing.
// publishNow=true → sets is_published=true.
export async function respondToReview(
  input: RespondToReviewInput,
): Promise<KernelReputationResult> {
  if (!input.responseText?.trim()) {
    return { success: false, error: "responseText is required." }
  }

  try {
    const supabase = createServiceClient()

    // Verify ownership.
    // A REFUSED READ IS NOT AN ABSENT ROW. Without the error destructure this
    // returned "not owned by this agent" for a permission or transport failure,
    // which sends the agent looking for the wrong problem.
    const { data: review, error: ownershipErr } = await supabase
      .from("agent_reviews")
      .select("id, agent_id")
      .eq("id",         input.reviewId)
      .eq("agent_id",   input.agentId)
      .eq("brokerage_id", input.brokerageId)
      .maybeSingle()

    if (ownershipErr) {
      return { success: false, error: `Could not verify this review: ${ownershipErr.message}` }
    }
    if (!review) {
      return { success: false, error: "Review not found or not owned by this agent." }
    }

    // is_published is only ever RAISED here, never lowered.
    // It used to be written unconditionally as `input.publishNow ?? false`, so
    // responding to an already-published review with publishNow omitted took it
    // OFF the public profile (app/p/[agentSlug] and multi-persona.ts:
    // getAgentReviews both filter is_published = true). Answering a review is
    // not a request to retract it.
    const updatePayload: Record<string, unknown> = {
      response_text: input.responseText.trim(),
      response_at:   new Date().toISOString(),
      updated_at:    new Date().toISOString(),
    }
    if (input.publishNow) updatePayload.is_published = true

    const { error } = await supabase
      .from("agent_reviews")
      .update(updatePayload)
      .eq("id",           input.reviewId)
      .eq("agent_id",     input.agentId)
      .eq("brokerage_id", input.brokerageId)

    if (error) {
      return { success: false, error: error.message }
    }

    await emitLifecycleEvent({
      supabase,
      brokerageId: input.brokerageId,
      agentId:     input.agentId,
      entityType:  "agent_review",
      entityId:    input.reviewId,
      event:       KernelEvent.REVIEW_RESPONSE_PUBLISHED,
      metadata:    { publishNow: input.publishNow ?? false },
    })

    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}



// Command 7: loadReferralPipeline
// Reads referrals grouped by status. Returns counts per status.
// No writes.
export async function loadReferralPipeline(
  input: LoadReferralPipelineInput,
): Promise<KernelReputationResult<ReferralPipelineData>> {
  try {
    const supabase = createServiceClient()

    let query = supabase
      .from("referrals")
      .select("id, referral_name, status, referral_source, value_estimate, commission_potential, commission_amount, source_contact_name, referred_by, gift_sent, thank_you_sent, notes, created_at, converted_at, referred_contact_id, referred_lead_id, partner_id")
      .eq("agent_id",     input.agentId)
      .eq("brokerage_id", input.brokerageId)
      .order("created_at", { ascending: false })

    if (input.status) {
      query = query.eq("status", input.status)
    }

    const { data, error } = await query

    if (error) {
      return { success: false, error: error.message }
    }

    const referrals = (data ?? []) as ReferralRow[]
    const counts: Record<string, number> = {}
    for (const r of referrals) {
      counts[r.status] = (counts[r.status] ?? 0) + 1
    }

    return { success: true, data: { referrals, counts } }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

// Command 8: loadReviewPerformance
// Computes performance analytics from agent_reviews. No writes.
export async function loadReviewPerformance(
  input: LoadReviewPerformanceInput,
): Promise<KernelReputationResult<ReputationPerformance>> {
  try {
    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from("agent_reviews")
      .select("id, rating, platform, response_text, created_at")
      .eq("agent_id",     input.agentId)
      .eq("brokerage_id", input.brokerageId)

    if (error) {
      return { success: false, error: error.message }
    }

    const reviews = (data ?? []) as ReviewRow[]
    return { success: true, data: computePerformance(reviews) }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}
