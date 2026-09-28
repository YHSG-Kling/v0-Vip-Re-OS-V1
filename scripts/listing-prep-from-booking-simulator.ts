/**
 * scripts/listing-prep-from-booking-simulator.ts   (npm run test:listing-prep-from-booking)
 *
 * WAVE 87, LANE 87B. Owner, verbatim (2026-09-28): "listing presentation prep which
 * inlcudes the cma needs to be for a seller as this is started from the listing
 * appointmtent booking."
 *
 * Proves, with no network and no model / AVM / D-ID spend:
 *   §1 PURE RULES (lib/listing-presentation/booking-prep.ts) — the seller gate
 *      (classifySellerPrepContext), the booking gate (bookingPrepGate: event type,
 *      cancelled, tentative hold), the cron safety-net decision (decideSafetyNetAction),
 *      the booked-address splitter — each with a positive and a negative control.
 *   §2 RESOLUTION on an in-memory service client (resolveBookingPrepContext /
 *      startListingPresentationPrepFromBooking's refusal arms): the tenant is the
 *      BOOKING ROW's (a session tenant that differs is refused); a buyer is refused;
 *      a home-value seller resolves from the valuation request matched to the booked
 *      address; a listing consult resolves from the listing; an agents.id in metadata
 *      is RESOLVED to its users.id inside the tenant (never substituted); a
 *      pending_agent_confirmation hold is DEFERRED; a cancelled one is SKIPPED; a
 *      foreign-tenant contact is invisible.
 *   §3 WIRING (stripped source, §2 discipline) — EVERY booking path hands its row to
 *      the ONE starter; no booking path still starts the chain itself; the starter
 *      keys the run on the booking row; the cron is a safety net that reads both
 *      listing-appointment spellings and resolves through the SAME core; the builder
 *      is idempotent per appointment BEFORE any paid step; m667 carries the index.
 *      Every absence assertion has a positive control on a specimen of the defect.
 *
 * BLIND SPOTS (published): startRun itself binds its own service client, so the
 * STARTED arm is proved by source (the run is keyed on the booking row) and by
 * test:listing-appt-prep, not executed here; the live DB is not touched; a booking
 * path added later that writes calendar_events without calling the starter is caught
 * only if it lives in one of the files §3 names (the cron safety net still reaches it).
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import {
  classifySellerPrepContext,
  bookingPrepGate,
  decideSafetyNetAction,
  splitBookedAddress,
  resolveBookingPrepContext,
  startListingPresentationPrepFromBooking,
  LISTING_APPOINTMENT_BOOKING_EVENT_TYPES,
} from "../lib/listing-presentation/booking-prep"

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const ROOT = process.cwd()
const code = (rel: string) => stripComments(readFileSync(join(ROOT, rel), "utf8"))

// ── In-memory service client ─────────────────────────────────────────────────
type Row = Record<string, any>
function fakeSvc(tables: Record<string, Row[]>, refuse: Set<string> = new Set()) {
  const reads: string[] = []
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let limitN: number | null = null
    const run = () => {
      reads.push(table)
      if (refuse.has(table)) return { data: null, error: { message: `${table} refused (fixture)` } }
      let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
      if (limitN != null) rows = rows.slice(0, limitN)
      return { data: rows, error: null }
    }
    const q: any = {
      select: () => q,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return q },
      order: () => q,
      limit: (n: number) => { limitN = n; return q },
      maybeSingle: async () => { const r = run(); return r.error ? r : { data: (r.data as Row[])[0] ?? null, error: null } },
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    }
    return q
  }
  return { client: { from } as any, reads }
}

const T = "b0000000-0000-4000-8000-000000000001"
const OTHER = "b0000000-0000-4000-8000-000000000002"
const USER = "u0000000-0000-4000-8000-000000000001"
const AGENT = "a0000000-0000-4000-8000-000000000001"
const SELLER = "c0000000-0000-4000-8000-000000000001"
const BUYER = "c0000000-0000-4000-8000-000000000002"
const HV = "c0000000-0000-4000-8000-000000000003"
const LISTING = "l0000000-0000-4000-8000-000000000001"

function world(): Record<string, Row[]> {
  return {
    users: [{ id: USER, brokerage_id: T }],
    agents: [{ id: AGENT, user_id: USER, brokerage_id: T }],
    contacts: [
      { id: SELLER, brokerage_id: T, contact_type: "seller", address: "9 Oak St", city: "Tampa", state: "FL", zip_code: "33602" },
      { id: BUYER, brokerage_id: T, contact_type: "buyer", address: null, city: null, state: null, zip_code: null },
      { id: HV, brokerage_id: T, contact_type: "prospect", address: null, city: null, state: null, zip_code: null },
    ],
    listings: [{ id: LISTING, brokerage_id: T, contact_id: null, seller_contact_id: BUYER, address: "12 Cypress Ln", city: "Tampa", state: "FL", zip: "33606", bedrooms: 4, bathrooms: 3, sqft: 2400, year_built: 1999, lot_size: null, property_type: "single_family" }],
    valuation_requests: [
      { contact_id: HV, brokerage_id: T, property_address: "1 Old Rd", city: "Tampa", state: "FL", zip_code: "33600", bedrooms: 2, bathrooms: 1, square_feet: 900, year_built: 1960, submitted_at: "2026-09-01" },
      { contact_id: HV, brokerage_id: T, property_address: "77 Bay Dr", city: "Tampa", state: "FL", zip_code: "33611", bedrooms: 3, bathrooms: 2, square_feet: 1700, year_built: 1988, submitted_at: "2026-08-01" },
    ],
    calendar_events: [
      // agent calendar: listing_consultation, contact entity, agents.id in metadata.agentId, no agent_user_id
      { id: "e-cal", brokerage_id: T, entity_type: "contact", entity_id: SELLER, event_type: "listing_consultation", status: null, start_at: "2026-10-20T15:00:00Z", location: "9 Oak St, Tampa, FL 33602", metadata: { agentId: AGENT }, agent_user_id: null },
      // buyer "consultation"
      { id: "e-buyer", brokerage_id: T, entity_type: "contact", entity_id: BUYER, event_type: "listing_consultation", status: null, start_at: "2026-10-20T15:00:00Z", location: "somewhere", metadata: {}, agent_user_id: USER },
      // home-value self-booking: entity agent, contact in metadata, agents.id in metadata.agent_id
      { id: "e-hv", brokerage_id: T, entity_type: "agent", entity_id: AGENT, event_type: "listing_appointment", status: null, start_at: "2026-10-21T15:00:00Z", location: null, metadata: { contact_id: HV, agent_id: AGENT, property_address: "77 Bay Dr" }, agent_user_id: USER },
      // listing consult: the listing's seller (BUYER-typed contact that IS the listing's seller)
      { id: "e-listing", brokerage_id: T, entity_type: "listing", entity_id: LISTING, event_type: "listing_appointment", status: null, start_at: "2026-10-22T15:00:00Z", location: null, metadata: { contact_id: BUYER, agent_id: USER }, agent_user_id: USER },
      // AI-ISA tentative hold
      { id: "e-pending", brokerage_id: T, entity_type: "contact", entity_id: SELLER, event_type: "listing_appointment", status: "pending_agent_confirmation", start_at: "2026-10-23T15:00:00Z", location: null, metadata: {}, agent_user_id: USER },
      // superseded hold
      { id: "e-cancelled", brokerage_id: T, entity_type: "contact", entity_id: SELLER, event_type: "listing_appointment", status: "cancelled", start_at: "2026-10-23T15:00:00Z", location: null, metadata: {}, agent_user_id: USER },
      // a showing is not a listing appointment
      { id: "e-showing", brokerage_id: T, entity_type: "contact", entity_id: SELLER, event_type: "showing", status: null, start_at: "2026-10-23T15:00:00Z", location: null, metadata: {}, agent_user_id: USER },
      // ISA seller milestone row
      { id: "e-isa", brokerage_id: T, entity_type: "contact", entity_id: SELLER, event_type: "isa_appointment", status: "scheduled", start_at: "2026-10-24T15:00:00Z", location: null, metadata: {}, agent_user_id: USER },
      // a row whose contact lives in ANOTHER tenant
      { id: "e-foreign", brokerage_id: OTHER, entity_type: "contact", entity_id: SELLER, event_type: "listing_appointment", status: null, start_at: "2026-10-24T15:00:00Z", location: null, metadata: {}, agent_user_id: null },
    ],
  }
}

async function main() {
  console.log("\n── §1 pure rules ──")
  check("a seller-typed contact is a seller", classifySellerPrepContext({ contactId: "c", contactType: "seller", isListingSeller: false, hasValuationRequest: false }).seller === true)
  check("'both' is the seller side too", classifySellerPrepContext({ contactId: "c", contactType: "both", isListingSeller: false, hasValuationRequest: false }).seller === true)
  const buyer = classifySellerPrepContext({ contactId: "c", contactType: "buyer", isListingSeller: false, hasValuationRequest: false })
  check("NEGATIVE: a buyer with no home on file is REFUSED, reason named", !buyer.seller && (buyer as any).reason === "not_a_seller:buyer")
  check("a buyer-typed contact who IS a listing's seller is a seller (evidence wins)", classifySellerPrepContext({ contactId: "c", contactType: "buyer", isListingSeller: true, hasValuationRequest: false }).seller === true)
  check("an untyped contact with a valuation request is a seller", classifySellerPrepContext({ contactId: "c", contactType: null, isListingSeller: false, hasValuationRequest: true }).seller === true)
  check("NEGATIVE: no contact at all is refused", (classifySellerPrepContext({ contactId: null, contactType: "seller", isListingSeller: true, hasValuationRequest: true }) as any).reason === "no_seller_contact")

  check("both listing-appointment spellings pass the booking gate",
    LISTING_APPOINTMENT_BOOKING_EVENT_TYPES.every((et) => bookingPrepGate({ eventType: et, status: "scheduled" }).go))
  check("NEGATIVE: a showing is refused as not a listing appointment", (bookingPrepGate({ eventType: "showing", status: null }) as any).outcome === "refused")
  check("an ISA row passes ONLY when its caller asserts it is a listing appointment",
    bookingPrepGate({ eventType: "isa_appointment", status: null, isaListingAppointment: true }).go &&
    !bookingPrepGate({ eventType: "isa_appointment", status: null }).go)
  check("a cancelled/superseded booking is skipped", (bookingPrepGate({ eventType: "listing_appointment", status: "cancelled" }) as any).outcome === "skipped")
  check("a tentative hold awaiting the agent is DEFERRED (the confirm starts it)", (bookingPrepGate({ eventType: "listing_appointment", status: "pending_agent_confirmation" }) as any).outcome === "deferred")

  check("safety net: a presentation on file → done", decideSafetyNetAction({ presentationExists: true, runStatuses: ["failed"] }) === "done")
  check("safety net: a live run → in_progress", decideSafetyNetAction({ presentationExists: false, runStatuses: ["completed", "running"] }) === "in_progress")
  check("safety net: no run → start_prep (the booking missed its event)", decideSafetyNetAction({ presentationExists: false, runStatuses: [] }) === "start_prep")
  check("safety net: runs ended with no deck → build_presentation", decideSafetyNetAction({ presentationExists: false, runStatuses: ["failed"] }) === "build_presentation")

  const sp = splitBookedAddress("9 Oak St, Tampa, FL 33602")
  check("booked address splits street/city/state/zip", sp.street === "9 Oak St" && sp.city === "Tampa" && sp.state === "FL" && sp.zip === "33602")
  check("NEGATIVE: an address with no state yields no state (never invented)", splitBookedAddress("somewhere").state === null)

  console.log("\n── §2 resolution on the booking row ──")
  {
    const { client } = fakeSvc(world())
    const cal = await resolveBookingPrepContext(client, { calendarEventId: "e-cal", expectedBrokerageId: T })
    check("agent-calendar consultation: seller resolved, tenant = booking row",
      cal.ok && cal.context.contactId === SELLER && cal.context.brokerageId === T, JSON.stringify(cal))
    check("agent-calendar: metadata agents.id is RESOLVED to its users.id inside the tenant",
      cal.ok && cal.context.agentUserId === USER)
    check("agent-calendar: property from the seller's recorded address (source named)",
      cal.ok && cal.context.property.propertyAddress === "9 Oak St" && cal.context.property.state === "FL" && ["booking_address", "seller_home_address"].includes(cal.context.property.source))

    const mismatch = await resolveBookingPrepContext(client, { calendarEventId: "e-cal", expectedBrokerageId: OTHER })
    check("NEGATIVE: a session tenant that is not the booking row's is refused",
      !mismatch.ok && mismatch.reason === "booking_not_in_caller_tenant")

    const b = await resolveBookingPrepContext(client, { calendarEventId: "e-buyer" })
    check("NEGATIVE: a buyer's consultation gets NO seller prep", !b.ok && b.outcome === "refused" && b.reason === "not_a_seller:buyer", JSON.stringify(b))

    const hv = await resolveBookingPrepContext(client, { calendarEventId: "e-hv" })
    check("home-value self-booking: the valuation request is the seller evidence", hv.ok && hv.context.sellerBasis === "valuation_request")
    check("home-value: the valuation request MATCHING the booked address is used (not merely the newest)",
      hv.ok && hv.context.property.propertyAddress === "77 Bay Dr" && hv.context.property.sqft === 1700, JSON.stringify(hv.ok && hv.context.property))
    check("home-value: listingId stays null — an agents.id in entity_id is never a listing", hv.ok && hv.context.property.listingId === null)

    const li = await resolveBookingPrepContext(client, { calendarEventId: "e-listing" })
    check("listing consult: the listing's seller qualifies (listing evidence), property from the listing row",
      li.ok && li.context.sellerBasis === "listing_seller" && li.context.property.source === "listing" && li.context.property.listingId === LISTING)

    const pend = await startListingPresentationPrepFromBooking(client, { calendarEventId: "e-pending", origin: "sim" })
    check("AI-ISA tentative hold: DEFERRED until the agent confirms", pend.status === "deferred")
    const canc = await startListingPresentationPrepFromBooking(client, { calendarEventId: "e-cancelled", origin: "sim" })
    check("superseded hold: skipped", canc.status === "skipped")
    const show = await startListingPresentationPrepFromBooking(client, { calendarEventId: "e-showing", origin: "sim" })
    check("a showing: refused", show.status === "refused")
    const isaNoFlag = await startListingPresentationPrepFromBooking(client, { calendarEventId: "e-isa", origin: "sim" })
    check("an ISA row without the caller's listing assertion: refused", isaNoFlag.status === "refused")
    const isa = await resolveBookingPrepContext(client, { calendarEventId: "e-isa", isaListingAppointment: true, propertyHint: { address: "5 Pine Ct, Tampa, FL 33605", bedrooms: 3 } })
    check("ISA seller milestone: the caller's captured property is used (hint, state parsed)",
      isa.ok && isa.context.property.source === "caller_hint" && isa.context.property.propertyAddress === "5 Pine Ct" && isa.context.property.state === "FL" && isa.context.property.bedrooms === 3)

    const foreign = await resolveBookingPrepContext(client, { calendarEventId: "e-foreign" })
    check("NEGATIVE: a contact outside the booking row's tenant is invisible → refused", !foreign.ok && foreign.reason === "no_seller_contact")
  }
  {
    const { client } = fakeSvc(world(), new Set(["contacts"]))
    const r = await startListingPresentationPrepFromBooking(client, { calendarEventId: "e-cal", origin: "sim" })
    check("a REFUSED read is an error, never 'not a seller' (§3)", r.status === "error" && /contact read refused/.test((r as any).reason))
  }

  console.log("\n── §3 wiring (stripped source) ──")
  const STARTER = "startListingPresentationPrepFromBooking("
  const PATHS: Array<[string, string]> = [
    ["app/actions/ai-calendar-management.ts", "agent calendar"],
    ["app/actions/listing-lifecycle.ts", "listing consult + stage pipeline"],
    ["lib/ai-isa/book-seller-appointment.ts", "AI-ISA seller milestone"],
    ["lib/ai-isa/listing-appointment.ts", "AI-ISA / voice booking (at the agent's confirm)"],
    ["app/actions/home-value.ts", "seller self-booking (report page + portal)"],
    ["app/api/cron/listing-presentation-prep/route.ts", "cron safety net"],
  ]
  for (const [rel, label] of PATHS) {
    check(`${label} (${rel}) hands its booking row to the ONE starter`, existsSync(join(ROOT, rel)) && code(rel).includes(STARTER))
  }
  check("[control] the finder reports a path that does not call the starter",
    !stripComments(`// ${STARTER} is named only in a comment\nawait triggerChainsForEvent({ eventType: "listing.appointment_set" })`).includes(STARTER))
  check("listing-lifecycle calls the starter on BOTH its booking paths (consult + stage)",
    (code("app/actions/listing-lifecycle.ts").split(STARTER).length - 1) === 2)

  const OLD_START = /triggerChainsForEvent\(\{[\s\S]{0,120}listing\.appointment_set|chainKey:\s*"listing-appt-prep"/
  const offenders = PATHS.map(([rel]) => rel).filter((rel) => OLD_START.test(code(rel)))
  check("no booking path still starts the prep chain itself (triggerChainsForEvent / startRun)", offenders.length === 0, offenders.join(", "))
  check("[control] the old-start finder catches the retired shape",
    OLD_START.test(`await triggerChainsForEvent({ eventType: "listing.appointment_set", brokerageId })`) &&
    OLD_START.test(`await startRun({ chainKey: "listing-appt-prep", brokerageId })`))

  const starter = code("lib/listing-presentation/booking-prep.ts")
  check("the starter keys the prep run on the BOOKING ROW", /triggerEventId:\s*ctx\.calendarEventId/.test(starter))
  check("the starter's tenant is the booking row's brokerage_id; a session caller's must match",
    /const brokerageId = r\.brokerage_id/.test(starter) && /params\.expectedBrokerageId !== brokerageId/.test(starter))
  check("every seller/property/agent read in the starter is pinned to that tenant",
    (starter.match(/\.eq\("brokerage_id", (?:brokerageId|args\.brokerageId)\)/g) ?? []).length >= 6)
  check("the starter is server-only and never a 'use server' door",
    /^import "server-only"/m.test(starter) && !/^"use server"/m.test(starter))

  const cron = code("app/api/cron/listing-presentation-prep/route.ts")
  check("cron reads BOTH listing-appointment spellings", /\.in\("event_type", \[\.\.\.LISTING_APPOINTMENT_BOOKING_EVENT_TYPES\]\)/.test(cron))
  check("cron decides through decideSafetyNetAction and resolves through the SAME core",
    cron.includes("decideSafetyNetAction(") && cron.includes("resolveBookingPrepContext(") && !/function resolveSubjectProperty/.test(cron))
  check("[control] a cron that kept its own resolver would be caught", /function resolveSubjectProperty/.test("async function resolveSubjectProperty(svc) {}"))

  const builder = code("lib/workflow/intelligence/listing-presentation-builder.ts")
  const idem = builder.indexOf("loadPresentationForAppointment(svc, input.brokerageId, input.appointmentId)")
  const cma = builder.indexOf("await runAiCma(")
  check("builder: one presentation per appointment, checked BEFORE the paid CMA", idem > 0 && cma > 0 && idem < cma)
  check("builder: a lost insert race (23505) re-reads the winner instead of failing", /code === "23505"/.test(builder))
  const m667 = readFileSync(join(ROOT, "supabase/migrations/m667-one-presentation-per-booking-and-did-first.sql"), "utf8")
  check("m667 adds the partial UNIQUE index on listing_presentations(appointment_id)",
    /CREATE UNIQUE INDEX IF NOT EXISTS listing_presentations_one_per_appointment\s+ON public\.listing_presentations \(appointment_id\)\s+WHERE appointment_id IS NOT NULL/.test(m667))

  const chain = code("lib/workflow-orchestrator/chains/listing-appt-prep.ts")
  check("the chain's presentation step resolves agents.id INSIDE the run's tenant",
    /\.eq\("user_id", ctx\.agentUserId\)\s*\.eq\("brokerage_id", ctx\.brokerageId\)[\s\S]{0,200}Agent profile not found/.test(chain))

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log("FAILURES:\n  - " + failures.join("\n  - ")); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
