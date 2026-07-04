"use server"

// app/actions/superadmin/support-console.ts
// ─────────────────────────────────────────────────────────────────────────────
// Cross-tenant SUPPORT CONSOLE for platform staff (superadmin + support). Lets them actually RESPOND to any
// tenant's tickets: a queue with tenant identity + first-response SLA flag, a ticket thread, a reply that
// notifies the tenant, assignment, and status. Every ticket carries the brokerage name so a staffer knows
// whose ticket it is.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { postTicketReply, loadTicketThread, awaitingFirstResponse, type TicketThread } from "@/lib/support/support-thread"

const STAFF_ROLES = new Set(["superadmin", "support"])

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
  createdAt: string
  updatedAt: string
}

export async function listAllTicketsAction(filter?: { status?: string }): Promise<
  | { ok: true; rows: SupportQueueRow[]; counts: Record<string, number>; awaiting: number }
  | { ok: false; error: string }
> {
  const auth = await requireStaff()
  if (!auth.ok) return auth
  const svc = createServiceClient()

  let q = svc.from("support_tickets").select("id, brokerage_id, subject, status, priority, category, assigned_to, first_response_at, created_at, updated_at").order("updated_at", { ascending: false }).limit(500)
  if (filter?.status) q = q.eq("status", filter.status)
  const { data: tickets } = await q

  const rows0 = (tickets ?? []) as any[]
  const brokerageIds = Array.from(new Set(rows0.map((t) => t.brokerage_id).filter(Boolean)))
  const nameById = new Map<string, string>()
  if (brokerageIds.length) {
    const { data: brks } = await svc.from("brokerages").select("id, name").in("id", brokerageIds)
    for (const b of (brks ?? []) as any[]) nameById.set(b.id, b.name)
  }

  const counts: Record<string, number> = { open: 0, in_progress: 0, resolved: 0, closed: 0 }
  let awaiting = 0
  const rows: SupportQueueRow[] = rows0.map((t) => {
    counts[t.status] = (counts[t.status] ?? 0) + 1
    const aw = awaitingFirstResponse({ status: t.status, first_response_at: t.first_response_at })
    if (aw) awaiting += 1
    return {
      id: t.id, brokerageId: t.brokerage_id, brokerageName: t.brokerage_id ? nameById.get(t.brokerage_id) ?? null : null,
      subject: t.subject, status: t.status, priority: t.priority, category: t.category, assignedTo: t.assigned_to,
      awaitingFirstResponse: aw, createdAt: t.created_at, updatedAt: t.updated_at,
    }
  })
  return { ok: true, rows, counts, awaiting }
}

export async function getTicketThreadAction(ticketId: string): Promise<{ ok: true; thread: TicketThread } | { ok: false; error: string }> {
  const auth = await requireStaff()
  if (!auth.ok) return auth
  const thread = await loadTicketThread(createServiceClient(), ticketId)
  if (!thread) return { ok: false, error: "Ticket not found" }
  return { ok: true, thread }
}

export async function replyToTicketAction(params: { ticketId: string; body: string }): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireStaff()
  if (!auth.ok) return auth
  const r = await postTicketReply(createServiceClient(), { ticketId: params.ticketId, authorUserId: auth.userId, authorKind: "staff", body: params.body })
  if (!r.ok) return { ok: false, error: r.error }
  revalidatePath(`/dashboard/superadmin/support/${params.ticketId}`)
  revalidatePath("/dashboard/superadmin/support")
  return { ok: true }
}

export async function assignTicketAction(params: { ticketId: string; assigneeUserId: string | null }): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireStaff()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { error } = await svc.from("support_tickets").update({ assigned_to: params.assigneeUserId ?? auth.userId, updated_at: new Date().toISOString() }).eq("id", params.ticketId)
  if (error) return { ok: false, error: error.message }
  revalidatePath(`/dashboard/superadmin/support/${params.ticketId}`)
  return { ok: true }
}

export async function setTicketStatusAction(params: { ticketId: string; status: "open" | "in_progress" | "resolved" | "closed" }): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireStaff()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const patch: Record<string, unknown> = { status: params.status, updated_at: new Date().toISOString() }
  if (params.status === "resolved" || params.status === "closed") patch.resolved_at = new Date().toISOString()
  else patch.resolved_at = null
  const { error } = await svc.from("support_tickets").update(patch).eq("id", params.ticketId)
  if (error) return { ok: false, error: error.message }
  revalidatePath(`/dashboard/superadmin/support/${params.ticketId}`)
  revalidatePath("/dashboard/superadmin/support")
  return { ok: true }
}
