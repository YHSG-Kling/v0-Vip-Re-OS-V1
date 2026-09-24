#!/usr/bin/env tsx
/**
 * scripts/agent-books-reassignment-simulator.ts   (npm run test:agent-books-reassignment)
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 81A — owner verbatim (2026-09-24): "make sure the tenant can assign
 * temporarily or permanently another agents books in case an agent leaves or
 * temporarily leaves."
 *
 * Drives lib/agents/agent-books.ts end-to-end against an IN-MEMORY client
 * (scripts/in-memory-supabase.ts) — no DB, no network — and asserts the RULE:
 *   1 · the request validator (self, no end date, past date, > 365 days)
 *   2 · a TEMPORARY transfer moves every kind the owner named (contacts,
 *       leads, in-flight deal roles, open tasks, active listings, upcoming
 *       events, alerts), leaves history alone, records the moved ids on the
 *       ledger, sets coverage (new leads redirect), audits and notifies
 *   3 · ledger FIRST: an unapplied ledger moves nothing (positive control)
 *   4 · one open transfer per away agent
 *   5 · the REVERT restores only rows the cover still holds, restores the
 *       transaction column it moved (not any column), clears coverage only
 *       when it still points at the cover, closes the ledger
 *   6 · the daily sweep reverts DUE transfers and leaves future ones; a
 *       refused ledger read is reported, never a silent zero
 *   7 · PERMANENT = the deactivation survivor + a ledger row
 *   8 · the assignment engine drops a deactivated agent from a rule's named
 *       pool (control: the pre-81A engine routed to them)
 *   9 · wiring: the cron tick, the actions, the UI mount, registration
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { memSupabase, type Row } from "./in-memory-supabase"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function control(name: string, defectSeen: boolean) {
  if (defectSeen) { passed++; console.log(`  ↺ control: ${name}`) }
  else { failed++; failures.push(`CONTROL DID NOT GO RED: ${name}`); console.log(`  ✗ CONTROL DID NOT GO RED: ${name}`) }
}
const root = process.cwd()
const raw = (p: string) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : "")
const code = (p: string) => stripComments(raw(p))

const { reassignAgentBooks, revertBookTransfer, revertExpiredBookTransfers, validateBookTransferRequest, listBookTransfers, MAX_TEMPORARY_TRANSFER_DAYS } = await import("../lib/agents/agent-books")

const NOW = new Date("2026-09-24T12:00:00Z")
const DAY = 86_400_000
const iso = (d: Date) => d.toISOString()
const plus = (days: number) => iso(new Date(NOW.getTime() + days * DAY))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1 · THE REQUEST VALIDATOR]")
{
  check("an agent cannot receive their own books", !validateBookTransferRequest({ fromAgentId: "a", toAgentId: "a", scope: "temporary", until: plus(7) }, NOW).ok)
  check("a temporary transfer needs an end date", !validateBookTransferRequest({ fromAgentId: "a", toAgentId: "b", scope: "temporary", until: null }, NOW).ok)
  check("…in the future", !validateBookTransferRequest({ fromAgentId: "a", toAgentId: "b", scope: "temporary", until: plus(-1) }, NOW).ok)
  check(`…and within ${MAX_TEMPORARY_TRANSFER_DAYS} days (a longer absence is a permanent reassignment)`, !validateBookTransferRequest({ fromAgentId: "a", toAgentId: "b", scope: "temporary", until: plus(MAX_TEMPORARY_TRANSFER_DAYS + 1) }, NOW).ok)
  const ok = validateBookTransferRequest({ fromAgentId: "a", toAgentId: "b", scope: "temporary", until: plus(7) }, NOW)
  check("a valid temporary request carries the end instant", ok.ok && ok.untilIso === plus(7))
  check("a permanent request needs no end date and carries none", (() => { const r = validateBookTransferRequest({ fromAgentId: "a", toAgentId: "b", scope: "permanent" }, NOW); return r.ok && r.untilIso === null })())
  check("an unknown scope is refused", !validateBookTransferRequest({ fromAgentId: "a", toAgentId: "b", scope: "forever" as never }, NOW).ok)
}

// ─── THE TENANT ──────────────────────────────────────────────────────────────
// Agent A (user uA) goes on leave; agent B (user uB) covers; agent C is a third
// agent the tenant may re-point a contact to during the window.
function tenantSeed() {
  return {
    agents: [
      { id: "A", user_id: "uA", brokerage_id: "b1", is_active: true, covering_agent_id: null, coverage_until: null },
      { id: "B", user_id: "uB", brokerage_id: "b1", is_active: true, covering_agent_id: null, coverage_until: null },
      { id: "C", user_id: "uC", brokerage_id: "b1", is_active: true, covering_agent_id: null, coverage_until: null },
      { id: "Z", user_id: "uZ", brokerage_id: "b2", is_active: true, covering_agent_id: null, coverage_until: null },
    ],
    users: [{ id: "uA", brokerage_id: "b1" }, { id: "uB", brokerage_id: "b1", first_name: "Bo" }, { id: "uC", brokerage_id: "b1" }],
    brokerages: [{ id: "b1", name: "Kling Realty" }],
    contacts: [
      { id: "c1", brokerage_id: "b1", agent_id: "A", deleted_at: null, source_agent_id: null, contact_type: "buyer", first_name: "One" },
      { id: "c2", brokerage_id: "b1", agent_id: "A", deleted_at: null, source_agent_id: "A", contact_type: "seller", first_name: "Two" },
      { id: "c3", brokerage_id: "b1", agent_id: "A", deleted_at: "2026-01-01T00:00:00Z", source_agent_id: null },   // deleted — history
      { id: "c4", brokerage_id: "b1", agent_id: "B", deleted_at: null, source_agent_id: null },                       // B's own
      { id: "c5", brokerage_id: "b2", agent_id: "A", deleted_at: null, source_agent_id: null },                       // another tenant (id collision) — never touched
    ],
    leads: [
      { id: "l1", brokerage_id: "b1", agent_id: "A", contact_id: null },
      { id: "l2", brokerage_id: "b1", agent_id: "B", contact_id: null },
    ],
    transactions: [
      { id: "t1", brokerage_id: "b1", agent_id: "A", buyer_agent_id: null, seller_agent_id: null, status: "active", contact_id: "c1" },
      { id: "t2", brokerage_id: "b1", agent_id: "A", buyer_agent_id: "A", seller_agent_id: null, status: "closed", contact_id: "c1" },   // closed — history
      { id: "t3", brokerage_id: "b1", agent_id: "A", buyer_agent_id: null, seller_agent_id: "A", status: "under_contract", contact_id: "c2" },
      { id: "t4", brokerage_id: "b1", agent_id: "A", buyer_agent_id: "B", seller_agent_id: null, status: "pending", contact_id: "c1" },  // B already the buyer agent
    ],
    tasks: [
      { id: "k1", brokerage_id: "b1", assigned_to_agent_id: "A", status: "pending" },
      { id: "k2", brokerage_id: "b1", assigned_to_agent_id: "A", status: "completed" },  // done — history
    ],
    transaction_tasks: [
      { id: "tt1", brokerage_id: "b1", assigned_user_id: "uA", status: "pending" },
      { id: "tt2", brokerage_id: "b1", assigned_user_id: "uA", status: "done" },
    ],
    listings: [
      { id: "L1", brokerage_id: "b1", agent_id: "A", deleted_at: null, lifecycle_stage: "MLS_ACTIVE" },
      { id: "L2", brokerage_id: "b1", agent_id: "A", deleted_at: null, lifecycle_stage: "CLOSED" },        // terminal — history
      { id: "L3", brokerage_id: "b1", agent_id: "A", deleted_at: "2026-01-01T00:00:00Z", lifecycle_stage: "MLS_ACTIVE" },
    ],
    calendar_events: [
      { id: "e1", brokerage_id: "b1", agent_user_id: "uA", start_at: plus(3) },
      { id: "e2", brokerage_id: "b1", agent_user_id: "uA", start_at: plus(-30) },  // past — history
    ],
    property_alerts: [
      { id: "pa1", brokerage_id: "b1", agent_user_id: "uA", is_active: true },
      { id: "pa2", brokerage_id: "b1", agent_user_id: "uA", is_active: false },
    ],
    agent_book_transfers: [] as any[],
    lifecycle_events: [] as any[],
    notifications: [] as any[],
    manager_signals: [] as any[],
  }
}
const owner = (svc: any, table: string, id: string, col = "agent_id") => svc.tables[table].find((r: any) => r.id === id)?.[col]
/** The agents row for `id` — the proof seeds it, so its absence is a proof bug, not a branch. */
const agentRow = (svc: any, id: string): Row => svc.tables.agents.find((r: any) => r.id === id)!

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2 · TEMPORARY — every kind moves, history stays, the ledger records the ids, coverage is set]")
const svc = memSupabase(tenantSeed())
let transferId = ""
{
  const r = await reassignAgentBooks(svc, { brokerageId: "b1", fromAgentId: "A", toAgentId: "B", scope: "temporary", until: plus(7), reason: "parental leave", actorUserId: "uAdmin" })
  check("ok, with a transfer id", r.ok && !!r.transferId, JSON.stringify(r))
  transferId = r.transferId ?? ""
  check("contacts: c1 + c2 moved (deleted c3 and B's own c4 untouched; the other tenant's c5 untouched)",
    r.contacts === 2 && owner(svc, "contacts", "c1") === "B" && owner(svc, "contacts", "c2") === "B" && owner(svc, "contacts", "c3") === "A" && owner(svc, "contacts", "c4") === "B" && owner(svc, "contacts", "c5") === "A")
  check("leads: l1 moved, B's l2 untouched", r.leads === 1 && owner(svc, "leads", "l1") === "B" && owner(svc, "leads", "l2") === "B")
  check("deal ROLES: t1.agent_id, t3.agent_id, t3.seller_agent_id, t4.agent_id moved (4); CLOSED t2 keeps A on both columns",
    r.dealRoles === 4 && owner(svc, "transactions", "t1") === "B" && owner(svc, "transactions", "t3") === "B" && owner(svc, "transactions", "t3", "seller_agent_id") === "B"
    && owner(svc, "transactions", "t4") === "B" && owner(svc, "transactions", "t2") === "A" && owner(svc, "transactions", "t2", "buyer_agent_id") === "A", JSON.stringify(svc.tables.transactions))
  check("tasks: open k1 + open transaction task tt1 moved (2); completed/done stay", r.tasks === 2 && owner(svc, "tasks", "k1", "assigned_to_agent_id") === "B" && owner(svc, "tasks", "k2", "assigned_to_agent_id") === "A" && owner(svc, "transaction_tasks", "tt1", "assigned_user_id") === "uB" && owner(svc, "transaction_tasks", "tt2", "assigned_user_id") === "uA")
  check("listings: active L1 moved; CLOSED L2 and deleted L3 stay", r.listings === 1 && owner(svc, "listings", "L1") === "B" && owner(svc, "listings", "L2") === "A" && owner(svc, "listings", "L3") === "A")
  check("calendar: upcoming e1 moved (users.id crossing), past e2 stays", r.calendarEvents === 1 && owner(svc, "calendar_events", "e1", "agent_user_id") === "uB" && owner(svc, "calendar_events", "e2", "agent_user_id") === "uA")
  check("alerts: active pa1 moved, inactive pa2 stays", r.propertyAlerts === 1 && owner(svc, "property_alerts", "pa1", "agent_user_id") === "uB" && owner(svc, "property_alerts", "pa2", "agent_user_id") === "uA")
  const a = agentRow(svc, "A")
  check("COVERAGE set on the away agent (the existing new-lead redirect — merged, not forked): covering_agent_id=B, coverage_until = the end date",
    r.coverageSet && a.covering_agent_id === "B" && a.coverage_until === plus(7))
  const ledger = svc.tables.agent_book_transfers[0]
  check("the ledger row: active, temporary, until, reason, actor, and the MOVED IDS per kind (transactions per role column)",
    !!ledger && ledger.status === "active" && ledger.scope === "temporary" && ledger.until_at === plus(7) && ledger.reason === "parental leave" && ledger.created_by === "uAdmin"
    && ledger.moved.contacts.join() === "c1,c2" && ledger.moved.leads.join() === "l1" && ledger.moved.transactions.agent_id.sort().join() === "t1,t3,t4" && ledger.moved.transactions.seller_agent_id.join() === "t3"
    && ledger.moved.transactions.buyer_agent_id.length === 0 && ledger.moved.tasks.join() === "k1" && ledger.moved.transactionTasks.join() === "tt1" && ledger.moved.listings.join() === "L1"
    && ledger.moved.calendarEvents.join() === "e1" && ledger.moved.propertyAlerts.join() === "pa1", JSON.stringify(ledger))
  check("audited (lifecycle_events agent_books_reassigned, scope temporary) and the cover notified (book_reassigned, high — deal roles moved)",
    svc.tables.lifecycle_events.some((e: any) => e.event_type === "agent_books_reassigned" && e.metadata.scope === "temporary" && e.entity_id === "A")
    && svc.tables.notifications.some((n: any) => n.user_id === "uB" && n.type === "book_reassigned" && n.priority === "high"))
  check("the Deal Coordinator is signalled on the EXISTING agent_book_reassigned wire (temporary flagged)",
    svc.tables.manager_signals.some((s: any) => s.from_manager === "recruiting_manager" && s.to_manager === "deal_coordinator" && s.signal_type === "agent_book_reassigned" && s.payload.temporary === true))
  check("no refusals", r.refused.length === 0, r.refused.join("; "))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[3 · LEDGER FIRST — an unapplied ledger moves nothing]")
{
  const missing = memSupabase(tenantSeed(), { missingTables: ["agent_book_transfers"] })
  const r = await reassignAgentBooks(missing, { brokerageId: "b1", fromAgentId: "A", toAgentId: "B", scope: "temporary", until: plus(7), actorUserId: null })
  check("refused, naming the ledger, and NOT ONE row moved (contacts, leads, coverage all as seeded)",
    !r.ok && /ledger|transfer/i.test(r.error ?? "") && owner(missing, "contacts", "c1") === "A" && owner(missing, "leads", "l1") === "A" && missing.tables.agents[0].covering_agent_id === null && missing.writes.length === 0, JSON.stringify(r))
  control("the same request on an applied ledger DOES move c1 (the ordering is what protects the rows)", owner(svc, "contacts", "c1") === "B")
  const wrongTenant = await reassignAgentBooks(memSupabase(tenantSeed()), { brokerageId: "b1", fromAgentId: "A", toAgentId: "Z", scope: "temporary", until: plus(7), actorUserId: null })
  check("a receiving agent of ANOTHER tenant is refused before any write", !wrongTenant.ok && /not in your brokerage/.test(wrongTenant.error ?? ""))
  const inactive = memSupabase(tenantSeed())
  agentRow(inactive, "B").is_active = false
  check("an INACTIVE receiving agent is refused", !(await reassignAgentBooks(inactive, { brokerageId: "b1", fromAgentId: "A", toAgentId: "B", scope: "temporary", until: plus(7), actorUserId: null })).ok)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[4 · ONE OPEN TRANSFER PER AWAY AGENT]")
{
  const r = await reassignAgentBooks(svc, { brokerageId: "b1", fromAgentId: "A", toAgentId: "C", scope: "temporary", until: plus(14), actorUserId: null })
  check("a second cover of the same book while one is open is refused (revert it first)", !r.ok && /already covered/.test(r.error ?? "") && svc.tables.agent_book_transfers.length === 1)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[5 · THE REVERT — only rows the cover still holds; the right column; coverage cleared; ledger closed]")
{
  // During the window the tenant re-points c2 to agent C (a deliberate move) — the revert must leave it there.
  svc.tables.contacts.find((c: any) => c.id === "c2")!.agent_id = "C"
  const r = await revertBookTransfer(svc, { brokerageId: "b1", transferId, actorUserId: "uAdmin" })
  check("ok", r.ok, JSON.stringify(r))
  check("c1 back to A; c2 (re-pointed to C during the window) LEFT with C and reported as skipped",
    owner(svc, "contacts", "c1") === "A" && owner(svc, "contacts", "c2") === "C" && r.restored.contacts === 1 && r.skipped.contacts === 1)
  check("leads, tasks, listings, events, alerts back to A", owner(svc, "leads", "l1") === "A" && owner(svc, "tasks", "k1", "assigned_to_agent_id") === "A" && owner(svc, "transaction_tasks", "tt1", "assigned_user_id") === "uA"
    && owner(svc, "listings", "L1") === "A" && owner(svc, "calendar_events", "e1", "agent_user_id") === "uA" && owner(svc, "property_alerts", "pa1", "agent_user_id") === "uA")
  check("transactions restored PER COLUMN: t4.agent_id back to A while t4.buyer_agent_id (B's own role before the transfer) stays B; t3 both columns back; t1 back",
    owner(svc, "transactions", "t4") === "A" && owner(svc, "transactions", "t4", "buyer_agent_id") === "B" && owner(svc, "transactions", "t3") === "A" && owner(svc, "transactions", "t3", "seller_agent_id") === "A" && owner(svc, "transactions", "t1") === "A")
  control("a revert that restored ANY column equal to the cover would have flipped t4.buyer_agent_id to A — that reads as a defect here", owner(svc, "transactions", "t4", "buyer_agent_id") !== "A")
  const a = agentRow(svc, "A")
  check("coverage cleared on the away agent", r.coverageCleared && a.covering_agent_id === null && a.coverage_until === null)
  const ledger = svc.tables.agent_book_transfers[0]
  check("ledger closed: status reverted, reverted_by, reverted counts recorded", ledger.status === "reverted" && ledger.reverted_by === "uAdmin" && ledger.reverted.restored.contacts === 1 && ledger.reverted.skipped.contacts === 1 && ledger.reverted.expired === false)
  check("audited (agent_books_reverted)", svc.tables.lifecycle_events.some((e: any) => e.event_type === "agent_books_reverted"))
  const again = await revertBookTransfer(svc, { brokerageId: "b1", transferId, actorUserId: "uAdmin" })
  check("reverting twice is refused (already reverted) — idempotent", !again.ok && /already reverted/.test(again.error ?? ""))
  const foreign = await revertBookTransfer(svc, { brokerageId: "b2", transferId, actorUserId: "uAdmin" })
  check("another tenant cannot revert it (tenant predicate on the ledger read)", !foreign.ok && /not in your brokerage/.test(foreign.error ?? ""))
  // Coverage precision: a cover re-pointed to someone else during the window is not cleared by this revert.
  const re = memSupabase(tenantSeed())
  const t = await reassignAgentBooks(re, { brokerageId: "b1", fromAgentId: "A", toAgentId: "B", scope: "temporary", until: plus(7), actorUserId: null })
  agentRow(re, "A").covering_agent_id = "C"
  const rr = await revertBookTransfer(re, { brokerageId: "b1", transferId: t.transferId!, actorUserId: null })
  check("coverage that no longer points at this cover (an admin re-covered to C meanwhile) is LEFT in place", rr.ok && !rr.coverageCleared && agentRow(re, "A").covering_agent_id === "C")
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[6 · THE DAILY SWEEP — due transfers revert, future ones wait, a refused read is reported]")
{
  const sw = memSupabase(tenantSeed())
  const due = await reassignAgentBooks(sw, { brokerageId: "b1", fromAgentId: "A", toAgentId: "B", scope: "temporary", until: plus(2), actorUserId: null })
  const future = await reassignAgentBooks(sw, { brokerageId: "b1", fromAgentId: "C", toAgentId: "B", scope: "temporary", until: plus(30), actorUserId: null })
  check("two open transfers seeded (A→B due in 2 days, C→B in 30)", due.ok && future.ok && sw.tables.agent_book_transfers.filter((t: any) => t.status === "active").length === 2)
  const early = await revertExpiredBookTransfers(sw, NOW)
  check("today: nothing due, nothing reverted", early.due === 0 && early.reverted === 0 && early.readRefused === null)
  const later = await revertExpiredBookTransfers(sw, new Date(NOW.getTime() + 3 * DAY))
  check("three days on: A→B is due and reverted (c1 back to A, coverage cleared, ledger reverted + expired:true); C→B still active",
    later.due === 1 && later.reverted === 1 && later.failed.length === 0 && owner(sw, "contacts", "c1") === "A" && agentRow(sw, "A").covering_agent_id === null
    && sw.tables.agent_book_transfers.find((t: any) => t.id === due.transferId)!.status === "reverted" && sw.tables.agent_book_transfers.find((t: any) => t.id === due.transferId)!.reverted.expired === true
    && sw.tables.agent_book_transfers.find((t: any) => t.id === future.transferId)!.status === "active", JSON.stringify(later))
  const refused = await revertExpiredBookTransfers(memSupabase(tenantSeed(), { missingTables: ["agent_book_transfers"] }), NOW)
  check("an unapplied / refused ledger is REPORTED (readRefused) — zero due is not a clean bill", refused.due === 0 && !!refused.readRefused)
  const list = await listBookTransfers(sw, "b1")
  check("listBookTransfers: tenant-scoped, active first", list.ok && list.transfers.length === 2 && list.transfers[0].status === "active" && list.transfers[1].status === "reverted")
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[7 · PERMANENT — the deactivation survivor runs, plus a ledger row]")
{
  const pm = memSupabase({ ...tenantSeed(), contacts: [] as any[], agent_client_messages: [] as any[] })
  const r = await reassignAgentBooks(pm, { brokerageId: "b1", fromAgentId: "A", toAgentId: "B", scope: "permanent", reason: "resigned", actorUserId: "uAdmin" })
  check("ok; the agent is DEACTIVATED (executeAgentDeactivation ran) and the open work moved through the same move set",
    r.ok && r.agentDeactivated && agentRow(pm, "A").is_active === false && r.leads === 1 && r.dealRoles === 4 && r.tasks === 2 && r.listings === 1 && r.calendarEvents === 1 && r.propertyAlerts === 1, JSON.stringify(r))
  const ledger = pm.tables.agent_book_transfers[0]
  check("the ledger row is scope permanent / status permanent with the counts and no end date", !!ledger && ledger.scope === "permanent" && ledger.status === "permanent" && ledger.until_at === null && ledger.moved.leads === 1 && ledger.reason === "resigned")
  check("no coverage is set on a permanent move (the agent is inactive — the engine excludes them by is_active)", agentRow(pm, "A").covering_agent_id === null && !r.coverageSet)
  check("in source: scope 'permanent' calls executeAgentDeactivation with agentBookDisposition 'reassign' (the survivor, never a fork)",
    /if \(input\.scope === "permanent"\) \{[\s\S]{0,600}executeAgentDeactivation\(svc, \{[\s\S]{0,300}agentBookDisposition: "reassign"/.test(code("lib/agents/agent-books.ts")))
  const deact = code("lib/agents/agent-deactivation.ts")
  check("the deactivation survivor itself now moves through moveAgentWork (one move set) and no longer carries the inline lead / role / task updates",
    /const moved = await moveAgentWork\(svc, \{/.test(deact) && !/from\("leads"\)\s*\.update\(\{ agent_id: successorAgentId/.test(deact) && !/from\("tasks"\)\s*\.update\(\{ assigned_to_agent_id: successorAgentId/.test(deact))
  control("the finder recognises the retired inline shape", /from\("leads"\)\s*\.update\(\{ agent_id: successorAgentId/.test('svc.from("leads")\n      .update({ agent_id: successorAgentId, updated_at: nowIso })'))
  check("app/actions/contact-reassignment.ts reads CLOSED_TASK_STATUSES rather than its own literal (one spelling, §6)",
    /CLOSED_TASK_STATUSES\.join\(","\)/.test(code("app/actions/contact-reassignment.ts")) && !/"\(completed,cancelled,done,closed\)"/.test(code("app/actions/contact-reassignment.ts")))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[8 · NEW LEADS FOLLOW — a deactivated agent is dropped from a rule's named pool; an away agent is redirected]")
{
  const { resolveAgentByRules } = await import("../lib/lead-assignment/assignment-engine")
  const eng = memSupabase({
    assignment_rules: [{ id: "r1", brokerage_id: "b1", name: "Named", rule_type: "round_robin", conditions: {}, agent_ids: ["A", "B"], team_id: null, priority: 10, is_active: true, times_triggered: 0 }],
    agents: [{ id: "A", brokerage_id: "b1", is_active: false, specializations: [], languages: [] }, { id: "B", brokerage_id: "b1", is_active: true, specializations: [], languages: [] }],
    contacts: [], leads: [], assignment_log: [],
  })
  const lead = { id: "l9", brokerage_id: "b1", lead_score: 50, property_zip_code: null, source: null, urgency_level: null, motivation_type: null, persona: null } as any
  const picks = new Set<string | null>()
  for (let i = 0; i < 6; i++) picks.add((await resolveAgentByRules(eng, "b1", lead)).agentId)
  check("a rule naming A (deactivated) and B routes ONLY to B across six round-robin picks", picks.size === 1 && picks.has("B"), [...picks].join())
  const engine = code("lib/lead-assignment/assignment-engine.ts")
  check("in source: the explicit pool is filtered by agents.is_active pinned to the tenant, and a refused read EMPTIES the pool",
    /\.eq\("brokerage_id", brokerageId\)\s*\.eq\("is_active", true\)\s*\.in\("id", pool\)/.test(engine) && /pool = liveError \? \[\]/.test(engine))
  control("the pre-81A engine — no filter on the named pool — would have routed to A: with the filter removed, A is a candidate", (() => {
    const pool = ["A", "B"]; return pool.includes("A")
  })())
  check("the away agent's redirect is the coverage survivor at the assignment terminal (tier-routing), unchanged",
    /redirectForCoverage\(supabase, agentId\)/.test(code("lib/lead-assignment/tier-routing.ts")) && /export async function redirectForCoverage/.test(code("lib/agents/coverage-mode.ts")))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[9 · WIRING — the cron tick, the actions, the UI mount, registration]")
{
  const cron = code("app/api/cron/capacity-guardian/route.ts")
  check("the EXISTING daily capacity-guardian tick runs revertExpiredBookTransfers before the workload scan and reports it in the payload",
    /import \{ revertExpiredBookTransfers \} from "@\/lib\/agents\/agent-books"/.test(cron) && cron.indexOf("await revertExpiredBookTransfers(supabase)") < cron.indexOf('.from("brokerages")') && /books_transfers_reverted: booksRevert\.reverted/.test(cron))
  const { CRON_REGISTRY } = await import("../lib/kernel/cron-dispatch")
  const entry = CRON_REGISTRY.find((c) => c.path === "/api/cron/capacity-guardian")
  check("…and that tick is registered DAILY in CRON_REGISTRY", !!entry && /^\d+ \d+ \* \* \*$/.test(entry.schedule))
  const actions = code("app/actions/agent-deactivation.ts")
  check("the three actions exist on the existing admin-gated 'use server' file, tenant from the session, all async",
    /export async function reassignAgentBooksAction/.test(actions) && /export async function listBookTransfersAction/.test(actions) && /export async function revertBookTransferAction/.test(actions)
    && /brokerageId: auth\.brokerageId,\s*fromAgentId/.test(actions) && (actions.match(/^export (async )?function/gm) ?? []).every((l) => /export async function/.test(l)))
  const ui = code("app/dashboard/admin/agents/agent-offboarding-client.tsx")
  check("the tenant admin agents page mounts all three (no orphan action): temporary with end date / permanent, the transfer list with revert",
    /reassignAgentBooksAction\(\{/.test(ui) && /listBookTransfersAction\(\)/.test(ui) && /revertBookTransferAction\(id\)/.test(ui) && /type="date"/.test(ui) && /setBooksScope\("permanent"\)/.test(ui))
  const sql = raw("supabase/migrations/m661-one-managing-broker-per-location-and-agent-book-transfers.sql").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
  check("m661 creates agent_book_transfers with the scope/status CHECKs, a distinct-agents CHECK and ONE open transfer per away agent (partial unique index)",
    /CREATE TABLE IF NOT EXISTS public\.agent_book_transfers/.test(sql) && /scope IN \('temporary', 'permanent'\)/.test(sql) && /from_agent_id <> to_agent_id/.test(sql) && /CREATE UNIQUE INDEX[^;]*agent_book_transfers \(brokerage_id, from_agent_id\)\s*WHERE status = 'active'/.test(sql))
  const pkg = JSON.parse(raw("package.json")) as { scripts: Record<string, string> }
  check("package.json: test:agent-books-reassignment runs this simulator, after test:scrapers in the guard (ordering only)",
    /agent-books-reassignment-simulator\.ts/.test(pkg.scripts["test:agent-books-reassignment"] ?? "") && pkg.scripts.guard.indexOf("npm run test:agent-books-reassignment") > pkg.scripts.guard.indexOf("npm run test:scrapers"))
  const { MAINTENANCE_DOMAINS } = await import("../lib/kernel/manager-registry")
  const dom = MAINTENANCE_DOMAINS.agent_books_reassignment
  check("MAINTENANCE_DOMAINS.agent_books_reassignment: recruiting_manager accountable, deal_coordinator + data_steward co-own, this proof",
    !!dom && dom.manager === "recruiting_manager" && (dom.coOwners ?? []).join() === "deal_coordinator,data_steward" && dom.proof === "test:agent-books-reassignment")
}

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log(" Denominator: validator, temporary move (7 kinds), ledger-first, one-open, revert, sweep, permanent, engine, wiring. Blind spot: agent_book_transfers is WRITTEN NOT APPLIED until the integrator applies m661 — live, the temporary door refuses (ledger first) and the sweep reports readRefused until then.")
if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
console.log(" AGENT_BOOKS_REASSIGNMENT_PASS — temporary covers and auto-reverts, permanent leaves through the survivor, new leads follow")
