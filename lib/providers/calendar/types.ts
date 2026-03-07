// TypeScript strict — no any, no default exports

export type CalendarProviderName = "google" | "outlook" | "ical"

export interface CalendarProviderEventInput {
  externalId?: string
  title: string
  description?: string
  startAtUtcISO: string
  endAtUtcISO?: string
  timezoneName: string
  metadata?: Record<string, unknown>
}

export interface CalendarProvider {
  name: CalendarProviderName

  upsertEvent(params: {
    brokerageId: string
    userId: string
    event: CalendarProviderEventInput
  }): Promise<{ externalId: string }>

  deleteEvent(params: {
    brokerageId: string
    userId: string
    externalId: string
  }): Promise<void>
}
