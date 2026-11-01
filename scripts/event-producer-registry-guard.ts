#!/usr/bin/env tsx
/**
 * scripts/event-producer-registry-guard.ts   (npm run test:event-producer-registry) — in-memory, no DB, no network.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WAVE 148, LANE 148H — contract C22, owner rulings 12 / 14 / 20, verbatim: "any event needs producers or one place all feeds
 * into"; "we use Zoom so maybe use that for virtual open house? or YouTube Live?"; "an anonymous join click is not attendance".
 *
 *   A  THE CENSUS — the database's event_type vocabulary (the generated CHECK cache ∪ the newest migration's CHECK — assert the
 *      RULE, not a waypoint: the cache regenerates after m924 is applied) = lib/open-house/event-registry.ts EVENT_KINDS = the ONE
 *      scheduling door's refusing list; every kind's producer / registration / check-in / follow-up door EXISTS in stripped source;
 *      the registry's vocabularies equal their m924 / m925 CHECKs and the contacts timeline CHECK; every online kind routes a
 *      capability that routeCapability serves.
 *   B  THE WIRING — registration goes through C8 (captureConsentedContact, form owner = the event) and writes no contact itself;
 *      the join door never writes attendance; only verifyAttendance writes 'attended'; the Zoom webhook verifies BEFORE it
 *      dispatches participant events; createOpenHouse routes Zoom through routeCapability + the action ledger; the AI prompt
 *      meets the wave-148 expert standard.
 *   C  PURE RULES — identity matching (never a display name), the presence window, the verdict per kind, agent notification,
 *      the outcome, the Zoom payload parser, the copy scanner.
 *   D  RUNTIME (memSupabase + the canary harness, the REAL C8 survivor) — register → Contact once + consent + registration +
 *      personal Zoom link + one confirmation; the same person again is the SAME contact and registration; an anonymous Zoom join
 *      is evidence, not attendance; a click is not attendance; a registrant present ≥ the kind's minimum is verified once (one
 *      attendee row); a redelivery is a no-op; meeting.ended → no-shows on a verifiable host, none on YouTube; the replay goes
 *      once per registration, only when it exists.
 *
 * POSITIVE CONTROLS on every finder (a kind without a producer is caught; a join without identity is not attendance; a second
 * contact WOULD be counted). BLIND SPOTS printed at the end.
 * Run: NODE_OPTIONS=--max-old-space-size=6000 npx tsx --conditions=react-server scripts/event-producer-registry-guard.ts
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankComments, blankStrings } from "./strip-comments"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { memSupabase } from "./in-memory-supabase"
import { stubModule, setSvc } from "./canaries/_harness"

const ROOT = process.cwd()
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const raw = (rel: string): string => { try { return readFileSync(join(ROOT, rel), "utf8") } catch { return "" } }
const stripped = (rel: string): string => stripComments(raw(rel))
/** SQL: drop `--` line comments (a migration's own prose must never count as its CHECK). */
const sqlCode = (s: string): string => s.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n")
/**
 * The body of `function <name>(` (comment-blanked; braces matched on string-blanked text). The parameter list is skipped by
 * PAREN matching (a parameter's object type has braces), and a return-type annotation by ANGLE depth (`Promise<{ … }>` has
 * braces at depth 1; `=>` inside a type is not a closing angle) — the body is the first `{` at paren and angle depth 0.
 */
function bodyOf(src: string, fn: string): string {
  const c = blankComments(src), m = blankStrings(c)
  const at = m.search(new RegExp(`function\\s+${fn}\\s*[(<]`))
  if (at < 0) return ""
  let i = m.indexOf("(", at), paren = 0
  for (; i < m.length; i++) { if (m[i] === "(") paren++; else if (m[i] === ")" && --paren === 0) break }
  let angle = 0, open = -1
  for (i = i + 1; i < m.length; i++) {
    const ch = m[i]
    if (ch === "<") angle++
    else if (ch === ">" && m[i - 1] !== "=") angle = Math.max(0, angle - 1)
    else if (ch === "{" && angle === 0) { open = i; break }
  }
  if (open < 0) return ""
  let depth = 0
  for (let k = open; k < m.length; k++) { if (m[k] === "{") depth++; else if (m[k] === "}" && --depth === 0) return c.slice(at, k + 1) }
  return ""
}

/** The newest migration that (re)defines a CHECK, its ARRAY list parsed from SQL code (comments dropped). Lane stamp OR applied stamp. */
function newestCheckList(constraint: string): { file: string | null; values: string[] } {
  const files = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => /^m\d+.*\.sql$/.test(f)).sort((a, b) => Number(a.match(/^m(\d+)/)![1]) - Number(b.match(/^m(\d+)/)![1]))
  for (const f of files.reverse()) {
    const src = raw(`supabase/migrations/${f}`)
    const line1 = src.split("\n")[0] ?? ""
    if (!/^-- WRITTEN, NOT APPLIED \(wave \d+, lane \d+[A-Z0-9]*\)|^-- ── APPLIED LIVE /.test(line1)) continue
    const code = sqlCode(src)
    const m = new RegExp(`ADD CONSTRAINT ${constraint}\\s+CHECK\\s*\\(([\\s\\S]*?)\\);`, "i").exec(code)
    if (m) return { file: f, values: [...m[1].matchAll(/'([a-z_]+)'::text/g)].map((x) => x[1]) }
  }
  return { file: null, values: [] }
}

/**
 * THE C22 CENSUS (contract C22: "a census proves no type lacks a producer") — every value the database admits has a registry
 * entry whose producer, registration, check-in and follow-up doors EXIST in stripped source; every registry entry is a value the
 * database admits. `sourceOf` returns STRIPPED source (CLAUDE.md §2: a tombstone is not a call site).
 */
type Spec = import("../lib/open-house/event-registry").EventProducerSpec
function censusEventProducers(vocabulary: readonly string[], registry: Readonly<Record<string, Spec>>, sourceOf: (file: string) => string): Array<{ kind: string; problem: string }> {
  const out: Array<{ kind: string; problem: string }> = []
  const exports = (src: string, fn: string) => new RegExp(`export\\s+(async\\s+)?function\\s+${fn}\\s*\\(`).test(src)
  for (const v of vocabulary) {
    const spec = registry[v]
    if (!spec) { out.push({ kind: v, problem: "admitted by the database CHECK but has NO producer entry in the registry" }); continue }
    if (!exports(sourceOf(spec.producer.file), spec.producer.fn)) out.push({ kind: v, problem: `producer ${spec.producer.file}::${spec.producer.fn} does not exist` })
    if (spec.registration.door && !exports(sourceOf(spec.registration.door.file), spec.registration.door.fn)) out.push({ kind: v, problem: `registration door ${spec.registration.door.file}::${spec.registration.door.fn} does not exist` })
    if (spec.registration.required && !spec.registration.door) out.push({ kind: v, problem: "registration is required but no registration door is named" })
    for (const d of spec.attendance.checkInDoors) if (!exports(sourceOf(d.file), d.fn)) out.push({ kind: v, problem: `check-in door ${d.file}::${d.fn} does not exist` })
    if (spec.attendance.verifiedBy.length === 0) out.push({ kind: v, problem: "no way to verify attendance is declared" })
    if (!exports(sourceOf(spec.followUp.door.file), spec.followUp.door.fn)) out.push({ kind: v, problem: `follow-up door ${spec.followUp.door.file}::${spec.followUp.door.fn} does not exist` })
    if (spec.venue !== "in_person" && !spec.capability.hosting) out.push({ kind: v, problem: "an online kind with no hosting capability (law 3: capability → router → provider)" })
  }
  for (const k of Object.keys(registry)) if (!vocabulary.includes(k)) out.push({ kind: k, problem: "a registry entry the database CHECK does not admit (it could never be stored)" })
  return out
}

async function main(): Promise<void> {
  const reg = await import("../lib/open-house/event-registry")
  const { EVENT_KINDS, EVENT_PRODUCER_REGISTRY } = reg

  // ── A ─────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n── A  the census: CHECK = registry = the one producer's list; every door exists ──")
  const cached = CHECK_VOCABULARIES.open_house_events?.event_type ?? []
  const migrated = newestCheckList("open_house_events_event_type_check")
  const vocabulary = [...new Set([...cached, ...migrated.values])].sort()
  console.log(`  · event_type: cache [${cached.join(", ")}] ∪ ${migrated.file ?? "no migration"} [${migrated.values.join(", ")}] → [${vocabulary.join(", ")}]`)
  check("the newest event_type CHECK migration names every registry kind (the vocabulary the database WILL hold)", migrated.values.length > 0 && EVENT_KINDS.every((k) => migrated.values.includes(k)), JSON.stringify(migrated))
  const findings = censusEventProducers(vocabulary, EVENT_PRODUCER_REGISTRY, stripped)
  check(`every event type the database admits has a producer, registration, check-in and follow-up door that exists (${findings.length} finding(s))`, findings.length === 0, JSON.stringify(findings))
  // POSITIVE CONTROLS — a kind with no producer; a door that does not exist; a door present only as a TOMBSTONE comment.
  const pc1 = censusEventProducers([...vocabulary, "community_bbq"], EVENT_PRODUCER_REGISTRY, stripped)
  check("POSITIVE CONTROL: a type the CHECK admits with NO registry producer is caught", pc1.some((f) => f.kind === "community_bbq" && /NO producer/.test(f.problem)))
  const broken = { ...EVENT_PRODUCER_REGISTRY, webinar: { ...EVENT_PRODUCER_REGISTRY.webinar, producer: { file: "app/actions/open-house.ts", fn: "createWebinarTwin" } } }
  const pc2 = censusEventProducers(vocabulary, broken as never, stripped)
  check("POSITIVE CONTROL: a producer that does not exist in its file is caught", pc2.some((f) => f.kind === "webinar" && /does not exist/.test(f.problem)))
  const tomb = (file: string) => (file === "x.ts" ? stripComments("// export async function createOpenHouse() {} — tombstone: moved\n") : stripped(file))
  const pc3 = censusEventProducers(["open_house"], { open_house: { ...EVENT_PRODUCER_REGISTRY.open_house, producer: { file: "x.ts", fn: "createOpenHouse" } } } as never, tomb)
  check("POSITIVE CONTROL: a producer present only as a tombstone comment is NOT credited (stripped source)", pc3.some((f) => /does not exist/.test(f.problem)))
  const pc4 = censusEventProducers(["open_house"], EVENT_PRODUCER_REGISTRY, stripped)
  check("POSITIVE CONTROL: a registry entry the CHECK does not admit is caught", pc4.some((f) => /does not admit/.test(f.problem)))
  check("EVENT_KINDS = the registry's keys (one spelling each)", JSON.stringify([...EVENT_KINDS].sort()) === JSON.stringify(Object.keys(EVENT_PRODUCER_REGISTRY).sort()))
  const producerBody = bodyOf(raw("app/actions/open-house.ts"), "createOpenHouse")
  const list = /const\s+OPEN_HOUSE_EVENT_TYPES\s*=\s*\[([^\]]*)\]/.exec(producerBody)
  const producerKinds = list ? [...list[1].matchAll(/["']([a-z_]+)["']/g)].map((m) => m[1]).sort() : []
  check("the ONE scheduling door's refusing list = EVENT_KINDS (no twin producer, no kind the registry lacks)",
    JSON.stringify(producerKinds) === JSON.stringify([...EVENT_KINDS].sort()) && /!\s*\(\s*OPEN_HOUSE_EVENT_TYPES\s+as\s+readonly\s+string\[\]\s*\)\.includes\(\s*eventType\s*\)\s*\)\s*return\b/.test(producerBody), JSON.stringify(producerKinds))
  const timeline = [...(CHECK_VOCABULARIES.contacts?.timeline ?? [])].sort()
  check("the situation timeline = the live contacts.timeline CHECK (buckets, never 30/60/90 — CLAUDE.md §5)", JSON.stringify([...reg.EVENT_TIMELINE_BUCKETS].sort()) === JSON.stringify(timeline), JSON.stringify(timeline))
  check("VIRTUAL_PROVIDERS = m924's virtual_provider CHECK", JSON.stringify([...reg.VIRTUAL_PROVIDERS].sort()) === JSON.stringify(newestCheckList("open_house_events_virtual_provider_check").values.sort()))
  check("ATTENDANCE_VERIFIERS = m925's attendance_verified_by CHECK (a click is not among them)", JSON.stringify([...reg.ATTENDANCE_VERIFIERS].sort()) === JSON.stringify(newestCheckList("open_house_rsvp_tracking_attendance_verified_by_check").values.sort()) && !(reg.ATTENDANCE_VERIFIERS as readonly string[]).some((v) => /click|open/.test(v)))
  const m925 = sqlCode(raw("supabase/migrations/m925-event-registration-and-verified-attendance.sql"))
  const im = /identity_match\s+text NOT NULL CHECK \(identity_match = ANY \(ARRAY\[([^\]]*)\]/.exec(m925)
  check("IDENTITY_MATCHES = m925's identity_match CHECK", !!im && JSON.stringify([...reg.IDENTITY_MATCHES].sort()) === JSON.stringify([...im[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort()))
  const intentTypes = Object.values(reg.CONTACT_TYPE_FOR_INTENT)
  check("every intent maps to a live contacts.contact_type CHECK value", intentTypes.every((t) => (CHECK_VOCABULARIES.contacts?.contact_type ?? []).includes(t)))
  const { CONSENT_PURPOSES } = await import("../lib/kernel/compliance/require-contact-consent")
  check("every registry consent purpose is a C8 consent purpose", Object.values(EVENT_PRODUCER_REGISTRY).every((s) => s.registration.consentPurposes.every((p) => (CONSENT_PURPOSES as readonly string[]).includes(p))))
  const rail = await import("../lib/ai-isa/property-lookup-rail")
  const hosting = rail.routeCapability("virtual_event_hosting", {}), broadcast = rail.routeCapability("live_broadcast", {})
  check("every online kind's hosting capability is served by routeCapability (virtual_event_hosting → zoom; live_broadcast → youtube) — law 3",
    Object.values(EVENT_PRODUCER_REGISTRY).filter((s) => s.venue !== "in_person").every((s) => s.capability.hosting === "virtual_event_hosting") && hosting.providers.join() === "zoom" && broadcast.providers.join() === "youtube")
  check("POSITIVE CONTROL: a failing Zoom is routed around with its reason (the event degrades to a pasted link, honestly unverifiable)",
    rail.routeCapability("virtual_event_hosting", { zoom: { state: "failing", routeAround: true, reason: "5 faults" } }).providers.length === 0)
  check("every online kind declares Zoom 'verified' and YouTube / an external link 'unverifiable' (YouTube exposes no per-viewer identity)",
    Object.values(EVENT_PRODUCER_REGISTRY).filter((s) => s.venue !== "in_person").every((s) => s.attendance.providers.zoom === "verified" && s.attendance.providers.youtube === "unverifiable" && s.attendance.providers.external_link === "unverifiable" && (s.attendance.minVerifiedSeconds ?? 0) > 0))

  // ── B ─────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n── B  the wiring ──")
  const att = stripped("lib/open-house/event-attendance.ts")
  const regBody = bodyOf(raw("lib/open-house/event-attendance.ts"), "registerForEvent")
  check("registration captures through C8 — captureConsentedContact with the EVENT as the form owner (tenant from the event row)",
    /captureConsentedContact/.test(regBody) && /formOwner:\s*\{\s*table:\s*"open_house_events",\s*id:\s*ev\.id\s*\}/.test(regBody) && /brokerageId:\s*ev\.brokerage_id/.test(regBody))
  check("registration assigns the person back to the event's creating agent / user (ruling 12) and records the creator on the registration",
    /ownerAgentId:\s*ev\.agent_id/.test(regBody) && /agentUserId:\s*ev\.created_by/.test(regBody) && /created_by_user_id:/.test(regBody))
  const ownContactWrite = /\.from\(\s*["']contacts["']\s*\)\s*\.\s*(insert|upsert|update)\(/
  check("the attendance module writes NO contacts row itself (identity is C8's)", !ownContactWrite.test(blankStrings(att).replace(/\s+/g, " ")) && !ownContactWrite.test(att))
  check("POSITIVE CONTROL: the own-write finder sees a direct contacts insert", ownContactWrite.test(`await svc.from("contacts").insert({ email })`))
  check("the register route calls registerForEvent with the SERVICE client and takes no brokerage from the body",
    /registerForEvent\(\s*createServiceClient\(\)/.test(stripped("app/api/open-house/register/route.ts")) && !/body\.brokerage/i.test(stripped("app/api/open-house/register/route.ts")))
  const joinSrc = stripped("app/open-house/[eventId]/join/route.ts")
  const writesAttended = (s: string) => /rsvp_status\s*:\s*["']attended["']|attendance_verified_by\s*:/.test(s)
  check("A CLICK IS NOT ATTENDANCE: the join door writes no 'attended' and no attendance verifier", !!joinSrc && !writesAttended(joinSrc))
  check("POSITIVE CONTROL: a join door that writes rsvp_status 'attended' is caught", writesAttended(`supabase.from("open_house_rsvp_tracking").upsert({ rsvp_status: "attended" })`))
  check("the join door forwards ONLY to this event's own rows (check_in_url / the registration's provider_join_url, https) — never a link parameter",
    /new URL\(String\(ev\?\.check_in_url/.test(joinSrc) && /provider_join_url/.test(joinSrc) && !/searchParams\.get\([^)]*\)[\s\S]{0,40}redirect\(|redirect\([^)]*searchParams/.test(joinSrc) && /\.eq\("event_id", ev\.id\)\s*\.eq\("brokerage_id", ev\.brokerage_id\)/.test(joinSrc))
  const attendedSites = [...blankComments(raw("lib/open-house/event-attendance.ts")).matchAll(/rsvp_status:\s*"attended"/g)].length
  const verifyBody = bodyOf(raw("lib/open-house/event-attendance.ts"), "verifyAttendance")
  check(`only verifyAttendance writes 'attended' (${attendedSites} site(s) in the module, inside it: ${(verifyBody.match(/rsvp_status:\s*"attended"/g) ?? []).length})`,
    attendedSites === 1 && /rsvp_status:\s*"attended"/.test(verifyBody) && /action:\s*"open_house\.attendance\.verify"/.test(verifyBody))
  const hook = stripped("app/api/webhooks/zoom/route.ts")
  check("the Zoom webhook VERIFIES (x-zm-signature) before it dispatches participant / meeting.ended events to the attendance recorder",
    hook.indexOf("verifyZoomWebhook(") > 0 && hook.indexOf("verifyZoomWebhook(") < hook.indexOf("recordZoomParticipantEvent(") && /ZOOM_PARTICIPANT_EVENTS/.test(hook) && /meeting\.ended[\s\S]{0,200}recordZoomMeetingEnded\(/.test(hook))
  const hostBody = bodyOf(raw("app/actions/open-house.ts"), "hostEventOnZoom")
  check("createOpenHouse hosts Zoom through routeCapability('virtual_event_hosting') → a ledgered ensureZoomMeetingForAppointment WITH registration on the tenant cascade",
    /routeCapability\(\s*"virtual_event_hosting"/.test(hostBody) && /withActionLedger\(/.test(hostBody) && /action:\s*"open_house\.virtual_meeting\.create"/.test(hostBody) && /registration:\s*true/.test(hostBody) && /scope:\s*"agent"/.test(hostBody) && /hostEventOnZoom\(/.test(producerBody))
  check("hostEventOnZoom is NOT exported from the \"use server\" file (a step, not a public endpoint)", !/export\s+async\s+function\s+hostEventOnZoom/.test(stripped("app/actions/open-house.ts")))
  const approveBody = bodyOf(raw("app/actions/open-house.ts"), "approveEventMarketing")
  check("publication is a person's act: approveEventMarketing asks approverFor('publication'), refuses a blocking scan, ledgers, then publishes",
    /approverFor\(/.test(approveBody) && /assetKind:\s*"publication"/.test(approveBody) && /scan\.blocking/.test(approveBody) && /withActionLedger\(/.test(approveBody) && /is_published:\s*true/.test(approveBody))
  check("an event that requires registration sends NO invitation before its copy is approved", /params\.sendInvites\s*&&\s*event\.id\s*&&\s*!spec\.registration\.required/.test(producerBody))
  const mk = await import("../lib/open-house/event-marketing")
  const P = mk.EVENT_MARKETING_SYSTEM
  const rubric = [/ROLE AND MANDATE/, /THE PERSON YOU SERVE/, /FACTS YOU MAY RELY ON/, /NEVER invent/, /FAIR HOUSING/, /THE DECISION YOU OWN/, /creative brief/i, /OUTPUT CONTRACT/, /ESCALATION/, /\{\{join_link\}\}/, /\{\{replay_link\}\}/, /Reply STOP/]
  const missingRubric = rubric.filter((r) => !r.test(P)).map(String)
  check(`the event-marketing prompt meets the wave-148 expert standard (${P.length} chars, ${rubric.length - missingRubric.length}/${rubric.length} rubric items)`, P.length > 2500 && missingRubric.length === 0, missingRubric.join(", "))
  check("POSITIVE CONTROL: a one-line prompt fails the rubric", rubric.filter((r) => r.test("Write an invitation for this event.")).length < 3)
  check("the processEventFollowups sweep settles online attendance (finalize + replay) before it hands attendees over",
    /finalizeEventAttendance\(/.test(bodyOf(raw("app/actions/open-house-automation.ts"), "processEventFollowups")) && bodyOf(raw("app/actions/open-house-automation.ts"), "processEventFollowups").indexOf("finalizeEventAttendance(") < bodyOf(raw("app/actions/open-house-automation.ts"), "processEventFollowups").indexOf("handoffOpenHouseLeads"))

  // ── C ─────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n── C  pure rules ──")
  const regs = [
    { contactId: "c-ana", providerRegistrantId: "REG-ANA", email: "ana@example.test" },
    { contactId: "c-bo", providerRegistrantId: null, email: "bo@example.test" },
    { contactId: "c-dup1", providerRegistrantId: null, email: "shared@example.test" },
    { contactId: "c-dup2", providerRegistrantId: null, email: "shared@example.test" },
  ]
  const none = { registrantId: null, email: null, accountUserId: null, sessionUserId: "16778240", displayName: null }
  check("a Zoom registrant id this event minted → that registrant", reg.matchParticipantIdentity({ ...none, registrantId: "REG-ANA" }, regs, { hostId: "H1" }).contactId === "c-ana")
  check("a signed-in participant's exact e-mail (any case) → that registrant", reg.matchParticipantIdentity({ ...none, email: "BO@example.test" }, regs, { hostId: "H1" }).contactId === "c-bo")
  const anon = reg.matchParticipantIdentity({ ...none, displayName: "Ana Lopez" }, regs, { hostId: "H1" })
  check("POSITIVE CONTROL — A JOIN WITHOUT IDENTITY IS NOT ATTENDANCE: a display name that equals a registrant's name files NOBODY", anon.contactId === null && anon.match === "unmatched")
  check("a registrant id this event never minted (registered on Zoom, outside our consented form) files nobody", reg.matchParticipantIdentity({ ...none, registrantId: "REG-ELSEWHERE", email: null }, regs, { hostId: "H1" }).match === "unmatched")
  check("an e-mail two registrations share is ambiguous → nobody", reg.matchParticipantIdentity({ ...none, email: "shared@example.test" }, regs, { hostId: "H1" }).contactId === null)
  check("the meeting host is the host, never a registrant's attendance", reg.matchParticipantIdentity({ ...none, accountUserId: "H1", email: "ana@example.test" }, regs, { hostId: "H1" }).match === "host")
  const T = (m: number) => new Date(Date.UTC(2026, 10, 10, 18, m)).toISOString()
  const w = reg.computeAttendanceWindow([{ kind: "participant_joined", at: T(0), participantKey: "p1" }, { kind: "participant_left", at: T(6), participantKey: "p1" }])
  check("join 18:00 → leave 18:06 = 360 s present", w.seconds === 360 && w.firstJoinedAt === T(0) && w.lastLeftAt === T(6))
  const two = reg.computeAttendanceWindow([{ kind: "participant_joined", at: T(0), participantKey: "phone" }, { kind: "participant_joined", at: T(2), participantKey: "laptop" }, { kind: "participant_left", at: T(5), participantKey: "phone" }, { kind: "participant_left", at: T(8), participantKey: "laptop" }])
  check("two devices overlapping are merged, not double time (0–8 min = 480 s)", two.seconds === 480)
  const rejoin = reg.computeAttendanceWindow([{ kind: "participant_joined", at: T(0), participantKey: "a" }, { kind: "participant_left", at: T(2), participantKey: "a" }, { kind: "participant_joined", at: T(10), participantKey: "b" }, { kind: "participant_left", at: T(13), participantKey: "b" }])
  check("a rejoin counts both stretches, not the gap (2 + 3 min = 300 s)", rejoin.seconds === 300)
  const open = reg.computeAttendanceWindow([{ kind: "participant_joined", at: T(0), participantKey: "a" }])
  check("a join with no leave and no meeting end is NOT presence (0 s, one open session) — presence is never assumed", open.seconds === 0 && open.openSessions === 1)
  check("…closed at the meeting's end it counts to the end", reg.computeAttendanceWindow([{ kind: "participant_joined", at: T(0), participantKey: "a" }], T(45)).seconds === 2700)
  check("the verdict: a webinar needs 300 s — 299 s is not attendance, 300 s is", !reg.attendanceVerdict({ kind: "webinar", provider: "zoom", matched: true, seconds: 299 }).attended && reg.attendanceVerdict({ kind: "webinar", provider: "zoom", matched: true, seconds: 300 }).verifiedBy === "zoom_participant")
  check("the verdict: YouTube or an external link is never attendance, however long", !reg.attendanceVerdict({ kind: "webinar", provider: "youtube", matched: true, seconds: 9999 }).attended && !reg.attendanceVerdict({ kind: "virtual_open_house", provider: "external_link", matched: true, seconds: 9999 }).attended)
  check("the verdict: an unmatched participant is never attendance", !reg.attendanceVerdict({ kind: "webinar", provider: "zoom", matched: false, seconds: 9999 }).attended)
  check("the agent is told about a verified attendee with a near timeline or a question — never about a click, never about a quiet verified attendee",
    reg.shouldNotifyAgent({ verified: true, engagementRatio: 0.2, situation: { timeline: "1-3_months" }, audience: "consumer" }).notify
    && reg.shouldNotifyAgent({ verified: true, engagementRatio: 0.2, situation: { question: "Can I buy with 5% down?" }, audience: "consumer" }).notify
    && !reg.shouldNotifyAgent({ verified: false, engagementRatio: 1, situation: { timeline: "immediate" }, audience: "consumer" }).notify
    && !reg.shouldNotifyAgent({ verified: true, engagementRatio: 0.3, situation: { timeline: "12+_months" }, audience: "consumer" }).notify)
  const outYT = reg.eventOutcome({ kind: "webinar", provider: "youtube", rsvps: [{ rsvp_status: "yes", attendance_verified_by: null, registered_at: T(0) }], unmatchedJoins: 0 })
  check("the outcome on an unverifiable host claims no no-show and no rate (unverifiable 1, rate null)", outYT.noShow === 0 && outYT.unverifiable === 1 && outYT.attendanceRate === null)
  const zoom = await import("../lib/connections/zoom")
  const pj = zoom.parseZoomParticipantEvent({ event: "meeting.participant_joined", payload: { object: { id: 987654321, uuid: "u==", host_id: "H1", participant: { user_id: "16778240", user_name: "Ana", email: "", registrant_id: "REG-ANA", participant_uuid: "pu-1", join_time: T(0) } } } })
  check("the Zoom parser keeps the registrant id, turns Zoom's empty e-mail into null, and keys the session on participant_uuid", pj?.registrantId === "REG-ANA" && pj.email === null && pj.participantKey === "pu-1" && pj.meetingId === "987654321" && pj.kind === "participant_joined")
  check("…and refuses a non-participant event or one with no time", zoom.parseZoomParticipantEvent({ event: "recording.completed", payload: { object: { id: 1 } } }) === null && zoom.parseZoomParticipantEvent({ event: "meeting.participant_left", payload: { object: { id: 1, participant: {} } } }) === null)
  check("Zoom's answered approval_type decides registration (0/1 on; 2 = Zoom silently refused it) — and the adapter reads the ANSWER, not the request",
    reg.zoomRegistrationEnabled(0) && reg.zoomRegistrationEnabled(1) && !reg.zoomRegistrationEnabled(2) && !reg.zoomRegistrationEnabled(undefined)
    && /registrationEnabled:\s*zoomRegistrationEnabled\(\s*res\.data\.settings\?\.approval_type\s*\)/.test(stripped("lib/connections/zoom.ts")))
  const goodDraft = {
    headline: "Buying your first home", registration_intro: "Join us.", what_you_will_learn: ["a"], invitation_subject: "s", invitation_body: "b", invitation_sms: "Join us. Reply STOP to opt out.",
    confirmation_subject: "s", confirmation_body: "See you {{date_time}} — {{join_link}}", replay_attended_subject: "s", replay_attended_body: "Here: {{replay_link}}", replay_missed_subject: "s", replay_missed_body: "Here: {{replay_link}}", social_post: "p", self_check: "",
  }
  check("a clean draft is approvable", !mk.scanEventCopy(goodDraft, { online: true }).blocking)
  check("POSITIVE CONTROL: 'perfect for families' in a public field blocks approval (fair housing on public copy)", mk.scanEventCopy({ ...goodDraft, registration_intro: "This home is perfect for families." }, { online: true }).blocking)
  check("POSITIVE CONTROL: an online confirmation without {{join_link}} is not approvable (it would be no confirmation)", mk.scanEventCopy({ ...goodDraft, confirmation_body: "See you then" }, { online: true }).missing.some((m) => /join_link/.test(m)))

  // ── D ─────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n── D  runtime: registration → verified attendance → outcome → replay (memSupabase, the real C8) ──")
  {
    const B = "b1480000-0000-4000-8000-0000000000a1", AG = "a1480000-0000-4000-8000-0000000000a1", U = "d1480000-0000-4000-8000-0000000000a1"
    const EV = "e1480000-0000-4000-8000-0000000000a1", EVY = "e1480000-0000-4000-8000-0000000000a2", EVD = "e1480000-0000-4000-8000-0000000000a3"
    stubModule("next/cache", "export const revalidatePath = () => {}; export const revalidateTag = () => {}")
    // The confirmation carries an ABSOLUTE personal link; with no public origin configured it is (honestly) not sent — the
    // fixture names one, as every deployment must (NEXT_PUBLIC_APP_URL — a variable NAME, no value read from the environment).
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test"
    const approved = { status: "approved", approved: goodDraft }
    const svc = memSupabase({
      brokerages: [{ id: B, name: "Harbor Realty" }],
      agents: [{ id: AG, user_id: U, brokerage_id: B, is_active: true }],
      users: [{ id: U, brokerage_id: B, first_name: "Dana", last_name: "Host", user_type: "agent" }],
      open_house_events: [
        { id: EV, brokerage_id: B, agent_id: AG, created_by: U, listing_id: null, event_type: "webinar", status: "scheduled", title: "First-time buyer basics", event_date: "2026-11-10", start_time: "18:00", end_time: "19:00", timezone: "America/New_York", check_in_url: "https://zoom.us/j/987654321", virtual_provider: "zoom", provider_meeting_id: "987654321", provider_meta: { host_owner_type: "agent", host_owner_id: U, registration_enabled: true }, marketing_assets: approved, is_published: true, replay_url: null },
        { id: EVY, brokerage_id: B, agent_id: AG, created_by: U, listing_id: null, event_type: "webinar", status: "scheduled", title: "Selling this spring", event_date: "2026-11-11", start_time: "18:00", end_time: "19:00", timezone: "America/New_York", check_in_url: "https://www.youtube.com/live/abc123", virtual_provider: "youtube", provider_meeting_id: null, provider_meta: {}, marketing_assets: approved, is_published: true, replay_url: null },
        { id: EVD, brokerage_id: B, agent_id: AG, created_by: U, listing_id: null, event_type: "webinar", status: "scheduled", title: "Draft session", event_date: "2026-11-12", start_time: "18:00", end_time: "19:00", virtual_provider: "zoom", provider_meeting_id: "111", provider_meta: {}, marketing_assets: {}, is_published: false },
      ],
      contacts: [], contact_consent_events: [], open_house_rsvp_tracking: [], open_house_attendees: [], event_attendance_evidence: [],
      lifecycle_events: [], person_identities: [], person_identity_evidence: [], agent_action_ledger: [], manager_signals: [], leads: [],
    }, {
      uuidIds: true,
      unique: {
        open_house_rsvp_tracking: [["event_id", "contact_id"]], open_house_attendees: [["event_id", "contact_id"]],
        event_attendance_evidence: [["dedupe_key"]], agent_action_ledger: [["idempotency_key"]],
      },
    })
    setSvc(svc)
    const tbl = (t: string) => (((svc as any).tables?.[t] ?? []) as any[])
    const A = await import("../lib/open-house/event-attendance")
    const sent: Array<{ to: string; subject: string; text: string }> = []
    const zoomCalls: string[] = []
    const regDeps = {
      addRegistrant: async (_s: unknown, a: { email: string }) => { zoomCalls.push(a.email); return { added: true as const, registrantId: a.email.startsWith("ana") ? "REG-ANA" : `REG-${zoomCalls.length}`, joinUrl: `https://zoom.us/w/987654321?tk=${zoomCalls.length}` } },
      sendEmail: async (p: { to: string; subject: string; text: string }) => { sent.push(p); return { success: true } },
    }
    const base = { eventId: EV, firstName: "Ana", lastName: "Lopez", email: "ana@example.test", phone: "8135550148", situation: { intent: "buying", timeline: "1-3_months", workingWithAgent: false, question: "How much do I need for a down payment?" }, consent: { serviceDelivery: true, textReminders: true, marketing: false }, evidence: { ip: "10.14.8.1", userAgent: "guard" } }
    const r1 = await A.registerForEvent(svc as never, base, regDeps)
    const contact = tbl("contacts")[0], rsvp = tbl("open_house_rsvp_tracking")[0]
    check("register → ONE Contact through C8, assigned to the event's agent, typed by the stated intent", r1.ok === true && tbl("contacts").length === 1 && contact?.brokerage_id === B && contact?.agent_id === AG && contact?.contact_type === "buyer", JSON.stringify({ r1, contact }).slice(0, 400))
    check("…its consent rows anchored to the contact with the server's wording version (email + the explicit SMS box)", tbl("contact_consent_events").filter((c) => c.contact_id === contact?.id).length >= 1 && tbl("contact_consent_events").every((c) => c.consent_text_version === "event_registration:v1" || c.consent_text_version == null), JSON.stringify(tbl("contact_consent_events").map((c) => ({ v: c.consent_text_version, ch: c.channels }))).slice(0, 300))
    check("…ONE registration row: tenant from the event, the situation verbatim, the creating user, registered_at, the C8 consent id", !!rsvp && rsvp.brokerage_id === B && rsvp.rsvp_status === "yes" && rsvp.source === "web_registration" && rsvp.situation?.timeline === "1-3_months" && rsvp.situation?.question === base.situation.question && rsvp.created_by_user_id === U && !!rsvp.registered_at, String(JSON.stringify(rsvp)).slice(0, 400))
    check("…the person's own Zoom registrant + personal https link stored (the key attendance is verified on)", rsvp?.provider_registrant_id === "REG-ANA" && /^https:\/\/zoom\.us\/w\//.test(rsvp?.provider_join_url ?? "") && r1.ok && r1.zoomRegistered)
    check("…and ONE confirmation, in the approved words, carrying the personal join path", sent.length === 1 && sent[0].to === "ana@example.test" && r1.ok && !!r1.joinPath && r1.joinPath.includes(`/open-house/${EV}/join?r=`), JSON.stringify(sent).slice(0, 300))
    const r2 = await A.registerForEvent(svc as never, { ...base, email: "ANA@example.test", situation: { ...base.situation, timeline: "immediate" } }, regDeps)
    check("NO DUPLICATE CONTACT: the same person registering again is the SAME contact and the SAME registration — no second email, no second Zoom registrant",
      r2.ok === true && r2.replay === true && tbl("contacts").length === 1 && tbl("open_house_rsvp_tracking").length === 1 && sent.length === 1 && zoomCalls.length === 1, JSON.stringify({ r2, contacts: tbl("contacts").length, rsvps: tbl("open_house_rsvp_tracking").length, sent: sent.length, zoomCalls }))
    const r3 = await A.registerForEvent(svc as never, { ...base, firstName: "Bo", lastName: "Chen", email: "bo@example.test", phone: null, situation: { intent: "learning" } }, regDeps)
    check("POSITIVE CONTROL: a different person IS a second contact (the counter above can move)", r3.ok === true && tbl("contacts").length === 2 && tbl("open_house_rsvp_tracking").length === 2)
    const before = tbl("contacts").length
    const noConsent = await A.registerForEvent(svc as never, { ...base, email: "nc@example.test", consent: { serviceDelivery: false, textReminders: false, marketing: false } }, regDeps)
    const unpublished = await A.registerForEvent(svc as never, { ...base, eventId: EVD, email: "draft@example.test" }, regDeps)
    check("no service-delivery consent → refused (400), nothing filed; an unapproved (unpublished) page → 404", !noConsent.ok && noConsent.status === 400 && !unpublished.ok && unpublished.status === 404 && tbl("contacts").length === before)

    const seen: { emitted: any[]; notified: any[]; linked: any[] } = { emitted: [], notified: [], linked: [] }
    const attDeps = {
      emit: async (p: any) => { seen.emitted.push(p) },
      notifyAgent: async (p: any) => { seen.notified.push(p); return { success: true } },
      linkIdentity: async (_s: unknown, p: any) => { seen.linked.push(p) },
    }
    const zp = (event: string, part: Record<string, unknown>) => ({ event, payload: { object: { id: 987654321, uuid: "mtg-uuid-1", host_id: "HOST-1", topic: "First-time buyer basics", participant: part } } })
    const anonRes = await A.recordZoomParticipantEvent(svc as never, zp("meeting.participant_joined", { user_id: "900", user_name: "Ana Lopez", email: "", participant_uuid: "anon-1", join_time: T(0) }), attDeps)
    check("POSITIVE CONTROL — AN ANONYMOUS JOIN IS NOT ATTENDANCE: recorded as unmatched evidence, nobody filed, no attendee, the registration untouched",
      anonRes.handled === true && anonRes.contactId === null && tbl("event_attendance_evidence").length === 1 && tbl("event_attendance_evidence")[0].identity_match === "unmatched" && tbl("event_attendance_evidence")[0].contact_id == null && tbl("open_house_attendees").length === 0 && tbl("open_house_rsvp_tracking").every((r) => r.rsvp_status === "yes"), JSON.stringify(anonRes))

    const { NextRequest } = await import("next/server")
    const joinRoute = await import("../app/open-house/[eventId]/join/route")
    const click = await joinRoute.GET(new NextRequest(`http://localhost/open-house/${EV}/join?r=${rsvp.id}`, { headers: { "x-forwarded-for": "10.14.8.2" } }), { params: Promise.resolve({ eventId: EV }) })
    check("A CLICK IS NOT ATTENDANCE: the personal join link forwards to the registrant's OWN Zoom link and records no attendance",
      click.status === 302 && /^https:\/\/zoom\.us\/w\//.test(click.headers.get("location") ?? "") && tbl("open_house_rsvp_tracking").find((r) => r.id === rsvp.id)?.rsvp_status === "yes" && tbl("open_house_attendees").length === 0, `${click.status} ${click.headers.get("location")}`)
    const evil = await joinRoute.GET(new NextRequest(`http://localhost/open-house/${EV}/join?to=https://evil.example.test`, { headers: { "x-forwarded-for": "10.14.8.2" } }), { params: Promise.resolve({ eventId: EV }) })
    check("POSITIVE CONTROL: a link parameter never moves the forward target (not an open redirect)", evil.headers.get("location") === "https://zoom.us/j/987654321")

    const j = await A.recordZoomParticipantEvent(svc as never, zp("meeting.participant_joined", { user_id: "901", user_name: "Ana", email: "", registrant_id: "REG-ANA", participant_uuid: "ana-1", join_time: T(1) }), attDeps)
    check("a registrant's join alone is not yet attendance (present 0 s so far)", j.handled === true && j.contactId === contact.id && j.attended === false)
    const l = await A.recordZoomParticipantEvent(svc as never, zp("meeting.participant_left", { user_id: "901", user_name: "Ana", email: "", registrant_id: "REG-ANA", participant_uuid: "ana-1", leave_time: T(8), leave_reason: "left the meeting" }), attDeps)
    const anaRsvp = tbl("open_house_rsvp_tracking").find((r) => r.contact_id === contact.id)
    const anaAtt = tbl("open_house_attendees").filter((a) => a.contact_id === contact.id)
    check("present 7 min (≥ the webinar's 300 s) → VERIFIED once: rsvp attended + verified_by zoom_participant + 420 s, ONE attendee row with the contact",
      l.handled === true && l.attended === true && anaRsvp?.rsvp_status === "attended" && anaRsvp?.attendance_verified_by === "zoom_participant" && anaRsvp?.attended_seconds === 420 && anaAtt.length === 1 && anaAtt[0].brokerage_id === B, JSON.stringify({ l, anaRsvp, anaAtt }).slice(0, 400))
    check("…the arbiter's reader is told (OPEN_HOUSE_ATTENDEE_CAPTURED with contactId + eventId, verified_by zoom_participant) and person identity linked",
      seen.emitted.length === 1 && seen.emitted[0].contactId === contact.id && seen.emitted[0].metadata?.eventId === EV && seen.emitted[0].metadata?.verified_by === "zoom_participant" && seen.linked.length === 1)
    check("…and the agent is notified — the registrant stated a 1–3 month timeline and asked a question (appropriate)", seen.notified.length === 1 && seen.notified[0].agent_id === AG)
    const evidenceBefore = tbl("event_attendance_evidence").length
    const redelivery = await A.recordZoomParticipantEvent(svc as never, zp("meeting.participant_left", { user_id: "901", user_name: "Ana", email: "", registrant_id: "REG-ANA", participant_uuid: "ana-1", leave_time: T(8), leave_reason: "left the meeting" }), attDeps)
    check("a Zoom REDELIVERY is a no-op (dedupe key): no new evidence, no second attendee, no second fan-out", redelivery.handled === true && (redelivery as any).replay === true && tbl("event_attendance_evidence").length === evidenceBefore && tbl("open_house_attendees").length === 1 && seen.emitted.length === 1)
    // Bo joins signed in (exact e-mail), stays 2 minutes → not attendance.
    await A.recordZoomParticipantEvent(svc as never, zp("meeting.participant_joined", { user_id: "902", user_name: "B.", email: "bo@example.test", participant_uuid: "bo-1", join_time: T(2) }), attDeps)
    await A.recordZoomParticipantEvent(svc as never, zp("meeting.participant_left", { user_id: "902", user_name: "B.", email: "bo@example.test", participant_uuid: "bo-1", leave_time: T(4) }), attDeps)
    const boContact = tbl("contacts").find((c) => c.email === "bo@example.test")
    check("a signed-in registrant matched by exact e-mail but present 120 s (< 300 s) is NOT attendance", tbl("open_house_rsvp_tracking").find((r) => r.contact_id === boContact?.id)?.rsvp_status === "yes" && !tbl("open_house_attendees").some((a) => a.contact_id === boContact?.id))
    const ended = await A.recordZoomMeetingEnded(svc as never, { event: "meeting.ended", payload: { object: { id: 987654321, uuid: "mtg-uuid-1", end_time: T(60) } } }, attDeps)
    const boAfter = tbl("open_house_rsvp_tracking").find((r) => r.contact_id === boContact?.id)
    check("meeting.ended on a VERIFIABLE host → Bo is a no_show; the outcome is stored (registered 2 · verified 1 · no-show 1 · anonymous joins 1)",
      ended.finalized === true && boAfter?.rsvp_status === "no_show" && (ended as any).outcome?.registered === 2 && (ended as any).outcome?.attendedVerified === 1 && (ended as any).outcome?.noShow === 1 && (ended as any).outcome?.anonymousJoins === 1
      && !!tbl("open_house_events").find((e) => e.id === EV)?.provider_meta?.attendance_outcome, JSON.stringify(ended).slice(0, 400))
    check("…the anonymous joiner is still nobody's attendance after the meeting ends", tbl("open_house_attendees").length === 1)

    // YouTube: registration-gated, attendance unverifiable — no no-show is ever claimed.
    const ry = await A.registerForEvent(svc as never, { ...base, eventId: EVY, firstName: "Cy", lastName: "Park", email: "cy@example.test", phone: null }, regDeps)
    const cyRsvp = tbl("open_house_rsvp_tracking").find((r) => r.event_id === EVY)
    const ytClick = await joinRoute.GET(new NextRequest(`http://localhost/open-house/${EVY}/join?r=${cyRsvp?.id}`, { headers: { "x-forwarded-for": "10.14.8.3" } }), { params: Promise.resolve({ eventId: EVY }) })
    const finY = await A.finalizeEventAttendance(svc as never, EVY, attDeps)
    check("YouTube Live: consented registration + its watch link; opening it is 'watch_link_opened' evidence (registration token), NEVER attendance; finalize marks NO no-show",
      ry.ok === true && zoomCalls.length === 2 && ytClick.headers.get("location") === "https://www.youtube.com/live/abc123" && tbl("event_attendance_evidence").some((e) => e.event_id === EVY && e.provider_event === "watch_link_opened" && e.identity_match === "registration_token")
      && cyRsvp?.rsvp_status === "yes" && finY.finalized === true && (finY.noShowsMarked ?? 0) === 0 && finY.outcome?.unverifiable === 1 && finY.outcome?.attendanceRate === null, JSON.stringify({ zoomCalls, finY }).slice(0, 400))

    // The promised replay: nothing until the recording exists; then once per registration, the right words for each.
    sent.length = 0
    const noReplay = await A.deliverEventReplay(svc as never, EV, { sendEmail: regDeps.sendEmail })
    check("no recording yet → nothing is sent (a deliverable is never 'delivered' without the asset)", noReplay.delivered === 0 && sent.length === 0)
    tbl("open_house_events").find((e) => e.id === EV).replay_url = "https://zoom.us/rec/share/abc"
    const rp1 = await A.deliverEventReplay(svc as never, EV, { sendEmail: regDeps.sendEmail })
    const rp2 = await A.deliverEventReplay(svc as never, EV, { sendEmail: regDeps.sendEmail })
    check("the recording exists → delivered ONCE per registration (attendee + no-show), and a second sweep sends nothing", rp1.delivered === 2 && sent.length === 2 && rp2.delivered === 0 && sent.every((s) => s.text.includes("https://zoom.us/rec/share/abc")), JSON.stringify({ rp1, rp2, sent: sent.length }))
  }

  console.log("\n[blind spots]")
  console.log("  · the runtime runs on memSupabase (no RLS, CHECK, FK or trigger) — m924 / m925 are WRITTEN, NOT APPLIED; the CHECK lists above are parsed from the migration text and the generated cache, and the live database is unchanged until the integrator applies them")
  console.log("  · Zoom is never called: the registrant add and the meeting create are seams here; their HTTP shapes are read from Zoom's documentation (2026-11-01), and 'registration_enabled' is taken from Zoom's ANSWERED approval_type — a real account may still behave differently")
  console.log("  · Zoom returns a participant's e-mail only for signed-in users; a registrant who joins on the SHARED link, signed out, with no registrant id is unmatched by design (an under-count, never a false attendance)")
  console.log("  · YouTube Live and external meeting links cannot verify attendance at all — their outcome says 'unverifiable' rather than a number")
  console.log("  · the static wiring checks read stripped source by pattern; a door that moves its logic behind a new helper is credited only where the pattern still sees it")
  console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
  for (const f of failures) console.log(`   ✗ ${f}`)
  process.exit(failed > 0 ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
