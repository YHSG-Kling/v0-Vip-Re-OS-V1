/**
 * scripts/listing-prep-from-booking-simulator.ts   (npm run test:listing-prep-from-booking)
 *
 * WAVE 87 (lane 87B) → RE-ANCHORED ON THE SURVIVOR, WAVE 88 (lane 88D).
 *
 * Owner, wave 87: "listing presentation prep which inlcudes the cma needs to be for a
 * seller as this is started from the listing appointmtent booking."
 * Owner, wave 88: "listing appointment already coded and built the listing prep or
 * listing presentation/cma automation with drip including video sections to win the
 * seller's listing before stepping into the listing appointment. you now just wrote it
 * again in the last wave."
 *
 * THE SURVIVOR is the original chain, lib/workflow-orchestrator/chains/listing-appt-prep.ts
 * (CMA → presentation → chapter reels → section drip → kit), started — as it always
 * declared — from the `listing.appointment_set` event. Lane 87B's second module
 * (lib/listing-presentation/booking-prep.ts) is deleted; its seller gate, booking gate,
 * booking-row resolution and cron decision now live at the chain's foot, and its starter
 * is the chain's own trigger, fireListingAppointmentSetForBooking.
 *
 * Proves, with no network and no model / AVM / D-ID spend:
 *   §1 PURE RULES — seller gate, booking gate, cron safety-net decision, each with a
 *      positive and a negative control.
 *   §2 RESOLUTION on an in-memory service client — tenant = the booking row's; buyer
 *      refused; home-value seller from the matching valuation request; listing consult
 *      from the listing; agents.id resolved to users.id in the tenant; tentative hold
 *      deferred; cancelled skipped; foreign-tenant contact invisible; a refused read is
 *      an error.
 *   §3 THE TRIGGER, EXECUTED — the booking records ONE `listing.appointment_set` lifecycle
 *      event (the payload carries the seller, the property, the appointment), the event is
 *      DISPATCHED, and the run it produces is keyed on the EVENT id — which satisfies
 *      workflow_runs.trigger_event_id's FK to lifecycle_events (modelled here, with a
 *      positive control that reproduces lane 87B's calendar-id key being refused). A second
 *      fire for the same booking is DEDUPED onto the same event and run; an event that
 *      landed without a run is RE-DISPATCHED; a racing insert refused by m673 (23505)
 *      re-reads the winner.
 *   §4 WIRING (stripped source) — every booking path calls the chain's trigger; none starts
 *      the chain itself; booking-prep.ts is gone and nothing imports it (control); the cron
 *      is the safety net through the SAME chain module; the builder is one-per-appointment
 *      before any paid step; m667 + m673 carry their indexes; the chain queues the pitch
 *      reel; the chapter reels and D-ID section tracks are on the tier VIDEO METER and
 *      rendered D-ID first.
 *
 * BLIND SPOTS (published): the orchestrator's real dispatch (orchestrateEvent →
 * getChainsByTrigger → startRun) binds its own service client, so it is proved by SOURCE
 * (triggerEventId: event.id) and by the live layers of test:listing-appt-prep /
 * test:seller-appt-conversion (they skip without SUPABASE_SERVICE_ROLE_KEY); the dispatcher
 * here is a registered fake that writes the run row the engine would. The live DB is not
 * touched. The Remotion (non-avatar) section slides are not metered — only the paid D-ID
 * renders are.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import {
  classifySellerPrepContext,
  bookingPrepGate,
  decideSafetyNetAction,
  resolveBookingPrepContext,
  fireListingAppointmentSetForBooking,
  listingApptPrepChain,
} from "../lib/workflow-orchestrator/chains/listing-appt-prep"
import { registerEventDispatcher } from "../lib/events/dispatcher-registry"
import { canonicalCalendarEventType } from "../lib/kernel/calendar-types"

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const ROOT = process.cwd()
const code = (rel: string) => stripComments(readFileSync(join(ROOT, rel), "utf8"))
function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walkTs(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

// ── In-memory service client (reads, inserts, JSON-path eq) ─────────────────
type Row = Record<string, any>
function fieldOf(r: Row, c: string): unknown {
  const m = c.match(/^(\w+)->>(\w+)$/)
  if (m) return (r[m[1]] ?? {})[m[2]]
  return r[c]
}
function fakeSvc(tables: Record<string, Row[]>, opts: { refuse?: Set<string>; raceOnce?: Row | null } = {}) {
  const refuse = opts.refuse ?? new Set<string>()
  let race = opts.raceOnce ?? null
  let seq = 0
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let limitN: number | null = null
    let pendingInsert: Row | null = null
    const run = () => {
      if (refuse.has(table)) return { data: null, error: { message: `${table} refused (fixture)` } }
      if (pendingInsert) {
        if (table === "lifecycle_events" && race) {
          // m673: a racing writer landed the same booking's event a moment earlier.
          ;(tables[table] ??= []).push(race); race = null
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"lifecycle_events_one_listing_appointment_set_per_booking\"" } }
        }
        const row = { id: `le-${++seq}`, created_at: new Date().toISOString(), ...pendingInsert }
        ;(tables[table] ??= []).push(row)
        return { data: [row], error: null }
      }
      let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
      if (limitN != null) rows = rows.slice(0, limitN)
      return { data: rows, error: null }
    }
    const q: any = {
      select: () => q,
      insert: (row: Row) => { pendingInsert = row; return q },
      eq: (c: string, v: unknown) => { filters.push((r) => fieldOf(r, c) === v); return q },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(fieldOf(r, c))); return q },
      gte: () => q,
      order: () => q,
      limit: (n: number) => { limitN = n; return q },
      maybeSingle: async () => { const r = run(); return r.error ? r : { data: (r.data as Row[])[0] ?? null, error: null } },
      single: async () => { const r = run(); return r.error ? r : { data: (r.data as Row[])[0] ?? null, error: null } },
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    }
    return q
  }
  return { client: { from } as any, tables }
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
      { id: "e-cal", brokerage_id: T, entity_type: "contact", entity_id: SELLER, event_type: "listing_appointment", status: null, start_at: "2026-10-20T15:00:00Z", location: "9 Oak St, Tampa, FL 33602", metadata: { agentId: AGENT }, agent_user_id: null },
      { id: "e-buyer", brokerage_id: T, entity_type: "contact", entity_id: BUYER, event_type: "listing_appointment", status: null, start_at: "2026-10-20T15:00:00Z", location: "somewhere", metadata: {}, agent_user_id: USER },
      { id: "e-hv", brokerage_id: T, entity_type: "agent", entity_id: AGENT, event_type: "listing_appointment", status: null, start_at: "2026-10-21T15:00:00Z", location: null, metadata: { contact_id: HV, agent_id: AGENT, property_address: "77 Bay Dr" }, agent_user_id: USER },
      { id: "e-listing", brokerage_id: T, entity_type: "listing", entity_id: LISTING, event_type: "listing_appointment", status: null, start_at: "2026-10-22T15:00:00Z", location: null, metadata: { contact_id: BUYER, agent_id: USER }, agent_user_id: USER },
      { id: "e-pending", brokerage_id: T, entity_type: "contact", entity_id: SELLER, event_type: "listing_appointment", status: "pending_agent_confirmation", start_at: "2026-10-23T15:00:00Z", location: null, metadata: {}, agent_user_id: USER },
      { id: "e-cancelled", brokerage_id: T, entity_type: "contact", entity_id: SELLER, event_type: "listing_appointment", status: "cancelled", start_at: "2026-10-23T15:00:00Z", location: null, metadata: {}, agent_user_id: USER },
      { id: "e-isa-generic", brokerage_id: T, entity_type: "contact", entity_id: SELLER, event_type: "isa_appointment", status: "scheduled", start_at: "2026-10-24T15:00:00Z", location: null, metadata: {}, agent_user_id: USER },
      { id: "e-showing", brokerage_id: T, entity_type: "contact", entity_id: SELLER, event_type: "showing", status: null, start_at: "2026-10-23T15:00:00Z", location: null, metadata: {}, agent_user_id: USER },
      { id: "e-isa", brokerage_id: T, entity_type: "contact", entity_id: SELLER, event_type: "listing_appointment", status: "scheduled", start_at: "2026-10-24T15:00:00Z", location: null, metadata: {}, agent_user_id: USER },
      { id: "e-foreign", brokerage_id: OTHER, entity_type: "contact", entity_id: SELLER, event_type: "listing_appointment", status: null, start_at: "2026-10-24T15:00:00Z", location: null, metadata: {}, agent_user_id: null },
    ],
    lifecycle_events: [],
    workflow_runs: [],
  }
}

/** workflow_runs.trigger_event_id → lifecycle_events(id), as the live FK has it. */
function fkViolations(tables: Record<string, Row[]>): string[] {
  const ids = new Set((tables.lifecycle_events ?? []).map((e) => e.id))
  return (tables.workflow_runs ?? []).filter((r) => r.trigger_event_id != null && !ids.has(r.trigger_event_id)).map((r) => String(r.trigger_event_id))
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

  check("the ONE listing-appointment spelling passes the booking gate", bookingPrepGate({ eventType: "listing_appointment", status: "scheduled" }).go)
  check("the retired 'listing_consultation' spelling is folded at the write, never read as a second kind",
    canonicalCalendarEventType("listing_consultation") === "listing_appointment" && !bookingPrepGate({ eventType: "listing_consultation", status: null }).go)
  check("[control] the fold leaves every other event type alone", canonicalCalendarEventType("listing_price_strategy") === "listing_price_strategy" && canonicalCalendarEventType("isa_appointment") === "isa_appointment")
  check("NEGATIVE: a showing is refused as not a listing appointment", (bookingPrepGate({ eventType: "showing", status: null }) as any).outcome === "refused")
  check("a generic ISA meeting ('isa_appointment') is NOT a listing appointment", !bookingPrepGate({ eventType: "isa_appointment", status: null }).go)
  check("a cancelled/superseded booking is skipped", (bookingPrepGate({ eventType: "listing_appointment", status: "cancelled" }) as any).outcome === "skipped")
  check("a tentative hold awaiting the agent is DEFERRED (the confirm fires it)", (bookingPrepGate({ eventType: "listing_appointment", status: "pending_agent_confirmation" }) as any).outcome === "deferred")

  check("safety net: a presentation on file → done", decideSafetyNetAction({ presentationExists: true, runStatuses: ["failed"] }) === "done")
  check("safety net: a live run → in_progress", decideSafetyNetAction({ presentationExists: false, runStatuses: ["completed", "running"] }) === "in_progress")
  check("safety net: a paused (approval-gated) run → in_progress", decideSafetyNetAction({ presentationExists: false, runStatuses: ["paused"] }) === "in_progress")
  check("safety net: no run → start_prep (the booking missed its event)", decideSafetyNetAction({ presentationExists: false, runStatuses: [] }) === "start_prep")
  check("safety net: runs ended with no deck → build_presentation", decideSafetyNetAction({ presentationExists: false, runStatuses: ["failed"] }) === "build_presentation")

  console.log("\n── §2 resolution on the booking row ──")
  {
    const { client } = fakeSvc(world())
    const cal = await resolveBookingPrepContext(client, { calendarEventId: "e-cal", expectedBrokerageId: T })
    check("agent-calendar booking: seller resolved, tenant = booking row", cal.ok && cal.context.contactId === SELLER && cal.context.brokerageId === T, JSON.stringify(cal))
    check("agent-calendar: metadata agents.id is RESOLVED to its users.id inside the tenant", cal.ok && cal.context.agentUserId === USER)
    check("agent-calendar: property from the booked address, state parsed by the ONE splitter",
      cal.ok && cal.context.property.propertyAddress === "9 Oak St" && cal.context.property.state === "FL" && cal.context.property.source === "booking_address")
    const mismatch = await resolveBookingPrepContext(client, { calendarEventId: "e-cal", expectedBrokerageId: OTHER })
    check("NEGATIVE: a session tenant that is not the booking row's is refused", !mismatch.ok && mismatch.reason === "booking_not_in_caller_tenant")
    const b = await resolveBookingPrepContext(client, { calendarEventId: "e-buyer" })
    check("NEGATIVE: a buyer's consultation gets NO seller prep", !b.ok && b.outcome === "refused" && b.reason === "not_a_seller:buyer", JSON.stringify(b))
    const hv = await resolveBookingPrepContext(client, { calendarEventId: "e-hv" })
    check("home-value self-booking: the valuation request is the seller evidence", hv.ok && hv.context.sellerBasis === "valuation_request")
    check("home-value: the valuation request MATCHING the booked address is used (not merely the newest)",
      hv.ok && hv.context.property.propertyAddress === "77 Bay Dr" && hv.context.property.sqft === 1700)
    check("home-value: listingId stays null — an agents.id in entity_id is never a listing", hv.ok && hv.context.property.listingId === null)
    const li = await resolveBookingPrepContext(client, { calendarEventId: "e-listing" })
    check("listing consult: the listing's seller qualifies, property from the listing row",
      li.ok && li.context.sellerBasis === "listing_seller" && li.context.property.source === "listing" && li.context.property.listingId === LISTING)
    check("AI-ISA tentative hold: DEFERRED until the agent confirms", (await fireListingAppointmentSetForBooking(client, { calendarEventId: "e-pending", origin: "sim" })).status === "deferred")
    check("superseded hold: skipped", (await fireListingAppointmentSetForBooking(client, { calendarEventId: "e-cancelled", origin: "sim" })).status === "skipped")
    check("a showing: refused", (await fireListingAppointmentSetForBooking(client, { calendarEventId: "e-showing", origin: "sim" })).status === "refused")
    check("a generic ISA meeting row: refused", (await fireListingAppointmentSetForBooking(client, { calendarEventId: "e-isa-generic", origin: "sim" })).status === "refused")
    const isa = await resolveBookingPrepContext(client, { calendarEventId: "e-isa", propertyHint: { address: "5 Pine Ct, Tampa, FL 33605", bedrooms: 3 } })
    check("ISA seller milestone: the caller's captured property is used (hint, state parsed)",
      isa.ok && isa.context.property.source === "caller_hint" && isa.context.property.propertyAddress === "5 Pine Ct" && isa.context.property.state === "FL" && isa.context.property.bedrooms === 3)
    const foreign = await resolveBookingPrepContext(client, { calendarEventId: "e-foreign" })
    check("NEGATIVE: a contact outside the booking row's tenant is invisible → refused", !foreign.ok && foreign.reason === "no_seller_contact")
  }
  {
    const { client } = fakeSvc(world(), { refuse: new Set(["contacts"]) })
    const r = await fireListingAppointmentSetForBooking(client, { calendarEventId: "e-cal", origin: "sim" })
    check("a REFUSED read is an error, never 'not a seller' (§3)", r.status === "error" && /contact read refused/.test((r as any).reason))
  }

  console.log("\n── §3 the trigger, executed: ONE listing.appointment_set event per booking ──")
  // The registered dispatcher stands in for orchestrateEvent → getChainsByTrigger →
  // engine startRun: it writes the run row the engine writes, keyed on the EVENT id.
  let tablesRef: Record<string, Row[]> = {}
  const dispatched: Row[] = []
  registerEventDispatcher(async (event) => {
    dispatched.push(event as Row)
    for (const chain of [listingApptPrepChain].filter((c) => c.triggerEvent === event.event_type)) {
      ;(tablesRef.workflow_runs ??= []).push({
        id: `run-${dispatched.length}`, chain_key: chain.key, brokerage_id: event.brokerage_id,
        trigger_event: event.event_type, trigger_event_id: event.id, status: "running",
        metadata: event.payload, contact_id: (event.payload as Row)?.contact_id ?? null,
      })
    }
  })
  {
    const w = fakeSvc(world()); tablesRef = w.tables
    const first = await fireListingAppointmentSetForBooking(w.client, { calendarEventId: "e-hv", expectedBrokerageId: T, origin: "seller_self_booking" })
    const events = w.tables.lifecycle_events
    check("the booking records ONE listing.appointment_set lifecycle event in the booking's tenant",
      first.status === "started" && events.length === 1 && events[0].event_type === "listing.appointment_set" && events[0].brokerage_id === T, JSON.stringify(first))
    check("the event is about the BOOKING (entity calendar_event) and deduped on it",
      events[0]?.entity_type === "calendar_event" && events[0]?.entity_id === "e-hv" && events[0]?.dedupe_key === "listing.appointment_set:e-hv")
    const pl = (events[0]?.metadata ?? {}) as Row
    check("the event payload carries the SELLER, the appointment and the seller's property for the chain",
      pl.contact_id === HV && pl.appointment_id === "e-hv" && pl.appointment_date === "2026-10-21T15:00:00Z" &&
      pl.property_data?.address === "77 Bay Dr" && pl.property_data?.state === "FL" && pl.agent_user_id === USER && pl.seller_prep?.basis === "valuation_request")
    check("the actor on the event is the agent's users.id (proven in the tenant)", events[0]?.actor_user_id === USER)
    check("the event was DISPATCHED and produced the chain's run", dispatched.length === 1 && first.status === "started" && (first as any).runId === "run-1")
    const run = w.tables.workflow_runs[0]
    check("the run is keyed on the EVENT id (never the calendar id)", run?.trigger_event_id === events[0]?.id && run?.trigger_event_id !== "e-hv")
    check("workflow_runs.trigger_event_id satisfies its FK to lifecycle_events (modelled)", fkViolations(w.tables).length === 0, fkViolations(w.tables).join(","))
    check("[control] lane 87B's key — the calendar row id — is REFUSED by that FK",
      fkViolations({ lifecycle_events: w.tables.lifecycle_events, workflow_runs: [{ trigger_event_id: "e-hv" }] }).length === 1)

    const again = await fireListingAppointmentSetForBooking(w.client, { calendarEventId: "e-hv", origin: "cron_safety_net" })
    check("a second fire for the same booking is DEDUPED onto the same event and run — no second event, no second dispatch",
      again.status === "deduped" && (again as any).eventId === events[0].id && (again as any).runId === "run-1" &&
      w.tables.lifecycle_events.length === 1 && dispatched.length === 1, JSON.stringify(again))
  }
  {
    // An event that landed but never produced a run (dispatch failed after the insert).
    const w = fakeSvc(world()); tablesRef = w.tables
    w.tables.lifecycle_events.push({ id: "le-orphan", brokerage_id: T, event_type: "listing.appointment_set", dedupe_key: "listing.appointment_set:e-cal", metadata: { contact_id: SELLER, appointment_id: "e-cal" }, actor_user_id: USER, created_at: "2026-09-28T00:00:00Z" })
    const before = dispatched.length
    const r = await fireListingAppointmentSetForBooking(w.client, { calendarEventId: "e-cal", origin: "cron_safety_net" })
    check("an event with no run is RE-DISPATCHED (not re-recorded) and its run is keyed on it",
      r.status === "deduped" && dispatched.length === before + 1 && w.tables.lifecycle_events.length === 1 &&
      w.tables.workflow_runs[0]?.trigger_event_id === "le-orphan", JSON.stringify(r))
  }
  {
    // m673 race: the insert is refused 23505 because a racing writer landed first.
    const winner = { id: "le-winner", brokerage_id: T, event_type: "listing.appointment_set", dedupe_key: "listing.appointment_set:e-listing", metadata: { contact_id: BUYER, appointment_id: "e-listing" }, actor_user_id: USER, created_at: "2026-09-28T00:00:00Z" }
    const w = fakeSvc(world(), { raceOnce: winner }); tablesRef = w.tables
    w.tables.workflow_runs.push({ id: "run-winner", chain_key: "listing-appt-prep", brokerage_id: T, trigger_event_id: "le-winner", status: "running", metadata: {} })
    const r = await fireListingAppointmentSetForBooking(w.client, { calendarEventId: "e-listing", origin: "listing_consult" })
    check("a racing insert refused by m673 (23505) re-reads the WINNER — one event, one run",
      r.status === "deduped" && (r as any).eventId === "le-winner" && (r as any).runId === "run-winner" && w.tables.lifecycle_events.length === 1, JSON.stringify(r))
  }
  {
    const w = fakeSvc(world(), { refuse: new Set(["lifecycle_events"]) }); tablesRef = w.tables
    const r = await fireListingAppointmentSetForBooking(w.client, { calendarEventId: "e-cal", origin: "sim" })
    check("a refused dedupe read is an error — never 'no event yet' (no blind insert)", r.status === "error" && /dedupe read refused/.test((r as any).reason))
  }

  console.log("\n── §4 wiring (stripped source) ──")
  const TRIGGER = "fireListingAppointmentSetForBooking("
  const PATHS: Array<[string, string]> = [
    ["app/actions/ai-calendar-management.ts", "agent calendar"],
    ["app/actions/listing-lifecycle.ts", "listing consult + stage pipeline"],
    ["lib/ai-isa/book-seller-appointment.ts", "AI-ISA seller milestone"],
    ["lib/ai-isa/listing-appointment.ts", "AI-ISA / voice booking (at the agent's confirm)"],
    ["app/actions/home-value.ts", "seller self-booking (report page + portal)"],
    ["app/api/cron/listing-presentation-prep/route.ts", "cron safety net"],
  ]
  for (const [rel, label] of PATHS) {
    check(`${label} (${rel}) fires the chain's own trigger`, existsSync(join(ROOT, rel)) && code(rel).includes(TRIGGER))
  }
  check("[control] the finder reports a path that names the trigger only in a comment",
    !stripComments(`// ${TRIGGER} is named only in a comment\nawait triggerChainsForEvent({ eventType: "listing.appointment_set" })`).includes(TRIGGER))
  check("listing-lifecycle fires it on BOTH its booking paths (consult + stage)", (code("app/actions/listing-lifecycle.ts").split(TRIGGER).length - 1) === 2)

  const OLD_START = /triggerChainsForEvent\(\{[\s\S]{0,120}listing\.appointment_set|chainKey:\s*"listing-appt-prep"|startRun\(\{[\s\S]{0,200}triggerEventId:\s*(?:ctx\.)?calendarEventId/
  const starters = [...PATHS.map(([rel]) => rel), "lib/workflow-orchestrator/chains/listing-appt-prep.ts"]
  const offenders = starters.filter((rel) => OLD_START.test(code(rel)))
  check("no booking path — and not the chain's trigger — starts the chain itself or keys a run on a calendar id", offenders.length === 0, offenders.join(", "))
  check("[control] the old-start finder catches all three retired shapes",
    OLD_START.test(`await triggerChainsForEvent({ eventType: "listing.appointment_set", brokerageId })`) &&
    OLD_START.test(`await startRun({ chainKey: "listing-appt-prep", brokerageId })`) &&
    OLD_START.test(`const run = await startRun({ chainKey: KEY, triggerEventId: ctx.calendarEventId })`))

  // THE DUPLICATE IS GONE (§1.1): no second starter module, nothing imports it.
  check("lib/listing-presentation/booking-prep.ts is deleted", !existsSync(join(ROOT, "lib/listing-presentation/booking-prep.ts")))
  const IMPORTS_DUP = /from\s+["'][^"']*listing-presentation\/booking-prep["']|import\(\s*["'][^"']*listing-presentation\/booking-prep["']\s*\)/
  const dupImporters = ["app", "lib", "components"].filter((d) => existsSync(join(ROOT, d))).flatMap((d) => walkTs(join(ROOT, d)))
    .filter((f) => IMPORTS_DUP.test(stripComments(readFileSync(f, "utf8"))))
    .map((f) => f.slice(ROOT.length + 1))
  check("no file in app/ lib/ components/ imports the retired module", dupImporters.length === 0, dupImporters.join(", "))
  check("[control] the importer finder sees both import shapes",
    IMPORTS_DUP.test(`import { x } from "@/lib/listing-presentation/booking-prep"`) && IMPORTS_DUP.test(`await import("@/lib/listing-presentation/booking-prep")`))
  const chainRaw = readFileSync(join(ROOT, "lib/workflow-orchestrator/chains/listing-appt-prep.ts"), "utf8")
  check("the tombstone names the survivor and where each retired export went",
    /TOMBSTONE \(lane 88D[\s\S]{0,400}lib\/listing-presentation\/booking-prep\.ts[\s\S]{0,1200}fireListingAppointmentSetForBooking/.test(chainRaw))

  const chain = code("lib/workflow-orchestrator/chains/listing-appt-prep.ts")
  check("the chain's trigger records the event through the ONE sessionless lifecycle-event core",
    /import\("@\/lib\/events\/lifecycle-event-core"\)/.test(chain) && /recordLifecycleEvent\(svc, ctx\.brokerageId,/.test(chain))
  check("the chain's trigger is its own declared trigger event and key (no second constant)",
    /event_type: listingApptPrepChain\.triggerEvent/.test(chain) && /\.eq\("chain_key", listingApptPrepChain\.key\)/.test(chain) && !/"listing\.appointment_set"/.test(chain.split("export const listingApptPrepChain")[1]?.split("steps:")[1] ?? ""))
  check("the chain's trigger reads the booking row's tenant; a session caller's must match",
    /const brokerageId = r\.brokerage_id/.test(chain) && /params\.expectedBrokerageId !== brokerageId/.test(chain))
  check("every seller/property/agent read in the trigger is pinned to that tenant",
    (chain.match(/\.eq\("brokerage_id", (?:brokerageId|args\.brokerageId|ctx\.brokerageId)\)/g) ?? []).length >= 8)
  const orch = code("lib/orchestrator/internal.ts")
  check("the orchestrator starts the chain from the event with triggerEventId = event.id",
    /getChainsByTrigger\(event\.event_type\)[\s\S]{0,600}triggerEventId:\s*event\.id/.test(orch))
  check("the chain's presentation step resolves agents.id INSIDE the run's tenant",
    /\.eq\("user_id", ctx\.agentUserId\)\s*\.eq\("brokerage_id", ctx\.brokerageId\)[\s\S]{0,200}Agent profile not found/.test(chain))
  check("the chain queues the pitch reel for the appointment (it used to come only from the cron's direct build)",
    /generate_presentation[\s\S]*queueListingPitchReel\(svc, \{[\s\S]{0,200}appointmentId/.test(chain))

  // §6 — ONE SPELLING at every writer (lane 87B2).
  const scheduler = code("lib/ai-isa/appointment-scheduler.ts")
  const milestone = code("lib/ai-isa/book-seller-appointment.ts")
  check("the ISA seller milestone books the ONE listing-appointment spelling",
    /event_type:\s*params\.eventType \?\? CalendarEventType\.ISA_APPOINTMENT/.test(scheduler) && /eventType: CalendarEventType\.LISTING_APPOINTMENT/.test(milestone) && !/isaListingAppointment/.test(milestone))
  const cal = code("app/actions/ai-calendar-management.ts")
  check("the agent calendar folds the posted type at the write and gates prep on the survivor",
    /event_type: canonicalCalendarEventType\(/.test(cal) && /canonicalCalendarEventType\(params\.type \?\? ""\) === CalendarEventType\.LISTING_APPOINTMENT/.test(cal))
  const LEGACY = /["']listing_consultation["']/
  const legacyHits = ["app", "lib"].flatMap((d) => walkTs(join(ROOT, d)))
    .filter((f) => !f.endsWith("lib/kernel/calendar-types.ts"))
    .filter((f) => LEGACY.test(stripComments(readFileSync(f, "utf8"))))
    .map((f) => f.slice(ROOT.length + 1))
  check("no reader or writer in app/ + lib/ still names 'listing_consultation' (the fold lives only in calendar-types)", legacyHits.length === 0, legacyHits.join(", "))
  check("[control] the legacy-spelling finder sees a live literal", LEGACY.test(stripComments(`event_type: "listing_consultation"`)))

  const cron = code("app/api/cron/listing-presentation-prep/route.ts")
  check("cron reads the ONE listing-appointment spelling", /\.eq\("event_type", CalendarEventType\.LISTING_APPOINTMENT\)/.test(cron))
  check("cron decides through decideSafetyNetAction and resolves through the SAME chain module",
    cron.includes("decideSafetyNetAction(") && cron.includes("resolveBookingPrepContext(") &&
    /from "@\/lib\/workflow-orchestrator\/chains\/listing-appt-prep"/.test(cron) && !/function resolveSubjectProperty/.test(cron))
  check("[control] a cron that kept its own resolver would be caught", /function resolveSubjectProperty/.test("async function resolveSubjectProperty(svc) {}"))

  const builder = code("lib/workflow/intelligence/listing-presentation-builder.ts")
  const idem = builder.indexOf("loadPresentationForAppointment(svc, input.brokerageId, input.appointmentId)")
  const cmaAt = builder.indexOf("await runAiCma(")
  check("builder: one presentation per appointment, checked BEFORE the paid CMA", idem > 0 && cmaAt > 0 && idem < cmaAt)
  check("builder: a lost insert race (23505) re-reads the winner instead of failing", /code === "23505"/.test(builder))
  check("builder: materializes the seller's section drip (render + narration) on every build",
    /materializePresentationSections\(pres\.id, svc\)/.test(builder))
  const m667 = readFileSync(join(ROOT, "supabase/migrations/m667-one-presentation-per-booking-and-did-first.sql"), "utf8")
  check("m667 adds the partial UNIQUE index on listing_presentations(appointment_id)",
    /CREATE UNIQUE INDEX IF NOT EXISTS listing_presentations_one_per_appointment\s+ON public\.listing_presentations \(appointment_id\)\s+WHERE appointment_id IS NOT NULL/.test(m667))
  const m673 = readFileSync(join(ROOT, "supabase/migrations/m673-one-listing-appointment-set-event-per-booking.sql"), "utf8")
  check("m673 makes ONE listing.appointment_set event per booking (partial UNIQUE on brokerage_id, dedupe_key)",
    /CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_events_one_listing_appointment_set_per_booking\s+ON public\.lifecycle_events \(brokerage_id, dedupe_key\)\s+WHERE event_type = 'listing\.appointment_set' AND dedupe_key IS NOT NULL/.test(m673))

  // THE VIDEO SECTIONS RUN, METERED, D-ID FIRST.
  const chapters = code("lib/video/chapter-video-generator.ts")
  const METERED = (src: string, feature: string) => {
    const gate = src.indexOf("gateVideoCreation(")
    const dispatch = Math.max(src.indexOf("dispatchVideo({"), src.indexOf("submitAvatarTrack(supabase"))
    const meter = src.search(new RegExp(`meterVideoCreation\\(\\{[\\s\\S]{0,400}feature:\\s*"${feature}"[\\s\\S]{0,120}autonomous:\\s*true`))
    return gate > 0 && dispatch > 0 && gate < dispatch && meter > dispatch
  }
  check("chapter reels: gated on the tier video meter BEFORE the D-ID dispatch and COUNTED after it (autonomous)", METERED(chapters, "presentation_chapter"))
  check("chapter reels are submitted to D-ID (provider 'did', the poller's adoption triple)",
    /dispatchVideo\(\{/.test(chapters) && /video_provider:\s*"did"/.test(chapters) && /provider:\s*"did"/.test(chapters))
  const narr = code("lib/listing-presentation/section-narration-orchestrator.ts")
  check("section avatar tracks: gated BEFORE the D-ID submit and COUNTED once D-ID has the job (autonomous)", METERED(narr, "presentation_section"))
  check("[control] the meter finder rejects a render path that never counts",
    !METERED(`const x = await dispatchVideo({ brokerageId })`, "presentation_chapter") &&
    !METERED(`await meterVideoCreation({ feature: "presentation_chapter", autonomous: true }); await dispatchVideo({ a })`, "presentation_chapter"))
  const meterSrc = code("lib/kernel/content-creators.ts")
  check("the meter is the SAME one lib/kernel/content-creators.ts createVideoProject counts on",
    /import\("@\/lib\/video\/video-metering"\)/.test(meterSrc) && /import\("@\/lib\/video\/video-metering"\)/.test(chapters) && /import\("@\/lib\/video\/video-metering"\)/.test(narr))

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log("FAILURES:\n  - " + failures.join("\n  - ")); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
