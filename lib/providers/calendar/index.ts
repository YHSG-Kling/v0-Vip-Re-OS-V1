/**
 * CALENDAR PROVIDER
 * Per-agent calendar via the agent's connected Google / Microsoft account (OAuth).
 * Nylas has been retired. When no personal calendar is connected (or no actor is
 * supplied) the functions return a mock response so non-actor callers keep working.
 * No business logic — pure API client routing.
 */

import {
  createEventViaPersonal,
  getAvailabilityViaPersonal,
  updateEventViaPersonal,
  deleteEventViaPersonal,
} from "./personal-calendar"

/** Optional actor context — when agentUserId resolves a connected Google/Outlook
 *  account, the event lands on THAT agent's calendar. */
export interface CalendarActor {
  agentUserId?: string | null
}

// ─── TYPES ─────────────────────────────────────────────────────────────────────

export interface CalendarEvent {
  id?: string
  title: string
  description?: string
  startTime: string // ISO 8601
  endTime: string   // ISO 8601
  location?: string
  attendees?: { email: string; name?: string }[]
  conferenceUrl?: string
}

export interface CreateEventResult {
  success: boolean
  eventId?: string
  conferenceUrl?: string
  error?: string
  mock?: boolean
}

export interface GetAvailabilityParams {
  startDate: string
  endDate: string
  durationMinutes: number
  timezone?: string
}

export interface AvailabilitySlot {
  startTime: string
  endTime: string
}

export interface GetAvailabilityResult {
  success: boolean
  slots: AvailabilitySlot[]
  error?: string
  mock?: boolean
}

export interface UpdateEventResult {
  success: boolean
  error?: string
  mock?: boolean
}

export interface DeleteEventResult {
  success: boolean
  error?: string
  mock?: boolean
}

// ─── Per-agent Google / Microsoft (OAuth) with mock fallback ────────────────────

export async function createCalendarEvent(event: CalendarEvent, actor?: CalendarActor): Promise<CreateEventResult> {
  if (actor?.agentUserId) {
    const res = await createEventViaPersonal(actor.agentUserId, event)
    if (res) return res
  }
  // No personal calendar connected — mock so non-actor callers keep working.
  return { success: true, eventId: `mock-event-${Date.now()}`, mock: true }
}

export async function getAvailability(params: GetAvailabilityParams, actor?: CalendarActor): Promise<GetAvailabilityResult> {
  if (actor?.agentUserId) {
    const res = await getAvailabilityViaPersonal(actor.agentUserId, params)
    if (res) return res
  }
  // Mock business-hours slots when no personal calendar is connected.
  const slots: AvailabilitySlot[] = []
  const start = new Date(params.startDate)
  const end = new Date(params.endDate)
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const slotStart = new Date(d)
    slotStart.setHours(10, 0, 0, 0)
    const slotEnd = new Date(slotStart)
    slotEnd.setMinutes(slotStart.getMinutes() + params.durationMinutes)
    slots.push({ startTime: slotStart.toISOString(), endTime: slotEnd.toISOString() })
  }
  return { success: true, slots, mock: true }
}

export async function updateCalendarEvent(
  eventId: string,
  updates: Partial<CalendarEvent>,
  actor?: CalendarActor,
): Promise<UpdateEventResult> {
  if (actor?.agentUserId) {
    const res = await updateEventViaPersonal(actor.agentUserId, eventId, updates)
    if (res) return res
  }
  return { success: true, mock: true }
}

export async function deleteCalendarEvent(eventId: string, actor?: CalendarActor): Promise<DeleteEventResult> {
  if (actor?.agentUserId) {
    const res = await deleteEventViaPersonal(actor.agentUserId, eventId)
    if (res) return res
  }
  return { success: true, mock: true }
}
