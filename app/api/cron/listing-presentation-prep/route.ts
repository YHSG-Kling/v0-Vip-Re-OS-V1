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

  // ?phase=deliver (19:00, two hours after prep — renders are done): completed
  // pitch reels land with THEIR agent ahead of tomorrow's appointment.
  if (new URL(req.url).searchParams.get("phase") === "deliver") {
    const { deliverListingPitchReels } = await import("@/lib/video/listing-pitch-reel")
    const delivery = await deliverListingPitchReels(svc)
    return NextResponse.json({ phase: "deliver", ...delivery })
  }

  // Find appointments in the next 24h marked as a listing consultation
  const now = new Date().toISOString()
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

  // calendar_events replaced appointments — appointments was a writer-less legacy twin (burn-down round 4 repoint).
  // Mapping: scheduled_at→start_at, appointment_type→event_type ('listing_appointment' is the value
  // lib/application/listing-lifecycle.ts writes for listing consults; entity_id is the listing,
  // metadata carries contact_id + agent_id [a users.id], and the address lives on the listing row).
  const { data: appointments } = await svc
    .from("calendar_events")
    .select("id, brokerage_id, entity_type, entity_id, start_at, event_type, metadata")
    .gte("start_at", now)
    .lte("start_at", tomorrow)
    .eq("event_type", "listing_appointment")

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

    // Need a property address + state to run the CMA — listing_appointment events carry
    // the listing as entity_id; the address lives on the listings row.
    let propertyAddress: string | null = null
    let state: string | null = null
    let city: string | null = null
    let zip: string | null = null
    if (apptAny.entity_type === "listing" && apptAny.entity_id) {
      const { data: listing } = await svc
        .from("listings").select("address, city, state, zip").eq("id", apptAny.entity_id).maybeSingle()
      propertyAddress = (listing as any)?.address ?? null
      state = (listing as any)?.state ?? null
      city = (listing as any)?.city ?? null
      zip = (listing as any)?.zip ?? null
    }
    if (!propertyAddress || !state) {
      skipped++
      continue
    }

    // metadata.agent_id is already the auth users.id (see scheduleListingAppointmentService)
    const agentUserId: string | null = apptAny.metadata?.agent_id ?? null

    const result = await buildListingPresentation({
      brokerageId:     apptAny.brokerage_id,
      agentUserId,
      contactId:       apptAny.metadata?.contact_id ?? null,
      appointmentId:   appt.id,
      appointmentAt:   apptAny.start_at,
      // The listing this appointment is on — carries the seller's recorded
      // upgrades into the CMA. Only set when the appointment really is a
      // listing appointment (the same guard the address read above uses).
      listingId:       apptAny.entity_type === "listing" ? (apptAny.entity_id ?? null) : null,
      propertyAddress,
      state,
      city,
      zip,
    })

    if (result.success) {
      built++
      // The showstopper: the pitch VIDEO — the agent + the team's measured
      // proof, on camera, for the seller's kitchen table. Best-effort; a
      // render-queue hiccup never blocks the deck/CMA prep.
      try {
        const { queueListingPitchReel } = await import("@/lib/video/listing-pitch-reel")
        await queueListingPitchReel(svc, {
          brokerageId: apptAny.brokerage_id, agentUserId,
          appointmentId: appt.id, address: propertyAddress,
        })
      } catch { /* pitch reel is additive */ }
    }
    else errors.push({ appointmentId: appt.id, error: result.error ?? "unknown" })
  }

  return NextResponse.json({
    scanned: appointments.length,
    built,
    skipped,
    errors: errors.length > 0 ? errors : undefined,
  })
}
