#!/usr/bin/env tsx
/**
 * scripts/capability-closure-guard.ts   (npm run test:capability-closure — pure, no DB, no network; memSupabase)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 147, LANE 147H — CAPABILITY CLOSURE + THE SUPPORT-TICKET CLOSED LOOP.
 *
 * Owner ruling 9 (2026-10-31): "Build the missing capabilities and the ones that say 'not available yet'. Every
 * exposed function works, gives an honest configuration message, or leaves the advertised launch surface."
 * Owner ruling 15: "Support tickets are a closed loop: intake → AI triage → manager action → human escalation →
 * closure; no stranded ticket."
 *
 *   A  CLASSIFICATION — every honest-state sentence (scripts/ui-capability-surface-audit.ts classifySites) sits in
 *      exactly one of the five classes; no "not available yet" sentence exists without a row; the nine files the
 *      brief names are each closed or classified; every closed surface carries its fix (old copy gone, survivor
 *      present). Positive control: an unlisted sentence reads UNCLASSIFIED.
 *   B  THE SUPPORT LOOP, END TO END on memSupabase: inbound intake (C1 → openInboundSupportTicket: refusals by name,
 *      replay = the same ticket) → the REAL AI triage (stub model) → the owner's inbox → the SLA sweep (first tier) →
 *      the loop sweep (second tier, re-triage, repair, auto-close) → the requester reopens → closure with ledger +
 *      evidence. Ends with the census: NO ticket in the fixture is stranded (supportTicketLoopState), with a positive
 *      control that a sweep that cannot move a ticket leaves it named in strandedLeft.
 *   C  THE DOORS, on STRIPPED source (they need a request): the office status door stamps resolved_at and ledgers;
 *      the cron runs the loop sweep after the SLA sweep; the triage prompt is expert and structured (seven sections).
 *   D  THE BUILT CAPABILITIES: vendor portfolio (m906 store, gate-first writer, ledgered) and the title closing
 *      appointment (gate-first, ledgered, never writes transactions.close_date) — static, positive controls.
 *
 * BLIND SPOTS (§2): the doors are read statically (no session in a script); memSupabase honours only the PostgREST
 * grammar it implements (anything else throws); the model is a stub (the routed lane is test:ai-by-your-side's).
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import { classifySites, CLOSED_THIS_WAVE, NOT_AVAILABLE, SURFACE_CLASSES } from "./ui-capability-surface-audit"
import {
  triageSupportTicket, handleSupportTicketTriaged, openInboundSupportTicket, TRIAGE_OWNER_BY_CATEGORY, type TriageModelOutput,
} from "../lib/support/ticket-triage"
import {
  runSupportSlaSweep, runSupportLoopSweep, supportTicketCompletion, SLA_TARGETS_HOURS, RESOLVED_AUTO_CLOSE_DAYS, TRIAGE_GRACE_MINUTES,
} from "../lib/support/support-sla"
/** The loop's PUBLISHED reading: the recovery sweep in dry-run mode (reads, places every ticket, acts on nothing). */
const statesOf = async (svc: any) => (await runSupportLoopSweep(svc, { now: NOW, dryRun: true })).states
import { postTicketReply } from "../lib/support/support-thread"

const ROOT = process.cwd()
let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; fails.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), "utf8") : "")
const code = (p: string) => stripComments(read(p))
const tokens = (p: string) => blankStrings(stripComments(read(p)))

type Row = Record<string, any>
const B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", EMPTY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", P = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const AGENT_U = "11111111-1111-4111-8111-111111111111", ADMIN_U = "22222222-2222-4222-8222-222222222222", STAFF_U = "33333333-3333-4333-8333-333333333333"
const CONTACT_U = "44444444-4444-4444-8444-444444444444", FOREIGN_U = "55555555-5555-4555-8555-555555555555", LONELY_U = "66666666-6666-4666-8666-666666666666"
const NOW = new Date("2026-10-31T12:00:00.000Z")
const hoursAgo = (h: number, from = NOW) => new Date(from.getTime() - h * 3_600_000).toISOString()
const later = (h: number) => new Date(NOW.getTime() + h * 3_600_000)

function client(seed: Record<string, Row[]> = {}) {
  const svc = memSupabase({
    support_tickets: [], support_ticket_messages: [], knowledge_articles: [], help_topics_kb: [], lifecycle_events: [], manager_signals: [], notifications: [], agent_action_ledger: [], agents: [],
    users: [
      { id: AGENT_U, brokerage_id: B, user_type: "agent", platform_role: null },
      { id: ADMIN_U, brokerage_id: B, user_type: "broker", platform_role: null },
      { id: STAFF_U, brokerage_id: P, user_type: "agent", platform_role: "support" },
      { id: CONTACT_U, brokerage_id: B, user_type: "contact", platform_role: null },
      { id: FOREIGN_U, brokerage_id: OTHER, user_type: "agent", platform_role: null },
      { id: LONELY_U, brokerage_id: EMPTY, user_type: "agent", platform_role: null },
    ],
    ...seed,
  }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] } })
  ;(svc as any).rpc = async () => ({ data: null, error: null })
  const orig = svc.from.bind(svc)
  ;(svc as any).from = (table: string) => {
    const q: any = orig(table)
    // The live manager_signals.status DEFAULT 'open' — the bus's dedupe and the tick both read it.
    if (table === "manager_signals") { const ins = q.insert.bind(q); q.insert = (p: any) => ins(Array.isArray(p) ? p.map((r: any) => ({ status: "open", ...r })) : { status: "open", ...p }) }
    return q
  }
  return svc
}
const verdict = (o: Partial<TriageModelOutput> = {}): TriageModelOutput => ({ category: "technical", priority: "medium", operation: null, summary: "The e-sign step does not render on the listing forms", answer: null, groundedIn: [], needsHuman: true, confidence: 0.7, ...o })
const allow = async () => ({ allowed: true, reason: "subscription_current" })
const stubTriage = (svc: any, input: any) => triageSupportTicket(svc, input, { afford: allow, model: async () => verdict(), now: NOW })
const tickets = (svc: any) => svc.tables.support_tickets as Row[]
const notes = (svc: any, type?: string, entity?: string) => (svc.tables.notifications as Row[]).filter((n) => (!type || n.type === type) && (!entity || n.entity_id === entity))
const evidenceOf = (svc: any, id: string) => {
  const ns = notes(svc, undefined, id).map((n) => n.type)
  const kinds = ["first_response", "resolution"] as const
  const unattended = ns.includes("support_queue_unattended")
  return {
    triaged: (svc.tables.lifecycle_events as Row[]).some((e) => e.event_type === "support.ticket_triaged" && e.entity_id === id),
    escalated: kinds.filter((k) => unattended || ns.includes(`support_sla_breach_${k}`)) as any,
    secondTier: kinds.filter((k) => unattended || ns.includes(`support_sla_second_tier_${k}`)) as any,
  }
}

async function main() {
  console.log("\n━━ CAPABILITY CLOSURE + SUPPORT-TICKET CLOSED LOOP (wave 147, lane 147H — rulings 9, 15) ━━\n")

  // ── A · classification ─────────────────────────────────────────────────────
  console.log("[A · every unfinished / not-configured / not-available sentence classified]")
  const sites = classifySites()
  console.log(`    denominator: ${sites.length} sentences — ${SURFACE_CLASSES.map((c) => `${c} ${sites.filter((s) => s.cls === c).length}`).join(" · ")} · UNCLASSIFIED ${sites.filter((s) => !s.cls).length}`)
  check("A1 every honest-state sentence is in exactly one of the five classes", sites.length > 0 && sites.every((s) => !!s.cls && (SURFACE_CLASSES as readonly string[]).includes(s.cls)), sites.filter((s) => !s.cls).map((s) => `${s.file}:${s.line}`).join("; "))
  const naYet = sites.filter((s) => NOT_AVAILABLE.test(s.text))
  check(`A2 no "not available yet" sentence without a classification row (${naYet.length} remain in app/** + lib/**)`, naYet.every((s) => !!s.cls))
  const NINE = ["app/components/portal/PortalSettingsPage.tsx", "app/title/closing/new/page.tsx", "app/vendor/portfolio/page.tsx", "app/vendor/portfolio/upload/page.tsx", "app/dashboard/admin/command-center/allocation-card.tsx", "app/dashboard/admin/manager-trust/improvement-proposals-panel.tsx", "app/dashboard/admin/manager-trust/tenant-constitution-panel.tsx", "app/dashboard/admin/manager-trust/workforce-thresholds-editor.tsx", "app/dashboard/financials/agreements/page.tsx"]
  const nineOpen = NINE.filter((f) => NOT_AVAILABLE.test(code(f)) && !sites.some((s) => s.file === f && !!s.cls))
  const nineUnclosed = NINE.filter((f) => !CLOSED_THIS_WAVE.some((c) => c.file === f))
  check("A3 the nine brief files: none still says \"not available yet\" unclassified, and each is in the closed-this-wave table with its action", nineOpen.length === 0 && nineUnclosed.length === 0, `open ${nineOpen.join(", ") || "none"}; not in the closed table ${nineUnclosed.join(", ") || "none"}`)
  const closedBad = CLOSED_THIS_WAVE.filter((c) => !existsSync(join(ROOT, c.survivor)) || (!!c.oldCopy && code(c.file).includes(c.oldCopy)))
  check(`A4 every surface closed this wave carries its fix (${CLOSED_THIS_WAVE.length}: old sentence gone, survivor present)`, closedBad.length === 0, closedBad.map((c) => c.surface).join("; "))
  const ctl = classifySites([{ file: "app/__no_such_screen__.tsx", line: 1, phrase: "not available yet", text: "<p>This is not available yet</p>", scope: "ui" }])[0]
  check("A5 POSITIVE CONTROL — an unlisted, underivable sentence reads UNCLASSIFIED (the classifier is not silently permissive)", ctl.cls === null && ctl.basis === "UNCLASSIFIED")

  // ── B · the support loop, end to end ───────────────────────────────────────
  console.log("\n[B · intake → AI triage → manager action → human escalation → closure; no stranded ticket]")
  const svc = client()
  // B1 — INTAKE from a non-UI channel (C1 → openInboundSupportTicket). The refusals, by name.
  const base = { channel: "email" as const, provider: "sendgrid", body: "The e-sign step does not show on my listing forms since this morning.", subject: "E-sign step missing" }
  const foreign = await openInboundSupportTicket(svc, { ...base, brokerageId: B, senderUserId: FOREIGN_U, providerRef: "msg-x1" }, { triage: stubTriage })
  const contact = await openInboundSupportTicket(svc, { ...base, brokerageId: B, senderUserId: CONTACT_U, providerRef: "msg-x2" }, { triage: stubTriage })
  const noRef = await openInboundSupportTicket(svc, { ...base, brokerageId: B, senderUserId: AGENT_U, providerRef: "" }, { triage: stubTriage })
  check("B1 intake refuses by name: a sender of ANOTHER tenant (cross-tenant), a CONTACT (a client message is the arbiter's, not a ticket), a message with no provider reference — and opens nothing", !foreign.ok && /not a member/.test(foreign.error ?? "") && !contact.ok && /CRM conversation/.test(contact.error ?? "") && !noRef.ok && tickets(svc).length === 0, JSON.stringify([foreign.error, contact.error, noRef.error]))
  const opened = await openInboundSupportTicket(svc, { ...base, brokerageId: B, senderUserId: AGENT_U, providerRef: "msg-1" }, { triage: stubTriage })
  const t1 = tickets(svc).find((t) => t.id === opened.ticketId)
  const officeBell = notes(svc, "support_ticket_new", opened.ticketId ?? "")
  check("B2 an agent's inbound email opens ONE office-lane ticket (user_to_brokerage — never the platform), the office admin is told, and the in-request triage ran", opened.ok && opened.created && !!t1 && t1.lane === "user_to_brokerage" && t1.brokerage_id === B && t1.submitted_by_user_id === AGENT_U && officeBell.length === 1 && officeBell[0].user_id === ADMIN_U && opened.triaged, JSON.stringify({ opened, bells: officeBell.length }))
  const replay = await openInboundSupportTicket(svc, { ...base, brokerageId: B, senderUserId: AGENT_U, providerRef: "msg-1" }, { triage: stubTriage })
  check("B3 a webhook retry of the same provider message returns the SAME ticket and opens no second one (ledger replay on support_inbound:<provider>:<ref>)", replay.ok && !replay.created && replay.ticketId === opened.ticketId && tickets(svc).length === 1, JSON.stringify(replay))
  const adminToPlatform = await openInboundSupportTicket(svc, { ...base, brokerageId: B, senderUserId: ADMIN_U, providerRef: "msg-2", addressedToPlatform: true }, { triage: stubTriage })
  const agentToPlatform = await openInboundSupportTicket(svc, { ...base, brokerageId: B, senderUserId: AGENT_U, providerRef: "msg-3", addressedToPlatform: true }, { triage: stubTriage })
  check("B4 lane: a brokerage ADMIN writing to the platform address raises tenant_to_platform (platform staff told); an AGENT writing there is routed to their own office", adminToPlatform.lane === "tenant_to_platform" && notes(svc, "support_ticket_new", adminToPlatform.ticketId ?? "").some((n) => n.user_id === STAFF_U) && agentToPlatform.lane === "user_to_brokerage", JSON.stringify([adminToPlatform.lane, agentToPlatform.lane]))
  // The fixture's clock: every intake ticket was stamped with the REAL now by the fake's column default; pin them to
  // one hour before NOW so the SLA arithmetic below never depends on when the proof runs.
  for (const t of tickets(svc)) t.created_at = hoursAgo(1)
  // B5 — AI TRIAGE evidence + the owner's inbox (manager action)
  const ev1 = (svc.tables.lifecycle_events as Row[]).filter((e) => e.event_type === "support.ticket_triaged" && e.entity_id === opened.ticketId)
  const sig1 = (svc.tables.manager_signals as Row[]).filter((s) => s.entity_id === opened.ticketId && s.signal_type === "support_ticket_triaged")
  const ledger1 = (svc.tables.agent_action_ledger as Row[]).filter((l) => l.idempotency_key === `support_triage:${opened.ticketId}` || l.idempotency_key === "support_inbound:sendgrid:msg-1")
  check("B5 triage left ONE evidence row, routed ONE signal to the category's registered owner (data_steward for technical), and both acts are ledgered (support.ticket.open_inbound + support.ticket.triage)", ev1.length === 1 && sig1.length === 1 && sig1[0].to_manager === TRIAGE_OWNER_BY_CATEGORY.technical && ledger1.length === 2, JSON.stringify({ ev: ev1.length, sig: sig1.map((s) => s.to_manager), ledger: ledger1.map((l) => l.action) }))
  const inbox1 = await handleSupportTicketTriaged({ id: sig1[0]?.id, payload: {}, entityId: opened.ticketId, createdAt: NOW.toISOString() } as never, { brokerageId: B, supabase: svc }, { now: NOW })
  const st1 = (await statesOf(svc)).find((s) => s.id === t1!.id)!
  const comp1 = supportTicketCompletion(t1 as never, TRIAGE_OWNER_BY_CATEGORY, NOW)
  check("B6 manager action: the owner's inbox keeps an unanswered ticket OPEN as its item; the loop reads `triaged` (owner_manager owes the first response) and the C14 completion handed to lane 147G names the owner, the due time and the evidence that closes it", inbox1 === null && st1.stage === "triaged" && st1.owed === "owner_manager" && !st1.stranded && !!comp1 && comp1.ownerManager === "data_steward" && comp1.evidenceExpected.includes("first_response_at"), JSON.stringify({ inbox1, st1, comp1 }))
  // B7 — HUMAN ESCALATION: first tier (SLA sweep), then the second tier (loop sweep), each exactly once.
  t1!.created_at = hoursAgo(SLA_TARGETS_HOURS.medium.firstResponse + 1)
  const sla1 = await runSupportSlaSweep(svc, NOW)
  const first = notes(svc, "support_sla_breach_first_response", t1!.id)
  check("B7 human escalation, first tier: a medium ticket past its first-response target pages the OFFICE admin once (never the platform)", first.length === 1 && first[0].user_id === ADMIN_U && sla1.escalated >= 1, JSON.stringify(sla1))
  t1!.created_at = hoursAgo(SLA_TARGETS_HOURS.medium.firstResponse * 2 + 1)
  const loop1 = await runSupportLoopSweep(svc, { now: NOW, triage: stubTriage })
  const second = notes(svc, "support_sla_second_tier_first_response", t1!.id)
  const loop1b = await runSupportLoopSweep(svc, { now: NOW, triage: stubTriage })
  check("B8 second tier: still unanswered at 2× the target, the loop sweep pages again ONCE (a re-run pages nobody)", second.length === 1 && loop1.secondTier >= 1 && notes(svc, "support_sla_second_tier_first_response", t1!.id).length === 1 && loop1b.secondTier === 0, JSON.stringify({ loop1: loop1.secondTier, loop1b: loop1b.secondTier }))
  // B9 — the answering human replies → first response stamped → the inbox closes its watch with the verification.
  const reply = await postTicketReply(svc as never, { ticketId: t1!.id, authorUserId: ADMIN_U, authorKind: "staff", body: "Fixed the template — the e-sign step shows again." })
  const inbox2 = await handleSupportTicketTriaged({ id: sig1[0]?.id, payload: {}, entityId: t1!.id, createdAt: NOW.toISOString() } as never, { brokerageId: B, supabase: svc }, { now: NOW })
  check("B9 the office replies: first_response_at is stamped, the ticket moves to in_progress, the submitter is told, and the owner's inbox closes the AI watch WITH the verification", reply.ok && !!t1!.first_response_at && t1!.status === "in_progress" && notes(svc, "support_reply", t1!.id).some((n) => n.user_id === AGENT_U) && /replied/.test(String(inbox2)), JSON.stringify({ reply, inbox2 }))
  // B10 — CLOSURE + the requester reopens + the evidenced auto-close.
  t1!.status = "resolved"; t1!.resolved_at = NOW.toISOString()
  const reopen = await postTicketReply(svc as never, { ticketId: t1!.id, authorUserId: AGENT_U, authorKind: "tenant", body: "It is broken again on the second listing." })
  check("B10 a requester who writes back on a RESOLVED ticket reopens it (in_progress, resolution cleared) — the reply is never a stranded bell", reopen.ok && t1!.status === "in_progress" && t1!.resolved_at === null, JSON.stringify({ status: t1!.status, resolved_at: t1!.resolved_at }))
  t1!.status = "resolved"; t1!.resolved_at = hoursAgo(RESOLVED_AUTO_CLOSE_DAYS * 24 + 2)
  const loop2 = await runSupportLoopSweep(svc, { now: NOW, triage: stubTriage })
  const closedEv = (svc.tables.lifecycle_events as Row[]).filter((e) => e.event_type === "support.ticket_closed" && e.entity_id === t1!.id)
  const closeLedger = (svc.tables.agent_action_ledger as Row[]).filter((l) => l.action === "support.ticket.auto_close")
  const loop2b = await runSupportLoopSweep(svc, { now: NOW, triage: stubTriage })
  check(`B11 closure: resolved ${RESOLVED_AUTO_CLOSE_DAYS}+ days with no reply → closed, ledgered (support.ticket.auto_close), evidenced (support.ticket_closed, recovered_by cron), the requester told how to reopen — and a re-run closes nothing twice`,
    t1!.status === "closed" && loop2.autoClosed === 1 && closedEv.length === 1 && closedEv[0].metadata?.recovered_by === "cron" && closeLedger.length === 1 && notes(svc, "support_ticket_closed", t1!.id).length === 1 && loop2b.autoClosed === 0,
    JSON.stringify({ status: t1!.status, loop2: loop2.autoClosed, ev: closedEv.length, ledger: closeLedger.length, loop2b: loop2b.autoClosed }))
  // B12 — the stranded shapes the event path can leave, each moved by the recovery sweep.
  const svc2 = client({
    support_tickets: [
      { id: "s-untriaged", brokerage_id: B, lane: "user_to_brokerage", subject: "E-sign step missing on forms", description: "the step is gone", category: "general", priority: "medium", status: "open", submitted_by_user_id: AGENT_U, first_response_at: null, resolved_at: null, created_at: hoursAgo(1) },
      { id: "s-unstamped", brokerage_id: B, lane: "user_to_brokerage", subject: "Closed without a time", description: null, category: "general", priority: "low", status: "closed", submitted_by_user_id: AGENT_U, first_response_at: hoursAgo(5), resolved_at: null, created_at: hoursAgo(9), updated_at: hoursAgo(2) },
      { id: "s-unattended", brokerage_id: EMPTY, lane: "user_to_brokerage", subject: "Nobody at the office", description: null, category: "general", priority: "urgent", status: "open", submitted_by_user_id: LONELY_U, first_response_at: null, resolved_at: null, created_at: hoursAgo(5) },
    ],
    lifecycle_events: [{ id: "ev-un", event_type: "support.ticket_triaged", entity_type: "support_ticket", entity_id: "s-unattended", brokerage_id: EMPTY, created_at: hoursAgo(5) }],
  })
  const writesBefore = svc2.writes.length
  const beforeStates = await statesOf(svc2)
  check("B12a a dry-run sweep publishes every ticket's state and writes NOTHING (the supervision read)", beforeStates.length === 3 && svc2.writes.length === writesBefore, `${beforeStates.length} states, ${svc2.writes.length - writesBefore} writes`)
  check("B12 the loop reader FLAGS every stranded shape (positive control for the census): no triage after the grace window → retriage; closed without resolved_at → repair; a breached office ticket nobody was paged for → escalate",
    beforeStates.find((s) => s.id === "s-untriaged")?.next === "retriage" && beforeStates.find((s) => s.id === "s-unstamped")?.next === "repair_resolved_at" && beforeStates.find((s) => s.id === "s-unattended")?.next === "escalate" && beforeStates.every((s) => s.stranded),
    JSON.stringify(beforeStates.map((s) => [s.id, s.next, s.stranded])))
  const slaU = await runSupportSlaSweep(svc2, NOW)
  const unattended = notes(svc2, "support_queue_unattended", "s-unattended")
  check("B13 an office with NO admin to page: the breach is counted undeliverable (never 'escalated'), and platform staff get ONE content-free notice (no subject, no body) to repair the tenant's roster", slaU.escalated === 0 && (slaU.undeliverable ?? 0) >= 1 && unattended.length === 1 && unattended[0].user_id === STAFF_U && !/Nobody at the office/.test(String(unattended[0].title) + String(unattended[0].body)), JSON.stringify({ slaU, n: unattended.length }))
  const loopU = await runSupportLoopSweep(svc2, { now: NOW, triage: stubTriage })
  check("B14 the recovery sweep moves each: the untriaged ticket is re-triaged (evidence + owner signal), the closed ticket gets its resolved_at, the unattended ticket reads paged — strandedLeft is EMPTY",
    loopU.retriaged === 1 && loopU.repaired === 1 && loopU.strandedLeft.length === 0 && evidenceOf(svc2, "s-untriaged").triaged && !!tickets(svc2).find((t) => t.id === "s-unstamped")?.resolved_at,
    JSON.stringify({ retriaged: loopU.retriaged, repaired: loopU.repaired, left: loopU.strandedLeft }))
  const allTickets = [...tickets(svc).map((t) => ({ svc, t })), ...tickets(svc2).map((t) => ({ svc: svc2, t }))]
  const finalStates = [...(await statesOf(svc)), ...(await statesOf(svc2))]
  const stranded = finalStates.filter((x) => x.stranded)
  // A ticket that is closed WITH its resolution time has left the loop; every other one must be placed and owned.
  const inLoop = allTickets.filter(({ t }) => !(t.status === "closed" && t.resolved_at))
  check(`B15 NO STRANDED TICKET: after the sweeps, every ticket still in the loop (${inLoop.length} of ${allTickets.length}; the rest closed with their resolution time) is placed with an owner and a next move`, finalStates.length === inLoop.length && stranded.length === 0, `${finalStates.length} placed; ` + stranded.map((x) => `${x.id}: ${x.reason}`).join("; "))
  const svc3 = client({ support_tickets: [{ id: "s-dead", brokerage_id: B, lane: "user_to_brokerage", subject: "x", description: null, category: "general", priority: "medium", status: "open", submitted_by_user_id: AGENT_U, first_response_at: null, resolved_at: null, created_at: hoursAgo(2) }] })
  const deadLoop = await runSupportLoopSweep(svc3, { now: NOW, triage: async () => ({ ok: false, evented: false, error: "model lane dark and evidence refused" }) })
  check("B16 POSITIVE CONTROL — a sweep that cannot move a ticket NAMES it in strandedLeft with the reason (the zero above is a measurement, not a default)", deadLoop.strandedLeft.length === 1 && deadLoop.strandedLeft[0].id === "s-dead" && /re-triage left no evidence/.test(deadLoop.strandedLeft[0].reason), JSON.stringify(deadLoop.strandedLeft))
  const svc4 = client({ support_tickets: [{ id: "g", brokerage_id: B, lane: "user_to_brokerage", subject: "fresh", description: null, category: "general", priority: "medium", status: "open", submitted_by_user_id: AGENT_U, first_response_at: null, resolved_at: null, created_at: new Date(NOW.getTime() - 60_000).toISOString() }] })
  const grace = (await statesOf(svc4))[0]
  check(`B17 the grace window is real: a ticket inside the first ${TRIAGE_GRACE_MINUTES} minutes waits for its in-request triage (intake, ai_triage owed, never stranded)`, grace?.stage === "intake" && grace.owed === "ai_triage" && grace.stranded === false, JSON.stringify(grace))

  // ── C · the doors (stripped source) ─────────────────────────────────────────
  console.log("\n[C · the session doors, the cron and the triage prompt]")
  const support = tokens("app/actions/support.ts")
  const flip = support.slice(support.indexOf("export async function updateTicketStatus"), support.indexOf("async function resolveAdminTicketScope"))
  const supportStrings = code("app/actions/support.ts")
  const flipStrings = supportStrings.slice(supportStrings.indexOf("export async function updateTicketStatus"), supportStrings.indexOf("async function resolveAdminTicketScope"))
  check("C1 the office status door stamps resolved_at on resolve / close (as the platform console does), ledgers the transition (support.ticket.status_change) and still resolves the scope BEFORE the service client",
    /update\.resolved_at\s*=\s*nowIso/.test(flip) && /withActionLedger\s*[<(]/.test(flip) && /support\.ticket\.status_change/.test(flipStrings) && flip.search(/resolveQueueScope\s*\(/) >= 0 && flip.search(/resolveQueueScope\s*\(/) < flip.search(/createServiceClient\s*\(/))
  const cron = tokens("app/api/cron/support-sla/route.ts")
  check("C2 the support cron runs the SLA sweep THEN the loop sweep (recovery only — the event path is the door's in-request triage and lane 147G's C14 supervision)", cron.search(/runSupportSlaSweep\(/) > 0 && cron.search(/runSupportLoopSweep\(/) > cron.search(/runSupportSlaSweep\(/))
  check("C3 the requester's reply reopens a resolved / closed ticket (support-thread.ts) — the reply is never stranded", /authorKind\s*===\s*"tenant"\s*&&\s*\(\(ticket as any\)\.status\s*===\s*"resolved"/.test(code("lib/support/support-thread.ts")) && /patch\.resolved_at\s*=\s*null/.test(code("lib/support/support-thread.ts")))
  // The prompt builder is module-private: read its body from the stripped source (strings kept — the sections ARE text).
  const triageSrc = code("lib/support/ticket-triage.ts")
  const system = triageSrc.slice(triageSrc.indexOf("function buildTriagePrompt("), triageSrc.indexOf("const cands = candidates.length"))
  const SECTIONS = ["ROLE —", "BUSINESS CONTEXT —", "FACTS YOU MAY RELY ON —", "THE DECISION YOU OWN —", "OUTPUT CONTRACT —", "COMPLIANCE BOUNDARY —", "ESCALATION RULE —"]
  check("C4 the triage prompt is EXPERT and STRUCTURED (wave-147 rule): role, business context, the facts it may rely on, the decision it owns, the typed output contract, the compliance boundary, the escalation rule — and it never says 'platform-covered'", SECTIONS.every((h) => system.includes(h)) && /wire/i.test(system) && !/platform[- ]?covered/i.test(system), SECTIONS.filter((h) => !system.includes(h)).join(", "))
  check("C5 POSITIVE CONTROL — the section check fails a one-line prompt", !SECTIONS.every((h) => "You are the support triage assistant. Classify the ticket.".includes(h)))
  const logDoor = support.slice(support.indexOf("export async function logSupportRequestOnBehalf"), support.indexOf("async function resolveAdminTicketScope"))
  check("C6 intake from every channel: the office logs a phone / email / in-person request through the SAME non-session door (openInboundSupportTicket) only after its OWN tenant desk scope resolves (gate before the service client; platform support refused), and the office queue renders the form and the ticket's completion line",
    logDoor.search(/resolveQueueScope\s*\(/) >= 0 && logDoor.search(/resolveQueueScope\s*\(/) < logDoor.search(/createServiceClient\s*\(/) && /scope\.kind\s*!==\s*"tenant"/.test(supportStrings.slice(supportStrings.indexOf("export async function logSupportRequestOnBehalf"))) && /openInboundSupportTicket\(/.test(logDoor)
    && /<LogRequestForm\b/.test(code("app/dashboard/admin/support-tickets/support-queue-client.tsx")) && /thread\.completion/.test(code("app/dashboard/admin/support-tickets/support-queue-client.tsx")) && /supportTicketCompletion\(/.test(code("lib/support/support-thread.ts")))
  // WAVE 147 (lane 147Z — this lane's Outside-lane 1 + 2, closed): the C1 inbound door hands a STAFF sender's email to ticket
  // intake BEFORE the unknown-sender raw pipeline (a member of the tenant is never minted a raw lead), and the C14 ticket watch
  // owns each ticket by THIS lane's triage owner with this lane's stall rule.
  const router = code("app/api/providers/inbound/route.ts")
  const staffAt = router.search(/\.from\("users"\)\.select\("id, user_type"\)\.eq\("brokerage_id", inbound\.brokerageId\)\.eq\("email", emailNorm\)\.neq\("user_type", "contact"\)/)
  const intakeAt = router.search(/openInboundSupportTicket\(supabase as never, \{/)
  const rawAt = router.search(/identifyAndRouteUnknownSender\(\{/)
  check("C7 the inbound email door: a sender who is a USER of the verified tenant (never a contact) → openInboundSupportTicket, BEFORE the unknown-sender raw pipeline; the contact / lead matches still run first",
    staffAt > 0 && intakeAt > staffAt && rawAt > intakeAt && router.search(/\.from\("contacts"\)/) < staffAt && /channel: "email"/.test(router.slice(intakeAt, intakeAt + 400)) && /providerRef: inbound\.messageId/.test(router.slice(intakeAt, intakeAt + 400)), `staff ${staffAt} · intake ${intakeAt} · raw ${rawAt}`)
  check("C8 POSITIVE CONTROL — the order finder rejects intake placed AFTER the raw pipeline", (() => { const t = "identifyAndRouteUnknownSender({ x }); openInboundSupportTicket(supabase as never, {"; return !(t.search(/openInboundSupportTicket\(supabase as never, \{/) < t.search(/identifyAndRouteUnknownSender\(\{/)) })())
  const ctSrc = code("lib/kernel/completion-tracking.ts")
  check("C9 the C14 ticket watch owns each ticket by TRIAGE_OWNER_BY_CATEGORY through supportTicketCompletion (owner + stall rule), not a hardcoded steward",
    /supportTicketCompletion\(t as never, TRIAGE_OWNER_BY_CATEGORY, now\)/.test(ctSrc) && /stall_rule: plan\?\.stallRule/.test(ctSrc))

  // ── D · the built capabilities (static) ──────────────────────────────────────
  console.log("\n[D · vendor portfolio (m906) and the title closing appointment]")
  const vp = tokens("app/actions/vendor-portfolio.ts"), vpS = code("app/actions/vendor-portfolio.ts")
  const add = vp.slice(vp.indexOf("export async function addVendorPortfolioItem"), vp.indexOf("export async function removeVendorPortfolioItem"))
  check("D1 the portfolio writer proves the SESSION's vendor (requireVendorActor) BEFORE the service client, ledgers vendor.portfolio_item.add / .remove, stores in the private documents bucket and signs reads (issueBucketObjectUrl)",
    add.search(/requireSessionVendor\(\)/) >= 0 && add.search(/requireSessionVendor\(\)/) < add.search(/createServiceClient\(\)/) && /requireVendorActor\(/.test(vp) && /vendor\.portfolio_item\.add/.test(vpS) && /vendor\.portfolio_item\.remove/.test(vpS) && /issueBucketObjectUrl/.test(vp) && /const BUCKET = "documents"/.test(vpS))
  const m906 = read("supabase/migrations/m906-vendor-portfolio-items.sql")
  const m906Line1 = m906.split("\n")[0] ?? ""
  check("D2 m906 is written with the lane stamp OR carries the integrator's APPLIED stamp (the rule, not the waypoint), creates the table with RLS and grants no write to authenticated",
    (/^-- WRITTEN, NOT APPLIED \(wave 147, lane 147H\)/.test(m906Line1) || /^-- ── APPLIED LIVE /.test(m906Line1)) && /CREATE TABLE IF NOT EXISTS public\.vendor_portfolio_items/.test(m906) && /ENABLE ROW LEVEL SECURITY/.test(m906) && !/GRANT\s+(?:INSERT|UPDATE|DELETE|ALL)[^;]*TO authenticated/i.test(m906))
  check("D3 the portfolio has BOTH readers: the vendor's own page and the agents' vendor directory (a writer with no reader is half a capability)", /listMyVendorPortfolio\(/.test(code("app/vendor/portfolio/page.tsx")) && /<VendorPortfolioStrip\b/.test(code("app/dashboard/vendors/vendor-directory-client.tsx")) && /listVendorPortfolioForStaff\(/.test(code("app/components/vendors/vendor-portfolio-strip.tsx")))
  const ca = tokens("app/actions/title/closing-appointment.ts"), caS = code("app/actions/title/closing-appointment.ts")
  const prop = ca.slice(ca.indexOf("export async function proposeClosingAppointment"))
  check("D4 the closing-appointment writer gates on the deal's TITLE party (own-session deal read + a title vendor seat or a title_company_users row) before writing, ledgers transaction.closing_appointment.propose, lands the agent's task, refuses another day as an amendment, and NEVER writes transactions",
    prop.search(/requireTitlePartyOnDeal\(/) >= 0 && prop.search(/requireTitlePartyOnDeal\(/) < prop.search(/createServiceClient\(\)/) && /transaction\.closing_appointment\.propose/.test(caS) && /\.from\("tasks"\)\.insert\(/.test(caS) && /amendment/.test(caS) && !/\.from\("transactions"\)\.(?:update|upsert|insert|delete)\(/.test(caS) && /vendorSeatsForUser/.test(ca))
  check("D5 POSITIVE CONTROL — the 'never writes transactions' finder catches a close_date update", /\.from\("transactions"\)\.(?:update|upsert|insert|delete)\(/.test(`await svc.from("transactions").update({ close_date: d })`))

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail) { console.log("FAILURES:\n  - " + fails.join("\n  - ")); process.exit(1) }
  console.log("✅ CAPABILITY_CLOSURE_PASS — every unfinished surface classified, the nine closed, and the support loop closes with no stranded ticket")
}
main().catch((e) => { console.error(e); process.exit(1) })
