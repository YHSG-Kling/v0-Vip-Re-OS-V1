'use server'

import { createClient } from '@/lib/supabase/server'
import { scheduleISAAppointment } from '@/lib/ai-isa/appointment-scheduler'
import { isAgentOrTenantAdmin } from '@/lib/auth/resolve-user-role'
import { resolveAgentRecipient } from '@/lib/notifications/recipient-tenant'

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

  // THE ONE ROSTER (lane 91D2). This was a retyped list — ['admin','broker',
  // 'superadmin','agent'] — which named a user_type no live row has
  // ('superadmin'; platform staff live in platform_role, §4) and refused
  // broker_owner, broker_admin and team_lead, all of whom the roster admits.
  if (!isAgentOrTenantAdmin({ user_type: profile.user_type })) {
    return { success: false, error: 'Forbidden: insufficient permissions to schedule ISA appointments' }
  }
  if (!profile.brokerage_id) {
    return { success: false, error: 'Your account is not linked to a brokerage yet.' }
  }

  if (!input.leadId && !input.contactId) {
    return { success: false, error: 'Either leadId or contactId is required' }
  }

  // THE BOOKING AGENT (lane 91D2, CLAUDE.md §3). The scheduler stamps a USERS id
  // (calendar_events.agent_user_id). For a CONTACT the appointment belongs to the
  // contact's agent — contacts.agent_id is an AGENTS id, crossed to users through
  // agents.user_id, never substituted — so a broker booking for an agent's client
  // no longer lands the appointment on the broker's own calendar. A LEAD has no
  // agent by ruling (§5: leads belong to the brokerage), so the booker holds it.
  let agentUserId: string = profile.id
  if (input.contactId) {
    const { data: contact, error: contactError } = await supabase
      .from('contacts')
      .select('agent_id')
      .eq('id', input.contactId)
      .eq('brokerage_id', profile.brokerage_id)
      .maybeSingle()
    if (contactError) return { success: false, error: `Could not read the contact: ${contactError.message}` }
    if (!contact) return { success: false, error: 'Contact not found in your brokerage' }
    const contactAgentId = (contact as { agent_id?: string | null }).agent_id ?? null
    if (contactAgentId) {
      // The ONE agents.id → users.id crossing (lib/notifications/recipient-tenant.ts
      // resolveAgentRecipient), not a private agents.user_id read. Its tenant is the
      // recipient's users.brokerage_id; an agent resolving outside the caller's
      // brokerage is never booked onto (the booker keeps the appointment).
      const crossed = await resolveAgentRecipient(supabase, contactAgentId)
      if (!crossed.ok) return { success: false, error: `Could not resolve the contact's agent: ${crossed.reason}` }
      if (crossed.userId && crossed.brokerageId === profile.brokerage_id) agentUserId = crossed.userId
    }
  }

  try {
    const calendarEventId = await scheduleISAAppointment({
      brokerageId:  profile.brokerage_id,
      leadId:       input.leadId,
      contactId:    input.contactId,
      agentUserId,
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
