import "server-only"

/**
 * lib/ai-reply-coach/reply-draft-core.ts — THE reply-draft generator (lane 92A).
 *
 * Moved here VERBATIM from app/actions/ai-reply-coach.ts `generateAIReplyDraft`,
 * which was a "use server" export — a PUBLIC HTTP endpoint (CLAUDE.md §4) — that
 * ran on the SERVICE client with NO session read at all and keyed every read and
 * write on the body's `brokerageId` / `agentUserId`: any signed-in (or not) caller
 * could read another tenant's contact, thread and listing into a prompt, persist an
 * ai_message_drafts row and book AI spend under that tenant. test:tenant-scope
 * (CHECK 3) could not see it because the params were a NAMED interface; lane 92A
 * closed that blind spot and this was one of its three findings.
 *
 * Why a lib core and not a gate in place: the generator has a SESSIONLESS caller
 * (lib/voice/sms-inbound.ts draftProactiveReply — the inbound SMS webhook, whose
 * tenant comes from the number's routing) and a session gate in the action would
 * read nothing there (test:sessionless-use-server-census). So:
 *   · THIS function trusts `params.brokerageId` / `params.agentUserId` — call it
 *     only with a tenant you resolved yourself (the webhook's routing, a session
 *     you already gated). It is not "use server", so it is not an endpoint.
 *   · app/actions/ai-reply-coach.ts `generateAIReplyDraft` is the PUBLIC door: it
 *     gates on requireCallerTenant (session wins, foreign brokerage refused, the
 *     agent must be the caller) and then calls this.
 * The three reads now carry the tenant predicate too (conversation, contact,
 * listing), so even a trusted caller cannot pull a foreign row into the prompt.
 */

import { generateAIResponse }  from "@/lib/ai"
import { createServiceClient } from "@/lib/supabase/service"
import { applyBrandVoice }     from "@/lib/kernel/brand-voice"
import { processKernelEvent }  from "@/lib/kernel/notification-engine"
import { KernelEvent }         from "@/lib/kernel/events"
import { loadContactMemoryForPrompt, contactMemoryPromptSection } from "@/lib/kernel/conversation-memory"
import { knownFactsBlock }     from "@/lib/ai-isa/qualification-playbook"

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

export async function generateAIReplyDraftForTenant(
  params: GenerateAIReplyDraftParams
): Promise<GenerateAIReplyDraftResult> {
  const supabase = createServiceClient()

  try {
    // ── 0. The thread must be THIS tenant's (lane 92A) ───────────────────────
    // messages are read by conversation_id alone, so the conversation itself is
    // the boundary. A refused read is a refusal, not "not found" (§3).
    const { data: convo, error: convoError } = await supabase
      .from("conversations")
      .select("id")
      .eq("id", params.conversationId)
      .eq("brokerage_id", params.brokerageId)
      .maybeSingle()
    if (convoError) return { success: false, error: `Could not read the conversation: ${convoError.message}` }
    if (!convo) return { success: false, error: "Conversation not found in your brokerage" }

    // ── 1. Load contact + recent thread context ──────────────────────────────
    const [{ data: contact }, { data: recentMsgs }, { data: listing }] = await Promise.all([
      supabase
        .from("contacts")
        .select("id, first_name, last_name, contact_type, contact_persona, status, timeline, dnc_status, tcpa_consent")
        .eq("id", params.contactId)
        .eq("brokerage_id", params.brokerageId)
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
            .eq("brokerage_id", params.brokerageId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ])

    if (!contact) {
      return { success: false, error: "Contact not found in your brokerage" }
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

    // Lane 99B — MEMORY on the shared spine, scoped to THIS tenant (the contact row
    // above already proved membership; the helper re-applies the predicate). The
    // playbook's "already on file — do not re-ask" block reads the SAME spine, so a
    // current fact is never re-asked and an expired one is re-confirmed, not assumed.
    const contactMemory = await loadContactMemoryForPrompt({ contactId: contact.id, brokerageId: params.brokerageId, client: supabase })
    const memorySection = contactMemoryPromptSection(contactMemory)
    const onFile = knownFactsBlock({ hasContactInfo: true, timeline: contact.timeline ?? null, memory: contactMemory?.spine ?? null })

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
${memorySection ? `\n${memorySection}\n` : ""}${onFile ? `\n${onFile}\n` : ""}

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
    // smart_assistant_suggestions.agent_id is agents-class. Writing the USERS id was
    // FK-rejected, so the draft was saved but the "AI Reply Ready" nudge that tells
    // the agent it exists never reached the assistant panel.
    const { resolveUserIdToAgentRecord } = await import("@/lib/kernel/agent-identity-resolver")
    const suggestionAgentId = await resolveUserIdToAgentRecord(params.agentUserId, params.brokerageId)

    // TENANT: the RECIPIENT AGENT'S `users.brokerage_id`, resolved through the
    // user this suggestion is addressed to — NOT `params.brokerageId`.
    // `getContactCopilotSuggestions` (app/actions/contact-details.ts) reads
    // `.eq("agent_id", ctx.agentId).eq("brokerage_id", ctx.brokerageId)` with both
    // halves from ONE `getAgentContext()`, whose `brokerageId` is that session
    // user's `users.brokerage_id`. The two agree on every live row today, and the
    // point of resolving rather than assuming is that when they ever disagree the
    // READER decides which is right — and the reader reads `users`.
    const { resolveRecipientBrokerageId } = await import("@/lib/notifications/recipient-tenant")
    const suggestionTenant = await resolveRecipientBrokerageId(supabase, params.agentUserId)

    // NO AGENT ROW, NO SUGGESTION. Both readers of this table filter `agent_id`;
    // an unattributed suggestion reaches nobody however it is stamped, and
    // `smart_assistant_suggestions.agent_id` is agents-class, so a null here is
    // not "the desk's" — it is nobody's.
    if (!suggestionAgentId) {
      console.error(
        `[ai-reply-coach] suggestion skipped — users.id ${params.agentUserId} has no agents row in brokerage ` +
        `${params.brokerageId}; the draft was saved but no nudge was written`,
      )
    } else if (!suggestionTenant.ok) {
      console.error(`[ai-reply-coach] suggestion skipped — recipient tenant unresolved: ${suggestionTenant.reason}`)
    } else if (!suggestionTenant.brokerageId) {
      console.error(
        `[ai-reply-coach] suggestion skipped — users.id ${params.agentUserId} has no users.brokerage_id; ` +
        "an untenanted suggestion is filtered out of the surface that owns it",
      )
    } else {
      const { error: suggestionError } = await supabase.from("smart_assistant_suggestions").insert({
        agent_id:            suggestionAgentId,
        brokerage_id:        suggestionTenant.brokerageId,
        title:               `AI Reply Ready — ${contact.first_name} ${contact.last_name}`,
        description:         `${resolvedTone} draft prepared for ${params.channel} reply (confidence: ${confidenceScore}%)`,
        context_type:        "inbox_reply",
        action_type:         "accept_or_edit_draft",
        action_payload_json: JSON.stringify({ draftId: draft.id, conversationId: params.conversationId }),
        priority:            confidenceScore >= 80 ? "high" : "medium",
        status:              "pending",
      })
      // supabase-js RESOLVES a refused insert; undestructured, the "AI Reply
      // Ready" nudge could fail on every call and this action still reported the
      // draft as delivered.
      if (suggestionError) {
        console.error("[ai-reply-coach] smart_assistant_suggestions insert refused:", suggestionError.message)
      }
    }

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
