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
  entityType:        'transaction' | 'contact'
  entityId:          string
  eventType:         CalendarEventType
  startAt:           Date
  endAt?:            Date
  timezoneName:      string
  isSystemGenerated: boolean
  metadata?:         CalendarEventMetadata
}
