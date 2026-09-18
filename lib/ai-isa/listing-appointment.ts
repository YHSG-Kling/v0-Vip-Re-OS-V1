/**
 * lib/ai-isa/listing-appointment.ts
 *
 * THE LISTING APPOINTMENT — the ONE survivor every AI-agent surface calls for
 * the "no-obligation agent visit" moment (wave 75 rulings, owner verbatim):
 *
 *   "the no obligation meeting should be marked as a listing appointment so
 *   that the workflow creates the follow up until the appt which should be
 *   at least a week out. since this is an appt for an agent, the calendar
 *   should be hooked up so that the ai agent can find a time and day that
 *   works for the person and set up the appt right then and the agent just
 *   confirms it. then the auto calendar emails go out and is pushed to their
 *   portal in app."
 *
 * ── WHAT THIS REPLACES ───────────────────────────────────────────────────
 * lib/ai-isa/customer-context-tools.ts::buildBookAgentAppointmentTool wrote
 * only an `activities`/`leads.next_followup_at` row with a "now" placeholder
 * timestamp — no calendar lookup, no real slot, no agent confirmation step,
 * no auto emails, no portal push. This module is the missing half: it reads
 * the AGENT's own connected calendar (lib/providers/calendar/personal-
 * calendar.ts — the SAME Google/Microsoft OAuth adapter the rest of the OS
 * already books through, never a second calendar client), books a tentative
 * hold, and drives the confirm → notify → remind pipeline. The old tool is
 * RETIRED in favor of `book_listing_appointment` (tombstone at
 * lib/ai-isa/customer-context-tools.ts).
 *
 * ── REUSE, NOT REBUILD ───────────────────────────────────────────────────
 *   · calendar_events IS the appointments table — CalendarEventType.
 *     LISTING_APPOINTMENT ('listing_appointment') already exists (lib/kernel/
 *     calendar-types.ts:27) and carries NO live CHECK constraint (verified:
 *     absent from scripts/check-vocabularies.ts, and no
 *     `ALTER TABLE calendar_events ... CHECK` anywhere in supabase/migrations —
 *     confirmed by grep). So no migration is required to accept either the
 *     event_type or the new `pending_agent_confirmation` status: the column
 *     is free text, exactly like the existing 'scheduled'/'completed'/
 *     'cancelled'/'no_show' values every other writer already uses with no
 *     CHECK enforcing them. Migration m655 is therefore UNUSED this wave —
 *     see the lane report.
 *   · lib/providers/calendar/personal-calendar.ts (Google Calendar v3 /
 *     Microsoft Graph via the existing REST connector gateway — googleapis is
 *     NOT a dependency of this repo, verified against package.json) is the
 *     adapter: getAvailabilityViaPersonal for free/busy, createEventViaPersonal
 *     to book, updateEventViaPersonal to confirm. It returns `null` when the
 *     agent has no connected calendar — that is FAIL CLOSED here: no mock
 *     slots are ever invented (lib/providers/calendar/index.ts's
 *     getAvailability() mock fallback is deliberately NOT used by this
 *     module).
 *   · lib/kernel/write-sentinel.ts::sentinelWrite — every write.
 *   · lib/kernel/manager-signals.ts::publishManagerSignal — the agent
 *     confirmation hand-off (ai_isa → listing_concierge).
 *   · portal_event_stream (app/actions/portal-stream.ts) IS the existing
 *     agent approval/notification rail: composer.ts's agent action queue
 *     already surfaces ANY open `agent_action_required` row with zero new UI,
 *     and dispositionPortalEventAction's "execute" mode is extended (this
 *     wave) with ONE event_type branch that calls confirmListingAppointment
 *     below — "the agent just confirms it" from the SAME surface every other
 *     agent action already confirms from. The same table's customer_copy
 *     doubles as the contact's portal in-app push (getCustomerPortalFeed
 *     already reads it) — one row, two readers, never a second table.
 *   · lib/providers/dispatch.ts::dispatchEmail (→ messaging sendEmail) — extended with an optional
 *     ICS attachment (this wave) for the auto calendar emails.
 *   · lib/kernel/appointment-noshow-autopilot.ts — "listing_appointment" is
 *     added to APPOINTMENT_EVENT_TYPES (this wave) so the existing within-24h
 *     no-show/reminder autopilot ALSO protects this appointment type; the
 *     5-day/2-day/morning-of cadence below is ADDITIVE (a longer-horizon
 *     "don't forget" touch), not a replacement for that autopilot.
 *
 * No new tables. contactId is REQUIRED — an appointment is for a CONTACT
 * (CLAUDE.md wave75/75C brief); a lead caller converts FIRST via lane 75A's
 * survivor (convertSellerLeadOnIntent), then books on the resulting contact —
 * that conversion happens at the CALLER (lib/ai-isa/customer-context-tools.ts),
 * never inside this module, so this module never has to guess a lead's intent
 * reason.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { publishManagerSignal } from "@/lib/kernel/manager-signals"
import { resolveAgentRecordToUserId } from "@/lib/kernel/agent-identity-resolver"
import { CalendarEventType } from "@/lib/kernel/calendar-types"
import { getAvailabilityViaPersonal, createEventViaPersonal, updateEventViaPersonal } from "@/lib/providers/calendar/personal-calendar"
import { DEFAULT_WORKING_HOURS, type WorkingHours, type FreeSlot } from "@/lib/providers/calendar/free-slots"
// Emails go through the ONE governed egress (lib/providers/dispatch.ts) — the
// low-level messaging sender is never imported here (egress-send-guard).
import { dispatchEmail } from "@/lib/providers/dispatch"
import { daysBetween } from "@/lib/format/dates"

type Svc = ReturnType<typeof createServiceClient>

// ── Tunables ──────────────────────────────────────────────────────────────

/** Owner ruling: "at least a week out." Every slot offered and every booking
 *  accepted is checked against this — never trusted from the caller. */
export const LISTING_APPOINTMENT_MIN_DAYS_OUT = 7

/** How far past the min-days floor to search before giving up. */
const SEARCH_HORIZON_DAYS = 28

const DEFAULT_DURATION_MINUTES = 45

/** The internal appointment_type / event_type this module owns on
 *  calendar_events — already a live enum member, see header. */
export const LISTING_APPOINTMENT_EVENT_TYPE = CalendarEventType.LISTING_APPOINTMENT

/** calendar_events.status values THIS module writes. Free text (no CHECK,
 *  see header) but declared once here so every writer/reader in this file
 *  uses the SAME spelling (CLAUDE.md §6). */
export const LISTING_APPOINTMENT_STATUS = {
  PENDING_AGENT_CONFIRMATION: "pending_agent_confirmation",
  CONFIRMED: "scheduled", // the existing "booked and on the calendar" spelling every other calendar_events writer uses
  CANCELLED: "cancelled",
} as const

const OPEN_LISTING_APPOINTMENT_STATUSES = [
  LISTING_APPOINTMENT_STATUS.PENDING_AGENT_CONFIRMATION,
  LISTING_APPOINTMENT_STATUS.CONFIRMED,
] as const

/** The portal_event_stream event_type this module's agent-confirmation card
 *  carries — dispositionPortalEventAction's "execute" branch keys off this
 *  EXACT string (app/actions/portal-stream.ts). One vocabulary (§6). */
export const LISTING_APPOINTMENT_CONFIRM_EVENT_TYPE = "listing_appointment_confirmation_needed"
export const LISTING_APPOINTMENT_CONFIRMED_EVENT_TYPE = "listing_appointment_confirmed"

/** The reminder cadence the owner asked for: 5 days out, 2 days out, and the
 *  morning of. Pure vocabulary — reminderTierForAppointment below is the only
 *  place that derives a tier from a date, so no second spelling can drift. */
export type ReminderTier = "5_day" | "2_day" | "morning_of"
export const REMINDER_TIER_DAYS_OUT: Record<ReminderTier, number> = {
  "5_day": 5,
  "2_day": 2,
  morning_of: 0,
}

// ── Pure helpers (unit-tested directly by scripts/listing-appointment-simulator.ts) ──

/** PURE — "at least a week out," derived from `daysBetween` (lib/format/dates.ts,
 *  §6 survivor for day-diff math), never a hand-rolled subtraction. Ceil: a slot
 *  6.2 days out is still inside the 7th day boundary from "now," so floor would
 *  wrongly admit it — ceil is the conservative (reject-leaning) rounding the
 *  owner's "AT LEAST a week" calls for. */
export function isAtLeastMinDaysOut(
  startIso: string,
  minDays: number = LISTING_APPOINTMENT_MIN_DAYS_OUT,
  now: Date = new Date(),
): boolean {
  const parsed = Date.parse(startIso)
  if (Number.isNaN(parsed)) return false
  return daysBetween(now, startIso, { round: "floor" }) >= minDays
}

/** PURE — which reminder tier (if any) an appointment's start date is due for,
 *  measured from `now`'s calendar day. Returns null when no tier matches
 *  today (the caller then checks metadata.reminder_tiers_sent for idempotency
 *  on the days it DOES match, e.g. a cron that runs more than once). */
export function reminderTierForAppointment(startIso: string, now: Date = new Date()): ReminderTier | null {
  const daysOut = daysBetween(now, startIso, { round: "floor" })
  if (daysOut === REMINDER_TIER_DAYS_OUT["5_day"]) return "5_day"
  if (daysOut === REMINDER_TIER_DAYS_OUT["2_day"]) return "2_day"
  if (daysOut === REMINDER_TIER_DAYS_OUT.morning_of) return "morning_of"
  return null
}

export interface SlotPreference {
  /** "mon".."sun", lowercase — only these weekdays are offered. Empty/undefined = any day. */
  preferredDays?: string[]
  /** "morning" (before 12:00), "afternoon" (12:00-17:00), "evening" (after 17:00 —
   *  only reachable when the agent's own working hours extend that late). */
  preferredWindow?: "morning" | "afternoon" | "evening" | null
}

const WEEKDAY_ABBR = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const

/** PURE — narrow a candidate slot list to the person's stated day-of-week /
 *  time-of-day preference. An empty result is a legitimate answer (the caller
 *  widens the search window or offers what's available with a caveat) —
 *  never silently ignored. */
export function filterSlotsByPreference(slots: FreeSlot[], pref: SlotPreference): FreeSlot[] {
  const days = (pref.preferredDays ?? []).map((d) => d.slice(0, 3).toLowerCase())
  return slots.filter((s) => {
    const d = new Date(s.startTime)
    if (days.length > 0 && !days.includes(WEEKDAY_ABBR[d.getUTCDay()])) return false
    if (pref.preferredWindow) {
      const hour = d.getUTCHours()
      const window = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening"
      if (window !== pref.preferredWindow) return false
    }
    return true
  })
}

/** PURE — defensive parse of ai_identity_profiles.business_hours (a free-form
 *  jsonb the voice receptionist already reads as an opaque blob — lib/voice/
 *  twilio-voice.ts:112). Recognizes `{start_hour, end_hour}` or `{start,end}`
 *  ("09:00"/"17:00") shapes; anything else (including null/legacy per-day
 *  objects this module doesn't need to interpret) falls back to the same
 *  09:00-17:00 window free-slots.ts has always used, so a malformed or unset
 *  value degrades to the EXISTING behavior rather than refusing to find slots. */
export function resolveWorkingHours(businessHours: unknown): WorkingHours {
  if (businessHours && typeof businessHours === "object") {
    const b = businessHours as Record<string, unknown>
    if (typeof b.start_hour === "number" && typeof b.end_hour === "number") {
      return { startHour: b.start_hour, endHour: b.end_hour }
    }
    const parseHour = (v: unknown): number | null => {
      if (typeof v !== "string") return null
      const m = /^(\d{1,2}):/.exec(v)
      return m ? Number(m[1]) : null
    }
    const start = parseHour(b.start)
    const end = parseHour(b.end)
    if (start !== null && end !== null && end > start) return { startHour: start, endHour: end }
  }
  return DEFAULT_WORKING_HOURS
}

/** PURE — a single-event ICS (RFC 5545), the auto calendar email attachment.
 *  No library needed for one VEVENT; kept pure so the simulator can assert
 *  its shape without a real send. */
export function buildAppointmentIcs(params: {
  uid: string
  startIso: string
  endIso: string
  summary: string
  description: string
  location: string | null
  organizerEmail: string
  attendeeEmail: string
}): string {
  const fmt = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z"
  const esc = (s: string) => s.replace(/[\\,;]/g, (c) => `\\${c}`).replace(/\n/g, "\\n")
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Real Estate OS//Listing Appointment//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${params.uid}`,
    `DTSTAMP:${fmt(new Date().toISOString())}`,
    `DTSTART:${fmt(params.startIso)}`,
    `DTEND:${fmt(params.endIso)}`,
    `SUMMARY:${esc(params.summary)}`,
    `DESCRIPTION:${esc(params.description)}`,
    params.location ? `LOCATION:${esc(params.location)}` : null,
    `ORGANIZER:mailto:${params.organizerEmail}`,
    `ATTENDEE:mailto:${params.attendeeEmail}`,
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter((l): l is string => l !== null).join("\r\n")
}

// ── findAgentAppointmentSlots ────────────────────────────────────────────

export interface FindAgentAppointmentSlotsParams {
  brokerageId: string
  /** agents.id (NOT users.id) — resolved to the agent's users.id internally. */
  agentId: string
  preferredDays?: string[]
  preferredWindows?: ("morning" | "afternoon" | "evening")[]
  minDaysOut?: number
  count?: number
  durationMinutes?: number
}

export type FindAgentAppointmentSlotsResult =
  | { success: true; slots: FreeSlot[]; minDaysOut: number }
  | { success: false; reason: "calendar_not_connected"; offerCallback: true; message: string }
  | { success: false; reason: "agent_not_found" | "availability_error"; offerCallback: true; message: string }

export async function findAgentAppointmentSlots(
  params: FindAgentAppointmentSlotsParams,
): Promise<FindAgentAppointmentSlotsResult> {
  const minDaysOut = params.minDaysOut ?? LISTING_APPOINTMENT_MIN_DAYS_OUT
  const count = params.count ?? 3
  const durationMinutes = params.durationMinutes ?? DEFAULT_DURATION_MINUTES

  const agentUserId = await resolveAgentRecordToUserId(params.agentId)
  if (!agentUserId) {
    return { success: false, reason: "agent_not_found", offerCallback: true, message: "Could not resolve this agent's account — offer a callback instead." }
  }

  const svc = createServiceClient()
  const hours = await resolveAgentWorkingHoursForAgent(svc, params.agentId, params.brokerageId)

  const startDate = new Date(Date.now() + minDaysOut * 86_400_000)
  const endDate = new Date(startDate.getTime() + SEARCH_HORIZON_DAYS * 86_400_000)

  // FAIL CLOSED — getAvailabilityViaPersonal (not the mock-fallback
  // lib/providers/calendar/index.ts::getAvailability) returns null when the
  // agent has no connected Google/Microsoft calendar. Never invent slots
  // (owner ruling, wave75C brief).
  const avail = await getAvailabilityViaPersonal(
    agentUserId,
    { startDate: startDate.toISOString(), endDate: endDate.toISOString(), durationMinutes },
    undefined,
    hours,
  )
  if (!avail) {
    return {
      success: false, reason: "calendar_not_connected", offerCallback: true,
      message: "This agent doesn't have a calendar connected yet — offer to have them call back to set up a time instead of booking one now.",
    }
  }
  if (!avail.success) {
    return { success: false, reason: "availability_error", offerCallback: true, message: avail.error ?? "Could not read the agent's calendar — offer a callback instead." }
  }

  // Second, independent floor — computeFreeSlots already starts the window
  // at `startDate`, but re-asserting the rule here means a future change to
  // the window math can never silently admit a sub-7-day slot.
  let slots = avail.slots.filter((s) => isAtLeastMinDaysOut(s.startTime, minDaysOut))

  const preferredWindow = params.preferredWindows?.[0] ?? null
  if ((params.preferredDays && params.preferredDays.length > 0) || preferredWindow) {
    const narrowed = filterSlotsByPreference(slots, { preferredDays: params.preferredDays, preferredWindow })
    if (narrowed.length > 0) slots = narrowed // an empty narrowed list falls back to the wider set rather than offering nothing
  }

  return { success: true, slots: slots.slice(0, count), minDaysOut }
}

/** agent-scope → brokerage-scope working-hours cascade, same shape as
 *  lib/voice/twilio-voice.ts's identity cascade (agent-scoped profile first). */
async function resolveAgentWorkingHoursForAgent(svc: Svc, agentId: string, brokerageId: string): Promise<WorkingHours> {
  const { data: agentProfile } = await svc.from("ai_identity_profiles").select("business_hours")
    .eq("scope_type", "agent").eq("scope_id", agentId).maybeSingle()
  if (agentProfile) return resolveWorkingHours((agentProfile as { business_hours?: unknown }).business_hours)
  const { data: brokerageProfile } = await svc.from("ai_identity_profiles").select("business_hours")
    .eq("scope_type", "brokerage").eq("scope_id", brokerageId).maybeSingle()
  return resolveWorkingHours((brokerageProfile as { business_hours?: unknown } | null)?.business_hours)
}

// ── bookListingAppointment ───────────────────────────────────────────────

export interface BookListingAppointmentParams {
  brokerageId: string
  contactId: string
  /** agents.id */
  agentId: string
  slot: { startTime: string; endTime: string }
  propertyAddress: string
  notes?: string | null
}

export type BookListingAppointmentResult =
  | { success: true; calendarEventId: string; contactId: string; startAt: string; endAt: string; calendarSynced: boolean; supersededAppointmentId: string | null }
  | { success: false; error: string }

export async function bookListingAppointment(
  params: BookListingAppointmentParams,
): Promise<BookListingAppointmentResult> {
  if (!isAtLeastMinDaysOut(params.slot.startTime)) {
    return { success: false, error: `Listing appointments must be at least ${LISTING_APPOINTMENT_MIN_DAYS_OUT} days out — the chosen slot is sooner than that.` }
  }
  const agentUserId = await resolveAgentRecordToUserId(params.agentId)
  if (!agentUserId) return { success: false, error: "Could not resolve the agent's user account." }

  const svc = createServiceClient()

  // ── cancel-on-reschedule: supersede any prior OPEN listing appointment for
  // this contact before creating the new one, so the reminder cron (which
  // only ever reads status='scheduled') stops touching the old row. ──
  const { data: existingOpen } = await svc
    .from("calendar_events")
    .select("id")
    .eq("brokerage_id", params.brokerageId)
    .eq("entity_type", "contact")
    .eq("entity_id", params.contactId)
    .eq("event_type", LISTING_APPOINTMENT_EVENT_TYPE)
    .in("status", OPEN_LISTING_APPOINTMENT_STATUSES as unknown as string[])
    .maybeSingle()
  const supersededAppointmentId = (existingOpen as { id: string } | null)?.id ?? null
  if (supersededAppointmentId) {
    await sentinelWrite(
      svc,
      svc.from("calendar_events").update({ status: LISTING_APPOINTMENT_STATUS.CANCELLED }).eq("id", supersededAppointmentId),
      { table: "calendar_events", flow: "listing_appointment_reschedule_supersede", brokerageId: params.brokerageId },
    )
  }

  const calendarEventId = crypto.randomUUID()
  const title = `Listing appointment — ${params.propertyAddress}`
  const description = params.notes ? `No-obligation listing appointment.\n\n${params.notes}` : "No-obligation listing appointment."

  const inserted = await sentinelWrite(
    svc,
    svc.from("calendar_events").insert({
      id: calendarEventId,
      brokerage_id: params.brokerageId,
      agent_user_id: agentUserId,
      entity_type: "contact",
      entity_id: params.contactId,
      event_type: LISTING_APPOINTMENT_EVENT_TYPE,
      title,
      start_at: params.slot.startTime,
      end_at: params.slot.endTime,
      timezone_name: "UTC",
      location: params.propertyAddress,
      is_system_generated: true,
      status: LISTING_APPOINTMENT_STATUS.PENDING_AGENT_CONFIRMATION,
      metadata: { notes: params.notes ?? null, property_address: params.propertyAddress, reminder_tiers_sent: [], superseded_appointment_id: supersededAppointmentId },
    }),
    { table: "calendar_events", flow: "listing_appointment_book", brokerageId: params.brokerageId },
  )
  if (!inserted) return { success: false, error: "Failed to create the appointment." }

  // Tentative hold on the agent's OWN connected calendar. Best-effort — the
  // internal calendar_events row above is the durable record; a failed
  // external sync degrades gracefully (calendarSynced:false) rather than
  // losing the booking.
  let calendarSynced = false
  try {
    const res = await createEventViaPersonal(agentUserId, {
      title, description, startTime: params.slot.startTime, endTime: params.slot.endTime,
      location: params.propertyAddress, status: "tentative",
    })
    if (res?.success && res.eventId && !res.mock) {
      calendarSynced = true
      await sentinelWrite(
        svc,
        svc.from("calendar_events").update({ metadata: { notes: params.notes ?? null, property_address: params.propertyAddress, reminder_tiers_sent: [], superseded_appointment_id: supersededAppointmentId, google_event_id: res.eventId } }).eq("id", calendarEventId),
        { table: "calendar_events", flow: "listing_appointment_book_sync", brokerageId: params.brokerageId },
      )
    }
  } catch (e) {
    console.error("[listing-appointment] agent calendar sync failed (internal booking still stands):", e)
  }

  // Agent notification (existing notifications shape).
  await sentinelWrite(
    svc,
    svc.from("notifications").insert({
      user_id: agentUserId, brokerage_id: params.brokerageId,
      type: "listing_appointment_confirmation_needed",
      title: "Confirm a listing appointment",
      body: `A no-obligation listing appointment was found for ${params.propertyAddress} — confirm the time from your action queue.`,
      priority: "high", entity_type: "contact", entity_id: params.contactId,
    }),
    { table: "notifications", flow: "listing_appointment_book", brokerageId: params.brokerageId },
  )

  // The existing agent action-queue rail (composer.ts already surfaces ANY
  // open agent_action_required row — no new UI) doubles as the contact's
  // portal in-app card (customer_copy, read by getCustomerPortalFeed).
  await sentinelWrite(
    svc,
    svc.from("portal_event_stream").insert({
      brokerage_id: params.brokerageId, contact_id: params.contactId, agent_user_id: agentUserId,
      event_type: LISTING_APPOINTMENT_CONFIRM_EVENT_TYPE,
      customer_copy: `We're setting up a no-obligation visit at ${params.propertyAddress} — your agent will confirm the exact time shortly.`,
      customer_icon: "calendar",
      agent_copy: `Confirm the listing appointment at ${params.propertyAddress} (${new Date(params.slot.startTime).toLocaleString()}).`,
      agent_action_required: true,
      agent_action_label: "Confirm listing appointment",
      agent_action_status: "open",
      severity: "high",
      metadata: { calendar_event_id: calendarEventId },
      occurred_at: new Date().toISOString(),
    }),
    { table: "portal_event_stream", flow: "listing_appointment_book", brokerageId: params.brokerageId },
  )

  // Manager hand-off — ai_isa found the slot and booked the hold; listing_concierge
  // (the seller-side manager) is told a confirmation is waiting.
  // IDENTITY CLASS (lane 76A fix): the signal is keyed on the calendar_events
  // row so the dedupe is per-APPOINTMENT (a reschedule is a new signal), and
  // that id is a calendar_events.id — it was written under entityType
  // "contact", which put a calendar id in a contacts.id slot (CLAUDE.md §3).
  // contactId still carries the contacts.id the handler
  // (proposeQualificationConfirmation) actually reads.
  await publishManagerSignal({
    brokerageId: params.brokerageId, fromManager: "ai_isa", toManager: "listing_concierge",
    signalType: "listing_appointment_pending_confirmation",
    message: `A listing appointment at ${params.propertyAddress} is pending the agent's confirmation.`,
    entityType: "calendar_event", entityId: calendarEventId, contactId: params.contactId,
    payload: { calendarEventId, propertyAddress: params.propertyAddress, startAt: params.slot.startTime },
  }).catch((e) => console.error("[listing-appointment] publishManagerSignal failed:", e))

  return {
    success: true, calendarEventId, contactId: params.contactId,
    startAt: params.slot.startTime, endAt: params.slot.endTime,
    calendarSynced, supersededAppointmentId,
  }
}

// ── confirmListingAppointment — the agent's one-click confirm ───────────

export interface ConfirmListingAppointmentParams {
  brokerageId: string
  calendarEventId: string
  confirmedByUserId: string
}

export type ConfirmListingAppointmentResult =
  | { success: true; alreadyConfirmed: boolean; icsSentToContact: boolean; icsSentToAgent: boolean; portalPushed: boolean }
  | { success: false; error: string }

export async function confirmListingAppointment(
  params: ConfirmListingAppointmentParams,
): Promise<ConfirmListingAppointmentResult> {
  const svc = createServiceClient()
  const { data: row, error } = await svc
    .from("calendar_events")
    .select("id, brokerage_id, agent_user_id, entity_id, start_at, end_at, location, status, metadata")
    .eq("id", params.calendarEventId)
    .eq("brokerage_id", params.brokerageId)
    .eq("event_type", LISTING_APPOINTMENT_EVENT_TYPE)
    .maybeSingle()
  if (error || !row) return { success: false, error: "Listing appointment not found." }
  const r = row as { id: string; brokerage_id: string; agent_user_id: string; entity_id: string; start_at: string; end_at: string; location: string | null; status: string; metadata: Record<string, unknown> | null }

  if (r.status === LISTING_APPOINTMENT_STATUS.CANCELLED) {
    return { success: false, error: "This listing appointment was superseded by a reschedule and can no longer be confirmed." }
  }
  const alreadyConfirmed = r.status === LISTING_APPOINTMENT_STATUS.CONFIRMED
  const metadata = r.metadata ?? {}

  if (!alreadyConfirmed) {
    const confirmed = await sentinelWrite(
      svc,
      svc.from("calendar_events").update({
        status: LISTING_APPOINTMENT_STATUS.CONFIRMED,
        metadata: { ...metadata, confirmed_at: new Date().toISOString(), confirmed_by: params.confirmedByUserId },
      }).eq("id", r.id),
      { table: "calendar_events", flow: "listing_appointment_confirm", brokerageId: params.brokerageId },
    )
    if (!confirmed) return { success: false, error: "Failed to confirm the appointment." }

    const googleEventId = metadata.google_event_id as string | undefined
    if (googleEventId) {
      await updateEventViaPersonal(r.agent_user_id, googleEventId, { status: "confirmed" }).catch((e) => {
        console.error("[listing-appointment] Google confirm PATCH failed (internal status still confirmed):", e)
      })
    }
  }

  // ── Auto calendar emails (agent + contact), ICS attached ────────────────
  const [{ data: contact }, { data: agentUser }] = await Promise.all([
    svc.from("contacts").select("id, first_name, last_name, email").eq("id", r.entity_id).maybeSingle(),
    svc.from("users").select("id, first_name, last_name, email").eq("id", r.agent_user_id).maybeSingle(),
  ])
  const c = contact as { first_name: string | null; last_name: string | null; email: string | null } | null
  const a = agentUser as { first_name: string | null; last_name: string | null; email: string | null } | null

  const propertyAddress = (metadata.property_address as string | undefined) ?? r.location ?? "the property"
  const summary = `Listing appointment — ${propertyAddress}`
  const description = `No-obligation listing appointment${a?.first_name ? ` with ${a.first_name}` : ""} at ${propertyAddress}.`

  let icsSentToContact = false
  let icsSentToAgent = false
  if (c?.email && a?.email) {
    const ics = buildAppointmentIcs({
      uid: `listing-appointment-${r.id}@vip-re-os`,
      startIso: r.start_at, endIso: r.end_at, summary, description,
      location: propertyAddress, organizerEmail: a.email, attendeeEmail: c.email,
    })
    const [contactSend, agentSend] = await Promise.all([
      dispatchEmail({
        to: c.email, subject: `Confirmed: ${summary}`,
        html: `<p>Hi ${c.first_name ?? ""},</p><p>Your listing appointment is confirmed for <strong>${new Date(r.start_at).toLocaleString()}</strong> at ${propertyAddress}.</p>`,
        contactId: r.entity_id, brokerageId: params.brokerageId,
        systemSource: "listing_appointment", channelPurpose: "transactional",
        icsAttachment: { filename: "appointment.ics", content: ics },
      }).catch((e) => ({ success: false, error: String(e) })),
      dispatchEmail({
        to: a.email, subject: `Confirmed: ${summary}`,
        html: `<p>Your listing appointment with ${c.first_name ?? "the client"} is confirmed for <strong>${new Date(r.start_at).toLocaleString()}</strong> at ${propertyAddress}.</p>`,
        // r.agent_user_id is a USERS id (calendar_events.agent_user_id), so it
        // goes in as userId — DispatchActorContext.agentId is an AGENTS id and
        // the two are disjoint (CLAUDE.md §3).
        brokerageId: params.brokerageId, userId: r.agent_user_id,
        systemSource: "listing_appointment", channelPurpose: "transactional",
        icsAttachment: { filename: "appointment.ics", content: ics },
      }).catch((e) => ({ success: false, error: String(e) })),
    ])
    icsSentToContact = !!contactSend.success
    icsSentToAgent = !!agentSend.success
  }

  // ── Portal in-app push (confirmed card) ─────────────────────────────────
  const portalPushed = await sentinelWrite(
    svc,
    svc.from("portal_event_stream").insert({
      brokerage_id: params.brokerageId, contact_id: r.entity_id, agent_user_id: r.agent_user_id,
      event_type: LISTING_APPOINTMENT_CONFIRMED_EVENT_TYPE,
      customer_copy: `Your listing appointment is confirmed for ${new Date(r.start_at).toLocaleString()} at ${propertyAddress}.`,
      customer_icon: "calendar-check",
      agent_copy: `Confirmed: listing appointment at ${propertyAddress}.`,
      agent_action_required: false, agent_action_status: "completed_executed",
      severity: "normal", metadata: { calendar_event_id: r.id },
      occurred_at: new Date().toISOString(),
    }),
    { table: "portal_event_stream", flow: "listing_appointment_confirm", brokerageId: params.brokerageId },
  )

  return { success: true, alreadyConfirmed, icsSentToContact, icsSentToAgent, portalPushed }
}

// ── sendListingAppointmentReminders — the 5-day/2-day/morning-of cadence ──

export interface ListingAppointmentReminderResult {
  scanned: number
  remindersSent: number
}

/** Cron-callable sweep (app/api/cron/listing-appointment-reminders). Only
 *  touches CONFIRMED ('scheduled') listing appointments — a still-pending or
 *  already-cancelled row gets no reminder, which is how "cancel on
 *  reschedule" takes effect: bookListingAppointment's supersede step flips
 *  the old row to 'cancelled' and this query never sees it again. */
export async function sendListingAppointmentReminders(svc: Svc = createServiceClient(), now: Date = new Date()): Promise<ListingAppointmentReminderResult> {
  const horizonEnd = new Date(now.getTime() + (REMINDER_TIER_DAYS_OUT["5_day"] + 1) * 86_400_000)
  const { data } = await svc
    .from("calendar_events")
    .select("id, brokerage_id, agent_user_id, entity_id, start_at, location, metadata")
    .eq("event_type", LISTING_APPOINTMENT_EVENT_TYPE)
    .eq("status", LISTING_APPOINTMENT_STATUS.CONFIRMED)
    .gte("start_at", now.toISOString())
    .lte("start_at", horizonEnd.toISOString())
  const rows = (data ?? []) as Array<{ id: string; brokerage_id: string; agent_user_id: string; entity_id: string; start_at: string; location: string | null; metadata: Record<string, unknown> | null }>

  let remindersSent = 0
  for (const row of rows) {
    const tier = reminderTierForAppointment(row.start_at, now)
    if (!tier) continue
    const sentTiers = new Set((row.metadata?.reminder_tiers_sent as string[] | undefined) ?? [])
    if (sentTiers.has(tier)) continue

    const { data: contact } = await svc.from("contacts").select("first_name, email").eq("id", row.entity_id).maybeSingle()
    const c = contact as { first_name: string | null; email: string | null } | null
    const propertyAddress = (row.metadata?.property_address as string | undefined) ?? row.location ?? "the property"
    const when = new Date(row.start_at).toLocaleString()
    const copy = tier === "morning_of"
      ? `Today's the day — your listing appointment at ${propertyAddress} is at ${when}.`
      : `Reminder: your listing appointment at ${propertyAddress} is coming up (${when}).`

    if (c?.email) {
      await dispatchEmail({
        to: c.email, subject: "Listing appointment reminder", html: `<p>Hi ${c.first_name ?? ""},</p><p>${copy}</p>`,
        contactId: row.entity_id, brokerageId: row.brokerage_id,
        systemSource: "listing_appointment", channelPurpose: "transactional",
      }).catch((e) => console.error("[listing-appointment] reminder email failed:", e))
    }
    await sentinelWrite(
      svc,
      svc.from("portal_event_stream").insert({
        brokerage_id: row.brokerage_id, contact_id: row.entity_id, agent_user_id: row.agent_user_id,
        event_type: "listing_appointment_reminder", customer_copy: copy, customer_icon: "bell",
        agent_copy: copy, agent_action_required: false, severity: "normal",
        metadata: { calendar_event_id: row.id, tier }, occurred_at: new Date().toISOString(),
      }),
      { table: "portal_event_stream", flow: "listing_appointment_reminder", brokerageId: row.brokerage_id },
    )
    await sentinelWrite(
      svc,
      svc.from("calendar_events").update({ metadata: { ...(row.metadata ?? {}), reminder_tiers_sent: [...sentTiers, tier] } }).eq("id", row.id),
      { table: "calendar_events", flow: "listing_appointment_reminder", brokerageId: row.brokerage_id },
    )
    remindersSent += 1
  }
  return { scanned: rows.length, remindersSent }
}
