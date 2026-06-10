// lib/compliance/ai-disclosure-ledger.ts
//
// AI DISCLOSURE LEDGER — the exportable compliance record regulators / counsel ask
// for: "show me every AI-generated message your system sent to a consumer, who
// approved it, and what the consumer's consent state was." The egress already
// records all of this (agent_client_messages: proposed→approved→sent, by which
// Claude manager, to which contact, on which channel); this assembles it into one
// auditable, manager-attributed ledger with the human-in-the-loop proof and a live
// consent snapshot per recipient.
//
// This IS the differentiator made legible: the approval gate is the human-oversight
// control the EU AI Act / FTC want, and this report is its evidence.

import { createServiceClient } from "@/lib/supabase/service"
import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"
import { canDispatchToContact, type DispatchChannel } from "@/lib/compliance/contact-channel-gate"

export interface AiDisclosureEntry {
  messageId:       string
  /** The accountable Claude manager (agent_kind → registry label). */
  managerKey:      ManagerKey | "unknown"
  managerLabel:    string
  audience:        string
  channel:         string
  recipientContactId: string | null
  recipientName:   string | null
  subject:         string | null
  status:          string  // proposed | approved | sent | rejected | failed
  proposedAt:      string | null
  approvedBy:      string | null   // users.id of the human approver (the oversight proof)
  approvedAt:      string | null
  sentAt:          string | null
  /** Was the recipient suppressible on this channel at report time? (consent snapshot) */
  channelAllowedNow: boolean | null
  suppressionReason: string | null
}

export interface AiDisclosureLedger {
  brokerageId: string
  since:       string
  until:       string
  entries:     AiDisclosureEntry[]
  summary: {
    total:        number
    sent:         number
    rejected:     number
    failed:       number
    awaitingHuman: number  // proposed/approved, not yet sent
    /** Sent WITHOUT a recorded human approver — should always be 0 (governance proof). */
    sentWithoutApprover: number
    byManager:    Array<{ manager: ManagerKey | "unknown"; label: string; count: number }>
  }
}

export interface AiDisclosureLedgerParams {
  brokerageId: string
  /** Inclusive lower bound on proposed_at (ISO). Defaults to 30 days ago. */
  sinceIso?: string
  /** Exclusive upper bound on proposed_at (ISO). Defaults to now. */
  untilIso?: string
  limit?: number
}

export async function generateAiDisclosureLedger(
  params: AiDisclosureLedgerParams,
  client?: ReturnType<typeof createServiceClient>,
): Promise<AiDisclosureLedger> {
  const supabase = client ?? createServiceClient()
  const since = params.sinceIso ?? new Date(Date.now() - 30 * 86_400_000).toISOString()
  const until = params.untilIso ?? new Date().toISOString()
  const limit = params.limit ?? 1000

  const { data: rows } = await supabase
    .from("agent_client_messages")
    .select("id, agent_kind, audience, channel, recipient_contact_id, subject, status, proposed_at, approved_by, approved_at, sent_at")
    .eq("brokerage_id", params.brokerageId)
    .gte("proposed_at", since).lt("proposed_at", until)
    .order("proposed_at", { ascending: false })
    .limit(limit)

  const messages = (rows ?? []) as Array<{
    id: string; agent_kind: string | null; audience: string; channel: string | null
    recipient_contact_id: string | null; subject: string | null; status: string
    proposed_at: string | null; approved_by: string | null; approved_at: string | null; sent_at: string | null
  }>

  // Batch-load recipient names + consent state for the snapshot (one query).
  const contactIds = Array.from(new Set(messages.map((m) => m.recipient_contact_id).filter(Boolean))) as string[]
  const contactMap = new Map<string, any>()
  if (contactIds.length > 0) {
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id, first_name, last_name, tcpa_consent, dnc_status, email_opt_out, email_unsubscribed, sms_opt_out, sms_unsubscribed, phone_opt_out, opt_out_channels")
      .in("id", contactIds)
    for (const c of (contacts ?? []) as any[]) contactMap.set(c.id, c)
  }

  const entries: AiDisclosureEntry[] = messages.map((m) => {
    const key = (m.agent_kind && m.agent_kind in MANAGERS ? m.agent_kind : "unknown") as ManagerKey | "unknown"
    const contact = m.recipient_contact_id ? contactMap.get(m.recipient_contact_id) : null
    const name = contact ? [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim() || null : null
    let channelAllowedNow: boolean | null = null
    let suppressionReason: string | null = null
    if (contact && (m.channel === "email" || m.channel === "sms" || m.channel === "voice_drop")) {
      const g = canDispatchToContact(contact, m.channel as DispatchChannel)
      channelAllowedNow = g.allowed
      suppressionReason = g.allowed ? null : g.reason ?? null
    } else if (m.channel === "portal" || m.channel === "portal_push") {
      channelAllowedNow = true
    }
    return {
      messageId: m.id,
      managerKey: key,
      managerLabel: key === "unknown" ? "Unassigned" : MANAGERS[key].label,
      audience: m.audience,
      channel: m.channel ?? "portal",
      recipientContactId: m.recipient_contact_id,
      recipientName: name,
      subject: m.subject,
      status: m.status,
      proposedAt: m.proposed_at,
      approvedBy: m.approved_by,
      approvedAt: m.approved_at,
      sentAt: m.sent_at,
      channelAllowedNow,
      suppressionReason,
    }
  })

  const byManagerMap = new Map<ManagerKey | "unknown", { manager: ManagerKey | "unknown"; label: string; count: number }>()
  for (const e of entries) {
    const cur = byManagerMap.get(e.managerKey) ?? { manager: e.managerKey, label: e.managerLabel, count: 0 }
    cur.count += 1
    byManagerMap.set(e.managerKey, cur)
  }

  return {
    brokerageId: params.brokerageId,
    since, until,
    entries,
    summary: {
      total: entries.length,
      sent: entries.filter((e) => e.status === "sent").length,
      rejected: entries.filter((e) => e.status === "rejected").length,
      failed: entries.filter((e) => e.status === "failed").length,
      awaitingHuman: entries.filter((e) => e.status === "proposed" || e.status === "approved").length,
      sentWithoutApprover: entries.filter((e) => e.status === "sent" && !e.approvedBy).length,
      byManager: Array.from(byManagerMap.values()).sort((a, b) => b.count - a.count),
    },
  }
}
