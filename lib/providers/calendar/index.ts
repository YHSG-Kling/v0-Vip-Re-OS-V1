/**
 * CALENDAR PROVIDER
 * Owns all calendar / scheduling API calls: Nylas, Calendly, Google Calendar.
 * No business logic — pure API client wrappers.
 * Falls back to a stub when credentials are not configured.
 */

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

// ─── NYLAS ─────────────────────────────────────────────────────────────────────

const NYLAS_API_BASE = "https://api.us.nylas.com"

function getNylasCredentials() {
  const apiKey = process.env.NYLAS_API_KEY
  const grantId = process.env.NYLAS_GRANT_ID
  return apiKey && grantId ? { apiKey, grantId } : null
}

export async function createCalendarEvent(event: CalendarEvent): Promise<CreateEventResult> {
  const credentials = getNylasCredentials()

  if (!credentials) {
    // Stub response when credentials not configured
    return {
      success: true,
      eventId: `mock-event-${Date.now()}`,
      mock: true,
    }
  }

  const { apiKey, grantId } = credentials

  const response = await fetch(`${NYLAS_API_BASE}/v3/grants/${grantId}/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: event.title,
      description: event.description,
      when: {
        start_time: Math.floor(new Date(event.startTime).getTime() / 1000),
        end_time: Math.floor(new Date(event.endTime).getTime() / 1000),
      },
      location: event.location,
      participants: event.attendees?.map((a) => ({ email: a.email, name: a.name })) || [],
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Nylas createEvent error: ${response.statusText} - ${errorText}`)
  }

  const data = await response.json()

  return {
    success: true,
    eventId: data.data?.id,
    conferenceUrl: data.data?.conferencing?.details?.url,
  }
}

export async function getAvailability(params: GetAvailabilityParams): Promise<GetAvailabilityResult> {
  const credentials = getNylasCredentials()

  if (!credentials) {
    // Return mock slots when credentials not configured
    const slots: AvailabilitySlot[] = []
    const start = new Date(params.startDate)
    const end = new Date(params.endDate)

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const slotStart = new Date(d)
      slotStart.setHours(10, 0, 0, 0)
      const slotEnd = new Date(slotStart)
      slotEnd.setMinutes(slotStart.getMinutes() + params.durationMinutes)
      slots.push({
        startTime: slotStart.toISOString(),
        endTime: slotEnd.toISOString(),
      })
    }

    return { success: true, slots, mock: true }
  }

  const { apiKey, grantId } = credentials

  const response = await fetch(`${NYLAS_API_BASE}/v3/grants/${grantId}/calendars/availability`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      start_time: Math.floor(new Date(params.startDate).getTime() / 1000),
      end_time: Math.floor(new Date(params.endDate).getTime() / 1000),
      duration_minutes: params.durationMinutes,
      timezone: params.timezone || "America/Los_Angeles",
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Nylas getAvailability error: ${response.statusText} - ${errorText}`)
  }

  const data = await response.json()

  return {
    success: true,
    slots: (data.data?.time_slots || []).map((slot: any) => ({
      startTime: new Date(slot.start_time * 1000).toISOString(),
      endTime: new Date(slot.end_time * 1000).toISOString(),
    })),
  }
}

export async function updateCalendarEvent(
  eventId: string,
  updates: Partial<CalendarEvent>
): Promise<UpdateEventResult> {
  const credentials = getNylasCredentials()

  if (!credentials) return { success: true, mock: true }

  const { apiKey, grantId } = credentials

  const body: Record<string, any> = {}
  if (updates.title) body.title = updates.title
  if (updates.description) body.description = updates.description
  if (updates.location) body.location = updates.location
  if (updates.startTime && updates.endTime) {
    body.when = {
      start_time: Math.floor(new Date(updates.startTime).getTime() / 1000),
      end_time: Math.floor(new Date(updates.endTime).getTime() / 1000),
    }
  }

  const response = await fetch(`${NYLAS_API_BASE}/v3/grants/${grantId}/events/${eventId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Nylas updateEvent error: ${response.statusText} - ${errorText}`)
  }

  return { success: true }
}

export async function deleteCalendarEvent(eventId: string): Promise<DeleteEventResult> {
  const credentials = getNylasCredentials()

  if (!credentials) return { success: true, mock: true }

  const { apiKey, grantId } = credentials

  const response = await fetch(`${NYLAS_API_BASE}/v3/grants/${grantId}/events/${eventId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey}` },
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Nylas deleteEvent error: ${response.statusText} - ${errorText}`)
  }

  return { success: true }
}
