/**
 * GET /api/cron/listing-presentation-prep
 *
 * Daily cron — finds every LISTING APPOINTMENT scheduled in the next 24 hours
 * and pre-builds a complete listing presentation (CMA + 3-price net sheet +
 * marketing plan + slide deck + listing-agreement packet) for the agent.
 *
 * Idempotent: skips appointments that already have a listing_presentations row.
 *
 * Schedule (vercel.json): "0 17 * * *"  (12:00 ET / 17:00 UTC, the day before
 * morning appointments → agent has it overnight to review before tomorrow's meeting)
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}
 */

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { buildListingPresentation } from "@/lib/workflow/intelligence/listing-presentation-builder"
import { verifyCronAuth } from "@/lib/cron-auth"

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const svc = createServiceClient()

  // Find appointments in the next 24h marked as a listing consultation
  const now = new Date().toISOString()
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

  // appointments table is conventional but field names vary — pull liberally
  const { data: appointments } = await svc
    .from("appointments")
    .select("id, agent_id, contact_id, scheduled_at, appointment_type, property_address, property_state, property_city, property_zip, brokerage_id")
    .gte("scheduled_at", now)
    .lte("scheduled_at", tomorrow)
    .or("appointment_type.eq.listing_consultation,appointment_type.eq.listing_appointment,appointment_type.ilike.%listing%")

  if (!appointments || appointments.length === 0) {
    return NextResponse.json({ scanned: 0, built: 0, skipped: 0 })
  }

  let built = 0
  let skipped = 0
  const errors: Array<{ appointmentId: string; error: string }> = []

  for (const appt of appointments) {
    const apptAny = appt as any

    // Idempotency — skip if a presentation already exists for this appointment
    const { data: existing } = await svc
      .from("listing_presentations")
      .select("id")
      .eq("appointment_id", appt.id)
      .maybeSingle()
    if (existing) {
      skipped++
      continue
    }

    // Need a property address + state to run the CMA
    const propertyAddress = apptAny.property_address
    const state = apptAny.property_state
    if (!propertyAddress || !state) {
      skipped++
      continue
    }

    // Resolve agent user_id (appointments.agent_id is agents.id)
    let agentUserId: string | null = null
    if (apptAny.agent_id) {
      const { data: agentRow } = await svc
        .from("agents").select("user_id").eq("id", apptAny.agent_id).maybeSingle()
      agentUserId = agentRow?.user_id ?? null
    }

    const result = await buildListingPresentation({
      brokerageId:     apptAny.brokerage_id,
      agentUserId,
      contactId:       apptAny.contact_id ?? null,
      appointmentId:   appt.id,
      appointmentAt:   apptAny.scheduled_at,
      propertyAddress,
      state,
      city:            apptAny.property_city ?? null,
      zip:             apptAny.property_zip ?? null,
    })

    if (result.success) built++
    else errors.push({ appointmentId: appt.id, error: result.error ?? "unknown" })
  }

  return NextResponse.json({
    scanned: appointments.length,
    built,
    skipped,
    errors: errors.length > 0 ? errors : undefined,
  })
}
