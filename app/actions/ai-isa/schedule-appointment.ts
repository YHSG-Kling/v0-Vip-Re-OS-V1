'use server'

import { createClient } from '@/lib/supabase/server'
import { scheduleISAAppointment } from '@/lib/ai-isa/appointment-scheduler'

export type ScheduleAppointmentInput = {
  leadId?: string
  contactId?: string
  startAt: string   // ISO string from client
  endAt: string     // ISO string from client
  timezoneName: string
  location?: string
  notes?: string
  /** "zoom" attempts a REAL Zoom meeting via the booker's connected scope
   *  (agent → team → brokerage). Honest fallback when not connected. */
  meetingMode?: 'zoom' | 'in_person' | 'phone'
}

export type ScheduleAppointmentResult =
  | {
      success: true
      calendarEventId: string
      /** Present when meetingMode was 'zoom': either the real meeting's join
       *  URL, or the honest reason none was created (settings hint / API error). */
      zoom?: { created: true; joinUrl: string; meetingId: string } | { created: false; reason: string; detail: string }
    }
  | { success: false; error: string }

export async function scheduleAppointment(
  input: ScheduleAppointmentInput,
): Promise<ScheduleAppointmentResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user?.id) {
    return { success: false, error: 'Unauthorized' }
  }

  // Resolve agentId + brokerageId from the current user's profile
  const { data: profile, error: profileError } = await supabase
    .from('users')
    .select('id, brokerage_id, user_type')
    .eq('id', user.id)
    .maybeSingle()

  if (profileError || !profile) {
    return { success: false, error: 'User profile not found' }
  }

  if (!['admin', 'broker', 'superadmin', 'agent'].includes(profile.user_type)) {
    return { success: false, error: 'Forbidden: insufficient permissions to schedule ISA appointments' }
  }

  if (!input.leadId && !input.contactId) {
    return { success: false, error: 'Either leadId or contactId is required' }
  }

  try {
    const calendarEventId = await scheduleISAAppointment({
      brokerageId:  profile.brokerage_id,
      leadId:       input.leadId,
      contactId:    input.contactId,
      agentId:      profile.id,
      startAt:      new Date(input.startAt),
      endAt:        new Date(input.endAt),
      timezoneName: input.timezoneName,
      location:     input.location,
      notes:        input.notes,
      meetingMode:  input.meetingMode,
    })

    // Report the honest Zoom outcome (round 39): read back what the scheduler
    // stamped — a real join URL, or the refusal with its settings hint.
    let zoom: Extract<ScheduleAppointmentResult, { success: true }>['zoom']
    if (input.meetingMode === 'zoom') {
      const { data: ev } = await supabase
        .from('calendar_events')
        .select('metadata')
        .eq('id', calendarEventId)
        .maybeSingle()
      const meta = (ev?.metadata ?? {}) as Record<string, any>
      if (meta.zoom?.join_url && meta.zoom?.meeting_id) {
        zoom = { created: true, joinUrl: meta.zoom.join_url, meetingId: String(meta.zoom.meeting_id) }
      } else if (meta.zoom_outcome) {
        zoom = { created: false, reason: meta.zoom_outcome.reason ?? 'not_connected', detail: meta.zoom_outcome.detail ?? '' }
      }
    }

    return { success: true, calendarEventId, ...(zoom ? { zoom } : {}) }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: message }
  }
}
