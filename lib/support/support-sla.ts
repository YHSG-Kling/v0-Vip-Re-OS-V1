// lib/support/support-sla.ts
// ─────────────────────────────────────────────────────────────────────────────
// SUPPORT SLA TIMERS + CSAT — the accountability layer the ticket system lacked.
// The queue knew "awaiting first response" as a boolean; it had NO clock. This
// gives every open ticket a priority-based first-response + resolution deadline
// (pure, provable), a breach state the queue can badge, and an hourly sweep that
// escalates breaches to platform staff EXACTLY ONCE per (ticket, breach kind).
// CSAT rides the same table: the tenant rates a resolved ticket 1–5, once.

import { TICKET_PRIORITIES, ticketAnsweredBy, type TicketPriority } from "./ticket-constants"

/** Response/resolution targets in HOURS, by priority. */
export const SLA_TARGETS_HOURS: Record<TicketPriority, { firstResponse: number; resolution: number }> = {
  urgent: { firstResponse: 1,  resolution: 8 },
  high:   { firstResponse: 4,  resolution: 24 },
  medium: { firstResponse: 8,  resolution: 72 },
  low:    { firstResponse: 24, resolution: 120 },
}

export type SlaBreachKind = "first_response" | "resolution"

export interface TicketSlaState {
  firstResponseDueAt: string
  resolutionDueAt: string
  /** Breaches ACTIVE right now (deadline passed and the obligation still unmet). */
  breaches: SlaBreachKind[]
  /** Within the final 25% of a not-yet-breached window. */
  atRisk: boolean
  ageHours: number
}

interface SlaTicket {
  created_at: string
  priority: string | null
  status: string | null
  first_response_at: string | null
  resolved_at: string | null
}

/** PURE: a ticket's SLA state at `now`. Closed/resolved tickets never breach. */
export function evaluateTicketSla(t: SlaTicket, now: Date = new Date()): TicketSlaState {
  const priority = ((TICKET_PRIORITIES as readonly string[]).includes(t.priority ?? "") ? t.priority : "medium") as TicketPriority
  const target = SLA_TARGETS_HOURS[priority]
  const created = new Date(t.created_at).getTime()
  const nowMs = now.getTime()
  const frDue = created + target.firstResponse * 3_600_000
  const resDue = created + target.resolution * 3_600_000

  const isOpen = t.status === "open" || t.status === "in_progress"
  const breaches: SlaBreachKind[] = []
  if (isOpen && !t.first_response_at && nowMs > frDue) breaches.push("first_response")
  if (isOpen && !t.resolved_at && nowMs > resDue) breaches.push("resolution")

  let atRisk = false
  if (isOpen && breaches.length === 0) {
    const frRemaining = frDue - nowMs
    const resRemaining = resDue - nowMs
    if (!t.first_response_at && frRemaining < target.firstResponse * 3_600_000 * 0.25) atRisk = true
    if (!t.resolved_at && resRemaining < target.resolution * 3_600_000 * 0.25) atRisk = true
  }

  return {
    firstResponseDueAt: new Date(frDue).toISOString(),
    resolutionDueAt: new Date(resDue).toISOString(),
    breaches,
    atRisk,
    ageHours: Math.max(0, (nowMs - created) / 3_600_000),
  }
}

/** PURE: can this ticket be CSAT-rated? Resolved/closed, not yet rated, rating 1–5. */
export function canRateTicket(
  t: { status: string | null; satisfaction_rating: number | null }, rating: number,
): { ok: boolean; reason?: string } {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { ok: false, reason: "rating must be 1–5" }
  if (t.status !== "resolved" && t.status !== "closed") return { ok: false, reason: "only a resolved ticket can be rated" }
  if (t.satisfaction_rating != null) return { ok: false, reason: "already rated" }
  return { ok: true }
}

/** PURE: CSAT rollup — average + counts (rated tickets only). */
export function rollupCsat(rows: Array<{ satisfaction_rating: number | null }>): { average: number | null; rated: number } {
  const rated = rows.map((r) => r.satisfaction_rating).filter((r): r is number => r != null)
  if (rated.length === 0) return { average: null, rated: 0 }
  return { average: rated.reduce((a, b) => a + b, 0) / rated.length, rated: rated.length }
}

/** `undeliverable`: a breach whose answering side had NOBODY to tell (wave 147, lane 147H) — it used to be counted
 *  as `escalated` although no row was written, so a brokerage with no office admin read as handled forever. */
export interface SlaSweepResult { open: number; breached: number; escalated: number; undeliverable?: number }

/**
 * Hourly sweep: evaluate every open ticket, escalate NEW breaches to platform
 * staff via the notifications rail — deduped per (ticket, breach kind) by
 * checking for an existing escalation notification.
 */
export async function runSupportSlaSweep(svc: any, now: Date = new Date()): Promise<SlaSweepResult> {
  const result: SlaSweepResult = { open: 0, breached: 0, escalated: 0 }
  // `error` destructured: an unchecked read here reports a refused query as
  // "no open tickets" and the sweep returns a clean zero while every SLA in the
  // product silently stops being measured.
  const { data: tickets, error } = await svc
    .from("support_tickets")
    .select("id, subject, brokerage_id, lane, created_at, priority, status, first_response_at, resolved_at")
    .in("status", ["open", "in_progress"]).limit(500)
  if (error) throw new Error(`support SLA sweep could not read tickets: ${error.message}`)

  for (const t of (tickets ?? []) as Array<SlaTicket & { id: string; subject: string | null; brokerage_id: string | null; lane: string | null }>) {
    result.open += 1
    const sla = evaluateTicketSla(t, now)
    if (sla.breaches.length === 0) continue
    result.breached += 1

    for (const kind of sla.breaches) {
      const type = `support_sla_breach_${kind}`
      // Dedupe: one escalation per (ticket, kind) — ever. The queue badge stays
      // red until resolved; staff don't need an hourly repeat.
      const { data: existing, error: dedupeErr } = await svc
        .from("notifications").select("id")
        // An office queue already handed to platform staff (no admin to page — unattendedQueueNotice) is escalated too.
        .in("type", [type, "support_queue_unattended"]).eq("entity_id", t.id).limit(1).maybeSingle()
      // A refused dedupe read must not be read as "never escalated" — that would
      // re-page the answering side every hour, forever.
      if (dedupeErr) { console.error("[support-sla] dedupe read refused:", dedupeErr.message); continue }
      if (existing) continue

      const label = kind === "first_response" ? "first response" : "resolution"
      const payload = {
        type,
        title: `SLA breach (${label}): ${t.subject ?? "Support ticket"}`,
        body: `Ticket is ${Math.round(sla.ageHours)}h old (priority ${t.priority ?? "medium"}) and past its ${label} target. Jump in from the support console.`,
        entityType: "support_ticket",
        entityId: t.id,
        priority: "high" as const,
      }

      // ESCALATE TO WHOEVER ANSWERS THIS LANE. This used to page platform staff for
      // EVERY breached ticket, so a brokerage-internal ticket nobody at the platform
      // is working — or can work — raised a platform alert, while the brokerage's own
      // office, which owes the response, was never told its clock had run out.
      // COUNT WHAT LANDED (wave 147, lane 147H): the notifiers return how many people were told; a zero is a
      // breach nobody heard about, not an escalation. The office lane's zero falls back to the content-free
      // platform notice (unattendedQueueNotice) so a tenant with no office admin is still somebody's problem.
      let delivered = 0
      const answerer = ticketAnsweredBy(t.lane)
      if (answerer === "brokerage_office") {
        if (!t.brokerage_id) continue
        const { notifyBrokerageAdmins } = await import("@/lib/notifications/brokerage-admins")
        delivered = await notifyBrokerageAdmins(svc, t.brokerage_id, payload)
        if (delivered === 0) await unattendedQueueNotice(svc, t)
      } else {
        const { notifyPlatformStaff } = await import("@/lib/notifications/platform-staff")
        delivered = await notifyPlatformStaff(svc, payload)
      }
      if (delivered > 0) result.escalated += 1
      else result.undeliverable = (result.undeliverable ?? 0) + 1
    }
  }
  return result
}

// ═════════════════════════════════════════════════════════════════════════════
// THE CLOSED LOOP (wave 147, lane 147H — owner ruling 15: "support tickets are a closed loop: intake → AI triage →
// manager action → human escalation → closure; no stranded ticket").
//
// AUDITED FIRST (LAW 1) — every stage already had a survivor and is REUSED, never re-spelled:
//   intake            app/actions/support.ts createSupportTicket (the session door, two lanes, m468) and, for a
//                     non-UI channel, lib/support/ticket-triage.ts openInboundSupportTicket (C1 → ticket, below it)
//   AI triage         lib/support/ticket-triage.ts triageSupportTicket — in-request, ledgered, owner from
//                     TRIAGE_OWNER_BY_CATEGORY, evidence row support.ticket_triaged
//   manager action    the owner's SIGNAL_HANDLERS inbox (handleSupportTicketTriaged) + the immediate-operations
//                     safe-repair path for a ticket that names one of the ten operations
//   human escalation  runSupportSlaSweep above — first tier, once per (ticket, breach kind)
//   closure           updateTicketStatus (office) / setTicketStatusAction (platform console) — resolved / closed
// WHAT WAS MISSING (measured at 4d527cc3): (1) a ticket whose triage never ran (the door's best-effort try/catch, a
// thrown import) had no owner and no evidence and nothing ever looked again; (2) after the one first-tier page a
// breached ticket could sit open forever; (3) a `resolved` ticket stayed resolved forever (no close) and the office
// door never stamped `resolved_at`; (4) a zero-recipient escalation counted as escalated. This block is the stage
// reader (pure) and the RECOVERY sweep that acts on what the event path missed — cron is recovery here, never the
// strategy (ruling 13): every action it takes is stamped `recovered_by: "cron"` in its evidence. Stall DETECTION for
// the manager supervision loop is lane 147G's C14 (`supportTicketCompletion` below is the shape handed to it).
// ═════════════════════════════════════════════════════════════════════════════

/** The loop's stages, in order. One vocabulary (§6) — the guard asserts every stage is reachable. */
export const SUPPORT_LOOP_STAGES = ["intake", "triaged", "answering", "escalated", "resolved", "closed"] as const
export type SupportLoopStage = (typeof SUPPORT_LOOP_STAGES)[number]
/** Who owes the next move. "none" only for a closed ticket. */
export type SupportLoopOwed = "ai_triage" | "owner_manager" | "answering_side" | "second_tier" | "requester" | "none"
export type SupportLoopAction = "retriage" | "escalate" | "escalate_second_tier" | "auto_close" | "repair_resolved_at" | "wait" | "none"

/** A ticket with no triage evidence this long after intake is re-triaged by the recovery sweep. */
export const TRIAGE_GRACE_MINUTES = 15
/** A breach still unanswered at this multiple of its target goes to the second tier (once per kind). */
export const SECOND_TIER_MULTIPLIER = 2
/** A resolved ticket the requester has not reopened in this many days is closed, with evidence. */
export const RESOLVED_AUTO_CLOSE_DAYS = 7

export interface LoopTicket extends SlaTicket { id: string; lane: string | null; brokerage_id: string | null; updated_at?: string | null }
/** What the loop has already done for a ticket — read from the evidence it leaves (lifecycle_events + notifications). */
export interface LoopEvidence { triaged: boolean; escalated: SlaBreachKind[]; secondTier: SlaBreachKind[] }

export interface SupportLoopState {
  stage: SupportLoopStage
  owed: SupportLoopOwed
  next: SupportLoopAction
  /** When the owed move is due (null for closed). */
  dueAt: string | null
  /** True when the ticket has fallen out of the loop and needs the recovery sweep's action. */
  stranded: boolean
  reason: string
}

const HOUR = 3_600_000

/** PURE: where a ticket is in the loop, who owes the next move, and whether it has been stranded. Module-private: the
 *  recovery sweep is its caller and publishes every ticket's state in its result (`states`; `dryRun` reads without acting). */
function supportTicketLoopState(t: LoopTicket, ev: LoopEvidence, now: Date = new Date()): SupportLoopState {
  const nowMs = now.getTime()
  if (t.status === "closed") {
    return t.resolved_at
      ? { stage: "closed", owed: "none", next: "none", dueAt: null, stranded: false, reason: "closed" }
      : { stage: "closed", owed: "none", next: "repair_resolved_at", dueAt: null, stranded: true, reason: "closed without a resolved_at — the resolution time was never recorded" }
  }
  if (t.status === "resolved") {
    if (!t.resolved_at) return { stage: "resolved", owed: "requester", next: "repair_resolved_at", dueAt: null, stranded: true, reason: "resolved without a resolved_at — the close clock cannot start" }
    const closeAt = new Date(t.resolved_at).getTime() + RESOLVED_AUTO_CLOSE_DAYS * 24 * HOUR
    if (nowMs > closeAt) return { stage: "resolved", owed: "none", next: "auto_close", dueAt: new Date(closeAt).toISOString(), stranded: true, reason: `resolved ${RESOLVED_AUTO_CLOSE_DAYS}+ days ago with no reply from the requester — close it with evidence` }
    return { stage: "resolved", owed: "requester", next: "wait", dueAt: new Date(closeAt).toISOString(), stranded: false, reason: "resolved; the requester may reply to reopen" }
  }
  // open / in_progress (anything else is read as open — a status the loop cannot place must not vanish)
  const created = new Date(t.created_at).getTime()
  if (!ev.triaged) {
    const graceAt = created + TRIAGE_GRACE_MINUTES * 60_000
    if (nowMs > graceAt) return { stage: "intake", owed: "ai_triage", next: "retriage", dueAt: new Date(graceAt).toISOString(), stranded: true, reason: `no triage evidence ${TRIAGE_GRACE_MINUTES}+ minutes after intake — no owner was ever told` }
    return { stage: "intake", owed: "ai_triage", next: "wait", dueAt: new Date(graceAt).toISOString(), stranded: false, reason: "awaiting the in-request triage" }
  }
  const sla = evaluateTicketSla(t, now)
  const unescalated = sla.breaches.filter((k) => !ev.escalated.includes(k))
  if (unescalated.length) return { stage: "escalated", owed: "answering_side", next: "escalate", dueAt: null, stranded: true, reason: `${unescalated.join(" + ")} breached and nobody has been paged yet` }
  const priority = ((TICKET_PRIORITIES as readonly string[]).includes(t.priority ?? "") ? t.priority : "medium") as TicketPriority
  const target = SLA_TARGETS_HOURS[priority]
  const secondDue = (k: SlaBreachKind) => created + (k === "first_response" ? target.firstResponse : target.resolution) * SECOND_TIER_MULTIPLIER * HOUR
  const owedSecond = sla.breaches.filter((k) => !ev.secondTier.includes(k) && nowMs > secondDue(k))
  if (owedSecond.length) return { stage: "escalated", owed: "second_tier", next: "escalate_second_tier", dueAt: new Date(secondDue(owedSecond[0])).toISOString(), stranded: true, reason: `${owedSecond.join(" + ")} still unmet at ${SECOND_TIER_MULTIPLIER}× its target after the first page` }
  if (sla.breaches.length) {
    const pending = sla.breaches.filter((k) => !ev.secondTier.includes(k))
    return { stage: "escalated", owed: "answering_side", next: "wait", dueAt: pending.length ? new Date(secondDue(pending[0])).toISOString() : null, stranded: false, reason: pending.length ? "paged; the second tier follows if it stays unmet" : "paged at both tiers; a person on the answering side owns it" }
  }
  if (t.first_response_at) return { stage: "answering", owed: "answering_side", next: "wait", dueAt: sla.resolutionDueAt, stranded: false, reason: "a person replied; resolution is owed" }
  return { stage: "triaged", owed: "owner_manager", next: "wait", dueAt: sla.firstResponseDueAt, stranded: false, reason: "triaged and routed; the first response is owed" }
}

/**
 * THE C14 HANDOFF (lane 147G owns the completion ledger and the event-driven supervision loop): what completing a
 * ticket means, who owns it, when it is due and what evidence closes it. The owner is the triage's registered
 * owner (lib/support/ticket-triage.ts TRIAGE_OWNER_BY_CATEGORY); the stall rule is the SLA clock above.
 */
export interface SupportTicketCompletion {
  what: string
  ownerManager: string
  dueAt: string
  evidenceExpected: Array<"first_response_at" | "resolved_at" | "status:closed">
  stallRule: string
}
/** Product reader: lib/support/support-thread.ts loadTicketThread shows it on both answering consoles; lane 147G's C14
 *  completion ledger opens one per ticket from the same shape. */
export function supportTicketCompletion(t: LoopTicket & { category?: string | null }, ownerByCategory: Readonly<Record<string, string>>, now: Date = new Date()): SupportTicketCompletion | null {
  if (t.status === "closed") return null
  const sla = evaluateTicketSla(t, now)
  const owner = ownerByCategory[t.category ?? "general"] ?? ownerByCategory.general ?? "data_steward"
  if (t.status === "resolved") return { what: `close support ticket ${t.id} (resolved, awaiting the requester)`, ownerManager: owner, dueAt: new Date(new Date(t.resolved_at ?? t.created_at).getTime() + RESOLVED_AUTO_CLOSE_DAYS * 24 * HOUR).toISOString(), evidenceExpected: ["status:closed"], stallRule: `resolved ${RESOLVED_AUTO_CLOSE_DAYS} days with no reply → close with evidence (support.ticket.auto_close)` }
  if (!t.first_response_at) return { what: `first response on support ticket ${t.id}`, ownerManager: owner, dueAt: sla.firstResponseDueAt, evidenceExpected: ["first_response_at"], stallRule: `no first response by the ${t.priority ?? "medium"} target → page the answering side once; still none at ${SECOND_TIER_MULTIPLIER}× → second tier` }
  return { what: `resolve support ticket ${t.id}`, ownerManager: owner, dueAt: sla.resolutionDueAt, evidenceExpected: ["resolved_at", "status:closed"], stallRule: `not resolved by the ${t.priority ?? "medium"} target → page the answering side once; still open at ${SECOND_TIER_MULTIPLIER}× → second tier` }
}

/** A brokerage-office breach nobody at the office could receive → ONE content-free platform notice per ticket (the
 *  platform is not a party to the conversation: no subject, no body — only that the tenant's office queue has no
 *  admin to receive it, so platform staff can repair the tenant's roster). */
async function unattendedQueueNotice(svc: any, t: { id: string; brokerage_id: string | null }): Promise<number> {
  const type = "support_queue_unattended"
  const { data: existing, error } = await svc.from("notifications").select("id").eq("type", type).eq("entity_id", t.id).limit(1).maybeSingle()
  if (error) { console.error("[support-sla] unattended-queue dedupe read refused:", error.message); return 0 }
  if (existing) return 0
  const { notifyPlatformStaff } = await import("@/lib/notifications/platform-staff")
  return notifyPlatformStaff(svc, {
    type, title: "A brokerage's support queue has no office admin to receive it",
    body: `Brokerage ${t.brokerage_id ?? "(unknown)"} has an overdue office-lane ticket and no broker / admin account to page. Repair the tenant's roster; the ticket's content stays with the brokerage.`,
    entityType: "support_ticket", entityId: t.id, priority: "high",
  })
}

export interface SupportLoopSweepResult {
  scanned: number
  stages: Record<SupportLoopStage, number>
  retriaged: number
  secondTier: number
  autoClosed: number
  repaired: number
  /** Stranded tickets the sweep could NOT move (each named with why) — the number the guard holds at zero. */
  strandedLeft: Array<{ id: string; reason: string }>
  /** Every scanned ticket's loop state BEFORE this sweep acted (the published reading of the loop). */
  states: Array<{ id: string } & SupportLoopState>
}

export interface SupportLoopDeps {
  now?: Date
  /** Read and publish every ticket's state without acting (the supervision read; the closure proof's census). */
  dryRun?: boolean
  /** The triage seam (default lib/support/ticket-triage.ts triageSupportTicket). */
  triage?: (svc: any, input: { ticketId: string; brokerageId: string; lane: "tenant_to_platform" | "user_to_brokerage"; subject: string; description: string | null; category: string | null; priority: string | null; submitterUserId: string | null }) => Promise<{ ok: boolean; evented: boolean; error: string | null }>
}

/**
 * THE RECOVERY SWEEP — runs after runSupportSlaSweep on the same cron (app/api/cron/support-sla/route.ts). Reads every
 * ticket that is not cleanly closed, places it in the loop, and acts on what the event path missed: re-triage, the
 * second-tier page, the evidenced close of a long-resolved ticket, the missing resolved_at. Idempotent: every act is
 * deduped by the evidence it leaves (the triage's own ledger key; a notification per (ticket, tier, kind); the
 * auto-close ledger key per resolution).
 */
export async function runSupportLoopSweep(svc: any, deps: SupportLoopDeps = {}): Promise<SupportLoopSweepResult> {
  const now = deps.now ?? new Date()
  const out: SupportLoopSweepResult = { scanned: 0, stages: { intake: 0, triaged: 0, answering: 0, escalated: 0, resolved: 0, closed: 0 }, retriaged: 0, secondTier: 0, autoClosed: 0, repaired: 0, strandedLeft: [], states: [] }
  // Both reads span the two lanes ON PURPOSE (each ticket is routed to the side that owes it) and therefore SELECT the
  // lane column, spelled inline so test:support-lane's lane-blind-list scanner can see it.
  const [{ data: live, error: liveErr }, { data: unstamped, error: unstampedErr }] = await Promise.all([
    svc.from("support_tickets").select("id, subject, description, brokerage_id, lane, category, created_at, updated_at, priority, status, first_response_at, resolved_at, submitted_by_user_id").in("status", ["open", "in_progress", "resolved"]).limit(1000),
    svc.from("support_tickets").select("id, subject, description, brokerage_id, lane, category, created_at, updated_at, priority, status, first_response_at, resolved_at, submitted_by_user_id").eq("status", "closed").is("resolved_at", null).limit(200),
  ])
  if (liveErr) throw new Error(`support loop sweep could not read tickets: ${liveErr.message}`)
  if (unstampedErr) throw new Error(`support loop sweep could not read closed tickets: ${unstampedErr.message}`)
  const tickets = [...((live ?? []) as any[]), ...((unstamped ?? []) as any[])]
  out.scanned = tickets.length
  if (!tickets.length) return out
  const ids = tickets.map((t) => t.id as string)

  // The evidence the loop has left — ONE read per kind, never per ticket.
  const [{ data: evRows, error: evErr }, { data: noteRows, error: noteErr }] = await Promise.all([
    svc.from("lifecycle_events").select("entity_id").eq("event_type", "support.ticket_triaged").eq("entity_type", "support_ticket").in("entity_id", ids).limit(5000),
    svc.from("notifications").select("entity_id, type").eq("entity_type", "support_ticket").in("entity_id", ids).limit(10000),
  ])
  if (evErr) throw new Error(`support loop sweep could not read triage evidence: ${evErr.message}`)
  if (noteErr) throw new Error(`support loop sweep could not read escalation evidence: ${noteErr.message}`)
  const triaged = new Set(((evRows ?? []) as Array<{ entity_id: string }>).map((r) => r.entity_id))
  const notesBy = new Map<string, Set<string>>()
  for (const n of (noteRows ?? []) as Array<{ entity_id: string; type: string }>) { const s = notesBy.get(n.entity_id) ?? new Set<string>(); s.add(n.type); notesBy.set(n.entity_id, s) }
  const kinds: SlaBreachKind[] = ["first_response", "resolution"]
  const evidenceOf = (id: string): LoopEvidence => {
    const s = notesBy.get(id) ?? new Set<string>()
    // An office queue with nobody to page was handed to platform staff (content-free) — that IS both tiers' page.
    const unattended = s.has("support_queue_unattended")
    return { triaged: triaged.has(id), escalated: kinds.filter((k) => unattended || s.has(`support_sla_breach_${k}`)), secondTier: kinds.filter((k) => unattended || s.has(`support_sla_second_tier_${k}`)) }
  }

  for (const t of tickets) {
    const state = supportTicketLoopState(t, evidenceOf(t.id), now)
    out.stages[state.stage] += 1
    out.states.push({ id: t.id, ...state })
    if (!state.stranded || deps.dryRun) continue
    let moved = false
    let why = state.reason
    try {
      if (state.next === "retriage") {
        const triage = deps.triage ?? (async (s: any, input: any) => (await import("@/lib/support/ticket-triage")).triageSupportTicket(s, input))
        const lane = t.lane === "tenant_to_platform" || t.lane === "user_to_brokerage" ? t.lane : null
        if (!lane || !t.brokerage_id) why = `cannot re-triage: ${!lane ? `unknown lane "${t.lane}"` : "no tenant on the ticket"}`
        else {
          const r = await triage(svc, { ticketId: t.id, brokerageId: t.brokerage_id, lane, subject: t.subject ?? "Support ticket", description: t.description ?? null, category: t.category ?? null, priority: t.priority ?? null, submitterUserId: t.submitted_by_user_id ?? null })
          moved = r.evented
          if (moved) out.retriaged += 1
          else why = `re-triage left no evidence: ${r.error ?? "unknown"}`
        }
      } else if (state.next === "escalate") {
        // The first tier is runSupportSlaSweep's (it runs first on the same cron; the guard drives both in order); a
        // ticket still un-paged here had nobody to receive it (counted undeliverable there) — named, never dropped.
        why = "first-tier page not delivered (no recipient on the answering side) — see runSupportSlaSweep.undeliverable"
      } else if (state.next === "escalate_second_tier") {
        const delivered = await secondTierPage(svc, t, evidenceOf(t.id), now)
        moved = delivered > 0
        if (moved) out.secondTier += 1
        else why = "second-tier page reached nobody"
      } else if (state.next === "auto_close") {
        const r = await autoCloseResolved(svc, t, now)
        moved = r.ok
        if (moved) out.autoClosed += 1
        else why = `auto-close refused: ${r.error}`
      } else if (state.next === "repair_resolved_at") {
        const stamp = t.updated_at ?? now.toISOString()
        const { data: rows, error } = await svc.from("support_tickets").update({ resolved_at: stamp }).eq("id", t.id).eq("brokerage_id", t.brokerage_id).is("resolved_at", null).select("id")
        moved = !error && ((rows ?? []) as unknown[]).length > 0
        if (moved) out.repaired += 1
        else why = `resolved_at repair refused: ${error?.message ?? "matched no row"}`
      }
    } catch (e) { why = `${state.next} threw: ${e instanceof Error ? e.message : String(e)}` }
    if (!moved) out.strandedLeft.push({ id: t.id, reason: why })
  }
  return out
}

/** Second tier: the answering side again, at high priority, ONCE per (ticket, kind); an office lane with nobody to
 *  page falls back to the content-free platform notice. Returns the number of people told. */
async function secondTierPage(svc: any, t: LoopTicket & { subject?: string | null }, ev: LoopEvidence, now: Date): Promise<number> {
  const sla = evaluateTicketSla(t, now)
  let total = 0
  for (const kind of sla.breaches.filter((k) => !ev.secondTier.includes(k))) {
    const label = kind === "first_response" ? "first response" : "resolution"
    const payload = {
      type: `support_sla_second_tier_${kind}`,
      title: `Still unanswered (${label}, ${SECOND_TIER_MULTIPLIER}× target): ${t.subject ?? "Support ticket"}`,
      body: `This ticket was paged once and is still past its ${label} target (${Math.round(sla.ageHours)}h old, priority ${t.priority ?? "medium"}). It needs an owner today. Recovered by the support sweep (cron).`,
      entityType: "support_ticket", entityId: t.id, priority: "high" as const,
    }
    let delivered = 0
    // WHO answers is the one decision ticketAnsweredBy makes (ticket-constants.ts) — read once, then branched on.
    const answerer = ticketAnsweredBy(t.lane)
    if (answerer === "brokerage_office") {
      if (!t.brokerage_id) continue
      const { notifyBrokerageAdmins } = await import("@/lib/notifications/brokerage-admins")
      delivered = await notifyBrokerageAdmins(svc, t.brokerage_id, payload)
      if (delivered === 0) delivered = await unattendedQueueNotice(svc, t)
    } else {
      const { notifyPlatformStaff } = await import("@/lib/notifications/platform-staff")
      delivered = await notifyPlatformStaff(svc, payload)
    }
    total += delivered
  }
  return total
}

/** Close a ticket that has sat resolved past RESOLVED_AUTO_CLOSE_DAYS with no reply — ledgered (LAW 5), counted,
 *  evidenced, and the requester told how to reopen it (a reply reopens: lib/support/support-thread.ts). */
async function autoCloseResolved(svc: any, t: LoopTicket & { subject?: string | null; submitted_by_user_id?: string | null }, now: Date): Promise<{ ok: boolean; error: string | null }> {
  if (!t.brokerage_id) return { ok: false, error: "no tenant on the ticket" }
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  return withActionLedger<{ ok: boolean; error: string | null }>(
    {
      brokerageId: t.brokerage_id, action: "support.ticket.auto_close",
      actor: { type: "system", managerKey: "data_steward" },
      subject: { type: "support_ticket", id: t.id },
      reasonDetail: `resolved at ${t.resolved_at}; no requester reply in ${RESOLVED_AUTO_CLOSE_DAYS} days`,
      idempotencyKey: `support_autoclose:${t.id}:${t.resolved_at}`, riskClass: "LOW_RISK_WRITE", channel: "support",
      detail: { lane: t.lane, recovered_by: "cron" },
    },
    async () => {
      const { data: rows, error } = await svc.from("support_tickets").update({ status: "closed", updated_at: now.toISOString() })
        .eq("id", t.id).eq("brokerage_id", t.brokerage_id).eq("status", "resolved").select("id")
      if (error) return { ok: false, error: error.message }
      if (((rows ?? []) as unknown[]).length === 0) return { ok: false, error: "matched no resolved row on this tenant (reopened or already closed)" }
      try {
        const { emitKernelEvent } = await import("@/lib/kernel/emit")
        await emitKernelEvent({ event: "support.ticket_closed", brokerageId: t.brokerage_id as string, entityType: "support_ticket", entityId: t.id, actorUserId: null, source: "cron", auditOnly: true, client: svc, metadata: { closed_by: "support_loop_sweep", recovered_by: "cron", resolved_at: t.resolved_at, lane: t.lane } })
      } catch (e) { console.error("[support-sla] auto-close evidence failed:", e instanceof Error ? e.message : String(e)) }
      if (t.submitted_by_user_id) {
        const { error: nErr } = await svc.from("notifications").insert({
          user_id: t.submitted_by_user_id, brokerage_id: t.brokerage_id, type: "support_ticket_closed",
          title: `Closed: ${(t.subject ?? "your support ticket").slice(0, 80)}`,
          body: `This ticket was resolved ${RESOLVED_AUTO_CLOSE_DAYS} days ago and we did not hear back, so it is now closed. Reply on the ticket any time to reopen it.`,
          entity_type: "support_ticket", entity_id: t.id, priority: "low", is_read: false,
        })
        if (nErr) console.error("[support-sla] auto-close bell refused:", nErr.message)
      }
      return { ok: true, error: null }
    },
    {
      settle: (r) => ({ status: r.ok ? "executed" : "failed", outcome: r.ok ? "closed" : "not_closed", error: r.error }),
      replay: () => ({ ok: true, error: null }),
    },
    { client: svc },
  )
}
