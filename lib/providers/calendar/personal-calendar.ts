// lib/providers/calendar/personal-calendar.ts
// Per-AGENT calendar via the agent's OWN connected Google / Microsoft account — the SAME
// OAuth token the email adapter uses (the Google/Microsoft consent already grants calendar
// scope). This is the calendar path now that Nylas is retired: a solo agent's bookings land
// on THEIR calendar. Returns null when no personal calendar is connected (index falls back
// to the mock no-credentials response).
//
// No stub — real Google Calendar v3 + Microsoft Graph calls. The pure slot computation is
// unit-tested in the simulator.

import "server-only"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { getFreshPersonalToken, type EmailOwner } from "@/lib/providers/email/personal-email-adapter"
import { computeFreeSlots } from "./free-slots"
import type {
  CalendarEvent,
  CreateEventResult,
  GetAvailabilityParams,
  GetAvailabilityResult,
  UpdateEventResult,
  DeleteEventResult,
} from "./index"

const GOOGLE_CAL = "https://www.googleapis.com/calendar/v3"
const GRAPH = "https://graph.microsoft.com/v1.0"

export async function hasPersonalCalendar(agentUserId: string, owner?: EmailOwner): Promise<boolean> {
  return (await getFreshPersonalToken(agentUserId, owner).catch(() => null)) != null
}

export async function createEventViaPersonal(agentUserId: string, event: CalendarEvent, owner?: EmailOwner): Promise<CreateEventResult | null> {
  const tok = await getFreshPersonalToken(agentUserId, owner).catch(() => null)
  if (!tok) return null

  if (tok.provider === "gmail") {
    const res = await callConnector<{ id?: string; hangoutLink?: string }>({
      connector: "google_calendar", baseUrl: GOOGLE_CAL, path: "/calendars/primary/events", method: "POST",
      query: { conferenceDataVersion: "1" }, auth: { style: "bearer", token: tok.accessToken },
      body: {
        summary: event.title,
        description: event.description,
        location: event.location,
        start: { dateTime: event.startTime },
        end: { dateTime: event.endTime },
        attendees: event.attendees?.map((a) => ({ email: a.email, displayName: a.name })),
      },
    })
    if (!res.ok) return { success: false, error: `Google Calendar (${res.status}): ${res.error ?? ""}` }
    return { success: true, eventId: res.data?.id, conferenceUrl: res.data?.hangoutLink }
  }

  const res = await callConnector<{ id?: string; onlineMeeting?: { joinUrl?: string } }>({
    connector: "outlook_calendar", baseUrl: GRAPH, path: "/me/events", method: "POST",
    auth: { style: "bearer", token: tok.accessToken },
    body: {
      subject: event.title,
      body: { contentType: "HTML", content: event.description ?? "" },
      start: { dateTime: event.startTime, timeZone: "UTC" },
      end: { dateTime: event.endTime, timeZone: "UTC" },
      location: event.location ? { displayName: event.location } : undefined,
      attendees: event.attendees?.map((a) => ({ emailAddress: { address: a.email, name: a.name }, type: "required" })),
    },
  })
  if (!res.ok) return { success: false, error: `Microsoft Graph (${res.status}): ${res.error ?? ""}` }
  return { success: true, eventId: res.data?.id, conferenceUrl: res.data?.onlineMeeting?.joinUrl }
}

export async function getAvailabilityViaPersonal(agentUserId: string, params: GetAvailabilityParams, owner?: EmailOwner): Promise<GetAvailabilityResult | null> {
  const tok = await getFreshPersonalToken(agentUserId, owner).catch(() => null)
  if (!tok) return null
  const timeMin = new Date(params.startDate).toISOString()
  const timeMax = new Date(params.endDate).toISOString()

  let busy: Array<{ start: number; end: number }> = []
  if (tok.provider === "gmail") {
    const res = await callConnector<{ calendars?: { primary?: { busy?: any[] } } }>({
      connector: "google_calendar", baseUrl: GOOGLE_CAL, path: "/freeBusy", method: "POST",
      auth: { style: "bearer", token: tok.accessToken },
      body: { timeMin, timeMax, items: [{ id: "primary" }] },
    })
    if (!res.ok) return { success: false, slots: [], error: `Google freeBusy (${res.status})` }
    busy = (res.data?.calendars?.primary?.busy ?? []).map((b: any) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }))
  } else {
    const res = await callConnector<{ value?: any[] }>({
      connector: "outlook_calendar", baseUrl: GRAPH, path: "/me/calendarView", method: "GET",
      query: { startDateTime: timeMin, endDateTime: timeMax, "$select": "start,end", "$top": "200" },
      auth: { style: "bearer", token: tok.accessToken },
      headers: { Prefer: 'outlook.timezone="UTC"' },
    })
    if (!res.ok) return { success: false, slots: [], error: `Microsoft calendarView (${res.status})` }
    busy = (res.data?.value ?? [])
      .map((ev: any) => ({ start: Date.parse(`${ev.start?.dateTime}Z`), end: Date.parse(`${ev.end?.dateTime}Z`) }))
      .filter((b: any) => !Number.isNaN(b.start) && !Number.isNaN(b.end))
  }

  return { success: true, slots: computeFreeSlots(busy, params) }
}

export async function updateEventViaPersonal(agentUserId: string, eventId: string, updates: Partial<CalendarEvent>, owner?: EmailOwner): Promise<UpdateEventResult | null> {
  const tok = await getFreshPersonalToken(agentUserId, owner).catch(() => null)
  if (!tok) return null

  if (tok.provider === "gmail") {
    const body: Record<string, any> = {}
    if (updates.title) body.summary = updates.title
    if (updates.description) body.description = updates.description
    if (updates.location) body.location = updates.location
    if (updates.startTime) body.start = { dateTime: updates.startTime }
    if (updates.endTime) body.end = { dateTime: updates.endTime }
    const res = await callConnector({
      connector: "google_calendar", baseUrl: GOOGLE_CAL,
      path: `/calendars/primary/events/${encodeURIComponent(eventId)}`, method: "PATCH",
      auth: { style: "bearer", token: tok.accessToken }, body,
    })
    return res.ok ? { success: true } : { success: false, error: `Google Calendar update (${res.status})` }
  }

  const body: Record<string, any> = {}
  if (updates.title) body.subject = updates.title
  if (updates.description) body.body = { contentType: "HTML", content: updates.description }
  if (updates.location) body.location = { displayName: updates.location }
  if (updates.startTime) body.start = { dateTime: updates.startTime, timeZone: "UTC" }
  if (updates.endTime) body.end = { dateTime: updates.endTime, timeZone: "UTC" }
  const res = await callConnector({
    connector: "outlook_calendar", baseUrl: GRAPH, path: `/me/events/${encodeURIComponent(eventId)}`, method: "PATCH",
    auth: { style: "bearer", token: tok.accessToken }, body,
  })
  return res.ok ? { success: true } : { success: false, error: `Microsoft Graph update (${res.status})` }
}

export async function deleteEventViaPersonal(agentUserId: string, eventId: string, owner?: EmailOwner): Promise<DeleteEventResult | null> {
  const tok = await getFreshPersonalToken(agentUserId, owner).catch(() => null)
  if (!tok) return null
  const res = tok.provider === "gmail"
    ? await callConnector({
        connector: "google_calendar", baseUrl: GOOGLE_CAL,
        path: `/calendars/primary/events/${encodeURIComponent(eventId)}`, method: "DELETE",
        auth: { style: "bearer", token: tok.accessToken },
      })
    : await callConnector({
        connector: "outlook_calendar", baseUrl: GRAPH,
        path: `/me/events/${encodeURIComponent(eventId)}`, method: "DELETE",
        auth: { style: "bearer", token: tok.accessToken },
      })
  // Google returns 410 if already deleted — treat as success.
  return res.ok || res.status === 410 ? { success: true } : { success: false, error: `Calendar delete (${res.status})` }
}
