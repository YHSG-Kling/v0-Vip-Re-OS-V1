"use server"

// app/actions/superadmin/support-console.ts
// ─────────────────────────────────────────────────────────────────────────────
// Cross-tenant SUPPORT CONSOLE for platform staff (superadmin + support). Lets them actually RESPOND to any
// tenant's tickets: a queue with tenant identity + first-response SLA flag, a ticket thread, a reply that
// notifies the tenant, assignment, and status. Every ticket carries the brokerage name so a staffer knows
// whose ticket it is.

import { headers } from "next/headers"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { postTicketReply, loadTicketThread, awaitingFirstResponse, type TicketThread } from "@/lib/support/support-thread"
import { evaluateTicketSla, rollupCsat, type SlaBreachKind } from "@/lib/support/support-sla"

const STAFF_ROLES = new Set(["superadmin", "support"])

/**
 * THE LANE THIS CONSOLE ANSWERS, AND THE ONLY ONE IT MAY TOUCH.
 *
 * Owner ruling: a user_to_brokerage ticket is "agents and vendors support ticket
 * to the brokerage office staff" — the platform is NOT a party to it. Before
 * support_tickets carried a lane this console listed and acted on EVERY ticket in
 * the database, so a platform staffer read, replied inside, assigned and closed
 * conversations between a brokerage and its own agents.
 *
 * RLS still lets platform staff REACH a lane 2 row (public.is_platform_staff() is
 * the first branch of can_access_support_ticket, carried through unchanged from the
 * superseded policies) — that door is deliberately left for break-glass. This is the
 * product deciding not to walk through it by accident.
 */
const CONSOLE_LANE = "tenant_to_platform"

/** Resolve a ticket this console is allowed to act on, or say why not. */
async function requireConsoleTicket(
  svc: ReturnType<typeof createServiceClient>,
  ticketId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await svc.from("support_tickets").select("id, lane").eq("id", ticketId).maybeSingle()
  // supabase-js RESOLVES a refused read. Without this the refusal reads as
  // "Ticket not found" and a platform staffer is told the ticket does not exist.
  if (error) return { ok: false, error: `Could not read the ticket: ${error.message}` }
  if (!data) return { ok: false, error: "Ticket not found" }
  if ((data as { lane?: string | null }).lane !== CONSOLE_LANE) {
    return { ok: false, error: "That ticket belongs to a brokerage's own office queue — the platform is not a party to it" }
  }
  return { ok: true }
}

// Audit — staff mutations on ANOTHER tenant's ticket land in superadmin_audit_log
// (same conventions as coupons/brokerage-management: non-fatal, never blocks).
async function audit(actorUserId: string, action: string, ticketId: string, details: Record<string, unknown>): Promise<void> {
  try {
    const svc = createServiceClient()
    const hdrs = await headers()
    const { data: actor } = await svc.from("users").select("email").eq("id", actorUserId).maybeSingle()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: actorUserId,
      actor_email: (actor as any)?.email ?? null,
      action,
      target_type: "support_ticket",
      target_id: ticketId,
      details,
      ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"),
      user_agent: hdrs.get("user-agent"),
    })
  } catch (err) {
    console.error("[support-console audit] write failed:", err)
  }
}

async function requireStaff(): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data } = await supabase.from("users").select("user_type, platform_role").eq("id", user.id).maybeSingle()
  const isStaff = STAFF_ROLES.has((data as any)?.user_type) || STAFF_ROLES.has((data as any)?.platform_role)
  if (!isStaff) return { ok: false, error: "Forbidden — platform support only" }
  return { ok: true, userId: user.id }
}

export interface SupportQueueRow {
  id: string
  brokerageId: string | null
  brokerageName: string | null
  subject: string | null
  status: string
  priority: string | null
  category: string | null
  assignedTo: string | null
  awaitingFirstResponse: boolean
  /** SLA breaches active right now (priority-based deadlines, lib/support/support-sla). */
  slaBreaches: SlaBreachKind[]
  slaAtRisk: boolean
  satisfactionRating: number | null
  createdAt: string
  updatedAt: string
}

export async function listAllTicketsAction(filter?: { status?: string }): Promise<
  | { ok: true; rows: SupportQueueRow[]; counts: Record<string, number>; awaiting: number; breached: number; csatAverage: number | null; csatRated: number }
  | { ok: false; error: string }
> {
  const auth = await requireStaff()
  if (!auth.ok) return auth
  const svc = createServiceClient()

  let q = svc.from("support_tickets").select("id, brokerage_id, lane, subject, status, priority, category, assigned_to, first_response_at, resolved_at, satisfaction_rating, created_at, updated_at")
    // THE LANE FILTER. Without it this queue is every brokerage's internal support
    // conversation as well as the platform's own, and the SLA/CSAT rollups below
    // are computed over work the platform does not owe.
    .eq("lane", CONSOLE_LANE)
    .order("updated_at", { ascending: false }).limit(500)
  if (filter?.status) q = q.eq("status", filter.status)
  const { data: tickets, error: qErr } = await q
  // An unchecked read here renders the platform's entire support queue as "no
  // tickets" whenever the query is refused — the emptiest possible lie.
  if (qErr) return { ok: false, error: qErr.message }

  const rows0 = (tickets ?? []) as any[]
  const brokerageIds = Array.from(new Set(rows0.map((t) => t.brokerage_id).filter(Boolean)))
  const nameById = new Map<string, string>()
  if (brokerageIds.length) {
    const { data: brks, error: bErr } = await svc.from("brokerages").select("id, name").in("id", brokerageIds)
    if (bErr) console.error("[support-console] brokerage names read refused:", bErr.message)
    for (const b of (brks ?? []) as any[]) nameById.set(b.id, b.name)
  }

  const counts: Record<string, number> = { open: 0, in_progress: 0, resolved: 0, closed: 0 }
  let awaiting = 0
  let breached = 0
  const rows: SupportQueueRow[] = rows0.map((t) => {
    counts[t.status] = (counts[t.status] ?? 0) + 1
    const aw = awaitingFirstResponse({ status: t.status, first_response_at: t.first_response_at })
    if (aw) awaiting += 1
    const sla = evaluateTicketSla(t)
    if (sla.breaches.length > 0) breached += 1
    return {
      id: t.id, brokerageId: t.brokerage_id, brokerageName: t.brokerage_id ? nameById.get(t.brokerage_id) ?? null : null,
      subject: t.subject, status: t.status, priority: t.priority, category: t.category, assignedTo: t.assigned_to,
      awaitingFirstResponse: aw, slaBreaches: sla.breaches, slaAtRisk: sla.atRisk,
      satisfactionRating: t.satisfaction_rating ?? null,
      createdAt: t.created_at, updatedAt: t.updated_at,
    }
  })
  const csat = rollupCsat(rows0.map((t) => ({ satisfaction_rating: t.satisfaction_rating ?? null })))
  return { ok: true, rows, counts, awaiting, breached, csatAverage: csat.average, csatRated: csat.rated }
}

export async function getTicketThreadAction(ticketId: string): Promise<{ ok: true; thread: TicketThread } | { ok: false; error: string }> {
  const auth = await requireStaff()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const lane = await requireConsoleTicket(svc, ticketId)
  if (!lane.ok) return lane
  const thread = await loadTicketThread(svc, ticketId)
  if (!thread) return { ok: false, error: "Ticket not found" }
  return { ok: true, thread }
}

export async function replyToTicketAction(params: { ticketId: string; body: string }): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireStaff()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const lane = await requireConsoleTicket(svc, params.ticketId)
  if (!lane.ok) return lane
  const r = await postTicketReply(svc, { ticketId: params.ticketId, authorUserId: auth.userId, authorKind: "staff", body: params.body })
  if (!r.ok) return { ok: false, error: r.error }
  await audit(auth.userId, "support_ticket.staff_replied", params.ticketId, { bodyLength: params.body.length })
  revalidatePath(`/dashboard/superadmin/support/${params.ticketId}`)
  revalidatePath("/dashboard/superadmin/support")
  return { ok: true }
}

export async function assignTicketAction(params: { ticketId: string; assigneeUserId: string | null }): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireStaff()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const lane = await requireConsoleTicket(svc, params.ticketId)
  if (!lane.ok) return lane
  const assignee = params.assigneeUserId ?? auth.userId
  // `.select("id")` + a length check: a zero-row refusal is error:null, so an
  // unchecked update reports an assignment that never happened.
  const { data: rows, error } = await svc.from("support_tickets").update({ assigned_to: assignee, updated_at: new Date().toISOString() }).eq("id", params.ticketId).select("id")
  if (error) return { ok: false, error: error.message }
  if ((rows?.length ?? 0) === 0) return { ok: false, error: "Ticket not found" }
  await audit(auth.userId, "support_ticket.assigned", params.ticketId, { assigneeUserId: assignee })
  revalidatePath(`/dashboard/superadmin/support/${params.ticketId}`)
  return { ok: true }
}

export async function setTicketStatusAction(params: { ticketId: string; status: "open" | "in_progress" | "resolved" | "closed" }): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireStaff()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const lane = await requireConsoleTicket(svc, params.ticketId)
  if (!lane.ok) return lane
  const patch: Record<string, unknown> = { status: params.status, updated_at: new Date().toISOString() }
  if (params.status === "resolved" || params.status === "closed") patch.resolved_at = new Date().toISOString()
  else patch.resolved_at = null
  const { data: rows, error } = await svc.from("support_tickets").update(patch).eq("id", params.ticketId).select("id")
  if (error) return { ok: false, error: error.message }
  if ((rows?.length ?? 0) === 0) return { ok: false, error: "Ticket not found" }
  await audit(auth.userId, "support_ticket.status_changed", params.ticketId, { status: params.status })
  revalidatePath(`/dashboard/superadmin/support/${params.ticketId}`)
  revalidatePath("/dashboard/superadmin/support")
  return { ok: true }
}
