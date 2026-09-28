// lib/kernel/calendar-types.ts
// Calendar event types and interfaces for the kernel layer.
// Named exports only — no default exports.

export enum CalendarEventType {
  INSPECTION          = 'inspection',
  APPRAISAL           = 'appraisal',
  FINANCING_DEADLINE  = 'financing_deadline',
  WALKTHROUGH         = 'walkthrough',
  CLOSING             = 'closing',
  TASK_DUE            = 'task_due',
  // CLAUDE.md §1 (BUILD the missing half, lane Z1 2026-09-08 hunt 2): notification_rules has
  // live rows on trigger_event='cd_due' (Closing Disclosure due — TRID's 3-business-day rule)
  // but there was no calendar event type to carry it, so KernelEvent.CD_DUE could never fire.
  // See lib/kernel/calendar-deadline-watcher.ts CALENDAR_EVENT_TYPE_TO_KERNEL_EVENT and
  // lib/kernel/milestone-calendar-bridge.ts (creates the calendar_events row, closingDate - 3 days).
  CLOSING_DISCLOSURE  = 'closing_disclosure',

  // ── ISA & Outreach ────────────────────────────────────────────────────────
  ISA_OUTREACH_EMAIL  = 'isa_outreach_email',
  ISA_FOLLOWUP_EMAIL  = 'isa_followup_email',
  ISA_DIRECT_MAIL     = 'isa_direct_mail',
  ISA_VIDEO_SEND      = 'isa_video_send',
  ISA_APPOINTMENT     = 'isa_appointment',

  // ── Appointments & Events ─────────────────────────────────────────────────
  LISTING_APPOINTMENT = 'listing_appointment',
  // Lane 76B — a PLATFORM prospect's product demo on a platform sales rep's
  // connected calendar (lib/ai-isa/listing-appointment.ts::bookDemoAppointment,
  // the SAME find/book/confirm/remind survivor the listing appointment rides).
  // entity_type on such a row is 'platform_prospect' (calendar_events carries
  // no CHECK on entity_type/event_type — verified live 2026-09-18), never
  // 'contact'/'lead': a platform prospect is neither.
  DEMO_APPOINTMENT    = 'demo_appointment',
  OPEN_HOUSE          = 'open_house',
}

/**
 * ONE SPELLING PER APPOINTMENT KIND (lane 87B2, CLAUDE.md §6). A listing appointment
 * was stored three ways — 'listing_appointment' (this enum), the agent calendar
 * scheduler's 'listing_consultation', and the AI-ISA seller milestone's
 * 'isa_appointment' (scheduleISAAppointment's generic ISA meeting). Readers matched
 * different subsets, so the reminder cadence, the meeting recap and the prep safety net
 * each missed a different third of the same meetings. Every writer now stores
 * LISTING_APPOINTMENT; a legacy spelling a stale client still posts is folded here, at
 * the write. (Live 2026-09-28: calendar_events carries no CHECK on event_type and
 * 0 rows, so no backfill/migration was owed.)
 */
const LEGACY_CALENDAR_EVENT_TYPE_ALIASES: Record<string, CalendarEventType> = {
  listing_consultation: CalendarEventType.LISTING_APPOINTMENT,
}

/** A posted/stored event_type → its one spelling (unknown values pass through unchanged). */
export function canonicalCalendarEventType(eventType: string): string {
  return LEGACY_CALENDAR_EVENT_TYPE_ALIASES[eventType] ?? eventType
}

export interface CalendarEventMetadata {
  reminderSentAt?:         string
  escalationLevel?:        number
  originalDueDate?:        string
  sourceLifecycleEventId?: string
  sourceMilestoneId?:      string
  [key: string]:           unknown
}

export interface KernelCalendarEvent {
  brokerageId:       string
  entityType:        'transaction' | 'contact' | 'lead'
  entityId:          string
  eventType:         CalendarEventType
  startAt:           Date
  endAt?:            Date
  timezoneName:      string
  isSystemGenerated: boolean
  metadata?:         CalendarEventMetadata
}
