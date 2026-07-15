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
  agentId: string
  startAt: Date
  endAt: Date
  timezoneName: string
  location?: string
  notes?: string
}): Promise<string> {
  if (!params.leadId && !params.contactId) {
    throw new Error('scheduleISAAppointment requires either leadId or contactId')
  }

  const supabase = createServiceClient()
  const entityType = params.leadId ? 'lead' : 'contact'
  const entityId   = params.leadId ?? params.contactId!

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
      location:            params.location ?? null,
      is_system_generated: true,
      status:              'scheduled',
      metadata:            { notes: params.notes ?? null },
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
