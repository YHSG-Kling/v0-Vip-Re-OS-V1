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
 *   support_tickets.lane     ∈ tenant_to_platform | user_to_brokerage  (NOT NULL, NO DEFAULT)
 *   knowledge_articles.status ∈ draft | published | archived
 *
 * Identity is resolved server-side via getAgentContext. Ticket writes set
 * agent_id = agents.id (FK), submitted_by_user_id = users.id (the submitter fact
 * that works for a user class holding no agents row) and brokerage_id from the
 * caller's context.
 *
 * TWO LANES, NEVER ONE QUEUE (m468, owner ruling). tenant_to_platform is the
 * brokerage raising a ticket TO the platform; user_to_brokerage is an agent or a
 * vendor raising one to their own office. Every insert states its lane and every
 * list filters by it — a list that spans them shows a brokerage its own open
 * questions to the platform as though they were work waiting on its desk.
 */

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity"
// Constants + types live in a non-"use server" module so clients can import them
// directly (a "use server" file may only export async functions).
import {
  TICKET_STATUSES, TICKET_PRIORITIES, TICKET_CATEGORIES, isTicketLane, ticketAnsweredBy,
  type TicketStatus, type TicketPriority, type TicketLane, type SupportTicket, type HelpArticle,
} from "@/lib/support/ticket-constants"
import { BROKERAGE_ADMIN_USER_TYPES } from "@/lib/auth/require-brokerage-admin"

// SCOPE LADDER (kept inline — 'support' is a storable platform-staff user_type
// this queue deliberately admits): 'superadmin' removed — dead as
// users.user_type (0 live rows; the platform superadmin is user_type='admin',
// admitted already); broker_owner added — storable seat that owns the brokerage.
const ADMIN_ROLES = new Set(["broker", "broker_owner", "broker_admin", "admin", "team_lead", "support"])

/** The columns every ticket read in this file selects. One list so a lane can
 *  never be dropped from one query and present in another. */
const TICKET_COLUMNS =
  "id, subject, description, status, priority, category, agent_id, lane, vendor_id, submitted_by_user_id, created_at, updated_at"

/**
 * Does this caller administer their own brokerage? MIRRORS public.is_brokerage_admin()
 * as m466 left it: users.user_type in the three admin values, OR a tenant role GRANT
 * in user_role_assignments carrying one of those roles for the caller's OWN brokerage.
 *
 * NOT requireBrokerageAdmin(), deliberately, for two reasons. It THROWS, and this is a
 * branch in a normal flow rather than a gate at the top of one. And its first branch
 * returns as soon as users.brokerage_id is set — so an account whose users row says
 * 'agent' and whose authority is a role grant is refused there without the grants ever
 * being read. MEASURED: agent1@yourbrokerage.com is exactly that account, and
 * public.is_brokerage_admin() admits it. An app gate mirrors RLS or sits inside it; a
 * gate NARROWER than the policy silently refuses the owner's second seat.
 *
 * EXISTS-shaped, not a single-row read: user_role_assignments is UNIQUE on
 * (user_id, role) and NOT on user_id, so several grants per user is legal AND LIVE.
 * `error` is destructured because supabase-js RESOLVES a refused query, and reading a
 * refusal as "no grants" would refuse a legitimate admin for the wrong reason.
 */
async function callerAdministersOwnBrokerage(ctx: { userId: string; userType: string; brokerageId: string | null }): Promise<boolean> {
  if (BROKERAGE_ADMIN_USER_TYPES.has(ctx.userType)) return true
  if (!ctx.brokerageId) return false
  const { data, error } = await createServiceClient()
    .from("user_role_assignments")
    .select("role, brokerage_id")
    .eq("user_id", ctx.userId)
  if (error) {
    console.error("[support] role-grant read refused:", error.message)
    return false
  }
  return (data ?? []).some(
    (g: { role?: string | null; brokerage_id?: string | null }) =>
      g.brokerage_id === ctx.brokerageId && BROKERAGE_ADMIN_USER_TYPES.has(String(g.role ?? "")),
  )
}

/**
 * Who reads/writes the ticket queue ACROSS brokerages instead of being pinned to
 * their own tenant.
 *
 * Two halves, and only one of them worked. `ctx.userType === "support"` is live —
 * 'support' is a storable user_type — but `ctx.userType === "superadmin"` matched
 * NOBODY: the platform's only superadmin is (user_type='admin',
 * platform_role='superadmin'), so the platform owner silently fell through to the
 * brokerage-scoped branch and the support console showed them ONE tenant's tickets
 * while reading as the whole queue. AgentContext does not carry platform_role, so
 * it is read here. Both columns, the same shape as public.is_platform_admin() in
 * RLS — see app/actions/vendor-budget.ts:136-147.
 *
 * NOT widened to the four-role platform-staff roster: that would newly admit
 * platform 'admin' and 'marketing' to every tenant's support tickets, which is a
 * scope decision this fix has no mandate to make. Only the dead half is repaired.
 */
async function callerReadsAllBrokerages(ctx: { userId: string; userType: string }): Promise<boolean> {
  if (ctx.userType === "superadmin" || ctx.userType === "support") return true
  const { data } = await createServiceClient()
    .from("users")
    .select("platform_role")
    .eq("id", ctx.userId)
    .maybeSingle()
  return (data as { platform_role?: string | null } | null)?.platform_role === "superadmin"
}

function mapTicket(r: Record<string, unknown>): SupportTicket {
  return {
    id: r.id as string,
    subject: r.subject as string,
    description: (r.description as string | null) ?? null,
    status: (r.status as string) ?? "open",
    priority: (r.priority as string) ?? "medium",
    category: (r.category as string | null) ?? null,
    agentId: (r.agent_id as string | null) ?? null,
    lane: (r.lane as string) ?? "user_to_brokerage",
    vendorId: (r.vendor_id as string | null) ?? null,
    submittedByUserId: (r.submitted_by_user_id as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: (r.updated_at as string | null) ?? null,
  }
}

/**
 * May this caller raise the tenant_to_platform lane? Asked by the help UI so it can
 * offer the choice only to an account that may take it, and enforced again inside
 * createSupportTicket — the UI decides what to SHOW, never what is ALLOWED.
 */
export async function canRaisePlatformTicket(): Promise<boolean> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return false
  return callerAdministersOwnBrokerage(ctx)
}

// ─── Raise a ticket, in ONE of the two lanes ─────────────────────────────────
/**
 * `lane` is REQUIRED and is NOT defaulted here. support_tickets.lane is NOT NULL
 * with no default (m468), and a default in this function would put it back: the
 * caller that forgot to say which conversation it is raising would silently get
 * one of them, routed to the wrong audience. An unrecognised lane is refused with
 * a sentence rather than handed to PostgREST to fail as 23514.
 *
 * LANE 1 IS ADMIN-CLASS ONLY, matching the RLS INSERT policy exactly. The tenant
 * speaks to the platform as an organisation; a producing agent raises to their own
 * office. Checked here as well as in the policy because this action writes through
 * the SERVICE client, which bypasses RLS entirely — without this test the policy
 * would never see the insert at all.
 */
export async function createSupportTicket(input: {
  subject: string
  description: string
  lane: TicketLane
  category?: string
  priority?: TicketPriority
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }
  const brokerageId: string = ctx.brokerageId

  if (!isTicketLane(input.lane)) return { ok: false, error: "A support lane is required" }
  const lane: TicketLane = input.lane

  const subject = input.subject?.trim()
  if (!subject) return { ok: false, error: "A subject is required" }
  const priority: TicketPriority = (TICKET_PRIORITIES as readonly string[]).includes(input.priority ?? "")
    ? (input.priority as TicketPriority)
    : "medium"
  const category = (TICKET_CATEGORIES as readonly string[]).includes(input.category ?? "")
    ? input.category
    : "general"

  if (lane === "tenant_to_platform" && !(await callerAdministersOwnBrokerage(ctx))) {
    return { ok: false, error: "Only a brokerage admin may raise a ticket with the platform" }
  }

  const svc = createServiceClient()
  const { data, error } = await svc
    .from("support_tickets")
    .insert({
      brokerage_id: brokerageId,
      agent_id: ctx.agentId,
      // The submitter, recorded at the AUTH level. agents.id answers this only for
      // users who have an agents row; a tc, an isa or an office admin does not, and
      // their ticket would then be invisible to the person who raised it.
      submitted_by_user_id: ctx.userId,
      lane,
      subject,
      description: input.description?.trim() || null,
      category,
      priority,
      status: "open",
    })
    .select("id")
    .single()
  if (error || !data) return { ok: false, error: error?.message ?? "Could not create ticket" }

  // Alert the side that actually answers this lane. Before the lane existed BOTH
  // lanes alerted platform staff, so a brokerage-internal ticket paged the platform
  // and the brokerage's own office was never told.
  try {
    if (ticketAnsweredBy(lane) === "platform_support") {
      const { notifyPlatformStaff } = await import("@/lib/notifications/platform-staff")
      await notifyPlatformStaff(svc as any, {
        type: "support_ticket_new", title: `New support ticket: ${subject}`,
        body: (input.description?.trim() || subject).slice(0, 400), entityType: "support_ticket", entityId: data.id as string,
        priority: priority === "urgent" || priority === "high" ? "high" : "medium",
      })
    } else if (ticketAnsweredBy(lane) === "brokerage_office") {
      const { notifyBrokerageAdmins } = await import("@/lib/notifications/brokerage-admins")
      await notifyBrokerageAdmins(svc as any, brokerageId, {
        type: "support_ticket_new", title: `New support ticket: ${subject}`,
        body: (input.description?.trim() || subject).slice(0, 400), entityType: "support_ticket", entityId: data.id as string,
        priority: priority === "urgent" || priority === "high" ? "high" : "medium",
      })
    }
  } catch { /* best-effort */ }

  revalidatePath("/dashboard/help")
  return { ok: true, id: data.id as string }
}

/**
 * Is this caller the person who raised that ticket? Mirrors
 * public.is_support_ticket_submitter: the AUTH-level submitter first, the agents
 * linkage beside it.
 *
 * WAS `agent_id === ctx.agentId` alone, which answers "no" for every tenant user
 * with no agents row — a tc, an isa, an office admin — so those users could raise a
 * ticket through this very file and then never reply to it.
 *
 * `error` is destructured: supabase-js RESOLVES a refused read, and `{ data }` alone
 * turns "permission denied" into "ticket not found", which is the same sentence for
 * two entirely different failures.
 */
async function callerIsTicketSubmitter(
  svc: ReturnType<typeof createServiceClient>,
  ticketId: string,
  ctx: { userId: string; agentId: string | null },
): Promise<{ ok: true; ticket: Record<string, unknown> } | { ok: false; error: string }> {
  const { data: t, error } = await svc
    .from("support_tickets")
    .select("id, agent_id, submitted_by_user_id, lane, status, satisfaction_rating")
    .eq("id", ticketId)
    .maybeSingle()
  if (error) return { ok: false, error: `Could not read the ticket: ${error.message}` }
  if (!t) return { ok: false, error: "Ticket not found" }
  const row = t as Record<string, unknown>
  const mine =
    (row.submitted_by_user_id != null && row.submitted_by_user_id === ctx.userId) ||
    (row.agent_id != null && ctx.agentId != null && row.agent_id === ctx.agentId)
  if (!mine) return { ok: false, error: "Ticket not found" }
  return { ok: true, ticket: row }
}

// ─── Agent: reply to my own ticket + read its thread (two-way conversation) ──────
export async function replyToMyTicket(input: { ticketId: string; body: string }): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }
  const svc = createServiceClient()
  const mine = await callerIsTicketSubmitter(svc, input.ticketId, ctx)
  if (!mine.ok) return { ok: false, error: mine.error }
  const { postTicketReply } = await import("@/lib/support/support-thread")
  const r = await postTicketReply(svc, { ticketId: input.ticketId, authorUserId: ctx.userId, authorKind: "tenant", body: input.body })
  if (!r.ok) return { ok: false, error: r.error }
  revalidatePath("/dashboard/help")
  return { ok: true }
}

export async function getMyTicketThread(ticketId: string): Promise<import("@/lib/support/support-thread").TicketThread | null> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return null
  const svc = createServiceClient()
  const mine = await callerIsTicketSubmitter(svc, ticketId, ctx)
  if (!mine.ok) return null
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
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }
  const svc = createServiceClient()
  const mine = await callerIsTicketSubmitter(svc, input.ticketId, ctx)
  if (!mine.ok) return { ok: false, error: mine.error }

  const { canRateTicket } = await import("@/lib/support/support-sla")
  const gate = canRateTicket(mine.ticket as any, input.rating)
  if (!gate.ok) return { ok: false, error: gate.reason }

  // `.select("id")` and a length check, not `error === null`: a zero-row RLS
  // refusal comes back as error:null with no rows, so an unchecked update
  // reports a rating that was never stored.
  const { data: rated, error } = await svc.from("support_tickets").update({
    satisfaction_rating: input.rating,
    satisfaction_comment: input.comment?.trim() || null,
    satisfaction_at: new Date().toISOString(),
  }).eq("id", input.ticketId).select("id")
  if (error) return { ok: false, error: error.message }
  if ((rated?.length ?? 0) === 0) return { ok: false, error: "The rating was not stored" }
  revalidatePath("/dashboard/help")
  return { ok: true }
}

// ─── My tickets — the ones I RAISED, in either lane ──────────────────────────
/**
 * Keyed on the SUBMITTER, not on agent_id. Two reasons, and neither is cosmetic:
 * agent_id is null for every tenant user with no agents row (so their own tickets
 * were invisible to them), and a lane 1 ticket is normally raised by an office
 * admin who has none.
 *
 * Returns a DISCRIMINATED result. This used to return `SupportTicket[]` off `{ data }`
 * alone, so a refused read rendered as "you have no tickets" — the exact shape that
 * makes a permissions failure look like an empty state.
 */
export async function listMyTickets(): Promise<
  { ok: true; tickets: SupportTicket[] } | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("support_tickets")
    .select(TICKET_COLUMNS)
    .eq("submitted_by_user_id", ctx.userId)
    .order("created_at", { ascending: false })
    .limit(100)
  if (error) return { ok: false, error: error.message }
  return { ok: true, tickets: (data ?? []).map(mapTicket) }
}

// ─── Admin/support: the queue, for ONE lane ──────────────────────────────────
/**
 * `lane` is REQUIRED. The two lanes are two different queues answered by two
 * different organisations, and a list that spans them shows a brokerage its own
 * tickets to the platform mixed in with its agents' tickets to itself. Every caller
 * states which queue it is drawing.
 */
export async function listBrokerageTickets(filters: {
  lane: TicketLane
  status?: TicketStatus
}): Promise<{ ok: true; tickets: SupportTicket[] } | { ok: false; error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }
  if (!ADMIN_ROLES.has(ctx.userType)) return { ok: false, error: "Forbidden" }
  if (!isTicketLane(filters?.lane)) return { ok: false, error: "A support lane is required" }

  const svc = createServiceClient()
  let query = svc
    .from("support_tickets")
    .select(TICKET_COLUMNS)
    .eq("lane", filters.lane)
    .order("created_at", { ascending: false })
    .limit(300)

  // Superadmin/support staff see all brokerages; everyone else is brokerage-scoped.
  if (!(await callerReadsAllBrokerages(ctx))) {
    if (!ctx.brokerageId) return { ok: false, error: "Brokerage not configured" }
    query = query.eq("brokerage_id", ctx.brokerageId)
  }
  if (filters.status) query = query.eq("status", filters.status)

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
  if (!(await callerReadsAllBrokerages(ctx))) {
    if (!ctx.brokerageId) return { ok: false, error: "Brokerage not configured" }
    q = q.eq("brokerage_id", ctx.brokerageId)
  }
  // PROVE the write. A brokerage-scoped update that matches no row returns
  // error:null with zero rows — indistinguishable from success unless the rows
  // are counted, which is how the optimistic status flip in the queue UI could
  // report "Ticket marked resolved" for a ticket in another tenant.
  const { data: updated, error } = await q.select("id")
  if (error) return { ok: false, error: error.message }
  if ((updated?.length ?? 0) === 0) return { ok: false, error: "Ticket not found" }

  revalidatePath("/dashboard/admin/support-tickets")
  return { ok: true }
}

// ─── Admin/support: brokerage ticket thread (view + reply) ───────────────────
// Same postTicketReply/loadTicketThread rail the platform console and the
// tenant help UI use — here gated to admin roles and pinned to the caller's
// brokerage (tenant anchor) unless the caller is platform staff.

/** Resolve a ticket the caller is allowed to touch, WITH ITS LANE, or nothing. */
async function resolveAdminTicketScope(ticketId: string): Promise<
  | { ok: true; svc: ReturnType<typeof createServiceClient>; userId: string; lane: string }
  | { ok: false }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ADMIN_ROLES.has(ctx.userType)) return { ok: false }
  const svc = createServiceClient()
  const { data: t, error } = await svc
    .from("support_tickets")
    .select("id, brokerage_id, lane")
    .eq("id", ticketId)
    .maybeSingle()
  if (error || !t) return { ok: false }
  // Non-platform admins may only touch their own brokerage's tickets.
  if (!(await callerReadsAllBrokerages(ctx))) {
    if (!ctx.brokerageId || (t as { brokerage_id: string | null }).brokerage_id !== ctx.brokerageId) {
      return { ok: false }
    }
  }
  return { ok: true, svc, userId: ctx.userId, lane: String((t as { lane?: string | null }).lane ?? "") }
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
  // WHICH SIDE OF THE THREAD THIS IS DEPENDS ON THE LANE, and it used to be
  // hard-coded to "tenant".
  //
  //   user_to_brokerage — the brokerage's office staff ARE the answering side.
  //     Their reply is the one that stamps first_response_at and moves the ticket
  //     open→in_progress, and it must notify the SUBMITTER. Posting it as "tenant"
  //     stamped nothing and notified the platform, which is not a party to this
  //     lane at all.
  //   tenant_to_platform — the brokerage is the ASKING side, replying to the
  //     platform. "tenant" is correct there, and unchanged.
  const authorKind = ticketAnsweredBy(scope.lane) === "brokerage_office" ? "staff" : "tenant"
  const r = await postTicketReply(scope.svc, {
    ticketId: input.ticketId,
    authorUserId: scope.userId,
    authorKind,
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
