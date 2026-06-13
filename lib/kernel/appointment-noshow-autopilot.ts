// lib/kernel/appointment-noshow-autopilot.ts
//
// THE APPOINTMENT NO-SHOW / RESCHEDULE AUTOPILOT — protect every appointment the
// intent-router now auto-books. Two jobs, both GATED (nothing auto-sends):
//
//   · UPCOMING appointments inside the reminder window → propose ONE gated client
//     reminder (idempotent per appointment) so the client actually shows.
//   · MISSED appointments (start passed by a grace window, status still 'scheduled'
//     and never completed/cancelled) → mark the calendar_event status 'no_show'
//     (canonical, the column is free-text + nullable), drop an audit lifecycle_event,
//     propose a GATED warm re-book message ("sorry we missed you — here are new times"),
//     and FEED the contact to the EXISTING AI-ISA re-engage loop so the relationship
//     stays alive (no parallel re-engage system).
//
// OWNER: deal_coordinator. manager-registry maps the calendar_events table AND the
// appointment lifecycle (deadline_watcher, fire_drills, briefing_deal_risk) to
// deal_coordinator. These are POST-handoff converted-contact appointments — the deal
// calendar — so the Deal Coordinator owns it. (The AI ISA owns PRE-handoff lead nurture;
// the appointment-whisper is the agent's pre-meeting briefing, a different surface.)
//
// REUSE, NOT REBUILD:
//   · proposeClientMessage (lib/agents/agent-client-messages) — the gate.
//   · initiateAIISAContactEngagement (the canonical consent-aware re-engage entry the
//     stale-contact cron + ghost-reengagement already use) — keep-the-conversation-alive.
//   · idempotency mirrors client-pulse / referral-radar (rationale tag + 1-per-window).
//
// NOT server-only (simulator-driven, like the rest of the kernel loaders).

import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "@/lib/kernel/events"

type Svc = ReturnType<typeof createServiceClient>

// ── Tunables ──────────────────────────────────────────────────────────────────

/** An appointment is "missed" only once its start is THIS many minutes in the past
 *  AND it is still 'scheduled' (never completed/cancelled/no_show). The grace window
 *  avoids firing on someone who is merely 10 minutes late. */
export const DEFAULT_GRACE_MINUTES = 90

/** Propose the reminder when the appointment starts within THIS many hours from now
 *  (and is still at least a few minutes out — we never "remind" a meeting that already
 *  started). */
export const DEFAULT_REMINDER_WINDOW_HOURS = 24
export const DEFAULT_REMINDER_MIN_LEAD_MINUTES = 30

/** The appointment event_types this autopilot protects — the client-facing consultations
 *  / showings the intent-router books. (NOT internal deadline/milestone calendar rows.) */
export const APPOINTMENT_EVENT_TYPES = [
  "isa_appointment",
  "showing",
  "buyer_consultation",
  "listing_consultation",
  "listing_presentation",
  "consultation",
  "appointment",
  "follow_up",
] as const

/** Statuses that mean the appointment is STILL OPEN (eligible for no-show / reminder).
 *  null counts as scheduled (legacy rows). 'completed'/'cancelled'/'canceled'/'no_show'
 *  are terminal → 'ok'. */
const OPEN_STATUSES = new Set(["scheduled", "confirmed", "pending"])
const TERMINAL_STATUSES = new Set(["completed", "cancelled", "canceled", "no_show", "rescheduled"])

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AppointmentRow {
  id: string
  brokerage_id: string
  entity_type: string | null
  entity_id: string | null
  event_type: string | null
  start_at: string
  status: string | null
  title: string | null
  agent_user_id: string | null
  metadata: Record<string, unknown> | null
}

export type AppointmentClass = "upcoming_reminder_due" | "missed_noshow" | "ok"

export interface ClassifyOpts {
  graceMinutes?: number
  reminderWindowHours?: number
  reminderMinLeadMinutes?: number
}

export interface RebookProposal {
  brokerageId: string
  agentKind: "deal_coordinator"
  entityType: "calendar_event"
  entityId: string
  recipientContactId: string
  audience: "buyer" | "seller" | "lead"
  subject: string
  body: string
  rationale: string
  channel: "portal"
}

export interface ReminderContext {
  firstName: string | null
  title: string | null
  startAt: string
}

// ── classifyAppointment (PURE) ──────────────────────────────────────────────────

/**
 * Decide what (if anything) this appointment needs RIGHT NOW.
 *  · terminal status (completed/cancelled/no_show/rescheduled) → 'ok'
 *  · start in the past by ≥ grace AND still open → 'missed_noshow'
 *  · start within the reminder window (and ≥ min-lead out) AND still open → 'upcoming_reminder_due'
 *  · otherwise → 'ok'
 */
export function classifyAppointment(
  now: Date,
  appt: Pick<AppointmentRow, "start_at" | "status">,
  opts: ClassifyOpts = {},
): AppointmentClass {
  const grace = opts.graceMinutes ?? DEFAULT_GRACE_MINUTES
  const windowH = opts.reminderWindowHours ?? DEFAULT_REMINDER_WINDOW_HOURS
  const minLead = opts.reminderMinLeadMinutes ?? DEFAULT_REMINDER_MIN_LEAD_MINUTES

  const status = (appt.status ?? "scheduled").toLowerCase()
  if (TERMINAL_STATUSES.has(status)) return "ok"
  if (!OPEN_STATUSES.has(status)) return "ok" // unknown non-open status → leave alone

  const startMs = new Date(appt.start_at).getTime()
  if (Number.isNaN(startMs)) return "ok"
  const nowMs = now.getTime()
  const minutesFromNow = (startMs - nowMs) / 60_000

  // Past by at least the grace window → missed.
  if (minutesFromNow <= -grace) return "missed_noshow"

  // Still upcoming: inside [minLead, windowH*60] minutes from now → remind.
  if (minutesFromNow >= minLead && minutesFromNow <= windowH * 60) {
    return "upcoming_reminder_due"
  }

  return "ok"
}

// ── rebookPlan (PURE) ────────────────────────────────────────────────────────────

/** Resolve the gate audience from the contact's role on the appointment/contact row. */
function resolveAudience(contactType: string | null): "buyer" | "seller" | "lead" {
  const t = (contactType ?? "").toLowerCase()
  if (t.includes("seller")) return "seller"
  if (t.includes("buyer")) return "buyer"
  return "lead"
}

/**
 * The GATED warm re-book proposal shape for a MISSED appointment. Pure — frames the
 * "sorry we missed you, here are new times" message; the runner hands this to
 * proposeClientMessage. No times are invented — the agent picks them on approval.
 */
export function rebookPlan(
  appt: Pick<AppointmentRow, "id" | "brokerage_id" | "title">,
  contact: { id: string; first_name: string | null; contact_type: string | null },
): RebookProposal {
  const name = contact.first_name?.trim() || "there"
  const what = appt.title?.trim() || "our appointment"
  const body =
    `Hi ${name} — we had ${what} on the calendar and didn't get to connect. ` +
    `No worries at all, life happens! I'd still love to get you in. ` +
    `Here are a couple of new times that could work — just reply with what's best and I'll lock it in.`
  return {
    brokerageId: appt.brokerage_id,
    agentKind: "deal_coordinator",
    entityType: "calendar_event",
    entityId: appt.id,
    recipientContactId: contact.id,
    audience: resolveAudience(contact.contact_type),
    subject: `Let's reschedule ${what}`,
    body,
    rationale:
      `APPOINTMENT NO-SHOW — the client missed ${what}; warm gated re-book ` +
      `("sorry we missed you, here are new times") so the relationship and the booked intent stay alive.`,
    channel: "portal",
  }
}

/** PURE: the gated UPCOMING reminder body. */
export function reminderPlan(
  appt: Pick<AppointmentRow, "id" | "brokerage_id" | "title">,
  contact: { id: string; first_name: string | null; contact_type: string | null },
  ctx: ReminderContext,
): RebookProposal {
  const name = contact.first_name?.trim() || "there"
  const what = appt.title?.trim() || ctx.title?.trim() || "our appointment"
  const when = formatWhen(ctx.startAt)
  const body =
    `Hi ${name} — just a friendly reminder about ${what}${when ? ` ${when}` : ""}. ` +
    `Looking forward to it! If anything's changed and you need to reschedule, just reply here and we'll find a new time.`
  return {
    brokerageId: appt.brokerage_id,
    agentKind: "deal_coordinator",
    entityType: "calendar_event",
    entityId: appt.id,
    recipientContactId: contact.id,
    audience: resolveAudience(contact.contact_type),
    subject: `Reminder: ${what}`,
    body,
    rationale:
      `APPOINTMENT REMINDER — gated pre-appointment client reminder for ${what} so the ` +
      `auto-booked appointment actually gets honored (protects the booked intent).`,
    channel: "portal",
  }
}

/** Human-readable "on Friday at 2:00 PM" style. Pure, UTC-safe (no tz fabrication). */
function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  try {
    return `on ${d.toLocaleString("en-US", { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" })} (your local time may vary)`
  } catch {
    return `on ${iso.slice(0, 16).replace("T", " ")}`
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────

export interface NoShowAutopilotOpts {
  now?: Date
  graceMinutes?: number
  reminderWindowHours?: number
  reminderMinLeadMinutes?: number
  /** cap per brokerage per run */
  maxBatch?: number
  /** seam: inject the re-engage entry so tests don't fire real outreach */
  reengage?: (contactId: string) => Promise<{ success: boolean; reason?: string }>
}

export interface NoShowAutopilotResult {
  scanned: number
  remindersProposed: number
  noShowsMarked: number
  rebooksProposed: number
  reengaged: number
  skipped: number
}

/** The rationale-tag idempotency markers (mirror client-pulse / referral-radar). */
const REMINDER_TAG = "APPOINTMENT REMINDER"
const REBOOK_TAG = "APPOINTMENT NO-SHOW"

/**
 * One sweep over a brokerage's open client appointments. UPCOMING → gated reminder
 * (idempotent per appt). MISSED → mark no_show + audit lifecycle_event + gated re-book +
 * feed the contact to the existing AI-ISA re-engage loop. Idempotent per (appt, stage);
 * honest skip when nothing is due. Never throws on a single-row failure.
 */
export async function runAppointmentNoShowAutopilot(
  brokerageId: string,
  opts: NoShowAutopilotOpts = {},
  client?: Svc,
): Promise<NoShowAutopilotResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const grace = opts.graceMinutes ?? DEFAULT_GRACE_MINUTES
  const windowH = opts.reminderWindowHours ?? DEFAULT_REMINDER_WINDOW_HOURS
  const minLead = opts.reminderMinLeadMinutes ?? DEFAULT_REMINDER_MIN_LEAD_MINUTES
  const maxBatch = opts.maxBatch ?? 100

  const result: NoShowAutopilotResult = {
    scanned: 0, remindersProposed: 0, noShowsMarked: 0,
    rebooksProposed: 0, reengaged: 0, skipped: 0,
  }

  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  const reengage =
    opts.reengage ??
    (async (contactId: string) => {
      const { initiateAIISAContactEngagement } = await import(
        "@/app/actions/ai-isa/initiate-contact-engagement"
      )
      return initiateAIISAContactEngagement(contactId)
    })

  // Fetch open, client-facing appointments in the relevant window: anything starting
  // from (now - generous past horizon for no-shows) through (now + reminder window).
  // We over-fetch a couple of days of past so freshly-missed appointments are caught.
  const pastHorizon = new Date(now.getTime() - 3 * 86_400_000).toISOString()
  const futureHorizon = new Date(now.getTime() + windowH * 3_600_000).toISOString()

  const { data: rows } = await supabase
    .from("calendar_events")
    .select("id, brokerage_id, entity_type, entity_id, event_type, start_at, status, title, agent_user_id, metadata")
    .eq("brokerage_id", brokerageId)
    .eq("entity_type", "contact")
    .in("event_type", APPOINTMENT_EVENT_TYPES as unknown as string[])
    .gte("start_at", pastHorizon)
    .lte("start_at", futureHorizon)
    .order("start_at", { ascending: true })
    .limit(maxBatch)

  for (const r of (rows ?? []) as AppointmentRow[]) {
    result.scanned += 1
    try {
      if (!r.entity_id) { result.skipped += 1; continue }
      const klass = classifyAppointment(now, r, {
        graceMinutes: grace, reminderWindowHours: windowH, reminderMinLeadMinutes: minLead,
      })
      if (klass === "ok") { result.skipped += 1; continue }

      // Load the contact once; honor suppression (withdrawn never touched).
      const { data: c } = await supabase
        .from("contacts")
        .select("id, first_name, contact_type, nurture_status, dnc_status, isa_reengage_allowed, deleted_at")
        .eq("id", r.entity_id)
        .maybeSingle()
      const contact = c as
        | { id: string; first_name: string | null; contact_type: string | null; nurture_status: string | null; dnc_status: boolean | null; isa_reengage_allowed: boolean | null; deleted_at: string | null }
        | null
      if (!contact || contact.deleted_at || (contact.nurture_status ?? "") === "withdrawn") {
        result.skipped += 1
        continue
      }

      if (klass === "upcoming_reminder_due") {
        // Idempotency — one reminder per appointment (rationale tag + entity id).
        if (await alreadyProposed(supabase, r.id, REMINDER_TAG)) { result.skipped += 1; continue }
        const plan = reminderPlan(r, contact, {
          firstName: contact.first_name, title: r.title, startAt: r.start_at,
        })
        const res = await proposeClientMessage(plan, supabase)
        if (res.ok) result.remindersProposed += 1
        else result.skipped += 1
        continue
      }

      // ── MISSED ─────────────────────────────────────────────────────────────
      // 1) Mark the calendar_event no_show (canonical; column is free-text/nullable).
      //    Claim semantics: only flips a still-open row, so the no-show + re-book fire ONCE.
      const { data: claimed } = await supabase
        .from("calendar_events")
        .update({
          status: "no_show",
          metadata: { ...(r.metadata ?? {}), no_show_marked_at: now.toISOString(), no_show_by: "appointment_noshow_autopilot" },
        })
        .eq("id", r.id)
        .or("status.is.null,status.eq.scheduled,status.eq.confirmed,status.eq.pending")
        .select("id")
        .maybeSingle()

      if (!claimed) { result.skipped += 1; continue } // someone else already handled it
      result.noShowsMarked += 1

      // 2) Audit lifecycle_event (no fan-out side-effects — a plain audit row like crm.ts).
      await supabase.from("lifecycle_events").insert({
        brokerage_id: brokerageId,
        entity_type: "contact",
        entity_id: contact.id,
        event_type: KernelEvent.APPOINTMENT_NO_SHOW,
        metadata: { calendar_event_id: r.id, appointment_title: r.title, start_at: r.start_at },
        created_at: now.toISOString(),
      }).then(() => void 0, () => void 0)

      // 3) Gated warm re-book proposal.
      const plan = rebookPlan(r, contact)
      const res = await proposeClientMessage(plan, supabase)
      if (res.ok) result.rebooksProposed += 1

      // 4) Keep the conversation alive — feed the contact to the EXISTING re-engage loop.
      //    Skip when the contact has explicitly opted out of ISA re-engage / is DNC.
      if (contact.isa_reengage_allowed !== false && contact.dnc_status !== true) {
        try {
          const rr = await reengage(contact.id)
          if (rr.success) result.reengaged += 1
        } catch { /* re-engage is best-effort; never fail the sweep */ }
      }
    } catch {
      result.skipped += 1
    }
  }

  return result
}

/** True when a proposal with this rationale tag already exists for this appointment. */
async function alreadyProposed(supabase: Svc, calendarEventId: string, tag: string): Promise<boolean> {
  const { data } = await supabase
    .from("agent_client_messages")
    .select("id")
    .eq("entity_type", "calendar_event")
    .eq("entity_id", calendarEventId)
    .ilike("rationale", `${tag}%`)
    .limit(1)
    .maybeSingle()
  return !!data
}
