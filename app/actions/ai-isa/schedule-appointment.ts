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
}

export type ScheduleAppointmentResult =
  | { success: true; calendarEventId: string }
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
    .from('user_profiles')
    .select('id, brokerage_id, user_type')
    .eq('user_id', user.id)
    .single()

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
    })

    return { success: true, calendarEventId }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: message }
  }
}
