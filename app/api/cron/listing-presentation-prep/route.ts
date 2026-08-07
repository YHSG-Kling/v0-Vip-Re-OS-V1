/**
 * GET /api/cron/listing-presentation-prep
 *
 * Daily cron — finds every LISTING APPOINTMENT scheduled inside the drip runway
 * and pre-builds the COMPLETE listing presentation (CMA + 3-price net sheet +
 * marketing plan + slide deck + listing-agreement packet) for the agent, which
 * also materializes + schedules the seller-facing pre-listing drip
 * (buildListingPresentation → materializePresentationSections →
 * planPresentationSections, the one timetable).
 *
 * THIS IS THE AUTONOMOUS TRIGGER. Nothing else has to run for a booked listing
 * appointment to end up with a complete, scheduled presentation: the chain
 * (listing-appt-prep enroll_drip) enriches it with chapter reels when it runs,
 * but it is not required for the presentation to exist or for the drip to be
 * on a timetable.
 *
 * WHY THE WINDOW IS THE RUNWAY, NOT 24 HOURS. This scanned `now → now+24h`,
 * which meant the presentation — and therefore the drip's whole schedule — was
 * created the day before the meeting. planPresentationSections spreads its
 * sections between NOW and (appointment − buffer), so building one day out left
 * seven seller touches to be crammed into roughly twelve hours: the drip
 * existed and had no runway to drip across. A listing appointment is booked at
 * least seven days out, so the scan reaches far enough ahead that the schedule
 * is laid down while there is still a window to spread it over.
 *
 * Idempotent: skips appointments that already have a listing_presentations row,
 * so re-scanning the same wide window every day builds each presentation once.
 *
 * Schedule (lib/kernel/cron-dispatch): "0 17 * * *" (12:00 ET / 17:00 UTC), and
 * "0 19 * * *" for ?phase=deliver.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}
 */

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { buildListingPresentation } from "@/lib/workflow/intelligence/listing-presentation-builder"
import { verifyCronAuth } from "@/lib/cron-auth"

/**
 * How far ahead a listing appointment is picked up for presentation prep.
 *
 * A listing appointment is booked at least SEVEN days out, and the pre-listing
 * drip runs from the moment the presentation is built until (appointment −
 * buffer). Fourteen days covers the seven-day minimum with room for an
 * appointment booked further out, and the build is idempotent per appointment,
 * so widening the window costs nothing beyond the first scan that sees each one.
 */
const PREP_LOOKAHEAD_DAYS = 14

/**
 * How many presentations one tick will BUILD. Skips are a single indexed read
 * and are not counted — only real builds, each of which runs a CMA. Appointments
 * are prepped soonest-first, so a tick that hits the ceiling defers the furthest
 * ones to tomorrow, when they are still inside the runway. (A SQL LIMIT would
 * not do: ordered by start_at the first rows are the already-built ones, so a
 * new booking further out would never be reached.)
 */
const MAX_BUILDS_PER_TICK = 25

export const dynamic = "force-dynamic"
export const maxDuration = 300

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

  // Find every listing consultation inside the drip runway. See the header: the
  // window has to be wide enough that planPresentationSections still has room to
  // spread the seller's sections between now and the appointment.
  const now = new Date().toISOString()
  const horizon = new Date(Date.now() + PREP_LOOKAHEAD_DAYS * 86_400_000).toISOString()

  // calendar_events replaced appointments — appointments was a writer-less legacy twin (burn-down round 4 repoint).
  // Mapping: scheduled_at→start_at, appointment_type→event_type ('listing_appointment' is the value
  // lib/application/listing-lifecycle.ts writes for listing consults; entity_id is the listing,
  // metadata carries contact_id + agent_id [a users.id], and the address lives on the listing row).
  const { data: appointments, error: apptErr } = await svc
    .from("calendar_events")
    .select("id, brokerage_id, entity_type, entity_id, start_at, event_type, metadata")
    .gte("start_at", now)
    .lte("start_at", horizon)
    .eq("event_type", "listing_appointment")
    .order("start_at", { ascending: true })
  // A refused read is a FAILED tick, not a quiet one. Reporting scanned:0 here
  // would read exactly like "no appointments booked".
  if (apptErr) {
    return NextResponse.json({ ok: false, error: apptErr.message }, { status: 500 })
  }

  if (!appointments || appointments.length === 0) {
    return NextResponse.json({ scanned: 0, built: 0, skipped: 0, deferred: 0 })
  }

  let built = 0
  let skipped = 0
  let deferred = 0
  const errors: Array<{ appointmentId: string; error: string }> = []

  for (const appt of appointments) {
    const apptAny = appt as any

    if (built >= MAX_BUILDS_PER_TICK) { deferred++; continue }

    // Idempotency — skip if a presentation already exists for this appointment.
    // An unreadable row is NOT treated as absent: building on a failed read
    // would produce a second presentation (and a second drip) for one seller.
    const { data: existing, error: existErr } = await svc
      .from("listing_presentations")
      .select("id")
      .eq("appointment_id", appt.id)
      .maybeSingle()
    if (existErr) {
      errors.push({ appointmentId: appt.id, error: `idempotency read failed: ${existErr.message}` })
      continue
    }
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
    lookahead_days: PREP_LOOKAHEAD_DAYS,
    built,
    skipped,
    // Over the per-tick build ceiling — picked up by tomorrow's tick, still
    // inside the runway. Reported so a ceiling that is too low is visible.
    deferred,
    errors: errors.length > 0 ? errors : undefined,
  })
}
