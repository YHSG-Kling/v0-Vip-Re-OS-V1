/**
 * GET /api/cron/buyer-consultation-prep
 *
 * Daily cron — the buyer twin of /api/cron/listing-presentation-prep: finds
 * every BUYER CONSULTATION booked inside the drip runway and pre-builds the
 * buyer-consultation deck (listing_presentations row with
 * presentation_type='buyer_consultation' + the six BuyerConsultationSlide
 * sections on the drip's one timetable, each rendered by
 * lib/buyer-consultation/consultation-render).
 *
 * THIS IS THE AUTONOMOUS TRIGGER — the "fire on a buyer_consultation
 * appointment being booked" dispatch point. Appointment writers are several
 * (quick-create panel, intent router, ISA booking) and none has a single
 * post-insert hook, so the composer keys off appointment start_at exactly the
 * way listing presentations do: a wide daily scan of calendar_events,
 * idempotent per appointment (one deck per appointment_id), so the deck exists
 * with runway for planPresentationSections to spread the slides across.
 *
 * THE ROW SHAPE SCANNED FOR is the one the appointment autopilot already
 * reads (lib/kernel/appointment-noshow-autopilot.ts:292-301): client-facing
 * consultations carry entity_type='contact', entity_id=<contacts.id>,
 * event_type='buyer_consultation', agent_user_id (USERS class). The live
 * calendar_events table held zero rows at build time (verified 2026-09-01), so
 * that reader — not row archaeology — is the shape authority.
 *
 * Delivery rides the existing drip unchanged: Gate 2
 * (delivery_approved_at, human release) → /api/cron/presentation-section-drip
 * → deliverDueSections → ONE reel per email via dispatchEmail.
 *
 * Schedule (lib/kernel/cron-dispatch): "30 17 * * *" — half an hour after the
 * listing prep tick, same daily cadence, staggered so the two prep scans do
 * not contend.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}
 */
import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { composeBuyerConsultationDeck } from "@/lib/buyer-consultation/consultation-prep"
import { verifyCronAuth } from "@/lib/cron-auth"

/** Same runway reasoning as listing-presentation-prep: the drip needs room
 *  between now and the appointment to spread six slides across. */
const PREP_LOOKAHEAD_DAYS = 14

/** Builds per tick — each build runs narration + six render enqueues. */
const MAX_BUILDS_PER_TICK = 25

export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function GET(req: NextRequest): Promise<NextResponse> {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const svc = createServiceClient()
  const now = new Date().toISOString()
  const horizon = new Date(Date.now() + PREP_LOOKAHEAD_DAYS * 86_400_000).toISOString()

  const { data: appointments, error: apptErr } = await svc
    .from("calendar_events")
    .select("id, brokerage_id, entity_type, entity_id, start_at, event_type, metadata, agent_user_id")
    .gte("start_at", now)
    .lte("start_at", horizon)
    .eq("event_type", "buyer_consultation")
    .order("start_at", { ascending: true })
  // A refused read is a FAILED tick, not a quiet one — scanned:0 here would
  // read exactly like "no consultations booked".
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
    const a = appt as any
    if (built >= MAX_BUILDS_PER_TICK) { deferred++; continue }
    if (!a.brokerage_id) { skipped++; continue }

    // The buyer. entity_type='contact' is the appointment convention; fall back
    // to metadata.contact_id for writers that anchor the event elsewhere.
    const contactId: string | null =
      (a.entity_type === "contact" ? a.entity_id : null) ?? a.metadata?.contact_id ?? null
    if (!contactId) { skipped++; continue }

    const res = await composeBuyerConsultationDeck(
      {
        brokerageId:   a.brokerage_id,
        agentUserId:   a.agent_user_id ?? null,
        contactId,
        appointmentId: a.id,
        appointmentAt: a.start_at ?? null,
      },
      svc,
    )
    if (!res.ok) {
      // An honest skip (no state on file) and a refusal (read failed) both land
      // here — the reason travels so a skipped buyer is a fact, not an absence.
      errors.push({ appointmentId: a.id, error: res.skipped })
      continue
    }
    if (res.created) built++
    else skipped++ // deck already exists for this appointment (idempotent)
  }

  return NextResponse.json({
    scanned: appointments.length,
    lookahead_days: PREP_LOOKAHEAD_DAYS,
    built,
    skipped,
    deferred,
    errors: errors.length > 0 ? errors : undefined,
  })
}
