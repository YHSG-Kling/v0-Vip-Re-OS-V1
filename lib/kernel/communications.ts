// lib/kernel/communications.ts
// LAYER 0 — Outbound communication eligibility gate.
//
// Single export: evaluateOutboundEligibility()
//
// Execution order (fail-fast):
//   1. Suppression pre-check (contact flags + contact_suppression_list)
//   2. Full compliance gate via evaluateOutbound() (brand, TCPA, authority, fair housing, them-first)
//
// This file calls evaluateOutbound() with the CORRECT EvaluateOutboundParams shape.
// Never use the flat enforceCompliance() wrapper for real contact sends —
// use this function instead.
//
// Import from '@/lib/kernel' — never import this file directly outside the kernel.

"use server"

import { evaluateOutbound } from "./compliance"
import { checkSuppression } from "./compliance/check-suppression"
import { createClient as createServerClient } from "@/lib/supabase/server"
import type {
  EvaluateOutboundParams,
  ComplianceResult,
  KernelContact,
  ActorContext,
  JourneyType,
  Persona,
  MessageType,
} from "./types"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface EvaluateOutboundEligibilityParams {
  /** Full actor context (userId, role, brokerageId) */
  actorContext: ActorContext
  /** Contact being messaged — must be a KernelContact shape */
  contact: KernelContact
  /** Content being sent */
  content: string
  /** Channel / message type */
  messageType: MessageType
  /** Journey context for compliance scoring */
  journeyType?: JourneyType
  /** Contact persona for brand voice and fair housing checks */
  persona?: Persona
}

export interface OutboundEligibilityResult {
  /** Whether the message is allowed to be sent */
  eligible: boolean
  /** Human-readable reason when not eligible */
  reason?: string
  /** Suppression-specific block (checked before full compliance) */
  suppressedBy?: string
  /** Full compliance result for logging / UI display */
  compliance: ComplianceResult
}

// ─── MAIN EXPORT ─────────────────────────────────────────────────────────────

/**
 * evaluateOutboundEligibility
 *
 * The canonical gate for any outbound send.
 * Runs suppression pre-check first (fast, DB-only) then full compliance evaluation.
 * Returns a structured result — never throws.
 *
 * Usage in a Server Action:
 * ```ts
 * const eligibility = await evaluateOutboundEligibility({
 *   actorContext: ctx.actorContext,
 *   contact: kernelContact,
 *   content: emailBody,
 *   messageType: "email",
 * })
 * if (!eligibility.eligible) return { error: eligibility.reason }
 * // proceed with send
 * ```
 */
export async function evaluateOutboundEligibility(
  params: EvaluateOutboundEligibilityParams
): Promise<OutboundEligibilityResult> {
  const NOT_ELIGIBLE_BASE: ComplianceResult = {
    allowed: false,
    violations: [],
    blockedReason: undefined,
    correctedContent: undefined,
  }

  try {
    // ── STAGE 1: Suppression pre-check ───────────────────────────────────────
    // Fast check against contact flags and contact_suppression_list.
    // If suppressed, skip the full compliance gate (no LLM calls, no writes).
    const suppressionChannel = messageTypeToSuppressionChannel(params.messageType)
    if (suppressionChannel) {
      const suppression = await checkSuppression({
        brokerageId: params.actorContext.brokerageId,
        contactId:   params.contact.id || null,
        email:       params.contact.email ?? null,
        phone:       params.contact.phone ?? null,
        channel:     suppressionChannel,
      })

      if (suppression.suppressed) {
        return {
          eligible:     false,
          reason:       suppression.reason ?? "Contact is suppressed",
          suppressedBy: suppression.reason,
          compliance:   {
            ...NOT_ELIGIBLE_BASE,
            violations:    [suppression.reason ?? "suppressed"],
            blockedReason: suppression.reason,
          },
        }
      }
    }

    // ── STAGE 2: Full compliance gate ─────────────────────────────────────────
    const outboundParams: EvaluateOutboundParams = {
      actorContext: params.actorContext,
      journeyType:  params.journeyType ?? inferJourneyType(params.contact),
      persona:      params.persona ?? (params.contact.persona ?? "other"),
      messageType:  params.messageType,
      content:      params.content,
      contact:      params.contact,
    }

    const compliance = await evaluateOutbound(outboundParams)

    return {
      eligible:  compliance.allowed,
      reason:    compliance.allowed ? undefined : (compliance.blockedReason ?? compliance.violations[0]),
      compliance,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Eligibility check failed"
    return {
      eligible:  false,
      reason:    message,
      compliance: {
        ...NOT_ELIGIBLE_BASE,
        violations:    [message],
        blockedReason: message,
      },
    }
  }
}

// ─── UNIVERSAL INBOX ─────────────────────────────────────────────────────────

export type InboxChannel = "all" | "sms" | "email" | "voice" | "portal" | "chat" | "ai" | "vendor"

export interface InboxMessageRow {
  id: string
  /** contacts.id for contact threads; "" for lead-lane rows (no contact yet). */
  contact_id: string
  contact_name: string
  channel: InboxChannel | string
  direction: "inbound" | "outbound"
  body: string
  created_at: string
  read: boolean
  source_table: "messages" | "client_portal_messages" | "voice_calls" | "chat_messages" | "vendor_messages" | "isa_outreach_log" | "ai_isa_activities"
  sentiment?: string | null
  summary?: string | null
  vendor_id?: string | null
  /** "lead" for AI-ISA lead-lane rows (isa_outreach_log sends + lead voice calls). */
  party?: "contact" | "lead"
  /** leads.id when party === "lead". Leads are NOT contacts — separate id class. */
  lead_id?: string | null
}

export interface InboxThread {
  /** contacts.id, or "" for lead threads (keyed by lead_id instead). */
  contact_id: string
  contact_name: string
  contact_type?: string | null
  last_message_at: string
  last_message_body: string
  unread_count: number
  channel: string
  party?: "contact" | "lead"
  lead_id?: string | null
}

export interface LoadUniversalInboxInput {
  actorContext: ActorContext
  channel?: InboxChannel
  contactId?: string
  unreadOnly?: boolean
  limit?: number
  /** Restrict to ONE lead's conversation (isa_outreach_log + lead voice_calls only). */
  leadId?: string
  /** "lead" fetches ONLY the AI-ISA lead lane (skips all contact lanes). */
  party?: "lead"
}

export interface UniversalInboxResult {
  messages: InboxMessageRow[]
  threads: InboxThread[]
  totalUnread: number
}

/**
 * loadUniversalInbox
 *
 * Kernel command for loading the unified message inbox.
 * Merges client_portal_messages, messages, voice_calls scoped by brokerage RLS.
 *
 * Input:  { actorContext, channel?, contactId?, unreadOnly?, limit? }
 * Output: { success, data: UniversalInboxResult }
 *
 * Tables read:
 *   messages, client_portal_messages, voice_calls, contacts
 *
 * Business rules:
 *   - All queries scoped by brokerage_id (never cross-brokerage)
 *   - agent role: also filters by agent_id on contacts
 *   - Results merged and sorted newest-first
 */
export async function loadUniversalInbox(
  input: LoadUniversalInboxInput
): Promise<{ success: boolean; data?: UniversalInboxResult; error?: string }> {
  try {
    const { actorContext, channel = "all", contactId, unreadOnly = false, limit = 50 } = input
    // Lead-lane-only mode: one lead's conversation, or the whole ISA lead lane.
    const leadLaneOnly = !!input.leadId || input.party === "lead"
    const supabase = await createServerClient()

    // ── 1. Resolve agent_id from actorContext.userId when role = agent ────────
    let agentId: string | null = null
    if (actorContext.role === "agent" || actorContext.role === "isa") {
      const { data: agent } = await supabase
        .from("agents")
        .select("id")
        .eq("user_id", actorContext.userId)
        .eq("brokerage_id", actorContext.brokerageId)
        .maybeSingle()
      agentId = agent?.id ?? null
    }

    // ── 2. Build base contact filter ──────────────────────────────────────────
    // For agents: only contacts they own; for broker/admin: all brokerage contacts
    let contactIds: string[] | null = null
    if (!leadLaneOnly) {
      if (contactId) {
        contactIds = [contactId]
      } else if (agentId) {
        const { data: agentContacts } = await supabase
          .from("contacts")
          .select("id")
          .eq("agent_id", agentId)
          .eq("brokerage_id", actorContext.brokerageId)
          .limit(500)
        contactIds = (agentContacts ?? []).map((c: any) => c.id)
      }
    }
    // An agent with zero owned contacts still gets the LEAD lane — don't return early.
    const skipContactLanes = leadLaneOnly || (contactIds !== null && contactIds.length === 0)

    // ── 3. contacts lookup for names ──────────────────────────────────────────
    const contactMap = new Map<string, { name: string; type: string | null }>()
    if (!skipContactLanes) {
      const contactNameQuery = supabase
        .from("contacts")
        .select("id, first_name, last_name, contact_type")
        .eq("brokerage_id", actorContext.brokerageId)
      if (contactIds) contactNameQuery.in("id", contactIds)
      const { data: contactRows } = await contactNameQuery.limit(500)
      for (const c of contactRows ?? []) {
        contactMap.set(c.id, {
          name: `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "Unknown",
          type: c.contact_type ?? null,
        })
      }
    }

    const results: InboxMessageRow[] = []

    // ── 4. client_portal_messages ─────────────────────────────────────────────
    const fetchPortal = !skipContactLanes && (channel === "all" || channel === "portal" || channel === "sms" || channel === "email")
    if (fetchPortal) {
      let q = supabase
        .from("client_portal_messages")
        .select("id, contact_id, channel, direction, body, created_at, read")
        .eq("brokerage_id", actorContext.brokerageId)
        .order("created_at", { ascending: false })
        .limit(limit)
      if (contactIds) q = q.in("contact_id", contactIds)
      if (unreadOnly) q = q.eq("read", false)
      const { data: portalMsgs } = await q
      for (const m of portalMsgs ?? []) {
        const contact = contactMap.get(m.contact_id)
        results.push({
          id: m.id,
          contact_id: m.contact_id,
          contact_name: contact?.name ?? "Unknown",
          channel: m.channel ?? "portal",
          direction: m.direction === "client_to_agent" ? "inbound" : "outbound",
          body: m.body ?? "",
          created_at: m.created_at,
          read: m.read ?? false,
          source_table: "client_portal_messages",
        })
      }
    }

    // ── 5. messages (sms, email, ai, chat) ────────────────────────────────────
    const fetchMessages = !skipContactLanes && (channel === "all" || ["sms", "email", "ai", "chat"].includes(channel))
    if (fetchMessages) {
      // TOMBSTONE — `messages.sentiment` removed from this select.
      //
      // It was READ BY CODE AND WRITTEN BY NOBODY (census 1b): no writer in the
      // tree ever names that column, so `sentiment` on every messages-lane row
      // of this feed was permanently null while the VOICE lane below (step 6)
      // filled the same field from `voice_calls.sentiment`, which IS written.
      // A reader comparing the two lanes would have concluded that text threads
      // are never analysed for sentiment — the opposite of the truth.
      //
      // SURVIVOR: sentiment on a text thread is measured at the THREAD level, not
      // per message — `conversation_insights.overall_sentiment`, written for
      // every analysed conversation at lib/intelligence/conversation-insights.ts:429
      // (insert) and :459 (update), and rendered on the inbox slideout and the
      // communications-intelligence board. Stamping a thread-level reading onto
      // each individual message would be a second, wrong spelling of it (§6),
      // so this lane leaves the field unset rather than filling it with a value
      // that is not about this message.
      let q = supabase
        .from("messages")
        .select("id, contact_id, type, direction, body, created_at, status, agent_id")
        .order("created_at", { ascending: false })
        .limit(limit)
      if (contactIds) q = q.in("contact_id", contactIds)
      if (channel !== "all") q = q.eq("type", channel)
      if (unreadOnly) q = q.eq("status", "unread")
      const { data: msgs } = await q
      for (const m of msgs ?? []) {
        const contact = contactMap.get(m.contact_id)
        results.push({
          id: m.id,
          contact_id: m.contact_id,
          contact_name: contact?.name ?? "Unknown",
          channel: m.type ?? "sms",
          direction: m.direction === "inbound" ? "inbound" : "outbound",
          body: m.body ?? "",
          created_at: m.created_at,
          read: m.status !== "unread",
          source_table: "messages",
          // `sentiment` deliberately unset — see the tombstone on this lane's
          // select. Thread sentiment lives on conversation_insights.overall_sentiment.
        })
      }
    }

    // ── 6. voice_calls (contact-keyed) ────────────────────────────────────────
    const fetchVoice = !skipContactLanes && (channel === "all" || channel === "voice")
    if (fetchVoice) {
      let q = supabase
        .from("voice_calls")
        .select("id, contact_id, direction, summary, ai_notes, created_at, sentiment, status")
        .order("created_at", { ascending: false })
        .limit(limit)
      if (agentId) q = q.eq("agent_id", agentId)
      if (contactId) q = q.eq("contact_id", contactId)
      // Lead-keyed calls (contact_id null, lead_id set) belong to the LEAD lane below.
      q = q.not("contact_id", "is", null)
      const { data: calls } = await q
      for (const v of calls ?? []) {
        const contact = contactMap.get(v.contact_id)
        results.push({
          id: v.id,
          contact_id: v.contact_id,
          contact_name: contact?.name ?? "Unknown",
          channel: "voice",
          direction: v.direction === "inbound" ? "inbound" : "outbound",
          body: v.summary ?? v.ai_notes ?? "Voice call",
          created_at: v.created_at,
          read: true,
          source_table: "voice_calls",
          sentiment: v.sentiment,
          summary: v.summary,
        })
      }
    }

    // ── 6b. vendor_messages (vendor↔contact threads surface in the contact's
    // thread; vendor↔agent threads are not contact-keyed and are shown in the
    // vendor surface, not here) ───────────────────────────────────────────────
    const fetchVendor = !skipContactLanes && (channel === "all" || channel === "vendor")
    if (fetchVendor) {
      let q = supabase
        .from("vendor_messages")
        .select("id, vendor_id, counterparty_type, counterparty_id, sender_type, body, created_at, read")
        .eq("brokerage_id", actorContext.brokerageId)
        .eq("counterparty_type", "contact")
        .order("created_at", { ascending: false })
        .limit(limit)
      if (contactIds) q = q.in("counterparty_id", contactIds)
      if (unreadOnly) q = q.eq("read", false)
      const { data: vendorMsgs } = await q
      for (const m of vendorMsgs ?? []) {
        const contact = contactMap.get(m.counterparty_id)
        results.push({
          id: m.id,
          contact_id: m.counterparty_id,
          contact_name: contact?.name ?? "Unknown",
          channel: "vendor",
          // A vendor-sent message is inbound to the brokerage side.
          direction: m.sender_type === "vendor" ? "inbound" : "outbound",
          body: m.body ?? "",
          created_at: m.created_at,
          read: m.read ?? false,
          source_table: "vendor_messages",
          vendor_id: m.vendor_id,
        })
      }
    }

    // ── 6c. AI-ISA LEAD LANE — isa_outreach_log sends + lead-keyed voice calls.
    // Leads are NOT contacts: the ISA nurtures them by email / direct mail (no
    // phone or SMS until consent), and leads can CALL IN. Those conversations
    // surface here, keyed by lead_id, until positive intent converts the lead
    // to a contact (then the contact thread owns the story). ──────────────────
    const fetchLeadLane =
      !contactId &&
      (!!input.leadId || channel === "all" || channel === "ai" || channel === "email" || channel === "voice")
    const leadMap = new Map<string, { name: string; state: string | null }>()
    if (fetchLeadLane) {
      // Lead scope mirrors contact scoping: agents see their own leads;
      // broker/admin/solo principals see the brokerage. Converted leads
      // (contact_id set) live on their contact thread — excluded.
      let leadQ = supabase
        .from("leads")
        .select("id, first_name, last_name, lifecycle_state")
        .eq("brokerage_id", actorContext.brokerageId)
        .is("contact_id", null)
      if (input.leadId) leadQ = leadQ.eq("id", input.leadId)
      else if (agentId) leadQ = leadQ.eq("agent_id", agentId)
      const { data: leadRows } = await leadQ.limit(500)
      for (const l of leadRows ?? []) {
        leadMap.set(l.id, {
          name: `${l.first_name ?? ""} ${l.last_name ?? ""}`.trim() || "New lead",
          state: l.lifecycle_state ?? null,
        })
      }
      const leadIds = [...leadMap.keys()]
      if (leadIds.length > 0) {
        // ISA sends (email / direct_mail / video / social / voice) — outbound.
        if (channel !== "voice") {
          let q = supabase
            .from("isa_outreach_log")
            .select("id, lead_id, channel, subject, body_snippet, status, created_at")
            .eq("brokerage_id", actorContext.brokerageId)
            .in("lead_id", leadIds)
            .order("created_at", { ascending: false })
            .limit(limit)
          if (channel === "email") q = q.eq("channel", "email")
          const { data: sends } = await q
          for (const s of sends ?? []) {
            results.push({
              id: s.id,
              contact_id: "",
              contact_name: leadMap.get(s.lead_id)?.name ?? "New lead",
              channel: s.channel ?? "email",
              direction: "outbound",
              body:
                [s.subject, s.body_snippet].filter(Boolean).join(" — ") ||
                `${(s.channel ?? "email").replace(/_/g, " ")} outreach sent`,
              created_at: s.created_at,
              read: true,
              source_table: "isa_outreach_log",
              party: "lead",
              lead_id: s.lead_id,
            })
          }
        }
        // The LEAD's replies — inbound turns recorded on ai_isa_activities
        // (outcome 'replied'; the inbound-email handler writes them lead-keyed
        // because leads are NOT contacts and messages is contact-FK'd).
        if (channel !== "voice") {
          const { data: replies } = await supabase
            .from("ai_isa_activities")
            .select("id, lead_id, channel, summary, created_at")
            .eq("brokerage_id", actorContext.brokerageId)
            .in("lead_id", leadIds)
            .eq("outcome", "replied")
            .order("created_at", { ascending: false })
            .limit(limit)
          for (const r of replies ?? []) {
            results.push({
              id: r.id,
              contact_id: "",
              contact_name: leadMap.get(r.lead_id)?.name ?? "New lead",
              channel: r.channel ?? "email",
              direction: "inbound",
              body: r.summary ?? "Lead replied",
              created_at: r.created_at,
              read: true,
              source_table: "ai_isa_activities",
              party: "lead",
              lead_id: r.lead_id,
            })
          }
        }
        // Lead call-ins (and ISA lead calls) — voice_calls keyed by lead_id.
        if (channel === "all" || channel === "ai" || channel === "voice" || !!input.leadId) {
          const { data: leadCalls } = await supabase
            .from("voice_calls")
            .select("id, lead_id, direction, summary, transcription, created_at, status")
            .eq("brokerage_id", actorContext.brokerageId)
            .in("lead_id", leadIds)
            .order("created_at", { ascending: false })
            .limit(limit)
          for (const v of leadCalls ?? []) {
            results.push({
              id: v.id,
              contact_id: "",
              contact_name: leadMap.get(v.lead_id)?.name ?? "New lead",
              channel: "voice",
              direction: v.direction === "inbound" ? "inbound" : "outbound",
              body: v.summary ?? (v.transcription ? String(v.transcription).slice(0, 160) : "Voice call"),
              created_at: v.created_at,
              read: true,
              source_table: "voice_calls",
              summary: v.summary,
              party: "lead",
              lead_id: v.lead_id,
            })
          }
        }
      }
    }

    // ── 7. Sort + deduplicate ─────────────────────────────────────────────────
    const sorted = results
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, limit)

    // ── 8. Build threads (one per contact OR lead, latest message wins) ───────
    const threadMap = new Map<string, InboxThread>()
    for (const m of sorted) {
      const key = m.party === "lead" && m.lead_id ? `lead:${m.lead_id}` : m.contact_id
      if (!threadMap.has(key)) {
        threadMap.set(key, {
          contact_id: m.contact_id,
          contact_name: m.contact_name,
          contact_type:
            m.party === "lead" ? "lead" : contactMap.get(m.contact_id)?.type ?? null,
          last_message_at: m.created_at,
          last_message_body: m.body.slice(0, 80),
          unread_count: m.read ? 0 : 1,
          channel: m.channel,
          party: m.party ?? "contact",
          lead_id: m.party === "lead" ? m.lead_id ?? null : null,
        })
      } else {
        if (!m.read) threadMap.get(key)!.unread_count++
      }
    }

    const threads = [...threadMap.values()].sort(
      (a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime()
    )

    const totalUnread = sorted.filter((m) => !m.read).length

    return { success: true, data: { messages: sorted, threads, totalUnread } }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to load inbox",
    }
  }
}

export interface SendInboxReplyInput {
  actorContext: ActorContext
  contactId: string
  body: string
  channel: "sms" | "email" | "portal" | "chat"
}

/**
 * sendInboxReply
 *
 * Kernel command to send an outbound reply from the inbox.
 * Runs full outbound eligibility gate, then ACTUALLY DISPATCHES, then records.
 *
 * ─── THE REPLY THAT WAS NEVER SENT ──────────────────────────────────────────
 * This function used to run the compliance gate and then INSERT a messages row
 * with `status: "sent"` — and stop. For channel 'portal'/'chat' that is correct:
 * an in-app message IS delivered by being stored, and the client portal reads
 * that row. For 'email' and 'sms' it was not: no dispatcher was ever called, no
 * provider ever saw the text, and the row said sent. An agent replying to a
 * client from the universal inbox got a success toast and a message in the
 * thread, and the client got nothing — with no error anywhere to notice.
 *
 * The canonical pattern already existed one directory over: the sequence email
 * adapter tries the agent's own connected mailbox (sendPersonalEmail), falls
 * back to dispatchEmail, and reports 'sent' ONLY on a successful dispatch. This
 * now does the same, in that order, so a reply leaves from the agent's real
 * mailbox when they have connected one — and a refusal is recorded as a FAILED
 * message with the provider's reason rather than a convincing lie.
 *
 * Every gate downstream still applies: dispatchEmail/dispatchSms re-run
 * suppression, compliance, de-conflict and budget. Double-gating is deliberate
 * (both fail closed) and matches the defence-in-depth the rest of the app uses.
 *
 * Tables written:
 *   messages OR client_portal_messages
 */
export async function sendInboxReply(
  input: SendInboxReplyInput
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const { actorContext, contactId, body, channel } = input
    const supabase = await createServerClient()

    // Load contact for compliance gate
    const { data: contact } = await supabase
      .from("contacts")
      .select("id, first_name, last_name, email, phone, contact_type, brokerage_id, tcpa_consent_source, tcpa_consent, dnc_status")
      .eq("id", contactId)
      .eq("brokerage_id", actorContext.brokerageId)
      .maybeSingle()

    if (!contact) return { success: false, error: "Contact not found" }

    // Run outbound eligibility gate
    const messageType: MessageType = channel === "sms" ? "sms" : channel === "email" ? "email" : "in_app"
    const eligibility = await evaluateOutboundEligibility({
      actorContext,
      contact: {
        id: contact.id,
        first_name: contact.first_name,
        last_name: contact.last_name,
        email: contact.email,
        phone: contact.phone,
        contact_type: contact.contact_type,
        brokerage_id: contact.brokerage_id,
        consent_type: contact.tcpa_consent_source,
        tcpa_consent: contact.tcpa_consent,
        dnc_status: contact.dnc_status,
      } as unknown as KernelContact,
      content: body,
      messageType,
    })

    if (!eligibility.eligible) {
      return { success: false, error: eligibility.reason ?? "Message blocked by compliance gate" }
    }

    // Resolve agent_id for the insert
    const { data: agentRow } = await supabase
      .from("agents")
      .select("id")
      .eq("user_id", actorContext.userId)
      .eq("brokerage_id", actorContext.brokerageId)
      .maybeSingle()

    const agentId = agentRow?.id ?? null

    // Persist via messages table (outbound)
    if (channel === "portal") {
      const { data: msg, error } = await supabase
        .from("client_portal_messages")
        .insert({
          contact_id: contactId,
          agent_id: agentId,
          brokerage_id: actorContext.brokerageId,
          body,
          channel: "portal",
          direction: "agent_to_client",
          read: true,
          created_at: new Date().toISOString(),
        })
        .select("id")
        .single()
      if (error) throw error
      return { success: true, messageId: msg.id }
    } else {
      // messages.conversation_id is NOT NULL (live schema) — this insert
      // silently failed for months without the thread resolved first.
      const { ensureConversationForContact, touchConversation } = await import("@/lib/kernel/conversation-thread")
      const conversationId = await ensureConversationForContact(supabase, {
        contactId, brokerageId: actorContext.brokerageId, agentId,
      })
      if (!conversationId) return { success: false, error: "Could not resolve the conversation thread" }

      // ── DISPATCH FIRST, then record what actually happened ────────────────
      let dispatched = false
      let dispatchError: string | null = null
      let providerKey: string | null = null
      // The provider's id for this send. Stored on the message so the delivery
      // webhook can correlate EXACTLY — without it the truth arrives and has
      // nothing to attach to, and the thread keeps showing an unproven "sent".
      let providerMessageId: string | null = null

      if (channel === "email") {
        if (!contact.email) return { success: false, error: "Contact has no email address" }
        const subject = "Re: your message"
        // 1. The agent's OWN connected mailbox, when they have one — a reply to a
        //    client should come from the agent, not a platform relay.
        if (actorContext.userId) {
          try {
            const { sendPersonalEmail } = await import("@/lib/providers/email/personal-email-adapter")
            const personal = await sendPersonalEmail({
              agentUserId: actorContext.userId,
              to: contact.email,
              subject,
              htmlBody: body.replace(/\n/g, "<br>"),
              textBody: body,
            })
            if (personal.success) { dispatched = true; providerKey = personal.provider ?? "personal" }
          } catch { /* fall through to the platform lane */ }
        }
        // 2. Platform email lane.
        if (!dispatched) {
          const { dispatchEmail } = await import("@/lib/providers/dispatch")
          const result = await dispatchEmail({
            brokerageId: actorContext.brokerageId,
            userId: actorContext.userId,
            agentId: agentId ?? undefined,
            // No invented sender. sendEmail now validates and refuses, so an
            // unresolvable from-address returns a reason instead of failing at
            // the provider with an opaque unverified-sender 403.
            from: (await import("@/lib/providers/outbound-sender"))
              .formatSenderOrUndefined(await (await import("@/lib/providers/outbound-sender"))
                .resolveOutboundSender(supabase as any, actorContext.brokerageId)),
            to: contact.email,
            subject,
            html: body.replace(/\n/g, "<br>"),
            text: body,
            contactId,
            channelPurpose: "conversation",
            systemSource: "inbox_reply",
          })
          dispatched = result.success
          providerKey = result.providerKey
          dispatchError = result.error ?? null
          providerMessageId = result.messageId ?? null
        }
      } else {
        // sms
        if (!contact.phone) return { success: false, error: "Contact has no phone number" }
        const { dispatchSms } = await import("@/lib/providers/dispatch")
        const result = await dispatchSms({
          brokerageId: actorContext.brokerageId,
          userId: actorContext.userId,
          agentId: agentId ?? undefined,
          to: contact.phone,
          message: body,
          contactId,
          systemSource: "inbox_reply",
        })
        dispatched = result.success
        providerKey = result.providerKey
        dispatchError = result.error ?? null
        providerMessageId = result.messageId ?? null
      }

      // Record the attempt either way — an agent must be able to see that the
      // reply they typed did not leave, and why. status carries the truth.
      const { data: msg, error } = await supabase
        .from("messages")
        .insert({
          conversation_id: conversationId,
          contact_id: contactId,
          agent_id: agentId,
          brokerage_id: actorContext.brokerageId,
          type: channel,
          direction: "outbound",
          body,
          status: dispatched ? "sent" : "failed",
          // The correlation key for outcome reconciliation. twilio_sid for sms,
          // sg_message_id for email — each named for the provider that issued it,
          // matching what the corresponding webhook looks for.
          metadata: providerMessageId
            ? (channel === "sms"
                ? { twilio_sid: providerMessageId }
                : { sg_message_id: providerMessageId })
            : {},
          created_at: new Date().toISOString(),
        })
        .select("id")
        .single()
      if (error) throw error

      if (!dispatched) {
        return {
          success: false,
          messageId: msg.id,
          error: dispatchError ?? `Reply could not be sent (${providerKey ?? channel} refused it)`,
        }
      }
      await touchConversation(supabase, conversationId, { inbound: false })
      return { success: true, messageId: msg.id }
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to send reply",
    }
  }
}

// ─── INTERNAL HELPERS ────────────────────────────────────────────────────────

function messageTypeToSuppressionChannel(
  messageType: MessageType
): import("./compliance/check-suppression").SuppressionChannel | null {
  switch (messageType) {
    case "email":       return "email"
    case "sms":         return "sms"
    case "phone":       return "phone"
    case "direct_mail": return "mail"
    default:            return null  // in_app, ai, social — no suppression list lookup
  }
}

function inferJourneyType(contact: KernelContact): JourneyType {
  if (contact.contact_type === "seller") return "seller"
  if (contact.contact_type === "both")   return "dual"
  return "buyer"
}
