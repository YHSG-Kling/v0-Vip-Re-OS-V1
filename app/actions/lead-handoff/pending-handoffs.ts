"use server"

// app/actions/lead-handoff/pending-handoffs.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE AGENT'S FIRST-TOUCH HEADS-UP — the READ half of the acknowledgement.
//
// OWNER RULING, verbatim: "their needs to be an agent side first touch
// acknolegement becaue the agent needs a heads up that a new contact has been
// added and contact welcome package sent."
//
// `acknowledgeLeadHandoffAction` (app/actions/lead-assignment/assign-lead.ts)
// is the WRITE half and already existed — with no caller anywhere. It flips
// `assignment_log.claimed` false → true, the flag three live surfaces read as
// "this handoff is still awaiting first touch"
// (lib/intelligence/daily-briefing-generator.ts, lib/intelligence/isa-overnight.ts
// `handoffs_unclaimed`, lib/intelligence/user-type-briefs/team-lead.ts). Without
// a surface those counters could only ever go UP. This module is the read that
// makes them go down.
//
// ── AGENTS SEE CONTACTS, NEVER LEAD ROWS ────────────────────────────────────
//
// The handoff ledger is keyed by `lead_id`, and the standing access ruling says
// an agent works the CONTACT a lead became, never the lead row. So this module
// touches `leads` for EXACTLY ONE COLUMN — `contact_id`, the bridge — and no
// lead field reaches the browser. What is returned is contact-shaped: the
// person's name, type, channel and when they were added.
//
// `handoffLeadId` IS returned, because it is the argument
// `acknowledgeLeadHandoffAction(leadId)` takes and that signature is not ours to
// change. It is an OPAQUE ACKNOWLEDGEMENT HANDLE, never rendered and never a
// lead field; and it grants nothing on its own — the acknowledge action re-reads
// the session and re-proves the caller is the assigned agent (or a tenant admin)
// before it writes.
//
// ── THE WELCOME PACKAGE CLAIM IS MEASURED, NOT ASSUMED ──────────────────────
//
// The ruling says the heads-up mentions the welcome package. This module
// REFUSES to assert a send it has not seen. `ensureClientWelcome`
// (lib/kernel/client-welcome.ts) does NOT send anything: it PROPOSES one gated
// draft on `agent_client_messages` via proposeClientMessage, tagged
// `WELCOME_RATIONALE_TAG` — imported here so the reader and the writer can never
// drift apart. That table carries the real lifecycle
// (status proposed|approved|sent|rejected|failed + sent_at, m189), and it is the
// ONLY evidence a welcome was ever produced. So the state reported per contact
// is whatever that ledger actually says, including "none_on_record" when there
// is no row at all. Nothing here prints "sent" unless `status = 'sent'`.
//
// EVERY EXPORT IN A "use server" FILE IS A PUBLIC HTTP ENDPOINT. The one export
// below takes NO caller-supplied scope: identity, brokerage and agents row are
// all re-resolved from the session and the database.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { WELCOME_RATIONALE_TAG } from "@/lib/kernel/client-welcome"

/**
 * What the welcome ledger ACTUALLY says. These map 1:1 onto
 * agent_client_messages.status, plus the honest fourth answer — no row.
 */
export type WelcomePackageState =
  | "sent"
  | "approved_not_sent"
  | "drafted_awaiting_approval"
  | "send_failed"
  | "rejected"
  | "none_on_record"

export interface PendingHandoffWelcome {
  state: WelcomePackageState
  /** agent_client_messages.sent_at — populated ONLY when state === "sent". */
  sentAt: string | null
  /** agent_client_messages.approved_at, when a human has approved the draft. */
  approvedAt: string | null
  /** agent_client_messages.proposed_at — when the draft was written. */
  proposedAt: string | null
  /** portal | email | sms | direct_mail — the rail the draft was written for. */
  channel: string | null
  subject: string | null
  /** agent_client_messages.send_error, when state === "send_failed". */
  error: string | null
}

export interface PendingHandoff {
  /**
   * OPAQUE ACKNOWLEDGEMENT HANDLE — the only argument
   * `acknowledgeLeadHandoffAction` accepts. NOT a lead field and never rendered.
   */
  handoffLeadId: string
  /** The CONTACT the lead became (leads.contact_id). This is what an agent works. */
  contactId: string
  contactName: string
  contactType: string | null
  email: string | null
  phone: string | null
  preferredChannel: string | null
  /** assignment_log.created_at — when the handoff landed. */
  assignedAt: string | null
  /** assignment_log.assignment_method — how it was routed (auto vs by hand). */
  assignmentMethod: string | null
  welcome: PendingHandoffWelcome
}

export type PendingHandoffsResult =
  | { ok: true; handoffs: PendingHandoff[] }
  | { ok: false; reason: string }

/**
 * The caller's OWN unacknowledged handoffs — nobody else's.
 *
 * `agents.id` and `users.id` are DISJOINT id spaces. `assignment_log.agent_id`
 * FKs agents(id) while the session gives us a users(id), so the caller's agents
 * row is resolved through `agents.user_id`. A caller with no agents row (a pure
 * admin seat) gets an EMPTY list rather than the whole tenant's handoffs: this
 * surface exists for the ruling's "agent side" first touch, and showing a
 * colleague's pending handoff here would invite acknowledging it for them.
 *
 * Reads run on the service client because `assignment_log` is a brokerage-desk
 * ledger, not an agent-readable table — so every query below carries BOTH an
 * explicit `brokerage_id` filter AND the caller's own resolved `agents.id`.
 * supabase-js RESOLVES refusals, so every read is destructured and every error
 * fails CLOSED.
 */
export async function listMyPendingHandoffsAction(): Promise<PendingHandoffsResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) return { ok: false, reason: "Unauthorized" }

  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (profileError) return { ok: false, reason: "Could not verify your account" }
  if (!profile?.brokerage_id) return { ok: false, reason: "No brokerage found for your account" }
  const brokerageId = profile.brokerage_id as string

  const svc = createServiceClient()

  // WHO AM I, in agents-space. Crossing users.id into an agents.id column is the
  // 23503 this repo has paid for before.
  const { data: me, error: meError } = await svc
    .from("agents")
    .select("id")
    .eq("user_id", user.id)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (meError) return { ok: false, reason: "Could not verify your agent record" }
  if (!me?.id) return { ok: true, handoffs: [] }

  // THE LEDGER: handoffs to me that nobody has acknowledged yet.
  const { data: logRows, error: logError } = await svc
    .from("assignment_log")
    .select("id, lead_id, created_at, assignment_method")
    .eq("brokerage_id", brokerageId)
    .eq("agent_id", me.id)
    .eq("claimed", false)
    .order("created_at", { ascending: false })
    .limit(25)
  if (logError) return { ok: false, reason: "Could not read your handoffs" }
  if (!logRows?.length) return { ok: true, handoffs: [] }

  const leadIds = logRows.map((r) => r.lead_id).filter(Boolean) as string[]
  if (!leadIds.length) return { ok: true, handoffs: [] }

  // THE BRIDGE, AND ONLY THE BRIDGE. `contact_id` is the single lead column this
  // module reads; `agent_id` is re-checked so the ledger and the lead must agree
  // on whose handoff this is. Neither value is a lead FIELD and neither is
  // returned.
  const { data: leadRows, error: leadError } = await svc
    .from("leads")
    .select("id, contact_id, agent_id")
    .eq("brokerage_id", brokerageId)
    .in("id", leadIds)
  if (leadError) return { ok: false, reason: "Could not resolve your handoffs" }

  const leadToContact = new Map<string, string>()
  for (const l of leadRows ?? []) {
    if (l.agent_id !== me.id) continue // ledger/lead disagree — not mine to see
    if (!l.contact_id) continue // not converted yet: there is no contact to show
    leadToContact.set(l.id as string, l.contact_id as string)
  }
  if (!leadToContact.size) return { ok: true, handoffs: [] }

  const contactIds = [...new Set(leadToContact.values())]

  const { data: contactRows, error: contactError } = await svc
    .from("contacts")
    .select("id, first_name, last_name, preferred_name, email, phone, contact_type, preferred_channel")
    .eq("brokerage_id", brokerageId)
    .in("id", contactIds)
  if (contactError) return { ok: false, reason: "Could not read those contacts" }

  const contactById = new Map<string, Record<string, unknown>>()
  for (const c of contactRows ?? []) contactById.set(c.id as string, c as Record<string, unknown>)

  // THE WELCOME EVIDENCE. Same tag `ensureClientWelcome` writes and dedupes on,
  // imported rather than retyped. Newest first so the freshest row wins per
  // contact — a resend would leave more than one.
  const { data: welcomeRows, error: welcomeError } = await svc
    .from("agent_client_messages")
    .select("id, recipient_contact_id, status, sent_at, approved_at, proposed_at, channel, subject, send_error")
    .eq("brokerage_id", brokerageId)
    .in("recipient_contact_id", contactIds)
    .ilike("rationale", `${WELCOME_RATIONALE_TAG}%`)
    .order("proposed_at", { ascending: false })
  // A refused welcome read must NOT silently become "no welcome package" — that
  // is the exact false claim this module exists to avoid. It fails the whole
  // call instead.
  if (welcomeError) return { ok: false, reason: "Could not verify the welcome package" }

  const welcomeByContact = new Map<string, PendingHandoffWelcome>()
  for (const w of welcomeRows ?? []) {
    const cid = w.recipient_contact_id as string | null
    if (!cid || welcomeByContact.has(cid)) continue
    welcomeByContact.set(cid, {
      state: mapWelcomeState(w.status as string | null),
      sentAt: (w.sent_at as string | null) ?? null,
      approvedAt: (w.approved_at as string | null) ?? null,
      proposedAt: (w.proposed_at as string | null) ?? null,
      channel: (w.channel as string | null) ?? null,
      subject: (w.subject as string | null) ?? null,
      error: (w.send_error as string | null) ?? null,
    })
  }

  const handoffs: PendingHandoff[] = []
  for (const row of logRows) {
    const contactId = leadToContact.get(row.lead_id as string)
    if (!contactId) continue
    const c = contactById.get(contactId)
    if (!c) continue

    const name =
      [c.preferred_name ?? c.first_name, c.last_name].filter(Boolean).join(" ").trim() ||
      "Unnamed contact"

    handoffs.push({
      handoffLeadId: row.lead_id as string,
      contactId,
      contactName: name,
      contactType: (c.contact_type as string | null) ?? null,
      email: (c.email as string | null) ?? null,
      phone: (c.phone as string | null) ?? null,
      preferredChannel: (c.preferred_channel as string | null) ?? null,
      assignedAt: (row.created_at as string | null) ?? null,
      assignmentMethod: (row.assignment_method as string | null) ?? null,
      welcome:
        welcomeByContact.get(contactId) ?? {
          // NO ROW = NO CLAIM. This is the honest answer, not a failure.
          state: "none_on_record",
          sentAt: null,
          approvedAt: null,
          proposedAt: null,
          channel: null,
          subject: null,
          error: null,
        },
    })
  }

  return { ok: true, handoffs }
}

/** agent_client_messages.status → the state this surface is willing to print. */
function mapWelcomeState(status: string | null): WelcomePackageState {
  switch (status) {
    case "sent":
      return "sent"
    case "approved":
      return "approved_not_sent"
    case "proposed":
      return "drafted_awaiting_approval"
    case "failed":
      return "send_failed"
    case "rejected":
      return "rejected"
    default:
      // An unknown status is not evidence of a send.
      return "none_on_record"
  }
}
