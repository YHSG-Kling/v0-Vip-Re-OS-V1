"use server"

import { createClient } from "@/lib/supabase/server"
import { generateObject } from "@/lib/ai/generate"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { z } from "zod"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { revalidatePath } from "next/cache"
import { resolveUserIdForAgentRecord } from "@/lib/kernel/agent-identity"

/**
 * AI Review & Testimonial Automation System
 * Handles review requests, sentiment analysis, response generation, and reputation management
 */

/**
 * ai_assistant_notes.brokerage_id is NOT NULL *and* the tenant INSERT policy
 * requires it to equal current_user_brokerage_id() — an insert that omits it is
 * rejected twice over. Two of the three note writes below omitted it entirely,
 * so they could never have landed even once note_type/source were admitted.
 *
 * Returning null means "do not attempt the write" — a doomed insert is worse
 * than an honest skip.
 *
 * THE `agentId` PARAMETER OF EVERY ACTION IN THIS FILE IS `agents.id` (m346).
 * It used to be "either agents.id or users.id depending on the caller", and this
 * helper tried both columns to cope. That ambiguity was not a quirk to work
 * around — it was the bug. Under it, aiGenerateReviewRequest could not succeed
 * from EITHER direction:
 *
 *   · given an agents id (the review-request-on-close cron passes
 *     transactions.agent_id), the `agents` lookups resolve — but
 *     review_requests.agent_id FKs USERS, so the insert was rejected. Proven
 *     live: no agents row's id is also a users id, so it is rejected 100% of
 *     the time, not occasionally.
 *   · given a users id (stage-progression passed params.userId), the insert
 *     would have been fine but `.from("agents").eq("id", …).single()` throws,
 *     so the action failed before reaching it.
 *
 * Either way the OS reported "review request drafted" and no row existed. The
 * class is now declared once, callers were corrected to honour it, and the
 * users-class columns are RESOLVED rather than guessed.
 */
async function resolveNoteBrokerageId(
  supabase: { from: (t: string) => any },
  agentRecordId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("agents")
    .select("brokerage_id")
    .eq("id", agentRecordId)
    .limit(1)
    .maybeSingle()
  return (data?.brokerage_id as string | undefined) ?? null
}

/**
 * ai_assistant_notes.source names the PRODUCER CLASS
 * (ai_assistant | ai_draft_human_approved | human) — not the subsystem. These
 * writes previously passed 'ai_review_automation', which the CHECK does not
 * admit and never could: it is a subsystem name in a producer-class column. The
 * subsystem now lives in note_type, which m295 widened to carry it.
 */
const AI_NOTE_SOURCE = "ai_assistant"

/** Roles that may act FOR another agent, and only inside their own brokerage. */
const SUPERVISOR_ROLES = new Set([
  "broker", "broker_admin", "admin", "superadmin", "team_lead", "tc", "transaction_coordinator",
])

/**
 * Session gate for this file's actions.
 *
 * Every export here is `"use server"` — a publicly reachable HTTP endpoint — and
 * every one of them takes `agentId` (an `agents.id`) FROM THE CALLER. Ungated,
 * a single guessed uuid was enough to (a) read another brokerage's contact
 * record joined to its transactions and interactions, (b) spend the platform's
 * model budget on a gpt-4o call, and (c) write `ai_assistant_notes` and
 * `lifecycle_events` rows into that tenant's ledger. None of those three needed
 * a session.
 *
 * RESOLUTION, NOT SUBSTITUTION. `agents.id` and `users.id` are disjoint id
 * spaces here, so the agent record is resolved from the session
 * (`ctx.agentId` IS `agents.id`) rather than coerced from the user id. A
 * caller-supplied agentId is honoured only when it resolves to an `agents` row
 * inside the caller's OWN brokerage and the caller holds a supervising role —
 * which is what lets a broker or TC act for one of their agents without letting
 * anyone act for a stranger's.
 *
 * The `agents` probe destructures `error`: supabase-js RESOLVES a refused read,
 * so `const { data }` alone would turn "RLS said no" into "no such agent" —
 * identical shapes, opposite meanings. Both outcomes fail closed, but a refusal
 * is reported as a refusal rather than laundered into a 404.
 */
async function requireAgentScope(
  supabase: { from: (t: string) => any },
  requestedAgentId?: string,
): Promise<
  | { ok: true; agentId: string; brokerageId: string; userId: string }
  | { ok: false; error: string }
> {
  const { getAgentContext } = await import("@/lib/identity/get-agent-context")
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }

  if (!requestedAgentId || requestedAgentId === ctx.agentId) {
    if (!ctx.agentId) return { ok: false, error: "Caller has no agent record" }
    return { ok: true, agentId: ctx.agentId, brokerageId: ctx.brokerageId, userId: ctx.userId }
  }

  if (!isValidUUID(requestedAgentId)) return { ok: false, error: "Invalid agent ID" }
  if (!SUPERVISOR_ROLES.has(ctx.userType)) return { ok: false, error: "Forbidden" }

  const { data: target, error } = await supabase
    .from("agents")
    .select("id, brokerage_id")
    .eq("id", requestedAgentId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()
  if (error) return { ok: false, error: "Could not verify that agent record" }
  if (!target) return { ok: false, error: "Forbidden" }

  return {
    ok: true,
    agentId: target.id as string,
    brokerageId: ctx.brokerageId,
    userId: ctx.userId,
  }
}

// ============================================================================
// AI REVIEW REQUEST TIMING
// ============================================================================

export async function aiDetermineReviewTiming(params: {
  transactionId: string
  agentId: string
}) {
  if (!isValidUUID(params.transactionId) || !isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    // Get transaction and client sentiment data.
    //
    // `interactions(...)` embedded a table that DOES NOT EXIST in the live database (no
    // public.interactions; not an FK column on transactions either), so PostgREST rejected
    // this whole query and — with `error` undestructured — every call fell through to
    // "Transaction not found". The timing recommendation has never been computed from data.
    //
    // The repoint is a SPLIT, because no single real table carries both things this
    // function reads:
    //   • notes / what happened → `activities` (activities.transaction_id → transactions.id)
    //   • sentiment            → `voice_calls`. NOTHING else contact-linked in this schema
    //     has a `sentiment` column; activities does not. voice_calls FKs contacts, not
    //     transactions, so it is fetched separately below off this deal's contact.
    // The old `interaction_type` / `interaction_date` columns have no counterpart on
    // activities; `activity_type` / `created_at` are the real ones.
    //
    // `contacts(*)` was also ambiguous: transactions has THREE FKs to contacts
    // (contact_id, buyer_contact_id, seller_contact_id). Named by constraint now, and
    // no `*` inside an embed (defect #214).
    const { data: transaction, error: transactionError } = await supabase
      .from("transactions")
      .select(`
        *,
        contacts!transactions_contact_id_fkey(id, first_name, last_name),
        activities!activities_transaction_id_fkey(activity_type, notes, outcome, created_at)
      `)
      .eq("id", params.transactionId)
      .single()

    if (transactionError) {
      console.error("[aiDetermineReviewTiming] transaction read failed:", transactionError.message)
      return { success: false, error: transactionError.message }
    }

    if (!transaction) {
      return { success: false, error: "Transaction not found" }
    }

    // Embedded rows are unordered — sort newest-first here instead of trusting slice(0, 10).
    const recentInteractions = ((transaction.activities ?? []) as Array<{
      activity_type: string | null; notes: string | null; outcome: string | null; created_at: string | null
    }>)
      .slice()
      .sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime())
      .slice(0, 10)

    // Sentiment lives on voice_calls, keyed by contact rather than by deal.
    let sentimentScores: string[] = []
    const clientContactId = (transaction.contacts as { id?: string } | null)?.id
    if (clientContactId) {
      const { data: calls, error: callsError } = await supabase
        .from("voice_calls")
        .select("sentiment, outcome, created_at")
        .eq("contact_id", clientContactId)
        .not("sentiment", "is", null)
        .order("created_at", { ascending: false })
        .limit(10)
      if (callsError) {
        // Non-fatal: timing can still be judged without sentiment, but say so rather
        // than letting an empty array masquerade as "no calls".
        console.error("[aiDetermineReviewTiming] voice_calls sentiment read failed:", callsError.message)
      }
      sentimentScores = (calls ?? []).map((c: { sentiment: string | null }) => c.sentiment).filter((s): s is string => Boolean(s))
    }

    const { object: timing } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        readyForReview: z.boolean(),
        confidence: z.number().min(0).max(100),
        optimalTiming: z.enum(["immediate", "wait_3_days", "wait_1_week", "wait_2_weeks", "not_recommended"]),
        reasoning: z.string(),
        sentimentAssessment: z.enum(["euphoric", "positive", "neutral", "negative", "at_risk"]),
        preReviewActions: z.array(z.object({
          action: z.string(),
          priority: z.enum(["high", "medium", "low"]),
          script: z.string(),
        })),
        bestChannel: z.enum(["email", "text", "phone", "in_person"]),
        bestTimeOfDay: z.string(),
      }),
      prompt: `Analyze this transaction to determine optimal review request timing:

Transaction: ${transaction.property_address || "Property"}
Close date: ${transaction.close_date}
Client: ${transaction.contacts?.first_name} ${transaction.contacts?.last_name}
Days since close: ${transaction.close_date ? Math.floor((Date.now() - new Date(transaction.close_date).getTime()) / (1000 * 60 * 60 * 24)) : "N/A"}

Recent interaction sentiment: ${JSON.stringify(sentimentScores)}
Last interaction notes: ${recentInteractions[0]?.notes || "None"}

Determine:
1. Is client ready for a review request?
2. Optimal timing (immediate, wait, or not recommended)
3. Current sentiment assessment
4. Any pre-review actions needed (address concerns first)
5. Best channel and time of day to ask`,
    })

    // review_timing_analysis table does not exist in live schema.
    // Recommendation is returned to the caller but not persisted.
    // To persist, the caller may use lifecycle_events or ai_assistant_notes.

    return { success: true, data: timing }
  } catch (error) {
    return handleError(error, "aiDetermineReviewTiming")
  }
}

// ============================================================================
// AI REVIEW REQUEST GENERATION
// ============================================================================

export async function aiGenerateReviewRequest(params: {
  transactionId: string
  agentId: string
  platform: "google" | "zillow" | "realtor" | "facebook" | "yelp"
  channel: "email" | "text" | "in_person"
}) {
  if (!isValidUUID(params.transactionId) || !isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    // Same ambiguity as aiDetermineReviewTiming above: transactions has THREE foreign keys
    // to contacts (contact_id, buyer_contact_id, seller_contact_id), so a bare
    // `contacts(...)` embed cannot be resolved and PostgREST fails the ENTIRE query. Name
    // the constraint so the client on the deal is the one that comes back.
    const { data: transaction, error: transactionError } = await supabase
      .from("transactions")
      .select(`
        *,
        contacts!transactions_contact_id_fkey(first_name, last_name, email, phone)
      `)
      .eq("id", params.transactionId)
      .single()

    if (transactionError) {
      console.error("[aiGenerateReviewRequest] transaction read failed:", transactionError.message)
      return { success: false, error: transactionError.message }
    }

    const { data: agent } = await supabase
      .from("agents")
      .select("users(first_name, last_name)")
      .eq("id", params.agentId)
      .single()

    if (!transaction) {
      return { success: false, error: "Transaction not found" }
    }

    // Platform-specific review URLs
    const platformUrls: Record<string, string> = {
      google: "https://g.page/r/YOUR_PLACE_ID/review",
      zillow: "https://www.zillow.com/profile/YOUR_ID/reviews",
      realtor: "https://www.realtor.com/realestateagents/YOUR_ID/reviews",
      facebook: "https://facebook.com/YOUR_PAGE/reviews",
      yelp: "https://www.yelp.com/writeareview/biz/YOUR_BIZ_ID",
    }

    const { object: request } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        subject: z.string().optional(),
        message: z.string(),
        callScript: z.string().optional(),
        keyPoints: z.array(z.string()),
        personalizedOpener: z.string(),
        softAsk: z.string(),
        directAsk: z.string(),
        followUpSequence: z.array(z.object({
          day: z.number(),
          channel: z.string(),
          message: z.string(),
        })),
      }),
      prompt: `Generate a ${params.channel} review request for ${params.platform}:

Agent: ${(agent?.users as any)?.first_name} ${(agent?.users as any)?.last_name}
Client: ${transaction.contacts?.first_name} ${transaction.contacts?.last_name}
Property: ${transaction.property_address}
Transaction type: ${transaction.deal_type}
Close date: ${transaction.close_date}

Guidelines:
- Be genuine and grateful, not pushy
- Reference specific positive moments from the transaction
- Make it easy with a direct link
- For ${params.platform}, the review URL is: ${platformUrls[params.platform]}

Generate:
1. ${params.channel === "email" ? "Email subject and body" : params.channel === "text" ? "Text message (under 300 chars)" : "In-person script"}
2. Key points to mention
3. Both a soft ask and direct ask version
4. 3-touch follow-up sequence if no response`,
    })

    const brokerageId = await resolveNoteBrokerageId(supabase, params.agentId)

    // review_requests.agent_id is agents-class and params.agentId already is
    // that class (see the header), so it is written straight through. The users
    // id is still resolved below because ai_assistant_notes.created_by really
    // does FK users — the two columns want different id spaces on the same actor.
    const agentUserId = await resolveUserIdForAgentRecord(supabase, params.agentId)

    // Save to review_requests using verified live schema columns only.
    const { data: rrInsert, error: rrError } = await supabase
      .from("review_requests")
      .insert({
        agent_id:     params.agentId,
        brokerage_id: brokerageId,
        contact_id:   transaction.contacts?.id ?? transaction.contact_id ?? null,
        contact_name: `${transaction.contacts?.first_name ?? ""} ${transaction.contacts?.last_name ?? ""}`.trim() || null,
        platform:     params.platform,
        review_url:   platformUrls[params.platform] ?? null,
        status:       "pending",
        created_at:   new Date().toISOString(),
      })
      .select("id")
      .single()

    // The error used to be discarded, which is why the FK rejection above was
    // invisible: the action returned success with reviewRequestId: null and the
    // UI said the request was drafted.
    if (rrError || !rrInsert?.id) {
      return { success: false, error: `Review request could not be saved: ${rrError?.message ?? "no row returned"}` }
    }

    // Persist AI-generated draft to ai_assistant_notes (note_text is the correct column).
    // No users id ⇒ no valid created_by, and the note is skipped rather than
    // written under a substituted actor. The review request itself already landed.
    if (rrInsert?.id && brokerageId && agentUserId) {
      await supabase.from("ai_assistant_notes").insert({
        brokerage_id: brokerageId,
        created_by:   agentUserId,
        role:         "agent",
        note_text:    JSON.stringify(request),
        note_type:    "review_request_draft",
        source:       AI_NOTE_SOURCE,
        created_at:   new Date().toISOString(),
      })
    }

    // Return both the structured data AND a flat `message` string the UI can use directly.
    const messageText = request.message
      ?? (params.channel === "text" ? request.callScript : null)
      ?? `Hi ${transaction.contacts?.first_name ?? "there"}, ${request.personalizedOpener ?? ""} ${request.softAsk ?? ""}`.trim()

    return { success: true, data: request, message: messageText, reviewRequestId: rrInsert?.id ?? null }
  } catch (error) {
    return handleError(error, "aiGenerateReviewRequest")
  }
}

// ============================================================================
// AI REVIEW RESPONSE GENERATOR
// ============================================================================

export async function aiGenerateReviewResponse(params: {
  reviewId: string
  agentId: string
  reviewText: string
  rating: number
  platform: string
  reviewerName: string
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    const { data: agent } = await supabase
      .from("agents")
      .select("users(first_name, last_name)")
      .eq("id", params.agentId)
      .single()

    const isPositive = params.rating >= 4
    const isNegative = params.rating <= 2

    const { object: response } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        publicResponse: z.string(),
        internalNotes: z.string(),
        sentiment: z.enum(["positive", "neutral", "negative", "mixed"]),
        keyThemes: z.array(z.string()),
        actionItems: z.array(z.object({
          action: z.string(),
          priority: z.enum(["high", "medium", "low"]),
          assignTo: z.string(),
        })),
        escalationNeeded: z.boolean(),
        privateFollowUp: z.string().optional(),
      }),
      prompt: `Generate a response to this ${params.platform} review:

Reviewer: ${params.reviewerName}
Rating: ${params.rating}/5 stars
Review: "${params.reviewText}"
Agent: ${(agent?.users as any)?.first_name} ${(agent?.users as any)?.last_name}

Guidelines:
${isPositive ? `
- Thank them warmly and specifically
- Reference details they mentioned
- Express genuine appreciation
- Invite referrals subtly
` : isNegative ? `
- Acknowledge their concerns professionally
- Don't be defensive
- Offer to discuss offline
- Show commitment to improvement
- Keep it brief and professional
` : `
- Thank them for feedback
- Address any specific points
- Maintain professional tone
`}

Generate:
1. Public response (appropriate length for ${params.platform})
2. Internal notes for team
3. Key themes identified
4. Any action items needed
5. Whether escalation is needed
6. Private follow-up message if appropriate`,
    })

    // review_responses table does not exist in live schema.
    // Save AI-generated draft response_text directly on agent_reviews.
    // is_published stays false until the agent explicitly publishes via respondToReview kernel command.
    if (params.reviewId) {
      await supabase
        .from("agent_reviews")
        .update({
          response_text: response.publicResponse,
          updated_at:    new Date().toISOString(),
        })
        .eq("id",       params.reviewId)
        .eq("agent_id", params.agentId)
    }

    revalidatePath("/reviews")
    return { success: true, data: response }
  } catch (error) {
    return handleError(error, "aiGenerateReviewResponse")
  }
}

// ============================================================================
// AI NEGATIVE REVIEW RECOVERY
// ============================================================================

/**
 * Draft a service-recovery plan for a negative review.
 *
 * GATED (was not). Before this pass the endpoint authenticated nothing: it took
 * `agentId` and `clientId` straight from the caller, pulled the whole contact row
 * plus every transaction and interaction attached to it, fed that PII into a
 * gpt-4o call on the platform's budget, and then wrote a note and a lifecycle
 * event into whatever brokerage the agent id happened to belong to. The agent
 * scope now comes from the session (see `requireAgentScope`) and the client
 * lookup is pinned to the caller's own brokerage.
 */
export async function aiCreateRecoveryPlan(params: {
  reviewId: string
  /** Optional. Honoured only for an agent inside the caller's own brokerage. */
  agentId?: string
  reviewText: string
  rating: number
  clientId?: string
}) {
  const supabase = await createClient()

  const gate = await requireAgentScope(supabase, params.agentId)
  if (!gate.ok) return { success: false, error: gate.error }
  const agentId = gate.agentId

  try {
    // Get client history if available — pinned to the caller's brokerage. Both
    // ids arrive from the caller, so without the tenant predicate one uuid read
    // a stranger's contact record and its whole deal history back out.
    //
    // `interactions(*)` embedded a table that DOES NOT EXIST (no public.interactions, and
    // not an FK column on contacts) — PostgREST fails the entire query on an unknown
    // relation, so `clientHistory` was always null and every recovery plan was written
    // from "No client history available". The real per-contact log is `activities`
    // (activities.contact_id → contacts.id).
    //
    // `transactions` has THREE FKs to contacts, so the bare embed was ambiguous and would
    // have failed independently; it is named by constraint now. Only the columns actually
    // consumed are selected — never `*` inside an embed (defect #214).
    let clientHistory: {
      transactions?: Array<{ id: string }> | null
      activities?: Array<{ notes: string | null; created_at: string | null }> | null
    } | null = null
    if (params.clientId && isValidUUID(params.clientId)) {
      const { data, error: historyError } = await supabase
        .from("contacts")
        .select(`
          *,
          transactions!transactions_contact_id_fkey(id),
          activities(notes, created_at)
        `)
        .eq("id", params.clientId)
        .eq("brokerage_id", gate.brokerageId)
        .maybeSingle()
      if (historyError) {
        // Do not let a failed read look like "this client has no history" — that silently
        // downgrades the plan. Surface it.
        console.error("[aiCreateRecoveryPlan] client history read failed:", historyError.message)
        return { success: false, error: historyError.message }
      }
      clientHistory = data
    }

    const lastClientActivity = (clientHistory?.activities ?? [])
      .filter((a) => a.created_at)
      .sort((a, b) => new Date(b.created_at!).getTime() - new Date(a.created_at!).getTime())[0] ?? null

    const { object: recoveryPlan } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        severity: z.enum(["critical", "serious", "moderate", "minor"]),
        rootCauseAnalysis: z.array(z.string()),
        immediateActions: z.array(z.object({
          action: z.string(),
          owner: z.string(),
          deadline: z.string(),
          script: z.string(),
        })),
        recoveryOutreach: z.object({
          channel: z.string(),
          timing: z.string(),
          message: z.string(),
          offerCompensation: z.boolean(),
          compensationType: z.string().optional(),
        }),
        publicResponseStrategy: z.string(),
        internalProcessChanges: z.array(z.string()),
        successMetrics: z.array(z.string()),
        escalationPath: z.string(),
      }),
      prompt: `Create a recovery plan for this negative review:

Rating: ${params.rating}/5
Review: "${params.reviewText}"
${clientHistory ? `
Client history:
- Total transactions: ${clientHistory.transactions?.length || 0}
- Total logged activities: ${clientHistory.activities?.length || 0}
- Last activity: ${lastClientActivity?.notes || "N/A"}
` : "No client history available"}

Create a comprehensive recovery plan including:
1. Severity assessment
2. Root cause analysis
3. Immediate action items with scripts
4. Outreach strategy to the client
5. Public response approach
6. Internal process improvements
7. Success metrics`,
    })

    // brokerage_id is NOT NULL on BOTH writes below (the note and the event).
    // It now comes from the SESSION gate, which is authoritative, rather than
    // from whatever brokerage a caller-supplied agent id pointed at.
    const brokerageId = gate.brokerageId
    // lifecycle_events.actor_user_id FKs users — the agents id was rejected there.
    const agentUserId = await resolveUserIdForAgentRecord(supabase, agentId)

    // review_recovery_plans table does not exist in live schema.
    // Persist recovery plan to ai_assistant_notes.
    // entity_type + entity_id columns were added to ai_assistant_notes via migration.
    //
    // BOTH WRITES BELOW WERE UNCHECKED. supabase-js RESOLVES a refused insert, so
    // an undestructured `await` here reports a saved plan that was never stored —
    // and this action is the only writer of the plan, so a swallowed refusal means
    // the agent walks away believing the recovery is on record when nothing is.
    // The plan is still RETURNED either way (the model call is already paid for),
    // but `persisted` says plainly whether it survived the request.
    let persisted = false
    let persistError: string | null = null

    if (brokerageId && agentUserId) {
      const { error: noteError } = await supabase.from("ai_assistant_notes").insert({
        brokerage_id: brokerageId,
        created_by:  agentUserId,
        role:        "agent",
        note_text:   JSON.stringify({ type: "recovery_plan", plan: recoveryPlan }),
        note_type:   "review_recovery_plan",
        source:      AI_NOTE_SOURCE,
        entity_type: "agent_review",
        entity_id:   params.reviewId,
      })
      if (noteError) {
        console.error("[aiCreateRecoveryPlan] recovery plan note insert refused:", noteError.message)
        persistError = noteError.message
      } else {
        persisted = true
      }
    } else {
      persistError = "Could not resolve the acting agent's brokerage or user record."
    }

    // lifecycle_events: actor_user_id (not agent_id), entity_type + entity_id columns.
    if (brokerageId && agentUserId) {
      const { error: eventError } = await supabase.from("lifecycle_events").insert({
        brokerage_id:  brokerageId,
        actor_user_id: agentUserId,
        entity_type:   "agent_review",
        entity_id:     params.reviewId,
        event_type:    "review_recovery_plan_created",
        payload:       { severity: recoveryPlan.severity, clientId: params.clientId ?? null },
        created_at:    new Date().toISOString(),
      })
      if (eventError) {
        console.error("[aiCreateRecoveryPlan] lifecycle event insert refused:", eventError.message)
      }
    }

    return { success: true, data: recoveryPlan, persisted, persistError }
  } catch (error) {
    return handleError(error, "aiCreateRecoveryPlan")
  }
}

// ============================================================================
// AI TESTIMONIAL EXTRACTION
// ============================================================================

export async function aiExtractTestimonials(params: {
  agentId: string
  source: "reviews" | "emails" | "texts" | "surveys"
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    // Get positive reviews/feedback
    const { data: reviews } = await supabase
      .from("agent_reviews")
      .select("*")
      .eq("agent_id", params.agentId)
      .gte("rating", 4)
      .order("created_at", { ascending: false })
      .limit(50)

    if (!reviews || reviews.length === 0) {
      return { success: true, data: { testimonials: [] } }
    }

    const { object: extraction } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        testimonials: z.array(z.object({
          originalText: z.string(),
          extractedQuote: z.string(),
          themes: z.array(z.string()),
          useCase: z.array(z.enum(["website", "social", "email", "print", "video"])),
          clientName: z.string(),
          propertyType: z.string().optional(),
          impactScore: z.number().min(1).max(10),
        })),
        themeAnalysis: z.object({
          topStrengths: z.array(z.string()),
          frequentPraise: z.array(z.string()),
          uniqueDifferentiators: z.array(z.string()),
        }),
        recommendations: z.array(z.string()),
      }),
      prompt: `Extract compelling testimonials from these reviews:

${reviews.map(r => `---
Rating: ${r.rating}/5
From: ${r.reviewer_name}
Review: "${r.review_text}"
Date: ${r.created_at}
---`).join("\n")}

For each review:
1. Extract the most quotable portion
2. Identify themes (responsiveness, knowledge, negotiation, etc.)
3. Suggest best use cases (website, social media, email, print, video)
4. Score impact (1-10)

Also provide:
- Analysis of top strengths mentioned
- Most frequent praise points
- Unique differentiators to highlight`,
    })

    // Expose testimonials at the top level so callers can read result.testimonials
    // without drilling into result.data.testimonials.
    return {
      success: true,
      data: extraction,
      testimonials: extraction.testimonials.map((t) => t.extractedQuote),
    }
  } catch (error) {
    return handleError(error, "aiExtractTestimonials")
  }
}

// ============================================================================
// AI REVIEW MONITORING ALERTS
// ============================================================================

/**
 * Persist a review-monitoring configuration for an agent.
 *
 * GATED (was not). It previously took `agentId` from the caller with no session
 * at all and wrote a config note into that agent's brokerage — an unauthenticated
 * write into an arbitrary tenant's ledger.
 */
export async function aiSetupReviewMonitoring(params: {
  /** Optional. Honoured only for an agent inside the caller's own brokerage. */
  agentId?: string
  platforms: string[]
  alertThreshold: number
}) {
  const supabase = await createClient()

  const gate = await requireAgentScope(supabase, params.agentId)
  if (!gate.ok) return { success: false, error: gate.error }
  const agentId = gate.agentId

  if (!Array.isArray(params.platforms) || params.platforms.length === 0) {
    return { success: false, error: "Pick at least one platform to monitor" }
  }
  if (!Number.isFinite(params.alertThreshold) || params.alertThreshold < 1 || params.alertThreshold > 5) {
    return { success: false, error: "Alert threshold must be a star rating between 1 and 5" }
  }

  try {
    // review_monitoring_config does not exist in the live schema.
    // Persist settings as an agent ai_assistant_notes entry so config survives.
    const config = {
      agent_id:            agentId,
      platforms:           params.platforms,
      alert_threshold:     params.alertThreshold,
      notification_email:  true,
      notification_sms:    true,
      auto_respond_positive: false,
      escalate_negative:   true,
      updated_at:          new Date().toISOString(),
    }

    // brokerage_id is NOT NULL — without it the config was never stored, so the
    // "configured" message below was the only trace the setting ever existed.
    // The tenant now comes from the session gate, not from the caller's agent id.
    const brokerageId = gate.brokerageId
    const agentUserId = await resolveUserIdForAgentRecord(supabase, agentId)
    if (!brokerageId || !agentUserId) {
      return { success: false, error: "Could not resolve the agent's brokerage; monitoring was not saved." }
    }

    // A SETTING REPLACES, IT DOES NOT STACK.
    //
    // This used to INSERT unconditionally, so every save appended another
    // `review_monitoring_config` note and the agent's configuration became
    // whichever row a future reader happened to pick. A settings write that
    // leaves N contradictory copies of the setting has not configured anything.
    // The agent's existing config row is updated in place when there is one.
    //
    // The refusal is read on BOTH branches: supabase-js resolves a rejected
    // write, and the success message below is the ONLY evidence the agent gets
    // that monitoring was saved — so an unchecked write meant that message was
    // printed over a setting that does not exist.
    const { data: existingConfig, error: existingError } = await supabase
      .from("ai_assistant_notes")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("created_by", agentUserId)
      .eq("note_type", "review_monitoring_config")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (existingError) {
      console.error("[aiSetupReviewMonitoring] existing config read failed:", existingError.message)
      return { success: false, error: "Could not read your current monitoring settings, so nothing was changed." }
    }

    if (existingConfig?.id) {
      const { data: updated, error: updateError } = await supabase
        .from("ai_assistant_notes")
        .update({ note_text: JSON.stringify(config), updated_at: new Date().toISOString() })
        .eq("id", existingConfig.id)
        .eq("brokerage_id", brokerageId)
        .select("id")
      if (updateError) {
        console.error("[aiSetupReviewMonitoring] config update refused:", updateError.message)
        return { success: false, error: `Monitoring settings were not saved: ${updateError.message}` }
      }
      // A zero-row update is a refusal wearing the shape of success.
      if (!updated || updated.length === 0) {
        return { success: false, error: "Monitoring settings were not saved — you may not have permission to change them." }
      }
    } else {
      const { data: inserted, error: insertError } = await supabase
        .from("ai_assistant_notes")
        .insert({
          brokerage_id: brokerageId,
          created_by: agentUserId,
          role:       "agent",
          note_text:  JSON.stringify(config),
          note_type:  "review_monitoring_config",
          source:     AI_NOTE_SOURCE,
        })
        .select("id")
      if (insertError) {
        console.error("[aiSetupReviewMonitoring] config insert refused:", insertError.message)
        return { success: false, error: `Monitoring settings were not saved: ${insertError.message}` }
      }
      if (!inserted || inserted.length === 0) {
        return { success: false, error: "Monitoring settings were not saved — the write was refused." }
      }
    }

    return {
      success: true,
      data: {
        platforms: params.platforms,
        alertThreshold: params.alertThreshold,
        message: `Review monitoring saved for ${params.platforms.join(", ")}. Reviews of ${params.alertThreshold} stars or below are flagged for recovery.`,
      },
    }
  } catch (error) {
    return handleError(error, "aiSetupReviewMonitoring")
  }
}

/**
 * Read back the caller's review-monitoring configuration.
 *
 * aiSetupReviewMonitoring above had NO reader anywhere in the tree, which is
 * what made it a write-only setting: the agent could save a threshold and no
 * surface — not this one, not a cron — could ever tell them what it was. A
 * setting that cannot be read back is indistinguishable from one that was never
 * saved, so the writer needed this before it could honestly be given a surface.
 *
 * Returns `configured: false` for "you have not set this up", which is a
 * different answer from a failed read — the caller is told which it got.
 */
export async function getReviewMonitoringSettings(requestedAgentId?: string): Promise<
  | { success: true; configured: false }
  | { success: true; configured: true; platforms: string[]; alertThreshold: number; updatedAt: string | null }
  | { success: false; error: string }
> {
  const supabase = await createClient()

  const gate = await requireAgentScope(supabase, requestedAgentId)
  if (!gate.ok) return { success: false, error: gate.error }

  try {
    const agentUserId = await resolveUserIdForAgentRecord(supabase, gate.agentId)
    if (!agentUserId) return { success: false, error: "Could not resolve the acting agent's user record." }

    const { data, error } = await supabase
      .from("ai_assistant_notes")
      .select("note_text, updated_at, created_at")
      .eq("brokerage_id", gate.brokerageId)
      .eq("created_by", agentUserId)
      .eq("note_type", "review_monitoring_config")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    // A refused read must not be rendered as "not configured yet" — that would
    // invite the agent to overwrite a setting they cannot currently see.
    if (error) {
      console.error("[getReviewMonitoringSettings] read failed:", error.message)
      return { success: false, error: "Could not read your monitoring settings." }
    }
    if (!data?.note_text) return { success: true, configured: false }

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(data.note_text as string) as Record<string, unknown>
    } catch {
      // Stored text that is not the config blob is not a config — say so rather
      // than inventing defaults that would look like the agent's own choices.
      return { success: true, configured: false }
    }

    const platforms = Array.isArray(parsed.platforms) ? (parsed.platforms as string[]) : []
    const alertThreshold = typeof parsed.alert_threshold === "number" ? parsed.alert_threshold : null
    if (platforms.length === 0 || alertThreshold === null) return { success: true, configured: false }

    return {
      success: true,
      configured: true,
      platforms,
      alertThreshold,
      updatedAt: (data.updated_at as string | null) ?? (data.created_at as string | null) ?? null,
    }
  } catch (error) {
    return handleError(error, "getReviewMonitoringSettings")
  }
}
