"use server"

/**
 * Thin server action returning the agent's upcoming listing presentations
 * (built by the Sprint J cron). Used by the PresentationReadyBanner widget
 * on the agent dashboard.
 *
 * Filter rules:
 *   - Only the authenticated agent's own presentations
 *   - status = 'ready'
 *   - appointment_at within the next 7 days OR null (just-built, no appt)
 */

import { createClient } from "@/lib/supabase/server"

export interface UpcomingPresentation {
  id:               string
  propertyAddress:  string | null
  appointmentAt:    string | null
  cmaLow:           number
  cmaMid:           number
  cmaHigh:          number
  state:            string | null
  packetDocumentId: string | null
}

export async function loadUpcomingPresentations(): Promise<UpcomingPresentation[]> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const sevenDaysFromNow = new Date(Date.now() + 7 * 86_400_000).toISOString()

  const { data } = await supabase
    .from("listing_presentations")
    .select("id, property_address, appointment_at, cma_low_value, cma_mid_value, cma_high_value, state, packet_document_id, status")
    .eq("agent_user_id", user.id)
    .eq("status", "ready")
    .or(`appointment_at.is.null,appointment_at.lte.${sevenDaysFromNow}`)
    .order("appointment_at", { ascending: true, nullsFirst: false })
    .limit(10)

  return (data ?? []).map(row => ({
    id:               row.id,
    propertyAddress:  row.property_address,
    appointmentAt:    row.appointment_at,
    cmaLow:           Number(row.cma_low_value  ?? 0),
    cmaMid:           Number(row.cma_mid_value  ?? 0),
    cmaHigh:          Number(row.cma_high_value ?? 0),
    state:            row.state,
    packetDocumentId: row.packet_document_id,
  }))
}
