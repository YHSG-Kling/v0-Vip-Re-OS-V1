// NOT a server-action module (2026-09-03, lane R3-A; template
// lib/behavior-learning/preference-updater.ts:1-9). The module-level "use server"
// that stood here published scheduleISAAppointment({ brokerageId, agentId, … })
// as a public HTTP door with no gate: a service client INSERTING a calendar
// event and emitting a kernel event under a caller-supplied brokerageId —
// section 4's named IDOR shape, on a write. Every caller is in-process server
// code (re-verified 2026-09-03):
//   · app/actions/ai-isa/schedule-appointment.ts:4  ("use server" action)
//   · lib/ai-isa/book-seller-appointment.ts:31      (server lib)
// so the directive published nothing anyone needed. `server-only` makes a future
// client import fail at build time instead of bundling the service credential.
// brokerageId / agentId are now an IN-PROCESS CONTRACT: with the door closed,
// the server caller that supplies them is the gate.
import "server-only"

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

  // ── CONVERSION FINALITY — RE-ROUTE the booking to the contact ──────────────
  //
  // "once a lead converts, all communication/updates or schedules are to cease
  // and only contacts get the actions." A SCHEDULE is squarely in that list, and
  // this function's only guard was `lifecycle_state === 'representation'` — a
  // value NOTHING in the tree writes. So a converted lead booked here inserted a
  // lead-keyed calendar_events row, a lead-keyed ai_isa_activities row, a
  // lead_sla_tracking row, and ADVANCED leads.lifecycle_state.
  //
  // An appointment is real work a human is expecting, so this RE-ROUTES rather
  // than refuses: the booking proceeds against the CONTACT the lead became.
  // Everything downstream (entityType, the SLA row, the lifecycle advance) then
  // keys on the contact, because `leadId` is cleared. Fails closed — an
  // unreadable lead throws rather than booking against an unknown entity.
  let leadId = params.leadId ?? null
  let contactId = params.contactId ?? null
  if (leadId) {
    const { assertLeadNotConverted } = await import('@/lib/contact-promotion/conversion-finality')
    const verdict = await assertLeadNotConverted(supabase, leadId)
    if (!verdict.allowed) {
      if (!verdict.contactId) {
        throw new Error(`Cannot schedule ISA appointment: ${verdict.reason}`)
      }
      console.log(
        `[appointment-scheduler] lead ${leadId} converted — booking re-routed to contact ${verdict.contactId}`,
      )
      contactId = verdict.contactId
      leadId = null
    }
  }

  const entityType = leadId ? 'lead' : 'contact'
  const entityId   = leadId ?? contactId!

  // ── Zoom branch (additive, round 39) — never blocks the booking ────────────
  let zoomLocation: string | null = null
  let zoomMetadata: Record<string, unknown> = {}
  if (params.meetingMode === 'zoom') {
    try {
      const { ensureZoomMeetingForAppointment } = await import('@/lib/connections/zoom')
      const { connectionScopeForUserType } = await import('@/lib/connections/field-spec')
      // platform_role rides along (§4): a platform-staff booker resolves to the
      // platform host scope only through BOTH identity columns.
      const { data: booker } = await supabase
        .from('users')
        .select('user_type, platform_role, team_id, brokerage_id')
        .eq('id', params.agentId)
        .maybeSingle()
      const scope = connectionScopeForUserType(
        (booker?.user_type as string) ?? '',
        (booker?.platform_role as string | null) ?? null,
      ).scope
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
  if (leadId) {
    const { data: lead, error } = await supabase
      .from('leads')
      .select('lifecycle_state')
      .eq('id', leadId)
      .single()

    if (error || !lead) throw new Error(`Lead not found: ${leadId}`)
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
      lead_id:             leadId,
      contact_id:          contactId,
      activity_type:       'appointment_set',
      qualifying_response: { calendar_event_id: calendarEvent.id },
    })

  if (activityError) {
    throw new Error(`Failed to log ISA activity: ${activityError.message}`)
  }

  // ── Step 4: Advance lead lifecycle_state → appointment ─────────────────────
  // `leadId` (not params.leadId): a converted lead was re-routed to its contact
  // above and cleared here, so none of this lead-keyed block — the lifecycle
  // advance or the lead_sla_tracking row — runs for a converted person.
  if (leadId) {
    const { data: lead } = await supabase
      .from('leads')
      .select('lifecycle_state')
      .eq('id', leadId)
      .single()

    if (lead) {
      await assertValidTransition(lead.lifecycle_state, 'appointment', leadId)

      const { error: updateError } = await supabase
        .from('leads')
        .update({
          lifecycle_state: 'appointment',
          updated_at: new Date().toISOString(),
        })
        .eq('id', leadId)

      if (updateError) {
        throw new Error(`Failed to update lead lifecycle_state: ${updateError.message}`)
      }

      const { error: slaError } = await supabase
        .from('lead_sla_tracking')
        .insert({
          lead_id:     leadId,
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
