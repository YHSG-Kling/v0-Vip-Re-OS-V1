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
 * ── LANE 76B: ONE APPOINTMENT ENGINE, TWO KINDS ──────────────────────────
 * Owner (wave 76): "on the platform voice receptionist merge you didn't use
 * listing appointment … we have a way for the agents to create a demo
 * appointment". The PLATFORM DEMO (a prospect's product walkthrough on a
 * platform sales rep's connected calendar) is the SAME shape — find real
 * slots on a connected calendar, book a tentative hold, the human confirms,
 * ICS emails go out, a reminder cadence runs — so it rides THIS module via
 * an `AppointmentKind` rather than a second slot-finder/ICS-builder/reminder
 * sweep (CLAUDE.md §1/§6). `APPOINTMENT_KIND_SPEC` is the only place the two
 * kinds differ: event_type, entity class, min-days floor, duration, wording.
 * The kind-specific side rails (a contact's portal card and manager signal;
 * a prospect's platform_prospects stamp and the rep's notification) sit in
 * the thin `bookListingAppointment` / `bookDemoAppointment` wrappers around
 * ONE `bookAppointmentCore`, and the same for confirm.
 *
 * IDENTITY (CLAUDE.md §3/§4, wave 76 "you made some mistakes with assigning
 * contactid with leadid"): a demo row is entity_type='platform_prospect' with
 * entity_id = platform_prospects.id — NEVER 'contact'/'lead', and that id
 * never reaches a contactId/leadId slot (dispatchEmail is called WITHOUT
 * contactId for a prospect). calendar_events carries no CHECK on
 * entity_type/event_type (verified live 2026-09-18; absent from
 * scripts/check-vocabularies.ts), so no migration is owed for either value.
 * calendar_events.brokerage_id is NOT NULL: a demo row is keyed to the rep's
 * own users.brokerage_id (lib/platform/sales-rep.ts explains why).
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
 *     LISTING_APPOINTMENT ('listing_appointment') and (lane 76B)
 *     DEMO_APPOINTMENT ('demo_appointment') are enum members (lib/kernel/
 *     calendar-types.ts) and calendar_events carries NO live CHECK constraint
 *     on event_type/status/entity_type (verified: absent from
 *     scripts/check-vocabularies.ts; no `ALTER TABLE calendar_events ... CHECK`
 *     in supabase/migrations; live pg_constraint read 2026-09-18 shows only
 *     the two FKs). So no migration is required to accept either event_type,
 *     the `pending_agent_confirmation` status, or the prospect entity class.
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
 *     confirmation hand-off (ai_isa → listing_concierge), listing kind only.
 *   · portal_event_stream (app/actions/portal-stream.ts) IS the existing
 *     agent approval/notification rail for the LISTING kind: composer.ts's
 *     agent action queue already surfaces ANY open `agent_action_required`
 *     row with zero new UI, and dispositionPortalEventAction's "execute" mode
 *     calls confirmListingAppointment below. The DEMO kind's confirm rail is
 *     the platform growth board (app/actions/superadmin/platform-growth.ts::
 *     confirmProspectDemoAction → confirmDemoAppointment) — a prospect has no
 *     portal, and the rep is platform staff, not a tenant agent.
 *   · lib/providers/dispatch.ts::dispatchEmail (→ messaging sendEmail) — with
 *     the optional ICS attachment for the auto calendar emails. Both kinds.
 *   · lib/kernel/appointment-noshow-autopilot.ts — "listing_appointment" is in
 *     APPOINTMENT_EVENT_TYPES so the existing within-24h no-show/reminder
 *     autopilot ALSO protects that kind (it resolves a CONTACT from
 *     entity_id, so the demo kind is deliberately NOT added there — a
 *     prospect id would be looked up as a contact). The 5-day/2-day/
 *     morning-of cadence below covers BOTH kinds.
 *
 * No new tables. For the listing kind contactId is REQUIRED — an appointment
 * is for a CONTACT (CLAUDE.md wave75/75C brief); a lead caller converts FIRST
 * via lane 75A's survivor (convertSellerLeadOnIntent), then books on the
 * resulting contact — that conversion happens at the CALLER
 * (lib/ai-isa/customer-context-tools.ts), never inside this module.
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
import { markProspectDemoScheduled, markProspectDemoConfirmed } from "@/lib/platform/prospect-capture"
import type { PlatformSalesRep } from "@/lib/platform/sales-rep"

type Svc = ReturnType<typeof createServiceClient>

// ── Tunables ──────────────────────────────────────────────────────────────

/** Owner ruling: "at least a week out." Every slot offered and every booking
 *  accepted is checked against this — never trusted from the caller. */
export const LISTING_APPOINTMENT_MIN_DAYS_OUT = 7

/** A product demo needs no week-long runway — the rep just has to be able to
 *  confirm it first. Next-day earliest. */
export const DEMO_APPOINTMENT_MIN_DAYS_OUT = 1

/** How far past the min-days floor to search before giving up. */
const SEARCH_HORIZON_DAYS = 28

const DEFAULT_DURATION_MINUTES = 45
const DEMO_DURATION_MINUTES = 30

/** The internal appointment_type / event_type this module owns on
 *  calendar_events — already a live enum member, see header. */
export const LISTING_APPOINTMENT_EVENT_TYPE = CalendarEventType.LISTING_APPOINTMENT
/** Lane 76B — the platform demo's event_type (same enum, same table). */
export const DEMO_APPOINTMENT_EVENT_TYPE = CalendarEventType.DEMO_APPOINTMENT

// ── The ONE kind table (lane 76B) ────────────────────────────────────────

export type AppointmentKind = "listing_appointment" | "demo_appointment"

/** The entity class a calendar_events row of this kind points at. A platform
 *  prospect is neither a contact nor a lead — its own class, never borrowed. */
export type AppointmentEntityType = "contact" | "platform_prospect"

export interface AppointmentKindSpec {
  eventType: string
  entityType: AppointmentEntityType
  minDaysOut: number
  durationMinutes: number
  /** Human wording for titles/emails. */
  label: string
  /** dispatchEmail systemSource — the attribution key for every send of this kind. */
  systemSource: string
  /** ICS UID prefix. */
  uidPrefix: string
}

export const APPOINTMENT_KIND_SPEC: Record<AppointmentKind, AppointmentKindSpec> = {
  listing_appointment: {
    eventType: LISTING_APPOINTMENT_EVENT_TYPE, entityType: "contact",
    minDaysOut: LISTING_APPOINTMENT_MIN_DAYS_OUT, durationMinutes: DEFAULT_DURATION_MINUTES,
    label: "Listing appointment", systemSource: "listing_appointment", uidPrefix: "listing-appointment",
  },
  demo_appointment: {
    eventType: DEMO_APPOINTMENT_EVENT_TYPE, entityType: "platform_prospect",
    minDaysOut: DEMO_APPOINTMENT_MIN_DAYS_OUT, durationMinutes: DEMO_DURATION_MINUTES,
    label: "Product demo", systemSource: "demo_appointment", uidPrefix: "demo-appointment",
  },
}

/** Every event_type this module owns — the reminder sweep's `.in()` list. */
export const APPOINTMENT_EVENT_TYPES = Object.values(APPOINTMENT_KIND_SPEC).map((s) => s.eventType)

/** PURE: kind from a stored event_type (null for anything this module does not own). */
export function appointmentKindForEventType(eventType: string | null | undefined): AppointmentKind | null {
  for (const [kind, spec] of Object.entries(APPOINTMENT_KIND_SPEC) as Array<[AppointmentKind, AppointmentKindSpec]>) {
    if (spec.eventType === eventType) return kind
  }
  return null
}

/** calendar_events.status values THIS module writes. Free text (no CHECK,
 *  see header) but declared once here so every writer/reader in this file
 *  uses the SAME spelling (CLAUDE.md §6). Shared by both kinds. */
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

/** notifications.type for the platform rep's "confirm this demo" heads-up. */
export const DEMO_APPOINTMENT_CONFIRM_NOTIFICATION_TYPE = "demo_appointment_confirmation_needed"

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
 *  its shape without a real send. The ONE ICS builder — both kinds. */
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
    "PRODID:-//Real Estate OS//Appointments//EN",
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

// ── Slot finding — ONE finder on a connected users.id calendar ───────────

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

interface FindSlotsCoreParams {
  kind: AppointmentKind
  /** users.id whose CONNECTED calendar is read. */
  calendarUserId: string
  hours: WorkingHours
  preferredDays?: string[]
  preferredWindows?: ("morning" | "afternoon" | "evening")[]
  minDaysOut?: number
  count?: number
  durationMinutes?: number
}

/** The ONE slot finder both kinds ride. FAIL CLOSED — never invents a slot. */
async function findSlotsOnConnectedCalendar(params: FindSlotsCoreParams): Promise<FindAgentAppointmentSlotsResult> {
  const spec = APPOINTMENT_KIND_SPEC[params.kind]
  const minDaysOut = params.minDaysOut ?? spec.minDaysOut
  const count = params.count ?? 3
  const durationMinutes = params.durationMinutes ?? spec.durationMinutes

  const startDate = new Date(Date.now() + minDaysOut * 86_400_000)
  const endDate = new Date(startDate.getTime() + SEARCH_HORIZON_DAYS * 86_400_000)

  // FAIL CLOSED — getAvailabilityViaPersonal (not the mock-fallback
  // lib/providers/calendar/index.ts::getAvailability) returns null when the
  // agent has no connected Google/Microsoft calendar. Never invent slots
  // (owner ruling, wave75C brief).
  const avail = await getAvailabilityViaPersonal(
    params.calendarUserId,
    { startDate: startDate.toISOString(), endDate: endDate.toISOString(), durationMinutes },
    undefined,
    params.hours,
  )
  if (!avail) {
    return {
      success: false, reason: "calendar_not_connected", offerCallback: true,
      message: params.kind === "demo_appointment"
        ? "No sales rep has a calendar connected yet — offer to have a person reach out to set a time instead of booking one now."
        : "This agent doesn't have a calendar connected yet — offer to have them call back to set up a time instead of booking one now.",
    }
  }
  if (!avail.success) {
    return { success: false, reason: "availability_error", offerCallback: true, message: avail.error ?? "Could not read the calendar — offer a callback instead." }
  }

  // Second, independent floor — computeFreeSlots already starts the window
  // at `startDate`, but re-asserting the rule here means a future change to
  // the window math can never silently admit a sub-floor slot.
  let slots = avail.slots.filter((s) => isAtLeastMinDaysOut(s.startTime, minDaysOut))

  const preferredWindow = params.preferredWindows?.[0] ?? null
  if ((params.preferredDays && params.preferredDays.length > 0) || preferredWindow) {
    const narrowed = filterSlotsByPreference(slots, { preferredDays: params.preferredDays, preferredWindow })
    if (narrowed.length > 0) slots = narrowed // an empty narrowed list falls back to the wider set rather than offering nothing
  }

  return { success: true, slots: slots.slice(0, count), minDaysOut }
}

export async function findAgentAppointmentSlots(
  params: FindAgentAppointmentSlotsParams,
): Promise<FindAgentAppointmentSlotsResult> {
  const agentUserId = await resolveAgentRecordToUserId(params.agentId)
  if (!agentUserId) {
    return { success: false, reason: "agent_not_found", offerCallback: true, message: "Could not resolve this agent's account — offer a callback instead." }
  }
  const svc = createServiceClient()
  const hours = await resolveAgentWorkingHoursForAgent(svc, params.agentId, params.brokerageId)
  return findSlotsOnConnectedCalendar({
    kind: "listing_appointment", calendarUserId: agentUserId, hours,
    preferredDays: params.preferredDays, preferredWindows: params.preferredWindows,
    minDaysOut: params.minDaysOut, count: params.count, durationMinutes: params.durationMinutes,
  })
}

export interface FindDemoAppointmentSlotsParams {
  /** The platform sales rep (lib/platform/sales-rep.ts) — a USERS id. */
  rep: Pick<PlatformSalesRep, "userId" | "calendarConnected">
  preferredDays?: string[]
  preferredWindows?: ("morning" | "afternoon" | "evening")[]
  count?: number
}

/** Lane 76B — the demo's slot finder: the SAME finder on the rep's calendar.
 *  Platform staff carry no ai_identity_profiles business_hours, so the
 *  default 09:00-17:00 window applies. */
export async function findDemoAppointmentSlots(params: FindDemoAppointmentSlotsParams): Promise<FindAgentAppointmentSlotsResult> {
  if (!params.rep.calendarConnected) {
    return { success: false, reason: "calendar_not_connected", offerCallback: true, message: "No sales rep has a calendar connected yet — offer to have a person reach out to set a time instead of booking one now." }
  }
  return findSlotsOnConnectedCalendar({
    kind: "demo_appointment", calendarUserId: params.rep.userId, hours: DEFAULT_WORKING_HOURS,
    preferredDays: params.preferredDays, preferredWindows: params.preferredWindows, count: params.count,
  })
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

// ── Booking — ONE core, two thin wrappers ────────────────────────────────

interface BookAppointmentCoreParams {
  kind: AppointmentKind
  brokerageId: string
  /** users.id — the calendar owner (calendar_events.agent_user_id). */
  agentUserId: string
  /** contacts.id for the listing kind; platform_prospects.id for the demo kind. */
  entityId: string
  slot: { startTime: string; endTime: string }
  title: string
  description: string
  location: string | null
  metadata: Record<string, unknown>
}

type BookAppointmentCoreResult =
  | { success: true; calendarEventId: string; calendarSynced: boolean; supersededAppointmentId: string | null }
  | { success: false; error: string }

async function bookAppointmentCore(params: BookAppointmentCoreParams): Promise<BookAppointmentCoreResult> {
  const spec = APPOINTMENT_KIND_SPEC[params.kind]
  const eventType = spec.eventType
  if (!isAtLeastMinDaysOut(params.slot.startTime, spec.minDaysOut)) {
    return { success: false, error: `${spec.label}s must be at least ${spec.minDaysOut} day${spec.minDaysOut === 1 ? "" : "s"} out — the chosen slot is sooner than that.` }
  }
  const svc = createServiceClient()

  // ── cancel-on-reschedule: supersede any prior OPEN appointment of this kind
  // for this entity before creating the new one, so the reminder sweep (which
  // only ever reads status='scheduled') stops touching the old row. ──
  // The listing kind keeps its tenant predicate; a demo row is keyed to the
  // rep's brokerage, which may differ between two reps, so the prospect's
  // prior hold is matched on its own entity class + id alone.
  let openQuery = svc
    .from("calendar_events")
    .select("id")
    .eq("entity_type", spec.entityType)
    .eq("entity_id", params.entityId)
    .eq("event_type", eventType)
    .in("status", OPEN_LISTING_APPOINTMENT_STATUSES as unknown as string[])
  if (params.kind === "listing_appointment") openQuery = openQuery.eq("brokerage_id", params.brokerageId)
  const { data: existingOpen } = await openQuery.limit(1).maybeSingle()
  const supersededAppointmentId = (existingOpen as { id: string } | null)?.id ?? null
  if (supersededAppointmentId) {
    await sentinelWrite(
      svc,
      svc.from("calendar_events").update({ status: LISTING_APPOINTMENT_STATUS.CANCELLED }).eq("id", supersededAppointmentId),
      { table: "calendar_events", flow: `${params.kind}_reschedule_supersede`, brokerageId: params.brokerageId },
    )
  }

  const calendarEventId = crypto.randomUUID()
  const baseMetadata = { ...params.metadata, reminder_tiers_sent: [], superseded_appointment_id: supersededAppointmentId }

  const inserted = await sentinelWrite(
    svc,
    svc.from("calendar_events").insert({
      id: calendarEventId,
      brokerage_id: params.brokerageId,
      agent_user_id: params.agentUserId,
      entity_type: spec.entityType,
      entity_id: params.entityId,
      event_type: eventType,
      title: params.title,
      start_at: params.slot.startTime,
      end_at: params.slot.endTime,
      timezone_name: "UTC",
      location: params.location,
      is_system_generated: true,
      status: LISTING_APPOINTMENT_STATUS.PENDING_AGENT_CONFIRMATION,
      metadata: baseMetadata,
    }),
    { table: "calendar_events", flow: `${params.kind}_book`, brokerageId: params.brokerageId },
  )
  if (!inserted) return { success: false, error: "Failed to create the appointment." }

  // Tentative hold on the calendar owner's OWN connected calendar. Best-effort —
  // the internal calendar_events row above is the durable record; a failed
  // external sync degrades gracefully (calendarSynced:false) rather than
  // losing the booking.
  let calendarSynced = false
  try {
    const res = await createEventViaPersonal(params.agentUserId, {
      title: params.title, description: params.description, startTime: params.slot.startTime, endTime: params.slot.endTime,
      location: params.location ?? undefined, status: "tentative",
    })
    if (res?.success && res.eventId && !res.mock) {
      calendarSynced = true
      await sentinelWrite(
        svc,
        svc.from("calendar_events").update({ metadata: { ...baseMetadata, google_event_id: res.eventId } }).eq("id", calendarEventId),
        { table: "calendar_events", flow: `${params.kind}_book_sync`, brokerageId: params.brokerageId },
      )
    }
  } catch (e) {
    console.error(`[${params.kind}] calendar sync failed (internal booking still stands):`, e)
  }

  return { success: true, calendarEventId, calendarSynced, supersededAppointmentId }
}

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
  const agentUserId = await resolveAgentRecordToUserId(params.agentId)
  if (!agentUserId) return { success: false, error: "Could not resolve the agent's user account." }

  const title = `Listing appointment — ${params.propertyAddress}`
  const description = params.notes ? `No-obligation listing appointment.\n\n${params.notes}` : "No-obligation listing appointment."
  const booked = await bookAppointmentCore({
    kind: "listing_appointment", brokerageId: params.brokerageId, agentUserId,
    entityId: params.contactId, slot: params.slot, title, description, location: params.propertyAddress,
    metadata: { notes: params.notes ?? null, property_address: params.propertyAddress },
  })
  if (!booked.success) return booked
  const { calendarEventId, calendarSynced, supersededAppointmentId } = booked
  const svc = createServiceClient()

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

export interface BookDemoAppointmentParams {
  /** platform_prospects.id — NEVER passed as a contactId/leadId anywhere. */
  prospectId: string
  prospectName: string | null
  company: string | null
  rep: PlatformSalesRep
  slot: { startTime: string; endTime: string }
  notes?: string | null
}

export type BookDemoAppointmentResult =
  | { success: true; calendarEventId: string; prospectId: string; startAt: string; endAt: string; calendarSynced: boolean; supersededAppointmentId: string | null; prospectStamped: boolean }
  | { success: false; error: string }

/** Lane 76B — the platform demo: the SAME core (slot floor, supersede, insert,
 *  tentative hold), then the demo's own side rails: the rep's notification
 *  (the growth board is the confirm surface) and the platform_prospects stamp
 *  (status 'demo_scheduled' — the cold follow-up ladder stops here). */
export async function bookDemoAppointment(params: BookDemoAppointmentParams): Promise<BookDemoAppointmentResult> {
  if (!params.rep.calendarConnected) return { success: false, error: "No sales rep has a connected calendar — offer the human handoff instead." }
  const who = [params.prospectName, params.company].filter(Boolean).join(" — ") || "a platform prospect"
  const title = `Product demo — ${who}`
  const description = params.notes ? `Live product demo.\n\n${params.notes}` : "Live product demo."
  const booked = await bookAppointmentCore({
    kind: "demo_appointment", brokerageId: params.rep.brokerageId, agentUserId: params.rep.userId,
    entityId: params.prospectId, slot: params.slot, title, description, location: "Video call",
    metadata: { notes: params.notes ?? null, prospect_id: params.prospectId, prospect_name: params.prospectName, company: params.company },
  })
  if (!booked.success) return booked
  const { calendarEventId, calendarSynced, supersededAppointmentId } = booked
  const svc = createServiceClient()

  await sentinelWrite(
    svc,
    svc.from("notifications").insert({
      user_id: params.rep.userId, brokerage_id: params.rep.brokerageId,
      type: DEMO_APPOINTMENT_CONFIRM_NOTIFICATION_TYPE,
      title: "Confirm a product demo",
      body: `${who} booked a demo for ${new Date(params.slot.startTime).toLocaleString()} — confirm it from the growth board.`,
      priority: "high", entity_type: "platform_prospect", entity_id: params.prospectId,
    }),
    { table: "notifications", flow: "demo_appointment_book", brokerageId: params.rep.brokerageId },
  )

  const prospectStamped = await markProspectDemoScheduled(svc, {
    prospectId: params.prospectId, calendarEventId,
    startAt: params.slot.startTime, endAt: params.slot.endTime, repUserId: params.rep.userId,
  })

  return {
    success: true, calendarEventId, prospectId: params.prospectId,
    startAt: params.slot.startTime, endAt: params.slot.endTime,
    calendarSynced, supersededAppointmentId, prospectStamped,
  }
}

// ── Confirm — the human's one-click confirm, ONE core ────────────────────

interface AppointmentRow {
  id: string; brokerage_id: string; agent_user_id: string; entity_type: string; entity_id: string
  event_type: string; start_at: string; end_at: string; location: string | null; status: string | null
  metadata: Record<string, unknown> | null
}

interface Attendee { firstName: string | null; email: string | null }

/** Resolve WHO the appointment is for, by the row's OWN entity class — a
 *  contact row reads contacts, a prospect row reads platform_prospects. The
 *  id is never looked up in the other table. */
async function resolveAppointmentAttendee(svc: Svc, row: Pick<AppointmentRow, "entity_type" | "entity_id">): Promise<Attendee | null> {
  if (row.entity_type === "contact") {
    const { data } = await svc.from("contacts").select("first_name, email").eq("id", row.entity_id).maybeSingle()
    const c = data as { first_name: string | null; email: string | null } | null
    return c ? { firstName: c.first_name, email: c.email } : null
  }
  if (row.entity_type === "platform_prospect") {
    const { data } = await svc.from("platform_prospects").select("name, email").eq("id", row.entity_id).maybeSingle()
    const p = data as { name: string | null; email: string | null } | null
    return p ? { firstName: (p.name ?? "").trim().split(" ")[0] || null, email: p.email } : null
  }
  return null
}

interface ConfirmCoreParams {
  kind: AppointmentKind
  calendarEventId: string
  /** Tenant predicate for the listing kind; null for the demo kind (the row's
   *  brokerage is the rep's own — the caller was gated as platform staff). */
  brokerageId: string | null
  confirmedByUserId: string
}

type ConfirmCoreResult =
  | { success: true; row: AppointmentRow; alreadyConfirmed: boolean; icsSentToAttendee: boolean; icsSentToOwner: boolean; subject: string }
  | { success: false; error: string }

async function confirmAppointmentCore(params: ConfirmCoreParams): Promise<ConfirmCoreResult> {
  const spec = APPOINTMENT_KIND_SPEC[params.kind]
  const svc = createServiceClient()
  let q = svc
    .from("calendar_events")
    .select("id, brokerage_id, agent_user_id, entity_type, entity_id, event_type, start_at, end_at, location, status, metadata")
    .eq("id", params.calendarEventId)
    .eq("event_type", spec.eventType)
  if (params.brokerageId) q = q.eq("brokerage_id", params.brokerageId)
  const { data: row, error } = await q.maybeSingle()
  if (error || !row) return { success: false, error: `${spec.label} not found.` }
  const r = row as AppointmentRow

  if (r.status === LISTING_APPOINTMENT_STATUS.CANCELLED) {
    return { success: false, error: `This ${spec.label.toLowerCase()} was superseded by a reschedule and can no longer be confirmed.` }
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
      { table: "calendar_events", flow: `${params.kind}_confirm`, brokerageId: r.brokerage_id },
    )
    if (!confirmed) return { success: false, error: "Failed to confirm the appointment." }

    const googleEventId = metadata.google_event_id as string | undefined
    if (googleEventId) {
      await updateEventViaPersonal(r.agent_user_id, googleEventId, { status: "confirmed" }).catch((e) => {
        console.error(`[${params.kind}] Google confirm PATCH failed (internal status still confirmed):`, e)
      })
    }
  }

  // ── Auto calendar emails (owner + attendee), ICS attached ───────────────
  const [attendee, { data: ownerUser }] = await Promise.all([
    resolveAppointmentAttendee(svc, r),
    svc.from("users").select("id, first_name, last_name, email").eq("id", r.agent_user_id).maybeSingle(),
  ])
  const c = attendee
  const a = ownerUser as { first_name: string | null; last_name: string | null; email: string | null } | null

  const where = params.kind === "listing_appointment"
    ? ((metadata.property_address as string | undefined) ?? r.location ?? "the property")
    : (r.location ?? "a video call")
  const subject = params.kind === "listing_appointment" ? `Listing appointment — ${where}` : `Product demo${a?.first_name ? ` with ${a.first_name}` : ""}`
  const description = params.kind === "listing_appointment"
    ? `No-obligation listing appointment${a?.first_name ? ` with ${a.first_name}` : ""} at ${where}.`
    : `Live product demo${a?.first_name ? ` with ${a.first_name}` : ""} — ${where}.`

  let icsSentToAttendee = false
  let icsSentToOwner = false
  if (c?.email && a?.email) {
    const ics = buildAppointmentIcs({
      uid: `${spec.uidPrefix}-${r.id}@vip-re-os`,
      startIso: r.start_at, endIso: r.end_at, summary: subject, description,
      location: params.kind === "listing_appointment" ? where : null, organizerEmail: a.email, attendeeEmail: c.email,
    })
    const when = new Date(r.start_at).toLocaleString()
    const [attendeeSend, ownerSend] = await Promise.all([
      dispatchEmail({
        to: c.email, subject: `Confirmed: ${subject}`,
        html: `<p>Hi ${c.firstName ?? ""},</p><p>Your ${spec.label.toLowerCase()} is confirmed for <strong>${when}</strong>${params.kind === "listing_appointment" ? ` at ${where}` : ""}.</p>`,
        // IDENTITY CLASS: contactId ONLY when the row's entity IS a contact. A
        // platform prospect's id never flows into a contactId/leadId slot.
        ...(r.entity_type === "contact" ? { contactId: r.entity_id } : {}),
        brokerageId: r.brokerage_id,
        systemSource: spec.systemSource, channelPurpose: "transactional",
        icsAttachment: { filename: "appointment.ics", content: ics },
      }).catch((e) => ({ success: false, error: String(e) })),
      dispatchEmail({
        to: a.email, subject: `Confirmed: ${subject}`,
        html: `<p>Your ${spec.label.toLowerCase()} with ${c.firstName ?? "the client"} is confirmed for <strong>${when}</strong>${params.kind === "listing_appointment" ? ` at ${where}` : ""}.</p>`,
        // r.agent_user_id is a USERS id (calendar_events.agent_user_id), so it
        // goes in as userId — DispatchActorContext.agentId is an AGENTS id and
        // the two are disjoint (CLAUDE.md §3).
        brokerageId: r.brokerage_id, userId: r.agent_user_id,
        systemSource: spec.systemSource, channelPurpose: "transactional",
        icsAttachment: { filename: "appointment.ics", content: ics },
      }).catch((e) => ({ success: false, error: String(e) })),
    ])
    icsSentToAttendee = !!attendeeSend.success
    icsSentToOwner = !!ownerSend.success
  }

  return { success: true, row: r, alreadyConfirmed, icsSentToAttendee, icsSentToOwner, subject }
}

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
  const core = await confirmAppointmentCore({ kind: "listing_appointment", calendarEventId: params.calendarEventId, brokerageId: params.brokerageId, confirmedByUserId: params.confirmedByUserId })
  if (!core.success) return core
  const r = core.row
  const propertyAddress = ((r.metadata?.property_address as string | undefined) ?? r.location ?? "the property")

  // ── Portal in-app push (confirmed card) ─────────────────────────────────
  const svc = createServiceClient()
  const portalPushed = await sentinelWrite(
    svc,
    svc.from("portal_event_stream").insert({
      brokerage_id: r.brokerage_id, contact_id: r.entity_id, agent_user_id: r.agent_user_id,
      event_type: LISTING_APPOINTMENT_CONFIRMED_EVENT_TYPE,
      customer_copy: `Your listing appointment is confirmed for ${new Date(r.start_at).toLocaleString()} at ${propertyAddress}.`,
      customer_icon: "calendar-check",
      agent_copy: `Confirmed: listing appointment at ${propertyAddress}.`,
      agent_action_required: false, agent_action_status: "completed_executed",
      severity: "normal", metadata: { calendar_event_id: r.id },
      occurred_at: new Date().toISOString(),
    }),
    { table: "portal_event_stream", flow: "listing_appointment_confirm", brokerageId: r.brokerage_id },
  )

  return { success: true, alreadyConfirmed: core.alreadyConfirmed, icsSentToContact: core.icsSentToAttendee, icsSentToAgent: core.icsSentToOwner, portalPushed }
}

export interface ConfirmDemoAppointmentParams {
  calendarEventId: string
  /** The platform staffer who clicked confirm (gated at the action). */
  confirmedByUserId: string
}

export type ConfirmDemoAppointmentResult =
  | { success: true; alreadyConfirmed: boolean; icsSentToProspect: boolean; icsSentToRep: boolean; prospectStamped: boolean; prospectId: string }
  | { success: false; error: string }

/** Lane 76B — the rep's confirm: the SAME core (status flip, Google PATCH,
 *  two ICS emails), then the prospect row's stamp. No portal push — a
 *  prospect has no portal; the emails ARE their confirmation. */
export async function confirmDemoAppointment(params: ConfirmDemoAppointmentParams): Promise<ConfirmDemoAppointmentResult> {
  const core = await confirmAppointmentCore({ kind: "demo_appointment", calendarEventId: params.calendarEventId, brokerageId: null, confirmedByUserId: params.confirmedByUserId })
  if (!core.success) return core
  const svc = createServiceClient()
  const prospectStamped = await markProspectDemoConfirmed(svc, { prospectId: core.row.entity_id, calendarEventId: core.row.id })
  return { success: true, alreadyConfirmed: core.alreadyConfirmed, icsSentToProspect: core.icsSentToAttendee, icsSentToRep: core.icsSentToOwner, prospectStamped, prospectId: core.row.entity_id }
}

// ── sendAppointmentReminders — the 5-day/2-day/morning-of cadence, both kinds ──

export interface ListingAppointmentReminderResult {
  scanned: number
  remindersSent: number
}

/** Cron-callable sweep (app/api/cron/listing-appointment-reminders). Only
 *  touches CONFIRMED ('scheduled') appointments of the kinds this module
 *  owns — a still-pending or already-cancelled row gets no reminder, which
 *  is how "cancel on reschedule" takes effect: bookAppointmentCore's
 *  supersede step flips the old row to 'cancelled' and this query never sees
 *  it again. Lane 76B: the demo kind rides the SAME sweep (attendee resolved
 *  by the row's own entity class; no portal card for a prospect).
 *
 *  TOMBSTONE (lane 76B): formerly `sendListingAppointmentReminders` — renamed
 *  because it now serves both kinds; the cron route imports the new name. */
export async function sendAppointmentReminders(svc: Svc = createServiceClient(), now: Date = new Date()): Promise<ListingAppointmentReminderResult> {
  const horizonEnd = new Date(now.getTime() + (REMINDER_TIER_DAYS_OUT["5_day"] + 1) * 86_400_000)
  const { data } = await svc
    .from("calendar_events")
    .select("id, brokerage_id, agent_user_id, entity_type, entity_id, event_type, start_at, location, metadata")
    .in("event_type", APPOINTMENT_EVENT_TYPES)
    .eq("status", LISTING_APPOINTMENT_STATUS.CONFIRMED)
    .gte("start_at", now.toISOString())
    .lte("start_at", horizonEnd.toISOString())
  const rows = (data ?? []) as Array<Pick<AppointmentRow, "id" | "brokerage_id" | "agent_user_id" | "entity_type" | "entity_id" | "event_type" | "start_at" | "location" | "metadata">>

  let remindersSent = 0
  for (const row of rows) {
    const kind = appointmentKindForEventType(row.event_type)
    if (!kind) continue
    const spec = APPOINTMENT_KIND_SPEC[kind]
    const tier = reminderTierForAppointment(row.start_at, now)
    if (!tier) continue
    const sentTiers = new Set((row.metadata?.reminder_tiers_sent as string[] | undefined) ?? [])
    if (sentTiers.has(tier)) continue

    const c = await resolveAppointmentAttendee(svc, row)
    const where = kind === "listing_appointment"
      ? ((row.metadata?.property_address as string | undefined) ?? row.location ?? "the property")
      : (row.location ?? "a video call")
    const when = new Date(row.start_at).toLocaleString()
    const what = kind === "listing_appointment" ? `your listing appointment at ${where}` : `your product demo (${where})`
    const copy = tier === "morning_of"
      ? `Today's the day — ${what} is at ${when}.`
      : `Reminder: ${what} is coming up (${when}).`

    if (c?.email) {
      await dispatchEmail({
        to: c.email, subject: `${spec.label} reminder`, html: `<p>Hi ${c.firstName ?? ""},</p><p>${copy}</p>`,
        ...(row.entity_type === "contact" ? { contactId: row.entity_id } : {}),
        brokerageId: row.brokerage_id,
        systemSource: spec.systemSource, channelPurpose: "transactional",
      }).catch((e) => console.error(`[${kind}] reminder email failed:`, e))
    }
    if (row.entity_type === "contact") {
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
    }
    await sentinelWrite(
      svc,
      svc.from("calendar_events").update({ metadata: { ...(row.metadata ?? {}), reminder_tiers_sent: [...sentTiers, tier] } }).eq("id", row.id),
      { table: "calendar_events", flow: `${kind}_reminder`, brokerageId: row.brokerage_id },
    )
    remindersSent += 1
  }
  return { scanned: rows.length, remindersSent }
}
