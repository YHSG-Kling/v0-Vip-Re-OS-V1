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

  // ── ISA & Outreach ────────────────────────────────────────────────────────
  ISA_OUTREACH_EMAIL  = 'isa_outreach_email',
  ISA_FOLLOWUP_EMAIL  = 'isa_followup_email',
  ISA_DIRECT_MAIL     = 'isa_direct_mail',
  ISA_VIDEO_SEND      = 'isa_video_send',
  ISA_APPOINTMENT     = 'isa_appointment',

  // ── Appointments & Events ─────────────────────────────────────────────────
  LISTING_APPOINTMENT = 'listing_appointment',
  OPEN_HOUSE          = 'open_house',
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
