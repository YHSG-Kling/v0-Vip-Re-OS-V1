// lib/agents/agent-deactivation.ts
// ─────────────────────────────────────────────────────────────────────────────
// AGENT DEACTIVATION — the governed "an agent leaves the brokerage" operation that the
// admin (user management) drives. Deactivating an agent must never ORPHAN their book:
// every contact + lead they held is consciously REASSIGNED to a successor or ARCHIVED.
//
// The crux is OWNERSHIP. A real brokerage distinguishes two kinds of relationship:
//   • SYSTEM-ACQUIRED — the brokerage's AI pipeline scraped/sourced the lead and merely
//     ASSIGNED this agent to work it. The brokerage owns the relationship; on departure it
//     ALWAYS moves to the successor agent (never archived — it's a brokerage asset).
//   • AGENT BOOK — the agent personally SOURCED the relationship (their sphere/referral/
//     past client). Per many agent contracts this book leaves WITH the agent, so the admin
//     may choose to ARCHIVE it (stop all automation, preserve history) instead of handing
//     it to another agent — OR still reassign it if the contract says the brokerage keeps it.
// The single, defensible signal for "the agent brought this relationship" is
// contacts.source_agent_id (the system's record of who sourced it).
//
// HARD RULE: a contact with an IN-FLIGHT transaction is NEVER archived — a live deal must
// always land with the successor so the client is never dropped mid-transaction.
//
// NOT server-only (the simulator drives it end-to-end); only ever writes through a
// caller-supplied/service client.

import type { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

/** Transaction statuses that mean a deal is IN FLIGHT — such a contact is always
 *  reassigned to the successor, never archived (the client is never dropped mid-deal). */
export const ACTIVE_DEAL_STATUSES = [
  "active", "under_contract", "pending", "closing", "accepted", "in_escrow",
] as const

export type ContactOwnership = "agent_book" | "system_acquired"

/** The agent's identifiers a contact's source_agent_id might match (agents.id or users.id). */
export interface AgentIdentity {
  agentId: string
  userId: string | null
}

/**
 * classifyContactOwnership — PURE. The contact is the AGENT'S BOOK only when the agent
 * personally SOURCED it (contacts.source_agent_id matches the agent's id or user id).
 * Everything else is SYSTEM-ACQUIRED — the conservative default, because the dangerous
 * operation (archiving) must require positive proof the agent owns the relationship.
 */
export function classifyContactOwnership(
  contact: { source_agent_id: string | null },
  agent: AgentIdentity,
): ContactOwnership {
  const src = contact.source_agent_id
  if (src && (src === agent.agentId || src === agent.userId)) return "agent_book"
  return "system_acquired"
}

export type AgentBookDisposition = "reassign" | "archive"

interface PlannedContact {
  id: string
  ownership: ContactOwnership
  hasActiveTransaction: boolean
}

export interface DeactivationPlan {
  agentId: string
  contacts: PlannedContact[]
  leadIds: string[]
  counts: {
    systemAcquired: number
    agentBook: number
    leads: number
    activeDeals: number
  }
}

/** The set of contact_ids that currently have an in-flight transaction. */
async function contactsWithActiveDeals(svc: Svc, brokerageId: string, contactIds: string[]): Promise<Set<string>> {
  if (contactIds.length === 0) return new Set()
  const { data } = await svc
    .from("transactions")
    .select("contact_id, status")
    .eq("brokerage_id", brokerageId)
    .in("contact_id", contactIds)
    .in("status", ACTIVE_DEAL_STATUSES as unknown as string[])
  const set = new Set<string>()
  for (const r of (data ?? []) as Array<{ contact_id: string | null }>) {
    if (r.contact_id) set.add(r.contact_id)
  }
  return set
}

/**
 * planAgentDeactivation — READ-ONLY preview the admin UI renders before confirming:
 * how the agent's book splits into system-acquired vs agent-book, how many leads, and
 * how many in-flight deals (which always reassign regardless of disposition).
 */
export async function planAgentDeactivation(
  svc: Svc,
  params: { brokerageId: string; agentId: string; userId: string | null },
): Promise<DeactivationPlan> {
  const { brokerageId, agentId, userId } = params
  const agent: AgentIdentity = { agentId, userId }

  const { data: contactRows } = await svc
    .from("contacts")
    .select("id, source_agent_id")
    .eq("brokerage_id", brokerageId)
    .eq("agent_id", agentId)
    .is("deleted_at", null)
  const contacts = (contactRows ?? []) as Array<{ id: string; source_agent_id: string | null }>

  const activeDealSet = await contactsWithActiveDeals(svc, brokerageId, contacts.map((c) => c.id))

  const planned: PlannedContact[] = contacts.map((c) => ({
    id: c.id,
    ownership: classifyContactOwnership(c, agent),
    hasActiveTransaction: activeDealSet.has(c.id),
  }))

  const { data: leadRows } = await svc
    .from("leads")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq("agent_id", agentId)
  const leadIds = ((leadRows ?? []) as Array<{ id: string }>).map((r) => r.id)

  return {
    agentId,
    contacts: planned,
    leadIds,
    counts: {
      systemAcquired: planned.filter((c) => c.ownership === "system_acquired").length,
      agentBook: planned.filter((c) => c.ownership === "agent_book").length,
      leads: leadIds.length,
      activeDeals: planned.filter((c) => c.hasActiveTransaction).length,
    },
  }
}

export interface DeactivationResult {
  ok: boolean
  reason?: string
  reassignedContacts: number
  archivedContacts: number
  reassignedLeads: number
  inFlightForcedReassign: number
  agentDeactivated: boolean
  /** Gated client re-introductions proposed for the inherited book (warm hand-off). */
  reintroductionsProposed: number
  /** In-flight transaction ownership rows moved to the successor (closed deals untouched). */
  reassignedDealRoles: number
  /** Open tasks (general + transaction) the departed agent owed, moved to the successor. */
  reassignedOpenTasks: number
}

/**
 * executeAgentDeactivation — the governed operation. Reassigns system-acquired contacts +
 * leads to the successor; for the agent's own book follows the admin's disposition
 * (reassign or archive) EXCEPT an in-flight deal is always reassigned; deactivates the
 * agent; notifies the successor; audits every move; and signals the Deal Coordinator to
 * realign the transaction team for any in-flight deal that changed hands.
 *
 * Idempotent: a re-run finds the agent already inactive + the book already moved and no-ops.
 */
export async function executeAgentDeactivation(
  svc: Svc,
  params: {
    brokerageId: string
    agentId: string
    userId: string | null
    successorAgentId: string | null
    agentBookDisposition: AgentBookDisposition
    actorUserId?: string | null
  },
): Promise<DeactivationResult> {
  const { brokerageId, agentId, userId, successorAgentId, agentBookDisposition, actorUserId } = params
  const result: DeactivationResult = {
    ok: false, reassignedContacts: 0, archivedContacts: 0, reassignedLeads: 0,
    inFlightForcedReassign: 0, agentDeactivated: false, reintroductionsProposed: 0, reassignedDealRoles: 0,
    reassignedOpenTasks: 0,
  }
  const reassignedContactIds: string[] = []
  if (!brokerageId || !agentId) return { ...result, reason: "brokerageId + agentId required" }
  if (agentId === successorAgentId) return { ...result, reason: "successor must differ from the deactivated agent" }

  const plan = await planAgentDeactivation(svc, { brokerageId, agentId, userId })

  // A successor is REQUIRED whenever anything must be reassigned (system-acquired contacts,
  // leads, in-flight deals, or an agent-book 'reassign' disposition). Archive-only of a book
  // with no system assets + no leads + no deals is the only successor-free path.
  const needsSuccessor =
    plan.counts.systemAcquired > 0 ||
    plan.counts.leads > 0 ||
    plan.counts.activeDeals > 0 ||
    (agentBookDisposition === "reassign" && plan.counts.agentBook > 0)
  if (needsSuccessor && !successorAgentId) {
    return { ...result, reason: "a successor agent is required to reassign this agent's system book / leads / in-flight deals" }
  }

  // Validate the successor is a real, active agent in the brokerage.
  let successorUserId: string | null = null
  if (successorAgentId) {
    const { data: succ } = await svc.from("agents")
      .select("id, user_id, is_active").eq("id", successorAgentId).eq("brokerage_id", brokerageId).maybeSingle()
    if (!succ) return { ...result, reason: "successor agent not found in this brokerage" }
    if ((succ as any).is_active === false) return { ...result, reason: "successor agent is not active" }
    successorUserId = (succ as any).user_id ?? null
  }

  const nowIso = new Date().toISOString()
  const audit = async (entityId: string, action: string, meta: Record<string, unknown>) => {
    await svc.from("lifecycle_events").insert({
      brokerage_id: brokerageId, entity_type: "contact", entity_id: entityId,
      event_type: "AGENT_DEACTIVATION_REASSIGN",
      metadata: { action, from_agent: agentId, to_agent: successorAgentId, by: actorUserId ?? null, ...meta },
      created_at: nowIso,
    }).then(() => {}, () => {})
  }

  // ── Contacts ──
  for (const c of plan.contacts) {
    const mustReassign = c.ownership === "system_acquired" || c.hasActiveTransaction || agentBookDisposition === "reassign"
    if (mustReassign) {
      if (!successorAgentId) continue // guarded above; defensive
      const { error } = await svc.from("contacts")
        .update({ agent_id: successorAgentId, updated_at: nowIso })
        .eq("id", c.id).eq("brokerage_id", brokerageId)
      if (!error) {
        result.reassignedContacts += 1
        reassignedContactIds.push(c.id)
        if (c.hasActiveTransaction && c.ownership === "agent_book" && agentBookDisposition === "archive") {
          result.inFlightForcedReassign += 1
          await audit(c.id, "reassign_inflight_override", { ownership: c.ownership, note: "in-flight deal — never archived" })
        } else {
          await audit(c.id, "reassign", { ownership: c.ownership })
        }
      }
    } else {
      // agent_book + archive disposition + no in-flight deal → ARCHIVE (stop all automation,
      // preserve history). The agent's personal book leaves with them per contract.
      const { error } = await svc.from("contacts")
        .update({ status: "archived", ai_outreach_paused: true, isa_reengage_allowed: false, updated_at: nowIso })
        .eq("id", c.id).eq("brokerage_id", brokerageId)
      if (!error) {
        result.archivedContacts += 1
        await audit(c.id, "archive", { ownership: c.ownership })
      }
    }
  }

  // ── Leads (always system/brokerage-owned → reassign to the successor) ──
  if (successorAgentId && plan.leadIds.length > 0) {
    const { error, count } = await svc.from("leads")
      .update({ agent_id: successorAgentId, updated_at: nowIso }, { count: "exact" })
      .eq("brokerage_id", brokerageId).eq("agent_id", agentId)
    if (!error) result.reassignedLeads = count ?? plan.leadIds.length
  }

  // ── In-flight DEAL OWNERSHIP follows the client. Reassign the departed agent's role on
  //    ACTIVE transactions (agent / buyer-agent / seller-agent) to the successor so deal
  //    ownership is never orphaned to an inactive agent. CLOSED deals are LEFT untouched —
  //    historical attribution + commission credit must stay with the original agent. ──
  if (successorAgentId) {
    for (const roleCol of ["agent_id", "buyer_agent_id", "seller_agent_id"] as const) {
      const { count } = await svc.from("transactions")
        .update({ [roleCol]: successorAgentId, updated_at: nowIso }, { count: "exact" })
        .eq("brokerage_id", brokerageId).eq(roleCol, agentId)
        .in("status", ACTIVE_DEAL_STATUSES as unknown as string[])
      result.reassignedDealRoles += count ?? 0
    }
  }

  // ── OPEN WORK FOLLOWS THE BOOK — the departed agent's INCOMPLETE tasks (general +
  //    transaction) move to the successor so nothing the agent owed sits unactioned. Closed/
  //    cancelled tasks are left as history. ──
  if (successorAgentId) {
    const OPEN_TASK_EXCLUDE = "(completed,cancelled,done,closed)"
    const { count: genTasks } = await svc.from("tasks")
      .update({ assigned_to_agent_id: successorAgentId }, { count: "exact" })
      .eq("brokerage_id", brokerageId).eq("assigned_to_agent_id", agentId)
      .not("status", "in", OPEN_TASK_EXCLUDE)
    result.reassignedOpenTasks += genTasks ?? 0
    if (successorUserId && userId) {
      const { count: txTasks } = await svc.from("transaction_tasks")
        .update({ assigned_user_id: successorUserId }, { count: "exact" })
        .eq("brokerage_id", brokerageId).eq("assigned_user_id", userId)
        .not("status", "in", OPEN_TASK_EXCLUDE)
      result.reassignedOpenTasks += txTasks ?? 0
    }
  }

  // ── Deactivate the agent ──
  {
    const { error } = await svc.from("agents")
      .update({ is_active: false }).eq("id", agentId).eq("brokerage_id", brokerageId)
    result.agentDeactivated = !error
  }

  // ── WARM HAND-OFF: re-INTRODUCE the successor to every inherited client. A reassigned
  //    relationship must be RE-ESTABLISHED, not silently re-pointed — the client hears
  //    "you have a new point of contact" from the successor, gated (a human approves before
  //    it sends). Archived contacts are excluded (automation is off). Idempotent per contact.
  if (successorAgentId && reassignedContactIds.length > 0) {
    result.reintroductionsProposed = await proposeSuccessorReintroductions(
      svc, { brokerageId, successorAgentId, contactIds: reassignedContactIds },
    )
  }

  // ── Notify the successor of the inherited book (one summary notification) ──
  if (successorUserId && (result.reassignedContacts > 0 || result.reassignedLeads > 0)) {
    await svc.from("notifications").insert({
      user_id: successorUserId, brokerage_id: brokerageId, type: "book_reassigned",
      title: "You've inherited a departing agent's book",
      body: `${result.reassignedContacts} contact(s) and ${result.reassignedLeads} lead(s) were reassigned to you${result.inFlightForcedReassign > 0 ? `, including ${result.inFlightForcedReassign} with an in-flight deal — review those first` : ""}.`,
      entity_type: "agent", entity_id: agentId, priority: result.inFlightForcedReassign > 0 ? "high" : "medium", is_read: false,
    }).then(() => {}, () => {})
  }

  // ── Managers working together: the Deal Coordinator realigns the transaction team for
  //    any in-flight deal that just changed hands (the client is never dropped mid-deal). ──
  if (successorAgentId && plan.counts.activeDeals > 0) {
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    await publishManagerSignal({
      brokerageId,
      fromManager: "recruiting_manager", // user-management / roster is the recruiting manager's domain
      toManager: "deal_coordinator",
      signalType: "agent_book_reassigned",
      message: `A departing agent's ${plan.counts.activeDeals} in-flight deal(s) moved to the successor — realign the transaction team so nothing slips.`,
      entityType: "agent",
      entityId: agentId,
      payload: { successor_agent_id: successorAgentId, active_deals: plan.counts.activeDeals },
    }, svc)
  }

  result.ok = true
  return result
}

/** Subject the warm hand-off re-introduction uses (also the idempotency key per contact). */
export const SUCCESSOR_REINTRO_SUBJECT = "A quick introduction from your new point of contact"

/**
 * proposeSuccessorReintroductions — for every CONTACT inherited by the successor, propose a
 * GATED warm re-introduction so the relationship is RE-ESTABLISHED, not silently re-pointed.
 * Side-aware (buyer → Shopping Agent, seller → Listing Concierge), brand-named, them-first,
 * Fair-Housing safe; nothing sends until the successor approves it. Idempotent per contact
 * (one open/approved re-intro). Returns how many were proposed.
 */
async function proposeSuccessorReintroductions(
  svc: Svc,
  params: { brokerageId: string; successorAgentId: string; contactIds: string[] },
): Promise<number> {
  const { brokerageId, successorAgentId, contactIds } = params
  if (contactIds.length === 0) return 0

  // Successor's display name + the brokerage trade name (best-effort; the message still
  // reads cleanly without them).
  const { data: succAgent } = await svc.from("agents").select("user_id").eq("id", successorAgentId).maybeSingle()
  const succUserId = (succAgent as { user_id: string | null } | null)?.user_id ?? null
  let successorName = "your new agent"
  if (succUserId) {
    const { data: su } = await svc.from("users").select("first_name, last_name").eq("id", succUserId).maybeSingle()
    const nm = [(su as any)?.first_name, (su as any)?.last_name].filter(Boolean).join(" ").trim()
    if (nm) successorName = nm
  }
  const { data: brk } = await svc.from("brokerages").select("name").eq("id", brokerageId).maybeSingle()
  const brokerageName = (brk as { name: string | null } | null)?.name?.trim() || "our team"

  const { data: contactRows } = await svc.from("contacts")
    .select("id, first_name, contact_type").in("id", contactIds).eq("brokerage_id", brokerageId)
  const contacts = (contactRows ?? []) as Array<{ id: string; first_name: string | null; contact_type: string | null }>

  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  let proposed = 0
  for (const c of contacts) {
    // Idempotency — skip a contact that already has an open/approved re-intro.
    const { data: dup } = await svc.from("agent_client_messages").select("id")
      .eq("brokerage_id", brokerageId).eq("recipient_contact_id", c.id)
      .eq("subject", SUCCESSOR_REINTRO_SUBJECT).in("status", ["proposed", "approved"]).limit(1).maybeSingle()
    if (dup) continue

    const isSeller = c.contact_type === "seller"
    const audience: "seller" | "buyer" = isSeller ? "seller" : "buyer"
    const agentKind = isSeller ? "listing_concierge" : "shopping_agent"
    const firstName = c.first_name || "there"
    const body =
      `Hi ${firstName}, I'm ${successorName} with ${brokerageName} — I'll be your point of contact going forward. ` +
      `Nothing about your plans changes; you've still got the whole team behind you, and I'm here for anything you need. ` +
      `Reply anytime and I'll take it from there.`
    const res = await proposeClientMessage({
      brokerageId, agentKind, entityType: "contact", entityId: c.id,
      recipientContactId: c.id, audience, subject: SUCCESSOR_REINTRO_SUBJECT, body,
      rationale: "Warm hand-off — the successor re-introduces themselves to an inherited client (agent off-boarding).",
      channel: "portal",
    }, svc)
    if (res.ok) proposed += 1
  }
  return proposed
}
