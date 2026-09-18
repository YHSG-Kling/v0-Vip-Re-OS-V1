// lib/support/support-thread.ts
//
// SUPPORT TICKET THREAD — the two-way conversation the support system was missing. A ticket used to be a
// subject + description + status enum: a tenant submitted, a staffer flipped a status the tenant never saw,
// and nobody was notified. This adds a real thread (support_ticket_messages) + reply posting that stamps
// first-response, bumps the ticket, and NOTIFIES the other side (staff reply → the tenant; tenant reply →
// platform staff). Reused by the platform support console AND the tenant help UI so both sides stay on the
// same page.

import { createServiceClient } from "@/lib/supabase/service"
import { notifyPlatformStaff } from "@/lib/notifications/platform-staff"
import { ticketAnsweredBy } from "@/lib/support/ticket-constants"

type Svc = ReturnType<typeof createServiceClient>
export type AuthorKind = "staff" | "tenant"

export interface TicketMessage {
  id: string
  ticketId: string
  authorUserId: string | null
  authorKind: AuthorKind
  body: string
  createdAt: string
}

/** PURE: is this ticket still awaiting the first staff reply? (SLA signal for the queue.) */
export function awaitingFirstResponse(ticket: { status: string; first_response_at: string | null }): boolean {
  return (ticket.status === "open" || ticket.status === "in_progress") && !ticket.first_response_at
}

export interface PostReplyResult { ok: boolean; error?: string; messageId?: string }

/**
 * Post a reply to a ticket thread + notify the other side. authorKind='staff' means a platform support
 * user (stamps first_response_at, notifies the tenant); 'tenant' means the ticket's own agent (notifies
 * platform staff). Best-effort notifications never block the reply.
 */
export async function postTicketReply(
  svc: Svc,
  params: { ticketId: string; authorUserId: string | null; authorKind: AuthorKind; body: string },
): Promise<PostReplyResult> {
  const body = params.body?.trim()
  if (!body) return { ok: false, error: "Message body is required" }

  // `error` destructured: supabase-js RESOLVES a refused read, so `{ data }` alone
  // reports "permission denied" as "Ticket not found" — one sentence for two
  // entirely different failures, and only one of them is the caller's fault.
  const { data: ticket, error: readErr } = await svc.from("support_tickets")
    .select("id, brokerage_id, agent_id, lane, submitted_by_user_id, subject, first_response_at, status")
    .eq("id", params.ticketId).maybeSingle()
  if (readErr) return { ok: false, error: `Could not read the ticket: ${readErr.message}` }
  if (!ticket) return { ok: false, error: "Ticket not found" }

  const { data: msg, error } = await svc.from("support_ticket_messages")
    .insert({ ticket_id: params.ticketId, author_user_id: params.authorUserId, author_kind: params.authorKind, body })
    .select("id").single()
  if (error || !msg) return { ok: false, error: error?.message ?? "insert failed" }

  // Stamp first staff response + keep the ticket fresh in the queue.
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (params.authorKind === "staff" && !(ticket as any).first_response_at) patch.first_response_at = new Date().toISOString()
  if (params.authorKind === "staff" && (ticket as any).status === "open") patch.status = "in_progress"
  await svc.from("support_tickets").update(patch).eq("id", params.ticketId).then(undefined, () => {})

  // ── NOTIFY THE OTHER SIDE, AND WHO THAT IS DEPENDS ON THE LANE ─────────────
  // Before support_tickets carried a lane, an asking-side reply ALWAYS alerted
  // platform staff. On a user_to_brokerage ticket that paged the platform about
  // a conversation it is not a party to, and never told the brokerage's own office
  // — the side that actually answers it.
  const lane = String((ticket as any).lane ?? "")
  const brokerageId = (ticket as any).brokerage_id as string | null
  try {
    if (params.authorKind === "staff") {
      // The ANSWERING side replied → tell the SUBMITTER. submitted_by_user_id
      // first: it is set for every class of tenant user, where agent_id resolves
      // only for users holding an agents row.
      let uid = (ticket as any).submitted_by_user_id as string | null
      if (!uid && (ticket as any).agent_id) {
        const { data: ag, error: agErr } = await svc.from("agents").select("user_id").eq("id", (ticket as any).agent_id).maybeSingle()
        if (agErr) console.error("[support-thread] agent read refused:", agErr.message)
        uid = ((ag as any)?.user_id as string | null) ?? null
      }
      if (uid) {
        await svc.from("notifications").insert({
          user_id: uid, brokerage_id: brokerageId, type: "support_reply",
          title: "Support replied to your ticket", body: `“${(ticket as any).subject ?? "Your ticket"}” — ${body.slice(0, 180)}`,
          entity_type: "support_ticket", entity_id: params.ticketId, priority: "medium", is_read: false,
        }).then(undefined, () => {})
      }
    } else if (ticketAnsweredBy(lane) === "brokerage_office" && brokerageId) {
      // Lane 2 asking side → the BROKERAGE's own office staff. Never the platform.
      const { notifyBrokerageAdmins } = await import("@/lib/notifications/brokerage-admins")
      await notifyBrokerageAdmins(svc as any, brokerageId, {
        type: "support_ticket_reply", title: `Ticket reply: ${(ticket as any).subject ?? "Support ticket"}`,
        body: body.slice(0, 400), entityType: "support_ticket", entityId: params.ticketId, priority: "high",
      })
    } else {
      // Lane 1 asking side (the tenant) → platform staff. Unchanged.
      await notifyPlatformStaff(svc as any, {
        type: "support_ticket_reply", title: `Ticket reply: ${(ticket as any).subject ?? "Support ticket"}`,
        body: body.slice(0, 400), entityType: "support_ticket", entityId: params.ticketId, priority: "high",
      })
    }
  } catch { /* best-effort */ }

  return { ok: true, messageId: (msg as any).id }
}

export interface TicketThread {
  id: string
  /** Which conversation this is — see TICKET_LANES. Decides who answers it. */
  lane: string
  brokerageId: string | null
  brokerageName: string | null
  subject: string | null
  description: string | null
  status: string
  priority: string | null
  category: string | null
  assignedTo: string | null
  firstResponseAt: string | null
  resolvedAt: string | null
  createdAt: string
  requesterName: string | null
  satisfactionRating: number | null
  messages: TicketMessage[]
}

/** Load a ticket with its brokerage identity, requester name, and full message thread. */
export async function loadTicketThread(svc: Svc, ticketId: string): Promise<TicketThread | null> {
  const { data: t, error: tErr } = await svc.from("support_tickets")
    .select("id, brokerage_id, agent_id, lane, subject, description, status, priority, category, assigned_to, first_response_at, resolved_at, created_at, satisfaction_rating")
    .eq("id", ticketId).maybeSingle()
  if (tErr) { console.error("[support-thread] loadTicketThread refused:", tErr.message); return null }
  if (!t) return null
  const tk = t as any

  const [{ data: brk }, { data: msgs }, agentRow] = await Promise.all([
    tk.brokerage_id ? svc.from("brokerages").select("name").eq("id", tk.brokerage_id).maybeSingle() : Promise.resolve({ data: null }),
    svc.from("support_ticket_messages").select("id, ticket_id, author_user_id, author_kind, body, created_at").eq("ticket_id", ticketId).order("created_at", { ascending: true }).limit(500),
    tk.agent_id ? svc.from("agents").select("users(first_name, last_name)").eq("id", tk.agent_id).maybeSingle() : Promise.resolve({ data: null }),
  ])
  const u = (agentRow.data as any)?.users
  const uu = Array.isArray(u) ? u[0] : u

  return {
    id: tk.id, lane: String(tk.lane ?? ""), brokerageId: tk.brokerage_id, brokerageName: (brk as any)?.name ?? null,
    subject: tk.subject, description: tk.description, status: tk.status, priority: tk.priority, category: tk.category,
    assignedTo: tk.assigned_to, firstResponseAt: tk.first_response_at, resolvedAt: tk.resolved_at, createdAt: tk.created_at,
    requesterName: uu ? [uu.first_name, uu.last_name].filter(Boolean).join(" ") || null : null,
    satisfactionRating: tk.satisfaction_rating ?? null,
    messages: ((msgs ?? []) as any[]).map((m) => ({ id: m.id, ticketId: m.ticket_id, authorUserId: m.author_user_id, authorKind: m.author_kind, body: m.body, createdAt: m.created_at })),
  }
}
