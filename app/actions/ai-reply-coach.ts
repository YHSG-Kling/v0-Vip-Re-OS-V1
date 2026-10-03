"use server"

/**
 * AI Reply Coach — Server Actions
 *
 * Distinct from generateSmartResponse (ai-communication-hub.ts) which is a
 * fire-and-forget draft helper. This module owns the full ai_message_drafts
 * lifecycle: generate → persist → accept/edit/reject, plus smart_assistant
 * suggestion writes.
 *
 * Kernel: fires MESSAGE_FROM_CONTACT (already exists in KernelEvent enum) when
 * an inbound message triggers a draft.  No new KernelEvents required.
 */

import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext }     from "@/lib/identity"
import { requireCallerTenant } from "@/lib/auth/require-caller"
import {
  generateAIReplyDraftForTenant,
  type GenerateAIReplyDraftParams,
  type GenerateAIReplyDraftResult,
} from "@/lib/ai-reply-coach/reply-draft-core"

// ─── TYPES ────────────────────────────────────────────────────────────────────

// The draft types live with the generator (lib/ai-reply-coach/reply-draft-core.ts);
// re-exported type-only, which a "use server" module may do (erased at compile).
export type { GenerateAIReplyDraftParams, GenerateAIReplyDraftResult } from "@/lib/ai-reply-coach/reply-draft-core"

export interface AcceptDraftParams {
  draftId:     string
  agentUserId: string
  /** Final body after any agent edits */
  finalBody:   string
  finalSubject?: string
}

export interface RejectDraftParams {
  draftId:     string
  agentUserId: string
  reason?:     string
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function computeEditDelta(original: string, final: string): Record<string, any> {
  if (original === final) return { changed: false, delta_chars: 0 }
  const originalWords = original.split(/\s+/).length
  const finalWords    = final.split(/\s+/).length
  return {
    changed:      true,
    delta_chars:  final.length - original.length,
    delta_words:  finalWords - originalWords,
    pct_changed:  Math.round(Math.abs(final.length - original.length) / Math.max(original.length, 1) * 100),
  }
}

// ─── ACTION 1: GENERATE DRAFT ─────────────────────────────────────────────────

export async function generateAIReplyDraft(
  params: GenerateAIReplyDraftParams
): Promise<GenerateAIReplyDraftResult> {
  // THE PUBLIC DOOR (lane 92A). The generator lives in
  // lib/ai-reply-coach/reply-draft-core.ts and trusts its tenant; this export is
  // reachable over HTTP, so the tenant is the SESSION's (a foreign body brokerage
  // is refused, an absent one is filled from the session) and the draft's agent
  // must be the caller — a draft is written into that agent's queue and books AI
  // spend in their name.
  const caller = await requireCallerTenant(params.brokerageId)
  if (!caller.ok) return { success: false, error: caller.error }
  if (params.agentUserId && params.agentUserId !== caller.userId) {
    return { success: false, error: "Forbidden: a reply draft is generated for your own conversations only." }
  }
  return generateAIReplyDraftForTenant({ ...params, brokerageId: caller.brokerageId, agentUserId: caller.userId })
}

// ─── ACTION 2: ACCEPT DRAFT ───────────────────────────────────────────────────

export async function acceptDraft(params: AcceptDraftParams): Promise<{ success: boolean; error?: string }> {
  // Tenant gate: service client bypasses RLS, so verify the draft belongs to
  // the caller's brokerage before acting on it.
  const ctx = await getAgentContext()
  if (!ctx.brokerageId) return { success: false, error: "Not authenticated" }

  const supabase = createServiceClient()

  const { data: draft, error: fetchError } = await supabase
    .from("ai_message_drafts")
    .select("draft_body, draft_subject, status, brokerage_id")
    .eq("id", params.draftId)
    .maybeSingle()

  if (fetchError || !draft) {
    return { success: false, error: fetchError?.message ?? "Draft not found" }
  }
  if (draft.brokerage_id !== ctx.brokerageId) {
    return { success: false, error: "Forbidden: draft in another brokerage" }
  }
  if (draft.status !== "pending") {
    return { success: false, error: `Draft already ${draft.status}` }
  }

  const editDelta = computeEditDelta(draft.draft_body ?? "", params.finalBody)

  const { error } = await supabase
    .from("ai_message_drafts")
    .update({
      status:      "accepted",
      final_body:  params.finalBody,
      edit_delta:  editDelta,
      acted_at:    new Date().toISOString(),
    })
    .eq("id", params.draftId)
    .eq("brokerage_id", ctx.brokerageId)

  if (error) return { success: false, error: error.message }

  // Dismiss associated smart_assistant_suggestion
  await sentinelWrite(supabase, supabase
    .from("smart_assistant_suggestions")
    .update({ status: "dismissed" })
    .contains("action_payload_json", `"draftId":"${params.draftId}"`), { table: "smart_assistant_suggestions", flow: "smart_assistant_suggestions_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })

  return { success: true }
}

// ─── ACTION 3: REJECT DRAFT ───────────────────────────────────────────────────

export async function rejectDraft(params: RejectDraftParams): Promise<{ success: boolean; error?: string }> {
  // Tenant gate — see acceptDraft above for rationale.
  const ctx = await getAgentContext()
  if (!ctx.brokerageId) return { success: false, error: "Not authenticated" }

  const supabase = createServiceClient()

  // ai_message_drafts.status CHECK only allows pending/accepted/edited/dismissed/sent.
  // 'rejected' is invalid and the update would fail silently — the UI button
  // would appear to do nothing. 'dismissed' is the canonical "agent passed on
  // this suggestion" state.
  const { error } = await supabase
    .from("ai_message_drafts")
    .update({
      status:   "dismissed",
      acted_at: new Date().toISOString(),
      edit_delta: params.reason ? { rejection_reason: params.reason } : { rejection_reason: null },
    })
    .eq("id", params.draftId)
    .eq("brokerage_id", ctx.brokerageId)
    .eq("status", "pending")

  if (error) return { success: false, error: error.message }

  await sentinelWrite(supabase, supabase
    .from("smart_assistant_suggestions")
    .update({ status: "dismissed" })
    .contains("action_payload_json", `"draftId":"${params.draftId}"`), { table: "smart_assistant_suggestions", flow: "smart_assistant_suggestions_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })

  return { success: true }
}

// ─── ACTION 4: LOAD PENDING DRAFTS FOR CONVERSATION ──────────────────────────

export async function loadConversationDrafts(conversationId: string): Promise<{
  success: boolean
  drafts?: Array<{
    id: string
    draft_body: string
    draft_subject: string | null
    suggested_tone: string | null
    confidence_score: number | null
    channel: string
    created_at: string
    status: string
    listing_id: string | null
    source_message_id: string | null
  }>
  error?: string
}> {
  // Tenant gate — scope reads to the caller's brokerage so cross-tenant
  // conversation IDs can't leak draft bodies.
  const ctx = await getAgentContext()
  if (!ctx.brokerageId) return { success: false, error: "Not authenticated" }

  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("ai_message_drafts")
    .select("id, draft_body, draft_subject, suggested_tone, confidence_score, channel, created_at, status, listing_id, source_message_id")
    .eq("conversation_id", conversationId)
    .eq("brokerage_id", ctx.brokerageId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(5)

  if (error) return { success: false, error: error.message }
  return { success: true, drafts: data ?? [] }
}

// ─── ACTION 5: RECORD THE MESSAGE A DRAFT WAS ACTUALLY SENT AS ──────────────
//
// acceptDraft only stages the draft's body into the compose bar — the agent
// can still edit further before sending, and the send itself goes through the
// unrelated messages pipeline (sendMessage in app/actions/communications.ts).
// sent_message_id is the RECONCILIATION column: it closes the loop from
// "the AI proposed this" to "and this is what actually went out", which
// outcomeForConversationDrafts below reads to grade acceptance-vs-real-send.

export async function recordDraftSent(params: {
  draftId: string
  messageId: string
}): Promise<{ success: boolean; error?: string }> {
  const ctx = await getAgentContext()
  if (!ctx.brokerageId) return { success: false, error: "Not authenticated" }

  const supabase = createServiceClient()
  const { error } = await supabase
    .from("ai_message_drafts")
    .update({ sent_message_id: params.messageId, status: "sent" })
    .eq("id", params.draftId)
    .eq("brokerage_id", ctx.brokerageId)
    // Only a draft the agent actually accepted can be reconciled to a send —
    // a still-pending or already-dismissed draft has no business being marked
    // sent underneath the agent.
    .in("status", ["accepted", "edited"])

  if (error) return { success: false, error: error.message }
  return { success: true }
}

// ─── ACTION 6: RECENT DRAFT OUTCOMES FOR A CONVERSATION ─────────────────────
//
// The reconciliation surface: for a conversation's last few AI drafts, whether
// each one was actually sent (sent_message_id set) or accepted-then-abandoned
// (accepted with no sent_message_id — the agent edited it away from the
// compose bar, or navigated off before sending). Read by AIReplyCoachPanel's
// "Recent AI drafts" strip.

export async function loadRecentDraftOutcomes(conversationId: string): Promise<{
  success: boolean
  outcomes?: Array<{
    id: string
    status: string
    confidence_score: number | null
    listing_id: string | null
    sent_message_id: string | null
    created_at: string
  }>
  error?: string
}> {
  const ctx = await getAgentContext()
  if (!ctx.brokerageId) return { success: false, error: "Not authenticated" }

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from("ai_message_drafts")
    .select("id, status, confidence_score, listing_id, sent_message_id, created_at")
    .eq("conversation_id", conversationId)
    .eq("brokerage_id", ctx.brokerageId)
    .in("status", ["accepted", "edited", "sent"])
    .order("created_at", { ascending: false })
    .limit(5)

  if (error) return { success: false, error: error.message }
  return { success: true, outcomes: data ?? [] }
}
