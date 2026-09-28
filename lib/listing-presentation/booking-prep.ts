/**
 * lib/listing-presentation/booking-prep.ts — THE LISTING-APPOINTMENT BOOKING
 * STARTS THE SELLER'S LISTING-PRESENTATION PREP (wave 87, lane 87B).
 *
 * Owner, verbatim (2026-09-28): "listing presentation prep which inlcudes the cma
 * needs to be for a seller as this is started from the listing appointmtent
 * booking."
 *
 * WHAT WAS WRONG. The prep (CMA → presentation → chapter reels → drip → kit) had
 * FIVE starters and they disagreed about what they were starting:
 *   · the agent calendar (app/actions/ai-calendar-management.ts createAppointment)
 *     and the listing consult (app/actions/listing-lifecycle.ts) went through
 *     triggerChainsForEvent — a SESSION door — with a property parsed ad hoc and
 *     no check that the contact was a seller at all (a buyer's "consultation"
 *     prepped a CMA of the buyer's typed-in location);
 *   · the AI-ISA seller milestone (lib/ai-isa/book-seller-appointment.ts) called
 *     startRun directly, keyed on its own calendar row;
 *   · the AI-ISA / voice live booking (lib/ai-isa/listing-appointment.ts
 *     bookListingAppointment → confirmListingAppointment) started NOTHING — its
 *     seller waited for the daily cron;
 *   · the seller's own self-booking (app/actions/home-value.ts
 *     scheduleSellerListingAppointment, the report page AND the portal) started
 *     NOTHING — same;
 *   · the daily cron (app/api/cron/listing-presentation-prep) built presentations
 *     for every 'listing_appointment' row it found, including CANCELLED
 *     (superseded) holds and rows whose contact was not a seller, and never saw
 *     the calendar path's 'listing_consultation' rows at all (lane 87B2 merged that
 *     spelling — and the ISA milestone's 'isa_appointment' — onto 'listing_appointment').
 *
 * THE SHAPE NOW. Every booking path hands THIS core the calendar_events row it
 * just wrote. The core:
 *   1. reads the BOOKING ROW on the service client — its brokerage_id is the
 *      tenant (a caller that holds a session passes its tenant as
 *      expectedBrokerageId and a mismatch is refused — never trusted from a body);
 *   2. refuses anything that is not a listing appointment (event type), is
 *      cancelled, or is still a tentative hold awaiting the agent's confirmation
 *      (deferred — the confirm path calls back in);
 *   3. resolves the SELLER CONTACT (entity_id when entity_type='contact',
 *      metadata.contact_id otherwise, the listing's seller for a listing row) and
 *      REFUSES a non-seller context (classifySellerPrepContext — pure);
 *   4. resolves the SELLER'S PROPERTY ADDRESS (listing row → caller's property
 *      hint → valuation request → the booking's recorded address → the seller's
 *      own home address), never inventing a state the CMA cannot run without;
 *   5. resolves the agent as a USERS id from agent_user_id, else metadata.agent_id
 *      tested as users.id then as agents.id — both INSIDE the tenant (§3: the two
 *      id spaces are disjoint; resolved, never substituted);
 *   6. starts the ONE listing-appt-prep chain run keyed on the BOOKING ROW id
 *      (triggerEventId) — so every path for one appointment collapses onto one run.
 *
 * The cron is now the SAFETY NET (decideSafetyNetAction, pure): a booking with a
 * presentation is done; one with a live run is in progress; one with no run
 * missed its event and is started here; one whose run ended without a
 * presentation gets the presentation built directly (the old cron behaviour).
 *
 * Server-only, never "use server" — it trusts the calendar row it is handed.
 */
import "server-only"
import type { createServiceClient } from "@/lib/supabase/service"
import { splitOneLineAddress } from "@/lib/ai-isa/property-lookup-rail"
import { CalendarEventType } from "@/lib/kernel/calendar-types"

type Svc = ReturnType<typeof createServiceClient>

// ── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * THE ONE calendar_events.event_type spelling of a listing appointment
 * (CalendarEventType.LISTING_APPOINTMENT). Lane 87B2 (§6) merged the other two onto
 * it at their writers: the agent calendar's 'listing_consultation' (scheduler value +
 * canonicalCalendarEventType at createAppointment) and the AI-ISA seller milestone's
 * generic 'isa_appointment' (scheduleISAAppointment now takes eventType, and
 * book-seller-appointment passes LISTING_APPOINTMENT). The lane-87B caller flag
 * `isaListingAppointment` is RETIRED with it — no reader needs a second spelling.
 */
export const LISTING_APPOINTMENT_BOOKING_EVENT_TYPES = [CalendarEventType.LISTING_APPOINTMENT] as const

/** contact_type values that ARE the seller side (CHECK vocabulary: scripts/check-vocabularies.ts). */
const SELLER_SIDE_CONTACT_TYPES = new Set(["seller", "both"])

/** Statuses a booking can carry that mean "do not prep". */
const CANCELLED_BOOKING_STATUSES = new Set(["cancelled", "canceled", "no_show"])
/** lib/ai-isa/listing-appointment.ts LISTING_APPOINTMENT_STATUS.PENDING_AGENT_CONFIRMATION — a tentative hold. */
const PENDING_CONFIRMATION_STATUS = "pending_agent_confirmation"

const LISTING_APPT_PREP_CHAIN_KEY = "listing-appt-prep"
const LISTING_APPT_PREP_TRIGGER_EVENT = "listing.appointment_set"

// ── Pure rules (unit-tested by scripts/listing-prep-from-booking-simulator.ts) ─

type SellerPrepVerdict =
  | { seller: true; basis: "contact_type" | "listing_seller" | "valuation_request" }
  | { seller: false; reason: string }

/**
 * Is this booking FOR A SELLER? Owner: the prep "needs to be for a seller".
 *   · contact_type seller/both → yes;
 *   · otherwise EVIDENCE of a home to sell in the same tenant — the contact is the
 *     seller on a listing, or asked for a valuation of their home → yes;
 *   · anything else (a buyer, a vendor, an untyped contact with no home on file,
 *     or no contact at all) → no, with the reason named.
 */
export function classifySellerPrepContext(input: {
  contactId: string | null
  contactType: string | null
  isListingSeller: boolean
  hasValuationRequest: boolean
}): SellerPrepVerdict {
  if (!input.contactId) return { seller: false, reason: "no_seller_contact" }
  const t = (input.contactType ?? "").trim().toLowerCase()
  if (SELLER_SIDE_CONTACT_TYPES.has(t)) return { seller: true, basis: "contact_type" }
  if (input.isListingSeller) return { seller: true, basis: "listing_seller" }
  if (input.hasValuationRequest) return { seller: true, basis: "valuation_request" }
  return { seller: false, reason: `not_a_seller:${t || "untyped"}` }
}

/** Which booking rows start prep, which wait, which never do. Pure. */
export function bookingPrepGate(input: {
  eventType: string | null
  status: string | null
}): { go: true } | { go: false; outcome: "refused" | "deferred" | "skipped"; reason: string } {
  const et = (input.eventType ?? "").trim()
  const isListingKind = (LISTING_APPOINTMENT_BOOKING_EVENT_TYPES as readonly string[]).includes(et)
  if (!isListingKind) return { go: false, outcome: "refused", reason: `not_a_listing_appointment:${et || "none"}` }
  const st = (input.status ?? "").trim().toLowerCase()
  if (CANCELLED_BOOKING_STATUSES.has(st)) return { go: false, outcome: "skipped", reason: `booking_${st}` }
  if (st === PENDING_CONFIRMATION_STATUS) return { go: false, outcome: "deferred", reason: "awaiting_agent_confirmation" }
  return { go: true }
}

type SafetyNetAction = "done" | "in_progress" | "start_prep" | "build_presentation"

/**
 * The cron's decision for ONE booking, given what already exists for it. Pure.
 *   · a presentation exists            → done (idempotent);
 *   · a live prep run exists           → in_progress (the chain will build it);
 *   · no run at all                    → start_prep (the booking missed its event);
 *   · runs exist, all ended, no deck   → build_presentation (the chain failed or was
 *                                        stopped before its presentation step —
 *                                        the old cron behaviour is the net's net).
 */
export function decideSafetyNetAction(input: {
  presentationExists: boolean
  runStatuses: string[]
}): SafetyNetAction {
  if (input.presentationExists) return "done"
  const live = new Set(["running", "paused", "needs_approval"])
  if (input.runStatuses.some((s) => live.has(s))) return "in_progress"
  if (input.runStatuses.length === 0) return "start_prep"
  return "build_presentation"
}

/** Loose address comparison for picking WHICH valuation_request. */
function addressKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

/**
 * "123 Main St, Tampa, FL 33601" → parts, through the ONE one-line address splitter
 * (lib/ai-isa/property-lookup-rail.ts::splitOneLineAddress — §6, never a second
 * parser), normalised to nulls. A line with no state yields no state (never invented).
 */
export function splitBookedAddress(line: string): { street: string; city: string | null; state: string | null; zip: string | null } {
  const a = splitOneLineAddress(line)
  return { street: a.street, city: a.city ?? null, state: a.state ?? null, zip: a.zip ?? null }
}

// ── Resolution (I/O) ──────────────────────────────────────────────────────────

interface SellerProperty {
  propertyAddress: string | null
  state: string | null
  city: string | null
  zip: string | null
  /** Only ever a real listings.id in this tenant. */
  listingId: string | null
  bedrooms: number | null
  bathrooms: number | null
  sqft: number | null
  yearBuilt: number | null
  lotSize: number | null
  propertyType: string | null
  source: "listing" | "caller_hint" | "valuation_request" | "booking_address" | "seller_home_address" | "none"
}

const NO_PROPERTY: SellerProperty = {
  propertyAddress: null, state: null, city: null, zip: null, listingId: null,
  bedrooms: null, bathrooms: null, sqft: null, yearBuilt: null, lotSize: null, propertyType: null,
  source: "none",
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

interface BookingPrepContext {
  calendarEventId: string
  brokerageId: string
  startAt: string | null
  contactId: string
  agentUserId: string | null
  property: SellerProperty
  sellerBasis: "contact_type" | "listing_seller" | "valuation_request"
}

type ResolveBookingPrepResult =
  | { ok: true; context: BookingPrepContext }
  | { ok: false; outcome: "refused" | "deferred" | "skipped" | "error"; reason: string }

interface ResolveBookingPrepParams {
  calendarEventId: string
  /** The tenant a SESSION caller holds. The booking row must be in it. */
  expectedBrokerageId?: string | null
  /** A listing the caller KNOWS this booking is for (tenant-verified here). */
  listingId?: string | null
  /** Property facts the caller captured at booking (address/city/state/zip…). */
  propertyHint?: Record<string, unknown> | null
}

/**
 * Read the booking row and resolve everything the prep needs — or say exactly why
 * this booking does not get one. Every read is on the service client and pinned
 * to the booking row's brokerage.
 */
export async function resolveBookingPrepContext(svc: Svc, params: ResolveBookingPrepParams): Promise<ResolveBookingPrepResult> {
  const { data: row, error: rowErr } = await svc
    .from("calendar_events")
    .select("id, brokerage_id, entity_type, entity_id, event_type, status, start_at, location, metadata, agent_user_id")
    .eq("id", params.calendarEventId)
    .maybeSingle()
  if (rowErr) return { ok: false, outcome: "error", reason: `booking read refused: ${rowErr.message}` }
  if (!row) return { ok: false, outcome: "refused", reason: "booking_not_found" }
  const r = row as {
    id: string; brokerage_id: string | null; entity_type: string | null; entity_id: string | null
    event_type: string | null; status: string | null; start_at: string | null; location: string | null
    metadata: Record<string, unknown> | null; agent_user_id: string | null
  }

  // TENANT — the booking row's own brokerage. A session caller's tenant must match.
  const brokerageId = r.brokerage_id
  if (!brokerageId) return { ok: false, outcome: "refused", reason: "booking_has_no_tenant" }
  if (params.expectedBrokerageId && params.expectedBrokerageId !== brokerageId) {
    return { ok: false, outcome: "refused", reason: "booking_not_in_caller_tenant" }
  }

  const gate = bookingPrepGate({ eventType: r.event_type, status: r.status })
  if (!gate.go) return { ok: false, outcome: gate.outcome, reason: gate.reason }

  const meta = r.metadata ?? {}

  // ── The listing this booking is on (tenant-pinned) ──────────────────────────
  const listingCandidate =
    params.listingId ?? (r.entity_type === "listing" ? r.entity_id : null) ?? str(meta.listing_id)
  let listing: Record<string, unknown> | null = null
  if (listingCandidate) {
    const { data, error } = await svc
      .from("listings")
      .select("id, contact_id, seller_contact_id, address, city, state, zip, bedrooms, bathrooms, sqft, year_built, lot_size, property_type")
      .eq("id", listingCandidate)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    if (error) return { ok: false, outcome: "error", reason: `listing read refused: ${error.message}` }
    listing = (data as Record<string, unknown> | null) ?? null
  }

  // ── The SELLER contact ──────────────────────────────────────────────────────
  const contactCandidate =
    (r.entity_type === "contact" ? r.entity_id : null) ??
    str(meta.contact_id) ??
    (listing ? str(listing.seller_contact_id) ?? str(listing.contact_id) : null)
  type ContactRow = { id: string; contact_type: string | null; address: string | null; city: string | null; state: string | null; zip_code: string | null }
  let contact: ContactRow | null = null
  if (contactCandidate) {
    const { data, error } = await svc
      .from("contacts")
      .select("id, contact_type, address, city, state, zip_code")
      .eq("id", contactCandidate)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    if (error) return { ok: false, outcome: "error", reason: `contact read refused: ${error.message}` }
    contact = (data as ContactRow | null) ?? null
  }

  const isListingSeller = !!(contact && listing &&
    (listing.seller_contact_id === contact.id || listing.contact_id === contact.id))

  // Valuation requests — evidence of a home to sell AND a property source.
  let valuations: Array<Record<string, unknown>> = []
  if (contact) {
    const { data, error } = await svc
      .from("valuation_requests")
      .select("property_address, city, state, zip_code, bedrooms, bathrooms, square_feet, year_built, submitted_at")
      .eq("contact_id", contact.id)
      .eq("brokerage_id", brokerageId)
      .order("submitted_at", { ascending: false })
      .limit(10)
    if (error) return { ok: false, outcome: "error", reason: `valuation_requests read refused: ${error.message}` }
    valuations = (data as Array<Record<string, unknown>> | null) ?? []
  }

  const verdict = classifySellerPrepContext({
    contactId: contact?.id ?? null,
    contactType: contact?.contact_type ?? null,
    isListingSeller,
    hasValuationRequest: valuations.length > 0,
  })
  if (!verdict.seller || !contact) return { ok: false, outcome: "refused", reason: verdict.seller ? "no_seller_contact" : verdict.reason }

  // ── The SELLER'S PROPERTY ───────────────────────────────────────────────────
  const property = pickSellerProperty({
    listing, hint: params.propertyHint ?? null, valuations,
    bookedAddress: str(meta.property_address) ?? str(meta.location) ?? str(r.location),
    contact,
  })

  // ── The agent as a USERS id, inside the tenant ─────────────────────────────
  const agentUserId = await resolveBookingAgentUserId(svc, {
    brokerageId,
    agentUserIdColumn: r.agent_user_id,
    metadataAgentId: str(meta.agent_id) ?? str(meta.agentId),
  })

  return {
    ok: true,
    context: {
      calendarEventId: r.id,
      brokerageId,
      startAt: r.start_at,
      contactId: contact.id,
      agentUserId,
      property,
      sellerBasis: verdict.basis,
    },
  }
}

function pickSellerProperty(args: {
  listing: Record<string, unknown> | null
  hint: Record<string, unknown> | null
  valuations: Array<Record<string, unknown>>
  bookedAddress: string | null
  contact: { address: string | null; city: string | null; state: string | null; zip_code: string | null } | null
}): SellerProperty {
  // 1. The listing row — the property the appointment is ON.
  if (args.listing && str(args.listing.address)) {
    const l = args.listing
    return {
      propertyAddress: str(l.address), state: str(l.state), city: str(l.city), zip: str(l.zip),
      listingId: str(l.id), bedrooms: num(l.bedrooms), bathrooms: num(l.bathrooms), sqft: num(l.sqft),
      yearBuilt: num(l.year_built), lotSize: num(l.lot_size), propertyType: str(l.property_type), source: "listing",
    }
  }
  const listingId = args.listing ? str(args.listing.id) : null

  // 2. What the booking caller captured (the ISA's property data).
  const h = args.hint
  if (h && str(h.address)) {
    const split = splitBookedAddress(str(h.address) as string)
    const state = str(h.state) ?? split.state
    if (state) {
      return {
        propertyAddress: split.street, state: state.toUpperCase(), city: str(h.city) ?? split.city,
        zip: str(h.zip) ?? str(h.zipCode) ?? split.zip, listingId,
        bedrooms: num(h.bedrooms), bathrooms: num(h.bathrooms), sqft: num(h.sqft), yearBuilt: num(h.yearBuilt),
        lotSize: num(h.lotSize), propertyType: str(h.propertyType), source: "caller_hint",
      }
    }
  }

  // 3. The home-value request — prefer the one for the address booked about.
  if (args.valuations.length > 0) {
    let chosen = args.valuations[0]
    if (args.bookedAddress) {
      const want = addressKey(args.bookedAddress)
      const match = args.valuations.find((v) => typeof v.property_address === "string" && addressKey(v.property_address) === want)
      if (match) chosen = match
    }
    if (str(chosen.property_address) && str(chosen.state)) {
      return {
        propertyAddress: str(chosen.property_address), state: str(chosen.state), city: str(chosen.city),
        zip: str(chosen.zip_code), listingId, bedrooms: num(chosen.bedrooms), bathrooms: num(chosen.bathrooms),
        sqft: num(chosen.square_feet), yearBuilt: num(chosen.year_built), lotSize: null, propertyType: null,
        source: "valuation_request",
      }
    }
  }

  // 4. The address the booking itself recorded — only when it carries a state.
  if (args.bookedAddress) {
    const split = splitBookedAddress(args.bookedAddress)
    if (split.state && split.street) {
      return { ...NO_PROPERTY, propertyAddress: split.street, state: split.state, city: split.city, zip: split.zip, listingId, source: "booking_address" }
    }
  }

  // 5. The seller's own home address on the contact card.
  const c = args.contact
  if (c && str(c.address) && str(c.state)) {
    return { ...NO_PROPERTY, propertyAddress: str(c.address), state: str(c.state), city: str(c.city), zip: str(c.zip_code), listingId, source: "seller_home_address" }
  }

  return { ...NO_PROPERTY, listingId }
}

/**
 * The booking's agent as a USERS id, proven inside the tenant. agent_user_id is
 * the column most writers fill with one; metadata.agent_id is a users.id on some
 * paths and an AGENTS id on others (home-value, the calendar scheduler), so it is
 * tested as each — never substituted (listing_presentations.agent_user_id FKs users).
 */
async function resolveBookingAgentUserId(
  svc: Svc,
  args: { brokerageId: string; agentUserIdColumn: string | null; metadataAgentId: string | null },
): Promise<string | null> {
  for (const candidate of [args.agentUserIdColumn, args.metadataAgentId]) {
    if (!candidate) continue
    const { data: user, error: userErr } = await svc
      .from("users").select("id").eq("id", candidate).eq("brokerage_id", args.brokerageId).maybeSingle()
    if (userErr) { console.error(`[booking-prep] users check for ${candidate} refused: ${userErr.message}`); continue }
    if (user) return candidate
    const { data: agent, error: agentErr } = await svc
      .from("agents").select("user_id").eq("id", candidate).eq("brokerage_id", args.brokerageId).maybeSingle()
    if (agentErr) { console.error(`[booking-prep] agents check for ${candidate} refused: ${agentErr.message}`); continue }
    const uid = (agent as { user_id?: string | null } | null)?.user_id ?? null
    if (uid) return uid
  }
  return null
}

// ── The one starter ───────────────────────────────────────────────────────────

export type StartBookingPrepResult =
  | { status: "started" | "deduped"; runId: string; runStatus: string | null; context: BookingPrepContext }
  | { status: "refused" | "deferred" | "skipped" | "error"; reason: string }

/**
 * THE ONE STARTER every listing-appointment booking path calls with the row it
 * wrote. Starts (or reuses) the listing-appt-prep chain run for this booking.
 * Never throws — a prep that could not start must not undo a booking.
 */
export async function startListingPresentationPrepFromBooking(
  svc: Svc,
  params: ResolveBookingPrepParams & { origin: string },
): Promise<StartBookingPrepResult> {
  try {
    const resolved = await resolveBookingPrepContext(svc, params)
    if (!resolved.ok) {
      if (resolved.outcome === "error") console.error(`[booking-prep] ${params.origin} ${params.calendarEventId}: ${resolved.reason}`)
      return { status: resolved.outcome, reason: resolved.reason }
    }
    const ctx = resolved.context
    if (!ctx.property.propertyAddress || !ctx.property.state) {
      // Honest skip: nothing on file names the seller's property with a state —
      // the CMA is state-scoped and listing_presentations.state is NOT NULL.
      return { status: "skipped", reason: "no_seller_property_with_state" }
    }
    const { startRun } = await import("@/lib/workflow-orchestrator/engine")
    const p = ctx.property
    const run = await startRun({
      chainKey: LISTING_APPT_PREP_CHAIN_KEY,
      brokerageId: ctx.brokerageId,
      contactId: ctx.contactId,
      listingId: p.listingId,
      agentUserId: ctx.agentUserId,
      triggerEvent: LISTING_APPT_PREP_TRIGGER_EVENT,
      // ONE run per BOOKING: every path for this appointment collapses onto it.
      triggerEventId: ctx.calendarEventId,
      metadata: {
        appointment_id: ctx.calendarEventId,
        appointment_date: ctx.startAt,
        seller_prep: { basis: ctx.sellerBasis, property_source: p.source, origin: params.origin },
        property_data: {
          address: p.propertyAddress, city: p.city, state: p.state, zip: p.zip,
          bedrooms: p.bedrooms, bathrooms: p.bathrooms, sqft: p.sqft, yearBuilt: p.yearBuilt,
          lotSize: p.lotSize, propertyType: p.propertyType ?? "single_family",
        },
      },
    })
    if (!run.success || !run.runId) return { status: "error", reason: run.error ?? "chain start failed" }
    return { status: run.deduped ? "deduped" : "started", runId: run.runId, runStatus: run.status ?? null, context: ctx }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error(`[booking-prep] ${params.origin} ${params.calendarEventId} threw: ${reason}`)
    return { status: "error", reason }
  }
}

/** The prep runs already started for this booking (the safety net's second read). */
export async function prepRunStatusesForBooking(
  svc: Svc,
  args: { brokerageId: string; calendarEventId: string },
): Promise<{ ok: true; statuses: string[] } | { ok: false; error: string }> {
  const { data, error } = await svc
    .from("workflow_runs")
    .select("status")
    .eq("chain_key", LISTING_APPT_PREP_CHAIN_KEY)
    .eq("brokerage_id", args.brokerageId)
    .eq("trigger_event_id", args.calendarEventId)
    .limit(20)
  if (error) return { ok: false, error: error.message }
  return { ok: true, statuses: ((data as Array<{ status: string }> | null) ?? []).map((r) => r.status) }
}
