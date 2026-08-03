"use server"

/**
 * app/actions/support.ts
 *
 * User support on the platform. The tables existed (support_tickets — written only
 * by the onboarding-escalation path — knowledge_articles, help_topics_kb) but there
 * was no user-facing surface: no way to raise a ticket, see its status, browse help,
 * or for a broker/admin to triage the queue. This wires that loop to the live tables.
 *
 * Constraints honored (live CHECKs):
 *   support_tickets.status   ∈ open | in_progress | resolved | closed
 *   support_tickets.priority ∈ low | medium | high | urgent
 *   knowledge_articles.status ∈ draft | published | archived
 *
 * Identity is resolved server-side via getAgentContext. Ticket writes set
 * agent_id = agents.id (FK) and brokerage_id from the caller's context.
 */

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity"
// Constants + types live in a non-"use server" module so clients can import them
// directly (a "use server" file may only export async functions).
import {
  TICKET_STATUSES, TICKET_PRIORITIES, TICKET_CATEGORIES,
  type TicketStatus, type TicketPriority, type SupportTicket, type HelpArticle,
} from "@/lib/support/ticket-constants"

const ADMIN_ROLES = new Set(["broker", "broker_admin", "admin", "superadmin", "team_lead", "support"])

function mapTicket(r: Record<string, unknown>): SupportTicket {
  return {
    id: r.id as string,
    subject: r.subject as string,
    description: (r.description as string | null) ?? null,
    status: (r.status as string) ?? "open",
    priority: (r.priority as string) ?? "medium",
    category: (r.category as string | null) ?? null,
    agentId: (r.agent_id as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: (r.updated_at as string | null) ?? null,
  }
}

// ─── Agent: raise a ticket ───────────────────────────────────────────────────
export async function createSupportTicket(input: {
  subject: string
  description: string
  category?: string
  priority?: TicketPriority
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }

  const subject = input.subject?.trim()
  if (!subject) return { ok: false, error: "A subject is required" }
  const priority: TicketPriority = (TICKET_PRIORITIES as readonly string[]).includes(input.priority ?? "")
    ? (input.priority as TicketPriority)
    : "medium"
  const category = (TICKET_CATEGORIES as readonly string[]).includes(input.category ?? "")
    ? input.category
    : "general"

  const svc = createServiceClient()
  const { data, error } = await svc
    .from("support_tickets")
    .insert({
      brokerage_id: ctx.brokerageId,
      agent_id: ctx.agentId,
      subject,
      description: input.description?.trim() || null,
      category,
      priority,
      status: "open",
    })
    .select("id")
    .single()
  if (error || !data) return { ok: false, error: error?.message ?? "Could not create ticket" }

  // Alert platform support that a new ticket landed (previously nobody was notified).
  try {
    const { notifyPlatformStaff } = await import("@/lib/notifications/platform-staff")
    await notifyPlatformStaff(svc as any, {
      type: "support_ticket_new", title: `New support ticket: ${subject}`,
      body: (input.description?.trim() || subject).slice(0, 400), entityType: "support_ticket", entityId: data.id as string,
      priority: priority === "urgent" || priority === "high" ? "high" : "medium",
    })
  } catch { /* best-effort */ }

  revalidatePath("/dashboard/help")
  return { ok: true, id: data.id as string }
}

// ─── Agent: reply to my own ticket + read its thread (two-way conversation) ──────
export async function replyToMyTicket(input: { ticketId: string; body: string }): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.agentId) return { ok: false, error: "Unauthorized" }
  const svc = createServiceClient()
  const { data: t } = await svc.from("support_tickets").select("agent_id").eq("id", input.ticketId).maybeSingle()
  if (!t || (t as any).agent_id !== ctx.agentId) return { ok: false, error: "Ticket not found" }
  const { postTicketReply } = await import("@/lib/support/support-thread")
  const r = await postTicketReply(svc, { ticketId: input.ticketId, authorUserId: ctx.userId, authorKind: "tenant", body: input.body })
  if (!r.ok) return { ok: false, error: r.error }
  revalidatePath("/dashboard/help")
  return { ok: true }
}

export async function getMyTicketThread(ticketId: string): Promise<import("@/lib/support/support-thread").TicketThread | null> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.agentId) return null
  const svc = createServiceClient()
  const { data: t } = await svc.from("support_tickets").select("agent_id").eq("id", ticketId).maybeSingle()
  if (!t || (t as any).agent_id !== ctx.agentId) return null
  const { loadTicketThread } = await import("@/lib/support/support-thread")
  return loadTicketThread(svc, ticketId)
}

// ─── Agent: rate a resolved ticket (CSAT — once, 1–5) ────────────────────────
export async function rateMyTicket(input: {
  ticketId: string
  rating: number
  comment?: string
}): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.agentId) return { ok: false, error: "Unauthorized" }
  const svc = createServiceClient()
  const { data: t } = await svc.from("support_tickets")
    .select("agent_id, status, satisfaction_rating").eq("id", input.ticketId).maybeSingle()
  if (!t || (t as any).agent_id !== ctx.agentId) return { ok: false, error: "Ticket not found" }

  const { canRateTicket } = await import("@/lib/support/support-sla")
  const gate = canRateTicket(t as any, input.rating)
  if (!gate.ok) return { ok: false, error: gate.reason }

  const { error } = await svc.from("support_tickets").update({
    satisfaction_rating: input.rating,
    satisfaction_comment: input.comment?.trim() || null,
    satisfaction_at: new Date().toISOString(),
  }).eq("id", input.ticketId)
  if (error) return { ok: false, error: error.message }
  revalidatePath("/dashboard/help")
  return { ok: true }
}

// ─── Agent: my tickets ───────────────────────────────────────────────────────
export async function listMyTickets(): Promise<SupportTicket[]> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.agentId) return []
  const supabase = await createClient()
  const { data } = await supabase
    .from("support_tickets")
    .select("id, subject, description, status, priority, category, agent_id, created_at, updated_at")
    .eq("agent_id", ctx.agentId)
    .order("created_at", { ascending: false })
    .limit(100)
  return (data ?? []).map(mapTicket)
}

// ─── Admin/support: the queue ────────────────────────────────────────────────
export async function listBrokerageTickets(filters?: {
  status?: TicketStatus
}): Promise<{ ok: true; tickets: SupportTicket[] } | { ok: false; error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }
  if (!ADMIN_ROLES.has(ctx.userType)) return { ok: false, error: "Forbidden" }

  const svc = createServiceClient()
  let query = svc
    .from("support_tickets")
    .select("id, subject, description, status, priority, category, agent_id, created_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(300)

  // Superadmin/support staff see all brokerages; everyone else is brokerage-scoped.
  if (ctx.userType !== "superadmin" && ctx.userType !== "support") {
    if (!ctx.brokerageId) return { ok: false, error: "Brokerage not configured" }
    query = query.eq("brokerage_id", ctx.brokerageId)
  }
  if (filters?.status) query = query.eq("status", filters.status)

  const { data, error } = await query
  if (error) return { ok: false, error: error.message }
  return { ok: true, tickets: (data ?? []).map(mapTicket) }
}

export async function updateTicketStatus(
  ticketId: string,
  status: TicketStatus,
  priority?: TicketPriority,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ADMIN_ROLES.has(ctx.userType)) return { ok: false, error: "Forbidden" }
  if (!(TICKET_STATUSES as readonly string[]).includes(status)) return { ok: false, error: "Invalid status" }

  const svc = createServiceClient()
  const update: Record<string, unknown> = { status, updated_at: new Date().toISOString() }
  if (priority && (TICKET_PRIORITIES as readonly string[]).includes(priority)) update.priority = priority

  let q = svc.from("support_tickets").update(update).eq("id", ticketId)
  // Non-platform admins may only touch their own brokerage's tickets.
  if (ctx.userType !== "superadmin" && ctx.userType !== "support") {
    if (!ctx.brokerageId) return { ok: false, error: "Brokerage not configured" }
    q = q.eq("brokerage_id", ctx.brokerageId)
  }
  const { error } = await q
  if (error) return { ok: false, error: error.message }

  revalidatePath("/dashboard/admin/support-tickets")
  return { ok: true }
}

// ─── Admin/support: brokerage ticket thread (view + reply) ───────────────────
// Same postTicketReply/loadTicketThread rail the platform console and the
// tenant help UI use — here gated to admin roles and pinned to the caller's
// brokerage (tenant anchor) unless the caller is platform staff.

/** Resolve a ticket the caller is allowed to touch, or null. */
async function resolveAdminTicketScope(ticketId: string): Promise<
  | { ok: true; svc: ReturnType<typeof createServiceClient>; userId: string }
  | { ok: false }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ADMIN_ROLES.has(ctx.userType)) return { ok: false }
  const svc = createServiceClient()
  const { data: t, error } = await svc
    .from("support_tickets")
    .select("id, brokerage_id")
    .eq("id", ticketId)
    .maybeSingle()
  if (error || !t) return { ok: false }
  // Non-platform admins may only touch their own brokerage's tickets.
  if (ctx.userType !== "superadmin" && ctx.userType !== "support") {
    if (!ctx.brokerageId || (t as { brokerage_id: string | null }).brokerage_id !== ctx.brokerageId) {
      return { ok: false }
    }
  }
  return { ok: true, svc, userId: ctx.userId }
}

export async function getBrokerageTicketThread(
  ticketId: string,
): Promise<import("@/lib/support/support-thread").TicketThread | null> {
  const scope = await resolveAdminTicketScope(ticketId)
  if (!scope.ok) return null
  const { loadTicketThread } = await import("@/lib/support/support-thread")
  return loadTicketThread(scope.svc, ticketId)
}

export async function replyToBrokerageTicket(input: {
  ticketId: string
  body: string
}): Promise<{ ok: boolean; error?: string }> {
  const scope = await resolveAdminTicketScope(input.ticketId)
  if (!scope.ok) return { ok: false, error: "Ticket not found" }
  const { postTicketReply } = await import("@/lib/support/support-thread")
  // Tenant admins are the tenant side of the thread — same authorKind the
  // ticket's own agent uses; platform staff replies stay on the console rail.
  const r = await postTicketReply(scope.svc, {
    ticketId: input.ticketId,
    authorUserId: scope.userId,
    authorKind: "tenant",
    body: input.body,
  })
  if (!r.ok) return { ok: false, error: r.error }
  revalidatePath("/dashboard/admin/support-tickets")
  return { ok: true }
}

// ─── Help center: knowledge articles + KB topics ─────────────────────────────
export async function searchHelp(query?: string): Promise<HelpArticle[]> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return []
  const supabase = await createClient()
  const q = query?.trim()

  // Published knowledge articles (brokerage-scoped or platform-wide).
  let artQ = supabase
    .from("knowledge_articles")
    .select("id, title, excerpt, category, slug, helpful_count, view_count, brokerage_id")
    .eq("status", "published")
    .order("helpful_count", { ascending: false })
    .limit(50)
  if (q) artQ = artQ.or(`title.ilike.%${q}%,content.ilike.%${q}%`)
  const { data: articles } = await artQ

  // Active KB help topics.
  let kbQ = supabase
    .from("help_topics_kb")
    .select("id, title, content, category, is_active, brokerage_id")
    .eq("is_active", true)
    .limit(50)
  if (q) kbQ = kbQ.or(`title.ilike.%${q}%,content.ilike.%${q}%`)
  const { data: topics } = await kbQ

  const fromArticles: HelpArticle[] = (articles ?? [])
    .filter((a: Record<string, unknown>) => !a.brokerage_id || a.brokerage_id === ctx.brokerageId)
    .map((a: Record<string, unknown>) => ({
      id: a.id as string,
      source: "article" as const,
      title: a.title as string,
      excerpt: (a.excerpt as string | null) ?? null,
      category: (a.category as string | null) ?? null,
      slug: (a.slug as string | null) ?? null,
      helpfulCount: (a.helpful_count as number | null) ?? 0,
      viewCount: (a.view_count as number | null) ?? 0,
    }))

  const fromTopics: HelpArticle[] = (topics ?? [])
    .filter((t: Record<string, unknown>) => !t.brokerage_id || t.brokerage_id === ctx.brokerageId)
    .map((t: Record<string, unknown>) => ({
      id: t.id as string,
      source: "kb" as const,
      title: t.title as string,
      excerpt: ((t.content as string | null) ?? "").slice(0, 160) || null,
      category: (t.category as string | null) ?? null,
      slug: null,
      helpfulCount: 0,
      viewCount: 0,
    }))

  return [...fromArticles, ...fromTopics]
}

export async function getHelpArticle(
  id: string,
  source: "article" | "kb",
): Promise<{ title: string; content: string; category: string | null } | null> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return null
  const supabase = await createClient()

  if (source === "kb") {
    const { data } = await supabase
      .from("help_topics_kb")
      .select("title, content, category, is_active, brokerage_id")
      .eq("id", id)
      .maybeSingle()
    if (!data || !data.is_active) return null
    if (data.brokerage_id && data.brokerage_id !== ctx.brokerageId) return null
    return { title: data.title as string, content: (data.content as string) ?? "", category: (data.category as string | null) ?? null }
  }

  const svc = createServiceClient()
  const { data } = await svc
    .from("knowledge_articles")
    .select("title, content, category, status, brokerage_id")
    .eq("id", id)
    .maybeSingle()
  if (!data || data.status !== "published") return null
  if (data.brokerage_id && data.brokerage_id !== ctx.brokerageId) return null
  // Best-effort view bump.
  try { await svc.rpc("increment_knowledge_article_view", { p_article_id: id }) } catch { /* optional RPC */ }
  return { title: data.title as string, content: (data.content as string) ?? "", category: (data.category as string | null) ?? null }
}

export async function voteArticleHelpful(
  id: string,
  helpful: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }
  const svc = createServiceClient()
  const col = helpful ? "helpful_count" : "not_helpful_count"

  // ATOMIC. This was a read-modify-write: two people voting on the same article
  // in the same moment both read N and both wrote N+1, so one vote was lost.
  // public.increment is the counter primitive built for exactly this — it is
  // SECURITY DEFINER but NOT a generic increment: it hard-allowlists four
  // (table, column) pairs (ai_video_projects.view_count and the three
  // knowledge_articles counters), raises on anything else, and quotes the
  // identifiers with format(%I). One statement, no lost update.
  const { error } = await svc.rpc("increment", {
    table_name:  "knowledge_articles",
    row_id:      id,
    column_name: col,
  })

  if (error) {
    // The allowlist rejects anything unexpected, so a failure here is real —
    // report it rather than silently falling back to the racy path.
    return { ok: false, error: error.message }
  }
  return { ok: true }
}
