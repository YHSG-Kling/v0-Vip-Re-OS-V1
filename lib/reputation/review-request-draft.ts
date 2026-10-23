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
import {
  parseReputationProfiles,
  screenReviewAskCopy,
  REVIEW_ASK_PROMPT_RULES,
  type AskableReviewPlatform,
  type ReviewAskViolation,
} from "@/lib/reputation/review-ask-policy"

// WAVE 143 (lane 143E) — ONE platform vocabulary (CLAUDE.md §6). This file spelled Realtor.com "realtor" while
// lib/kernel/reputation.ts REVIEW_PLATFORMS (the agent_reviews.platform CHECK) spells it "realtor_com"; the
// old spelling is still ACCEPTED at the door (ReputationPanel / review-request-panel send it) and normalised here.
export type ReviewPlatform = AskableReviewPlatform | "realtor"
export type ReviewChannel = "email" | "text" | "in_person"
const normalisePlatform = (p: ReviewPlatform): AskableReviewPlatform => (p === "realtor" ? "realtor_com" : p)

export interface ReviewRequestDraftInput {
  brokerageId: string
  transactionId: string
  /** agents.id (m346) — review_requests.agent_id is agents-class. */
  agentId: string
  platform: ReviewPlatform
  channel: ReviewChannel
  /**
   * The REAL review link to carry. Omitted → resolved here from the tenant's `reputation_profiles` policy
   * (the agent's own link, else the brokerage's). NEVER a placeholder: the old PLATFORM_URLS table shipped
   * `https://g.page/r/YOUR_PLACE_ID/review` to real clients.
   */
  reviewUrl?: string
  /** A queued request row to ADOPT (status 'scheduled' legacy rows) instead of inserting a second one. */
  existingRequestId?: string
}

const ReviewRequestSchema = z.object({
  subject: z.string().optional(),
  message: z.string(),
  callScript: z.string().optional(),
  keyPoints: z.array(z.string()),
  personalizedOpener: z.string(),
  softAsk: z.string(),
  directAsk: z.string(),
  // TOMBSTONE (wave 143, lane 143E): `followUpSequence` (a model-authored "3-touch follow-up if no response" with
  // fixed `day` numbers) is gone — nothing ever read it, it was a hard-coded reminder timetable, and a second
  // and third unprompted ask is exactly the pestering the no-duplicates rule forbids. Whether and when to follow
  // up on a review ask is the follow-up arbiter's call (lib/ai-isa/followup-arbiter.ts), not a field of the draft.
})
export type ReviewRequestDraft = z.infer<typeof ReviewRequestSchema>

export type ReviewRequestDraftResult =
  | { success: true; data: ReviewRequestDraft; message: string; reviewRequestId: string; reviewUrl: string; platform: AskableReviewPlatform; violations: ReviewAskViolation[] }
  | { success: false; error: string; code?: "no_review_link" }

/**
 * ai_assistant_notes.source names the PRODUCER CLASS (ai_assistant |
 * ai_draft_human_approved | human) — moved with the body from the action.
 */
const AI_NOTE_SOURCE = "ai_assistant"

// TOMBSTONE (wave 143, lane 143E): PLATFORM_URLS — five literal template links (`…/YOUR_PLACE_ID/review`,
// `…/YOUR_ID/reviews`, `…/YOUR_PAGE/reviews`, `…/YOUR_BIZ_ID`) that were written to review_requests.review_url and
// put into the prompt, so a client could be sent a link that goes nowhere. Survivor: the tenant's
// `reputation_profiles` policy, parsed by lib/reputation/review-ask-policy.ts parseReputationProfiles (real,
// platform-hosted links only; no link = refusal below).

/** Injectable model call (the guard drives the core with a fixture; production uses generateObjectRouted). */
export interface ReviewRequestDraftDeps {
  generate?: (args: { brokerageId: string; prompt: string }) => Promise<{ object: ReviewRequestDraft }>
}

export async function draftReviewRequest(
  svc: any,
  input: ReviewRequestDraftInput & { contactId?: string | null },
  deps: ReviewRequestDraftDeps = {},
): Promise<ReviewRequestDraftResult> {
  const { brokerageId, transactionId, agentId, channel } = input
  const platform = normalisePlatform(input.platform)
  if (!brokerageId) return { success: false, error: "Review request refused: no brokerageId (the tenant must come from a session or the transaction row)" }

  // The transaction, tenant-pinned. (The old embed `contacts!transactions_contact_id_fkey` always drafted for
  // transactions.contact_id — on a two-sided deal that is ONE of the clients, not necessarily the one being
  // asked; the client is read by id below.)
  const { data: transaction, error: transactionError } = await svc
    .from("transactions")
    .select("id, brokerage_id, contact_id, property_address, deal_type, close_date")
    .eq("id", transactionId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (transactionError) return { success: false, error: `Review request: transaction read refused: ${transactionError.message}` }
  if (!transaction) return { success: false, error: "Transaction not found in this brokerage" }

  const clientContactId = input.contactId ?? transaction.contact_id ?? null
  let client: { id: string; first_name: string | null; last_name: string | null } | null = null
  if (clientContactId) {
    const { data: c, error: clientError } = await svc
      .from("contacts")
      .select("id, first_name, last_name")
      .eq("id", clientContactId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    if (clientError) return { success: false, error: `Review request: client read refused: ${clientError.message}` }
    client = c ?? null
  }

  const { data: agent, error: agentError } = await svc
    .from("agents")
    .select("id, users(first_name, last_name)")
    .eq("id", agentId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (agentError) return { success: false, error: `Review request: agent read refused: ${agentError.message}` }
  if (!agent) return { success: false, error: "Agent record not found in this brokerage" }

  // THE LINK — a real, platform-hosted review link from the tenant's policy, or the request is refused BEFORE any
  // model spend. (Fail closed: "no link configured" must never render as a link that goes nowhere.)
  let reviewUrl = input.reviewUrl ?? null
  if (!reviewUrl) {
    const { data: settingsRow, error: settingsError } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
    if (settingsError) return { success: false, error: `Review request: the reputation profiles could not be read (${settingsError.message}) — nothing was drafted` }
    const profiles = parseReputationProfiles((settingsRow as { settings?: unknown } | null)?.settings)
    reviewUrl = profiles.agents[agentId]?.[platform] ?? profiles.brokerage[platform] ?? null
  }
  if (!reviewUrl) {
    return { success: false, code: "no_review_link", error: `No review link is configured for ${platform}. Add the real ${platform} review link on the Referrals page (Where review requests point) — a request is never sent with a placeholder.` }
  }

  const agentName = `${(agent.users as any)?.first_name ?? ""} ${(agent.users as any)?.last_name ?? ""}`.trim()
  const basePrompt = `Generate a ${channel} review request for ${platform}:

Agent: ${agentName}
Client: ${client?.first_name ?? ""} ${client?.last_name ?? ""}
Property: ${transaction.property_address}
Transaction type: ${transaction.deal_type}
Close date: ${transaction.close_date}
The ONE review link to include (use exactly this, nothing else to click): ${reviewUrl}

Rules (the message is machine-checked against them):
${REVIEW_ASK_PROMPT_RULES.map((r) => `- ${r}`).join("\n")}
- Be genuine and grateful, not pushy; reference a real moment from the transaction.

Generate:
1. ${channel === "email" ? "Email subject and body" : channel === "text" ? "Text message (under 300 chars)" : "In-person script"}
2. Key points to mention
3. Both a soft ask and direct ask version`

  const generate = deps.generate ?? (async ({ brokerageId: b, prompt }: { brokerageId: string; prompt: string }) =>
    generateObjectRouted({ feature: "review_request_generation", brokerageId: b, schema: ReviewRequestSchema, prompt }))

  // Draft, SCREEN, and give the model ONE chance to repair a flagged draft with the reasons stated. A draft that is
  // still flagged is returned with its violations — the caller stages it for a human, it is never sent.
  let { object: request } = await generate({ brokerageId, prompt: basePrompt })
  let violations = screenReviewAskCopy({ subject: request.subject, body: request.message })
  if (violations.length > 0) {
    const retry = await generate({
      brokerageId,
      prompt: `${basePrompt}\n\nYour previous draft broke these rules — rewrite it so it breaks none: ${violations.map((v) => `${v.code} ("${v.match}")`).join("; ")}.`,
    })
    request = retry.object
    violations = screenReviewAskCopy({ subject: request.subject, body: request.message })
  }

  // ai_assistant_notes.created_by FKs users — the two columns want different id
  // spaces on the same actor, so the users id is RESOLVED, never substituted.
  const agentUserId = await resolveUserIdForAgentRecord(svc, agentId)

  const row = {
    agent_id:     agentId,
    brokerage_id: brokerageId,
    contact_id:   client?.id ?? clientContactId,
    contact_name: `${client?.first_name ?? ""} ${client?.last_name ?? ""}`.trim() || null,
    platform,
    review_url:   reviewUrl,
    status:       "pending",
  }
  let reviewRequestId: string
  if (input.existingRequestId) {
    // ADOPT a queued legacy row (tenant-pinned, COUNTED — an update that matches nothing also resolves).
    const { data: adopted, error: adoptError } = await svc
      .from("review_requests")
      .update(row)
      .eq("id", input.existingRequestId)
      .eq("brokerage_id", brokerageId)
      .select("id")
    if (adoptError) return { success: false, error: `Review request could not be saved: ${adoptError.message}` }
    if (!adopted || adopted.length !== 1) return { success: false, error: "Review request could not be saved: the queued request is not in this brokerage" }
    reviewRequestId = adopted[0].id as string
  } else {
    const { data: rrInsert, error: rrError } = await svc
      .from("review_requests")
      .insert({ ...row, created_at: new Date().toISOString() })
      .select("id")
      .single()
    if (rrError || !rrInsert?.id) return { success: false, error: `Review request could not be saved: ${rrError?.message ?? "no row returned"}` }
    reviewRequestId = rrInsert.id as string
  }

  // No users id ⇒ no valid created_by, and the note is skipped rather than
  // written under a substituted actor. The review request itself already landed.
  if (agentUserId) {
    const { error: noteError } = await svc.from("ai_assistant_notes").insert({
      brokerage_id: brokerageId,
      created_by:   agentUserId,
      role:         "agent",
      note_text:    JSON.stringify({ ...request, screen: violations }),
      note_type:    "review_request_draft",
      source:       AI_NOTE_SOURCE,
      created_at:   new Date().toISOString(),
    })
    if (noteError) console.error("[review-request-draft] draft note not saved (request row kept):", noteError.message)
  }

  const messageText = request.message
    ?? (channel === "text" ? request.callScript : null)
    ?? `Hi ${client?.first_name ?? "there"}, ${request.personalizedOpener ?? ""} ${request.softAsk ?? ""}`.trim()

  return { success: true, data: request, message: messageText, reviewRequestId, reviewUrl, platform, violations }
}
