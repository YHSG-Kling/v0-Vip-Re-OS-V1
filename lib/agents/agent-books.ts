// lib/agents/agent-books.ts
// ─────────────────────────────────────────────────────────────────────────────
// REASSIGN AN AGENT'S BOOKS — TEMPORARILY OR PERMANENTLY (wave 81A).
//
// OWNER, VERBATIM (2026-09-24): "make sure the tenant can assign temporarily or
// permanently another agents books in case an agent leaves or temporarily
// leaves."
//
// INVENTORY FIRST — the three survivors this rides, never a fourth engine:
//   · lib/agents/agent-deactivation.ts   the PERMANENT path ("an agent leaves"):
//     executeAgentDeactivation classifies every contact (agent book vs
//     system-acquired), moves the open work through moveAgentWork (the ONE move
//     set), deactivates the agent, proposes the warm re-introductions, notifies
//     the successor and signals the Deal Coordinator. reassignAgentBooks
//     scope:"permanent" IS that call, plus a ledger row.
//   · lib/agents/coverage-mode.ts        NEW-lead routing while an agent is away
//     (agents.covering_agent_id + coverage_until; enforced at the assignment
//     terminal, lib/lead-assignment/tier-routing.ts). It never moved the book —
//     that was the missing half. A TEMPORARY transfer SETS coverage on the away
//     agent (so new leads follow) AND moves the book; the daily revert clears it.
//   · lib/lead-assignment/rule-matcher.ts + assignment-engine.ts  the rules for
//     NEW leads: a deactivated agent is filtered out of a rule's pool
//     (assignment-engine, wave 81A) and an away agent is redirected (coverage).
//
// THE LEDGER: public.agent_book_transfers (m661, APPLIED LIVE 2026-09-24). A
// temporary transfer writes its row FIRST (status active, until_at) and only
// then moves anything — if the table is not there yet the transfer refuses
// before a single row moves (fail closed by ordering). The ids of every moved
// row are recorded (COUNTED from `.select("id")`, §3), and the revert moves
// back ONLY rows the covering agent still holds — a row the tenant re-pointed
// during the window stays where the tenant put it and is reported as skipped.
//
// AGENTS SEE CONTACTS ONLY (§5): nothing here changes what a contact row is;
// the covering agent inherits the away agent's CONTACTS (and their open work)
// exactly as a successor does; leads stay the brokerage's and merely follow.
//
// IDENTITY CLASSES (§3): fromAgentId / toAgentId are agents.id; the users.id
// crossing is agents.user_id and is resolved here once. NOT server-only (the
// simulator drives it with an injected client); writes only through the
// caller-supplied service client; the tenant is the caller's SESSION tenant.

import type { SupabaseClient } from "@supabase/supabase-js"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import {
  executeAgentDeactivation, moveAgentWork, emptyMovedWork, TRANSACTION_AGENT_ROLE_COLUMNS,
  proposeCoverIntroductions, proposeSuccessorIntroductions, withdrawCoverIntroductions,
  type MovedWork,
} from "./agent-deactivation"

type Svc = SupabaseClient<any, any, any>

export type BookTransferScope = "temporary" | "permanent"

/** Longest temporary window the tenant may set (a year of leave is a departure). */
export const MAX_TEMPORARY_TRANSFER_DAYS = 365

/** What a transfer moved — the ledger's `moved` jsonb. Contacts join the shared move set here. */
export interface BookTransferMoved extends MovedWork {
  contacts: string[]
}

export interface ReassignAgentBooksInput {
  brokerageId: string
  fromAgentId: string
  toAgentId: string
  scope: BookTransferScope
  /** ISO instant the temporary window ends — required for scope:"temporary". */
  until?: string | null
  reason?: string | null
  actorUserId: string | null
  /** PERMANENT only (wave 82E): move the whole book for good but KEEP the agent
   *  active — a role change (producer → manager / managing broker / staff), a
   *  team restructure, a reduced book. Default false: permanent = "the agent
   *  leaves" and runs the deactivation survivor, as 81A shipped it. */
  keepActive?: boolean
}

export interface ReassignAgentBooksResult {
  ok: boolean
  error?: string
  transferId: string | null
  scope: BookTransferScope
  contacts: number
  leads: number
  dealRoles: number
  tasks: number
  listings: number
  calendarEvents: number
  propertyAlerts: number
  /** temporary: coverage set on the away agent (new leads redirect). */
  coverageSet: boolean
  /** permanent: the agent was deactivated (the deactivation survivor ran). */
  agentDeactivated: boolean
  /** Gated client introductions queued for approval (wave 82E): the covering
   *  agent's temporary intro, or the successor's permanent re-introduction. */
  introductionsProposed: number
  refused: string[]
}

/**
 * PURE: validate the request shape before any read. `now` injected so the
 * proof can pin the window arithmetic.
 */
export function validateBookTransferRequest(
  input: Pick<ReassignAgentBooksInput, "fromAgentId" | "toAgentId" | "scope" | "until">,
  now: Date = new Date(),
): { ok: true; untilIso: string | null } | { ok: false; error: string } {
  if (!input.fromAgentId || !input.toAgentId) return { ok: false, error: "Both the agent whose books move and the agent receiving them are required." }
  if (input.fromAgentId === input.toAgentId) return { ok: false, error: "An agent cannot receive their own books." }
  if (input.scope !== "temporary" && input.scope !== "permanent") return { ok: false, error: `Scope must be temporary or permanent (got '${String(input.scope)}').` }
  if (input.scope === "permanent") return { ok: true, untilIso: null }
  if (!input.until) return { ok: false, error: "A temporary transfer needs an end date — the books revert automatically when it passes." }
  const until = new Date(input.until)
  if (Number.isNaN(until.getTime())) return { ok: false, error: "The end date could not be read." }
  if (until.getTime() <= now.getTime()) return { ok: false, error: "The end date must be in the future." }
  if (until.getTime() - now.getTime() > MAX_TEMPORARY_TRANSFER_DAYS * 86_400_000) {
    return { ok: false, error: `A temporary transfer may run at most ${MAX_TEMPORARY_TRANSFER_DAYS} days — a longer absence is a permanent reassignment.` }
  }
  return { ok: true, untilIso: until.toISOString() }
}

const CHUNK = 200
function chunks<T>(arr: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK))
  return out
}
const idsOf = (rows: unknown): string[] => ((rows ?? []) as Array<{ id: string }>).map((r) => r.id)

async function readTenantAgent(svc: Svc, brokerageId: string, agentId: string) {
  const { data, error } = await svc.from("agents").select("id, user_id, is_active, covering_agent_id, coverage_until")
    .eq("id", agentId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { error: error.message, agent: null }
  return { error: null, agent: (data ?? null) as { id: string; user_id: string | null; is_active: boolean | null; covering_agent_id: string | null; coverage_until: string | null } | null }
}

/**
 * reassignAgentBooks — THE tenant door. Temporary: ledger first, then contacts +
 * the shared move set, then coverage on the away agent; auto-reverts on the
 * daily sweep. Permanent: the deactivation survivor (disposition "reassign")
 * plus a ledger row. Every write counted; audited on lifecycle_events.
 */
export async function reassignAgentBooks(svc: Svc, input: ReassignAgentBooksInput): Promise<ReassignAgentBooksResult> {
  const base: ReassignAgentBooksResult = {
    ok: false, transferId: null, scope: input.scope, contacts: 0, leads: 0, dealRoles: 0, tasks: 0, listings: 0,
    calendarEvents: 0, propertyAlerts: 0, coverageSet: false, agentDeactivated: false, introductionsProposed: 0, refused: [],
  }
  const { brokerageId, actorUserId } = input
  if (!brokerageId) return { ...base, error: "brokerageId is required (the caller's session tenant)." }
  const valid = validateBookTransferRequest(input)
  if (!valid.ok) return { ...base, error: valid.error }

  const [from, to] = await Promise.all([readTenantAgent(svc, brokerageId, input.fromAgentId), readTenantAgent(svc, brokerageId, input.toAgentId)])
  if (from.error) return { ...base, error: `The departing agent could not be read (${from.error}); nothing moved.` }
  if (to.error) return { ...base, error: `The receiving agent could not be read (${to.error}); nothing moved.` }
  if (!from.agent) return { ...base, error: "The agent whose books move is not in your brokerage; nothing moved." }
  if (!to.agent) return { ...base, error: "The receiving agent is not in your brokerage; nothing moved." }
  if (to.agent.is_active === false) return { ...base, error: "The receiving agent is not active; nothing moved." }
  const nowIso = new Date().toISOString()

  // ── PERMANENT, AGENT STAYS (wave 82E) — the same move set as a temporary cover
  //    (contacts whole + moveAgentWork), no coverage, no revert, the SUCCESSOR's
  //    warm re-introduction, and the agent keeps their seat and login. ──
  if (input.scope === "permanent" && input.keepActive === true) {
    const moved: BookTransferMoved = { ...emptyMovedWork(), contacts: [] }
    {
      const { data, error } = await svc.from("contacts")
        .update({ agent_id: to.agent.id, updated_at: nowIso })
        .eq("brokerage_id", brokerageId).eq("agent_id", from.agent.id).is("deleted_at", null)
        .select("id")
      if (error) moved.refused.push(`contacts: ${error.message}`); else moved.contacts = idsOf(data)
    }
    const work = await moveAgentWork(svc, {
      brokerageId, fromAgentId: from.agent.id, fromUserId: from.agent.user_id, toAgentId: to.agent.id, toUserId: to.agent.user_id, nowIso,
    })
    Object.assign(moved, work, { contacts: moved.contacts, refused: [...moved.refused, ...work.refused] })
    const introductionsProposed = await proposeSuccessorIntroductions(svc, {
      brokerageId, successorAgentId: to.agent.id, contactIds: moved.contacts,
    })
    const { data: ledger, error: ledgerErr } = await svc.from("agent_book_transfers").insert({
      brokerage_id: brokerageId, from_agent_id: from.agent.id, to_agent_id: to.agent.id, scope: "permanent", status: "permanent",
      reason: input.reason ?? null, until_at: null, created_by: actorUserId,
      moved: { ...moved, agent_kept_active: true, introductions_proposed: introductionsProposed },
    }).select("id")
    const transferId = idsOf(ledger)[0] ?? null
    if (ledgerErr) moved.refused.push(`agent_book_transfers: ${ledgerErr.message}`)
    await audit(svc, brokerageId, from.agent.id, "agent_books_reassigned", actorUserId, {
      scope: "permanent", agent_kept_active: true, to_agent_id: to.agent.id, transfer_id: transferId, reason: input.reason ?? null,
      contacts: moved.contacts.length, leads: moved.leads.length, deal_roles: moved.transactionRoleMoves,
    })
    if (to.agent.user_id && (moved.contacts.length > 0 || moved.leads.length > 0)) {
      await sentinelWrite(svc, svc.from("notifications").insert({
        user_id: to.agent.user_id, brokerage_id: brokerageId, type: "book_reassigned",
        title: "You've inherited a colleague's book",
        body: `${moved.contacts.length} contact(s) and ${moved.leads.length} lead(s) are now yours for good${moved.transactionRoleMoves > 0 ? `, including ${moved.transactionRoleMoves} in-flight deal role(s) — review those first` : ""}.${introductionsProposed > 0 ? ` ${introductionsProposed} introduction(s) are waiting for your approval.` : ""}`,
        entity_type: "agent", entity_id: from.agent.id, priority: moved.transactionRoleMoves > 0 ? "high" : "medium", is_read: false,
      }), { table: "notifications", flow: "agent_books_permanent_notify", brokerageId, reason: "in-app notification — a lost row is a missed bell, never the transfer it follows" })
    }
    if (moved.transactionRoleMoves > 0) {
      const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
      await publishManagerSignal({
        brokerageId, fromManager: "recruiting_manager", toManager: "deal_coordinator", signalType: "agent_book_reassigned",
        message: `An agent's ${moved.transactionRoleMoves} in-flight deal role(s) moved permanently to a colleague (the agent stays active) — realign the transaction team so nothing slips.`,
        entityType: "agent", entityId: from.agent.id,
        payload: { successor_agent_id: to.agent.id, active_deals: moved.transactionRoleMoves, temporary: false, agent_kept_active: true },
      }, svc)
    }
    return {
      ...base, ok: true, transferId, contacts: moved.contacts.length, leads: moved.leads.length, dealRoles: moved.transactionRoleMoves,
      tasks: moved.tasks.length + moved.transactionTasks.length, listings: moved.listings.length, calendarEvents: moved.calendarEvents.length,
      propertyAlerts: moved.propertyAlerts.length, agentDeactivated: false, introductionsProposed, refused: moved.refused,
    }
  }

  // ── PERMANENT = the deactivation survivor ("an agent leaves") + a ledger row ──
  if (input.scope === "permanent") {
    const res = await executeAgentDeactivation(svc, {
      brokerageId, agentId: from.agent.id, userId: from.agent.user_id, successorAgentId: to.agent.id,
      agentBookDisposition: "reassign", actorUserId,
    })
    if (!res.ok) return { ...base, error: res.reason ?? "The permanent reassignment was refused." }
    const { data: ledger, error: ledgerErr } = await svc.from("agent_book_transfers").insert({
      brokerage_id: brokerageId, from_agent_id: from.agent.id, to_agent_id: to.agent.id, scope: "permanent", status: "permanent",
      reason: input.reason ?? null, until_at: null, created_by: actorUserId,
      moved: {
        contacts_reassigned: res.reassignedContacts, contacts_archived: res.archivedContacts, leads: res.reassignedLeads,
        deal_roles: res.reassignedDealRoles, tasks: res.reassignedOpenTasks, listings: res.reassignedListings,
        calendar_events: res.reassignedCalendarEvents, property_alerts: res.reassignedPropertyAlerts,
      },
    }).select("id")
    const transferId = idsOf(ledger)[0] ?? null
    const refused = [...res.moveRefusals]
    if (ledgerErr) refused.push(`agent_book_transfers: ${ledgerErr.message}`)
    await audit(svc, brokerageId, from.agent.id, "agent_books_reassigned", actorUserId, {
      scope: "permanent", to_agent_id: to.agent.id, transfer_id: transferId, reason: input.reason ?? null,
      contacts: res.reassignedContacts, leads: res.reassignedLeads, deal_roles: res.reassignedDealRoles,
    })
    return {
      ...base, ok: true, transferId, contacts: res.reassignedContacts, leads: res.reassignedLeads, dealRoles: res.reassignedDealRoles,
      tasks: res.reassignedOpenTasks, listings: res.reassignedListings, calendarEvents: res.reassignedCalendarEvents,
      propertyAlerts: res.reassignedPropertyAlerts, agentDeactivated: res.agentDeactivated,
      introductionsProposed: res.reintroductionsProposed, refused,
    }
  }

  // ── TEMPORARY: the ledger row FIRST (fail closed by ordering) ──
  const { data: open, error: openErr } = await svc.from("agent_book_transfers").select("id")
    .eq("brokerage_id", brokerageId).eq("from_agent_id", from.agent.id).eq("status", "active")
  if (openErr) return { ...base, error: `The transfer ledger could not be read (${openErr.message}); nothing moved.` }
  if (idsOf(open).length > 0) return { ...base, error: "This agent's books are already covered by an open temporary transfer — revert it first." }
  const { data: ledger, error: ledgerErr } = await svc.from("agent_book_transfers").insert({
    brokerage_id: brokerageId, from_agent_id: from.agent.id, to_agent_id: to.agent.id, scope: "temporary", status: "active",
    reason: input.reason ?? null, until_at: valid.untilIso, created_by: actorUserId, moved: {},
  }).select("id")
  if (ledgerErr) return { ...base, error: `The transfer could not be recorded (${ledgerErr.message}); nothing moved.` }
  const transferId = idsOf(ledger)[0] ?? null
  if (!transferId) return { ...base, error: "The transfer was not recorded (0 rows); nothing moved." }

  // Contacts in bulk (agents see contacts only — the cover inherits them whole).
  const moved: BookTransferMoved = { ...emptyMovedWork(), contacts: [] }
  {
    const { data, error } = await svc.from("contacts")
      .update({ agent_id: to.agent.id, updated_at: nowIso })
      .eq("brokerage_id", brokerageId).eq("agent_id", from.agent.id).is("deleted_at", null)
      .select("id")
    if (error) moved.refused.push(`contacts: ${error.message}`); else moved.contacts = idsOf(data)
  }
  const work = await moveAgentWork(svc, {
    brokerageId, fromAgentId: from.agent.id, fromUserId: from.agent.user_id, toAgentId: to.agent.id, toUserId: to.agent.user_id, nowIso,
  })
  Object.assign(moved, work, { contacts: moved.contacts, refused: [...moved.refused, ...work.refused] })

  // Coverage on the away agent — the EXISTING new-lead redirect (coverage-mode).
  let coverageSet = false
  {
    const { data, error } = await svc.from("agents")
      .update({ covering_agent_id: to.agent.id, coverage_until: valid.untilIso })
      .eq("id", from.agent.id).eq("brokerage_id", brokerageId)
      .select("id")
    if (error) moved.refused.push(`agents.coverage: ${error.message}`)
    else coverageSet = idsOf(data).length === 1
    if (!error && !coverageSet) moved.refused.push("agents.coverage: 0 rows updated")
  }

  // COVER INTRODUCTIONS (wave 82E) — the covering agent introduces themselves to
  // every client they now hold for the window, through the gated approval rail.
  const introductionsProposed = await proposeCoverIntroductions(svc, {
    brokerageId, coveringAgentId: to.agent.id, awayAgentId: from.agent.id, untilIso: valid.untilIso, contactIds: moved.contacts,
  })

  // Record what moved on the ledger (counted).
  {
    const { data, error } = await svc.from("agent_book_transfers")
      .update({ moved: { ...moved, coverage_set: coverageSet, introductions_proposed: introductionsProposed } })
      .eq("id", transferId).eq("brokerage_id", brokerageId)
      .select("id")
    if (error) moved.refused.push(`agent_book_transfers.moved: ${error.message}`)
    else if (idsOf(data).length !== 1) moved.refused.push("agent_book_transfers.moved: 0 rows updated")
  }

  await audit(svc, brokerageId, from.agent.id, "agent_books_reassigned", actorUserId, {
    scope: "temporary", to_agent_id: to.agent.id, transfer_id: transferId, until: valid.untilIso, reason: input.reason ?? null,
    contacts: moved.contacts.length, leads: moved.leads.length, deal_roles: moved.transactionRoleMoves, coverage_set: coverageSet,
    introductions_proposed: introductionsProposed,
  })
  if (to.agent.user_id && (moved.contacts.length > 0 || moved.leads.length > 0)) {
    await sentinelWrite(svc, svc.from("notifications").insert({
      user_id: to.agent.user_id, brokerage_id: brokerageId, type: "book_reassigned",
      title: "You're covering a colleague's book",
      body: `${moved.contacts.length} contact(s) and ${moved.leads.length} lead(s) are yours until ${valid.untilIso?.slice(0, 10)}${moved.transactionRoleMoves > 0 ? `, including ${moved.transactionRoleMoves} in-flight deal role(s) — review those first` : ""}. They revert automatically when the window ends.`,
      entity_type: "agent", entity_id: from.agent.id, priority: moved.transactionRoleMoves > 0 ? "high" : "medium", is_read: false,
    }), { table: "notifications", flow: "agent_books_cover_notify", brokerageId, reason: "in-app notification — a lost row is a missed bell, never the transfer it follows" })
  }
  if (moved.transactionRoleMoves > 0) {
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    await publishManagerSignal({
      brokerageId, fromManager: "recruiting_manager", toManager: "deal_coordinator", signalType: "agent_book_reassigned",
      message: `An away agent's ${moved.transactionRoleMoves} in-flight deal role(s) moved to a covering agent until ${valid.untilIso?.slice(0, 10)} — realign the transaction team so nothing slips.`,
      entityType: "agent", entityId: from.agent.id,
      payload: { successor_agent_id: to.agent.id, active_deals: moved.transactionRoleMoves, temporary: true, until: valid.untilIso },
    }, svc)
  }

  return {
    ...base, ok: true, transferId, contacts: moved.contacts.length, leads: moved.leads.length, dealRoles: moved.transactionRoleMoves,
    tasks: moved.tasks.length + moved.transactionTasks.length, listings: moved.listings.length, calendarEvents: moved.calendarEvents.length,
    propertyAlerts: moved.propertyAlerts.length, coverageSet, introductionsProposed, refused: moved.refused,
  }
}

export interface RevertBookTransferResult {
  ok: boolean
  error?: string
  transferId: string
  /** Rows moved back per kind (still held by the covering agent). */
  restored: Record<string, number>
  /** Rows the tenant re-pointed during the window — left alone, reported. */
  skipped: Record<string, number>
  coverageCleared: boolean
  /** Cover introductions still awaiting approval, withdrawn for the handed-back clients (wave 82E). */
  introductionsWithdrawn: number
  refused: string[]
}

/**
 * revertBookTransfer — move a TEMPORARY transfer's rows back to the original
 * owner (only the rows the covering agent still holds), clear coverage, close
 * the ledger row. Tenant-scoped; `expired` marks the daily sweep's revert
 * (actor null) apart from an admin's early revert.
 */
export async function revertBookTransfer(
  svc: Svc,
  params: { brokerageId: string; transferId: string; actorUserId: string | null; expired?: boolean },
): Promise<RevertBookTransferResult> {
  const { brokerageId, transferId, actorUserId } = params
  const out: RevertBookTransferResult = { ok: false, transferId, restored: {}, skipped: {}, coverageCleared: false, introductionsWithdrawn: 0, refused: [] }
  const { data: row, error: rowErr } = await svc.from("agent_book_transfers")
    .select("id, from_agent_id, to_agent_id, scope, status, moved, until_at")
    .eq("id", transferId).eq("brokerage_id", brokerageId).maybeSingle()
  if (rowErr) return { ...out, error: `The transfer could not be read (${rowErr.message}); nothing reverted.` }
  if (!row) return { ...out, error: "That transfer is not in your brokerage; nothing reverted." }
  const t = row as { id: string; from_agent_id: string; to_agent_id: string; scope: string; status: string; moved: Partial<BookTransferMoved> | null }
  if (t.scope !== "temporary") return { ...out, error: "A permanent reassignment does not revert — reassign the books again instead." }
  if (t.status !== "active") return { ...out, error: `This transfer is already ${t.status}.` }

  const [from, to] = await Promise.all([readTenantAgent(svc, brokerageId, t.from_agent_id), readTenantAgent(svc, brokerageId, t.to_agent_id)])
  if (from.error || to.error) return { ...out, error: `The agents could not be read (${from.error ?? to.error}); nothing reverted.` }
  if (!from.agent) return { ...out, error: "The original agent is no longer in your brokerage; nothing reverted." }
  const fromUserId = from.agent.user_id
  const toUserId = to.agent?.user_id ?? null
  const nowIso = new Date().toISOString()
  const moved = (t.moved ?? {}) as Partial<BookTransferMoved>

  /** Restore ONE kind: rows in `ids` still owned by the cover → back to the original. */
  const restore = async (kind: string, table: string, ownerCol: string, ownerNow: string | null, ownerBack: string | null, ids: string[] | undefined, patch: Record<string, unknown> = {}) => {
    const list = ids ?? []
    if (list.length === 0 || !ownerNow || !ownerBack) { out.restored[kind] = 0; out.skipped[kind] = list.length; return }
    let restored = 0
    for (const part of chunks(list)) {
      const { data, error } = await svc.from(table)
        .update({ [ownerCol]: ownerBack, ...patch })
        .eq("brokerage_id", brokerageId).eq(ownerCol, ownerNow).in("id", part)
        .select("id")
      if (error) { out.refused.push(`${kind}: ${error.message}`); continue }
      restored += idsOf(data).length
    }
    out.restored[kind] = restored
    out.skipped[kind] = list.length - restored
  }

  await restore("contacts", "contacts", "agent_id", t.to_agent_id, t.from_agent_id, moved.contacts, { updated_at: nowIso })
  await restore("leads", "leads", "agent_id", t.to_agent_id, t.from_agent_id, moved.leads, { updated_at: nowIso })
  for (const col of TRANSACTION_AGENT_ROLE_COLUMNS) {
    await restore(`transactions.${col}`, "transactions", col, t.to_agent_id, t.from_agent_id, moved.transactions?.[col], { updated_at: nowIso })
  }
  await restore("tasks", "tasks", "assigned_to_agent_id", t.to_agent_id, t.from_agent_id, moved.tasks)
  await restore("transaction_tasks", "transaction_tasks", "assigned_user_id", toUserId, fromUserId, moved.transactionTasks)
  await restore("listings", "listings", "agent_id", t.to_agent_id, t.from_agent_id, moved.listings, { updated_at: nowIso })
  await restore("calendar_events", "calendar_events", "agent_user_id", toUserId, fromUserId, moved.calendarEvents)
  await restore("property_alerts", "property_alerts", "agent_user_id", toUserId, fromUserId, moved.propertyAlerts, { updated_at: nowIso })

  // A cover intro still unapproved must not reach a client after the cover ends —
  // for EVERY client the cover was introduced to, including one the tenant
  // re-pointed during the window ("B is covering for A" is wrong for them too).
  {
    const w = await withdrawCoverIntroductions(svc, { brokerageId, contactIds: moved.contacts ?? [] })
    out.introductionsWithdrawn = w.withdrawn
    if (w.error) out.refused.push(`agent_client_messages.withdraw: ${w.error}`)
  }

  // Clear coverage only if it still points at this cover (an admin may have re-covered since).
  {
    const { data, error } = await svc.from("agents")
      .update({ covering_agent_id: null, coverage_until: null })
      .eq("id", t.from_agent_id).eq("brokerage_id", brokerageId).eq("covering_agent_id", t.to_agent_id)
      .select("id")
    if (error) out.refused.push(`agents.coverage: ${error.message}`)
    else out.coverageCleared = idsOf(data).length === 1
  }

  const { data: closed, error: closeErr } = await svc.from("agent_book_transfers")
    .update({ status: "reverted", reverted_at: nowIso, reverted_by: actorUserId, reverted: { restored: out.restored, skipped: out.skipped, expired: !!params.expired, introductions_withdrawn: out.introductionsWithdrawn, refused: out.refused } })
    .eq("id", transferId).eq("brokerage_id", brokerageId).eq("status", "active")
    .select("id")
  if (closeErr) return { ...out, error: `The rows moved back but the ledger could not be closed (${closeErr.message}).` }
  if (idsOf(closed).length !== 1) return { ...out, error: "The rows moved back but the ledger row did not match (0 rows updated)." }

  await audit(svc, brokerageId, t.from_agent_id, "agent_books_reverted", actorUserId, {
    transfer_id: transferId, to_agent_id: t.to_agent_id, expired: !!params.expired, restored: out.restored, skipped: out.skipped,
  })
  out.ok = true
  return out
}

/**
 * revertExpiredBookTransfers — THE DAILY SWEEP (rides /api/cron/capacity-guardian,
 * "50 6 * * *" in lib/kernel/cron-dispatch.ts). Platform-wide: every ACTIVE
 * temporary transfer whose window has passed is reverted under its own
 * tenant id. A refused ledger read (table not yet applied) reports zero WITH
 * the refusal — never a silent clean bill.
 */
export async function revertExpiredBookTransfers(
  svc: Svc,
  now: Date = new Date(),
): Promise<{ due: number; reverted: number; failed: Array<{ transferId: string; error: string }>; readRefused: string | null }> {
  const { data, error } = await svc.from("agent_book_transfers")
    .select("id, brokerage_id")
    .eq("status", "active").lte("until_at", now.toISOString()).limit(500)
  if (error) return { due: 0, reverted: 0, failed: [], readRefused: error.message }
  const rows = (data ?? []) as Array<{ id: string; brokerage_id: string }>
  let reverted = 0
  const failed: Array<{ transferId: string; error: string }> = []
  for (const r of rows) {
    const res = await revertBookTransfer(svc, { brokerageId: r.brokerage_id, transferId: r.id, actorUserId: null, expired: true })
    if (res.ok) reverted += 1
    else failed.push({ transferId: r.id, error: res.error ?? "revert refused" })
  }
  return { due: rows.length, reverted, failed, readRefused: null }
}

export interface BookTransferRow {
  id: string
  fromAgentId: string
  toAgentId: string
  scope: BookTransferScope
  status: string
  untilAt: string | null
  /** The revert stamps (temporary transfers): read here so the ledger's audit half has a reader (wave 81 integration). */
  revertedAt: string | null
  revertedBy: string | null
  reverted: Record<string, unknown> | null
  reason: string | null
  createdAt: string
  moved: Record<string, unknown>
}

/** The tenant's transfers, newest first (active temporary ones first for the revert door). */
export async function listBookTransfers(svc: Svc, brokerageId: string, limit = 50): Promise<{ ok: boolean; error?: string; transfers: BookTransferRow[] }> {
  const { data, error } = await svc.from("agent_book_transfers")
    .select("id, from_agent_id, to_agent_id, scope, status, until_at, reason, created_at, moved, reverted, reverted_at, reverted_by")
    .eq("brokerage_id", brokerageId).order("created_at", { ascending: false }).limit(limit)
  if (error) return { ok: false, error: error.message, transfers: [] }
  const rows = (data ?? []) as Array<{ id: string; from_agent_id: string; to_agent_id: string; scope: BookTransferScope; status: string; until_at: string | null; reverted_at?: string | null; reverted_by?: string | null; reverted?: unknown; reason: string | null; created_at: string; moved: Record<string, unknown> | null }>
  return {
    ok: true,
    transfers: rows
      .map((r) => ({ id: r.id, fromAgentId: r.from_agent_id, toAgentId: r.to_agent_id, scope: r.scope, status: r.status, untilAt: r.until_at, revertedAt: r.reverted_at ?? null, revertedBy: r.reverted_by ?? null, reverted: (r.reverted as Record<string, unknown> | null) ?? null, reason: r.reason, createdAt: r.created_at, moved: r.moved ?? {} }))
      .sort((a, b) => Number(b.status === "active") - Number(a.status === "active")),
  }
}

async function audit(svc: Svc, brokerageId: string, agentId: string, eventType: string, actorUserId: string | null, metadata: Record<string, unknown>) {
  const { error } = await svc.from("lifecycle_events").insert({
    brokerage_id: brokerageId, entity_type: "agent", entity_id: agentId, event_type: eventType,
    actor_user_id: actorUserId, metadata, created_at: new Date().toISOString(),
  })
  if (error) console.warn(`[agent-books] audit ${eventType} refused:`, error.message)
}
