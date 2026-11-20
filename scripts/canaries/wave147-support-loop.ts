/**
 * scripts/canaries/wave147-support-loop.ts — SUPPORT TICKET CLOSED LOOP + THE OWNER OBLIGATIONS canary (wave 147, lane 147J;
 * owner ruling 15 — lane 147H; the release-blocking owner obligations carried from wave 146):
 *   "Support tickets are a closed loop: intake → AI triage → manager action → human escalation → closure; no stranded ticket."
 *   → an agent's email arrives through the non-session door (C1 → openInboundSupportTicket) — another tenant's sender, a contact
 *     and a message with no provider reference are refused by name → ONE office-lane ticket, the office admin told, the in-request
 *     AI triage leaves evidence and routes ONE signal to the category's registered owner (both ledgered) → a webhook retry is the
 *     same ticket → past its first-response target the office is paged once; still unanswered at 2× the target the second tier
 *     is paged once (a re-run pages nobody) → resolved and quiet long enough: closed with evidence, ledgered, recovered_by 'cron',
 *     and the REQUESTER is told how to reopen → every ticket still in the loop is placed with an owner and a next move (zero
 *     stranded), and a sweep that cannot move a ticket NAMES it (the positive control).
 *   → OWNER DECISIONS no lane may take stay PENDING, never green: the storage.objects policies (m855 §F / m875 §G) and the four
 *     unlinked portal-contact seed accounts (OWNER-SQL §I).
 *
 * Driven through the REAL modules: lib/support/ticket-triage.ts openInboundSupportTicket / triageSupportTicket /
 * handleSupportTicketTriaged, lib/support/support-sla.ts runSupportSlaSweep / runSupportLoopSweep / supportTicketCompletion,
 * lib/support/support-thread.ts postTicketReply. Seamed exactly as lane 147H's proof seams it: the triage model and the
 * entitlement gate (mayUseAndAfford) — the routed model lane is test:ai-by-your-side's.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT, listFiles, strippedRepo } from "./_registry"
import { stripComments } from "../strip-comments"
import { memSupabase } from "../in-memory-supabase"
import { quiet, sqlCode } from "./wave145-harness"
import { canary147, jsonOf, tbl } from "./wave147-harness"

type Row = Record<string, any>
const B = "71470000-0000-4000-8000-0000000000b1", OTHER = "71470000-0000-4000-8000-0000000000b2", P = "71470000-0000-4000-8000-0000000000bf"
const AGENT_U = "71470000-0000-4000-8000-0000000000e1", ADMIN_U = "71470000-0000-4000-8000-0000000000e2", STAFF_U = "71470000-0000-4000-8000-0000000000e3"
const CONTACT_U = "71470000-0000-4000-8000-0000000000e4", FOREIGN_U = "71470000-0000-4000-8000-0000000000e5"
const NOW = new Date("2026-10-31T12:00:00.000Z")
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()

/** Lane 147H's fixture client: the users roster, rpc answered, and manager_signals.status defaulting to 'open' (the live DEFAULT). */
function client(seed: Record<string, Row[]> = {}) {
  const svc = memSupabase({
    support_tickets: [], support_ticket_messages: [], knowledge_articles: [], help_topics_kb: [], lifecycle_events: [], manager_signals: [], notifications: [], agent_action_ledger: [], agents: [],
    users: [
      { id: AGENT_U, brokerage_id: B, user_type: "agent", platform_role: null },
      { id: ADMIN_U, brokerage_id: B, user_type: "broker", platform_role: null },
      { id: STAFF_U, brokerage_id: P, user_type: "agent", platform_role: "support" },
      { id: CONTACT_U, brokerage_id: B, user_type: "contact", platform_role: null },
      { id: FOREIGN_U, brokerage_id: OTHER, user_type: "agent", platform_role: null },
    ],
    ...seed,
  }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] } })
  ;(svc as any).rpc = async () => ({ data: null, error: null })
  const orig = svc.from.bind(svc)
  ;(svc as any).from = (table: string) => {
    const q: any = orig(table)
    if (table === "manager_signals") { const ins = q.insert.bind(q); q.insert = (p: any) => ins(Array.isArray(p) ? p.map((r: any) => ({ status: "open", ...r })) : { status: "open", ...p }) }
    return q
  }
  return svc
}

export async function run() {
  const c = canary147("Support loop (ruling 15) + owner obligations: intake → AI triage → the owner's action → escalation at the target and at 2× → closure that tells the requester → zero stranded; the storage policies and the seed accounts stay pending the OWNER")
  const tt = await quiet(async () => import("../../lib/support/ticket-triage")) as unknown as Record<string, any>
  const sla = await quiet(async () => import("../../lib/support/support-sla")) as unknown as Record<string, any>
  const verdict = () => ({ category: "technical", priority: "medium", operation: null, summary: "The e-sign step does not render on the listing forms", answer: null, groundedIn: [], needsHuman: true, confidence: 0.7 })
  const triage = (svc: unknown, input: unknown) => tt.triageSupportTicket(svc, input, { afford: async () => ({ allowed: true, reason: "subscription_current" }), model: async () => verdict(), now: NOW })
  const svc = c.track(client(), B, P)
  const tickets = () => tbl(svc, "support_tickets")
  const notes = (type: string, entity?: string) => tbl(svc, "notifications").filter((n) => n.type === type && (!entity || n.entity_id === entity))
  const base = { channel: "email", provider: "sendgrid", body: "The e-sign step does not show on my listing forms since this morning.", subject: "E-sign step missing" }
  const open = (over: Record<string, unknown>) => quiet(async () => tt.openInboundSupportTicket(svc, { ...base, brokerageId: B, ...over }, { triage })) as Promise<Record<string, any>>

  // ── 1 · intake: refusals by name, then ONE ticket; a retry is the same ticket ──
  const foreign = await open({ senderUserId: FOREIGN_U, providerRef: "msg-147j-x1" })
  const contact = await open({ senderUserId: CONTACT_U, providerRef: "msg-147j-x2" })
  const noRef = await open({ senderUserId: AGENT_U, providerRef: "" })
  const afterRefusals = tickets().length
  const opened = await open({ senderUserId: AGENT_U, providerRef: "msg-147j-1" })
  const t1 = tickets().find((t) => t.id === opened.ticketId) ?? {}
  c.rule("147H", "INTAKE FROM EVERY CHANNEL, REFUSED BY NAME WHEN IT IS NOT A TICKET (ruling 15 'intake'; lane 147H item 3: C1 → openInboundSupportTicket): another tenant's sender, a CONTACT (a client message is the arbiter's conversation, not a ticket) and a message with no provider reference open NOTHING — POSITIVE CONTROL: the agent's own email then opens ONE office-lane ticket (user_to_brokerage, never the platform) and the office admin is told",
    foreign.ok === false && /not a member/.test(String(foreign.error)) && contact.ok === false && noRef.ok === false && afterRefusals === 0 && opened.ok === true && opened.created === true && t1.lane === "user_to_brokerage" && t1.brokerage_id === B && notes("support_ticket_new", opened.ticketId).some((n) => n.user_id === ADMIN_U),
    `foreign → ${String(foreign.error ?? "").slice(0, 40)}; contact → ${String(contact.error ?? "").slice(0, 40)}; no ref → ${noRef.ok ? "OPENED" : "refused"}; tickets after refusals ${afterRefusals}; agent email → ${opened.created ? `ticket ${t1.lane}` : opened.error}; office told ${notes("support_ticket_new", opened.ticketId).length}`)
  const replay = await open({ senderUserId: AGENT_U, providerRef: "msg-147j-1" })
  c.rule("147H", "A WEBHOOK RETRY IS THE SAME TICKET (C13-style idempotency on the provider reference): the same provider message again returns the SAME ticket and opens no second one",
    replay.ok === true && replay.created === false && replay.ticketId === opened.ticketId && tickets().length === 1, jsonOf({ created: replay.created, same: replay.ticketId === opened.ticketId, n: tickets().length }))
  // two more tickets that stay IN the loop to the end (so "zero stranded" is measured over live tickets, never an empty set)
  const toPlatform = await open({ senderUserId: ADMIN_U, providerRef: "msg-147j-2", addressedToPlatform: true })
  const routedHome = await open({ senderUserId: AGENT_U, providerRef: "msg-147j-3", addressedToPlatform: true })
  c.rule("147H", "THE LANE FOLLOWS THE SENDER (lane 147H item 3): a brokerage ADMIN writing to the platform address raises tenant_to_platform (platform staff told); an AGENT writing there is routed to their own office",
    toPlatform.lane === "tenant_to_platform" && notes("support_ticket_new", toPlatform.ticketId).some((n) => n.user_id === STAFF_U) && routedHome.lane === "user_to_brokerage", jsonOf([toPlatform.lane, routedHome.lane]))
  for (const t of tickets()) t.created_at = hoursAgo(1)
  const ev = tbl(svc, "lifecycle_events").filter((e) => e.event_type === "support.ticket_triaged" && e.entity_id === opened.ticketId)
  const sig = tbl(svc, "manager_signals").filter((s) => s.entity_id === opened.ticketId && s.signal_type === "support_ticket_triaged")
  const led = tbl(svc, "agent_action_ledger").filter((l) => l.idempotency_key === `support_triage:${opened.ticketId}` || l.idempotency_key === "support_inbound:sendgrid:msg-147j-1")
  c.rule("147H", "AI TRIAGE, EVIDENCED, ROUTED TO THE REGISTERED OWNER (ruling 15 'AI triage → manager action'): the in-request triage left ONE evidence row and routed ONE signal to the category's registered owner (technical → TRIAGE_OWNER_BY_CATEGORY.technical); the intake and the triage are both ledgered",
    opened.triaged === true && ev.length === 1 && sig.length === 1 && sig[0].to_manager === tt.TRIAGE_OWNER_BY_CATEGORY.technical && led.length === 2,
    `triaged ${opened.triaged}; evidence ${ev.length}; signal → ${sig.map((s) => s.to_manager).join(",")}; ledger ${led.map((l) => l.action).join(", ")}`)
  const inbox = await quiet(async () => tt.handleSupportTicketTriaged({ id: sig[0]?.id, payload: {}, entityId: opened.ticketId, createdAt: NOW.toISOString() }, { brokerageId: B, supabase: svc }, { now: NOW }))
  const st1 = ((await quiet(async () => sla.runSupportLoopSweep(svc, { now: NOW, dryRun: true }))) as Record<string, any>).states.find((s: Row) => s.id === opened.ticketId) ?? {}
  const comp = sla.supportTicketCompletion(t1, tt.TRIAGE_OWNER_BY_CATEGORY, NOW) as Record<string, any> | null
  c.rule("147H", "THE OWNER MANAGER OWES THE NEXT MOVE, AND THE C14 COMPLETION SAYS SO (ruling 15 'manager action'; lane 147H → 147G handoff): the owner's inbox keeps the unanswered ticket open as its item; the loop reads it 'triaged' with the owner manager owing the first response; the completion names the owner, its due time and the evidence that closes it",
    inbox === null && st1.stage === "triaged" && st1.owed === "owner_manager" && st1.stranded === false && !!comp && comp.ownerManager === tt.TRIAGE_OWNER_BY_CATEGORY.technical && (comp.evidenceExpected ?? []).includes("first_response_at"),
    `inbox ${jsonOf(inbox)}; loop ${st1.stage}/${st1.owed} stranded ${st1.stranded}; completion owner ${comp?.ownerManager}, due ${comp?.dueAt ?? comp?.due ?? "?"}, evidence ${jsonOf(comp?.evidenceExpected)}`)

  // ── 2 · escalation: the first tier at the target, the second tier at 2× — each exactly once ──
  const target = Number(sla.SLA_TARGETS_HOURS.medium.firstResponse)
  t1.created_at = hoursAgo(target + 1)
  const sla1 = await quiet(async () => sla.runSupportSlaSweep(svc, NOW)) as Record<string, any>
  const first = notes("support_sla_breach_first_response", t1.id)
  t1.created_at = hoursAgo(target * 2 + 1)
  const loop1 = await quiet(async () => sla.runSupportLoopSweep(svc, { now: NOW, triage })) as Record<string, any>
  const loop1b = await quiet(async () => sla.runSupportLoopSweep(svc, { now: NOW, triage })) as Record<string, any>
  const second = notes("support_sla_second_tier_first_response", t1.id)
  c.rule("147H", `HUMAN ESCALATION AT THE TARGET AND AGAIN AT 2× (ruling 15 'human escalation'): past the ${target}h first-response target the OFFICE admin is paged once (never the platform); still unanswered at 2× the target the second tier is paged ONCE and a re-run pages nobody`,
    first.length === 1 && first[0].user_id === ADMIN_U && Number(sla1.escalated) >= 1 && second.length === 1 && Number(loop1.secondTier) >= 1 && Number(loop1b.secondTier) === 0,
    `first tier ${first.length} → ${first[0]?.user_id === ADMIN_U ? "the office admin" : first[0]?.user_id}; second tier ${second.length} (sweep ${loop1.secondTier}, re-run ${loop1b.secondTier})`)

  // ── 3 · the office answers; closure tells the requester ──
  const thread = await quiet(async () => import("../../lib/support/support-thread")) as unknown as Record<string, any>
  const reply = await quiet(async () => thread.postTicketReply(svc, { ticketId: t1.id, authorUserId: ADMIN_U, authorKind: "staff", body: "Fixed the template — the e-sign step shows again." })) as Record<string, any>
  c.rule("147H", "THE ANSWERING HUMAN REPLIES AND THE REQUESTER IS TOLD (ruling 15): the office's reply stamps first_response_at, moves the ticket to in_progress and notifies the submitter",
    reply.ok === true && !!t1.first_response_at && t1.status === "in_progress" && notes("support_reply", t1.id).some((n) => n.user_id === AGENT_U),
    `reply ${reply.ok}; first_response_at ${t1.first_response_at ? "stamped" : "∅"}; status ${t1.status}; submitter told ${notes("support_reply", t1.id).some((n) => n.user_id === AGENT_U)}`)
  t1.status = "resolved"; t1.resolved_at = hoursAgo(Number(sla.RESOLVED_AUTO_CLOSE_DAYS) * 24 + 2)
  const loop2 = await quiet(async () => sla.runSupportLoopSweep(svc, { now: NOW, triage })) as Record<string, any>
  const closedEv = tbl(svc, "lifecycle_events").filter((e) => e.event_type === "support.ticket_closed" && e.entity_id === t1.id)
  const closeLedger = tbl(svc, "agent_action_ledger").filter((l) => l.action === "support.ticket.auto_close")
  const toldClosed = notes("support_ticket_closed", t1.id)
  const loop2b = await quiet(async () => sla.runSupportLoopSweep(svc, { now: NOW, triage })) as Record<string, any>
  c.rule("147H", `CLOSURE WITH EVIDENCE THAT TELLS THE REQUESTER (ruling 15 'closure'): resolved ${sla.RESOLVED_AUTO_CLOSE_DAYS}+ days with no reply → closed, ledgered (support.ticket.auto_close), evidenced (support.ticket_closed with recovered_by 'cron' — the sweep is recovery, and says so), the REQUESTER told how to reopen; a re-run closes nothing twice`,
    t1.status === "closed" && Number(loop2.autoClosed) === 1 && closedEv.length === 1 && closedEv[0].metadata?.recovered_by === "cron" && closeLedger.length === 1 && toldClosed.length === 1 && toldClosed[0].user_id === AGENT_U && Number(loop2b.autoClosed) === 0,
    `status ${t1.status}; auto-closed ${loop2.autoClosed} (re-run ${loop2b.autoClosed}); event recovered_by ${closedEv[0]?.metadata?.recovered_by}; ledger ${closeLedger.length}; requester told ${toldClosed.map((n) => (n.user_id === AGENT_U ? "the submitter" : n.user_id)).join(",") || "nobody"}`)

  // ── 4 · zero stranded — and the finder that would name one ──
  const states = ((await quiet(async () => sla.runSupportLoopSweep(svc, { now: NOW, dryRun: true }))) as Record<string, any>).states as Row[]
  const inLoop = tickets().filter((t) => !(t.status === "closed" && t.resolved_at))
  const dead = c.track(client({ support_tickets: [{ id: "s-147j-dead", brokerage_id: B, lane: "user_to_brokerage", subject: "x", description: null, category: "general", priority: "medium", status: "open", submitted_by_user_id: AGENT_U, first_response_at: null, resolved_at: null, created_at: hoursAgo(2) }] }), B, P)
  const deadLoop = await quiet(async () => sla.runSupportLoopSweep(dead, { now: NOW, triage: async () => ({ ok: false, evented: false, error: "model lane dark and evidence refused" }) })) as Record<string, any>
  c.rule("147H", "ZERO STRANDED (ruling 15 'no stranded ticket'): every ticket still in the loop is placed with an owner and a next move and none reads stranded — POSITIVE CONTROL: a sweep that cannot move a ticket NAMES it in strandedLeft with the reason (the zero is a measurement, not a default)",
    inLoop.length >= 2 && states.length === inLoop.length && states.every((s) => s.stranded === false && !!s.next) && (deadLoop.strandedLeft ?? []).length === 1 && deadLoop.strandedLeft[0].id === "s-147j-dead",
    `${states.length} placed of ${inLoop.length} in the loop; stranded ${states.filter((s) => s.stranded).length}; control names ${jsonOf((deadLoop.strandedLeft ?? []).map((s: Row) => [s.id, String(s.reason).slice(0, 40)]))}`)
  const cron = strippedRepo("app/api/cron/support-sla/route.ts") ?? ""
  const order = cron.search(/runSupportSlaSweep\(/) > 0 && cron.search(/runSupportLoopSweep\(/) > cron.search(/runSupportSlaSweep\(/)
  c.rule("147H", "THE SUPPORT CRON IS RECOVERY ONLY, IN ORDER (stripped source, app/api/cron/support-sla/route.ts): the SLA sweep then the loop sweep — the event path is the door's in-request triage (POSITIVE CONTROL: a commented call is not a call)",
    order && !/runSupportLoopSweep\(/.test(stripComments("// runSupportLoopSweep(svc)")), `SLA → loop order ${order}`)

  // ── 5 · OWNER DECISIONS — pending, never green ──
  const { claimOf } = await quiet(async () => import("../migration-status")) as unknown as { claimOf: (sql: string) => string }
  const storageMigs = listFiles("supabase/migrations", (f) => /\/m(855|875)-[^/]+\.sql$/.test(f)).sort()
  const stamps = storageMigs.map((f) => ({ f: f.split("/").pop(), claim: claimOf(readFileSync(join(ROOT, f), "utf8")), creates: /CREATE\s+POLICY/i.test(sqlCode(readFileSync(join(ROOT, f), "utf8"))) }))
  const liveCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL)
  let liveVerdict: string | null = null, liveClosed = false
  if (liveCreds) {
    try {
      const { createClient } = await import("@supabase/supabase-js")
      const live = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } })
      const { data, error } = await live.rpc("storage_bucket_policy_readiness")
      liveVerdict = error ? `refused (${error.message})` : jsonOf(data).slice(0, 200)
      liveClosed = !error && Array.isArray(data) && data.length > 0 && !jsonOf(data).includes('"open"')
    } catch (e) { liveVerdict = `unreadable (${e instanceof Error ? e.message : String(e)})` }
  }
  const stampsApplied = stamps.length === 2 && stamps.every((s) => s.claim === "applied" && s.creates)
  const stampControl = claimOf("-- ── APPLIED LIVE 2026-11-01 via the SQL editor\nCREATE POLICY x ON storage.objects") === "applied" && claimOf("-- WRITTEN, NOT APPLIED (wave 146, lane 146A)\nCREATE POLICY x ON storage.objects") !== "applied"
  c.pendingOwner("147H", "THE FIVE DOCUMENT BUCKETS' storage.objects POLICIES ARE APPLIED AND VERIFIED (release blocker carried from wave 146; WAVE147_SPEC: 'Nothing is LIVE or production-safe until storage_bucket_policy_readiness() reads owner_scoped/service_only'): m855 (§F) and m875 (§G) read 'applied' AND the live readiness read shows no bucket 'open' (stamp classifier POSITIVE CONTROL: an APPLIED LIVE line 1 reads applied, the lane stamp does not)",
    stampsApplied && liveClosed && stampControl,
    "the owner runs docs/operations/OWNER-SQL.md §F (m855, brokerage-forms) and §G (m875, the four sibling buckets) in the Supabase SQL editor; storage_bucket_policy_readiness() then reads owner_scoped / service_only for all five",
    `${stamps.map((s) => `${s.f}: ${s.claim}`).join(", ") || "no m855 / m875 in the tree"}; live read ${liveCreds ? liveVerdict : "not available (this process holds no service credentials)"}; classifier control ${stampControl}`)
  const ownerSql = readFileSync(join(ROOT, "docs/operations/OWNER-SQL.md"), "utf8")
  const resolvedI = (doc: string) => /^- Status:\s*RESOLVED\b.*\d{4}-\d{2}-\d{2}.*\b0\b/m.test(doc.split(/^## /m).find((s) => /^I\.\s/.test(s)) ?? "")
  const sectionI = ownerSql.split(/^## /m).find((s) => /^I\.\s/.test(s)) ?? ""
  const statusLine = /^- Status:.*$/m.exec(sectionI)?.[0] ?? "(no status line)"
  const seedControl = resolvedI("## I. seeds\n- Status: RESOLVED 2026-11-02 — 0 unlinked") && !resolvedI("## I. seeds\n- Status: OPEN — 4 unlinked (measured 2026-10-31)")
  // A pending step can never fail, so its readers' controls are a HARD step of their own: a blind reader would leave the
  // obligations pending forever and read as "honestly waiting" — or flip them green on nothing.
  c.rule("147H", "THE OWNER-OBLIGATION READERS ARE NOT BLIND (CLAUDE.md §2 'every absence assertion needs a POSITIVE CONTROL'): the stamp classifier reads an APPLIED LIVE line 1 as applied and the lane stamp as not; the §I reader reads a RESOLVED-with-date-and-zero line as resolved and the OPEN line as not; both storage migrations and §I are present",
    stampControl && seedControl && stamps.length === 2 && stamps.every((s) => s.creates) && !!sectionI && /^- Status:/m.test(sectionI), `stamp control ${stampControl}; §I control ${seedControl}; storage migrations ${stamps.length} (policies ${stamps.every((s) => s.creates)}); §I status line ${/^- Status:/m.test(sectionI)}`)
  c.pendingOwner("147H", "THE FOUR UNLINKED PORTAL-CONTACT SEED ACCOUNTS ARE LINKED OR REMOVED (owner obligation O2; production-readiness block O): OWNER-SQL §I's status line reads RESOLVED with a date and a zero census (the same reader as test:production-readiness; POSITIVE CONTROL: a RESOLVED specimen reads resolved, the OPEN line does not)",
    resolvedI(ownerSql) && seedControl,
    "the owner links each users.user_type='contact' account to its contacts.contact_user_id or removes it (docs/operations/OWNER-SQL.md §I), then writes 'Status: RESOLVED <date> — 0 unlinked'",
    `§I ${sectionI ? "present" : "ABSENT"}: ${statusLine.trim()}; reader control ${seedControl}`)

  c.blind("The triage model and the entitlement gate are seams (lane 147H's proof seams the same ones; the routed model lane is test:ai-by-your-side's). The office doors (updateTicketStatus, logSupportRequestOnBehalf) need a session and are lane 147H's static proof; the requester's closure notice is driven through the loop sweep's evidenced auto-close and the reply notice through postTicketReply. The storage-policy live read runs only when this process holds SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_URL (names only — no value is read or printed); otherwise the pending step reports the migration stamps. The seed-account step reads OWNER-SQL §I's status line, not the database (a canary cannot see the live census).")
  return c.report()
}
