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
  // Mapping: scheduled_at→start_at, appointment_type→event_type.
  //
  // TWO WRITERS put 'listing_appointment' here and they do NOT shape the row the same way:
  //
  //   lib/application/listing-lifecycle.ts  (agent books a consult on an existing listing)
  //     entity_type='listing', entity_id=listings.id, metadata.agent_id = a USERS id,
  //     address on the listings row.
  //
  //   app/actions/home-value.ts             (a home-value SELLER books their own appointment)
  //     entity_type='agent',   entity_id=agents.id,   metadata.agent_id = an AGENTS id,
  //     and there is NO listings row at all — this seller is a prospect. Their subject
  //     property lives on valuation_requests, joined by metadata.contact_id.
  //
  // agent_user_id is the one column BOTH writers fill with a users.id, so it — not
  // metadata.agent_id — is what the builder's agentUserId is resolved from below.
  const { data: appointments, error: apptErr } = await svc
    .from("calendar_events")
    .select("id, brokerage_id, entity_type, entity_id, start_at, event_type, metadata, agent_user_id")
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

    // The subject property. Resolved from whichever table this appointment's
    // origin actually records it in — see resolveSubjectProperty. A prospect who
    // came through /home-value has no listings row, and reading only listings is
    // what used to drop every one of them here.
    const contactId: string | null = apptAny.metadata?.contact_id ?? null
    const subject = await resolveSubjectProperty(svc, {
      brokerageId: apptAny.brokerage_id,
      entityType:  apptAny.entity_type,
      entityId:    apptAny.entity_id,
      contactId,
      // The address the seller booked ABOUT, when the booking recorded one. Used
      // to pick the right valuation_requests row for a homeowner who has asked
      // about more than one property — never as the address itself, because it
      // carries no state and the CMA cannot run without one.
      bookedAddress: typeof apptAny.metadata?.property_address === "string"
        ? apptAny.metadata.property_address
        : null,
    })
    // A refused read is not an absent property. Treating it as "no address" would
    // silently skip a seller whose row is right there, so it is reported instead.
    if (subject.error) {
      errors.push({ appointmentId: appt.id, error: `subject property lookup failed: ${subject.error}` })
      continue
    }
    // Honest skip: nothing on file names this property, or names it without a
    // state (listing_presentations.state is NOT NULL and the CMA is state-scoped).
    // Nothing is invented to get past this line.
    if (!subject.propertyAddress || !subject.state) {
      skipped++
      continue
    }

    // The USERS id. agent_user_id is the column both writers fill with one;
    // metadata.agent_id is a users.id from the listing lane and an AGENTS id from
    // the home-value lane, so it is RESOLVED, never substituted. Passing an
    // agents.id through would violate listing_presentations.agent_user_id's FK to
    // users(id) and fail the whole build.
    const agentUserId: string | null = await resolveAppointmentAgentUserId(svc, {
      agentUserIdColumn: apptAny.agent_user_id ?? null,
      metadataAgentId:   apptAny.metadata?.agent_id ?? null,
    })

    const result = await buildListingPresentation({
      brokerageId:     apptAny.brokerage_id,
      agentUserId,
      contactId,
      appointmentId:   appt.id,
      appointmentAt:   apptAny.start_at,
      // The listing this appointment is on — carries the seller's recorded
      // upgrades into the CMA. Null for a home-value prospect, who has none.
      listingId:       subject.listingId,
      propertyAddress: subject.propertyAddress,
      state:           subject.state,
      city:            subject.city,
      zip:             subject.zip,
      // Real, seller-reported property facts when the home-value form captured
      // them — they sharpen the CMA. Absent for the listings path, which lets
      // the builder's enrichment chain fill them in as before.
      bedrooms:        subject.bedrooms,
      bathrooms:       subject.bathrooms,
      sqft:            subject.sqft,
      yearBuilt:       subject.yearBuilt,
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
          appointmentId: appt.id, address: subject.propertyAddress,
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

// ───────────────────────────────────────────────────────────────────────────
// SUBJECT PROPERTY RESOLUTION
//
// The CMA needs a real address and a real state. Which table holds them depends
// on where the appointment came from, and there are exactly two origins (see the
// note on the scan query above):
//
//   1. a listing consult   → listings.address/city/state/zip, via entity_id.
//   2. a home-value seller → they are a PROSPECT. No listings row exists, so
//      reading only listings meant `!propertyAddress` was true for every one of
//      them and they were counted as `skipped`. No presentation, no section
//      drip, no chapter reels — for exactly the sellers this lane exists to
//      serve. Their property is on valuation_requests, keyed by contact_id.
//
// home_value_estimates also carries a property_address, but it has no state
// column and every estimate hangs off a valuation_request (valuation_request_id
// is NOT NULL, and valuation_requests.property_address is NOT NULL), so it can
// never resolve a case valuation_requests cannot. It is deliberately not read.
// ───────────────────────────────────────────────────────────────────────────

interface SubjectProperty {
  propertyAddress: string | null
  state:           string | null
  city:            string | null
  zip:             string | null
  /** Only ever a real listings.id — null for a prospect, who has no listing. */
  listingId:       string | null
  bedrooms:        number | null
  bathrooms:       number | null
  sqft:            number | null
  yearBuilt:       number | null
  /** Set when a read was REFUSED — distinct from "this seller has no property on file". */
  error?:          string
}

const NO_SUBJECT: SubjectProperty = {
  propertyAddress: null, state: null, city: null, zip: null,
  listingId: null, bedrooms: null, bathrooms: null, sqft: null, yearBuilt: null,
}

/** Loose address comparison for picking WHICH valuation_request — punctuation and
 *  casing differ between what the seller typed and what the booking recorded. */
function addressKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

async function resolveSubjectProperty(
  svc: ReturnType<typeof createServiceClient>,
  args: {
    brokerageId: string
    entityType: string | null
    entityId: string | null
    contactId: string | null
    bookedAddress: string | null
  },
): Promise<SubjectProperty> {
  // ── 1. The listing path, unchanged. ──────────────────────────────────────
  if (args.entityType === "listing" && args.entityId) {
    const { data: listing, error } = await svc
      .from("listings")
      .select("address, city, state, zip")
      .eq("id", args.entityId)
      .maybeSingle()
    if (error) return { ...NO_SUBJECT, error: `listings read: ${error.message}` }
    if (listing) {
      return {
        ...NO_SUBJECT,
        propertyAddress: (listing as any).address ?? null,
        state:           (listing as any).state   ?? null,
        city:            (listing as any).city    ?? null,
        zip:             (listing as any).zip     ?? null,
        listingId:       args.entityId,
      }
    }
    // The event points at a listing that is gone. Fall through to the contact's
    // valuation request rather than dropping the appointment silently.
  }

  // ── 2. The home-value path. ──────────────────────────────────────────────
  if (!args.contactId) return NO_SUBJECT

  const { data: requests, error } = await svc
    .from("valuation_requests")
    .select("property_address, city, state, zip_code, bedrooms, bathrooms, square_feet, year_built, submitted_at")
    .eq("contact_id", args.contactId)
    // Tenant anchor: the service client bypasses RLS, so the brokerage is explicit.
    .eq("brokerage_id", args.brokerageId)
    .order("submitted_at", { ascending: false })
    .limit(10)
  if (error) return { ...NO_SUBJECT, error: `valuation_requests read: ${error.message}` }
  if (!requests || requests.length === 0) return NO_SUBJECT

  // A homeowner may have asked about more than one address. Prefer the request
  // for the property the appointment was actually booked about; otherwise the
  // most recent one they submitted.
  let chosen: any = requests[0]
  if (args.bookedAddress) {
    const want = addressKey(args.bookedAddress)
    const match = requests.find(
      (r: any) => typeof r.property_address === "string" && addressKey(r.property_address) === want,
    )
    if (match) chosen = match
  }

  return {
    propertyAddress: chosen.property_address ?? null,
    state:           chosen.state            ?? null,
    city:            chosen.city             ?? null,
    zip:             chosen.zip_code         ?? null,
    // A prospect has no listing. Never point listingId at the agents.id in
    // entity_id — different id space, and it would poison the upgrade lookup.
    listingId:       null,
    bedrooms:        typeof chosen.bedrooms     === "number" ? chosen.bedrooms     : null,
    bathrooms:       typeof chosen.bathrooms    === "number" ? chosen.bathrooms    : null,
    sqft:            typeof chosen.square_feet  === "number" ? chosen.square_feet  : null,
    yearBuilt:       typeof chosen.year_built   === "number" ? chosen.year_built   : null,
  }
}

/**
 * The appointment's agent as a USERS id.
 *
 * `agent_user_id` is the column both writers fill with one, so it is preferred.
 * `metadata.agent_id` is only consulted when that column is empty, and then it is
 * RESOLVED rather than trusted: it holds a users.id on listing-lifecycle events
 * and an agents.id on home-value ones, and handing an agents.id to the builder
 * violates listing_presentations.agent_user_id → users(id) and fails the build.
 */
async function resolveAppointmentAgentUserId(
  svc: ReturnType<typeof createServiceClient>,
  args: { agentUserIdColumn: string | null; metadataAgentId: string | null },
): Promise<string | null> {
  if (args.agentUserIdColumn) return args.agentUserIdColumn
  if (!args.metadataAgentId) return null

  // Is it already a users.id?
  const { data: user, error: userErr } = await svc
    .from("users").select("id").eq("id", args.metadataAgentId).maybeSingle()
  if (userErr) {
    console.error(`[listing-presentation-prep] users lookup for ${args.metadataAgentId} refused: ${userErr.message}`)
    return null
  }
  if (user) return args.metadataAgentId

  // Then it is an agents.id — map it to the users.id it belongs to.
  const { resolveAgentRecordToUserId } = await import("@/lib/kernel/agent-identity-resolver")
  return await resolveAgentRecordToUserId(args.metadataAgentId)
}
