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

import { generateAIResponse }  from "@/lib/ai"
import { createServiceClient } from "@/lib/supabase/service"
import { applyBrandVoice }     from "@/lib/kernel/brand-voice"
import { processKernelEvent }  from "@/lib/kernel/notification-engine"
import { KernelEvent }         from "@/lib/kernel/events"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface GenerateAIReplyDraftParams {
  brokerageId:     string
  agentUserId:     string
  conversationId:  string
  contactId:       string
  listingId?:      string
  /** The inbound message id that triggered the draft — pass null for proactive/outbound drafts */
  inboundMessageId: string | null
  inboundBody:     string
  channel:         "email" | "sms" | "in_app"
  /** Optional override — defaults to brand voice tone if omitted */
  toneOverride?:   "professional" | "friendly" | "empathetic" | "assertive"
}

export interface GenerateAIReplyDraftResult {
  success:         boolean
  draftId?:        string
  draftBody?:      string
  draftSubject?:   string
  suggestedTone?:  string
  confidenceScore?: number
  brandVoiceNotes?: string[]
  error?:          string
}

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
  const supabase = createServiceClient()

  try {
    // ── 1. Load contact + recent thread context ──────────────────────────────
    const [{ data: contact }, { data: recentMsgs }, { data: listing }] = await Promise.all([
      supabase
        .from("contacts")
        .select("id, first_name, last_name, contact_type, contact_persona, status, timeline, dnc_status, tcpa_consent")
        .eq("id", params.contactId)
        .maybeSingle(),
      supabase
        .from("messages")
        .select("id, direction, body, type, created_at")
        .eq("conversation_id", params.conversationId)
        .order("created_at", { ascending: false })
        .limit(8),
      params.listingId
        ? supabase
            .from("listings")
            .select("id, address, list_price, lifecycle_stage")
            .eq("id", params.listingId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ])

    if (!contact) {
      return { success: false, error: "Contact not found" }
    }

    // ── 2. DNC / TCPA guard ──────────────────────────────────────────────────
    if (contact.dnc_status) {
      return { success: false, error: "Contact is on DNC list — draft blocked" }
    }
    if (params.channel === "sms" && !contact.tcpa_consent) {
      return { success: false, error: "No TCPA consent recorded — SMS draft blocked" }
    }

    // ── 3. Load brand voice (brokerage → agent hierarchy) ───────────────────
    const brandVoiceResult = await applyBrandVoice({
      brokerageId:  params.brokerageId,
      actorUserId:  params.agentUserId,
      actorRole:    "agent",
      journeyType:  "seller",
      persona:      contact.contact_persona ?? "general",
      messageType:  params.channel === "in_app" ? "chat" : params.channel,
      content:      params.inboundBody, // evaluate inbound content for tone context
    })

    const resolvedTone = params.toneOverride
      ?? brandVoiceResult.notes.find(n => n.startsWith("Target tone:"))?.replace("Target tone: ", "")
      ?? "professional"

    // ── 4. Build context summary ─────────────────────────────────────────────
    const threadHistory = (recentMsgs ?? [])
      .reverse()
      .map(m => `${m.direction === "inbound" ? "Contact" : "Agent"}: ${(m.body ?? "").substring(0, 120)}`)
      .join("\n")

    const charLimit = params.channel === "sms" ? 160 : params.channel === "in_app" ? 500 : 2000
    const includeSubject = params.channel === "email"

    // ── 5. Generate draft via AI ─────────────────────────────────────────────
    const draftResponse = await generateAIResponse({
      prompt: `You are a real estate agent's AI reply coach. Generate a ${resolvedTone} reply.

INBOUND MESSAGE (requires reply):
"${params.inboundBody}"

CONTACT:
- Name: ${contact.first_name} ${contact.last_name}
- Type: ${contact.contact_type ?? "unknown"}
- Persona: ${contact.contact_persona ?? "general"}
- Timeline: ${contact.timeline ?? "unknown"}

${listing ? `LISTING CONTEXT:
- Address: ${listing.address}
- List Price: $${listing.list_price?.toLocaleString() ?? "TBD"}
- Stage: ${listing.lifecycle_stage ?? "unknown"}
` : ""}

RECENT THREAD (newest last):
${threadHistory || "No prior messages"}

BRAND VOICE GUIDANCE:
${brandVoiceResult.notes.join("\n") || "Use professional, helpful tone"}

REQUIREMENTS:
- Channel: ${params.channel} (max ${charLimit} chars)
- Tone: ${resolvedTone}
- Address the contact by first name
- Be specific, warm, action-oriented
- Do NOT use prohibited phrases: ${brandVoiceResult.violations.length > 0 ? brandVoiceResult.violations.join(", ") : "none flagged"}
${includeSubject ? "- Start your reply with SUBJECT: <subject line> on the first line, then a blank line, then the body" : "- Return ONLY the message body, no subject line"}
- Return ONLY the message content, no meta-commentary`,
      metadata: {
        userId: params.agentUserId,
        brokerageId: params.brokerageId,
        feature: "ai_reply_coach",
      },
    })
    const rawDraft = draftResponse.text

    // ── 6. Parse subject vs body if email ───────────────────────────────────
    let draftSubject: string | undefined
    let draftBody = rawDraft.trim()

    if (includeSubject && draftBody.startsWith("SUBJECT:")) {
      const lines = draftBody.split("\n")
      draftSubject = lines[0].replace("SUBJECT:", "").trim()
      draftBody    = lines.slice(2).join("\n").trim()
    }

    // ── 7. Compute confidence score (heuristic: length + voice compliance) ──
    const hasViolations     = brandVoiceResult.violations.length > 0
    const withinCharLimit   = draftBody.length <= charLimit
    const baseConfidence    = 85
    const violationPenalty  = hasViolations ? brandVoiceResult.violations.length * 8 : 0
    const lengthPenalty     = withinCharLimit ? 0 : 10
    const confidenceScore   = Math.max(40, Math.min(99, baseConfidence - violationPenalty - lengthPenalty))

    const contextSummary = `Inbound: "${params.inboundBody.substring(0, 80)}…" | Contact: ${contact.first_name} ${contact.last_name} | Channel: ${params.channel}`

    // ── 8. Persist to ai_message_drafts ─────────────────────────────────────
    const { data: draft, error: insertError } = await supabase
      .from("ai_message_drafts")
      .insert({
        brokerage_id:      params.brokerageId,
        agent_user_id:     params.agentUserId,
        source_message_id: params.inboundMessageId ?? null,
        conversation_id:   params.conversationId,
        contact_id:        params.contactId,
        listing_id:        params.listingId ?? null,
        channel:           params.channel,
        context_summary:   contextSummary,
        trigger_event:     "inbound_message",
        draft_subject:     draftSubject ?? null,
        draft_body:        draftBody,
        suggested_tone:    resolvedTone,
        confidence_score:  confidenceScore,
        status:          "pending",
        final_body:      null,
        edit_delta:      null,
        acted_at:        null,
        sent_message_id: null,
      })
      .select("id")
      .single()

    if (insertError) {
      return { success: false, error: insertError.message }
    }

    // ── 9. Write smart_assistant_suggestions row ─────────────────────────────
    await supabase.from("smart_assistant_suggestions").insert({
      agent_id:            params.agentUserId,
      title:               `AI Reply Ready — ${contact.first_name} ${contact.last_name}`,
      description:         `${resolvedTone} draft prepared for ${params.channel} reply (confidence: ${confidenceScore}%)`,
      context_type:        "inbox_reply",
      action_type:         "accept_or_edit_draft",
      action_payload_json: JSON.stringify({ draftId: draft.id, conversationId: params.conversationId }),
      priority:            confidenceScore >= 80 ? "high" : "medium",
      status:              "pending",
    })

    // ── 10. Kernel event — non-blocking ─────────────────────────────────────
    await processKernelEvent({
      event:      KernelEvent.MESSAGE_FROM_CONTACT,
      brokerageId: params.brokerageId,
      entityType: "conversation",
      entityId:   params.conversationId,
    }).catch(() => {})

    return {
      success:         true,
      draftId:         draft.id,
      draftBody,
      draftSubject,
      suggestedTone:   resolvedTone,
      confidenceScore,
      brandVoiceNotes: brandVoiceResult.notes,
    }
  } catch (err: any) {
    return { success: false, error: err.message ?? "Unknown error" }
  }
}

// ─── ACTION 2: ACCEPT DRAFT ───────────────────────────────────────────────────

export async function acceptDraft(params: AcceptDraftParams): Promise<{ success: boolean; error?: string }> {
  const supabase = createServiceClient()

  const { data: draft, error: fetchError } = await supabase
    .from("ai_message_drafts")
    .select("draft_body, draft_subject, status")
    .eq("id", params.draftId)
    .maybeSingle()

  if (fetchError || !draft) {
    return { success: false, error: fetchError?.message ?? "Draft not found" }
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

  if (error) return { success: false, error: error.message }

  // Dismiss associated smart_assistant_suggestion
  await supabase
    .from("smart_assistant_suggestions")
    .update({ status: "dismissed" })
    .contains("action_payload_json", `"draftId":"${params.draftId}"`)

  return { success: true }
}

// ─── ACTION 3: REJECT DRAFT ───────────────────────────────────────────────────

export async function rejectDraft(params: RejectDraftParams): Promise<{ success: boolean; error?: string }> {
  const supabase = createServiceClient()

  const { error } = await supabase
    .from("ai_message_drafts")
    .update({
      status:   "rejected",
      acted_at: new Date().toISOString(),
      edit_delta: params.reason ? { rejection_reason: params.reason } : { rejection_reason: null },
    })
    .eq("id", params.draftId)
    .eq("status", "pending")

  if (error) return { success: false, error: error.message }

  await supabase
    .from("smart_assistant_suggestions")
    .update({ status: "dismissed" })
    .contains("action_payload_json", `"draftId":"${params.draftId}"`)

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
  }>
  error?: string
}> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("ai_message_drafts")
    .select("id, draft_body, draft_subject, suggested_tone, confidence_score, channel, created_at, status")
    .eq("conversation_id", conversationId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(5)

  if (error) return { success: false, error: error.message }
  return { success: true, drafts: data ?? [] }
}
