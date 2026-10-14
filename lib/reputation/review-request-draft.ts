/**
 * lib/reputation/review-request-draft.ts — THE post-close review-request
 * drafter, callable with no session (lane 86E, wave 86).
 *
 * THE DEFECT. app/api/cron/review-request-on-close and
 * lib/transactions/stage-progression.ts (the closed-stage hook) both called
 * app/actions/ai-review-automation.ts::aiGenerateReviewRequest — a "use
 * server" action that built the COOKIE client and read `transactions` through
 * it. Neither caller has a cookie: under RLS the read came back refused/empty,
 * the action returned `success:false`, and the cron counted "compose failed"
 * for every closed deal it found — the autonomous review ask never drafted a
 * single request. The action also took `agentId` from its caller with NO
 * session gate at all (§4 — every "use server" export is a public endpoint).
 * Found by scripts/sessionless-use-server-census.ts.
 *
 * THE SHAPE (LANE_RULES wave 86). The body moved here UNCHANGED in what it
 * writes; the tenant now arrives VERIFIED:
 *   · the session door passes requireAgentScope()'s brokerage + agents.id;
 *   · the cron and the stage hook pass the brokerage_id of the transaction row
 *     they already read on the service client.
 * The transaction AND the agent must both sit in that brokerage, or it refuses.
 * The model call moved from the unrouted generateObject shim to
 * generateObjectRouted (feature review_request_generation, pinned to the gpt-4o
 * the call site already used), so ai_tool_usage now books the spend (§5).
 *
 * Server-only, never "use server" — this trusts the brokerageId it is handed.
 */
import "server-only"
import { z } from "zod"
import { generateObjectRouted } from "@/lib/ai/models"
import { resolveUserIdForAgentRecord } from "@/lib/kernel/agent-identity"

export type ReviewPlatform = "google" | "zillow" | "realtor" | "facebook" | "yelp"
export type ReviewChannel = "email" | "text" | "in_person"

export interface ReviewRequestDraftInput {
  brokerageId: string
  transactionId: string
  /** agents.id (m346) — review_requests.agent_id is agents-class. */
  agentId: string
  platform: ReviewPlatform
  channel: ReviewChannel
}

const ReviewRequestSchema = z.object({
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
})
export type ReviewRequestDraft = z.infer<typeof ReviewRequestSchema>

export type ReviewRequestDraftResult =
  | { success: true; data: ReviewRequestDraft; message: string; reviewRequestId: string }
  | { success: false; error: string }

/**
 * ai_assistant_notes.source names the PRODUCER CLASS (ai_assistant |
 * ai_draft_human_approved | human) — moved with the body from the action.
 */
const AI_NOTE_SOURCE = "ai_assistant"

// Platform-specific review URLs (moved unchanged).
const PLATFORM_URLS: Record<ReviewPlatform, string> = {
  google: "https://g.page/r/YOUR_PLACE_ID/review",
  zillow: "https://www.zillow.com/profile/YOUR_ID/reviews",
  realtor: "https://www.realtor.com/realestateagents/YOUR_ID/reviews",
  facebook: "https://facebook.com/YOUR_PAGE/reviews",
  yelp: "https://www.yelp.com/writeareview/biz/YOUR_BIZ_ID",
}

export async function draftReviewRequest(svc: any, input: ReviewRequestDraftInput): Promise<ReviewRequestDraftResult> {
  const { brokerageId, transactionId, agentId, platform, channel } = input
  if (!brokerageId) return { success: false, error: "Review request refused: no brokerageId (the tenant must come from a session or the transaction row)" }

  // transactions has THREE FKs to contacts (contact_id, buyer_contact_id,
  // seller_contact_id) — the embed names its constraint (PGRST201).
  const { data: transaction, error: transactionError } = await svc
    .from("transactions")
    .select(`
      *,
      contacts!transactions_contact_id_fkey(first_name, last_name, email, phone)
    `)
    .eq("id", transactionId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (transactionError) return { success: false, error: `Review request: transaction read refused: ${transactionError.message}` }
  if (!transaction) return { success: false, error: "Transaction not found in this brokerage" }

  const { data: agent, error: agentError } = await svc
    .from("agents")
    .select("id, users(first_name, last_name)")
    .eq("id", agentId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (agentError) return { success: false, error: `Review request: agent read refused: ${agentError.message}` }
  if (!agent) return { success: false, error: "Agent record not found in this brokerage" }

  const { object: request } = await generateObjectRouted({
    feature: "review_request_generation",
    brokerageId,
    schema: ReviewRequestSchema,
    prompt: `Generate a ${channel} review request for ${platform}:

Agent: ${(agent.users as any)?.first_name} ${(agent.users as any)?.last_name}
Client: ${transaction.contacts?.first_name} ${transaction.contacts?.last_name}
Property: ${transaction.property_address}
Transaction type: ${transaction.deal_type}
Close date: ${transaction.close_date}

Guidelines:
- Be genuine and grateful, not pushy
- Reference specific positive moments from the transaction
- Make it easy with a direct link
- For ${platform}, the review URL is: ${PLATFORM_URLS[platform]}

Generate:
1. ${channel === "email" ? "Email subject and body" : channel === "text" ? "Text message (under 300 chars)" : "In-person script"}
2. Key points to mention
3. Both a soft ask and direct ask version
4. 3-touch follow-up sequence if no response`,
  })

  // ai_assistant_notes.created_by FKs users — the two columns want different id
  // spaces on the same actor, so the users id is RESOLVED, never substituted.
  const agentUserId = await resolveUserIdForAgentRecord(svc, agentId)

  const { data: rrInsert, error: rrError } = await svc
    .from("review_requests")
    .insert({
      agent_id:     agentId,
      brokerage_id: brokerageId,
      contact_id:   transaction.contacts?.id ?? transaction.contact_id ?? null,
      contact_name: `${transaction.contacts?.first_name ?? ""} ${transaction.contacts?.last_name ?? ""}`.trim() || null,
      platform,
      review_url:   PLATFORM_URLS[platform] ?? null,
      status:       "pending",
      created_at:   new Date().toISOString(),
    })
    .select("id")
    .single()
  if (rrError || !rrInsert?.id) {
    return { success: false, error: `Review request could not be saved: ${rrError?.message ?? "no row returned"}` }
  }

  // No users id ⇒ no valid created_by, and the note is skipped rather than
  // written under a substituted actor. The review request itself already landed.
  if (agentUserId) {
    const { error: noteError } = await svc.from("ai_assistant_notes").insert({
      brokerage_id: brokerageId,
      created_by:   agentUserId,
      role:         "agent",
      note_text:    JSON.stringify(request),
      note_type:    "review_request_draft",
      source:       AI_NOTE_SOURCE,
      created_at:   new Date().toISOString(),
    })
    if (noteError) console.error("[review-request-draft] draft note not saved (request row kept):", noteError.message)
  }

  const messageText = request.message
    ?? (channel === "text" ? request.callScript : null)
    ?? `Hi ${transaction.contacts?.first_name ?? "there"}, ${request.personalizedOpener ?? ""} ${request.softAsk ?? ""}`.trim()

  return { success: true, data: request, message: messageText, reviewRequestId: rrInsert.id as string }
}
