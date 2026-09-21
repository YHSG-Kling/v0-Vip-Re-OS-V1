#!/usr/bin/env tsx
/**
 * scripts/platform-prospect-funnel-simulator.ts   (npm run test:platform-prospect-funnel)
 * ─────────────────────────────────────────────────────────────────────────────
 * Lane 76B — owner verbatim: "on the platform voice receptionist merge you
 * didn't use listing appointment. need to be sure the platform 'potential'
 * customers are being saved/created as 'potential' subscribers and if they
 * do decide to setup a demo or want to purchase a subscription we have a way
 * for the agents to create a demo appointment or given a way to either sign
 * up online or with a human … this goes for the platform ai agents."
 *
 * Proves, in STRIPPED source wherever a code token is scanned for
 * (scripts/strip-comments.ts — CLAUDE.md §2), with a positive control on
 * every absence assertion:
 *   Layer 1  — strip-comments positive control.
 *   Layer 2  — the ONE writer's pure helpers (never nulls a known fact,
 *              timeline clamped to the live bucket spelling, status only
 *              moves forward).
 *   Layer 3  — upsertPlatformProspect against an in-memory table: a phone
 *              caller + a later web hand-raise MERGE onto one row; the demo /
 *              handoff / signup stamps land on that same row.
 *   Layer 4  — EVERY platform surface writes through the one writer (voice
 *              wrapper, both web captures, the tool bundle, the chat route),
 *              and no surface keeps its own platform_prospects upsert.
 *   Layer 5  — the DEMO reuses the listing-appointment SURVIVOR: exactly ONE
 *              buildAppointmentIcs and ONE getAvailabilityViaPersonal call
 *              site across lib/ + app/ (positive control: a fixture with a
 *              fake second builder turns the counter red), demo kind spec is
 *              entity_type='platform_prospect' + event_type='demo_appointment'.
 *   Layer 6  — IDENTITY: no platform_prospects.id flows into a contactId /
 *              leadId slot anywhere in the funnel modules (positive control).
 *   Layer 7  — the signup link is the REAL route (/get-started, /signup 308s
 *              there) built by brandCta and sent through dispatch only.
 *   Layer 8  — the human handoff targets platform_role staff (sales bench
 *              derives from PLATFORM_STAFF_ROLES minus support; no
 *              user_type='superadmin' anywhere in the funnel modules).
 *   Layer 9  — playbook wording for the platform matches the registered
 *              tools (PLATFORM_EXIT_MENU ⊆ PLATFORM_PROSPECT_TOOL_NAMES, each
 *              tool actually registered, prompt names them, and the
 *              real-estate goals stay OUT of the platform branch).
 *   Layer 10 — vocabulary: 'demo_scheduled' in the (hand-added, m654)
 *              vocabulary cache, PROSPECT_STATUSES agrees, timeline buckets
 *              equal the live contacts timeline CHECK spelling.
 *   Layer 11 — the follow-up loop: the cold ladder reads only new|contacted
 *              and excludes an open human handoff in the QUERY; the reminder
 *              sweep covers the demo kind.
 *   Layer 12 — the reader: growth board shows next touch + demo time + confirm.
 *   Layer 13 — registration: package.json script, guard chain after
 *              test:scrapers, MAINTENANCE_DOMAINS owner.
 *
 * No DB, no network. Run:
 *   npx tsx --conditions=react-server scripts/platform-prospect-funnel-simulator.ts
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import { walkTs } from "./runtime-roots"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const root = process.cwd()
const raw = (p: string): string => readFileSync(join(root, p), "utf8")
const stripped = (p: string): string => stripComments(raw(p))

const CAPTURE = "lib/platform/prospect-capture.ts"
const TOOLS = "lib/platform/prospect-agent-tools.ts"
const SALES_REP = "lib/platform/sales-rep.ts"
const APPT = "lib/ai-isa/listing-appointment.ts"
const VOICE_RECEPTION = "lib/voice/platform-reception.ts"
const TWILIO_VOICE = "lib/voice/twilio-voice.ts"
const GROWTH_ACTIONS = "app/actions/superadmin/platform-growth.ts"
const CHAT_ROUTE = "app/api/platform/prospect-chat/route.ts"
const FOLLOWUP = "lib/platform/prospect-followup.ts"
const BOARD = "app/dashboard/superadmin/growth/platform-growth-board.tsx"

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 1 · strip-comments positive control]")
const captureSrc = stripped(CAPTURE)
check("a comment-only phrase is ABSENT from stripped prospect-capture.ts (the scanner sees comments)", !captureSrc.includes("Three writers, three merge rules"))
check("a real code token from the same file IS present (the scanner did not eat the code)", captureSrc.includes("export async function upsertPlatformProspect"))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 2 · the ONE writer's pure helpers]")
const {
  normalizeProspectEmail, normalizeProspectQualification, buildProspectColumnPatch, mergeProspectDetails,
  advanceProspectStatus, upsertPlatformProspect, markProspectDemoScheduled, markProspectHandoff, markProspectSignupLinkSent,
  PROSPECT_TIMELINE_BUCKETS,
} = await import("../lib/platform/prospect-capture")

check("normalizeProspectEmail lowercases/trims and rejects garbage", normalizeProspectEmail("  Jo@Example.COM ") === "jo@example.com" && normalizeProspectEmail("nope") === null)
const q = normalizeProspectQualification({ brokerage_name: " Acme Realty ", size_seats: 12.4, timeline: "3-6_months", territory: "", pain: "follow-up falls through", current_tools: null, role_title: "broker-owner" })
check("qualification keeps stated facts and drops blanks", q.brokerage_name === "Acme Realty" && q.size_seats === 12 && q.role_title === "broker-owner" && !("territory" in q) && !("current_tools" in q))
check("an OFF-VOCABULARY timeline is DROPPED, never stored as a seventh spelling (CLAUDE.md §5 buckets)", !("timeline" in normalizeProspectQualification({ timeline: "30 days" as never })) && normalizeProspectQualification({ timeline: "1-3_months" }).timeline === "1-3_months")
const patch = buildProspectColumnPatch({ source: "web:prospect_chat", name: null, company: "", roleInterest: "bogus", note: "wants a demo" })
check("the column patch never writes a null over a known fact (absent name/company are simply not in the patch)", !("name" in patch) && !("company" in patch) && patch.interest_note === "wants a demo")
check("an off-vocabulary role_interest is not written (the funnel CHECK list is the only role vocabulary)", !("role_interest" in patch) && buildProspectColumnPatch({ source: "x", roleInterest: "team" }).role_interest === "team")
const merged = mergeProspectDetails({ proposal: { x: 1 }, qualification: { pain: "old" } }, { demo_request: { at: 1 } }, { timeline: "6-12_months" })
check("details merge keeps existing keys (a stored proposal survives) and merges qualification key-wise", (merged.proposal as { x: number }).x === 1 && !!merged.demo_request && (merged.qualification as { pain: string; timeline: string }).pain === "old" && (merged.qualification as { timeline: string }).timeline === "6-12_months")
check("status only moves FORWARD: contacted→demo_scheduled advances, trial stays trial, lost is sticky", advanceProspectStatus("contacted", "demo_scheduled") === "demo_scheduled" && advanceProspectStatus("trial", "demo_scheduled") === "trial" && advanceProspectStatus("lost", "contacted") === "lost" && advanceProspectStatus(null, "contacted") === "contacted")

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 3 · upsertPlatformProspect + stamps against an in-memory table — one row, never two]")

type Row = Record<string, unknown> & { id: string }
function fakeSvc() {
  const rows: Row[] = []
  const calls: Row[] = []
  let seq = 0
  function table(name: string) {
    const store = name === "platform_prospects" ? rows : calls
    let filters: Array<[string, unknown]> = []
    let op: { kind: "select" | "insert" | "update"; payload?: Record<string, unknown> } = { kind: "select" }
    let single = false
    const api: any = {
      select() { return api },
      eq(col: string, val: unknown) { filters.push([col, val]); return api },
      maybeSingle() { single = true; return api.then((r: any) => r) },
      single() { single = true; return api.then((r: any) => r) },
      insert(payload: Record<string, unknown>) { op = { kind: "insert", payload }; return api },
      update(payload: Record<string, unknown>) { op = { kind: "update", payload }; return api },
      then(resolve: (v: unknown) => unknown) {
        const match = store.filter((r) => filters.every(([c, v]) => r[c] === v))
        let out: unknown
        if (op.kind === "insert") { const row = { id: `p${++seq}`, details: {}, status: "new", ...op.payload } as Row; store.push(row); out = { data: row, error: null } }
        else if (op.kind === "update") { for (const r of match) Object.assign(r, op.payload); out = { data: match, error: null } }
        else out = { data: single ? (match[0] ?? null) : match, error: null }
        filters = []; op = { kind: "select" }; single = false
        return Promise.resolve(resolve(out))
      },
    }
    return api
  }
  return { from: table, rows, calls }
}

const svc = fakeSvc()
const first = await upsertPlatformProspect(svc, { phone: "+15125550100", name: "Dana", source: "phone:reception", note: "asked about pricing", qualification: { size_seats: 8 } })
check("a phone-only caller is SAVED as a potential subscriber (row created, keyed by phone)", !!first?.created && svc.rows.length === 1 && svc.rows[0]!.phone === "+15125550100" && svc.rows[0]!.source === "phone:reception")
const second = await upsertPlatformProspect(svc, { phone: "+15125550100", email: "Dana@Acme.com", company: "Acme Realty", source: "web:prospect_chat", qualification: { timeline: "3-6_months" } })
check("the SAME person giving an email later MERGES onto the same row — never a duplicate", second?.id === first?.id && !second?.created && svc.rows.length === 1)
check("…gaining the email, the company and the merged qualification, keeping first-touch source and the earlier facts", svc.rows[0]!.email === "dana@acme.com" && svc.rows[0]!.company === "Acme Realty" && svc.rows[0]!.source === "phone:reception" && svc.rows[0]!.name === "Dana" && (svc.rows[0]!.details as { qualification: { size_seats: number; timeline: string } }).qualification.size_seats === 8 && (svc.rows[0]!.details as { qualification: { timeline: string } }).qualification.timeline === "3-6_months")
const third = await upsertPlatformProspect(svc, { email: "dana@acme.com", source: "demo_request", detailsPatch: { demo_request: { preferred_times: "Tue am" } } })
check("a web demo request by email finds the phone caller's row (the web key reaches a phone-first prospect)", third?.id === first?.id && !!(svc.rows[0]!.details as { demo_request?: unknown }).demo_request)
check("upsert with no key at all returns null (never an anonymous row)", (await upsertPlatformProspect(svc, { source: "x" })) === null && svc.rows.length === 1)

const stamped = await markProspectDemoScheduled(svc, { prospectId: first!.id, calendarEventId: "ce1", startAt: "2026-09-25T15:00:00.000Z", endAt: "2026-09-25T15:30:00.000Z", repUserId: "u-rep" })
const demoStamp = (svc.rows[0]!.details as { demo_appointment: { status: string; calendar_event_id: string } }).demo_appointment
check("markProspectDemoScheduled → status 'demo_scheduled' + details.demo_appointment (pending rep confirmation)", stamped && svc.rows[0]!.status === "demo_scheduled" && demoStamp.status === "pending_rep_confirmation" && demoStamp.calendar_event_id === "ce1")
const svc2 = fakeSvc()
const p2 = await upsertPlatformProspect(svc2, { email: "lee@team.com", source: "web:prospect_chat" })
await markProspectHandoff(svc2, { prospectId: p2!.id, reason: "contract questions", bestTime: "tomorrow 2pm", channel: "web:prospect_chat", staffNotified: 2 })
check("markProspectHandoff → details.human_handoff open + status at least 'contacted' (a person is on it)", svc2.rows[0]!.status === "contacted" && (svc2.rows[0]!.details as { human_handoff: { status: string; staff_notified: number } }).human_handoff.status === "open" && (svc2.rows[0]!.details as { human_handoff: { staff_notified: number } }).human_handoff.staff_notified === 2)
await markProspectSignupLinkSent(svc2, { prospectId: p2!.id, channel: "email", url: "https://x/get-started?utm_source=web_prospect_chat" })
check("markProspectSignupLinkSent → details.signup_link recorded on the same row", (svc2.rows[0]!.details as { signup_link: { channel: string } }).signup_link.channel === "email")
check("a stamp on an unknown prospect id reports false (COUNTED update, CLAUDE.md §3)", (await markProspectDemoScheduled(svc2, { prospectId: "nope", calendarEventId: "c", startAt: "2026-09-25T15:00:00.000Z", endAt: "2026-09-25T15:30:00.000Z", repUserId: "u" })) === false)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 4 · EVERY platform surface writes through the ONE writer]")
const voiceSrc = stripped(VOICE_RECEPTION)
const growthSrc = stripped(GROWTH_ACTIONS)
const toolsSrc = stripped(TOOLS)
const chatSrc = stripped(CHAT_ROUTE)
const twilioSrc = stripped(TWILIO_VOICE)
check("voice: capturePhoneProspect delegates to upsertPlatformProspect and keeps the 'phone:reception' source", /capturePhoneProspect[\s\S]{0,600}upsertPlatformProspect\(/.test(voiceSrc) && voiceSrc.includes('"phone:reception"'))
check("voice: platform-reception.ts no longer writes platform_prospects itself", !voiceSrc.includes('from("platform_prospects")'))
check("web forms: capturePlatformProspectAction AND requestPlatformDemoAction both delegate to upsertPlatformProspect", (growthSrc.match(/upsertPlatformProspect\(/g) ?? []).length >= 2)
check("web forms: no inline platform_prospects upsert remains in the growth actions", !/from\("platform_prospects"\)\s*\.upsert\(/.test(growthSrc))
check("POSITIVE CONTROL: the inline-upsert scanner still recognises the retired shape on a fixture", /from\("platform_prospects"\)\s*\.upsert\(/.test('svc.from("platform_prospects").upsert({ email }, { onConflict: "email" })'))
check("tool bundle: save_prospect / book_demo / signup link / handoff all resolve the prospect through upsertPlatformProspect (one resolver)", toolsSrc.includes("upsertPlatformProspect(") && (toolsSrc.match(/resolveProspect\(/g) ?? []).length >= 5)
check("chat route: mounts platformReceptionTools with source 'web:prospect_chat' and no phone/prospect id from the body", chatSrc.includes("platformReceptionTools({") && chatSrc.includes('source: "web:prospect_chat"') && chatSrc.includes("phone: null, prospectId: null") && !/body\.(prospectId|phone)/.test(chatSrc))
check("chat route: public + throttled through the shared limiter (never unthrottled)", chatSrc.includes("checkPublicRateLimit(") && chatSrc.includes("publicCallerIp("))
check("voice engine: the platform branch threads a SERVER-resolved prospect context into platformReceptionTools", /deployment === "platform"[\s\S]{0,2500}platformReceptionTools\(\{[\s\S]{0,300}source: "phone:reception"/.test(twilioSrc))
const turnSrc = stripped("app/api/voice/twilio/turn/route.ts")
const relaySrc = stripped("app/api/voice/relay/plan/route.ts")
check("both voice transports pass Twilio's signed From + the CallSid-resolved ledger row (never a body value)", /prospect:\s*\{\s*phone:\s*params\.From/.test(turnSrc) && /prospect:\s*\{\s*phone:\s*req\.from/.test(relaySrc) && relaySrc.includes("prospect_id"))
check("public site mounts the chat on /get-started and /demo", stripped("app/get-started/page.tsx").includes("<ProspectChat") && stripped("app/demo/page.tsx").includes("<ProspectChat"))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 5 · the demo reuses the listing-appointment SURVIVOR — no second ICS builder, no second slot finder]")
const apptSrc = stripped(APPT)
const {
  APPOINTMENT_KIND_SPEC, APPOINTMENT_EVENT_TYPES, DEMO_APPOINTMENT_EVENT_TYPE, DEMO_APPOINTMENT_MIN_DAYS_OUT,
  appointmentKindForEventType, DEMO_APPOINTMENT_CONFIRM_NOTIFICATION_TYPE,
} = await import("../lib/ai-isa/listing-appointment")
const { CalendarEventType } = await import("../lib/kernel/calendar-types")
check("findDemoAppointmentSlots / bookDemoAppointment / confirmDemoAppointment are exported from the survivor module", apptSrc.includes("export async function findDemoAppointmentSlots") && apptSrc.includes("export async function bookDemoAppointment") && apptSrc.includes("export async function confirmDemoAppointment"))
check("the demo kind spec: event_type 'demo_appointment' (CalendarEventType enum), entity class 'platform_prospect', next-day floor", APPOINTMENT_KIND_SPEC.demo_appointment.eventType === CalendarEventType.DEMO_APPOINTMENT && DEMO_APPOINTMENT_EVENT_TYPE === "demo_appointment" && APPOINTMENT_KIND_SPEC.demo_appointment.entityType === "platform_prospect" && DEMO_APPOINTMENT_MIN_DAYS_OUT === 1 && APPOINTMENT_KIND_SPEC.demo_appointment.minDaysOut === 1)
check("the listing kind is untouched: 7-day floor, entity 'contact'", APPOINTMENT_KIND_SPEC.listing_appointment.minDaysOut === 7 && APPOINTMENT_KIND_SPEC.listing_appointment.entityType === "contact")
check("appointmentKindForEventType maps both event types and nothing else", appointmentKindForEventType("demo_appointment") === "demo_appointment" && appointmentKindForEventType("listing_appointment") === "listing_appointment" && appointmentKindForEventType("showing") === null)
check("APPOINTMENT_EVENT_TYPES carries both kinds (the ONE reminder sweep's .in list)", APPOINTMENT_EVENT_TYPES.includes("demo_appointment") && APPOINTMENT_EVENT_TYPES.includes("listing_appointment"))
check("ONE bookAppointmentCore / ONE findSlotsOnConnectedCalendar / ONE confirmAppointmentCore — both public wrappers call them", (apptSrc.match(/async function bookAppointmentCore\(/g) ?? []).length === 1 && (apptSrc.match(/bookAppointmentCore\(\{/g) ?? []).length === 2 && (apptSrc.match(/findSlotsOnConnectedCalendar\(\{/g) ?? []).length === 2 && (apptSrc.match(/confirmAppointmentCore\(\{/g) ?? []).length === 2)

// Count DEFINITIONS of an ICS builder and CALL SITES of the fail-closed
// availability adapter across the whole runtime tree, on stripped +
// string-blanked source (a fixture inside a template literal must not count).
// Denominator: every .ts/.tsx under lib/ and app/ for the ICS builder (there
// must be one in the whole runtime tree); for the availability adapter the
// denominator is the AI-agent + platform modules (lib/ai-isa, lib/platform) —
// lib/kernel/self-book.ts and lib/providers/calendar/index.ts are OTHER,
// pre-existing domains' callers of the same adapter and are not this lane's
// claim. Blind spot, stated: a second finder placed OUTSIDE those two folders
// would not be counted here.
const runtimeFiles = [...walkTs(join(root, "lib")), ...walkTs(join(root, "app"))]
const ICS_DEF = /function\s+buildAppointmentIcs\s*\(/g
const AVAIL_CALL = /getAvailabilityViaPersonal\s*\(/g
let icsDefs = 0, availCalls = 0
const icsDefFiles: string[] = []
const availFiles: string[] = []
for (const f of runtimeFiles) {
  const rel = f.replace(root + "/", "")
  const s = blankStrings(stripComments(readFileSync(f, "utf8")))
  const d = (s.match(ICS_DEF) ?? []).length
  if (d > 0) { icsDefs += d; icsDefFiles.push(rel) }
  if (rel.startsWith("lib/ai-isa/") || rel.startsWith("lib/platform/")) {
    const c = (s.match(AVAIL_CALL) ?? []).length
    if (c > 0) { availCalls += c; availFiles.push(rel) }
  }
}
check(`exactly ONE buildAppointmentIcs definition in lib/ + app/ (found ${icsDefs}: ${icsDefFiles.join(", ")})`, icsDefs === 1 && icsDefFiles[0] === APPT)
check(`exactly ONE getAvailabilityViaPersonal call site across lib/ai-isa + lib/platform (found ${availCalls}: ${availFiles.join(", ")}) — the demo finder IS the listing finder`, availCalls === 1 && availFiles[0] === APPT)
check("POSITIVE CONTROL: a fake second `export function buildAppointmentIcs(` in a fixture makes the definition counter read 2 (the counter is not blind)",
  ((blankStrings(stripComments(raw(APPT) + "\nexport function buildAppointmentIcs(x: number) { return x }")).match(ICS_DEF) ?? []).length) === 2)
check("POSITIVE CONTROL: a fake second getAvailabilityViaPersonal( call in a fixture reads 2", ((blankStrings(stripComments(raw(APPT) + "\nconst z = await getAvailabilityViaPersonal(a, b)")).match(AVAIL_CALL) ?? []).length) === 2)
check("the tool bundle / writer / rep resolver carry NO ICS or free-slot code of their own (no VCALENDAR, no computeFreeSlots, no availability call)",
  ![toolsSrc, captureSrc, stripped(SALES_REP)].some((s) => /VCALENDAR|computeFreeSlots|getAvailabilityViaPersonal|createEventViaPersonal/.test(s)))
check("the demo booking notifies the REP (users.id) via the existing notifications shape with entity_type 'platform_prospect'", /DEMO_APPOINTMENT_CONFIRM_NOTIFICATION_TYPE[\s\S]{0,400}entity_type:\s*"platform_prospect",\s*entity_id:\s*params\.prospectId/.test(apptSrc) && DEMO_APPOINTMENT_CONFIRM_NOTIFICATION_TYPE === "demo_appointment_confirmation_needed")
check("the demo kind is NOT added to the no-show autopilot's APPOINTMENT_EVENT_TYPES (it resolves a CONTACT from entity_id — a prospect id would be looked up as a contact)", !stripped("lib/kernel/appointment-noshow-autopilot.ts").includes('"demo_appointment"'))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 6 · IDENTITY — no platform_prospects.id in a contactId/leadId slot]")
const ID_LEAK = /(contactId|leadId|contact_id|lead_id)\s*:\s*(prospect(Id)?(\.id)?|params\.prospectId|ctx\.prospectId|saved\.id|p\.id|r\.entity_id)\b/
const funnelSources: Array<[string, string]> = [[TOOLS, toolsSrc], [CAPTURE, captureSrc], [SALES_REP, stripped(SALES_REP)], [CHAT_ROUTE, chatSrc], [GROWTH_ACTIONS, growthSrc]]
for (const [name, s] of funnelSources) check(`${name}: no prospect id assigned to a contactId/leadId/contact_id/lead_id slot`, !ID_LEAK.test(s))
check("POSITIVE CONTROL: the id-leak scanner recognises `contactId: prospect.id` on a fixture", ID_LEAK.test("dispatchEmail({ contactId: prospect.id })") && ID_LEAK.test("insert({ contact_id: params.prospectId })"))
check("the tool bundle never mentions leadId / lead_id at all (a platform prospect is not a lead)", !/leadId|lead_id/.test(toolsSrc))
check("listing-appointment.ts: the demo confirm/reminder sends pass contactId ONLY for a contact row (guarded by entity_type === \"contact\")", (apptSrc.match(/entity_type\s*===\s*"contact"\s*\?\s*\{\s*contactId:\s*(r|row)\.entity_id\s*\}\s*:\s*\{\}/g) ?? []).length === 2 && !/contactId:\s*r\.entity_id,/.test(apptSrc))
check("listing-appointment.ts: bookDemoAppointment writes entity_type from the kind spec (never a literal 'contact' for a prospect) and the demo spec says platform_prospect", /entity_type:\s*spec\.entityType/.test(apptSrc) && APPOINTMENT_KIND_SPEC.demo_appointment.entityType === "platform_prospect")
check("the attendee resolver reads platform_prospects for a 'platform_prospect' row and contacts for a 'contact' row — never the other table", /entity_type === "contact"[\s\S]{0,200}from\("contacts"\)/.test(apptSrc) && /entity_type === "platform_prospect"[\s\S]{0,200}from\("platform_prospects"\)/.test(apptSrc))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 7 · the signup link is the REAL route, sent through dispatch only]")
check("send_signup_link builds the URL with brandCta (lib/platform/product-brand.ts) — the /get-started attributed CTA", toolsSrc.includes("brandCta(ctx.brand") && stripped("lib/platform/product-brand.ts").includes("/get-started?utm_source="))
check("/get-started is a real page and /signup permanently redirects there (one front door)", existsSync(join(root, "app/get-started/page.tsx")) && /permanentRedirect\(`\/get-started/.test(stripped("app/signup/page.tsx")))
check("the link goes out through dispatchSms (transactional, the caller-ID number) or dispatchEmail — never the raw messaging sender", toolsSrc.includes("dispatchSms({") && toolsSrc.includes("dispatchEmail({") && /transactional:\s*true/.test(toolsSrc) && !toolsSrc.includes("@/lib/providers/messaging"))
check("POSITIVE CONTROL: the raw-sender scanner recognises a messaging import on a fixture", 'import { sendSMS } from "@/lib/providers/messaging"'.includes("@/lib/providers/messaging"))
check("the SMS send uses the SERVER-resolved caller phone (ctx.phone), never a model-supplied number", /dispatchSms\(\{\s*to:\s*ctx\.phone/.test(toolsSrc) && !/dispatchSms\(\{\s*to:\s*a\./.test(toolsSrc))
check("the send is stamped on the prospect row (markProspectSignupLinkSent) so the board and the ladder see it", toolsSrc.includes("markProspectSignupLinkSent("))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 8 · the human handoff targets platform_role staff]")
const { SALES_REP_ROLE_ORDER, salesBenchDerivesFromRoster, rankSalesRepCandidates } = await import("../lib/platform/sales-rep")
const { PLATFORM_STAFF_ROLES } = await import("../lib/platform/platform-staff-roster")
check("the sales bench derives from PLATFORM_STAFF_ROLES by named subtraction (minus support only)", salesBenchDerivesFromRoster() && SALES_REP_ROLE_ORDER.every((r) => (PLATFORM_STAFF_ROLES as readonly string[]).includes(r)))
check("bench order: marketing first (owns the growth funnel), then admin, then superadmin", SALES_REP_ROLE_ORDER.join(",") === "marketing,admin,superadmin")
const ranked = rankSalesRepCandidates([{ platformRole: "superadmin", calendarConnected: true }, { platformRole: "marketing", calendarConnected: false }, { platformRole: "admin", calendarConnected: true }])
check("a calendar-connected rep outranks a disconnected one, and bench order breaks ties", ranked[0]!.platformRole === "admin" && ranked[1]!.platformRole === "superadmin" && ranked[2]!.platformRole === "marketing")
const salesRepSrc = stripped(SALES_REP)
check("the rep query keys on users.platform_role (never user_type='superadmin', which no live row carries)", /\.in\("platform_role"/.test(salesRepSrc) && ![salesRepSrc, toolsSrc, captureSrc].some((s) => /user_type[^\n]{0,40}superadmin/.test(s)))
check("POSITIVE CONTROL: the user_type scanner recognises the dead gate on a fixture", /user_type[^\n]{0,40}superadmin/.test('.eq("user_type", "superadmin")'))
check("request_human_handoff notifies through lib/notifications/platform-staff.ts::notifyPlatformStaff (the platform_role roster) and stamps details.human_handoff", toolsSrc.includes("notifyPlatformStaff(") && toolsSrc.includes("markProspectHandoff(") && stripped("lib/notifications/platform-staff.ts").includes("PLATFORM_STAFF_ROLES"))
check("with no connected calendar the demo exit FAILS CLOSED to the handoff (offerHandoff), never an invented slot", /calendar_not_connected/.test(apptSrc) && (toolsSrc.match(/offerHandoff:\s*true/g) ?? []).length >= 2 && !/slots:\s*\[\s*\{/.test(toolsSrc))
check("the voice line keeps the live warm transfer as the first human exit (hasLiveTransfer threaded from PLATFORM_RECEPTION_FORWARD_NUMBER)", twilioSrc.includes("hasLiveTransfer: !!input.ctx.forwardNumber") && toolsSrc.includes("liveTransferAvailable: ctx.hasLiveTransfer"))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 9 · playbook wording for the platform matches the registered tools]")
const { PLATFORM_PROSPECT_TOOL_NAMES, platformExitMenuMatchesTools, PLATFORM_PROSPECT_TOOL_GUIDANCE } = await import("../lib/platform/prospect-agent-tools")
const { PLATFORM_EXIT_MENU, PLATFORM_QUALIFICATION_GOALS, buildQualificationPrompt } = await import("../lib/ai-isa/qualification-playbook")
check("every PLATFORM_EXIT_MENU tool is a registered PLATFORM_PROSPECT_TOOL_NAMES entry", platformExitMenuMatchesTools())
check("the three exits are exactly demo / signup link / human", PLATFORM_EXIT_MENU.map((o) => o.tool).sort().join(",") === ["book_demo_appointment", "request_human_handoff", "send_signup_link"].join(","))
for (const name of PLATFORM_PROSPECT_TOOL_NAMES) check(`tool '${name}' is actually registered in buildPlatformProspectTools`, new RegExp(`\\b${name}:\\s*tool\\(\\{`).test(toolsSrc))
check("POSITIVE CONTROL: a tool name NOT in the bundle is reported unregistered", !/\bbook_showing:\s*tool\(\{/.test(toolsSrc))
const platformPrompt = buildQualificationPrompt({ surface: "platform_reception" })
check("the platform prompt names all three exit tools and the save tool", PLATFORM_EXIT_MENU.every((o) => platformPrompt.includes(o.tool)) && platformPrompt.includes("save_prospect"))
check("the platform prompt asks for the software buyer's facts (brokerage, seats, role, tools, pain, timeline bucket, territory)…", ["brokerage_name", "size_seats", "role_title", "current_tools", "pain", "timeline", "territory"].every((k) => PLATFORM_QUALIFICATION_GOALS.some((g) => g.key === k)) && platformPrompt.includes("1-3 months") && platformPrompt.includes("6-12 months"))
check("…and NOT the real-estate goal list (no 'Property they're selling', no buyer criteria, no financing)", !platformPrompt.includes("Property they're selling") && !platformPrompt.includes("Buyer criteria") && !platformPrompt.includes("Financing status"))
check("POSITIVE CONTROL: the tenant surface's prompt DOES carry the real-estate goals (the scanner discriminates)", buildQualificationPrompt({ surface: "voice_reception" }).includes("Property they're selling"))
check("the voice tool-turn guidance and the chat route carry the SAME PLATFORM_PROSPECT_TOOL_GUIDANCE (one wording)", stripped("lib/voice/reception-brain.ts").includes("PLATFORM_PROSPECT_TOOL_GUIDANCE") && chatSrc.includes("PLATFORM_PROSPECT_TOOL_GUIDANCE") && PLATFORM_PROSPECT_TOOL_GUIDANCE.includes("find_demo_slots"))
check("the platform prompt's timeline wording is BUCKETS (never 30/60/90 — CLAUDE.md §5)", !/30\/60\/90|30 days|60 days|90 days/.test(platformPrompt))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 10 · vocabulary — 'demo_scheduled' (m654), timeline buckets]")
const vocab = raw("scripts/check-vocabularies.ts")
const prospectsVocab = /platform_prospects: \{[\s\S]*?status: \[([^\]]*)\]/.exec(vocab)?.[1] ?? ""
const vocabStatuses = [...prospectsVocab.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).sort()
const { PROSPECT_STATUSES } = await import("../lib/platform/growth-funnel")
check("the vocabulary cache carries 'demo_scheduled' for platform_prospects.status", vocabStatuses.includes("demo_scheduled"))
check("PROSPECT_STATUSES (code) equals the vocabulary cache's status set (one vocabulary, §6)", [...PROSPECT_STATUSES].sort().join(",") === vocabStatuses.join(","))
const m654 = join(root, "supabase/migrations/m654-platform-prospects-demo-scheduled-status.sql")
const m654Src = existsSync(m654) ? readFileSync(m654, "utf8") : ""
check("migration m654 exists and re-creates platform_prospects_status_check WITH 'demo_scheduled' (the rule, not a waypoint string)", /platform_prospects_status_check/.test(m654Src) && /'demo_scheduled'::text/.test(m654Src) && /drop constraint if exists platform_prospects_status_check/.test(m654Src))
const contactsTimeline = /^  contacts: \{[\s\S]*?timeline: \[([^\]]*)\]/m.exec(vocab)?.[1] ?? ""
const contactsBuckets = [...contactsTimeline.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).sort()
check(`PROSPECT_TIMELINE_BUCKETS equals the live contacts.timeline CHECK spelling (${contactsBuckets.join("|")})`, contactsBuckets.length > 0 && [...PROSPECT_TIMELINE_BUCKETS].sort().join(",") === contactsBuckets.join(","))
check("CalendarEventType carries DEMO_APPOINTMENT = 'demo_appointment' (one enum, no free-text spelling)", CalendarEventType.DEMO_APPOINTMENT === "demo_appointment")

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 11 · the follow-up loop — a booked demo / open handoff stops the cold ladder; reminders take over]")
const followupSrc = stripped(FOLLOWUP)
const ladderStatuses = [...followupSrc.matchAll(/\.eq\("status",\s*"([^"]+)"\)/g)].map((m) => m[1]!)
check("the cold ladder reads ONLY status new|contacted (so 'demo_scheduled' never receives an intro/nudge)", ladderStatuses.length === 2 && ladderStatuses.every((s) => s === "new" || s === "contacted") && !followupSrc.includes("demo_scheduled"))
check("both rungs exclude an OPEN human handoff in the QUERY (details->human_handoff IS NULL), not in a post-filter", (followupSrc.match(/\.is\("details->human_handoff",\s*null\)/g) ?? []).length === 2)
check("the reminder sweep (sendAppointmentReminders) covers both kinds via APPOINTMENT_EVENT_TYPES and only CONFIRMED rows", /sendAppointmentReminders[\s\S]{0,700}\.in\("event_type",\s*APPOINTMENT_EVENT_TYPES\)[\s\S]{0,200}\.eq\("status",\s*LISTING_APPOINTMENT_STATUS\.CONFIRMED\)/.test(apptSrc))
check("the sweep pushes a portal card ONLY for a contact row (a prospect has no portal)", /if \(row\.entity_type === "contact"\) \{[\s\S]{0,200}portal_event_stream/.test(apptSrc))
check("the cron route still calls the (renamed) sweep — no second reminder cron", stripped("app/api/cron/listing-appointment-reminders/route.ts").includes("sendAppointmentReminders(") && !existsSync(join(root, "app/api/cron/demo-appointment-reminders")))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 12 · the reader — growth board shows status, next touch, demo time, confirm]")
const { describeProspectNextTouch } = await import("../lib/platform/growth-funnel")
const boardSrc = stripped(BOARD)
check("listPlatformProspectsAction selects followup_count, last_followup_at and details (what the next-touch line needs)", /select\("id, name, email, phone,[^"]*followup_count, last_followup_at[^"]*"\)/.test(growthSrc) && /select\("id, name, email, phone,[^"]*details[^"]*"\)/.test(growthSrc))
check("confirmProspectDemoAction is marketing-gated, audited, and calls confirmDemoAppointment", /confirmProspectDemoAction[\s\S]{0,300}requireMarketingStaff\(\)[\s\S]{0,900}confirmDemoAppointment\(\{[\s\S]{0,400}audit\(/.test(growthSrc))
check("the board renders describeProspectNextTouch and the Confirm demo button (confirmProspectDemoAction)", boardSrc.includes("describeProspectNextTouch(") && boardSrc.includes("confirmProspectDemoAction(") && boardSrc.includes("Confirm demo"))
check("the board's status list IS PROSPECT_STATUSES (not a second hand-typed list)", boardSrc.includes("const STATUSES: readonly string[] = PROSPECT_STATUSES") && boardSrc.includes("demo_scheduled:"))
const nt1 = describeProspectNextTouch({ status: "demo_scheduled", details: { demo_appointment: { start_at: "2026-09-25T15:00:00.000Z", status: "pending_rep_confirmation" } } })
const nt2 = describeProspectNextTouch({ status: "contacted", followup_count: 1, details: { human_handoff: { status: "open", best_time: "2pm" } } })
const nt3 = describeProspectNextTouch({ status: "new", followup_count: 0, email: "a@b.co", created_at: "2026-09-18T10:00:00.000Z" })
const nt4 = describeProspectNextTouch({ status: "new", followup_count: 0, email: null })
check("next touch: a pending demo shows the demo time + awaiting confirmation", nt1.demoAt === "2026-09-25T15:00:00.000Z" && nt1.demoState === "pending_rep_confirmation" && /awaiting rep confirmation/.test(nt1.label))
check("next touch: an open handoff pauses the ladder (and says so)", nt2.handoffOpen && /paused/.test(nt2.label))
check("next touch: a fresh emailable prospect gets the intro ≥1h after capture", nt3.at === "2026-09-18T11:00:00.000Z" && /Intro email/.test(nt3.label))
check("next touch: a phone-only prospect is honest — no automated email exists for them", /Phone-only/.test(nt4.label) && nt4.at === null)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 13 · registration]")
const pkg = raw("package.json")
check(`"test:platform-prospect-funnel" script is registered`, /"test:platform-prospect-funnel":\s*"tsx --conditions=react-server scripts\/platform-prospect-funnel-simulator\.ts"/.test(pkg))
const guardLine = /"guard":\s*"([^"]+)"/.exec(pkg)?.[1] ?? ""
// ORDER, not adjacency (CLAUDE.md §2 — a pinned neighbour is a waypoint that
// every later wave's proof insertion breaks): it runs AFTER test:scrapers.
check("the guard chain runs it after test:scrapers (wave 76 ruling)",
  guardLine.indexOf("npm run test:scrapers") > -1 && guardLine.indexOf("npm run test:platform-prospect-funnel") > guardLine.indexOf("npm run test:scrapers"))
const registrySrc = stripped("lib/kernel/manager-registry.ts")
check("MAINTENANCE_DOMAINS carries platform_prospect_funnel, owner data_steward, proof test:platform-prospect-funnel", /platform_prospect_funnel:\s*\{\s*manager:\s*"data_steward",\s*proof:\s*"test:platform-prospect-funnel"/.test(registrySrc))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(60))
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  ✗ ${f}`)
  console.log("\n❌ PLATFORM_PROSPECT_FUNNEL — see failures above")
  process.exit(1)
}
console.log("\n✅ PLATFORM_PROSPECT_FUNNEL — all checks passed")
