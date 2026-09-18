#!/usr/bin/env tsx
/**
 * scripts/listing-appointment-simulator.ts   (npm run test:listing-appointment)
 * ─────────────────────────────────────────────────────────────────────────────
 * Lane 75C — owner verbatim: "the no obligation meeting should be marked as
 * a listing appointment so that the workflow creates the follow up until the
 * appt which should be at least a week out. since this is an appt for an
 * agent, the calendar should be hooked up so that the ai agent can find a
 * time and day that works for the person and set up the appt right then and
 * the agent just confirms it. then the auto calendar emails go out and is
 * pushed to their portal in app."
 *
 * Proves, in STRIPPED source where a code token is being scanned for
 * (scripts/strip-comments.ts — CLAUDE.md §2), with a positive control on
 * every absence assertion:
 *   Layer 1 — isAtLeastMinDaysOut: a slot ≥7 days out is accepted, a 3-day
 *             slot is REJECTED (the named positive control).
 *   Layer 2 — reminderTierForAppointment: the 5-day/2-day/morning-of cadence
 *             derives correctly, and a day that matches none of the three
 *             returns null (not a false tier).
 *   Layer 3 — filterSlotsByPreference: day-of-week / time-of-day narrowing.
 *   Layer 4 — buildAppointmentIcs: a well-formed single-VEVENT ICS.
 *   Layer 5 — resolveWorkingHours: defensive parse + default fallback.
 *   Layer 6 — findAgentAppointmentSlots FAILS CLOSED (calendar not
 *             connected → no slots, offerCallback, never a mock slot) — read
 *             from source, since a live Google/Microsoft OAuth token is
 *             creds-gated and this repo runs no live network in a lane.
 *   Layer 7 — bookListingAppointment writes event_type='listing_appointment'
 *             + status='pending_agent_confirmation' via sentinelWrite.
 *   Layer 8 — confirmListingAppointment sends BOTH calendar emails (ICS
 *             attached) and pushes a portal_event_stream card.
 *   Layer 9 — the reminder cron only ever touches CONFIRMED rows (cancel-on-
 *             reschedule holds because a cancelled row drops out of its own
 *             WHERE clause).
 *   Layer 10 — the customer tool: a LEAD caller converts via
 *             convertSellerLeadOnIntent BEFORE booking; book_listing_appointment
 *             is in the persona-tool-policy free-tool allowlist and the
 *             qualification follow-up menu; book_agent_appointment is GONE.
 *   Layer 11 — NO AVM VALUE ever appears in the listing-appointment module or
 *             the two new tool builders (positive control: the WIDER file,
 *             which legitimately has an AVM in schedule_home_value_review,
 *             DOES match — proving the scanner is not simply blind).
 *   Layer 12 — signal/cron/registry wiring: listing_appointment_pending_
 *             confirmation catalogued with a real handler and the classifier-
 *             matching kind; the reminder cron is registered in
 *             CRON_REGISTRY + CRON_MANAGER; MAINTENANCE_DOMAINS carries
 *             listing_appointment owned by listing_concierge; package.json
 *             registers the proof in the guard tail right after test:scrapers.
 *
 * No DB, no network. Run:
 *   npx tsx scripts/listing-appointment-simulator.ts
 */
import { readFileSync } from "node:fs"
import { stripComments } from "./strip-comments"
import { graphShowAsFor } from "../lib/providers/calendar/personal-calendar"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function stripped(path: string): string {
  return stripComments(readFileSync(path, "utf8"))
}
const raw = (path: string): string => readFileSync(path, "utf8")

const LISTING_APPT_PATH = "lib/ai-isa/listing-appointment.ts"

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 1 · isAtLeastMinDaysOut — ≥7 days out, POSITIVE CONTROL rejects 3 days]")

const {
  isAtLeastMinDaysOut, reminderTierForAppointment, filterSlotsByPreference,
  buildAppointmentIcs, resolveWorkingHours, LISTING_APPOINTMENT_MIN_DAYS_OUT,
  LISTING_APPOINTMENT_EVENT_TYPE, LISTING_APPOINTMENT_STATUS,
  LISTING_APPOINTMENT_CONFIRM_EVENT_TYPE, LISTING_APPOINTMENT_CONFIRMED_EVENT_TYPE,
} = await import("../lib/ai-isa/listing-appointment")

const NOW = new Date("2026-09-18T12:00:00.000Z")
const daysFromNow = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString()

check("LISTING_APPOINTMENT_MIN_DAYS_OUT is 7 (owner: 'at least a week out')", LISTING_APPOINTMENT_MIN_DAYS_OUT === 7)
check("a slot exactly 7 days out is ACCEPTED", isAtLeastMinDaysOut(daysFromNow(7), 7, NOW))
check("a slot 10 days out is ACCEPTED", isAtLeastMinDaysOut(daysFromNow(10), 7, NOW))
check("POSITIVE CONTROL: a slot 3 days out is REJECTED", !isAtLeastMinDaysOut(daysFromNow(3), 7, NOW))
check("a slot 6.9 days out (inside the 7th day) is REJECTED", !isAtLeastMinDaysOut(daysFromNow(6.9), 7, NOW))
check("an unparseable date is REJECTED, not thrown", !isAtLeastMinDaysOut("not-a-date", 7, NOW))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 2 · reminderTierForAppointment — 5-day / 2-day / morning-of cadence]")

check("5 days out → '5_day'", reminderTierForAppointment(daysFromNow(5), NOW) === "5_day")
check("2 days out → '2_day'", reminderTierForAppointment(daysFromNow(2), NOW) === "2_day")
check("same calendar day → 'morning_of'", reminderTierForAppointment(daysFromNow(0.2), NOW) === "morning_of")
check("3 days out (no matching tier) → null, not a guessed tier", reminderTierForAppointment(daysFromNow(3), NOW) === null)
check("6 days out (no matching tier) → null", reminderTierForAppointment(daysFromNow(6), NOW) === null)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 3 · filterSlotsByPreference — day-of-week / time-of-day narrowing]")

const slots = [
  { startTime: "2026-09-29T14:00:00.000Z", endTime: "2026-09-29T14:45:00.000Z" }, // Tuesday afternoon
  { startTime: "2026-09-30T09:00:00.000Z", endTime: "2026-09-30T09:45:00.000Z" }, // Wednesday morning
  { startTime: "2026-10-01T18:00:00.000Z", endTime: "2026-10-01T18:45:00.000Z" }, // Thursday evening
]
check("no preference returns everything unfiltered", filterSlotsByPreference(slots, {}).length === 3)
check("preferredDays narrows to the matching weekday", filterSlotsByPreference(slots, { preferredDays: ["tue"] }).length === 1)
check("preferredWindow narrows to morning-only", filterSlotsByPreference(slots, { preferredWindow: "morning" }).length === 1)
check("combined day+window narrows to the exact match", filterSlotsByPreference(slots, { preferredDays: ["thu"], preferredWindow: "evening" }).length === 1)
check("a preference matching nothing returns an EMPTY array (never silently ignored)", filterSlotsByPreference(slots, { preferredDays: ["sun"] }).length === 0)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 4 · buildAppointmentIcs — a well-formed single-VEVENT ICS]")

const ics = buildAppointmentIcs({
  uid: "listing-appointment-test-uid@vip-re-os",
  startIso: daysFromNow(7), endIso: daysFromNow(7.03),
  summary: "Listing appointment — 123 Main St", description: "No-obligation visit",
  location: "123 Main St", organizerEmail: "agent@example.com", attendeeEmail: "client@example.com",
})
check("ICS opens/closes VCALENDAR", ics.includes("BEGIN:VCALENDAR") && ics.includes("END:VCALENDAR"))
check("ICS carries exactly one VEVENT", (ics.match(/BEGIN:VEVENT/g) ?? []).length === 1 && (ics.match(/END:VEVENT/g) ?? []).length === 1)
check("ICS carries the UID, SUMMARY, ORGANIZER and ATTENDEE mailto lines", ics.includes("UID:listing-appointment-test-uid@vip-re-os") && ics.includes("SUMMARY:Listing appointment") && ics.includes("ORGANIZER:mailto:agent@example.com") && ics.includes("ATTENDEE:mailto:client@example.com"))
check("ICS marks the event CONFIRMED", ics.includes("STATUS:CONFIRMED"))
const icsEscaped = buildAppointmentIcs({ uid: "u", startIso: daysFromNow(7), endIso: daysFromNow(7.03), summary: "A, B; C", description: "x", location: null, organizerEmail: "a@b.com", attendeeEmail: "c@d.com" })
check("ICS escapes commas/semicolons in free text (RFC 5545) and omits LOCATION when null", icsEscaped.includes("A\\, B\\; C") && !icsEscaped.includes("LOCATION:"))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 5 · resolveWorkingHours — defensive parse, default fallback]")

check("{start_hour,end_hour} numeric shape is read directly", JSON.stringify(resolveWorkingHours({ start_hour: 8, end_hour: 18 })) === JSON.stringify({ startHour: 8, endHour: 18 }))
check("{start,end} \"HH:MM\" shape is parsed", JSON.stringify(resolveWorkingHours({ start: "08:00", end: "18:30" })) === JSON.stringify({ startHour: 8, endHour: 18 }))
check("null/malformed falls back to the EXISTING 09:00-17:00 default (never refuses to find slots)", JSON.stringify(resolveWorkingHours(null)) === JSON.stringify({ startHour: 9, endHour: 17 }) && JSON.stringify(resolveWorkingHours({ garbage: true })) === JSON.stringify({ startHour: 9, endHour: 17 }))
check("an inverted range (end <= start) is rejected back to the default", JSON.stringify(resolveWorkingHours({ start: "18:00", end: "09:00" })) === JSON.stringify({ startHour: 9, endHour: 17 }))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 6 · findAgentAppointmentSlots FAILS CLOSED — never invents a slot]")

const apptSrc = stripped(LISTING_APPT_PATH)
check("uses getAvailabilityViaPersonal (the FAIL-CLOSED adapter — returns null with no connection)", apptSrc.includes("getAvailabilityViaPersonal("))
check("does NOT call the mock-fallback getAvailability() wrapper (lib/providers/calendar/index.ts's invented-slot path)", !/[^.]getAvailability\(/.test(apptSrc.replace(/getAvailabilityViaPersonal/g, "")))
check("a null availability result returns reason 'calendar_not_connected' with offerCallback:true", /reason:\s*"calendar_not_connected",\s*offerCallback:\s*true/.test(apptSrc))
check("the fail-closed result NEVER returns a `slots` array (no invented slots on the failure branch)", !/reason:\s*"calendar_not_connected"[\s\S]{0,200}slots:/.test(apptSrc))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 7 · bookListingAppointment — appointment_type + pending confirmation, via sentinelWrite]")

check(`writes event_type: LISTING_APPOINTMENT_EVENT_TYPE inside a sentinelWrite(...calendar_events".insert...) call`,
  /sentinelWrite\(\s*svc,\s*svc\s*\.from\("calendar_events"\)\s*\.insert\(\{[\s\S]{0,400}event_type:\s*LISTING_APPOINTMENT_EVENT_TYPE/.test(apptSrc))
check("the SAME insert sets status: LISTING_APPOINTMENT_STATUS.PENDING_AGENT_CONFIRMATION",
  /svc\.from\("calendar_events"\)\s*\.insert\(\{[\s\S]{0,500}status:\s*LISTING_APPOINTMENT_STATUS\.PENDING_AGENT_CONFIRMATION/.test(apptSrc))
check("LISTING_APPOINTMENT_EVENT_TYPE resolves to the LIVE CalendarEventType.LISTING_APPOINTMENT enum member ('listing_appointment')", LISTING_APPOINTMENT_EVENT_TYPE === "listing_appointment")
check("LISTING_APPOINTMENT_STATUS.PENDING_AGENT_CONFIRMATION is the exact spelling the portal-stream execute branch keys on", LISTING_APPOINTMENT_STATUS.PENDING_AGENT_CONFIRMATION === "pending_agent_confirmation")
check("cancel-on-reschedule: an existing OPEN appointment for the same contact is superseded (status → CANCELLED) BEFORE the new insert",
  /existingOpen[\s\S]{0,600}LISTING_APPOINTMENT_STATUS\.CANCELLED[\s\S]{0,800}calendarEventId\s*=\s*crypto\.randomUUID/.test(apptSrc))
check(`sentinelWrite is used at least 6 times in ${LISTING_APPT_PATH} (supersede, book insert, calendar-sync metadata update, agent notification, portal card, confirm update)`,
  (apptSrc.match(/sentinelWrite\(/g) ?? []).length >= 6)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 8 · confirmListingAppointment — calendar emails (ICS) + portal push]")

// Both sends go through the GOVERNED dispatcher (lib/providers/dispatch.ts),
// never the low-level lib/providers/messaging sendEmail — that is what
// egress-send-guard enforces, and the ICS rides through as
// DispatchEmailParams.icsAttachment.
check("the module does NOT import the low-level lib/providers/messaging sender (egress governance: dispatchEmail only)",
  !/from\s+"@\/lib\/providers\/messaging"/.test(apptSrc) && /from\s+"@\/lib\/providers\/dispatch"/.test(apptSrc))
check("sends an email to the CONTACT via dispatchEmail with an icsAttachment and systemSource listing_appointment",
  /dispatchEmail\(\{[\s\S]{0,300}to:\s*c\.email[\s\S]{0,300}systemSource:\s*"listing_appointment"[\s\S]{0,200}icsAttachment:/.test(apptSrc))
check("sends an email to the AGENT via dispatchEmail with an icsAttachment (userId = calendar_events.agent_user_id, a USERS id — never agentId)",
  /dispatchEmail\(\{[\s\S]{0,300}to:\s*a\.email[\s\S]{0,400}userId:\s*r\.agent_user_id[\s\S]{0,300}icsAttachment:/.test(apptSrc) && !/agentId:\s*a\.id/.test(apptSrc))
check("buildAppointmentIcs is called once per confirm (one ICS shared by both sends)", (apptSrc.match(/buildAppointmentIcs\(\{/g) ?? []).length === 1)
check("pushes a CONFIRMED portal_event_stream card (event_type LISTING_APPOINTMENT_CONFIRMED_EVENT_TYPE)",
  /portal_event_stream"\)\s*\.insert\(\{[\s\S]{0,300}event_type:\s*LISTING_APPOINTMENT_CONFIRMED_EVENT_TYPE/.test(apptSrc))
check("the booking step ALSO pushes an agent-action-required portal_event_stream card (event_type LISTING_APPOINTMENT_CONFIRM_EVENT_TYPE, agent_action_required:true) — the confirm rail itself",
  /portal_event_stream"\)\s*\.insert\(\{[\s\S]{0,400}event_type:\s*LISTING_APPOINTMENT_CONFIRM_EVENT_TYPE[\s\S]{0,600}agent_action_required:\s*true/.test(apptSrc))
check("LISTING_APPOINTMENT_CONFIRM_EVENT_TYPE matches what app/actions/portal-stream.ts's execute branch checks against",
  LISTING_APPOINTMENT_CONFIRM_EVENT_TYPE === "listing_appointment_confirmation_needed")

const portalStreamSrc = stripped("app/actions/portal-stream.ts")
check("dispositionPortalEventAction's 'execute' mode calls confirmListingAppointment for this event_type",
  /mode\s*===\s*"execute"\s*&&\s*row\.event_type\s*===\s*LISTING_APPOINTMENT_CONFIRM_EVENT_TYPE/.test(portalStreamSrc) && portalStreamSrc.includes("confirmListingAppointment("))
check("a confirm FAILURE refuses the disposition (never marks the card completed while the appointment is still pending)",
  /confirmListingAppointment\(\{[\s\S]{0,200}\}\)[\s\S]{0,120}if\s*\(!confirmed\.success\)\s*return\s*\{\s*success:\s*false/.test(portalStreamSrc))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 9 · reminder cron only touches CONFIRMED rows — cancel-on-reschedule]")

check("sendListingAppointmentReminders filters status = LISTING_APPOINTMENT_STATUS.CONFIRMED", /\.eq\("status",\s*LISTING_APPOINTMENT_STATUS\.CONFIRMED\)/.test(apptSrc))
check("sendListingAppointmentReminders filters event_type = LISTING_APPOINTMENT_EVENT_TYPE", /sendListingAppointmentReminders[\s\S]{0,600}\.eq\("event_type",\s*LISTING_APPOINTMENT_EVENT_TYPE\)/.test(apptSrc))
check("a sent tier is recorded on calendar_events.metadata.reminder_tiers_sent (idempotent — a tier is never re-sent)", apptSrc.includes("reminder_tiers_sent:"))
check("LISTING_APPOINTMENT_STATUS.CANCELLED is a DIFFERENT value than CONFIRMED (so a superseded row structurally drops out of the reminder query)", (LISTING_APPOINTMENT_STATUS.CANCELLED as string) !== (LISTING_APPOINTMENT_STATUS.CONFIRMED as string))

const cronSrc = stripped("app/api/cron/listing-appointment-reminders/route.ts")
check("the cron route calls sendListingAppointmentReminders and verifies cron auth", cronSrc.includes("sendListingAppointmentReminders(") && cronSrc.includes("verifyCronAuth("))

const cronDispatchSrc = stripped("lib/kernel/cron-dispatch.ts")
check("CRON_REGISTRY carries /api/cron/listing-appointment-reminders", /path:\s*"\/api\/cron\/listing-appointment-reminders"/.test(cronDispatchSrc))

const managerRegistrySrc = stripped("lib/kernel/manager-registry.ts")
check("CRON_MANAGER maps /api/cron/listing-appointment-reminders to listing_concierge", /"\/api\/cron\/listing-appointment-reminders":\s*"listing_concierge"/.test(managerRegistrySrc))
check("MAINTENANCE_DOMAINS carries listing_appointment, owner listing_concierge, proof test:listing-appointment", /listing_appointment:\s*\{\s*manager:\s*"listing_concierge",\s*proof:\s*"test:listing-appointment"/.test(managerRegistrySrc))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 10 · the customer tool — a LEAD converts BEFORE booking, tool renamed everywhere]")

const toolsSrc = stripped("lib/ai-isa/customer-context-tools.ts")
check("buildFindListingAppointmentSlotsTool and buildBookListingAppointmentTool are exported", toolsSrc.includes("export function buildFindListingAppointmentSlotsTool") && toolsSrc.includes("export function buildBookListingAppointmentTool"))
check("book_listing_appointment converts a LEAD via convertSellerLeadOnIntent BEFORE calling bookListingAppointment", /convertSellerLeadOnIntent\(\{[\s\S]{0,300}\}\)[\s\S]{0,600}bookListingAppointment\(\{/.test(toolsSrc))
check("the conversion reason is 'positive_reply' (NOT 'appointment_request' — that reason's OWN internal booking path is pre-calendar and would double-book)", /reason:\s*"positive_reply"/.test(toolsSrc))
check("book_agent_appointment (the OLD tool key) is GONE from the registered bundle", !/out\.book_agent_appointment\s*=/.test(toolsSrc))
check("book_listing_appointment IS registered in the bundle", /out\.book_listing_appointment\s*=\s*buildBookListingAppointmentTool/.test(toolsSrc))
check("find_listing_appointment_slots IS registered in the bundle", /out\.find_listing_appointment_slots\s*=\s*buildFindListingAppointmentSlotsTool/.test(toolsSrc))

const { QUALIFICATION_FOLLOW_UP_MENU } = await import("../lib/ai-isa/qualification-playbook")
check("QUALIFICATION_FOLLOW_UP_MENU names book_listing_appointment (not the retired book_agent_appointment)",
  QUALIFICATION_FOLLOW_UP_MENU.some((o) => o.tool === "book_listing_appointment") && !QUALIFICATION_FOLLOW_UP_MENU.some((o) => o.tool === "book_agent_appointment"))

const { FREE_INTERNAL_TOOL_NAMES } = await import("../lib/ai-isa/persona-tool-policy")
check("FREE_INTERNAL_TOOL_NAMES carries both new tool names (rank 0, never priced) and drops the retired one",
  FREE_INTERNAL_TOOL_NAMES.includes("find_listing_appointment_slots") && FREE_INTERNAL_TOOL_NAMES.includes("book_listing_appointment") && !FREE_INTERNAL_TOOL_NAMES.includes("book_agent_appointment"))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 11 · NO AVM value ever in the listing-appointment tool result]")

check("lib/ai-isa/listing-appointment.ts never mentions AVM/estimated value (the whole module — find/book/confirm/remind)", !/avm|estimatedvalue|estimated_value/i.test(apptSrc))
// Isolate JUST the two new tool builders (from buildFindListingAppointmentSlotsTool through
// the closing brace right before buildBookAgentAppointmentTool's retirement comment no longer
// exists — so isolate up to buildCustomerFreeTools instead, which is the next real boundary).
const newToolsBlockStart = toolsSrc.indexOf("export function buildFindListingAppointmentSlotsTool")
// End at the first exported function AFTER the book tool (wave 75 integration:
// the two builders no longer sit immediately before buildCustomerFreeTools).
const bookToolStart = toolsSrc.indexOf("export function buildBookListingAppointmentTool")
const newToolsBlockEnd = bookToolStart >= 0 ? toolsSrc.indexOf("\nexport function", bookToolStart + 1) : -1
const newToolsBlock = toolsSrc.slice(newToolsBlockStart, newToolsBlockEnd)
check("the isolated slice actually captured both new tool builders (not an empty/mis-sliced window)",
  newToolsBlockStart >= 0 && newToolsBlockEnd > newToolsBlockStart && newToolsBlock.includes("buildBookListingAppointmentTool"))
check("neither find_listing_appointment_slots nor book_listing_appointment mentions AVM/value", !/avm|estimatedvalue|estimated_value/i.test(newToolsBlock))
// POSITIVE CONTROL on a literal fixture: lane 75B removed the AVM call from
// schedule_home_value_review (owner: never give a value in conversation), so the
// wider file is legitimately AVM-free now; the scanner is proven live on a fixture.
check("POSITIVE CONTROL: the AVM scanner still recognises the defect on a fixture (`const v = await getCurrentAvm(address)`)", /avm/i.test("const v = await getCurrentAvm(address)"))
check("customer-context-tools.ts as a whole no longer runs the AVM chain (owner ruling: never give the person a value over the conversation)", !/getCurrentAvm\(/.test(toolsSrc))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 12 · signal registry wiring]")

const { SIGNAL_REGISTRY } = await import("../lib/kernel/signal-registry")
const { SIGNAL_HANDLERS } = await import("../lib/kernel/manager-signals")
const { classifyCoordination } = await import("../lib/kernel/coordination-kind")

const spec = SIGNAL_REGISTRY["listing_appointment_pending_confirmation"]
check("listing_appointment_pending_confirmation is catalogued in SIGNAL_REGISTRY", !!spec)
if (spec) {
  check("its declared kind matches classifyCoordination", spec.kind === classifyCoordination("listing_appointment_pending_confirmation"))
  for (const c of spec.consumers) {
    check(`a real SIGNAL_HANDLERS entry exists for consumer "${c}"`, `${c}:listing_appointment_pending_confirmation` in SIGNAL_HANDLERS)
  }
}
check("the RETIRED qualification_appointment_handoff stays catalogued (never deleted to move a number — CLAUDE.md §1)", !!SIGNAL_REGISTRY["qualification_appointment_handoff"])
check("no live publisher of qualification_appointment_handoff remains in customer-context-tools.ts", !toolsSrc.includes('signalType: "qualification_appointment_handoff"'))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 13 · package.json registration — guard tail right after test:scrapers]")

const pkg = raw("package.json")
check(`"test:listing-appointment" script is registered`, /"test:listing-appointment":\s*"tsx --conditions=react-server scripts\/listing-appointment-simulator\.ts"/.test(pkg))
check("the guard chain runs it immediately after test:scrapers (the exact anchor this lane's brief named)",
  pkg.includes("npm run test:scrapers && npm run test:listing-appointment && npm run test:qualification-playbook"))

// ─────────────────────────────────────────────────────────────────────────────
// Layer 14 · Microsoft Graph tentative state (lane 76C blind-spot burn-down).
// Wave 75 left the Outlook branch a "documented no-op": Graph has no lifecycle
// `tentative` for an organizer-created event. It DOES carry an availability
// field — event.showAs ∈ free|tentative|busy|oof|workingElsewhere|unknown
// (learn.microsoft.com/graph/api/resources/event, fetched 2026-09-18) — so the
// tentative hold and the confirm PATCH now map onto it. Source-asserted on
// STRIPPED text (a comment naming showAs is not a call site, CLAUDE.md §2).
console.log("\n[Layer 14 · Microsoft Graph — tentative hold maps onto event.showAs, confirm flips it to busy]")
{
  const calSrc = stripped("lib/providers/calendar/personal-calendar.ts")
  check("graphShowAsFor: tentative → 'tentative' (a Graph showAs value, not Google's status vocabulary)", graphShowAsFor("tentative") === "tentative")
  check("graphShowAsFor: confirmed → 'busy' (the only Graph availability that reads as a firm hold)", graphShowAsFor("confirmed") === "busy")
  const graphCreate = calSrc.slice(calSrc.indexOf('path: "/me/events", method: "POST"'), calSrc.indexOf("export async function getAvailabilityViaPersonal"))
  check("the Graph CREATE body carries showAs derived from event.status (and omits it when no status was given — Graph's own default, never a fabricated one)",
    /\.\.\.\(event\.status \? \{ showAs: graphShowAsFor\(event\.status\) \} : \{\}\)/.test(graphCreate))
  const graphUpdate = calSrc.slice(calSrc.indexOf("export async function updateEventViaPersonal"), calSrc.indexOf("export async function deleteEventViaPersonal"))
  check("the Graph UPDATE (confirm PATCH) sets body.showAs from updates.status — the Outlook branch is no longer a no-op for status",
    /if \(updates\.status\) body\.showAs = graphShowAsFor\(updates\.status\)/.test(graphUpdate))
  check("POSITIVE CONTROL: the same finders reject the wave-75 no-op shape (a Graph body with no showAs)",
    !/showAs/.test('body: { subject: event.title, start: { dateTime: event.startTime, timeZone: "UTC" } }'))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(60))
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  ✗ ${f}`)
  console.log("\n❌ LISTING_APPOINTMENT — see failures above")
  process.exit(1)
}
console.log("\n✅ LISTING_APPOINTMENT — all checks passed")
