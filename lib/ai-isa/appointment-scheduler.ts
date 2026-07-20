'use server'

import { createServiceClient } from '@/lib/supabase/service'
import { CalendarEventType } from '@/lib/kernel/calendar-types'
import { KernelEvent } from '@/lib/kernel/events'
import {
  assertValidTransition,
  processKernelEvent,
} from '@/lib/kernel'

export async function scheduleISAAppointment(params: {
  brokerageId: string
  leadId?: string
  contactId?: string
  /** The auth users.id — stamps calendar_events.agent_user_id (a USERS-class
   *  column: agent-coaching + no-show autopilot key it against users). Callers
   *  holding agents.id must resolve via resolveAgentRecordToUserId first. */
  agentId: string
  startAt: Date
  endAt: Date
  timezoneName: string
  location?: string
  notes?: string
  /** "zoom" → attempt a REAL Zoom meeting (round 39): if any owner in the
   *  booking agent's host cascade (agent → team → brokerage; platform for a
   *  platform actor) has Zoom connected, the meeting is created via the Zoom
   *  API and the join URL becomes the event location. Not connected / provider
   *  unconfigured / API rejection → the appointment still books, honestly
   *  in-person/phone, with the refusal recorded in metadata.zoom_outcome. */
  meetingMode?: 'zoom' | 'in_person' | 'phone'
}): Promise<string> {
  if (!params.leadId && !params.contactId) {
    throw new Error('scheduleISAAppointment requires either leadId or contactId')
  }

  const supabase = createServiceClient()
  const entityType = params.leadId ? 'lead' : 'contact'
  const entityId   = params.leadId ?? params.contactId!

  // ── Zoom branch (additive, round 39) — never blocks the booking ────────────
  let zoomLocation: string | null = null
  let zoomMetadata: Record<string, unknown> = {}
  if (params.meetingMode === 'zoom') {
    try {
      const { ensureZoomMeetingForAppointment } = await import('@/lib/connections/zoom')
      const { connectionScopeForUserType } = await import('@/lib/connections/field-spec')
      const { data: booker } = await supabase
        .from('users')
        .select('user_type, team_id, brokerage_id')
        .eq('id', params.agentId)
        .maybeSingle()
      const scope = connectionScopeForUserType((booker?.user_type as string) ?? '').scope
      const outcome = await ensureZoomMeetingForAppointment(supabase, {
        host: {
          scope: scope as any,
          agentUserId: params.agentId,
          teamId: (booker?.team_id as string | null) ?? null,
          brokerageId: (booker?.brokerage_id as string | null) ?? params.brokerageId,
        },
        topic: 'ISA Appointment',
        startAt: params.startAt,
        endAt: params.endAt,
        timezoneName: params.timezoneName,
      })
      if (outcome.created) {
        zoomLocation = outcome.joinUrl
        zoomMetadata = {
          zoom: {
            meeting_id: outcome.meetingId,
            join_url: outcome.joinUrl,
            start_url: outcome.startUrl,
            host_owner_type: outcome.hostOwnerType,
            host_owner_id: outcome.hostOwnerId,
          },
        }
      } else {
        // HONEST refusal — no fabricated link; the hint travels to the surface.
        zoomMetadata = { zoom_outcome: { created: false, reason: outcome.reason, detail: outcome.detail } }
      }
    } catch (e: any) {
      zoomMetadata = { zoom_outcome: { created: false, reason: 'api_error', detail: e?.message ?? 'Zoom lane error' } }
    }
  }

  // ── Step 1: Guard representation state ──────────────────────────────────────
  if (params.leadId) {
    const { data: lead, error } = await supabase
      .from('leads')
      .select('lifecycle_state')
      .eq('id', params.leadId)
      .single()

    if (error || !lead) throw new Error(`Lead not found: ${params.leadId}`)
    if (lead.lifecycle_state === 'representation') {
      throw new Error('Cannot schedule ISA appointment: lead is under representation')
    }
  }

  // ── Step 2: Insert calendar_events ──────────────────────────────────────────
  const { data: calendarEvent, error: calError } = await supabase
    .from('calendar_events')
    .insert({
      brokerage_id:        params.brokerageId,
      agent_user_id:       params.agentId,
      entity_type:         entityType,
      entity_id:           entityId,
      event_type:          CalendarEventType.ISA_APPOINTMENT,
      title:               'ISA Appointment',
      start_at:            params.startAt.toISOString(),
      end_at:              params.endAt.toISOString(),
      timezone_name:       params.timezoneName,
      // A REAL Zoom join URL (API-accepted) wins the location; otherwise the
      // caller's honest in-person/phone location.
      location:            zoomLocation ?? params.location ?? null,
      is_system_generated: true,
      status:              'scheduled',
      metadata:            { notes: params.notes ?? null, ...zoomMetadata },
    })
    .select('id')
    .single()

  if (calError || !calendarEvent) {
    throw new Error(`Failed to create calendar event: ${calError?.message ?? 'no row returned'}`)
  }

  // ── Step 3: Insert ai_isa_activities ────────────────────────────────────────
  const { error: activityError } = await supabase
    .from('ai_isa_activities')
    .insert({
      brokerage_id:        params.brokerageId,
      lead_id:             params.leadId ?? null,
      contact_id:          params.contactId ?? null,
      activity_type:       'appointment_set',
      qualifying_response: { calendar_event_id: calendarEvent.id },
    })

  if (activityError) {
    throw new Error(`Failed to log ISA activity: ${activityError.message}`)
  }

  // ── Step 4: Advance lead lifecycle_state → appointment ─────────────────────
  if (params.leadId) {
    const { data: lead } = await supabase
      .from('leads')
      .select('lifecycle_state')
      .eq('id', params.leadId)
      .single()

    if (lead) {
      await assertValidTransition(lead.lifecycle_state, 'appointment', params.leadId)

      const { error: updateError } = await supabase
        .from('leads')
        .update({
          lifecycle_state: 'appointment',
          updated_at: new Date().toISOString(),
        })
        .eq('id', params.leadId)

      if (updateError) {
        throw new Error(`Failed to update lead lifecycle_state: ${updateError.message}`)
      }

      const { error: slaError } = await supabase
        .from('lead_sla_tracking')
        .insert({
          lead_id:     params.leadId,
          brokerage_id: params.brokerageId,
          sla_type:    'appointment',
          target_at:   params.startAt.toISOString(),
          created_at:  new Date().toISOString(),
        })

      if (slaError) {
        // Non-fatal: SLA tracking failure should not abort the booking
        console.error('[appointment-scheduler] Failed to insert lead_sla_tracking:', slaError.message)
      }
    }
  }

  // ── Step 5: Insert lifecycle_events ─────────────────────────────────────────
  const { error: leError } = await supabase
    .from('lifecycle_events')
    .insert({
      brokerage_id: params.brokerageId, // NOT NULL (pass 5): missing → the appointment event never landed
      entity_type: entityType,
      entity_id:   entityId,
      event_type:  KernelEvent.ISA_APPOINTMENT_SCHEDULED,
      metadata:    {
        calendarEventId: calendarEvent.id,
        startAt: params.startAt.toISOString(),
      },
      created_at: new Date().toISOString(),
    })

  if (leError) {
    console.error('[appointment-scheduler] Failed to insert lifecycle_event:', leError.message)
  }

  // ── Step 6: processKernelEvent ───────────────────────────────────────────────
  await processKernelEvent({
    event: KernelEvent.ISA_APPOINTMENT_SCHEDULED,
    brokerageId: params.brokerageId,
    entityType,
    entityId,
  })

  // ── Step 7: Return calendar_events.id ───────────────────────────────────────
  return calendarEvent.id
}
