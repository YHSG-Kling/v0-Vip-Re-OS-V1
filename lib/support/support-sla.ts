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

export interface SlaSweepResult { open: number; breached: number; escalated: number }

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
        .eq("type", type).eq("entity_id", t.id).limit(1).maybeSingle()
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
      if (ticketAnsweredBy(t.lane) === "brokerage_office") {
        if (!t.brokerage_id) continue
        const { notifyBrokerageAdmins } = await import("@/lib/notifications/brokerage-admins")
        await notifyBrokerageAdmins(svc, t.brokerage_id, payload)
      } else {
        const { notifyPlatformStaff } = await import("@/lib/notifications/platform-staff")
        await notifyPlatformStaff(svc, payload)
      }
      result.escalated += 1
    }
  }
  return result
}
