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
 * IT SERVES BOTH ORIGINS. An agent booking a consult on a listing, and a
 * home-value SELLER booking their own appointment from the report page or the
 * portal, write the same event_type — and the seller is the one this lane exists
 * for. The subject property is therefore resolved from whichever table that
 * origin records it in (resolveSubjectProperty at the foot of this file); it used
 * to be read only from `listings`, which a prospect does not have, so every
 * home-value seller was counted as `skipped` and got no presentation, no section
 * drip and no chapter reels.
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
import {
  LISTING_APPOINTMENT_BOOKING_EVENT_TYPES,
  decideSafetyNetAction,
  prepRunStatusesForBooking,
  resolveBookingPrepContext,
  startListingPresentationPrepFromBooking,
} from "@/lib/listing-presentation/booking-prep"

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

  // Find every listing appointment inside the drip runway. See the header: the
  // window has to be wide enough that planPresentationSections still has room to
  // spread the seller's sections between now and the appointment.
  const now = new Date().toISOString()
  const horizon = new Date(Date.now() + PREP_LOOKAHEAD_DAYS * 86_400_000).toISOString()

  // THE SAFETY NET (lane 87B). The prep now STARTS FROM THE BOOKING: every
  // listing-appointment booking path hands its calendar_events row to
  // lib/listing-presentation/booking-prep.ts::startListingPresentationPrepFromBooking
  // (the agent calendar, the listing consult, the AI-ISA/voice booking at the
  // agent's confirm, the seller's own self-booking from the report page or the
  // portal). This scan catches the bookings that missed that event, and reads the
  // ONE spelling of a listing appointment ("listing_appointment" —
  // LISTING_APPOINTMENT_BOOKING_EVENT_TYPES; lane 87B2 merged the calendar's
  // "listing_consultation" and the ISA milestone's "isa_appointment" onto it).
  // The seller check, the tenant (the booking row's own brokerage_id), the
  // seller's property and the agent's users.id are resolved by the SAME core the
  // booking paths use — never a second resolver here.
  const { data: appointments, error: apptErr } = await svc
    .from("calendar_events")
    .select("id, brokerage_id, start_at, event_type")
    .gte("start_at", now)
    .lte("start_at", horizon)
    .in("event_type", [...LISTING_APPOINTMENT_BOOKING_EVENT_TYPES])
    .order("start_at", { ascending: true })
  // A refused read is a FAILED tick, not a quiet one. Reporting scanned:0 here
  // would read exactly like "no appointments booked".
  if (apptErr) {
    return NextResponse.json({ ok: false, error: apptErr.message }, { status: 500 })
  }

  if (!appointments || appointments.length === 0) {
    return NextResponse.json({ scanned: 0, built: 0, started: 0, in_progress: 0, skipped: 0, refused: 0, deferred: 0 })
  }

  let built = 0
  let started = 0
  let inProgress = 0
  let skipped = 0
  let refused = 0
  let deferred = 0
  const errors: Array<{ appointmentId: string; error: string }> = []

  for (const appt of appointments) {
    const apptAny = appt as { id: string; brokerage_id: string | null; start_at: string }
    if (!apptAny.brokerage_id) { refused++; continue }

    if (built + started >= MAX_BUILDS_PER_TICK) { deferred++; continue }

    // Idempotency — a presentation for this appointment already exists.
    // An unreadable row is NOT treated as absent: building on a failed read
    // would produce a second presentation (and a second drip) for one seller.
    const { data: existing, error: existErr } = await svc
      .from("listing_presentations")
      .select("id")
      .eq("appointment_id", appt.id)
      .eq("brokerage_id", apptAny.brokerage_id)
      .maybeSingle()
    if (existErr) {
      errors.push({ appointmentId: appt.id, error: `idempotency read failed: ${existErr.message}` })
      continue
    }
    const runs = existing
      ? { ok: true as const, statuses: [] as string[] }
      : await prepRunStatusesForBooking(svc, { brokerageId: apptAny.brokerage_id, calendarEventId: appt.id })
    if (!runs.ok) {
      errors.push({ appointmentId: appt.id, error: `prep run read failed: ${runs.error}` })
      continue
    }
    const action = decideSafetyNetAction({ presentationExists: !!existing, runStatuses: runs.statuses })
    if (action === "done") { skipped++; continue }
    if (action === "in_progress") { inProgress++; continue }

    if (action === "start_prep") {
      // The booking missed its event — start it exactly as the booking would have.
      const r = await startListingPresentationPrepFromBooking(svc, { calendarEventId: appt.id, origin: "cron_safety_net" })
      if (r.status === "started" || r.status === "deduped") started++
      else if (r.status === "refused") refused++
      else if (r.status === "deferred") deferred++
      else if (r.status === "skipped") skipped++
      else errors.push({ appointmentId: appt.id, error: "reason" in r ? r.reason : "prep start failed" })
      continue
    }

    // action === "build_presentation": the prep run ended without a deck. Build
    // the presentation directly (the net's net), for the SAME seller and property
    // the core resolves — a non-seller booking is refused here too.
    const resolved = await resolveBookingPrepContext(svc, { calendarEventId: appt.id })
    if (!resolved.ok) {
      if (resolved.outcome === "error") errors.push({ appointmentId: appt.id, error: resolved.reason })
      else if (resolved.outcome === "refused") refused++
      else if (resolved.outcome === "deferred") deferred++
      else skipped++
      continue
    }
    const ctx = resolved.context
    // Honest skip: nothing on file names this property, or names it without a
    // state (listing_presentations.state is NOT NULL and the CMA is state-scoped).
    // Nothing is invented to get past this line.
    if (!ctx.property.propertyAddress || !ctx.property.state) { skipped++; continue }

    const result = await buildListingPresentation({
      brokerageId:     ctx.brokerageId,
      agentUserId:     ctx.agentUserId,
      contactId:       ctx.contactId,
      appointmentId:   appt.id,
      appointmentAt:   ctx.startAt,
      listingId:       ctx.property.listingId,
      propertyAddress: ctx.property.propertyAddress,
      state:           ctx.property.state,
      city:            ctx.property.city,
      zip:             ctx.property.zip,
      bedrooms:        ctx.property.bedrooms,
      bathrooms:       ctx.property.bathrooms,
      sqft:            ctx.property.sqft,
      yearBuilt:       ctx.property.yearBuilt,
    })

    if (result.success) {
      built++
      // The showstopper: the pitch VIDEO — the agent + the team's measured
      // proof, on camera, for the seller's kitchen table. Best-effort; a
      // render-queue hiccup never blocks the deck/CMA prep.
      try {
        const { queueListingPitchReel } = await import("@/lib/video/listing-pitch-reel")
        await queueListingPitchReel(svc, {
          brokerageId: ctx.brokerageId, agentUserId: ctx.agentUserId,
          appointmentId: appt.id, address: ctx.property.propertyAddress,
          // The seller's contact id — resolves the seller's own language for the
          // pitch narration (owner ruling, wave 51/52).
          contactId: ctx.contactId,
        })
      } catch { /* pitch reel is additive */ }
    }
    else errors.push({ appointmentId: appt.id, error: result.error ?? "unknown" })
  }

  return NextResponse.json({
    scanned: appointments.length,
    lookahead_days: PREP_LOOKAHEAD_DAYS,
    // Prep runs the net started for bookings that missed their event.
    started,
    // Presentations the net built directly (the prep run ended without one).
    built,
    in_progress: inProgress,
    skipped,
    // Not a seller / not a listing appointment / not in a tenant — never prepped.
    refused,
    // Over the per-tick build ceiling — picked up by tomorrow's tick, still
    // inside the runway. Reported so a ceiling that is too low is visible.
    deferred,
    errors: errors.length > 0 ? errors : undefined,
  })
}

// SUBJECT PROPERTY / AGENT RESOLUTION — moved (lane 87B) to the ONE core every
// booking path uses: lib/listing-presentation/booking-prep.ts
// (resolveBookingPrepContext → pickSellerProperty / resolveBookingAgentUserId).
// The listing → valuation_request order this file carried is preserved there, with
// the seller check in front of it and the caller's captured property, the booking's
// own address and the seller's home address added behind it.
