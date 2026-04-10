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

export type InboxChannel = "all" | "sms" | "email" | "voice" | "portal" | "chat" | "ai"

export interface InboxMessageRow {
  id: string
  contact_id: string
  contact_name: string
  channel: InboxChannel | string
  direction: "inbound" | "outbound"
  body: string
  created_at: string
  read: boolean
  source_table: "messages" | "client_portal_messages" | "voice_calls" | "chat_messages"
  sentiment?: string | null
  summary?: string | null
}

export interface InboxThread {
  contact_id: string
  contact_name: string
  contact_type?: string | null
  last_message_at: string
  last_message_body: string
  unread_count: number
  channel: string
}

export interface LoadUniversalInboxInput {
  actorContext: ActorContext
  channel?: InboxChannel
  contactId?: string
  unreadOnly?: boolean
  limit?: number
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
      if (contactIds.length === 0) {
        return { success: true, data: { messages: [], threads: [], totalUnread: 0 } }
      }
    }

    // ── 3. contacts lookup for names ──────────────────────────────────────────
    const contactNameQuery = supabase
      .from("contacts")
      .select("id, first_name, last_name, contact_type")
      .eq("brokerage_id", actorContext.brokerageId)
    if (contactIds) contactNameQuery.in("id", contactIds)
    const { data: contactRows } = await contactNameQuery.limit(500)
    const contactMap = new Map<string, { name: string; type: string | null }>(
      (contactRows ?? []).map((c: any) => [
        c.id,
        {
          name: `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "Unknown",
          type: c.contact_type ?? null,
        },
      ])
    )

    const results: InboxMessageRow[] = []

    // ── 4. client_portal_messages ─────────────────────────────────────────────
    const fetchPortal = channel === "all" || channel === "portal" || channel === "sms" || channel === "email"
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
    const fetchMessages = channel === "all" || ["sms", "email", "ai", "chat"].includes(channel)
    if (fetchMessages) {
      let q = supabase
        .from("messages")
        .select("id, contact_id, type, direction, body, created_at, status, sentiment, agent_id")
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
          sentiment: m.sentiment,
        })
      }
    }

    // ── 6. voice_calls ────────────────────────────────────────────────────────
    const fetchVoice = channel === "all" || channel === "voice"
    if (fetchVoice) {
      let q = supabase
        .from("voice_calls")
        .select("id, contact_id, direction, summary, ai_notes, created_at, sentiment, status")
        .order("created_at", { ascending: false })
        .limit(limit)
      if (agentId) q = q.eq("agent_id", agentId)
      if (contactId) q = q.eq("contact_id", contactId)
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

    // ── 7. Sort + deduplicate ─────────────────────────────────────────────────
    const sorted = results
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, limit)

    // ── 8. Build threads (one per contact, latest message wins) ───────────────
    const threadMap = new Map<string, InboxThread>()
    for (const m of sorted) {
      if (!threadMap.has(m.contact_id)) {
        threadMap.set(m.contact_id, {
          contact_id: m.contact_id,
          contact_name: m.contact_name,
          contact_type: contactMap.get(m.contact_id)?.type ?? null,
          last_message_at: m.created_at,
          last_message_body: m.body.slice(0, 80),
          unread_count: m.read ? 0 : 1,
          channel: m.channel,
        })
      } else {
        if (!m.read) threadMap.get(m.contact_id)!.unread_count++
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
 * Runs full outbound eligibility gate before persisting via communication-spine.
 *
 * Tables written:
 *   messages OR client_portal_messages (via communication-spine persister)
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
      .select("id, first_name, last_name, email, phone, contact_type, brokerage_id, consent_type, tcpa_consent, dnc_status")
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
        consent_type: contact.consent_type,
        tcpa_consent: contact.tcpa_consent,
        dnc_status: contact.dnc_status,
      } as KernelContact,
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
      const { data: msg, error } = await supabase
        .from("messages")
        .insert({
          contact_id: contactId,
          agent_id: agentId,
          brokerage_id: actorContext.brokerageId,
          type: channel,
          direction: "outbound",
          body,
          status: "sent",
          created_at: new Date().toISOString(),
        })
        .select("id")
        .single()
      if (error) throw error
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
